import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { normalizeJsonSchema } from "./generationClient.js";

/**
 * 返信を書いたモデル自身に「この投稿で知らなかった語」を申告させ、非同期で調べる。
 *
 * 【なぜこの形か】
 * 同期パス時代は planner（LLM）が投稿を読み直して検索要否を判断していた。それを
 * 正規表現に置き換えると「薬屋のひとりごと見た！」のような新語だけの投稿を丸ごと
 * 取りこぼす。かといって非同期側で planner を回すと、返信生成とは別にもう一度
 * 投稿を読ませることになる。
 *
 * 返信を書いたモデルは、まさにその投稿を読んだ直後で「何を知らなかったか」を
 * 一番よく知っている。生成と同じ1回のリクエストで一緒に出させれば、
 *   - 判定用の LLM 呼び出しがゼロになる（同期・非同期とも）
 *   - 正規表現に頼らない
 *   - キューに載るのが投稿本文ではなく抽出された語だけになる
 * が同時に成り立つ。
 */

const MAX_TERMS = 5;
const MAX_TERM_LENGTH = 60;
/** 用語として短すぎるものは検索してもノイズにしかならない。 */
const MIN_TERM_LENGTH = 2;

export const UNKNOWN_TERMS_INSTRUCTION = `
Also report the words in the user's post that you do not actually know — new titles, products,
people, slang, events. Put them in "unknownTerms" exactly as they appear in the post, at most
${MAX_TERMS}. This list is never shown to the user; it is only used to look them up later.
Leave it empty when you genuinely know everything mentioned. Do not put common words,
the user's name, or anything you are merely unsure how to reply to.
返信文そのものには「あとで調べる」等と書かないこと。unknownTerms は裏側の申告であって会話ではない。`;

const unknownTermsProperty = {
  type: "ARRAY",
  items: { type: "STRING" },
  maxItems: MAX_TERMS,
};

/** 自由文を返す機能を `{reply, unknownTerms}` の構造化出力へ包む。 */
export const replyWithUnknownTermsSchema = () =>
  normalizeJsonSchema({
    type: "OBJECT",
    properties: {
      reply: { type: "STRING" },
      unknownTerms: unknownTermsProperty,
    },
    required: ["reply"],
  });

/** 既に JSON を返している機能のスキーマへ `unknownTerms` を足す。 */
export function withUnknownTermsProperty(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return { ...properties, unknownTerms: unknownTermsProperty };
}

export function sanitizeUnknownTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const term = item.replace(/\s+/g, " ").trim().slice(0, MAX_TERM_LENGTH);
    if (term.length < MIN_TERM_LENGTH) continue;
    // URL は reportSharedLinks が別に積む。検索語として扱っても意味がない。
    if (/^https?:\/\//i.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/**
 * 調べる仕事をキューへ積む。fire-and-forget。
 *
 * `@bsky-affirmative-bot/database` は import しただけで dotenv を読み Postgres
 * クライアントを作るので、生成を呼ばないユニットテストを巻き込まないよう遅延 import する。
 * 失敗しても返信は既に成立しているので握り潰す。
 */
export function reportUnknownTerms(terms: string[]): void {
  if (!terms.length) return;
  void (async () => {
    try {
      const { enqueueResearchJob } = await import("@bsky-affirmative-bot/database");
      for (const term of terms) await enqueueResearchJob(term);
    } catch {
      // 調べられなくても、その場では「知らない」と答えて成立している。
    }
  })();
}

/**
 * 利用者が投稿に貼った URL を調査キューへ積む。Gemini の URL Context の置き換え。
 *
 * 語と違って「調べるべきか」の判断は要らない。貼られた時点で対象なので、モデルの
 * 申告を待たずにここで積む。ワーカーが検索せず本文を直接読み、結果は語と同じく
 * bot memory へ入るので、次に同じリンクや話題が来たときに使える。
 *
 * リンクカードには title / description が最初から付いており、それは従来どおり
 * プロンプトへ載る。ここで積むのは「本文まで読む」ぶんの上積み。
 */
export function reportSharedLinks(userinfo?: UserInfoGemini): void {
  const embed = userinfo?.embed;
  if (!embed) return;
  const urls = new Set<string>();
  for (const link of embed.links_embed ?? []) {
    if (typeof link?.uri === "string") urls.add(link.uri);
  }
  if (typeof embed.uri_embed === "string") urls.add(embed.uri_embed);
  if (!urls.size) return;

  void (async () => {
    try {
      const { enqueueResearchJob } = await import("@bsky-affirmative-bot/database");
      for (const url of [...urls].slice(0, 3)) await enqueueResearchJob(url);
    } catch {
      // 読めなくても、カードの title / description でリプライは成立している。
    }
  })();
}
