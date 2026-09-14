import { Type } from "@google/genai";
import { gemini } from "./index.js";
import { generateContentWithRetry } from "./util.js";
import {
  UserInfoGemini,
  BOT_ANALYSIS_BRIEF_EN,
  BOT_ANALYSIS_BRIEF_JA,
  safeFetch,
} from "@bsky-affirmative-bot/shared-configs";
import { bulletList, limitLikedMaterial } from "./analysisMaterials.js";

export interface AnalyzeResult {
  analysis: string;
  title_ja: string;
  title_en: string;
}

export async function generateAnalyzeResult(userinfo: UserInfoGemini): Promise<AnalyzeResult> {
  const prompt = buildAnalyzePrompt(userinfo);
  const contents: any[] = [prompt];

  if (userinfo?.image) {
    for (const img of userinfo.image) {
      try {
        const response = await safeFetch(img.image_url);
        if (!response.ok) {
          console.warn(`[WARN] Failed to fetch image: ${img.image_url} (Status: ${response.status})`);
          continue;
        }
        const imageArrayBuffer = await response.arrayBuffer();
        const base64ImageData = Buffer.from(imageArrayBuffer).toString("base64");
        contents.push({
          inlineData: {
            mimeType: img.mimeType,
            data: base64ImageData,
          }
        });
      } catch (e) {
        console.warn(`[WARN] Error fetching image: ${img.image_url}`, e);
        continue;
      }
    }
  }

  const response = await generateContentWithRetry({
    feature: "BSKY_ANALYZE",
    contents,
    config: {
      // ペルソナ全文（SYSTEM_INSTRUCTION）は載せない。botたん自身の趣味リストと
      // 「あなたの趣味と似た話題は自分の知識として反応して」という指示が入っていて、
      // それが分析対象の人の趣味として出力に混ざる（Nagi の名刺で実際に起きた）。
      systemInstruction:
        userinfo.langStr === "日本語"
          ? BOT_ANALYSIS_BRIEF_JA
          : BOT_ANALYSIS_BRIEF_EN,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          analysis: {
            type: Type.STRING,
            description: "性格分析の本文（空の行は含めないこと。**本人の投稿にある内容だけ**に言及し、全肯定のスタンスで分析すること。いいね先の投稿は他人の文章なので、そこにある趣味や作品名を本人のものとして書かないこと）"
          },
          title_ja: {
            type: Type.STRING,
            description: "ユーザーにふさわしい日本語の称号（20字以内、例: 癒やしの哲学者）。**本人の投稿から読み取れること**を元にすること"
          },
          title_en: {
            type: Type.STRING,
            description: "同じ称号の英語訳（30字以内、例: Philosopher of Healing）"
          }
        },
        required: ["analysis", "title_ja", "title_en"]
      }
    }
    // userinfo を渡さない。渡すと botContext（botたんの直近24時間の行動履歴・最悪4000字）が
    // プロンプト末尾＝ユーザの投稿の後ろへ連結される。他人の性格分析には無関係な材料で、
    // AGENTS.md「プロンプトの並び順」が禁じている形でもある。
  }, 3);

  try {
    const responseText = response.text || "{}";
    const cleanedText = responseText.replace(/\[.*?\]/gs, '');
    const json = JSON.parse(cleanedText) as AnalyzeResult;
    return {
      analysis: json.analysis || "",
      title_ja: json.title_ja || "全肯定の賢者",
      title_en: json.title_en || "Affirmative Sage"
    };
  } catch (e) {
    console.error("[ERROR] Failed to parse Structured Outputs JSON in generateAnalyzeResult:", e);
    return {
      analysis: response.text || "",
      title_ja: "全肯定の賢者",
      title_en: "Affirmative Sage"
    };
  }
}

/**
 * 分析プロンプトを組み立てる。
 *
 * 並びは **[指示 → いいね先（他人の投稿） → 本人の投稿]**。本人の投稿をいちばん後ろに
 * 置くのは AGENTS.md「プロンプトの並び順」の規則どおり。
 *
 * 材料の扱いを作り直した理由は Nagi の名刺と同じ（buildNagiAnalysisPrompt のコメント参照）。
 * 「いいねしたポストは趣味の参考に」という指示のままだと、他人の投稿にある趣味・作品名が
 * そのまま本人の趣味として出る。Bluesky 側は配列をテンプレートへ直接埋めていたので、
 * 材料が "a,b,c" のカンマ区切りになり、1件の境界すら消えていた。
 */
export const buildAnalyzePrompt = (userinfo: UserInfoGemini) => {
  const ownPosts = bulletList(userinfo.posts ?? []);
  const likedPosts = bulletList(limitLikedMaterial(userinfo.likedByFollower ?? []));

  if (userinfo.langStr === "日本語") {
    // いいねが1件も無いなら、いいねの話はプロンプトから消す。
    // 材料が無いまま「相性の良さそうな人」を求めると、モデルは埋めるために作る。
    const likeElement = likedPosts
      ? "* 相性の良さそうな人（本人がいいねした投稿の傾向から分析する）\n"
      : "";
    const likeRules = likedPosts
      ? `* 「## 本人がいいねした、他の人の投稿」は **他の人が書いた文章** です。本人が書いたものではありません。
  そこに出てくる趣味・作品名・仕事・活動を、本人のものとして書いては **絶対にいけません**。
* いいねから言えるのは「どんな話題に反応する人か」「どんな人と相性が良さそうか」だけです。
`
      : "";

    return `ある人（以下「本人」）の投稿を読んで、その人の性格分析をしてください。
出力する性格分析の本文の文字数は最大500文字までです。
空の行は入れないでください。
分析は以下の要素に基づいて生成し、本人の具体的な投稿内容に言及してください。
* ポジティブな投稿の割合
* どんな趣味を持っているか（**本人の投稿だけ**から分析する）
${likeElement}* 心がけるといいこと
# 材料の扱い（いちばん大事なルール）
* 本人がどんな人かを判断してよい材料は「## 本人の投稿」**だけ**です。
${likeRules}* 趣味・好きなもの・仕事・していることは、**本人の投稿に書かれているときだけ** 書いてよいです。
* 固有名詞（作品名・ゲーム名・製品名・技術名など）は、本人の投稿に出てきたものだけ使えます。
  本人の投稿に一つも出てこないなら、固有名詞は書かないでください。
* あなた自身（botたん）の趣味や好みを、本人の趣味として書いてはいけません。
* 材料が少ないときは、書ける範囲で短く書いてください。埋めるために推測を足さないでください。
# ルール
* 悪い内容は含まず、全肯定のスタンスで分析してください。

また、本人の性格や投稿の様子から、本人にふさわしい「称号」を考えてください。
称号も、本人の投稿から読み取れることを元にしてください。
称号は、日本語（20字以内）と、その英語訳（30字以内）の両方を考えてください。
- title_ja は日本語で書いてください。
- title_en は title_ja と同じ称号の自然な英訳にし、別の題材を選ばないでください。
  **必ず英語で書いてください。** 日本語をそのまま入れたり、日本語に英字を添えたりしてはいけません。
例：
- 日本語: 「癒やしの哲学者」, 英語: 「Philosopher of Healing」
- 日本語: 「趣味の探求者」, 英語: 「Explorer of Hobbies」

-----
ユーザ名: ${userinfo.follower.displayName}
${
      likedPosts
        ? `
## 本人がいいねした、他の人の投稿（本人の発言ではない。趣味・仕事の根拠にしてはいけない）
${likedPosts}
`
        : ""
    }
## 本人の投稿（分析の対象はこれだけ）
${ownPosts}
`;
  }

  const likeElement = likedPosts
    ? "* What kind of people they are likely to get along with (from the tendency of the posts they liked)\n"
    : "";
  const likeRules = likedPosts
    ? `* "## Posts by OTHER PEOPLE that they liked" were **written by other people**, not by them.
  You must **never** present the hobbies, titles, jobs, or activities found there as theirs.
* All you may draw from likes is what topics they respond to and what kind of people they would get along with.
`
    : "";

  return `Read one person's own posts and analyze their personality.
The output should be in ${userinfo.langStr}.
The maximum number of characters that can be output for the analysis body is 1000.
Do not include any blank lines.

The personality analysis should be based on the following aspects, and should refer to the content of their own posts:
* The proportion of positive posts
* What hobbies they seem to have (**from their own posts only**)
${likeElement}* Things they might want to keep in mind

How to use the material (the most important rules):
* The **only** material you may use to judge what this person is like is "## Their own posts".
${likeRules}* Hobbies, favourite things, work, and activities may be written **only when they appear in their own posts**.
* Proper nouns (titles of works, games, products, technologies) may be used only if they appear in their own posts. If none appear there, use no proper nouns at all.
* Never present your own hobbies or tastes as theirs.
* When there is little material, write briefly. Do not add guesses to fill space.

Rules:
* Keep the tone fully positive and affirming. Do **not** include anything negative or critical.

Also, based on their personality and posts, award them a fitting "title".
The title must also be grounded in what their own posts show.
Provide the title in both Japanese (within 20 characters) and English (within 30 characters).
- Write title_ja in Japanese.
- title_en must be a natural English translation of the same title, not a different subject.
  **Write it in English.** Never leave Japanese text in title_en.
Examples:
- Japanese: 「癒やしの哲学者」, English: 「Philosopher of Healing」
- Japanese: 「趣味の探求者」, English: 「Explorer of Hobbies」

-----
Username: ${userinfo.follower.displayName}
${
    likedPosts
      ? `
## Posts by OTHER PEOPLE that they liked (not written by them; never use as evidence of their hobbies or work)
${likedPosts}
`
      : ""
  }
## Their own posts (this is the only material to analyze)
${ownPosts}
`;
};
