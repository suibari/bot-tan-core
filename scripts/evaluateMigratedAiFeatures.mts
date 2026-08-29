/**
 * Gemma 4移行後の全AI論理機能を、投稿・DB保存なしで1件ずつ実行する目視確認用ハーネス。
 *
 *   pnpm ai-migration:evaluate             # ケース一覧だけ（外部通信なし）
 *   pnpm ai-migration:evaluate -- --run     # Ollama + 必要箇所だけGemini Grounding
 *
 * 出力:
 *   docs/evaluations/ai-migration/latest.json
 *   docs/evaluations/ai-migration/review.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AI_FEATURE_KEYS,
  BOT_SCENE_BRIEF_JA,
  SYSTEM_INSTRUCTION,
  aiModel,
  resolveAiRoute,
  type AiFeatureKey,
} from "../packages/shared-configs/src/index.js";
import { generateContentForFeature } from "../packages/bot_brain/src/gemini/routedGeneration.js";
// OLLAMA_* の4機能は generateContentForFeature を通らない。本番と同じクライアントを
// 呼ばないと、動かないコードを PASS と report してしまう（実際に一度そうなった）。
import { classifyPredefinedAffirmationStrict } from "../packages/bot_brain/src/predefinedAffirmation.js";
import { judgeNameIntent } from "../packages/bot_brain/src/gemini/judgeNameIntent.js";
import { generateAnalyzeResult } from "../packages/bot_brain/src/gemini/generateAnalyzeResult.js";
import { PositiveNewsService } from "../packages/bot_brain/src/api/newsdata/index.js";
import {
  botTranslationPrompt,
  requestTranslationWithRetry,
  translationPrompt,
} from "../apps/nagi_appview/src/services/translation.js";

// 翻訳は本番のプロンプトビルダーごと通す。ここで prompt を手書きすると、
// 「本番と違う入力で PASS した」という同じ失敗を繰り返す。
const JAPANESE = { code: "ja", name: "Japanese" } as any;
const ENGLISH = { code: "en", name: "English" } as any;

const MODEL = "hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S";
const run = process.argv.includes("--run");
const outputDir = path.resolve("docs/evaluations/ai-migration");

type Case = {
  id: string;
  title: string;
  covers: AiFeatureKey[];
  feature: AiFeatureKey;
  prompt: string;
  persona?: boolean;
  schema?: Record<string, unknown>;
  tools?: any[];
  functionDeclaration?: { name: string; parameters: Record<string, unknown> };
  system?: string;
  maxTokens?: number;
  /**
   * 本番が generateContentForFeature を通らない機能は、ここに実際の呼び出しを書く。
   * 戻り値はレビューに載せる生テキスト。
   */
  production?: () => Promise<string>;
};

/**
 * ニュース事前スクリーニングは PositiveNewsService の中でしか呼べない。NewsData への
 * 実リクエストだけ差し替え、Ollama へは本番と同じ body が飛ぶようにする。
 */
async function runNewsPrescreen(): Promise<string> {
  const article = {
    article_id: "eval-1",
    title: "地域の子ども食堂が開設5周年、利用者が感謝",
    description: "地域の子ども食堂が5周年を迎え、利用者から感謝の声が寄せられている。",
    source_name: "テストニュース",
    category: ["top"],
  };
  const service = new PositiveNewsService({
    fetchImpl: (async (input: any, init: any) => {
      if (String(input).startsWith("https://newsdata.io")) {
        return new Response(
          JSON.stringify({ status: "success", totalResults: 1, results: [article] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return fetch(input, init);
    }) as typeof fetch,
    getNewsDataApiKey: () => "evaluation-stub-key",
    logger: { log() {}, warn() {} },
  });
  const result = await service.getCandidates();
  const kept = result.candidates.length > 0;
  return JSON.stringify(
    { keep: kept, articleId: result.candidates[0]?.articleId ?? null },
    null,
    2,
  );
}

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "OBJECT",
  properties,
  required,
});
const string = { type: "STRING" };
const number = { type: "NUMBER" };
const boolean = { type: "BOOLEAN" };

const personaPrompt = (task: string) =>
  `${task}\n日本語で、botたん自身のくだけた口調で出力してください。敬語や説明の前置きは使わないでください。`;

const cases: Case[] = [
  {
    id: "user-diary",
    title: "ユーザー日記本文・再試行ラダー",
    covers: ["COMMON_USER_DIARY", "COMMON_DIARY_ATTEMPT_EARLY", "COMMON_DIARY_ATTEMPT_MID", "COMMON_DIARY_ATTEMPT_LATE"],
    feature: "COMMON_USER_DIARY",
    persona: true,
    prompt: personaPrompt("今日の投稿『朝の散歩で金木犀の香りに気づいた』を根拠に、本人の日記を2段落で書いて。"),
    schema: objectSchema({ title_ja: string, title_en: string, diary: string }, ["title_ja", "title_en", "diary"]),
  },
  {
    id: "affirmative-reply",
    title: "通常全肯定リプライ（検索不要判定を含む）",
    covers: ["BSKY_AFFIRMATIVE_REPLY", "NAGI_REPLY_ATTEMPT_EARLY", "NAGI_REPLY_ATTEMPT_MID", "NAGI_REPLY_ATTEMPT_LATE"],
    feature: "BSKY_AFFIRMATIVE_REPLY",
    persona: true,
    prompt: personaPrompt("ユーザーの『今日は苦手な作業を最後まで終えた』を具体的に全肯定し、commentとscoreをJSONで返して。"),
    schema: objectSchema({ comment: string, score: number }, ["comment", "score"]),
    tools: [{ googleSearch: {} }],
  },
  {
    id: "conversation-grounded",
    title: "会話・検索要否判定・Grounding・最終ローカル生成",
    covers: ["BSKY_CONVERSATION"],
    feature: "BSKY_CONVERSATION",
    persona: true,
    prompt: personaPrompt("2026年8月時点の横浜の最近の暑さについて、確認できる事実を1つだけ添えて労って。"),
    tools: [{ googleSearch: {} }],
  },
  {
    id: "bsky-analysis",
    title: "botたん分析",
    covers: ["BSKY_ANALYZE"],
    feature: "BSKY_ANALYZE",
    prompt: "本番の generateAnalyzeResult を実行（PROMPT_ANALYZE と称号ルールをそのまま通す）。",
    production: async () =>
      JSON.stringify(
        await generateAnalyzeResult({
          follower: { displayName: "すいばり" },
          posts: "毎日10分だけ絵を描き続けている / 今日は色塗りが楽しかった / 散歩の途中で空を撮った",
          likedByFollower: "水彩画の技法まとめ / 朝の散歩が続くコツ",
          langStr: "日本語",
        } as any),
        null,
        2,
      ),
  },
  {
    id: "fortune",
    title: "占い",
    covers: ["BSKY_FORTUNE"],
    feature: "BSKY_FORTUNE",
    persona: true,
    prompt: personaPrompt("今日の運勢を、fortune、item、commentのJSONで短く占って。"),
    schema: objectSchema({ fortune: string, item: string, comment: string }, ["fortune", "item", "comment"]),
  },
  {
    id: "bot-diary",
    title: "botたん自身の日記（Groundingなし）",
    covers: ["BSKY_BOT_DIARY"],
    feature: "BSKY_BOT_DIARY",
    persona: true,
    prompt: personaPrompt("朝に紅茶を飲み、午後に友達の作品を応援した日の短い日記を書いて。"),
    schema: objectSchema({ title: string, emoji: string, content: string }, ["title", "emoji", "content"]),
    tools: [{ googleSearch: {} }],
    maxTokens: 700,
  },
  {
    id: "questions-answer",
    title: "質問への回答",
    covers: ["BSKY_QUESTIONS_ANSWER"],
    feature: "BSKY_QUESTIONS_ANSWER",
    persona: true,
    prompt: personaPrompt("『落ち込んだ日に気持ちを切り替えるコツは？』へ3文で答えて。"),
  },
  {
    id: "recommended-song",
    title: "おすすめソング",
    covers: ["BSKY_RECOMMENDED_SONG"],
    feature: "BSKY_RECOMMENDED_SONG",
    persona: true,
    prompt: personaPrompt("元気を出したい朝に合う実在曲を1曲選び、title、artist、commentのJSONで返して。"),
    schema: objectSchema({ title: string, artist: string, comment: string }, ["title", "artist", "comment"]),
  },
  {
    id: "whimsical-reply",
    title: "気まぐれ投稿へのリプライ",
    covers: ["BSKY_WHIMSICAL_REPLY"],
    feature: "BSKY_WHIMSICAL_REPLY",
    persona: true,
    prompt: personaPrompt("『窓辺で猫が丸くなってる』へ自然な短い返事をして。"),
    tools: [{ googleSearch: {} }],
  },
  {
    id: "cheer-subject",
    title: "応援対象判定",
    covers: ["BSKY_CHEER_SUBJECT"],
    feature: "BSKY_CHEER_SUBJECT",
    prompt: "投稿『自主制作ゲームの体験版を公開しました』は創作活動として拡散してよいか判定して。",
    schema: { type: "ARRAY", items: objectSchema({ result: boolean, comment: string }, ["result", "comment"]) },
  },
  {
    id: "cheer-result",
    title: "応援メッセージ",
    covers: ["BSKY_CHEER_RESULT"],
    feature: "BSKY_CHEER_RESULT",
    persona: true,
    prompt: personaPrompt("初めて自主制作ゲームを公開した人へ、具体的な応援を2文で。"),
  },
  {
    id: "omikuji",
    title: "おみくじ",
    covers: ["BSKY_OMIKUJI"],
    feature: "BSKY_OMIKUJI",
    persona: true,
    prompt: personaPrompt("今日のおみくじを短く作って。"),
  },
  {
    id: "anniversary",
    title: "記念日コメント",
    covers: ["BSKY_ANNIVERSARY"],
    feature: "BSKY_ANNIVERSARY",
    persona: true,
    prompt: personaPrompt("Nagiを使い始めて1周年の人を、推測を足さずに祝って。"),
  },
  {
    id: "recap",
    title: "一年のまとめ",
    covers: ["BSKY_RECAP"],
    feature: "BSKY_RECAP",
    persona: true,
    prompt: personaPrompt("今年は散歩を習慣にし、イラストを12枚完成させた人の一年を3文で称えて。"),
  },
  {
    id: "room-welcome",
    title: "お部屋招待のお出迎え",
    covers: ["BSKY_ROOM_WELCOME"],
    feature: "BSKY_ROOM_WELCOME",
    persona: true,
    prompt: personaPrompt("botたんのお部屋へ来た人を、1文であたたかく迎えて。"),
  },
  {
    id: "mood-song-grounded",
    title: "気分ソング（実在確認Grounding）",
    covers: ["BSKY_MY_MOOD_SONG"],
    feature: "BSKY_MY_MOOD_SONG",
    persona: true,
    prompt: personaPrompt("静かに前向きになりたい夜に合う実在曲を調べ、title、artist、commentのJSONで返して。"),
    schema: objectSchema({ title: string, artist: string, comment: string }, ["title", "artist", "comment"]),
    tools: [{ googleSearch: {} }],
  },
  {
    id: "seasonal-works-grounded",
    title: "今期作品（必須Grounding）",
    covers: ["BIORHYTHM_SEASONAL_WORKS"],
    feature: "BIORHYTHM_SEASONAL_WORKS",
    prompt: "2026年夏に日本で実際に話題になっているアニメを調査し、titleとkindを持つ配列で3件返して。",
    schema: { type: "ARRAY", items: objectSchema({ title: string, kind: string }, ["title", "kind"]) },
    tools: [{ googleSearch: {} }],
  },
  {
    id: "memory-impressions",
    title: "公開会話から作品名・印象語抽出",
    covers: ["BIORHYTHM_MEMORY_IMPRESSIONS"],
    feature: "BIORHYTHM_MEMORY_IMPRESSIONS",
    prompt: "会話『星巡りの歌を聴いた。静かで透明感があった』から作品名と印象語をJSONで抽出して。",
    schema: objectSchema({ title: string, impressions: { type: "ARRAY", items: string } }, ["title", "impressions"]),
  },
  {
    id: "pronunciations",
    title: "TTS読み仮名",
    covers: ["BIORHYTHM_TTS_PRONUNCIATIONS"],
    feature: "BIORHYTHM_TTS_PRONUNCIATIONS",
    prompt: "『葬送のフリーレン』の自然な日本語読みをJSONで返して。",
    schema: objectSchema({ text: string, reading: string }, ["text", "reading"]),
  },
  {
    id: "daily-plan",
    title: "日次予定表",
    covers: ["BIORHYTHM_DAILY_PLAN"],
    feature: "BIORHYTHM_DAILY_PLAN",
    prompt: "2026-08-29のbotたんの予定を朝・昼・夜の3件、time、activityJa、activityEnの配列で作って。",
    schema: { type: "ARRAY", items: objectSchema({ time: string, activityJa: string, activityEn: string }, ["time", "activityJa", "activityEn"]) },
  },
  {
    id: "status",
    title: "現在状況",
    covers: ["BIORHYTHM_STATUS"],
    feature: "BIORHYTHM_STATUS",
    // 本番(manager.buildPrompt)は三人称の描写文を作らせる。SYSTEM_INSTRUCTION 全文ではなく
    // BOT_SCENE_BRIEF_JA を使い、フィールドも status_text / status_text_en / duration_minutes。
    // personaPrompt でbotたん自身のくだけた口調を要求すると本番と別物になる
    // （体力気力は行動を決めるための状態入力であって、読み上げさせる値ではない）。
    system: BOT_SCENE_BRIEF_JA,
    prompt: `以下のキャラクター（System Instruction に設定されている「全肯定botたん」）の行動を描写してほしいです。
このキャラクターが現在どんな気分でなにをしているか、現在時刻・天候・ステータス・行動欲求・前回した行動をもとにして、具体的に考えてください。
* ルール
- 結果はJSON形式で出力してください。
- "status_text": 「全肯定たんは～しています」という、AIに入力する平易なプロンプト文（200文字以内）。服装は前回から変わっていないため、服装の描写は不要です。
- "status_text_en": status_text の英語訳（plain English, max 200 characters）。「全肯定たん」は必ず "Bot-tan" と訳してください。ことみちゃん・ラテちゃん・モルフォなど他の登場人物の名前を、本人の呼び名として使ってはいけません。
- "duration_minutes": その行動にかかる時間（分）。5分から90分の範囲で決めてください。

-----以下がキャラクターの状態-----
・現在
現在時刻：2026年8月29日(土) 15:00
天候：晴れ
ステータス：FreeTime
体力気力（0～100）：12
行動欲求：{"WakeUp":0,"Study":10,"FreeTime":80,"Relax":40,"Sleep":30}
・前回
前回時刻：14:00
ステータス：FreeTime
体力気力（0～100）：0.2
前回した行動：全肯定たんは友達とカフェでおしゃべりしています。
`,
    schema: objectSchema(
      { status_text: string, status_text_en: string, duration_minutes: { type: "INTEGER" } },
      ["status_text", "status_text_en", "duration_minutes"],
    ),
  },
  {
    id: "good-night",
    title: "おやすみポスト",
    covers: ["BIORHYTHM_GOOD_NIGHT"],
    feature: "BIORHYTHM_GOOD_NIGHT",
    persona: true,
    prompt: personaPrompt("散歩と読書を楽しんだ日の、おやすみ投稿を日英で作って。"),
    schema: objectSchema({ textJa: string, textEn: string }, ["textJa", "textEn"]),
  },
  {
    id: "question",
    title: "質問生成",
    covers: ["BIORHYTHM_QUESTION"],
    feature: "BIORHYTHM_QUESTION",
    persona: true,
    prompt: personaPrompt("みんなが答えやすい『小さな楽しみ』についての質問を日英で1つ作って。"),
    schema: objectSchema({ textJa: string, textEn: string }, ["textJa", "textEn"]),
  },
  {
    id: "whimsical-plan",
    title: "気まぐれ投稿・企画（function互換）",
    covers: ["BIORHYTHM_WHIMSICAL_POST_PLAN"],
    feature: "BIORHYTHM_WHIMSICAL_POST_PLAN",
    // positiveNewsArticleId は「候補のarticleIdそのまま、なければ厳密に None」が本番の規則。
    // その一文を欠くとモデルが散文を入れてしまい、フィールドの妥当性を判定できない。
    prompt:
      "朝の紅茶と窓辺の光を素材に、SNS投稿の構造を作って。"
      + "ポジティブニュース候補は与えていないので、positiveNews と positiveNewsArticleId は厳密に \"None\" にすること。"
      + "selectedMemoryDocumentIds も候補がないので空配列にすること。",
    functionDeclaration: {
      name: "composePostStructure",
      parameters: objectSchema({ greeting: string, currentMood: string, whatDay: string, positiveNews: string, positiveNewsArticleId: string, botFunction: string, selectedMemoryDocumentIds: { type: "ARRAY", items: { type: "INTEGER" } } }, ["greeting", "currentMood", "whatDay", "positiveNews", "positiveNewsArticleId", "botFunction", "selectedMemoryDocumentIds"]),
    },
  },
  {
    id: "whimsical-write",
    title: "気まぐれ投稿・執筆",
    covers: ["BIORHYTHM_WHIMSICAL_POST_WRITE"],
    feature: "BIORHYTHM_WHIMSICAL_POST_WRITE",
    persona: true,
    prompt: personaPrompt("構造『朝の紅茶、窓辺のやわらかな光』から自然なSNS投稿を日英で書いて。"),
    schema: objectSchema({ textJa: string, textEn: string }, ["textJa", "textEn"]),
  },
  {
    id: "nagi-analysis",
    title: "Nagiアクター分析",
    covers: ["NAGI_ANALYSIS"],
    feature: "NAGI_ANALYSIS",
    prompt: "投稿傾向『散歩、写真、読書。穏やかな日常を短く記録』から、analysisJa、analysisEn、tagsのJSONを返して。",
    schema: objectSchema({ analysisJa: string, analysisEn: string, tags: { type: "ARRAY", items: string } }, ["analysisJa", "analysisEn", "tags"]),
  },
  {
    id: "card-comment",
    title: "Nagiカードコメント",
    covers: ["NAGI_CARD_COMMENT"],
    feature: "NAGI_CARD_COMMENT",
    persona: true,
    prompt: personaPrompt("カード『雨上がりの散歩道』を引いた人へ、commentJaとcommentEnをJSONで返して。"),
    schema: objectSchema({ commentJa: string, commentEn: string }, ["commentJa", "commentEn"]),
  },
  {
    id: "community-affirmation",
    title: "コミュニティ全肯定",
    covers: ["NAGI_COMMUNITY_AFFIRMATION"],
    feature: "NAGI_COMMUNITY_AFFIRMATION",
    persona: true,
    prompt: personaPrompt("3人の投稿『朝ランできた』『絵を完成』『料理に挑戦』を、個別に取り違えずまとめて称えて。"),
    schema: objectSchema({ commentJa: string, commentEn: string }, ["commentJa", "commentEn"]),
  },
  {
    id: "channel-welcome",
    title: "チャンネル歓迎",
    covers: ["NAGI_CHANNEL_WELCOME"],
    feature: "NAGI_CHANNEL_WELCOME",
    persona: true,
    prompt: personaPrompt("『朝の小さな発見』チャンネルの開始を1文で歓迎して。"),
  },
  {
    id: "channel-topic",
    title: "チャンネル話題ふり",
    covers: ["NAGI_CHANNEL_TOPIC"],
    feature: "NAGI_CHANNEL_TOPIC",
    persona: true,
    prompt: personaPrompt("『朝の小さな発見』チャンネルへ、答えやすい話題を1つ振って。"),
  },
  {
    id: "name-intent",
    title: "呼称指定・訂正判定",
    covers: ["NAGI_NAME_INTENT"],
    feature: "NAGI_NAME_INTENT",
    prompt: "『これからは、すいばりって呼んでね』から本人の呼称指定を判定する（本番のjudgeNameIntentを実行）。",
    // 本番は subject=self / intent=rename_request といった固定の識別子しか受け付けず、
    // 外れた値は normalizeNameIntent が none に落とす。自前スキーマで緩く聞くと
    // モデルが別の語を返しても PASS になり、本番で機能していないことに気付けない。
    production: async () =>
      JSON.stringify(await judgeNameIntent("これからは、すいばりって呼んでね"), null, 2),
  },
  {
    id: "news-gate",
    title: "ポジティブニュース掲載判定",
    covers: ["NEWS_POSITIVE_GATE"],
    feature: "NEWS_POSITIVE_GATE",
    prompt: "記事ID n1、題『高校生チームが国際科学大会で優勝』を掲載可能かJSONで判定して。",
    // 本番（judgePositiveNewsBatch）と同じ enum で拘束する。ここを素の string にすると
    // モデルが存在しない reasonCode を作っても PASS になり、本番の検証（REASONS.includes）で
    // 全件 unclear に落ちることに気付けない。
    schema: objectSchema(
      {
        articleId: string,
        publishable: boolean,
        reasonCode: {
          type: "STRING",
          enum: [
            "positive_result", "unresolved", "dark", "politics", "crime",
            "incident", "accident", "promotion", "pr", "unclear",
          ],
        },
      },
      ["articleId", "publishable", "reasonCode"],
    ),
  },
  {
    id: "news-comment-grounded",
    title: "ポジティブニュース調査・コメント",
    covers: ["NEWS_POSITIVE_COMMENT"],
    feature: "NEWS_POSITIVE_COMMENT",
    persona: true,
    prompt: personaPrompt("『高校生チームが国際科学大会で優勝』について確認し、断定しすぎない短いコメントを作って。"),
    tools: [{ googleSearch: {} }],
  },
  {
    id: "predefined-classifier",
    title: "定型文分類・選択",
    covers: ["OLLAMA_PREDEFINED_AFFIRMATION"],
    feature: "OLLAMA_PREDEFINED_AFFIRMATION",
    prompt: "投稿『今日は少し疲れたけど、やることは終えた』を分類する（本番のclassifyを実行）。",
    production: () => classifyPredefinedAffirmationStrict("今日は少し疲れたけど、やることは終えた"),
  },
  {
    id: "news-prescreen",
    title: "ニュース事前スクリーニング",
    covers: ["OLLAMA_NEWS_PRESCREEN"],
    feature: "OLLAMA_NEWS_PRESCREEN",
    prompt: "記事『地域の子ども食堂が開設5周年、利用者が感謝』を本番のclassifierで判定する。",
    production: runNewsPrescreen,
  },
  {
    id: "translation",
    title: "一般翻訳",
    covers: ["OLLAMA_TRANSLATION"],
    feature: "OLLAMA_TRANSLATION",
    prompt: "Translate Japanese to English: 朝の散歩で、小さな花を見つけた。",
    production: () =>
      requestTranslationWithRetry(
        translationPrompt(JAPANESE, ENGLISH, "朝の散歩で、小さな花を見つけた。"),
        ENGLISH,
        { model: aiModel("OLLAMA_TRANSLATION") },
      ),
  },
  {
    id: "bot-translation",
    title: "botたん口調翻訳",
    covers: ["OLLAMA_BOT_TRANSLATION"],
    feature: "OLLAMA_BOT_TRANSLATION",
    prompt: "Translate into casual Bot-tan English without adding facts: 今日も一歩進めたきみ、えらいんだよ！",
    production: () =>
      requestTranslationWithRetry(
        botTranslationPrompt(JAPANESE, ENGLISH, "今日も一歩進めたきみ、えらいんだよ！"),
        ENGLISH,
        // 本番（generateTranslation）と同じく temperature 0.3。
        { model: aiModel("OLLAMA_BOT_TRANSLATION"), temperature: 0.3 },
      ),
  },
];

type Result = {
  id: string;
  title: string;
  covers: AiFeatureKey[];
  model: string;
  provider: string;
  latencyMs: number;
  ok: boolean;
  output: string;
  error?: string;
  jsonValid?: boolean;
  personaSignals?: { casualEnding: boolean; keigo: boolean };
};

async function execute(testCase: Case): Promise<Result> {
  const route = resolveAiRoute(testCase.feature);
  const config: any = {
    systemInstruction: testCase.system ?? (testCase.persona ? SYSTEM_INSTRUCTION : undefined),
    maxOutputTokens: testCase.maxTokens ?? 360,
    ...(testCase.schema
      ? { responseMimeType: "application/json", responseSchema: testCase.schema }
      : {}),
    ...(testCase.tools ? { tools: testCase.tools } : {}),
    ...(testCase.functionDeclaration
      ? { tools: [{ functionDeclarations: [testCase.functionDeclaration] }] }
      : {}),
  };
  const startedAt = Date.now();
  try {
    if (testCase.production) {
      const output = (await testCase.production()).trim();
      return {
        id: testCase.id,
        title: testCase.title,
        covers: testCase.covers,
        model: route.model,
        provider: route.provider,
        latencyMs: Date.now() - startedAt,
        ok: Boolean(output),
        output,
      };
    }
    const response = await generateContentForFeature(testCase.feature, {
      contents: [{ role: "user", parts: [{ text: testCase.prompt }] }],
      config,
    });
    const output = testCase.functionDeclaration
      ? JSON.stringify(response.functionCalls?.[0] ?? null, null, 2)
      : String(response.text ?? "").trim();
    let jsonValid: boolean | undefined;
    if (testCase.schema || testCase.functionDeclaration) {
      try {
        JSON.parse(testCase.functionDeclaration ? JSON.stringify(response.functionCalls?.[0]?.args) : output);
        jsonValid = true;
      } catch {
        jsonValid = false;
      }
    }
    return {
      id: testCase.id,
      title: testCase.title,
      covers: testCase.covers,
      model: route.model,
      provider: route.provider,
      latencyMs: Date.now() - startedAt,
      ok: Boolean(output) && jsonValid !== false,
      output,
      ...(jsonValid !== undefined ? { jsonValid } : {}),
      ...(testCase.persona
        ? {
            personaSignals: {
              casualEnding: /(だよ|だね|なんだ|だぞ|！|〜)/.test(output),
              keigo: /(です|ます|でした|ました)([。！]|$)/.test(output),
            },
          }
        : {}),
    };
  } catch (error) {
    return {
      id: testCase.id,
      title: testCase.title,
      covers: testCase.covers,
      model: route.model,
      provider: route.provider,
      latencyMs: Date.now() - startedAt,
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkEmbedding(): Promise<Result> {
  const feature: AiFeatureKey = "OLLAMA_EMBED";
  const route = resolveAiRoute(feature);
  const base = process.env.OLLAMA_EMBED_BASE_URL ?? process.env.OLLAMA_BASE_URL;
  const startedAt = Date.now();
  try {
    if (!base) throw new Error("Ollama base URL is not configured");
    const response = await fetch(`${base.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: route.model, input: "穏やかな朝の記録" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const data: any = await response.json();
    const dimensions = data?.data?.[0]?.embedding?.length ?? 0;
    return {
      id: "embedding",
      title: "埋め込み",
      covers: [feature],
      model: route.model,
      provider: route.provider,
      latencyMs: Date.now() - startedAt,
      ok: dimensions > 0,
      output: `dimensions=${dimensions}`,
    };
  } catch (error) {
    return {
      id: "embedding",
      title: "埋め込み",
      covers: [feature],
      model: route.model,
      provider: route.provider,
      latencyMs: Date.now() - startedAt,
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function markdown(results: Result[]): string {
  const covered = new Set(results.flatMap((result) => result.covers));
  covered.add("GEMINI_GROUNDING_RESEARCH"); // grounding付き3ケースで実行される
  covered.add("BSKY_IMAGE"); // 移行対象外・Gemini維持を設定表で確認
  const missing = AI_FEATURE_KEYS.filter((feature) => !covered.has(feature));
  const lines = [
    "# AI migration visual review",
    "",
    `- generatedAt: ${new Date().toISOString()}`,
    `- AI_TEXT_PROVIDER: ${process.env.AI_TEXT_PROVIDER ?? "(default)"}`,
    `- OLLAMA_MODEL: ${process.env.OLLAMA_MODEL ?? MODEL}`,
    `- cases: ${results.length}`,
    `- automatic pass: ${results.filter((result) => result.ok).length}/${results.length}`,
    `- uncovered feature keys: ${missing.length ? missing.join(", ") : "none"}`,
    "- BSKY_IMAGE: migration scope excluded; existing Gemini image route retained",
    "- OLLAMA_* の4件（predefined-classifier / news-prescreen / translation / bot-translation）は",
    "  generateContentForFeature を通らないため、本番と同じクライアントを直接呼んでいる",
    "",
    "各項目を目視し、`human review` を `OK` / `NG: 理由` に更新する。自動persona信号は補助であり採否判定ではない。",
    "",
  ];
  for (const result of results) {
    lines.push(
      `## ${result.title} (${result.id})`,
      "",
      `- covers: ${result.covers.join(", ")}`,
      `- provider/model: ${result.provider} / ${result.model}`,
      `- latency: ${result.latencyMs} ms`,
      `- automatic: ${result.ok ? "PASS" : "FAIL"}`,
      ...(result.jsonValid !== undefined ? [`- JSON valid: ${result.jsonValid}`] : []),
      ...(result.personaSignals
        ? [`- persona signals: casual=${result.personaSignals.casualEnding}, keigo=${result.personaSignals.keigo}`]
        : []),
      "- human review: [ ] OK / [ ] NG",
      "",
      "```text",
      result.error ? `ERROR: ${result.error}` : result.output,
      "```",
      "",
    );
  }
  return lines.join("\n");
}

await mkdir(outputDir, { recursive: true });
if (!run) {
  console.log(JSON.stringify({ run: false, cases: cases.map(({ id, title, covers }) => ({ id, title, covers })) }, null, 2));
  process.exit(0);
}

const results: Result[] = [];
for (const [index, testCase] of cases.entries()) {
  console.log(`[${index + 1}/${cases.length + 1}] ${testCase.id}`);
  results.push(await execute(testCase));
}
console.log(`[${cases.length + 1}/${cases.length + 1}] embedding`);
results.push(await checkEmbedding());

await writeFile(
  path.join(outputDir, "latest.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n",
);
await writeFile(path.join(outputDir, "review.md"), markdown(results) + "\n");
console.log(JSON.stringify({
  passed: results.filter((result) => result.ok).length,
  total: results.length,
  failed: results.filter((result) => !result.ok).map((result) => result.id),
  review: path.join(outputDir, "review.md"),
}, null, 2));
