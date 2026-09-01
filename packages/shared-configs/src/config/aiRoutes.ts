/**
 * 「どの機能にどのモデル / ServiceTier を充てるか」の唯一の一覧表。
 *
 * 機能側のコードにはモデル名を書かない。各AI呼び出しは自分の機能キー（AiFeatureKey）を
 * 名乗るだけで、実際のモデルと ServiceTier はこのファイルが決める。
 * モデルを変えたいときに触るのは、
 *   - このファイルの AI_FEATURES の1行、または
 *   - 環境変数 AI_ROUTE_<機能キー>（例: AI_ROUTE_BSKY_CONVERSATION=flash-standard）
 * のどちらかだけ。conversation.ts などの機能コードは一切いじらない。
 *
 * 【重要】このファイルは module scope で process.env を読んではいけない。
 * 各アプリの dotenv.config() はモジュール本体で走る = ESM では全 import 評価の「後」。
 * トップレベルで env を読むと .env の上書きが黙って無視される。
 * そのため解決は resolveAiRoute() の初回呼び出し時に行い、メモ化する。
 */

// ---------------------------------------------------------------------------
// 層1: モデル別名 → 実モデルID
// 実際のモデル名が登場するのはこの表だけ。
// ---------------------------------------------------------------------------

export type ModelAliasName =
  | "gemini-lite"
  | "gemini-flash"
  | "gemini-35-lite"
  | "gemini-36-flash"
  | "gemini-grounding"
  | "gemini-image"
  | "gemini-embedding"
  | "ollama-chat"
  | "ollama-embed"
  | "ollama-translate"
  | "ollama-bot-translate";

export type AiTextProvider = "ollama" | "gemini";

export const DEFAULT_OLLAMA_TEXT_MODEL =
  "hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S";

/** `OLLAMA_TEXT_CONTEXT_LENGTH` 未設定時の num_ctx。 */
export const DEFAULT_OLLAMA_TEXT_CONTEXT_LENGTH = 32_768;

let contextLengthCache: number | undefined;

/**
 * ローカル生成の全リクエストで使う num_ctx。**必ず全呼び出し箇所でこの関数を使うこと。**
 *
 * 1. Ollama の既定は 4096 しかない。SYSTEM_INSTRUCTION だけで約3,900トークンあり、
 *    そこへ会話履歴と grounding の調査ブロック（最大8,000字）が乗る。4096 のままだと
 *    実測でリプライが**空文字**になる（エラーにならないので気付けない）。
 * 2. Ollama は num_ctx が違うと runner を作り直す。1箇所でも値がずれると、リプライ生成と
 *    分類・翻訳が交互に来るたびに26Bモデルが5〜8秒かけてリロードされる。
 * 3. Ollama は **num_predict を考慮せず**プロンプトを num_ctx まで詰めるので、num_ctx を
 *    上げるだけでは事故は止まらない。出力枠の確保は ollamaBudget.ts が受け持つ。
 *
 * 定数ではなく関数なのは、env をモジュール評価時に読むと `dotenv.config()` より先に
 * 走ってしまうため（アプリの index.ts は ESM の import 解決後に dotenv を呼ぶ）。
 * 1関数に集約したうえでメモ化するので、値が経路ごとにずれる心配は無い。
 * ホスト側の VRAM が足りなければ `OLLAMA_TEXT_CONTEXT_LENGTH=16384` で戻せる。
 */
export function ollamaTextContextLength(): number {
  if (contextLengthCache !== undefined) return contextLengthCache;
  const raw = process.env.OLLAMA_TEXT_CONTEXT_LENGTH?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (raw && (!Number.isFinite(parsed) || parsed < 4_096)) {
    console.warn(
      `[WARN][AI_ROUTE] OLLAMA_TEXT_CONTEXT_LENGTH="${raw}" は無効。既定の ${DEFAULT_OLLAMA_TEXT_CONTEXT_LENGTH} を使う。`,
    );
  }
  contextLengthCache =
    raw && Number.isFinite(parsed) && parsed >= 4_096
      ? Math.floor(parsed)
      : DEFAULT_OLLAMA_TEXT_CONTEXT_LENGTH;
  return contextLengthCache;
}

/**
 * OLLAMA_BASE_URL（OpenAI互換なので末尾に /v1 が付く）から、Ollamaネイティブの
 * ルートURLを作る。
 *
 * テキスト生成は必ずネイティブ `/api/chat` を使うこと。OpenAI互換の
 * `/v1/chat/completions` では `num_ctx` を指定する方法がなく（`options` は黙って
 * 無視される）、context が 4096 に落ちたrunnerが別途ロードされてしまう。
 * 埋め込みと死活監視は /v1 のままでよい（num_ctx が要らず、モデルも別）。
 */
export function ollamaNativeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

type ModelAliasSpec = {
  /** このモデル別名を差し替える環境変数名 */
  env: string;
  /** env 未設定時の既定。呼び出し時に評価される（module scope で env を読まないため） */
  fallback: () => string;
};

const MODEL_ALIAS_SPECS: Record<ModelAliasName, ModelAliasSpec> = {
  "gemini-lite": { env: "MODEL_GEMINI_LITE", fallback: () => "gemini-2.5-flash-lite" },
  "gemini-flash": { env: "MODEL_GEMINI_FLASH", fallback: () => "gemini-2.5-flash" },
  "gemini-35-lite": { env: "MODEL_GEMINI_35_LITE", fallback: () => "gemini-3.5-flash-lite" },
  "gemini-36-flash": { env: "MODEL_GEMINI_36_FLASH", fallback: () => "gemini-3.6-flash" },
  "gemini-grounding": {
    env: "MODEL_GEMINI_GROUNDING",
    fallback: () => process.env.MODEL_GEMINI_FLASH?.trim() || "gemini-2.5-flash",
  },
  "gemini-image": { env: "MODEL_GEMINI_IMAGE", fallback: () => "gemini-2.5-flash-image-preview" },
  "gemini-embedding": { env: "MODEL_GEMINI_EMBEDDING", fallback: () => "gemini-embedding-001" },
  "ollama-chat": { env: "OLLAMA_MODEL", fallback: () => DEFAULT_OLLAMA_TEXT_MODEL },
  "ollama-embed": { env: "OLLAMA_EMBED_MODEL", fallback: () => "snowflake-arctic-embed2" },
  "ollama-translate": {
    env: "OLLAMA_TRANSLATION_MODEL",
    fallback: () => process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_TEXT_MODEL,
  },
  // botたん翻訳は「専用env → 汎用OLLAMA_MODEL → 既定」の三段フォールバックを維持する
  "ollama-bot-translate": {
    env: "OLLAMA_BOT_TRANSLATION_MODEL",
    fallback: () => process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_TEXT_MODEL,
  },
};

// ---------------------------------------------------------------------------
// 層2: ルート = モデル別名 × ServiceTier
// ---------------------------------------------------------------------------

export type AiProvider = "gemini" | "ollama";

/**
 * "auto" は「serviceTier を送らない（Google 既定に任せる）」の意味。
 * 現状 serviceTier を設定していない呼び出しを挙動そのままで移行するために必要。
 */
export type AiTier = "flex" | "standard" | "auto";

export type AiRouteName =
  | "lite-flex"
  | "lite-standard"
  | "lite-auto"
  | "flash-flex"
  | "flash-standard"
  | "flash-auto"
  | "35-lite-flex"
  | "35-lite-standard"
  | "36-flash-flex"
  | "36-flash-standard"
  | "grounding-auto"
  | "image-auto"
  | "embedding-auto"
  | "ollama-chat"
  | "ollama-embed"
  | "ollama-translate"
  | "ollama-bot-translate";

type AiRouteSpec = { provider: AiProvider; alias: ModelAliasName; tier: AiTier };

export const AI_ROUTES = {
  "lite-flex": { provider: "gemini", alias: "gemini-lite", tier: "flex" },
  "lite-standard": { provider: "gemini", alias: "gemini-lite", tier: "standard" },
  "lite-auto": { provider: "gemini", alias: "gemini-lite", tier: "auto" },
  "flash-flex": { provider: "gemini", alias: "gemini-flash", tier: "flex" },
  "flash-standard": { provider: "gemini", alias: "gemini-flash", tier: "standard" },
  "flash-auto": { provider: "gemini", alias: "gemini-flash", tier: "auto" },
  "35-lite-flex": { provider: "gemini", alias: "gemini-35-lite", tier: "flex" },
  "35-lite-standard": { provider: "gemini", alias: "gemini-35-lite", tier: "standard" },
  "36-flash-flex": { provider: "gemini", alias: "gemini-36-flash", tier: "flex" },
  "36-flash-standard": { provider: "gemini", alias: "gemini-36-flash", tier: "standard" },
  "grounding-auto": { provider: "gemini", alias: "gemini-grounding", tier: "auto" },
  "image-auto": { provider: "gemini", alias: "gemini-image", tier: "auto" },
  // ※どの機能キーからも参照されていない。実運用の埋め込みは ollama-embed
  //   （snowflake-arctic-embed2）で、Gemini へ戻す予定もない。移行と削除を混ぜないため
  //   今回は残すが、次に aiRoutes を触るときの撤去候補。
  "embedding-auto": { provider: "gemini", alias: "gemini-embedding", tier: "auto" },
  // Ollama はローカル実行なので ServiceTier の概念がない
  "ollama-chat": { provider: "ollama", alias: "ollama-chat", tier: "auto" },
  "ollama-embed": { provider: "ollama", alias: "ollama-embed", tier: "auto" },
  "ollama-translate": { provider: "ollama", alias: "ollama-translate", tier: "auto" },
  "ollama-bot-translate": { provider: "ollama", alias: "ollama-bot-translate", tier: "auto" },
} as const satisfies Record<AiRouteName, AiRouteSpec>;

export const AI_ROUTE_NAMES = Object.keys(AI_ROUTES) as AiRouteName[];

// ---------------------------------------------------------------------------
// 層3: 機能 → ルート  ★これが一覧表の本体★
//
// 上書き:  AI_ROUTE_<キー名>=<ルート名>   例) AI_ROUTE_BSKY_CONVERSATION=flash-standard
// 各既定値は「リファクタ前の実効挙動」をそのまま写したもの。
// ---------------------------------------------------------------------------

export const AI_FEATURES = {
  // ══════ 共通（Bluesky botたん と Nagi の両方に効く） ═══════════════
  // ここを変えると両方のbotに効く。片方だけ変えたいなら機能キーの分割が必要。
  // ユーザ日記の本文。実運用の呼び出し（generateUserDiaryResilient）は必ず下の
  // COMMON_DIARY_ATTEMPT_* を requestOptions で明示上書きするので、このキーが効くのは
  // ラダーを通さず generateUserDiary を直接呼んだときだけ。
  COMMON_USER_DIARY: "35-lite-flex", // ユーザ日記 本文（bsky DiaryFeature + NagiDiaryFeature）
  // 日記の再試行ラダー。1日1回しか機会が無いので、詰まったら段を上げて必ず書き切る。
  // 品質比較後は3.5 Flash-Liteに固定し、tierだけを上げる。
  COMMON_DIARY_ATTEMPT_EARLY: "35-lite-flex", // 日記 1〜2回目
  COMMON_DIARY_ATTEMPT_MID: "35-lite-standard", // 日記 3〜4回目
  COMMON_DIARY_ATTEMPT_LATE: "35-lite-standard", // 日記 5回目以降

  // ══════ Bluesky 全肯定botたん（bsky_bot_server のみ） ══════════════
  //
  // 肯定返信と会話の実装（generateAffirmativeWord / conversation）は Nagi からも呼ばれるが、
  // Nagi は必ず requestOptions で model/serviceTier を明示上書きする（再試行ラダー）。
  // つまり下の2キーが実際に効くのは Bluesky 側だけ。
  // Nagi 側を変えたいときは NAGI_REPLY_ATTEMPT_{EARLY,MID,LATE} を触ること。
  BSKY_AFFIRMATIVE_REPLY: "lite-standard", // 通常AIリプライ（スコア付き）
  BSKY_CONVERSATION: "lite-standard", // 会話モード（chats.create）
  BSKY_ANALYZE: "lite-flex", // botたん分析
  BSKY_FORTUNE: "lite-flex", // 占い
  BSKY_BOT_DIARY: "lite-flex", // botたん自身の日記（Leaflet/Zenn 投稿）
  BSKY_QUESTIONS_ANSWER: "lite-flex", // 質問への回答
  BSKY_RECOMMENDED_SONG: "lite-flex", // おすすめソング（DJ機能）
  BSKY_WHIMSICAL_REPLY: "lite-flex", // 気まぐれ投稿へのリプライ
  BSKY_CHEER_SUBJECT: "lite-flex", // 応援対象かどうかの判定
  BSKY_CHEER_RESULT: "lite-flex", // 応援メッセージ
  BSKY_OMIKUJI: "lite-flex", // おみくじ
  BSKY_ANNIVERSARY: "lite-flex", // 記念日
  BSKY_RECAP: "lite-flex", // 1年のまとめ
  BSKY_ROOM_WELCOME: "lite-flex", // お部屋招待のお出迎えメッセージ
  BSKY_MY_MOOD_SONG: "lite-flex", // 今日の気分ソング（※現在は呼び出し元なし）
  BSKY_IMAGE: "image-auto", // 画像生成（※現在は呼び出し元なし）

  // ══════ biorhythm_server（定期ポスト生成） ═════════════════════════
  // 今期の話題作リスト（grounding）。日次予定表を作るときだけ呼び、さらに7日キャッシュするので実質週1回。
  BIORHYTHM_SEASONAL_WORKS: "flash-flex",
  BIORHYTHM_MEMORY_IMPRESSIONS: "lite-flex", // 公開会話から作品名・印象語を非同期抽出
  BIORHYTHM_TTS_PRONUNCIATIONS: "lite-flex", // 作品名・固有名詞の発話用かなを非同期生成
  // 今日の予定表。1日1回しか撃たず、落ちると丸1日プラン無しで走ることになるので
  // NAGI_ANALYSIS と同じ理由で standard に置く（flex は 503 を踏みやすい）。
  BIORHYTHM_DAILY_PLAN: "flash-standard",
  // botたんの現在状況（三人称の描写文）。1日24〜48回と呼び出しが多いが、今日の予定表が
  // 「何を・誰と・何分」を決めているので、ここに残るのは決まった予定を情景に起こす作業だけ。
  // systemInstruction も BOT_SCENE_BRIEF_JA（約1,000字）に絞ってあるので lite で足りる。
  BIORHYTHM_STATUS: "lite-flex",
  BIORHYTHM_GOOD_NIGHT: "flash-flex", // おやすみポスト
  BIORHYTHM_QUESTION: "flash-flex", // 質問生成
  BIORHYTHM_WHIMSICAL_POST_PLAN: "flash-flex", // 気まぐれ投稿: 企画フェーズ（function calling）
  BIORHYTHM_WHIMSICAL_POST_WRITE: "flash-flex", // 気まぐれ投稿: 執筆フェーズ（構造化JSON）

  // ══════ Nagi ═══════════════════════════════════════════════════════
  // ユーザーが画面上で待つ通常リプライ。Flex の混雑時に約10分滞留し、直列ワーカーの
  // 後続ジョブまで塞いだ実績があるため、初回から Standard で応答時間を優先する。
  NAGI_REPLY_ATTEMPT_EARLY: "lite-standard", // リプライ 1〜2回目
  NAGI_REPLY_ATTEMPT_MID: "lite-standard", // リプライ 3〜4回目
  NAGI_REPLY_ATTEMPT_LATE: "flash-standard", // リプライ 5回目以降 + 会話は初回から
  // 自動アクター分析（名刺）。発火は「初回登録 + Nagi投稿10件 + 100件ごと」と頻度が低く、
  // 失敗すると名刺が出ないまま次の機会まで待つことになるので、flex ではなく standard に置く。
  // flex は割引と引き換えのベストエフォート枠で 503(UNAVAILABLE) を踏みやすい。
  NAGI_ANALYSIS: "lite-standard", // 自動アクター分析
  NAGI_CARD_COMMENT: "lite-standard", // カードのbotたんコメント
  NAGI_COMMUNITY_AFFIRMATION: "lite-flex", // コミュニティ全肯定
  NAGI_CHANNEL_WELCOME: "lite-flex", // チャンネル作成時の歓迎
  NAGI_CHANNEL_TOPIC: "lite-flex", // チャンネルへの話題ふり
  // 呼び名の指定/訂正かどうかの判定。返信生成と並列だが投稿前に完了を待つため、
  // 通常返信と同じく Standard で応答時間を優先する。
  NAGI_NAME_INTENT: "lite-standard",

  // ══════ ニュース ═══════════════════════════════════════════════════
  NEWS_POSITIVE_GATE: "lite-flex", // ポジニュース判定（構造化JSON）
  NEWS_POSITIVE_COMMENT: "lite-flex", // ポジニュースのbotたんコメント

  // Ollama 運用時にも残す、検索・URL調査だけの Gemini。人格や最終文面は生成しない。
  GROUNDING_RESEARCH: "ollama-chat", // SearXNGで集めた素材の要約（自前ホスト）

  // ══════ ローカル Ollama（ServiceTier なし） ════════════════════════
  OLLAMA_PREDEFINED_AFFIRMATION: "ollama-chat", // 定型文リプライの分類/LLM選択
  OLLAMA_NEWS_PRESCREEN: "ollama-chat", // ニュースの事前スクリーニング
  OLLAMA_EMBED: "ollama-embed", // 埋め込み（投稿/ユーザ/チャンネル/ニュース）
  OLLAMA_TRANSLATION: "ollama-translate", // 投稿の一般翻訳
  OLLAMA_BOT_TRANSLATION: "ollama-bot-translate", // botたん投稿のペルソナ翻訳
} as const satisfies Record<string, AiRouteName>;

export type AiFeatureKey = keyof typeof AI_FEATURES;

export const AI_FEATURE_KEYS = Object.keys(AI_FEATURES) as AiFeatureKey[];

// ---------------------------------------------------------------------------
// リゾルバ（遅延解決 + メモ化）
// ---------------------------------------------------------------------------

export type ResolvedAiRoute = {
  feature: AiFeatureKey;
  route: AiRouteName;
  provider: AiProvider;
  model: string;
  /** undefined = serviceTier を送らない（ルートが "auto" のとき） */
  serviceTier?: "flex" | "standard";
  /** 既定値か env 上書きか、env/機能キーが不正でフォールバックしたか */
  source: "default" | "env" | "env-invalid" | "unknown-feature";
};

/**
 * 機能キーもルート名も引けなかったときの最終フォールバック。
 * ここに落ちるのは「アプリ側の dist だけ新しくてレジストリの dist が古い」等の
 * ビルド不整合のとき。AI呼び出し全体が TypeError で落ちるより、安いルートで
 * 動き続けて警告を出すほうがマシ（生成が1回失敗するだけで機能が丸ごと死ぬ箇所がある）。
 */
const FALLBACK_ROUTE: AiRouteName = "lite-flex";

let cache: Map<AiFeatureKey, ResolvedAiRoute> | undefined;

function isAiRouteName(value: string): value is AiRouteName {
  return Object.prototype.hasOwnProperty.call(AI_ROUTES, value);
}

/**
 * テキスト生成の全体スイッチ。未設定時は Ollama を使い、`gemini` を明示すると
 * AI_FEATURES に残してある従来の Gemini モデル/tier 割り当てへ一括で戻る。
 * 画像生成と埋め込みは互換性がないため、このスイッチの対象外。
 */
export function aiTextProvider(): AiTextProvider {
  const value = process.env.AI_TEXT_PROVIDER?.trim().toLowerCase();
  if (!value || value === "ollama") return "ollama";
  if (value === "gemini") return "gemini";
  console.warn(
    `[WARN][AI_ROUTE] AI_TEXT_PROVIDER="${value}" は無効。既定の "ollama" を使う。`,
  );
  return "ollama";
}

/** `off` なら検索を完全に止める。未設定時は調査専用 Gemini を使う。 */
export function isAiGroundingEnabled(): boolean {
  const value = process.env.AI_GROUNDING_PROVIDER?.trim().toLowerCase();
  if (!value || value === "gemini") return true;
  if (value === "off") return false;
  console.warn(
    `[WARN][AI_ROUTE] AI_GROUNDING_PROVIDER="${value}" は無効。既定の "gemini" を使う。`,
  );
  return true;
}

export function aiRouteEnvName(feature: AiFeatureKey): string {
  return `AI_ROUTE_${feature}`;
}

function resolveUncached(feature: AiFeatureKey): ResolvedAiRoute {
  let route: AiRouteName | undefined = AI_FEATURES[feature];
  let source: ResolvedAiRoute["source"] = "default";

  // 型上は起こらないが、ビルド不整合（アプリの dist だけ新しく、レジストリの dist が
  // 古い等）や JS からの呼び出しで未知のキーが来ることがある。ここで落とすと
  // generateContentWithRetry ごと throw し、呼び出し元の機能が丸ごと死ぬ。
  if (!route) {
    console.warn(
      `[WARN][AI_ROUTE] 未知の機能キー "${feature}"。ビルドが古い可能性がある。` +
        ` フォールバック "${FALLBACK_ROUTE}" で続行する。`,
    );
    route = FALLBACK_ROUTE;
    source = "unknown-feature";
  }

  const raw = process.env[aiRouteEnvName(feature)]?.trim();
  if (raw) {
    if (isAiRouteName(raw)) {
      route = raw;
      source = "env";
    } else {
      // 24時間動き続けるbotをタイポで落とさない。warn して既定にフォールバックし、
      // 起動時の logAiRouteTable() でまとめて目立たせる。
      source = "env-invalid";
      console.warn(
        `[WARN][AI_ROUTE] ${aiRouteEnvName(feature)}="${raw}" は未知のルート名。既定 "${route}" を使う。` +
          ` 有効な値: ${AI_ROUTE_NAMES.join(", ")}`,
      );
    }
  }

  // AI_ROUTES / MODEL_ALIAS_SPECS 側も同じ理由で防御する。ここは絶対に throw させない。
  let spec: AiRouteSpec = AI_ROUTES[route] ?? AI_ROUTES[FALLBACK_ROUTE];

  // Gemini のテキスト生成ルートを、呼び出し側を変えずに Ollama へ一括移行する。
  // image / embedding はモデル能力とAPI契約が異なるため、従来の Gemini ルートを保つ。
  if (
    spec.provider === "gemini" &&
    spec.alias !== "gemini-image" &&
    spec.alias !== "gemini-embedding" &&
    spec.alias !== "gemini-grounding" &&
    aiTextProvider() === "ollama"
  ) {
    spec = AI_ROUTES["ollama-chat"];
  }

  const alias = MODEL_ALIAS_SPECS[spec.alias] ?? MODEL_ALIAS_SPECS["gemini-lite"];
  const model = process.env[alias.env]?.trim() || alias.fallback();

  return {
    feature,
    route,
    provider: spec.provider,
    model,
    ...(spec.tier === "auto" ? {} : { serviceTier: spec.tier }),
    source,
  };
}

/** 機能キーから、実際に使うモデルと ServiceTier を解決する。初回呼び出し時に解決してメモ化。 */
export function resolveAiRoute(feature: AiFeatureKey): ResolvedAiRoute {
  if (!cache) cache = new Map();
  let hit = cache.get(feature);
  if (!hit) {
    hit = resolveUncached(feature);
    cache.set(feature, hit);
  }
  return hit;
}

/**
 * ルート名から直接モデルと ServiceTier を解く。
 *
 * 通常は機能キーから引く（resolveAiRoute）。これを使うのは、同じ機能を複数のルートで
 * 撃ち比べたいときだけ。実モデル名を呼び出し側に書かせないために置いている。
 * 機能キーを経由しないのでメモ化もしない（比較用途で頻度が低い）。
 */
export function resolveAiRouteByName(
  route: AiRouteName,
): { model: string; serviceTier?: "flex" | "standard" } {
  const spec: AiRouteSpec = AI_ROUTES[route] ?? AI_ROUTES[FALLBACK_ROUTE];
  const alias = MODEL_ALIAS_SPECS[spec.alias] ?? MODEL_ALIAS_SPECS["gemini-lite"];
  return {
    model: process.env[alias.env]?.trim() || alias.fallback(),
    ...(spec.tier === "auto" ? {} : { serviceTier: spec.tier }),
  };
}

/** 機能キー → 実モデルID。DBに記録する model カラムもこれを使う。 */
export function aiModel(feature: AiFeatureKey): string {
  return resolveAiRoute(feature).model;
}

/** 機能キー → ServiceTier。undefined なら送らない。 */
export function aiServiceTier(feature: AiFeatureKey): "flex" | "standard" | undefined {
  return resolveAiRoute(feature).serviceTier;
}

/** テスト用。process.env を書き換えたあとに呼ぶ。 */
export function resetAiRouteCache(): void {
  cache = undefined;
  contextLengthCache = undefined;
}

/**
 * 起動時に1回だけ、解決済みの割り当て表をログに出す。
 * dotenv.config() の「後」に呼ぶこと。
 * prefixes を渡すと、そのアプリが使う機能だけに絞れる（例: ["BSKY_", "OLLAMA_"]）。
 */
export function logAiRouteTable(options: { prefixes?: string[] } = {}): void {
  const { prefixes } = options;
  const keys = AI_FEATURE_KEYS.filter(
    (key) => !prefixes?.length || prefixes.some((prefix) => key.startsWith(prefix)),
  );
  const rows = keys.map((key) => {
    const resolved = resolveAiRoute(key);
    return {
      feature: key,
      route: resolved.route,
      model: resolved.model,
      tier: resolved.serviceTier ?? "(auto)",
      source: resolved.source,
    };
  });

  console.log("[INFO][AI_ROUTE] resolved AI routing table");
  console.table(rows);

  const invalid = rows.filter((row) => row.source === "env-invalid");
  if (invalid.length) {
    console.warn(
      `[WARN][AI_ROUTE] 無効な AI_ROUTE_* が ${invalid.length} 件あり既定にフォールバックした:`,
      invalid.map((row) => row.feature).join(", "),
    );
  }
}
