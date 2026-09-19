import {
  db,
  nagiActors,
  nagiCardDraws,
  nagiCardGets,
  nagiCardInstances,
  nagiProfiles,
  nagiZenkatsuCards,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import {
  cardGetRkey,
  dayIndexOfDateKey,
  getComboDef,
  getThemeDef,
  isAnniversaryCard,
  parseAnniversaryCardNumber,
  resolveCardDef,
} from "@bsky-affirmative-bot/shared-configs";
import type {
  ActorView,
  CardNewsFeed,
  CardNewsItem,
  CardView,
  NagiCardGet,
  ZenkatsuSubmissionCombo,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import type { DbLike } from "./zenkatsu.js";

/**
 * 全肯定カードのニュース。**SR以上のドロー**と**ゼンカツのハイライト**が同じ列に並ぶ。
 *
 * ゼンカツを全件流すとニュースの約8割がゼンカツになり、見せたいレアドローが埋もれる。
 * ハイライトの選別は提出時に計算済みの reading ラベルから決まっている（追加コストはゼロ）。
 */

/** ニュースに載せるレアリティ。 */
const NEWS_RARITIES = ["SR", "UR", "AAR"];

export type CardGetRejection =
  | "rkey_mismatch"
  | "no_such_draw"
  | "card_mismatch"
  | "not_owned"
  | "unknown_card";

/**
 * ドローの控えを検証して索引する。
 *
 * **控えであって権威ではない。** 「引いた」という申告を card_draws（記念日は card_instances）と
 * 突き合わせ、一致しなければ索引しない。ドローの結果を決めるのは AppView のままなので、
 * repo に置いても AAR を自作することはできない。
 */
export async function indexCardGet(
  tx: DbLike,
  input: {
    uri: string;
    cid: string;
    did: string;
    rkey: string;
    record: NagiCardGet;
  },
): Promise<{ indexed: boolean; reason?: CardGetRejection }> {
  const { record, did } = input;
  const slot = isAnniversaryCard(record.card.volume)
    ? parseAnniversaryCardNumber(record.card.id).slot
    : undefined;
  // rkey は (日付, 枠) から決まる。自由な rkey を許すと同じドローを何本でも控えられる。
  if (input.rkey !== cardGetRkey(record.drawDate, record.source, slot))
    return { indexed: false, reason: "rkey_mismatch" };

  let drawnAt: Date;
  if (record.source === "anniversary") {
    // 記念日は抽選ではないので card_draws に行が無い。所持そのものを真実源にする。
    const [instance] = await tx
      .select({ acquiredAt: nagiCardInstances.acquiredAt })
      .from(nagiCardInstances)
      .where(
        and(
          eq(nagiCardInstances.ownerDid, did),
          eq(nagiCardInstances.cardVolume, record.card.volume),
          eq(nagiCardInstances.cardNumber, record.card.id),
        ),
      )
      .limit(1);
    if (!instance) return { indexed: false, reason: "not_owned" };
    drawnAt = instance.acquiredAt;
  } else {
    const [draw] = await tx
      .select({
        cardVolume: nagiCardDraws.cardVolume,
        cardNumber: nagiCardDraws.cardNumber,
        createdAt: nagiCardDraws.createdAt,
      })
      .from(nagiCardDraws)
      .where(
        and(
          eq(nagiCardDraws.did, did),
          eq(nagiCardDraws.drawDate, record.drawDate),
          eq(nagiCardDraws.drawSource, record.source),
        ),
      )
      .limit(1);
    if (!draw) return { indexed: false, reason: "no_such_draw" };
    // その日その枠で本当に出たカードと一致するか。ここが偽造の本丸。
    if (
      draw.cardVolume !== record.card.volume ||
      draw.cardNumber !== record.card.id
    )
      return { indexed: false, reason: "card_mismatch" };
    drawnAt = draw.createdAt;
  }

  const def = resolveCardDef(record.card.volume, record.card.id);
  if (!def) return { indexed: false, reason: "unknown_card" };

  await tx
    .insert(nagiCardGets)
    .values({
      uri: input.uri,
      cid: input.cid,
      did,
      cardVolume: record.card.volume,
      cardNumber: record.card.id,
      drawDate: record.drawDate,
      source: record.source,
      rarity: def.rarity,
      drawnAt,
      deletedAt: null,
    })
    .onConflictDoUpdate({
      target: nagiCardGets.uri,
      set: { cid: input.cid, deletedAt: null },
    });
  return { indexed: true };
}

/** 控えが消されたとき。所持そのものは card_instances 側が権威なので、記録から隠すだけ。 */
export async function removeCardGet(tx: DbLike, uri: string): Promise<void> {
  await tx
    .update(nagiCardGets)
    .set({ deletedAt: new Date() })
    .where(eq(nagiCardGets.uri, uri));
}

/**
 * 直近で控えを書き損ねたドロー。**履歴の埋め戻しではない。**
 *
 * ドローは AppView 側で先に確定するので、そのあとの createRecord が失敗すると控えだけが
 * 欠ける（オフライン、PDS 落ち、アプリを閉じた）。UR や AAR を引いた日にこれが起きると
 * ニュースに出ないまま終わるので、次に開いたときに拾い直せるようにする。
 *
 * **過去ぶんは遡らない。** ニュースは「今この瞬間の出来事」なので、何ヶ月も前のドローを
 * 後から控えても誰も見ないし、利用者が頼んでいない書き込みを本人の repo へ大量に撃つことになる。
 * よって窓をここだけに閉じる。
 */
const MIRROR_RETRY_DAYS = 2;

export async function listUnmirroredDraws(
  did: string,
  today: string,
): Promise<{ drawDate: string; source: string; volume: number; id: number }[]> {
  // 日付キーは "YYYY-MM-DD" なので辞書順＝時系列順。Date を経路に入れない。
  const since = new Date(
    (dayIndexOfDateKey(today) - MIRROR_RETRY_DAYS) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select({
      drawDate: nagiCardDraws.drawDate,
      source: nagiCardDraws.drawSource,
      cardVolume: nagiCardDraws.cardVolume,
      cardNumber: nagiCardDraws.cardNumber,
    })
    .from(nagiCardDraws)
    .leftJoin(
      nagiCardGets,
      and(
        eq(nagiCardGets.did, nagiCardDraws.did),
        eq(nagiCardGets.drawDate, nagiCardDraws.drawDate),
        // 控えは記念日も含む text 型。enum 側を text にそろえて比較する。
        eq(nagiCardGets.source, sql`${nagiCardDraws.drawSource}::text`),
      ),
    )
    .where(
      and(
        eq(nagiCardDraws.did, did),
        gte(nagiCardDraws.drawDate, since),
        isNull(nagiCardGets.uri),
      ),
    )
    .orderBy(desc(nagiCardDraws.drawDate));
  return rows.map((r) => ({
    drawDate: r.drawDate,
    source: r.source,
    volume: r.cardVolume,
    id: r.cardNumber,
  }));
}

const CURSOR_SEP = "::";
const encodeCursor = (at: Date, uri: string) =>
  Buffer.from(`${at.toISOString()}${CURSOR_SEP}${uri}`).toString("base64url");
const decodeCursor = (cursor: string): { at: Date; uri: string } | undefined => {
  const [at, uri] = Buffer.from(cursor, "base64url").toString().split(CURSOR_SEP);
  const parsed = at ? new Date(at) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || !uri) return undefined;
  return { at: parsed, uri };
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

/** 保存済みの成立コンボを表示用へ。定義に無いものは黙って落とす。 */
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

const view = (def: Parameters<typeof cardViewOf>[0]) => cardViewOf(def);
const cardViewOf = (
  def: NonNullable<ReturnType<typeof resolveCardDef>>,
): CardView => ({ ...def, owned: true });

/**
 * ニュース。2つの源（レアドローとゼンカツのハイライト）を時刻で突き合わせて1列にする。
 *
 * 並びの時刻は源で意味が違う。**ドローは検証済みの実時刻**（card_draws 由来）なので、
 * 過去ぶんの控えを後から書いても正しい位置に入り、今日のニュースを埋め尽くさない。
 * ゼンカツは `indexedAt`（レコードの createdAt はユーザーが自由に書けるので使わない）。
 */
export async function getCardNews(opts: {
  cursor?: string;
  limit: number;
}): Promise<CardNewsFeed> {
  const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  if (opts.cursor && !after)
    throw new ApiError(400, "invalid_request", "Invalid cursor");
  const take = opts.limit + 1;

  const [draws, zenkatsu] = await Promise.all([
    db
      .select()
      .from(nagiCardGets)
      .where(
        and(
          inArray(nagiCardGets.rarity, NEWS_RARITIES),
          isNull(nagiCardGets.deletedAt),
          after
            ? or(
                lt(nagiCardGets.drawnAt, after.at),
                and(
                  eq(nagiCardGets.drawnAt, after.at),
                  lt(nagiCardGets.uri, after.uri),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(nagiCardGets.drawnAt), desc(nagiCardGets.uri))
      .limit(take),
    db
      .select()
      .from(nagiZenkatsuSubmissions)
      .where(
        and(
          eq(nagiZenkatsuSubmissions.isHighlight, true),
          isNull(nagiZenkatsuSubmissions.deletedAt),
          after
            ? or(
                lt(nagiZenkatsuSubmissions.indexedAt, after.at),
                and(
                  eq(nagiZenkatsuSubmissions.indexedAt, after.at),
                  lt(nagiZenkatsuSubmissions.uri, after.uri),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(nagiZenkatsuSubmissions.indexedAt),
        desc(nagiZenkatsuSubmissions.uri),
      )
      .limit(take),
  ]);

  type Merged = { at: Date; uri: string; kind: "cardGet" | "zenkatsu" };
  const merged: Merged[] = [
    ...draws.map((r) => ({ at: r.drawnAt, uri: r.uri, kind: "cardGet" as const })),
    ...zenkatsu.map((r) => ({
      at: r.indexedAt,
      uri: r.uri,
      kind: "zenkatsu" as const,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.uri < b.uri ? 1 : -1));

  const page = merged.slice(0, opts.limit);
  const drawByUri = new Map(draws.map((r) => [r.uri, r]));
  const zenByUri = new Map(zenkatsu.map((r) => [r.uri, r]));
  const zenUris = page.filter((m) => m.kind === "zenkatsu").map((m) => m.uri);

  const [cardRows, actors] = await Promise.all([
    zenUris.length
      ? db
          .select({
            submissionUri: nagiZenkatsuCards.submissionUri,
            position: nagiZenkatsuCards.position,
            cardVolume: nagiZenkatsuCards.cardVolume,
            cardNumber: nagiZenkatsuCards.cardNumber,
          })
          .from(nagiZenkatsuCards)
          .where(inArray(nagiZenkatsuCards.submissionUri, zenUris))
      : Promise.resolve([]),
    loadActorViews(
      page.map((m) =>
        m.kind === "cardGet"
          ? (drawByUri.get(m.uri)?.did ?? "")
          : (zenByUri.get(m.uri)?.did ?? ""),
      ),
    ),
  ]);

  const zenCards = new Map<string, CardView[]>();
  for (const row of [...cardRows].sort((a, b) => a.position - b.position)) {
    const def = resolveCardDef(row.cardVolume, row.cardNumber);
    if (!def) continue;
    const list = zenCards.get(row.submissionUri);
    if (list) list.push(view(def));
    else zenCards.set(row.submissionUri, [view(def)]);
  }

  const items: CardNewsItem[] = page.flatMap((m): CardNewsItem[] => {
    if (m.kind === "cardGet") {
      const row = drawByUri.get(m.uri);
      const author = row && actors.get(row.did);
      const def = row && resolveCardDef(row.cardVolume, row.cardNumber);
      if (!row || !author || !def) return [];
      return [
        {
          uri: row.uri,
          cid: row.cid,
          type: "cardGet",
          author,
          at: row.drawnAt.toISOString(),
          card: view(def),
        },
      ];
    }
    const row = zenByUri.get(m.uri);
    const author = row && actors.get(row.did);
    if (!row || !author) return [];
    const theme = getThemeDef(row.themeVolume, row.themeNumber);
    return [
      {
        uri: row.uri,
        cid: row.cid,
        type: "zenkatsu",
        author,
        at: row.indexedAt.toISOString(),
        cards: zenCards.get(row.uri) ?? [],
        ...(theme ? { themeJa: theme.textJa, themeEn: theme.textEn } : {}),
        // コンボはニュースにも出す。これが攻略の伝わる道になる。
        combos: comboViewsOf(row.combos),
        tailwindCount: theme
          ? (zenCards.get(row.uri) ?? []).filter(
              (c) => c.attribute === theme.attribute,
            ).length
          : 0,
        ...(row.commentJa ? { commentJa: row.commentJa } : {}),
        ...(row.commentEn ? { commentEn: row.commentEn } : {}),
      },
    ];
  });

  const last = page.at(-1);
  return {
    items,
    ...(merged.length > opts.limit && last
      ? { cursor: encodeCursor(last.at, last.uri) }
      : {}),
  };
}
