import {
  db,
  nagiCardInstances,
  nagiProfiles,
  nagiZenkatsuCards,
  nagiZenkatsuSubmissions,
  nagiZenkatsuTrophies,
} from "@bsky-affirmative-bot/database";
import {
  generateZenkatsuAward,
  type ZenkatsuAwardCandidateView,
} from "@bsky-affirmative-bot/bot-brain";
import {
  getThemeDef,
  resolveCardDef,
  candidatesForBottan,
  shortlistForBottan,
  type ZenkatsuBotanCandidate,
} from "@bsky-affirmative-bot/shared-configs";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

/**
 * 前日ぶんの部長賞を確定する。
 *
 * 部長賞だけを前日ぶんから選ぶ。ほかの賞は提出時に AppView が即時付与する。
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
  const cardRows = await db
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
    .orderBy(asc(nagiZenkatsuCards.position));

  const cardsByUri = new Map<string, { nameJa: string }[]>();
  for (const row of cardRows) {
    const def = resolveCardDef(
      row.cardVolume,
      row.cardNumber,
      row.anniversaryLabel ?? undefined,
    );
    if (!def) continue;
    const list = cardsByUri.get(row.submissionUri) ?? [];
    list.push({ nameJa: def.nameJa });
    cardsByUri.set(row.submissionUri, list);
  }
  const theme = getThemeDef(rows[0].themeVolume, rows[0].themeNumber);
  const labelsOf = (reading: unknown): string[] =>
    Array.isArray(reading) ? (reading as string[]) : [];

  const candidates: ZenkatsuBotanCandidate[] = rows.map((row) => ({
    submissionUri: row.uri,
    did: row.did,
    score: row.score,
    indexedAt: row.indexedAt.getTime(),
  }));

  const [year, month, day] = themeDate.split("-").map(Number);
  const previousThemeDate = new Date(Date.UTC(year, month - 1, day - 1))
    .toISOString()
    .slice(0, 10);
  const [previousTrophy] = await db
    .select({ did: nagiZenkatsuTrophies.did })
    .from(nagiZenkatsuTrophies)
    .where(
      and(
        eq(nagiZenkatsuTrophies.themeDate, previousThemeDate),
        eq(nagiZenkatsuTrophies.kind, "botan"),
      ),
    )
    .limit(1);

  // 前日の部長を外してから上位候補を選ぶ。ほかに提出者がいなければ再選を許可する。
  const shortlist = shortlistForBottan(
    candidatesForBottan(candidates, previousTrophy?.did),
  );
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
