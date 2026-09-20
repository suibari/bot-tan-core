import {
  db,
  nagiActors,
  nagiCardInstances,
  nagiProfiles,
  nagiZenkatsuAwardJobs,
  nagiZenkatsuCards,
  nagiZenkatsuComboDiscoveries,
  nagiZenkatsuCommentJobs,
  nagiZenkatsuDaily,
  nagiZenkatsuSubmissions,
  nagiZenkatsuTrophies,
} from "@bsky-affirmative-bot/database";
import {
  buildZenkatsuReading,
  cardDrawDate,
  COMBO_TOTAL,
  dayIndexOfDateKey,
  getComboDef,
  immediateZenkatsuAwards,
  matchCombos,
  scoreZenkatsu,
  type ComboDefinition,
  getThemeDef,
  isValidZenkatsuSelection,
  resolveCardDef,
  themeForDate,
  ZENKATSU_MAX_CARDS,
  zenkatsuAvailability,
  zenkatsuRestWindowStart,
  type CardDefinition,
  type CardRarity,
  type ZenkatsuHolding,
  type ZenkatsuReading,
  type ZenkatsuReadingCard,
  type ZenkatsuScore,
} from "@bsky-affirmative-bot/shared-configs";
import type {
  ActorView,
  CardView,
  NagiZenkatsu,
  ZenkatsuComboView,
  ZenkatsuDeckView,
  ZenkatsuFeed,
  ZenkatsuSubmissionCombo,
  ZenkatsuTrophyView,
  ZenkatsuPlayableCard,
  ZenkatsuSubmissionView,
  ZenkatsuThemeView,
  ZenkatsuViewerState,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { getReactionViews } from "./reactions.js";
import { zenkatsuPlayInventory } from "./zenkatsuPlayInventory.js";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";

/**
 * ゼンカツ！。設計の経緯と理由は docs/zenkatsu.md。
 *
 * 提出そのものは**ユーザー自身の PDS レコード**で、ここにあるのはその索引と検証。
 * ドローと違い、提出は「既に所持している札を参照するだけ」なので、所持・クールダウン・当日かを
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
 * 直近のクールダウン判定に要る提出履歴。
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

/** 今日出せる札。本番は所持・クールダウンを反映し、開発時は図鑑の全札を使える。 */
export async function loadPlayable(
  did: string,
  today: string,
): Promise<ZenkatsuPlayableCard[]> {
  const [{ holdings }, plays] = await Promise.all([
    loadHoldings(did),
    loadRecentPlays(did, today),
  ]);
  const inventory = zenkatsuPlayInventory(holdings, plays, config.dev);
  return zenkatsuAvailability(inventory.holdings, inventory.plays, today);
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
  | {
      ok: true;
      reading: ZenkatsuReading;
      /** 成立したコンボ。リザルトと発見記録に使う。 */
      combos: ComboDefinition[];
      /** 隠し得点。**表示には絶対に出さない**（今日のナギカツ部長の候補を絞るためだけ）。 */
      score: ZenkatsuScore;
      rarities: CardRarity[];
    }
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

  // コンボは隠し要素。出す前には見えず、成立して初めてリザルトに出る。
  const combos = matchCombos(record.cards);
  const reading = buildZenkatsuReading(input.theme, readingCards, combos);
  const score = scoreZenkatsu({
    theme: input.theme,
    cards: readingCards,
    comboBonuses: combos.map((c) => c.bonus),
  });
  return { ok: true, reading, combos, score, rarities: readingCards.map((card) => card.rarity) };
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
    ...zenkatsuPlayInventory(holdings, plays, config.dev),
    labels,
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
      score: decision.score.value,
      combos: decision.combos.map((c) => ({ volume: c.volume, id: c.id })),
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
  // コンボの初回発見を記録する。既に誰かが出していれば何も起きない（発見者は不変）。
  const discoveries = decision.combos.length
    ? await tx
        .insert(nagiZenkatsuComboDiscoveries)
        .values(
          decision.combos.map((combo) => ({
            comboVolume: combo.volume,
            comboNumber: combo.id,
            did,
            submissionUri: input.uri,
          })),
        )
        .onConflictDoNothing()
        .returning({ comboVolume: nagiZenkatsuComboDiscoveries.comboVolume })
    : [];

  const immediateAwards = immediateZenkatsuAwards({
    rarities: decision.rarities,
    tailwindCount: decision.score.tailwindCount,
    newComboCount: discoveries.length,
  });
  if (immediateAwards.length)
    await tx
      .insert(nagiZenkatsuTrophies)
      .values(
        immediateAwards.map((kind) => ({
          themeDate: record.themeDate,
          did,
          kind,
          submissionUri: input.uri,
        })),
      )
      .onConflictDoNothing();

  await tx
    .insert(nagiZenkatsuCommentJobs)
    .values({ submissionUri: input.uri })
    .onConflictDoNothing();
  // 翌朝の部長賞ジョブ。その日の最初の提出で作られ、以後は何もしない。
  await tx
    .insert(nagiZenkatsuAwardJobs)
    .values({ themeDate: record.themeDate })
    .onConflictDoNothing();

  return { indexed: true };
}

/**
 * 本人がレコードを消したときの取り消し。**論理削除にする。**
 *
 * 行ごと消すと、消して出し直せてしまう。しかも zenkatsu_cards まで消えるので出した札の
 * クールダウンもリセットされ、気に入る総評が出るまで引き直せる。行を残せば
 * (did, theme_date) の一意索引が再提出を止め、クールダウンも生き続ける。
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
  const [rows, chiefs] = await Promise.all([
    db.select({ actor: nagiActors, profile: nagiProfiles })
      .from(nagiActors)
      .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiActors.did))
      .where(inArray(nagiActors.did, unique)),
    getZenkatsuChiefDids(unique),
  ]);
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
        ...(chiefs.has(actor.did) ? { zenkatsuChief: true } : {}),
      },
    ]),
  );
}

/** 保存済みの成立コンボを、表示用の要約へ。定義に無いものは黙って落とす。 */
const comboViewsOf = (stored: unknown): ZenkatsuSubmissionCombo[] => {
  const list = Array.isArray(stored)
    ? (stored as { volume: number; id: number }[])
    : [];
  return list.flatMap((ref) => {
    const def = getComboDef(ref.volume, ref.id);
    return def
      ? [
          {
            volume: def.volume,
            id: def.id,
            nameJa: def.nameJa,
            nameEn: def.nameEn,
            descJa: def.descJa,
            descEn: def.descEn,
          },
        ]
      : [];
  });
};

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

  const [cardRows, actors, reactions] = await Promise.all([
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
    // 提出レコードそのものが subject。投稿・ニュースと同じ経路で付く。
    getReactionViews(uris, opts.viewerDid),
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
        // 追い風の枚数とコンボは「何が起きたか」なので出す。得点は出さない。
        tailwindCount: (cardsByUri.get(row.uri) ?? []).filter(
          (c) => c.attribute === theme.attribute,
        ).length,
        combos: comboViewsOf(row.combos),
        reactions: reactions.get(row.uri) ?? [],
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

/**
 * 「今日のナギカツ部長」＝ 直前に閉じた日の受賞者か。
 *
 * **バッジに出すのはこの1つだけで、しかも1日で消える。** 累積を出すと、
 * `badges.ts` が「競争や『ネガティブなことを言いづらい』という圧力につながる」として
 * 既に非表示にした超ポジティブLvと同じ構造を、別の名前で復活させてしまう。
 * 毎日ひとりだけが持ち、翌朝には別の人へ移るので、順位の梯子にならない。
 *
 * 判定する日は「今日」ではなく**直前に閉じた日**。トロフィーは JST 4:00 に前日ぶんを
 * 確定するので、今日まだ進行中の日には受賞者が居ない。
 */
export async function isZenkatsuChief(
  did: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await getZenkatsuChiefDids([did], now)).has(did);
}

/** フィードなどの投稿者に、直前に確定した部長バッジを一括で付ける。 */
export async function getZenkatsuChiefDids(
  dids: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  const unique = [...new Set(dids)];
  if (!unique.length) return new Set();
  const rows = await db
    .select({ did: nagiZenkatsuTrophies.did })
    .from(nagiZenkatsuTrophies)
    .where(
      and(
        inArray(nagiZenkatsuTrophies.did, unique),
        eq(nagiZenkatsuTrophies.kind, "botan"),
        eq(nagiZenkatsuTrophies.themeDate, previousThemeDate(now)),
      ),
    );
  return new Set(rows.map((row) => row.did));
}

/** 直前に閉じた日の日付キー。日付キーは "YYYY-MM-DD" なので日数で1引くだけ。 */
export function previousThemeDate(now: Date = new Date()): string {
  const today = cardDrawDate(now);
  return new Date((dayIndexOfDateKey(today) - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * レコード。**自分が成立させたことのあるコンボ**と、6種類のトロフィー。
 *
 * コンボは隠し要素なので、**まだ出していないコンボの中身は返さない**。総数だけ返して
 * 「26種のうち3種」と出せるようにする。未発見のぶんを名前入りで並べると、
 * 発見の楽しみをこちらから奪ってしまう。
 *
 * 成立履歴は zenkatsu_submissions.combos に入っているので、専用テーブルは要らない。
 */
export async function getZenkatsuDeck(did: string): Promise<ZenkatsuDeckView> {
  const [rows, trophyRows, pioneers] = await Promise.all([
    db
      .select({
        combos: nagiZenkatsuSubmissions.combos,
        themeDate: nagiZenkatsuSubmissions.themeDate,
      })
      .from(nagiZenkatsuSubmissions)
      .where(eq(nagiZenkatsuSubmissions.did, did))
      .orderBy(asc(nagiZenkatsuSubmissions.themeDate)),
    db
      .select()
      .from(nagiZenkatsuTrophies)
      .where(eq(nagiZenkatsuTrophies.did, did))
      .orderBy(desc(nagiZenkatsuTrophies.themeDate), asc(nagiZenkatsuTrophies.kind)),
    db.select().from(nagiZenkatsuComboDiscoveries),
  ]);

  // 同じコンボを何度も出していることがあるので、いちばん古い日を採る。
  const firstPlayed = new Map<string, string>();
  for (const row of rows) {
    const list = Array.isArray(row.combos)
      ? (row.combos as { volume: number; id: number }[])
      : [];
    for (const ref of list) {
      const key = `${ref.volume}:${ref.id}`;
      if (!firstPlayed.has(key)) firstPlayed.set(key, row.themeDate);
    }
  }

  const pioneerByKey = new Map(
    pioneers.map((p) => [`${p.comboVolume}:${p.comboNumber}`, p.did]),
  );
  const pioneerActors = await loadActorViews(
    [...firstPlayed.keys()].flatMap((key) => {
      const pioneerDid = pioneerByKey.get(key);
      return pioneerDid ? [pioneerDid] : [];
    }),
  );

  const combos: ZenkatsuComboView[] = [...firstPlayed.entries()]
    .flatMap(([key, themeDate]) => {
      const [volume, id] = key.split(":").map(Number);
      const def = getComboDef(volume, id);
      if (!def) return [];
      const pioneerDid = pioneerByKey.get(key);
      const pioneer = pioneerDid ? pioneerActors.get(pioneerDid) : undefined;
      return [
        {
          volume: def.volume,
          id: def.id,
          nameJa: def.nameJa,
          nameEn: def.nameEn,
          descJa: def.descJa,
          descEn: def.descEn,
          slots: def.members.map((slot) =>
            slot.flatMap((cardId) => {
              const card = resolveCardDef(def.volume, cardId);
              return card ? [{ ...card, owned: true }] : [];
            }),
          ),
          firstPlayedDate: themeDate,
          ...(pioneer ? { pioneer } : {}),
          isPioneer: pioneerDid === did,
        },
      ];
    })
    .sort((a, b) => a.firstPlayedDate.localeCompare(b.firstPlayedDate));

  const trophies: ZenkatsuTrophyView[] = trophyRows.map((row) => {
    // お題は日付から引き直す。トロフィー行に焼き付けなくても、daily が固定しているので動かない。
    return {
      kind: row.kind,
      themeDate: row.themeDate,
      submissionUri: row.submissionUri,
      ...(row.commentJa ? { commentJa: row.commentJa } : {}),
      ...(row.commentEn ? { commentEn: row.commentEn } : {}),
    };
  });

  return { comboTotal: COMBO_TOTAL, combos, trophies };
}

/**
 * **開発専用**: 今日の自分の提出を消して、もう一度出せるようにする。
 *
 * ゼンカツは1日1回なので、そのままでは総評や演出を1日1度しか確かめられない。
 * 「1日1回のロックを env で外す」やり方もあるが、それだと**検証したい当の制約が
 * 効いていない状態**で試すことになる。消して出し直す形にすれば、所持・クールダウン・
 * 当日判定・採点・コンボ・総評まで、本物の経路を毎回まるごと通せる。
 *
 * zenkatsu_cards も一緒に消すので、出した札のクールダウンも戻る。
 * 公開の記録からも消えるが、開発環境の話なので問題にならない。
 */
export async function resetZenkatsuForDev(
  did: string,
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const themeDate = cardDrawDate(now);
  const rows = await db
    .select({ uri: nagiZenkatsuSubmissions.uri })
    .from(nagiZenkatsuSubmissions)
    .where(
      and(
        eq(nagiZenkatsuSubmissions.did, did),
        eq(nagiZenkatsuSubmissions.themeDate, themeDate),
      ),
    );
  if (!rows.length) return { deleted: 0 };
  const uris = rows.map((r) => r.uri);

  await db.transaction(async (tx) => {
    await tx
      .delete(nagiZenkatsuCards)
      .where(inArray(nagiZenkatsuCards.submissionUri, uris));
    await tx
      .delete(nagiZenkatsuCommentJobs)
      .where(inArray(nagiZenkatsuCommentJobs.submissionUri, uris));
    // 初回発見も戻す。同じコンボを何度も「世界初」として試せるようにするため。
    await tx
      .delete(nagiZenkatsuComboDiscoveries)
      .where(inArray(nagiZenkatsuComboDiscoveries.submissionUri, uris));
    await tx
      .delete(nagiZenkatsuSubmissions)
      .where(inArray(nagiZenkatsuSubmissions.uri, uris));
  });
  return { deleted: uris.length };
}
