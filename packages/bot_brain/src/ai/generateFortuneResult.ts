import { Type } from "@google/genai";
import { gemini } from "./index.js";
import { generateContentWithRetry } from "./util.js";
import { getRandomItems, UserInfoGemini, SYSTEM_INSTRUCTION, safeFetch } from "@bsky-affirmative-bot/shared-configs";

export interface FortuneResult {
  fortune: string;
  emojis: string;
}

export async function generateFortuneResult(userinfo: UserInfoGemini): Promise<FortuneResult> {
  const maxLength = userinfo.langStr === "日本語" ?
    "出力する占い本文の文字数は最大500文字までです。" :
    "The maximum character count for the fortune text body is 1000 characters."

  const place_language = userinfo.langStr === "日本語" ? "日本" : "世界";
  const part_language = `**${userinfo.langStr}で出力してください**。`;
  const category_main = ["日常", "冒険", "リラックス", "自己成長", "絆", "笑い", "チャレンジ", "創造性", "感謝", "スピード", "バランス", "決断", "整理整頓", "推し活", "恋愛"];
  const category_spot = ["観光地", "公共施設", "商業施設", "自然", "歴史的建造物", "テーマパーク", "文化施設", "アウトドアスポット", "イベント会場", "温泉地", "グルメスポット", "スポーツ施設", "特殊施設"];
  const category_food = ["和食", "洋食", "中華料理", "エスニック料理", "カレー", "焼肉", "鍋", "ラーメン", "スイーツ"];
  const category_game = ["アクション", "アドベンチャー", "RPG", "シミュレーション", "ストラテジー", "パズル", "FPS", "ホラー", "シューティング", "レース"];
  const category_anime = ["バトル", "恋愛", "ファンタジー", "日常系", "スポーツ", "SF", "ホラー", "コメディ", "ロボット", "歴史"];
  const category_movie = ["アクション", "コメディ", "ドラマ", "ファンタジー", "ホラー", "ミュージカル", "サスペンス", "アニメ", "ドキュメンタリー", "恋愛"];
  const category_music = ["ポップ", "ロック", "ジャズ", "クラシック", "EDM", "ヒップホップ", "R&B", "レゲエ", "カントリー", "インストゥルメンタル"];
  const category_animal = ["肉食", "草食", "夜行性", "昼行性", "飛行", "水生", "爬虫類", "哺乳類", "昆虫", "群れで行動", "単独行動"];
  const category_action_place = ["公共交通機関", "コンビニ", "公園", "カフェ", "スーパーマーケット", "いつもと違う道", "会社や学校", "ショッピングモール"];
  const category_action_attr = ["赤色", "青色", "緑色", "白色", "黒色", "暖かみのある", "恋愛にまつわるもの", "歴史にまつわるもの", "ホラーにまつわるもの", "混んでいる", "空いている", "かわいい", "全肯定botたんっぽい"];
  const category_action_act = ["食べる", "写真を撮る", "音を聞く", "手に取る", "歩く", "匂いをかぐ", "座る", "空を見上げる", "絵を描く", "メモやブログを書く", "Blueskyにポストする", "勉強する"];
  const category_action_subject = ["経験したことないもの", "期間や季節の限定品", "動いているもの", "最初に目に入ったもの", "ちょっと苦手なもの", "昨日見た夢", "最近の目標", "最近の推し"];
  const part_prompt_luckys = [
    `* ラッキースポットは、${place_language}にある、${getRandomItems(category_spot, 2)}の中で、具体的な名称をランダムに選ぶこと。そのスポットを選んだ理由も合わせて説明してください。`,
    `* ラッキーフードは、${getRandomItems(category_food, 2)}をあわせもつ料理の具体的な名称をランダムに選ぶこと。その料理を選んだ理由も合わせて説明してください。`,
    `* ラッキーゲームは、${getRandomItems(category_game, 2)}をあわせもつ${place_language}のゲームの具体的な名称をランダムに選ぶこと。そのゲームを選んだ理由も合わせて説明してください。`,
    `* ラッキーアニメは、${getRandomItems(category_anime, 2)}の要素をあわせもつアニメの具体的な名称をランダムに選ぶこと。そのアニメを選んだ理由も合わせて説明してください。`,
    `* ラッキームービーは、${getRandomItems(category_movie, 2)}の要素をあわせもつ映画の具体的な名称をランダムに選ぶこと。その映画を選んだ理由も合わせて説明してください。`,
    `* ラッキーミュージックは、${getRandomItems(category_music, 2)}の要素をあわせもつ${place_language}の楽曲の具体的な名称（およびアーティスト）をランダムに選ぶこと。その楽曲を選んだ理由も合わせて説明してください。`,
    `* ラッキーアニマルは、${getRandomItems(category_animal, 2)}の要素をあわせもつ動物の具体的な名称をランダムに選ぶこと。その動物を選んだ理由も合わせて説明してください。`,
  ];

  const prompt =
`占いをしてください。
${part_language}
占い結果を以下の条件に基づいて生成してください。
${maxLength}
空の行は入れないでください。
占い結果に、「最高」などの最上級表現を使わないこと。
* 占いテーマは${getRandomItems(category_main, 2)}です。2つのテーマを合わせたアドバイスをしてください。
* ラッキーアクションは、${getRandomItems(category_action_attr, 1)}の${getRandomItems(category_action_place, 1)}の場所で、${getRandomItems(category_action_subject, 1)}を${getRandomItems(category_action_act, 1)}する指示を出してください。自然な文章にしてください。
${getRandomItems(part_prompt_luckys, 3)}
悪い内容が一切含まれないようにしてください。

また、この占い結果を総括（サマリー）する絵文字を【必ずちょうど3つ】考えてください。

以下がユーザ名です。
-----
ユーザ名: ${userinfo.follower.displayName}`;

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
    feature: "BSKY_FORTUNE",
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          fortune: {
            type: Type.STRING,
            description: "占いのアドバイス本文（空の行は含めないこと）"
          },
          emojis: {
            type: Type.STRING,
            description: "絵文字3つのみ（スペースや区切り文字等は含めず、例: 🔮✨🍀）"
          }
        },
        required: ["fortune", "emojis"]
      }
    }
  }, 3, userinfo);

  try {
    const responseText = response.text || "{}";
    const cleanedText = responseText.replace(/\[.*?\]/gs, '');
    const json = JSON.parse(cleanedText) as FortuneResult;
    return {
      fortune: json.fortune || "",
      emojis: json.emojis || "🔮✨🍀"
    };
  } catch (e) {
    console.error("[ERROR] Failed to parse Structured Outputs JSON in generateFortuneResult:", e);
    return {
      fortune: response.text || "",
      emojis: "🔮✨🍀"
    };
  }
}
