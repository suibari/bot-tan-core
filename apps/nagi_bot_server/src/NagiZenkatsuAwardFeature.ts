import {
  db,
  nagiCardInstances,
  nagiProfiles,
  nagiZenkatsuCards,
  nagiZenkatsuComboDiscoveries,
  nagiZenkatsuSubmissions,
  nagiZenkatsuTrophies,
} from "@bsky-affirmative-bot/database";
import {
  generateZenkatsuAward,
  type ZenkatsuAwardCandidateView,
} from "@bsky-affirmative-bot/bot-brain";
import {
  decideDeterministicAwards,
  getThemeDef,
  resolveCardDef,
  shortlistForBotan,
  type CardRarity,
  type ZenkatsuAwardCandidate,
} from "@bsky-affirmative-bot/shared-configs";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

/**
 * 前日ぶんのトロフィーを確定する。
 *
 * 6種類の賞のうち5つを決定論で、最後の「今日のナギカツ部長」を botたん が選ぶ。
 * 保存する kind は旧データと同じ値のままなので、過去の受賞履歴も引き続き読める。
 *
 * 決定論のぶんの材料は提出時に計算済み（score / reading / combos）なので、
 * ここで数え直すことはしない。
 */
export async function runNagiZenkatsuAward(themeDate: string): Promise<void> {
  const rows = await db
    .select({
      uri: nagiZenkatsuSubmissions.uri,
      did: nagiZenkatsuSubmissions.did,
      score: nagiZenkatsuSubmissions.score,
      reading: nagiZenkatsuSubmissions.reading,
      themeVolume: nagiZenkatsuSubmissions.themeVolume,
      themeNumber: nagiZenkatsuSubmissions.themeNumber,
      indexedAt: nagiZenkatsuSubmissions.indexedAt,
    })
    .from(nagiZenkatsuSubmissions)
    .where(
      and(
        eq(nagiZenkatsuSubmissions.themeDate, themeDate),
        // 本人が消した提出は賞の対象にしない。
        isNull(nagiZenkatsuSubmissions.deletedAt),
      ),
    );
  if (!rows.length) return;

  const uris = rows.map((r) => r.uri);
  const [cardRows, discoveries] = await Promise.all([
    db
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
      .leftJoin(
        nagiCardInstances,
        and(
          eq(nagiCardInstances.ownerDid, nagiZenkatsuSubmissions.did),
          eq(nagiCardInstances.cardVolume, nagiZenkatsuCards.cardVolume),
          eq(nagiCardInstances.cardNumber, nagiZenkatsuCards.cardNumber),
        ),
      )
      .where(inArray(nagiZenkatsuCards.submissionUri, uris))
      .orderBy(asc(nagiZenkatsuCards.position)),
    // その提出で「初めて」発見されたコンボ。発見者は1コンボ1人なので、
    // ここに出てくる時点でその人が最初。
    db
      .select({ submissionUri: nagiZenkatsuComboDiscoveries.submissionUri })
      .from(nagiZenkatsuComboDiscoveries)
      .where(inArray(nagiZenkatsuComboDiscoveries.submissionUri, uris)),
  ]);

  const cardsByUri = new Map<
    string,
    { nameJa: string; rarity: CardRarity; attribute: string }[]
  >();
  for (const row of cardRows) {
    const def = resolveCardDef(
      row.cardVolume,
      row.cardNumber,
      row.anniversaryLabel ?? undefined,
    );
    if (!def) continue;
    const list = cardsByUri.get(row.submissionUri) ?? [];
    list.push({
      nameJa: def.nameJa,
      rarity: def.rarity,
      attribute: def.attribute,
    });
    cardsByUri.set(row.submissionUri, list);
  }
  const newCombosByUri = new Map<string, number>();
  for (const row of discoveries)
    newCombosByUri.set(
      row.submissionUri,
      (newCombosByUri.get(row.submissionUri) ?? 0) + 1,
    );

  const theme = getThemeDef(rows[0].themeVolume, rows[0].themeNumber);
  const labelsOf = (reading: unknown): string[] =>
    Array.isArray(reading) ? (reading as string[]) : [];

  const candidates: ZenkatsuAwardCandidate[] = rows.map((row) => {
    const cards = cardsByUri.get(row.uri) ?? [];
    const labels = labelsOf(row.reading);
    return {
      submissionUri: row.uri,
      did: row.did,
      score: row.score,
      cardCount: cards.length,
      tailwindCount: theme
        ? cards.filter((c) => c.attribute === theme.attribute).length
        : 0,
      // 「初登板: A、B」というラベルの人数ぶんを数える。提出時の計算をそのまま使う。
      debutCount:
        labels
          .find((l) => l.startsWith("初登板:"))
          ?.split("、").length ?? 0,
      rarities: cards.map((c) => c.rarity),
      newComboCount: newCombosByUri.get(row.uri) ?? 0,
      indexedAt: row.indexedAt.getTime(),
    };
  });

  const awards = decideDeterministicAwards(candidates);
  if (awards.length)
    await db
      .insert(nagiZenkatsuTrophies)
      .values(
        awards.map((a) => ({
          themeDate,
          did: a.did,
          kind: a.kind,
          submissionUri: a.submissionUri,
        })),
      )
      .onConflictDoNothing();

  // 今日のナギカツ部長。候補が1人しか居ない日は選ばせず、そのまま贈る。
  const shortlist = shortlistForBotan(candidates);
  if (!shortlist.length) return;
  if (!theme) throw new Error(`zenkatsu award: theme for ${themeDate} is missing`);

  const names = await db
    .select({ did: nagiProfiles.did, displayName: nagiProfiles.displayName })
    .from(nagiProfiles)
    .where(inArray(nagiProfiles.did, shortlist.map((c) => c.did)));
  const nameByDid = new Map(names.map((n) => [n.did, n.displayName]));
  const readingByUri = new Map(rows.map((r) => [r.uri, labelsOf(r.reading)]));

  let winner = shortlist[0];
  let reasonJa = "";
  let reasonEn = "";

  if (shortlist.length > 1) {
    const views: ZenkatsuAwardCandidateView[] = shortlist.map((c) => ({
      displayName: nameByDid.get(c.did)?.trim() || "この人",
      cardNames: (cardsByUri.get(c.submissionUri) ?? []).map((x) => x.nameJa),
      reading: readingByUri.get(c.submissionUri) ?? [],
    }));
    const result = await generateZenkatsuAward({
      themeJa: theme.textJa,
      themeEn: theme.textEn,
      candidates: views,
    });
    winner = shortlist[result.pick - 1] ?? shortlist[0];
    reasonJa = result.reasonJa;
    reasonEn = result.reasonEn;
  }

  await db
    .insert(nagiZenkatsuTrophies)
    .values({
      themeDate,
      did: winner.did,
      kind: "botan",
      submissionUri: winner.submissionUri,
      commentJa: reasonJa || null,
      commentEn: reasonEn || null,
    })
    .onConflictDoNothing();
}
