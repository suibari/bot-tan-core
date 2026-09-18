import {
  db,
  nagiCardInstances,
  nagiProfiles,
  nagiZenkatsuCards,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import {
  generateZenkatsuComment,
  NAGI_ZENKATSU_PROMPT_VERSION,
} from "@bsky-affirmative-bot/bot-brain";
import {
  aiModel,
  getThemeDef,
  resolveCardDef,
  type CardDefinition,
} from "@bsky-affirmative-bot/shared-configs";
import { and, asc, eq } from "drizzle-orm";

/**
 * ゼンカツ！の提出に、botたんの総評を付ける。
 *
 * 総評はその提出（zenkatsu_submissions の行）に紐づく。同じ札でも、お題と人が違えば
 * 違う言葉が付く。プロンプトへ渡す「読み」は取り込み時に計算済みで、ここでは組み立てない
 * （量子化モデルに算術をさせないため。docs/zenkatsu.md 6.4）。
 */
export async function runNagiZenkatsu(submissionUri: string): Promise<void> {
  const [submission] = await db
    .select({
      did: nagiZenkatsuSubmissions.did,
      themeVolume: nagiZenkatsuSubmissions.themeVolume,
      themeNumber: nagiZenkatsuSubmissions.themeNumber,
      reading: nagiZenkatsuSubmissions.reading,
      deletedAt: nagiZenkatsuSubmissions.deletedAt,
    })
    .from(nagiZenkatsuSubmissions)
    .where(eq(nagiZenkatsuSubmissions.uri, submissionUri))
    .limit(1);
  if (!submission) return;
  // 本人が消した提出に総評を付けても誰も読まない。ジョブ側でも取り下げているが、
  // 競合して残った場合のために見ておく。
  if (submission.deletedAt) return;

  const theme = getThemeDef(submission.themeVolume, submission.themeNumber);
  if (!theme)
    throw new Error(
      `zenkatsu: theme ${submission.themeVolume}-${submission.themeNumber} is missing`,
    );

  const cardRows = await db
    .select({
      cardVolume: nagiZenkatsuCards.cardVolume,
      cardNumber: nagiZenkatsuCards.cardNumber,
      anniversaryLabel: nagiCardInstances.anniversaryLabel,
    })
    .from(nagiZenkatsuCards)
    .leftJoin(
      nagiCardInstances,
      and(
        eq(nagiCardInstances.ownerDid, submission.did),
        eq(nagiCardInstances.cardVolume, nagiZenkatsuCards.cardVolume),
        eq(nagiCardInstances.cardNumber, nagiZenkatsuCards.cardNumber),
      ),
    )
    .where(eq(nagiZenkatsuCards.submissionUri, submissionUri))
    // プレイヤーが置いた順は意味を持つ（総評もその順に読む）。
    .orderBy(asc(nagiZenkatsuCards.position));

  const cards = cardRows.flatMap((row): CardDefinition[] => {
    const def = resolveCardDef(
      row.cardVolume,
      row.cardNumber,
      row.anniversaryLabel ?? undefined,
    );
    return def ? [def] : [];
  });
  if (!cards.length) return;

  const [profile] = await db
    .select({ displayName: nagiProfiles.displayName })
    .from(nagiProfiles)
    .where(eq(nagiProfiles.did, submission.did))
    .limit(1);

  const comment = await generateZenkatsuComment({
    displayName: profile?.displayName?.trim() || "あなた",
    themeJa: theme.textJa,
    themeEn: theme.textEn,
    cards,
    reading: Array.isArray(submission.reading)
      ? (submission.reading as string[])
      : [],
  });
  if (!comment.commentJa) throw new Error("zenkatsu: empty comment");

  await db
    .update(nagiZenkatsuSubmissions)
    .set({
      commentJa: comment.commentJa,
      commentEn: comment.commentEn || null,
      commentModel: aiModel("NAGI_ZENKATSU"),
      commentPromptVersion: NAGI_ZENKATSU_PROMPT_VERSION,
    })
    .where(eq(nagiZenkatsuSubmissions.uri, submissionUri));
}
