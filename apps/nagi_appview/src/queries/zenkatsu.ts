import {
  db,
  nagiActors,
  nagiCardInstances,
  nagiProfiles,
  nagiZenkatsuCards,
  nagiZenkatsuCommentJobs,
  nagiZenkatsuDaily,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import {
  buildZenkatsuReading,
  cardDrawDate,
  getThemeDef,
  isValidZenkatsuSelection,
  resolveCardDef,
  themeForDate,
  ZENKATSU_MAX_CARDS,
  zenkatsuAvailability,
  zenkatsuRestWindowStart,
  type CardDefinition,
  type ZenkatsuHolding,
  type ZenkatsuReading,
  type ZenkatsuReadingCard,
} from "@bsky-affirmative-bot/shared-configs";
import type {
  ActorView,
  CardView,
  NagiZenkatsu,
  ZenkatsuFeed,
  ZenkatsuPlayableCard,
  ZenkatsuSubmissionView,
  ZenkatsuThemeView,
  ZenkatsuViewerState,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";

/**
 * ゼンカツ！。設計の経緯と理由は docs/zenkatsu.md。
 *
 * 提出そのものは**ユーザー自身の PDS レコード**で、ここにあるのはその索引と検証。
 * ドローと違い、提出は「既に所持している札を参照するだけ」なので、所持・おやすみ・当日かを
 * すべて AppView が照合できる。合わないレコードは索引しない＝記録には出ない。
 */

type CardRef = { volume: number; id: number };

/**
 * db か、進行中のトランザクション。
 *
 * 取り込みは applyMutation の大きなトランザクションの内側で走るので、
 * ここで `db.transaction()` を開くと別コネクションを掴んで自分自身とデッドロックする。
 * 呼び出し側のハンドルを受け取り、原子性はそちらに委ねる。
 */
export type DbLike =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

const cardKeyOf = (c: CardRef) => `${c.volume}:${c.id}`;

/**
 * その日のお題を確定させる。
 *
 * **お題は初回アクセス時に焼き付けて以後動かさない。** themes_v{n}.json にお題を足すと
 * `themeForDate` の割り当てが変わるので、都度計算にすると過去の日のお題が書き換わる。
 * 日付パーマリンクでさかのぼれる仕様なので、それはアーカイブの破壊になる。
 */
export async function resolveThemeForDate(
  themeDate: string,
  handle: DbLike = db,
): Promise<ZenkatsuThemeView> {
  const existing = await handle
    .select()
    .from(nagiZenkatsuDaily)
    .where(eq(nagiZenkatsuDaily.themeDate, themeDate))
    .limit(1);
  let volume = existing[0]?.themeVolume;
  let id = existing[0]?.themeNumber;

  if (volume === undefined || id === undefined) {
    const picked = themeForDate(themeDate);
    // 同時アクセスでも1つに収束させる。負けた側は入った値を読み直す。
    await handle
      .insert(nagiZenkatsuDaily)
      .values({
        themeDate,
        themeVolume: picked.volume,
        themeNumber: picked.id,
      })
      .onConflictDoNothing();
    const pinned = await handle
      .select()
      .from(nagiZenkatsuDaily)
      .where(eq(nagiZenkatsuDaily.themeDate, themeDate))
      .limit(1);
    volume = pinned[0]?.themeVolume ?? picked.volume;
    id = pinned[0]?.themeNumber ?? picked.id;
  }

  return themeViewOf(themeDate, volume, id);
}

function themeViewOf(
  themeDate: string,
  volume: number,
  id: number,
): ZenkatsuThemeView {
  const def = getThemeDef(volume, id);
  if (!def)
    // 焼き付けたお題が JSON から消えた＝リリース済み番号を消した、ということ。
    // 過去の記録が読めなくなるので、握りつぶさず落とす。
    throw new ApiError(500, "theme_missing", `Theme ${volume}-${id} is missing`);
  return {
    volume: def.volume,
    id: def.id,
    themeDate,
    textJa: def.textJa,
    textEn: def.textEn,
    attribute: def.attribute,
    ...(def.raceJa ? { raceJa: def.raceJa } : {}),
    tone: def.tone,
  };
}

/** 所持している札（duplicate_count が在庫枚数）。記念日カードも含む。 */
async function loadHoldings(
  did: string,
  handle: DbLike = db,
): Promise<{
  holdings: ZenkatsuHolding[];
  labels: Map<string, string | null>;
}> {
  const rows = await handle
    .select({
      cardVolume: nagiCardInstances.cardVolume,
      cardNumber: nagiCardInstances.cardNumber,
      duplicateCount: nagiCardInstances.duplicateCount,
      anniversaryLabel: nagiCardInstances.anniversaryLabel,
    })
    .from(nagiCardInstances)
    .where(eq(nagiCardInstances.ownerDid, did));

  const holdings: ZenkatsuHolding[] = [];
  const labels = new Map<string, string | null>();
  for (const row of rows) {
    const def = resolveCardDef(
      row.cardVolume,
      row.cardNumber,
      row.anniversaryLabel ?? undefined,
    );
    if (!def) continue;
    holdings.push({
      volume: row.cardVolume,
      id: row.cardNumber,
      rarity: def.rarity,
      stock: row.duplicateCount,
    });
    labels.set(
      cardKeyOf({ volume: row.cardVolume, id: row.cardNumber }),
      row.anniversaryLabel,
    );
  }
  return { holdings, labels };
}

/**
 * 直近のおやすみ判定に要る提出履歴。
 *
 * **日付キー（"YYYY-MM-DD"）の文字列比較で範囲を取る。** timestamp と Date を使わないので、
 * AGENTS.md が禁じている「raw sql への Date 補間」を踏む余地がそもそも無い。
 * (did, theme_date) の一意索引がそのまま効く。
 */
async function loadRecentPlays(
  did: string,
  today: string,
  handle: DbLike = db,
): Promise<{ volume: number; id: number; themeDate: string }[]> {
  const since = zenkatsuRestWindowStart(today);
  const rows = await handle
    .select({
      cardVolume: nagiZenkatsuCards.cardVolume,
      cardNumber: nagiZenkatsuCards.cardNumber,
      themeDate: nagiZenkatsuSubmissions.themeDate,
    })
    .from(nagiZenkatsuCards)
    .innerJoin(
      nagiZenkatsuSubmissions,
      eq(nagiZenkatsuSubmissions.uri, nagiZenkatsuCards.submissionUri),
    )
    .where(
      and(
        eq(nagiZenkatsuSubmissions.did, did),
        gte(nagiZenkatsuSubmissions.themeDate, since),
      ),
    );
  return rows.map((r) => ({
    volume: r.cardVolume,
    id: r.cardNumber,
    themeDate: r.themeDate,
  }));
}

/** 「その札をゼンカツに出したことがあるか」。初登板ラベルに使う。 */
async function loadEverPlayed(
  did: string,
  handle: DbLike = db,
): Promise<Set<string>> {
  const rows = await handle
    .selectDistinct({
      cardVolume: nagiZenkatsuCards.cardVolume,
      cardNumber: nagiZenkatsuCards.cardNumber,
    })
    .from(nagiZenkatsuCards)
    .innerJoin(
      nagiZenkatsuSubmissions,
      eq(nagiZenkatsuSubmissions.uri, nagiZenkatsuCards.submissionUri),
    )
    .where(eq(nagiZenkatsuSubmissions.did, did));
  return new Set(
    rows.map((r) => cardKeyOf({ volume: r.cardVolume, id: r.cardNumber })),
  );
}

/** 今日出せる札。所持している札だけが並び、おやすみ中のものは残り日数付きで返る。 */
export async function loadPlayable(
  did: string,
  today: string,
): Promise<ZenkatsuPlayableCard[]> {
  const [{ holdings }, plays] = await Promise.all([
    loadHoldings(did),
    loadRecentPlays(did, today),
  ]);
  return zenkatsuAvailability(holdings, plays, today);
}

/** 提出が弾かれた理由。ログと、将来クライアントへ返すときの識別子を兼ねる。 */
export type ZenkatsuRejection =
  | "rkey_mismatch"
  | "not_today"
  | "invalid_selection"
  | "not_owned"
  | "resting"
  | "unknown_card"
  | "already_submitted";

export type ZenkatsuDecision =
  | { ok: true; reading: ZenkatsuReading }
  | { ok: false; reason: ZenkatsuRejection };

/**
 * 提出レコードを受け入れてよいかの判定。**ここが唯一の防御線。**
 *
 * レコードはユーザーの repo にあるので誰でも自由に書ける。合わないものは索引しない
 * （repo には残るが記録には出ない ＝ AT Protocol の通常の動作）。
 *
 * DB アクセスを含まない純粋関数にしてあるのは、この判定こそテストで固めたいから。
 * 形の検証（1〜3枚・重複なし・日付キーの体裁）は validateRecord 側で済んでいるが、
 * 取り込み経路が増えても守られるよう、ここでももう一度見る。
 */
export function decideZenkatsuSubmission(input: {
  rkey: string;
  record: NagiZenkatsu;
  /** 取り込み時点の日付キー（cardDrawDate の結果）。 */
  today: string;
  theme: { attribute: string; raceJa?: string };
  holdings: readonly ZenkatsuHolding[];
  /** 記念日カードの表示名に使うラベル。 */
  labels: ReadonlyMap<string, string | null>;
  plays: readonly { volume: number; id: number; themeDate: string }[];
  everPlayed: ReadonlySet<string>;
}): ZenkatsuDecision {
  const { record } = input;
  // rkey は日付そのもの。ズレていると repo 側の「1日1本」の保証が効かなくなる。
  if (record.themeDate !== input.rkey) return { ok: false, reason: "rkey_mismatch" };
  // 遡り提出の禁止。取り込み時点の当日ぶんしか受け付けない。
  if (record.themeDate !== input.today) return { ok: false, reason: "not_today" };
  if (!isValidZenkatsuSelection(record.cards))
    return { ok: false, reason: "invalid_selection" };

  const holdingByKey = new Map(input.holdings.map((h) => [cardKeyOf(h), h]));
  const availabilityByKey = new Map(
    zenkatsuAvailability(input.holdings, input.plays, record.themeDate).map(
      (a) => [cardKeyOf(a), a],
    ),
  );

  const readingCards: ZenkatsuReadingCard[] = [];
  for (const ref of record.cards) {
    const key = cardKeyOf(ref);
    const holding = holdingByKey.get(key);
    // 所持していない札は出せない。ここがドローとの決定的な違いで、
    // 「既に持っているもの」だから照合できる。
    if (!holding) return { ok: false, reason: "not_owned" };
    if ((availabilityByKey.get(key)?.available ?? 0) < 1)
      return { ok: false, reason: "resting" };
    const def = resolveCardDef(
      ref.volume,
      ref.id,
      input.labels.get(key) ?? undefined,
    );
    if (!def) return { ok: false, reason: "unknown_card" };
    readingCards.push({
      nameJa: def.nameJa,
      rarity: def.rarity,
      attribute: def.attribute,
      raceJa: def.raceJa,
      atk: def.atk,
      def: def.def,
      stock: holding.stock,
      firstPlay: !input.everPlayed.has(key),
    });
  }

  return { ok: true, reading: buildZenkatsuReading(input.theme, readingCards) };
}

/** 検証を通した提出を索引する。原子性は呼び出し側のトランザクションに委ねる（DbLike 参照）。 */
export async function indexZenkatsuSubmission(
  tx: DbLike,
  input: {
    uri: string;
    cid: string;
    did: string;
    rkey: string;
    record: NagiZenkatsu;
    now?: Date;
  },
): Promise<{ indexed: boolean; reason?: ZenkatsuRejection }> {
  const now = input.now ?? new Date();
  const { record, did } = input;
  const theme = await resolveThemeForDate(record.themeDate, tx);
  const [{ holdings, labels }, plays, everPlayed] = await Promise.all([
    loadHoldings(did, tx),
    loadRecentPlays(did, record.themeDate, tx),
    loadEverPlayed(did, tx),
  ]);

  const decision = decideZenkatsuSubmission({
    rkey: input.rkey,
    record,
    today: cardDrawDate(now),
    theme: {
      attribute: theme.attribute,
      ...(theme.raceJa ? { raceJa: theme.raceJa } : {}),
    },
    holdings,
    labels,
    plays,
    everPlayed,
  });
  if (!decision.ok) return { indexed: false, reason: decision.reason };

  const inserted = await tx
    .insert(nagiZenkatsuSubmissions)
    .values({
      uri: input.uri,
      cid: input.cid,
      did,
      themeDate: record.themeDate,
      themeVolume: theme.volume,
      themeNumber: theme.id,
      reading: decision.reading.labels,
      isHighlight: decision.reading.highlight,
      createdAt: new Date(record.createdAt),
    })
    .onConflictDoNothing()
    .returning({ uri: nagiZenkatsuSubmissions.uri });
  // 先着のみ有効。レコードを消して書き直しても、(did, theme_date) の行が残っているので
  // 通らない（「1日1回・確定」の実体）。
  if (!inserted.length) return { indexed: false, reason: "already_submitted" };

  await tx.insert(nagiZenkatsuCards).values(
    record.cards.map((ref, index) => ({
      submissionUri: input.uri,
      position: index + 1,
      cardVolume: ref.volume,
      cardNumber: ref.id,
    })),
  );
  await tx
    .insert(nagiZenkatsuCommentJobs)
    .values({ submissionUri: input.uri })
    .onConflictDoNothing();

  return { indexed: true };
}

/**
 * 本人がレコードを消したときの取り消し。**論理削除にする。**
 *
 * 行ごと消すと、消して出し直せてしまう。しかも zenkatsu_cards まで消えるので出した札の
 * おやすみもリセットされ、気に入る総評が出るまで引き直せる。行を残せば
 * (did, theme_date) の一意索引が再提出を止め、おやすみも生き続ける。
 * 記録から見えなくなるだけ、が正しい挙動。
 */
export async function removeZenkatsuSubmission(
  tx: DbLike,
  uri: string,
): Promise<void> {
  await tx
    .update(nagiZenkatsuSubmissions)
    .set({ deletedAt: new Date() })
    .where(eq(nagiZenkatsuSubmissions.uri, uri));
  // 消された提出に総評を付けても誰も読まないので、生成待ちなら取り下げる。
  await tx
    .delete(nagiZenkatsuCommentJobs)
    .where(eq(nagiZenkatsuCommentJobs.submissionUri, uri));
}

const CURSOR_SEP = "::";
const encodeCursor = (indexedAt: Date, uri: string) =>
  Buffer.from(`${indexedAt.toISOString()}${CURSOR_SEP}${uri}`).toString("base64url");
const decodeCursor = (cursor: string): { indexedAt: Date; uri: string } | undefined => {
  const [at, uri] = Buffer.from(cursor, "base64url").toString().split(CURSOR_SEP);
  const indexedAt = at ? new Date(at) : undefined;
  if (!indexedAt || Number.isNaN(indexedAt.getTime()) || !uri) return undefined;
  return { indexedAt, uri };
};

async function loadActorViews(dids: string[]): Promise<Map<string, ActorView>> {
  const unique = [...new Set(dids)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ actor: nagiActors, profile: nagiProfiles })
    .from(nagiActors)
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiActors.did))
    .where(inArray(nagiActors.did, unique));
  return new Map(
    rows.map(({ actor, profile }) => [
      actor.did,
      {
        did: actor.did,
        handle: actor.handle,
        displayName: profile?.displayName ?? undefined,
        avatar: profile?.avatarCid
          ? `/api/blob/${encodeURIComponent(actor.did)}/${profile.avatarCid}`
          : undefined,
        isBot: actor.did === config.botDid,
      },
    ]),
  );
}

const submissionCardView = (def: CardDefinition): CardView => ({
  ...def,
  // 提出に載っている札は、出した本人が所持していることを取り込み時に照合済み。
  owned: true,
});

/**
 * ある1日のお題と全回答。**新着順（indexedAt 降順）**。
 *
 * 並びに createdAt を使わないのは、レコードの値はユーザーが自由に書けるからで、
 * フィード上位を取るために遡られる。
 */
export async function getZenkatsu(opts: {
  date?: string;
  cursor?: string;
  limit: number;
  viewerDid?: string;
  now?: Date;
}): Promise<ZenkatsuFeed> {
  const now = opts.now ?? new Date();
  const today = cardDrawDate(now);
  const themeDate = opts.date ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(themeDate))
    throw new ApiError(400, "invalid_request", "Invalid date");
  // 未来のお題は出さない（先に見えると、その日の回答が引きずられる）。
  if (themeDate > today)
    throw new ApiError(400, "invalid_request", "Future date");

  const theme = await resolveThemeForDate(themeDate);

  const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  if (opts.cursor && !after)
    throw new ApiError(400, "invalid_request", "Invalid cursor");

  const rows = await db
    .select()
    .from(nagiZenkatsuSubmissions)
    .where(
      and(
        eq(nagiZenkatsuSubmissions.themeDate, themeDate),
        isNull(nagiZenkatsuSubmissions.deletedAt),
        after
          ? or(
              lt(nagiZenkatsuSubmissions.indexedAt, after.indexedAt),
              and(
                eq(nagiZenkatsuSubmissions.indexedAt, after.indexedAt),
                lt(nagiZenkatsuSubmissions.uri, after.uri),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(nagiZenkatsuSubmissions.indexedAt), desc(nagiZenkatsuSubmissions.uri))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit);
  const uris = page.map((r) => r.uri);

  const [cardRows, actors] = await Promise.all([
    uris.length
      ? db
          .select({
            submissionUri: nagiZenkatsuCards.submissionUri,
            position: nagiZenkatsuCards.position,
            cardVolume: nagiZenkatsuCards.cardVolume,
            cardNumber: nagiZenkatsuCards.cardNumber,
            anniversaryLabel: nagiCardInstances.anniversaryLabel,
          })
          .from(nagiZenkatsuCards)
          .leftJoin(
            nagiZenkatsuSubmissions,
            eq(nagiZenkatsuSubmissions.uri, nagiZenkatsuCards.submissionUri),
          )
          // 記念日カードの表示名は、受け取った人が付けたラベルで決まる。
          .leftJoin(
            nagiCardInstances,
            and(
              eq(nagiCardInstances.ownerDid, nagiZenkatsuSubmissions.did),
              eq(nagiCardInstances.cardVolume, nagiZenkatsuCards.cardVolume),
              eq(nagiCardInstances.cardNumber, nagiZenkatsuCards.cardNumber),
            ),
          )
          .where(inArray(nagiZenkatsuCards.submissionUri, uris))
      : Promise.resolve([]),
    loadActorViews(page.map((r) => r.did)),
  ]);

  const cardsByUri = new Map<string, CardView[]>();
  for (const row of [...cardRows].sort((a, b) => a.position - b.position)) {
    const def = resolveCardDef(
      row.cardVolume,
      row.cardNumber,
      row.anniversaryLabel ?? undefined,
    );
    if (!def) continue;
    const list = cardsByUri.get(row.submissionUri);
    if (list) list.push(submissionCardView(def));
    else cardsByUri.set(row.submissionUri, [submissionCardView(def)]);
  }

  const submissions: ZenkatsuSubmissionView[] = page.flatMap((row) => {
    const author = actors.get(row.did);
    if (!author) return [];
    return [
      {
        uri: row.uri,
        cid: row.cid,
        author,
        cards: cardsByUri.get(row.uri) ?? [],
        ...(row.commentJa ? { commentJa: row.commentJa } : {}),
        ...(row.commentEn ? { commentEn: row.commentEn } : {}),
        commentPending: !row.commentJa,
        createdAt: row.createdAt.toISOString(),
        indexedAt: row.indexedAt.toISOString(),
      },
    ];
  });

  const last = page.at(-1);
  const feed: ZenkatsuFeed = {
    theme,
    submissions,
    ...(rows.length > opts.limit && last
      ? { cursor: encodeCursor(last.indexedAt, last.uri) }
      : {}),
  };

  if (opts.viewerDid) feed.viewer = await loadViewerState(opts.viewerDid, today);
  return feed;
}

async function loadViewerState(
  did: string,
  today: string,
): Promise<ZenkatsuViewerState> {
  const [mine, playable] = await Promise.all([
    // 消した場合も submitted は true のまま。再提出はできないので、
    // 「まだ出せる」と誤解させないほうが正しい。
    db
      .select({
        uri: nagiZenkatsuSubmissions.uri,
        deletedAt: nagiZenkatsuSubmissions.deletedAt,
      })
      .from(nagiZenkatsuSubmissions)
      .where(
        and(
          eq(nagiZenkatsuSubmissions.did, did),
          eq(nagiZenkatsuSubmissions.themeDate, today),
        ),
      )
      .limit(1),
    loadPlayable(did, today),
  ]);
  return {
    submitted: !!mine[0],
    ...(mine[0] && !mine[0].deletedAt ? { submissionUri: mine[0].uri } : {}),
    playable,
    maxCards: ZENKATSU_MAX_CARDS,
  };
}
