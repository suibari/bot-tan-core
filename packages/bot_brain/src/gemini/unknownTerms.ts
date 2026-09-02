import type { AiFeatureKey, UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { normalizeJsonSchema } from "./generationClient.js";
import { groundingPolicyForFeature } from "./grounding.js";

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
 * 利用者が投稿に貼ったリンクを取り出す。
 *
 * 語（新語）と違い、URL は**その場で読む**。「このリンク見て」に対して
 * 「あとで読んでおくね」では会話にならないため、非同期キューへは積まない。
 * 読むのは prepareOllamaGrounding（SSRF 検証込みの fetchReadableText 経由）。
 *
 * リンクカードには title / description が最初から付いており、それは従来どおり
 * プロンプトへ載る。ここで取り出すのは「本文まで読む」ぶんの上積み。
 */
export function sharedLinkUrls(userinfo?: UserInfoGemini): string[] {
  const embed = userinfo?.embed;
  if (!embed) return [];
  const urls = new Set<string>();
  for (const link of embed.links_embed ?? []) {
    if (typeof link?.uri === "string") urls.add(link.uri);
  }
  if (typeof embed.uri_embed === "string") urls.add(embed.uri_embed);
  return [...urls];
}

/**
 * この機能で「知らなかった語」を申告させるか。
 *
 * 同期パスで検索しない機能（deferred）だけが対象。おみくじ等を巻き込むと
 * 自由文だった出力が JSON に変わってしまう。
 */
export function collectsUnknownTerms(feature?: AiFeatureKey): boolean {
  return groundingPolicyForFeature(feature) === "deferred";
}

/**
 * `{reply, unknownTerms}` を解いて本文と語に分ける。
 *
 * 解析に失敗したら素のテキストとして返す。ここで throw すると、構造化に失敗しただけで
 * リプライが消える。**利用者に生の JSON が届かないことが最優先。**
 */
export function unwrapReplyWithTerms(text: string): { reply: string; terms: string[] } {
  const raw = text ?? "";
  try {
    const parsed = JSON.parse(
      /```json\n([\s\S]*?)\n```/.exec(raw)?.[1] ??
        /(\{[\s\S]*\})/.exec(raw)?.[1] ??
        raw,
    ) as { reply?: unknown; unknownTerms?: unknown };
    return {
      reply: typeof parsed?.reply === "string" ? parsed.reply : raw,
      terms: sanitizeUnknownTerms(parsed?.unknownTerms),
    };
  } catch {
    return { reply: raw, terms: [] };
  }
}
