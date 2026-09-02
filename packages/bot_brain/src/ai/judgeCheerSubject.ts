import { PartListUnion, Type } from "@google/genai";
import { SYSTEM_INSTRUCTION, safeFetch } from "@bsky-affirmative-bot/shared-configs";
import { UserInfoGemini, GeminiScore } from "@bsky-affirmative-bot/shared-configs";
import { generateContentForFeature } from "./routedGeneration.js";


type GeminiJudgeResult = {
  result: boolean;
  comment: string;
}

export async function judgeCheerSubject(userinfo: UserInfoGemini) {
  const SCHEMA_CHECKCHEER = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        result: {
          type: Type.BOOLEAN,
        },
        comment: {
          type: Type.STRING,
        }
      },
      propertyOrdering: ["result", "comment"],
    }
  }

  const prompt =
    `
以下のユーザのポストおよび画像を拡散してよいかどうか、ジャッジを行ってください。
resultに、拡散してよいならtrue, 拡散NGならfalseを出力してください。
commentには、そう判断した理由を出力してください。
ジャッジのポイントは以下です。
* イラスト、音楽、ブログ、撮影した写真のほか、チーム活動やコミュニティ（Discordサーバーなど）の宣伝・紹介などの活動が含まれており、「ユーザの創作活動やコミュニティ活動の拡散」という目的にあっているか
* 上記内容（創作活動・チーム活動・コミュニティの紹介など）のないポストはNG
* イラストで、あまりに直接的なR-18はNG(微エロくらいはOK)
* 政治宗教などの活動はNG
-----この下がユーザのポストです-----
ユーザ名: ${userinfo.follower.displayName}
文章: ${userinfo.posts?.[0] || ""}`;

  const contents: PartListUnion = [prompt];
  if (userinfo?.image) {
    for (const img of userinfo.image) {
      const response = await safeFetch(img.image_url);
      const imageArrayBuffer = await response.arrayBuffer();
      const base64ImageData = Buffer.from(imageArrayBuffer).toString("base64");
      contents.push({
        inlineData: {
          mimeType: img.mimeType,
          data: base64ImageData,
        }
      });
    }
  }
  const response = await generateContentForFeature("BSKY_CHEER_SUBJECT", {
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA_CHECKCHEER,
    }
  });
  const result = JSON.parse(response.text || "") as GeminiJudgeResult[];

  // Geminiリクエスト数加算


  return result[0];
}
