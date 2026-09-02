import { Type } from "@google/genai";
import { gemini } from "./index.js";
import { generateContentWithRetry } from "./util.js";
import { UserInfoGemini, SYSTEM_INSTRUCTION, safeFetch } from "@bsky-affirmative-bot/shared-configs";

export interface AnalyzeResult {
  analysis: string;
  title_ja: string;
  title_en: string;
}

export async function generateAnalyzeResult(userinfo: UserInfoGemini): Promise<AnalyzeResult> {
  const prompt = PROMPT_ANALYZE(userinfo);
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
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          analysis: {
            type: Type.STRING,
            description: "性格分析の本文（空の行は含めないこと。具体的なポストやいいね内容に言及し、全肯定のスタンスで分析すること）"
          },
          title_ja: {
            type: Type.STRING,
            description: "ユーザーにふさわしい日本語の称号（20字以内、例: 癒やしの哲学者）"
          },
          title_en: {
            type: Type.STRING,
            description: "同じ称号の英語訳（30字以内、例: Philosopher of Healing）"
          }
        },
        required: ["analysis", "title_ja", "title_en"]
      }
    }
  }, 3, userinfo);

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

const PROMPT_ANALYZE = (userinfo: UserInfoGemini) => {
  return userinfo.langStr === "日本語" ?
    `ユーザ自身のポストとユーザがいいねしたポストを基に、性格分析をしてください。
出力する性格分析の本文の文字数は最大500文字までです。
空の行は入れないでください。
分析結果は以下の要素に基づいて生成してください。具体的なポスト内容やいいね内容に言及してください。
* ポジティブなポストの割合
* どんな趣味を持っているか(ユーザのポストおよびいいねから分析する)
* 相性の良さそうな人(いいねから分析する)
* 心がけるといいこと
# ルール
* 悪い内容は含まず、全肯定のスタンスで分析してください。
* ユーザがいいねしたポストは、ユーザ自身のポストではありません。趣味の参考としてのみ参照してください。

また、ユーザの性格やポストの様子から、ユーザにふさわしい「称号」を考えてください。
称号は、日本語（20字以内）と、その英語訳（30字以内）の両方を考えてください。
- title_ja は日本語で書いてください。
- title_en は title_ja と同じ称号の自然な英訳にし、別の題材を選ばないでください。
  **必ず英語で書いてください。** 日本語をそのまま入れたり、日本語に英字を添えたりしてはいけません。
例：
- 日本語: 「癒やしの哲学者」, 英語: 「Philosopher of Healing」
- 日本語: 「趣味の探求者」, 英語: 「Explorer of Hobbies」

以下がユーザ名およびポスト、いいねしたポストです。
-----
ユーザ名: ${userinfo.follower.displayName}
ポスト内容: ${userinfo.posts || ""}
ユーザがいいねしたポスト: ${userinfo.likedByFollower || ""}
` :
    `Please analyze the user's personality based on their own posts and the posts they have liked.
The output should be in ${userinfo.langStr}.
The maximum number of characters that can be output for the analysis body is 1000.
Do not include any blank lines.

The personality analysis should be based on the following aspects, and should include references to the content of their posts and likes:
* The proportion of positive posts
* What hobbies they seem to have (based on both their posts and their likes)
* What kind of people they are likely to get along with (based on their likes)
* Things they might want to keep in mind

Rules:
* Keep the tone fully positive and affirming. Do **not** include anything negative or critical.
* Liked posts by user are not the user's own posts. Please use it as reference only for hobbies.

Also, based on their personality and posts, award them a fitting "title".
Provide the title in both Japanese (within 20 characters) and English (within 30 characters).
- Write title_ja in Japanese.
- title_en must be a natural English translation of the same title, not a different subject.
  **Write it in English.** Never leave Japanese text in title_en.
Examples:
- Japanese: 「癒やしの哲学者」, English: 「Philosopher of Healing」
- Japanese: 「趣味の探求者」, English: 「Explorer of Hobbies」

-----Below is the username, user's posts and likes-----  
Username: ${userinfo.follower.displayName}  
Posts: ${userinfo.posts || ""}  
Liked posts by user: ${userinfo.likedByFollower || ""}
`;
};
