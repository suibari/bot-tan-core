import { Type } from "@google/genai";
import { generateContentWithRetry } from "./util.js";
import {
  SYSTEM_INSTRUCTION,
  TONE_RULES_JA,
  type CardDefinition,
} from "@bsky-affirmative-bot/shared-configs";

/** 全肯定カードを引いた瞬間に付ける、botたんの吹き出しコメントの入力。 */
export interface NagiCardCommentInput {
  /** 引いたカードの定義（名前・レアリティ・属性・種族・フレーバー）。 */
  card: CardDefinition;
  /** 引いた人の表示名。 */
  displayName: string;
  /** 同じカードを引き直したか（コメントは上書きされるので、前回とは違うことを言わせる）。 */
  isDuplicate: boolean;
  /**
   * 記念日カードのとき。ガチャで引いたのではなく botたんが贈った1枚なので、
   * 「引き当てたこと」を喜ぶ通常の枠組みがそのまま逆になる。
   */
  anniversary?: {
    /** 年を含まない記念日名（カード名は「ハロウィン2026」だが、話題にするのは記念日そのもの）。 */
    nameJa: string;
    nameEn: string;
    /** 何年ぶんの1枚か。 */
    year: number;
    /** 本人が登録した記念日か。true のとき中身を推測させない。 */
    isUserAnniversary: boolean;
    /** Nagi 登録記念日のみ。今日で何年目か。 */
    yearsSinceJoined?: number;
  };
}

export interface NagiCardCommentResult {
  commentJa: string;
  commentEn: string;
}

/**
 * v2: 「カードに書かれた行いを、引いた人がやったことにして褒めてしまう」問題を修正。
 * カードの内容は引いた人の出来事ではない、と明示していなかったのが原因。
 * v5: 記念日カード（贈り物であってガチャの当たりではない）の枠組みを追加。
 */
export const NAGI_CARD_COMMENT_PROMPT_VERSION = "nagi-card-comment-v5";

const DEEP_COMMENT_RARITIES = new Set(["SR", "UR", "AAR"]);

function commentFormat(card: CardDefinition) {
  return DEEP_COMMENT_RARITIES.has(card.rarity)
    ? {
        ja: "日本語・2〜3文・最大140文字・改行なし",
        en: "英語・2〜3文・最大280文字・改行なし",
      }
    : {
        ja: "日本語・1〜2文・最大80文字・改行なし",
        en: "英語・1〜2文・最大160文字・改行なし",
      };
}

/**
 * カードを引いた人へ向けた botたんのひとことを生成する。
 *
 * カードのフレーバーテキスト（静的・遊戯王風）とは役割が別で、こちらは
 * 「引いたその人へ、その瞬間に向けた言葉」。同じカードでも人によって違う言葉が付くので、
 * カード種は共通でもその1枚は世界に1つになる。
 *
 * 口調は必ず共有ペルソナ SYSTEM_INSTRUCTION に載せる（独自の口調指定を書かない）。
 * ja/en を1リクエストで取るのは generateNagiAnalysis と同じ方針。
 */
export async function generateNagiCardComment(
  input: NagiCardCommentInput,
): Promise<NagiCardCommentResult> {
  const format = commentFormat(input.card);
  const response = await generateContentWithRetry(
    {
      /*
       * NAGI_CARD_COMMENT のルートは lite-standard。ここだけ他の生成と違って FLEX を使わない。
       * ユーザーはドロー演出を見ながらこの1文を待っているので、待ち時間がそのまま体験の質になる。
       * 呼び出しは「1ユーザーにつき1日1回・数十文字」なので、STANDARD にしても
       * 総量はごくわずか（会話や分析のほうが桁違いに重い）。
       * モデル/tier を変えたいときは shared-configs の aiRoutes.ts か AI_ROUTE_NAGI_CARD_COMMENT で。
       */
      feature: "NAGI_CARD_COMMENT",
      contents: [buildNagiCardCommentPrompt(input)],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            commentJa: {
              type: Type.STRING,
              description: `カードを引いた人への、botたんとしてのひとこと（${format.ja}）。**敬語は使わず、botたんの口調（〜だよ/〜だね）で書くこと。**`,
            },
            commentEn: {
              type: Type.STRING,
              description: `commentJa と同じ気持ちを伝える自然な英語（${format.en}）。直訳ではなく英語として自然な言い回しにすること。`,
            },
          },
          required: ["commentJa", "commentEn"],
          propertyOrdering: ["commentJa", "commentEn"],
        },
      },
    },
    3,
  );

  try {
    const json = JSON.parse(response.text || "{}") as NagiCardCommentResult;
    return {
      commentJa: (json.commentJa || "").trim(),
      commentEn: (json.commentEn || "").trim(),
    };
  } catch (e) {
    console.error(
      "[ERROR] Failed to parse Structured Outputs JSON in generateNagiCardComment:",
      e,
    );
    return { commentJa: (response.text || "").trim(), commentEn: "" };
  }
}

/** 「引き当てたこと」に対する喜び方の強さ。行いを褒める話ではないことに注意。 */
const RARITY_HINT: Record<string, string> = {
  N: "よく出るカード。特別扱いせず、軽く声をかけるくらいで。",
  R: "そこそこ出るカード。「お、いいの出たね」くらいのテンションで。",
  SR: "月に数回しか出ないカード。はっきり「やったね」と喜んであげて。",
  UR: "2ヶ月に1回くらいしか出ない当たり。かなりテンションを上げていい。",
  AAR: "1年以上引き続けてやっと出る幻のカード。全力で驚いて、全力で祝ってあげて。",
};

/**
 * 記念日カードのひとこと。通常カードと違い、これは**抽選の当たりではなく botたんからの贈り物**。
 * 「引き当てたことを喜ぶ」という通常の枠組みをそのまま使うと「レアだね！」になってしまい、
 * 記念日を祝う言葉にならないので、レアリティの話題ごと外して today の話に寄せる。
 */
const buildAnniversaryCommentPrompt = (
  input: NagiCardCommentInput & {
    anniversary: NonNullable<NagiCardCommentInput["anniversary"]>;
  },
) => {
  const format = commentFormat(input.card);
  const { anniversary: anniv } = input;

  const originRule = anniv.isUserAnniversary
    ? `* この記念日は **${input.displayName} さんが自分で登録したもの** です。何の日なのかは本人しか
  知りません。名前から中身を推測して決めつけないでください（「${anniv.nameJa}」という名前でも、
  それが何を指すのかを言い当てようとしないこと）。名前をそのまま使って、その日を一緒に祝ってください。`
    : anniv.yearsSinceJoined !== undefined
      ? `* これは ${input.displayName} さんが Nagi に来てくれた日の記念日です。今日でちょうど
  ${anniv.yearsSinceJoined}年になります。来てくれたことへの気持ちを、あなたの言葉で伝えてください。`
      : `* この記念日についてあなたが知っていることは、SYSTEM_INSTRUCTION の人物設定と下のカード情報が
  すべてです。設定にない思い出や出来事を新しく作らないでください。`;

  return `あなたのアプリ「Nagi」では、記念日にログインした人へ、あなた（botたん）から
その記念日のカードを1枚贈っています。
今日は「${anniv.nameJa}」です。いま ${input.displayName} さんにこのカードを贈りました。
それを渡すときのあなたのひとことを考えてください。

# 最重要（ここを間違えないこと）
* **このカードはガチャで出たものではありません。** あなたが今日という日のために贈ったものです。
  「出た」「引けた」「当たった」という言い方はしないでください。
* **レアリティの話をしないでください。** 珍しいから嬉しいのではなく、今日がその日だから贈っています。
  「レアだね」「なかなか出ないよ」の類は禁止です。
* カードに書かれている出来事を、この人が実際にしたわけではありません。その行いを褒めないでください。

# 出力するもの
* commentJa: ${format.ja}。
* commentEn: 同じ気持ちを伝える自然な${format.en}。直訳ではなく英語として自然に。

# ルール
${originRule}
* 記念日そのものに触れてください。「おめでとう」だけで終わらせず、その日が何の日かに
  ひとこと寄り添ってから祝ってください。
* カードのフレーバーテキストをそのまま繰り返さないでください。フレーバーは「カードの説明」、
  あなたのひとことは「贈る相手への言葉」です。役割が違います。
* 名前を呼ぶときは「${input.displayName}」をそのまま使ってください。プレースホルダを出力しないこと。
* 改行を入れないでください。
* commentJa は必ずbotたんの口調にしてください。カードのフレーバーテキストは文語調ですが、
  その文体には引きずられないこと。
${TONE_RULES_JA}

# 贈ったカード（この人の行動記録ではなく、贈り物の情報です）
-----
カード名: ${input.card.nameJa}
記念日: ${anniv.nameJa}（${anniv.year}年ぶん）
属性: ${input.card.attribute}
フレーバーテキスト: ${input.card.textJa}
`;
};

export const buildNagiCardCommentPrompt = (input: NagiCardCommentInput) => {
  if (input.anniversary)
    return buildAnniversaryCommentPrompt({
      ...input,
      anniversary: input.anniversary,
    });
  const format = commentFormat(input.card);
  const deepCommentRule = DEEP_COMMENT_RARITIES.has(input.card.rarity)
    ? `# このレアカードで必ず行う掘り下げ
* レアリティへの驚きだけで終えてはいけません。「すごい」「レアだよ」「おめでとう」だけの
  汎用コメントは禁止です。
* カード固有の要素を1つ以上取り上げ、あなたとの関係、覚えているエピソード、名前や姿の由来、
  またはあなたにとって特別な理由を、引いた人へ自分の言葉で話してください。
* SYSTEM_INSTRUCTION の人物設定とカード情報だけを根拠にしてください。設定にない思い出や
  出来事を新しく作ってはいけません。
* 人物カードでは、単なる第三者紹介ではなく、親友・相棒・過去の自分など、あなた自身との
  関係が伝わる話し方にしてください。
* たとえばラテちゃんのカードなら、親友であることや猫に変身しすぎた話など、その絵柄に合う
  具体的な話をします。「全否定bot」なら別人として紹介せず、支えられて立ち直ったあなた自身の
  過去として、そのカードが特別な理由を話します。同じ定型文をそのまま使わないでください。
`
    : "";

  return `あなたのアプリ「Nagi」には、1日1回カードを引ける「全肯定カード」があります。
いま ${input.displayName} さんがカードを1枚引いて、下のカードが出ました。
それを見たあなた（botたん）のひとことを考えてください。

# 最重要（ここを間違えないこと）
* **カードに書かれている出来事を、この人が実際にしたわけではありません。** カードはガチャで
  出てきただけです。たとえば「洗濯物を干した者」というカードが出ても、この人が洗濯をしたとは
  限りません。**その行いを褒めてはいけません。**
* ほめる・喜ぶ対象は「そのカードを引き当てたこと」です。話題は「何が出たか」と「引けたこと」。
* カードに出てくるキャラクターやモチーフに反応するのは歓迎です
  （例:「この子が出たんだ！」「その属性いいなあ」）。

# 出力するもの
* commentJa: ${format.ja}。
* commentEn: 同じ気持ちを伝える自然な${format.en}。直訳ではなく英語として自然に。

# ルール
* カードのフレーバーテキストをそのまま繰り返さないでください。フレーバーは「カードの説明」、
  あなたのひとことは「引いた人への言葉」です。役割が違います。
* 引いた人に語りかけてください。カード情報の読み上げやステータス解説だけにはしないこと。
* レアリティに応じて喜び方の強さを変えてください。${RARITY_HINT[input.card.rarity] ?? ""}
* 名前を呼ぶときは「${input.displayName}」をそのまま使ってください。プレースホルダを出力しないこと。
* 改行を入れないでください。
* commentJa は必ずbotたんの口調にしてください。カードのフレーバーテキストは文語調ですが、
  その文体には引きずられないこと。
${TONE_RULES_JA}
${deepCommentRule}
${
  input.isDuplicate
    ? "* この人がこのカードを引くのは2回目以降です。「また来たね」という文脈を入れてください。"
    : "* この人がこのカードを引くのは初めてです。"
}

# 出たカード（この人の行動記録ではなく、引いた札の情報です）
-----
カード名: ${input.card.nameJa}
レアリティ: ${input.card.rarity}
属性: ${input.card.attribute}
種族: ${input.card.raceJa}
ATK/DEF: ${input.card.atk}/${input.card.def}
フレーバーテキスト: ${input.card.textJa}
`;
};
