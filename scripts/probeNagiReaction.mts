/**
 * Nagi の絵文字リアクションを受けた返信を、実際の投稿で生成し直して比べる。
 *
 * 投稿はしない。入力は本番DBから書き出した JSON（1件 = 返信済みジョブ + そのとき拾った
 * リアクション + 実際に投稿された返信）。本番DBへ直接つながないのは、生成経路に
 * unknownTerms 登録などの書き込みがあるため。生成時の DATABASE_URL は開発DBにすること。
 *
 * 使い方:
 *   pnpm exec tsx --env-file=.env scripts/probeNagiReaction.mts --cases=/path/cases.json
 *   ... --limit=20 --n=2 --no-images --out=/path/result.jsonl
 *
 * 本番の返信と違い、記憶・botたんの状況・会話履歴は載せない（リアクション指示の効きを見るため）。
 * 会話モードのジョブは履歴なしの会話として生成する。
 */
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { conversation, generateAffirmativeWord } from "../packages/bot_brain/src/index.js";
import { blobImagesToImageRefs, resolvePdsUrl } from "../packages/bot-runtime/src/media.js";
import { receivedNagiReaction } from "../apps/nagi_bot_server/src/nagiReplyContext.js";
import { isReplyToBot } from "../apps/nagi_bot_server/src/NagiReplyFeature.js";

type Case = {
  sourceUri: string;
  authorDid: string;
  createdAt: string;
  record: any;
  embedImages: any[] | null;
  displayName: string | null;
  handle: string | null;
  emoji: string;
  emojiUri: string | null;
  emojiName: string | null;
  emojiAlt: string | null;
  emojiSearchText: string | null;
  repeated: boolean;
  actualReply: string | null;
};

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length)).at(-1);
}

const casesPath = arg("cases");
if (!casesPath) {
  console.error("--cases=<JSON> は必須");
  process.exit(1);
}
const limit = Number(arg("limit") ?? "Infinity");
const samples = Number(arg("n") ?? "1");
const withImages = !process.argv.includes("--no-images");
const out = arg("out");
if (out) writeFileSync(out, "");

const botDid = process.env.NAGI_BOT_DID!;
const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8")).slice(0, limit);

for (const [index, item] of cases.entries()) {
  const text = typeof item.record?.text === "string" ? item.record.text : "";
  const lang = String(item.record?.langs?.[0] ?? "ja").startsWith("ja") ? "日本語" : "English";
  const reaction = receivedNagiReaction(item, { repeated: item.repeated });
  let image: UserInfoGemini["image"];
  if (withImages && item.embedImages?.length) {
    try {
      const pds = await resolvePdsUrl(item.authorDid);
      image = blobImagesToImageRefs(item.authorDid, pds, item.embedImages) as any;
    } catch (error) {
      console.warn(`[WARN] 画像を解決できなかった: ${item.sourceUri}`, error);
    }
  }
  const mode = isReplyToBot(item.record, botDid) ? "conversation" : "affirmative";
  const userinfo = {
    follower: {
      did: item.authorDid,
      handle: item.handle ?? "unknown",
      displayName: item.displayName ?? item.handle ?? "",
    },
    posts: [text],
    image,
    receivedNagiReaction: reaction,
    isSubscriber: false,
    langStr: lang,
  } as UserInfoGemini;

  const generated: string[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      generated.push(
        mode === "conversation"
          ? ((await conversation({ ...userinfo, history: [] } as any)).text_bot ?? "")
          : (await generateAffirmativeWord(userinfo)).comment,
      );
    } catch (error) {
      generated.push(`[ERROR] ${(error as Error).message}`);
    }
  }

  const result = {
    index,
    mode,
    emoji: item.emojiName ?? item.emoji,
    custom: Boolean(item.emojiUri),
    repeated: item.repeated,
    associations: item.emojiSearchText?.split("\n").slice(0, 6).join("/") ?? null,
    images: image?.length ?? 0,
    post: text,
    actualReply: item.actualReply,
    generated,
  };
  if (out) appendFileSync(out, `${JSON.stringify(result)}\n`);
  console.log(
    `\n=== [${index + 1}/${cases.length}] ${result.emoji}${result.repeated ? "（繰り返し）" : ""} ${mode} 画像${result.images}`,
  );
  console.log(`投稿: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  console.log(`本番: ${(item.actualReply ?? "").replace(/\s+/g, " ")}`);
  for (const comment of generated) console.log(`新案: ${comment.replace(/\s+/g, " ")}`);
}
process.exit(0);
