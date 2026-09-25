import { createHash } from "node:crypto";
import {
  db,
  followers,
  nagiBookmarks,
  nagiCardGets,
  nagiCardInstances,
  nagiChronicleEvents,
  nagiChronicleNews,
  nagiNews,
  nagiNewsApprovals,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import type {
  CardView,
  ChronicleEventKind,
  ChronicleEventView,
  ChroniclePage,
  NewsView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  CARD_VOLUME_ANNIVERSARY,
  cardDrawDate,
} from "@bsky-affirmative-bot/shared-configs";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, min } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { anniversaryViews, INSTANCE_COLUMNS } from "./cards.js";
import { hasTrustedSnapshot, newsView, type NewsLang } from "./positiveNews.js";

/**
 * 自分年表。
 *
 * **LLM が書いたイベント（nagi.chronicle_events）以外は行にしていない。** 記念日カードも
 * 「はじめて」も出会った日もニュースも、既存テーブルが権威なのでここで読み取り時に合流させる。
 * コピーを持つと、カードを交換して owner_did が動いたとき・過去の日記をバックフィルして
 * MIN が動いたときに、年表だけが古い事実を表示し続ける。
 *
 * **並びは古い順。** 年表は「はじまりから今へ」読むもので、一覧やフィードの新しい順とは
 * 逆向きになる。スクロールを下げるほど時間が前へ進み、いちばん下が今日に近づく。
 *
 * 1ページ＝1年ぶんで、cursor は**次に読む（より新しい）年**。年表は年見出しでまとまるので、
 * **ページ境界を見出し境界に一致させる**（日付カーソルだと1年が2ページに割れて見出しが
 * 重複するうえ、同じ日に複数イベントが載るので "日付+ID" の複合カーソルが要る）。
 * 1年の件数は構造的に有界
 * （記念日カード最大19枚 + highlight 最大12 + news_context 最大12 + はじめて6 + 起点2）。
 */

/** cursor として受け付ける下限。これより前のデータは無い（Nagi は 2025 開始）。 */
export const CHRONICLE_MIN_YEAR = 2020;
type ChronicleDb = Pick<typeof db, "select">;

const YEAR = /^\d{4}$/;

/**
 * 同じ日に複数のイベントが載るときの並び。**固定優先度で決定論的に決める。**
 * 時刻で並べると、日付だけ持つイベント（日記・記念日）と時刻を持つイベントが混ざったとき、
 * 「0時のもの」として全部先頭へ寄ってしまう。
 */
const KIND_ORDER: Record<ChronicleEventKind, number> = {
  nagi_joined: 0,
  bot_met: 1,
  first_card_ur: 2,
  first_card_aar: 3,
  anniversary_card: 4,
  highlight: 5,
  // その月のまとめの下に置くので、同じ日なら必ずいちばん後ろ。
  news_context: 7,
};

export function parseChronicleCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  if (!YEAR.test(cursor))
    throw new ApiError(400, "invalid_request", "Invalid chronicle cursor");
  return Number(cursor);
}

/** timestamptz を年表の日付へ。カード図鑑と同じ JST 4:00 始まりの物差しを使う。 */
export const chronicleDate = (at: Date): string => cardDrawDate(at);

/**
 * **日付の昇順（古いものが先）。** 同日は KIND_ORDER、それも同じなら id。
 *
 * 年表は「はじまりから今へ」読むもの。一覧やフィードの新しい順とは逆向きで、
 * スクロールを下げるほど時間が前へ進む。
 *
 * **id まで見るのは、ページをまたいだ重複排除と keyed each のために順序が安定している
 * 必要があるから。** 並びが実行ごとに揺れると、無限スクロールの継ぎ目で同じ行が二度出る。
 */
export function sortChronicleEvents(
  events: ChronicleEventView[],
): ChronicleEventView[] {
  return [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const order = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (order !== 0) return order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 年表は本人だけのもの。本人以外（未認証を含む）には undefined を返す。
 * viewerDid を必須引数にしてあるのは diaryView と同じ理由で、新しい呼び出し元が
 * うっかり渡し忘れたときに他人の年表が漏れないようにするため。
 */
export function chronicleEventView(
  subjectDid: string,
  viewerDid: string | undefined,
  event: ChronicleEventView,
): ChronicleEventView | undefined {
  if (subjectDid !== viewerDid) return undefined;
  return event;
}

type ChronicleWindow = { year: number; from: string; to: string };

const windowOf = (year: number): ChronicleWindow => ({
  year,
  from: `${year}-01-01`,
  to: `${year}-12-31`,
});

const inWindow = (date: string, w: ChronicleWindow) =>
  date >= w.from && date <= w.to;

/** LLM が日記から抜いた行（highlight）。 */
async function loadStoredEvents(
  did: string,
  w: ChronicleWindow,
  queryDb: ChronicleDb,
): Promise<ChronicleEventView[]> {
  const rows = await queryDb
    .select()
    .from(nagiChronicleEvents)
    .where(
      and(
        eq(nagiChronicleEvents.subjectDid, did),
        gte(nagiChronicleEvents.eventDate, w.from),
        lt(nagiChronicleEvents.eventDate, `${w.year + 1}-01-01`),
      ),
    )
    .orderBy(desc(nagiChronicleEvents.eventDate));
  return rows.map((row) => ({
    id: `stored:${row.id}`,
    kind: row.kind as ChronicleEventKind,
    date: row.eventDate,
    titleJa: row.titleJa,
    titleEn: row.titleEn,
    ...(row.detailJa ? { detailJa: row.detailJa } : {}),
    ...(row.detailEn ? { detailEn: row.detailEn } : {}),
    // highlight は日記の1日に対応する。UI はここから /diary?date= へ飛ばす。
    ...(row.kind === "highlight" ? { diaryDate: row.eventDate } : {}),
  }));
}

/** 記念日カード。card_volume = 0 だけを引く（図鑑のガチャ段は年表に出さない）。 */
async function loadAnniversaryCards(
  did: string,
  w: ChronicleWindow,
  queryDb: ChronicleDb,
): Promise<ChronicleEventView[]> {
  const rows = await queryDb
    .select(INSTANCE_COLUMNS)
    .from(nagiCardInstances)
    .where(
      and(
        eq(nagiCardInstances.ownerDid, did),
        eq(nagiCardInstances.cardVolume, CARD_VOLUME_ANNIVERSARY),
      ),
    );
  // 定義が引けない行は anniversaryViews が落とすので、行とビューの対応は instanceId で取り直す。
  const views = new Map<string, CardView>(
    anniversaryViews(rows).flatMap((v) => (v.instanceId ? [[v.instanceId, v]] : [])),
  );
  return rows.flatMap((row) => {
    const card = views.get(row.id);
    if (!card) return [];
    const date = chronicleDate(row.acquiredAt);
    if (!inWindow(date, w)) return [];
    return [
      {
        id: `anniversary:${row.id}`,
        kind: "anniversary_card" as const,
        date,
        card,
      },
    ];
  });
}

/** Date | 文字列 | 欠損 を Date へ。不正な値は undefined。 */
export function toDate(
  value: Date | string | null | undefined,
): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** 起点と「はじめて」の材料。SQL と切り離してテストできるようにしてある。 */
export type FirstsInput = {
  /** nagi.profiles.created_at。 */
  profileCreatedAt?: Date | string | null;
  /** affirmative_bot.followers.created_at。 */
  followerCreatedAt?: Date | string | null;
  /** レアカードの初取得。rarity ごとの min(drawn_at)。 */
  rareCards?: Array<{ rarity: string; at?: Date | string | null }>;
};

/**
 * 起点と「はじめて」を組み立てる。
 *
 * **起点は、それを名乗っている列をそのまま読む。他の列で補正しない。**
 *
 * - `nagi_joined` は `nagi.profiles.created_at`。これは PDS 上の
 *   `com.suibari.nagi.profile` レコードの `createdAt` を焼いたもので、**PDS が正本**。
 *   lexicon で required なので欠損は無く（`validateRecord` を通らない行は索引されない）、
 *   クライアントの `putProfile` も既存レコードの `createdAt` を引き継ぐので編集で飛ばない
 * - `bot_met` は `affirmative_bot.followers.created_at`
 *
 * **AppView の索引から推測して補正しない。** 以前は「最古の投稿」で下限を取っていたが、
 * AppView は自分が見始めるより前の投稿を知らないので、索引が浅いと
 * **その人の初投稿ではなく「DBが見始めた日」**を起点として載せてしまう
 * （開発DBで実際に起きた。`docs/chronicle.md` 参照）。
 * 正本を読むほうが、派生物から推測するより常に正しい。
 *
 * `followers.created_at` が Nagi 登録より後に来ることはある（Bluesky のフォロー以外でも
 * 行ができる: Nagi の会話・日記の称号・超ポジティブLv）。これは異常ではないので、
 * kind のラベルを「出会った日」ではなく「関わりはじめた日」にして受け止めている。
 */
export function buildFirstEvents(input: FirstsInput): ChronicleEventView[] {
  const events: ChronicleEventView[] = [];
  const push = (kind: ChronicleEventKind, date: string | null | undefined) => {
    if (date) events.push({ id: `first:${kind}`, kind, date });
  };

  const joinedAt = toDate(input.profileCreatedAt);
  if (joinedAt) push("nagi_joined", chronicleDate(joinedAt));
  const metAt = toDate(input.followerCreatedAt);
  if (metAt) push("bot_met", chronicleDate(metAt));
  for (const row of input.rareCards ?? []) {
    const at = toDate(row.at);
    if (!at) continue;
    push(
      row.rarity === "AAR" ? "first_card_aar" : "first_card_ur",
      chronicleDate(at),
    );
  }
  return events;
}

/**
 * 「はじめて」の記録と起点。すべて1行ずつで、**年窓に関係なく同じ結果になる**
 * （MIN は年に依存しない）ので、窓での絞り込みは呼び出し側に任せて全部返す。
 *
 * ここだけ先に引くのは、**古い順に並べる年表では1ページ目の年を決めるのに起点が要る**から。
 * 残りのクエリはこのあと並列でまとめて投げる。
 */
async function loadFirsts(
  did: string,
  queryDb: ChronicleDb,
): Promise<{ events: ChronicleEventView[]; originYear?: number }> {
  const [profile, follower, rareCards] = await Promise.all([
    queryDb
      .select({ createdAt: nagiProfiles.createdAt })
      .from(nagiProfiles)
      .where(eq(nagiProfiles.did, did))
      .limit(1),
    queryDb
      .select({ createdAt: followers.created_at })
      .from(followers)
      .where(eq(followers.did, did))
      .limit(1),
    // rarity は card_gets に焼き付けてあるので、カード定義 JSON を読まずに SQL で絞れる。
    queryDb
      .select({ rarity: nagiCardGets.rarity, at: min(nagiCardGets.drawnAt) })
      .from(nagiCardGets)
      .where(
        and(
          eq(nagiCardGets.did, did),
          isNull(nagiCardGets.deletedAt),
          inArray(nagiCardGets.rarity, ["UR", "AAR"]),
        ),
      )
      .groupBy(nagiCardGets.rarity),
  ]);

  const all = buildFirstEvents({
    profileCreatedAt: profile[0]?.createdAt,
    followerCreatedAt: follower[0]?.createdAt,
    rareCards,
  });

  // 起点＝いちばん古いイベントの年。年表はここから始まる。
  const originYear = all.length
    ? Math.min(...all.map((event) => Number(event.date.slice(0, 4))))
    : undefined;
  return { events: all, originYear };
}

/**
 * ニュース本体を引く。**承認フィルタは一覧と同じものを必ず通す** — 年表だけ未承認の
 * ニュースを出す抜け道を作らない。
 */
async function loadNewsViews(
  uris: string[],
  lang: NewsLang,
  queryDb: ChronicleDb,
): Promise<Map<string, NewsView>> {
  if (!uris.length) return new Map();
  const rows = await queryDb
    .select({ news: nagiNews, approval: nagiNewsApprovals })
    .from(nagiNews)
    .innerJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .where(
      and(
        inArray(nagiNews.uri, uris),
        isNull(nagiNews.deletedAt),
        isNull(nagiNewsApprovals.hiddenAt),
        eq(nagiNewsApprovals.newsCid, nagiNews.cid),
        eq(nagiNewsApprovals.status, "approved"),
        hasTrustedSnapshot,
      ),
    );
  // 年表はリアクションバーを出さないので reactions は空で足りる。
  return new Map(rows.map((row) => [row.news.uri, newsView(row, lang, [])]));
}

/**
 * 「そのころ世の中では」。**月ごとに1行で、全ユーザー共通。**
 * 利用者では絞らない（世の中の出来事の欄なので、誰が見ても同じ）。
 */
type MonthlyNewsRow = { event: ChronicleEventView; newsUri: string };

async function loadMonthlyNews(
  w: ChronicleWindow,
  queryDb: ChronicleDb,
): Promise<{ rows: MonthlyNewsRow[]; newsUris: string[] }> {
  const rows = await queryDb
    .select()
    .from(nagiChronicleNews)
    .where(
      and(
        gte(nagiChronicleNews.month, `${w.year}-01`),
        lt(nagiChronicleNews.month, `${w.year + 1}-01`),
        isNotNull(nagiChronicleNews.newsUri),
      ),
    );
  return {
    rows: rows.map((row) => ({
      event: {
        id: `news_context:${row.month}`,
        kind: "news_context" as const,
        // その月の出来事なので月末に置く。
        date: monthEndOf(row.month),
        // **見出しは付けない。** 表示側が news.title（記事の原題）をそのまま出す。
      },
      newsUri: row.newsUri!,
    })),
    newsUris: rows.flatMap((row) => (row.newsUri ? [row.newsUri] : [])),
  };
}

/** "YYYY-MM" → その月の最終日 "YYYY-MM-DD"。 */
function monthEndOf(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

/** 表示言語・取得順序によらない年全体の版。削除や空の年への変更も検出する。 */
export function chronicleYearRevision(
  year: number,
  items: ChronicleEventView[],
): string {
  const contents = [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((event) => [
      event.id, event.kind, event.date, event.titleJa, event.titleEn,
      event.detailJa, event.detailEn, event.diaryDate,
      event.news?.uri, event.news?.cid,
      event.card?.volume, event.card?.id, event.card?.nameJa, event.card?.nameEn,
      event.card?.commentJa, event.card?.commentEn,
    ]);
  return createHash("sha256").update(JSON.stringify([year, contents])).digest("hex");
}

export async function getChronicle(
  opts: {
    actor: string;
    /** 互換性のため受理する。年全体の既読判定には全項目が必要なので切り捨てない。 */
    limit: number;
    cursor?: string;
    lang: NewsLang;
    /** 認証必須。actor と一致しなければ拒否する。 */
    viewerDid: string;
  },
  queryDb: ChronicleDb = db,
): Promise<ChroniclePage> {
  if (!opts.actor)
    throw new ApiError(400, "invalid_request", "actor is required");
  if (opts.actor !== opts.viewerDid)
    throw new ApiError(
      403,
      "forbidden",
      "The chronicle is only available to its owner",
    );

  const thisYear = Number(cardDrawDate().slice(0, 4));
  /*
   * 起点（いちばん古い節目の年）を先に確定させる。
   *
   * 年表は古い順なので、**1ページ目はその人の起点の年から始まる**（一覧のように
   * 「今年」から始めればよいわけではない）。そのぶんここだけ1往復多いが、
   * 引いているのは索引付きの MIN が数本だけ。
   */
  const firsts = await loadFirsts(opts.actor, queryDb);
  const origin = firsts.originYear ?? thisYear;
  const year = parseChronicleCursor(opts.cursor) ?? origin;
  if (year < Math.max(CHRONICLE_MIN_YEAR, origin) || year > thisYear)
    throw new ApiError(400, "invalid_request", "Invalid chronicle cursor");
  const w = windowOf(year);

  const [storedEvents, cards, monthlyNews] = await Promise.all([
    loadStoredEvents(opts.actor, w, queryDb),
    loadAnniversaryCards(opts.actor, w, queryDb),
    loadMonthlyNews(w, queryDb),
  ]);

  const news = await loadNewsViews(
    [...new Set(monthlyNews.newsUris)],
    opts.lang,
    queryDb,
  );

  /*
   * 月次ニュースに本体を貼る。
   *
   * **本体が引けない news_context は落とす。** 承認が外れた・消された記事について
   * botたんの書いた見出しだけが年表に残ると、一覧では見えなくなった記事が
   * ここからだけ見える状態になる（「年表だけ未承認のニュースを出す抜け道」そのもの）。
   */
  const contextEvents = monthlyNews.rows.flatMap(({ event, newsUri }) => {
    const view = news.get(newsUri);
    return view ? [{ ...event, news: view }] : [];
  });

  const items = sortChronicleEvents([
    ...storedEvents,
    ...contextEvents,
    ...cards,
    ...firsts.events.filter((event) => inWindow(event.date, w)),
  ]).flatMap((event) => chronicleEventView(opts.actor, opts.viewerDid, event) ?? []);
  // 年単位の既読なので全件を返す。limitで切ると未表示部分まで既読になる。

  // 今年まで来たら終端。古い順なので、進む先は「より新しい年」。
  const hasMore = year < thisYear;
  return {
    year,
    revision: chronicleYearRevision(year, items),
    items,
    ...(hasMore ? { cursor: String(year + 1) } : {}),
    hasMore,
  };
}
