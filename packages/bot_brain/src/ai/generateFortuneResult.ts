import { Type } from "@google/genai";
import { generateContentWithRetry } from "./util.js";
import { getRandomItems, UserInfoGemini, SYSTEM_INSTRUCTION, safeFetch } from "@bsky-affirmative-bot/shared-configs";

export interface FortuneResult {
  /** 画像へ描く占い本文。セクションごとに改行済み。 */
  fortune: string;
  emojis: string;
  /** 背景画像の題材（日本語の短い情景文）。取れなかったときは空文字。 */
  picture: string;
}

type LuckyCategory = {
  labelJa: string;
  labelEn: string;
  instruction: (place: string) => string;
};

const category_food = ["和食", "洋食", "中華料理", "エスニック料理", "カレー", "焼肉", "鍋", "ラーメン", "スイーツ"];
const category_spot = ["観光地", "公共施設", "商業施設", "自然", "歴史的建造物", "テーマパーク", "文化施設", "アウトドアスポット", "イベント会場", "温泉地", "グルメスポット", "スポーツ施設", "特殊施設"];
const category_game = ["アクション", "アドベンチャー", "RPG", "シミュレーション", "ストラテジー", "パズル", "FPS", "ホラー", "シューティング", "レース"];
const category_anime = ["バトル", "恋愛", "ファンタジー", "日常系", "スポーツ", "SF", "ホラー", "コメディ", "ロボット", "歴史"];
const category_movie = ["アクション", "コメディ", "ドラマ", "ファンタジー", "ホラー", "ミュージカル", "サスペンス", "アニメ", "ドキュメンタリー", "恋愛"];
const category_music = ["ポップ", "ロック", "ジャズ", "クラシック", "EDM", "ヒップホップ", "R&B", "レゲエ", "カントリー", "インストゥルメンタル"];
const category_animal = ["肉食", "草食", "夜行性", "昼行性", "飛行", "水生", "爬虫類", "哺乳類", "昆虫", "群れで行動", "単独行動"];

const LUCKY_CATEGORIES: LuckyCategory[] = [
  { labelJa: "ラッキースポット", labelEn: "Lucky Spot", instruction: (place) => `${place}にある、${getRandomItems(category_spot, 2)}の中から具体的な名称をランダムに選ぶ` },
  { labelJa: "ラッキーフード", labelEn: "Lucky Food", instruction: () => `${getRandomItems(category_food, 2)}をあわせもつ料理の具体的な名称をランダムに選ぶ` },
  { labelJa: "ラッキーゲーム", labelEn: "Lucky Game", instruction: (place) => `${getRandomItems(category_game, 2)}をあわせもつ${place}のゲームの具体的な名称をランダムに選ぶ` },
  { labelJa: "ラッキーアニメ", labelEn: "Lucky Anime", instruction: () => `${getRandomItems(category_anime, 2)}の要素をあわせもつアニメの具体的な名称をランダムに選ぶ` },
  { labelJa: "ラッキームービー", labelEn: "Lucky Movie", instruction: () => `${getRandomItems(category_movie, 2)}の要素をあわせもつ映画の具体的な名称をランダムに選ぶ` },
  { labelJa: "ラッキーミュージック", labelEn: "Lucky Music", instruction: (place) => `${getRandomItems(category_music, 2)}の要素をあわせもつ${place}の楽曲の具体的な名称（およびアーティスト）をランダムに選ぶ` },
  { labelJa: "ラッキーアニマル", labelEn: "Lucky Animal", instruction: () => `${getRandomItems(category_animal, 2)}の要素をあわせもつ動物の具体的な名称をランダムに選ぶ` },
];

const LUCKY_KEYS = ["lucky_1", "lucky_2", "lucky_3"] as const;

export type FortuneSections = {
  advice: string;
  action: string;
  luckies: Array<{ label: string; name: string; reason: string }>;
};

/** モデルが本文に混ぜた改行・空行を1行へ畳む。レイアウトの改行はこちらで決める。 */
function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s*\n+\s*/g, " ").trim() : "";
}

/**
 * 占い結果を画像へ描く本文にする。
 *
 * 以前は本文を1本の文字列でモデルに書かせていたので、ラッキー項目が段落に埋もれたり
 * 1行に詰められたりと、日によって見た目が揃わなかった。項目ごとに受け取り、
 * 見出し・改行はコードで固定する。
 */
export function formatFortuneText(sections: FortuneSections, langStr: string): string {
  const ja = langStr === "日本語";
  const heading = (label: string) => (ja ? `【${label}】` : `[${label}]`);
  const blocks: string[] = [];

  if (sections.advice) blocks.push(`${heading(ja ? "今日の運勢" : "Today's Fortune")}\n${sections.advice}`);
  if (sections.action) blocks.push(`${heading(ja ? "ラッキーアクション" : "Lucky Action")}\n${sections.action}`);
  for (const lucky of sections.luckies) {
    if (!lucky.name) continue;
    blocks.push(`${heading(lucky.label)} ${lucky.name}${lucky.reason ? `\n${lucky.reason}` : ""}`);
  }

  return blocks.join("\n\n");
}

export async function generateFortuneResult(userinfo: UserInfoGemini): Promise<FortuneResult> {
  const ja = userinfo.langStr === "日本語";
  const maxLength = ja ?
    "文字数の目安: advice は150文字以内、lucky_action は80文字以内、各ラッキー項目の reason は60文字以内。" :
    "Length guide: advice up to 300 characters, lucky_action up to 160 characters, each lucky reason up to 120 characters.";

  const place_language = ja ? "日本" : "世界";
  const part_language = `**${userinfo.langStr}で出力してください**（picture だけは日本語）。`;
  const category_main = ["日常", "冒険", "リラックス", "自己成長", "絆", "笑い", "チャレンジ", "創造性", "感謝", "スピード", "バランス", "決断", "整理整頓", "推し活", "恋愛"];
  const category_action_place = ["公共交通機関", "コンビニ", "公園", "カフェ", "スーパーマーケット", "いつもと違う道", "会社や学校", "ショッピングモール"];
  const category_action_attr = ["赤色", "青色", "緑色", "白色", "黒色", "暖かみのある", "恋愛にまつわるもの", "歴史にまつわるもの", "ホラーにまつわるもの", "混んでいる", "空いている", "かわいい", "全肯定botたんっぽい"];
  const category_action_act = ["食べる", "写真を撮る", "音を聞く", "手に取る", "歩く", "匂いをかぐ", "座る", "空を見上げる", "絵を描く", "メモやブログを書く", "Blueskyにポストする", "勉強する"];
  const category_action_subject = ["経験したことないもの", "期間や季節の限定品", "動いているもの", "最初に目に入ったもの", "ちょっと苦手なもの", "昨日見た夢", "最近の目標", "最近の推し"];

  // 3カテゴリはコードで選ぶ。見出しをモデルに書かせると表記が揺れる。
  const luckies = [...LUCKY_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, LUCKY_KEYS.length);
  const part_luckies = luckies
    .map((lucky, index) =>
      `* ${LUCKY_KEYS[index]} は「${lucky.labelJa}」。${lucky.instruction(place_language)}こと。name に名称、reason に選んだ理由を書く。`,
    )
    .join("\n");

  const prompt =
`占いをしてください。
${part_language}
占い結果を以下の条件に基づいて、項目ごとに生成してください。
${maxLength}
どの項目にも改行や空行は入れないでください。
占い結果に、「最高」などの最上級表現を使わないこと。
* advice: 占いテーマは${getRandomItems(category_main, 2)}です。2つのテーマを合わせたアドバイスをしてください。
* lucky_action: ${getRandomItems(category_action_attr, 1)}の${getRandomItems(category_action_place, 1)}の場所で、${getRandomItems(category_action_subject, 1)}を${getRandomItems(category_action_act, 1)}する指示を出してください。自然な文章にしてください。
${part_luckies}
悪い内容が一切含まれないようにしてください。

emojis: この占い結果を総括（サマリー）する絵文字を【必ずちょうど3つ】考えてください。

picture: この占い結果をモチーフにした1枚の絵の情景を、日本語で80文字以内で書いてください。
全肯定botたんが、ラッキーアクションやラッキー項目（場所・食べ物・動物など、目に見えるもの）を楽しんでいる場面にしてください。
主語は必ず「botたん」と三人称で書き、「わたし」などの一人称は使わないでください（絵の生成で別作品のキャラ名と取り違えられるため）。
ゲーム・アニメ・映画・楽曲の作品名、キャラクター名、実在の人物名は書かないでください（雰囲気や小物に置き換える）。

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

  const luckySchema = {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: "名称" },
      reason: { type: Type.STRING, description: "選んだ理由（改行なし）" },
    },
    required: ["name", "reason"],
  };

  const response = await generateContentWithRetry({
    feature: "BSKY_FORTUNE",
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          advice: { type: Type.STRING, description: "2つのテーマを合わせたアドバイス（改行なし）" },
          lucky_action: { type: Type.STRING, description: "ラッキーアクション（改行なし）" },
          lucky_1: luckySchema,
          lucky_2: luckySchema,
          lucky_3: luckySchema,
          emojis: {
            type: Type.STRING,
            description: "絵文字3つのみ（スペースや区切り文字等は含めず、例: 🔮✨🍀）"
          },
          picture: { type: Type.STRING, description: "占い結果をモチーフにした絵の情景（日本語、80文字以内）" },
        },
        required: ["advice", "lucky_action", ...LUCKY_KEYS, "emojis", "picture"]
      }
    }
  }, 3, userinfo);

  try {
    const responseText = response.text || "{}";
    const json = JSON.parse(responseText.replace(/\[.*?\]/gs, ''));
    const fortune = formatFortuneText({
      advice: oneLine(json.advice),
      action: oneLine(json.lucky_action),
      luckies: luckies.map((lucky, index) => ({
        label: ja ? lucky.labelJa : lucky.labelEn,
        name: oneLine(json[LUCKY_KEYS[index]]?.name),
        reason: oneLine(json[LUCKY_KEYS[index]]?.reason),
      })),
    }, userinfo.langStr ?? "");
    return {
      fortune,
      emojis: oneLine(json.emojis) || "🔮✨🍀",
      picture: oneLine(json.picture),
    };
  } catch (e) {
    console.error("[ERROR] Failed to parse Structured Outputs JSON in generateFortuneResult:", e);
    return {
      fortune: response.text || "",
      emojis: "🔮✨🍀",
      picture: "",
    };
  }
}
