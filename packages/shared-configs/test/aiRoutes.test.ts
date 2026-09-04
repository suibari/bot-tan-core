import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_FEATURES,
  AI_FEATURE_KEYS,
  AI_ROUTES,
  DEFAULT_OLLAMA_TEXT_MODEL,
  aiModel,
  isAiGroundingEnabled,
  resetAiRouteCache,
  resolveAiRoute,
  type AiFeatureKey,
} from "../src/config/aiRoutes.js";

const MODEL_ENV_VARS = [
  "MODEL_GEMINI_LITE",
  "MODEL_GEMINI_FLASH",
  "MODEL_GEMINI_35_LITE",
  "MODEL_GEMINI_36_FLASH",
  "MODEL_GEMINI_IMAGE",
  "OLLAMA_MODEL",
  "OLLAMA_EMBED_MODEL",
  "OLLAMA_TRANSLATION_MODEL",
  "OLLAMA_BOT_TRANSLATION_MODEL",
  "AI_TEXT_PROVIDER",
  "AI_GROUNDING_PROVIDER",
];

/** レジストリ関連の env を全部消してから fn を走らせ、必ず元に戻す。 */
function withCleanEnv(fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of [...MODEL_ENV_VARS, ...AI_FEATURE_KEYS.map((k) => `AI_ROUTE_${k}`)]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetAiRouteCache();
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAiRouteCache();
  }
}

const LITE = "gemini-2.5-flash-lite";
const FLASH = "gemini-2.5-flash";
const FLASH_35_LITE = "gemini-3.5-flash-lite";

/**
 * 各機能に「意図して」割り当てたモデルと ServiceTier のピン留め。
 * ここが赤くなる = どこかの機能のモデル/tier が意図せず変わった、ということ。
 * 方針: 即時応答が要るものは standard、待ってもらえるものは flex。
 * tier が undefined の行は serviceTier を送らない（"-auto" ルート）。
 */
const EXPECTED: Record<AiFeatureKey, [model: string, tier: "flex" | "standard" | undefined]> = {
  // 共通（bsky + Nagi 両方に効く）
  COMMON_USER_DIARY: [FLASH_35_LITE, "flex"],
  // 日記の再試行ラダー。1日1回しか機会が無いので、詰まったら段を上げて必ず書き切る。
  COMMON_DIARY_ATTEMPT_EARLY: [FLASH_35_LITE, "flex"],
  COMMON_DIARY_ATTEMPT_MID: [FLASH_35_LITE, "standard"],
  COMMON_DIARY_ATTEMPT_LATE: [FLASH_35_LITE, "standard"],
  // bsky_bot_server（肯定返信/会話は Nagi が requestOptions で上書きするので実質 bsky 専用）
  BSKY_AFFIRMATIVE_REPLY: [LITE, "standard"],
  BSKY_CONVERSATION: [LITE, "standard"],
  BSKY_ANALYZE: [LITE, "flex"],
  BSKY_FORTUNE: [LITE, "flex"],
  BSKY_BOT_DIARY: [LITE, "flex"],
  BSKY_QUESTIONS_ANSWER: [LITE, "flex"],
  BSKY_RECOMMENDED_SONG: [LITE, "flex"],
  BSKY_WHIMSICAL_REPLY: [LITE, "flex"],
  BSKY_CHEER_SUBJECT: [LITE, "flex"],
  BSKY_CHEER_RESULT: [LITE, "flex"],
  BSKY_OMIKUJI: [LITE, "flex"],
  BSKY_ANNIVERSARY: [LITE, "flex"],
  BSKY_RECAP: [LITE, "flex"],
  BSKY_ROOM_WELCOME: [LITE, "flex"],
  BSKY_MY_MOOD_SONG: [LITE, "flex"],
  BSKY_IMAGE: ["gemini-2.5-flash-image-preview", undefined],
  // biorhythm_server（定期ポスト）
  // 今期の話題作リスト。grounding 付きだが7日キャッシュするので実質週1回。
  BIORHYTHM_SEASONAL_WORKS: [FLASH, "flex"],
  // 公開会話の非同期バッチ抽出。返信ホットパス外なので lite/flex でよい。
  BIORHYTHM_MEMORY_IMPRESSIONS: [LITE, "flex"],
  BIORHYTHM_TTS_PRONUNCIATIONS: [LITE, "flex"],
  // 今日の予定表。1日1回しか撃たず、落ちると丸1日プラン無しになるので standard。
  BIORHYTHM_DAILY_PLAN: [FLASH, "standard"],
  // 予定表が骨組みを決め、systemInstruction も描写用ブリーフに絞ったので lite で足りる。
  BIORHYTHM_STATUS: [LITE, "flex"],
  BIORHYTHM_GOOD_NIGHT: [FLASH, "flex"],
  BIORHYTHM_QUESTION: [FLASH, "flex"],
  BIORHYTHM_WHIMSICAL_POST_PLAN: [FLASH, "flex"],
  BIORHYTHM_WHIMSICAL_POST_WRITE: [FLASH, "flex"],
  // Nagi
  NAGI_REPLY_ATTEMPT_EARLY: [LITE, "standard"],
  NAGI_REPLY_ATTEMPT_MID: [LITE, "standard"],
  NAGI_REPLY_ATTEMPT_LATE: [FLASH, "standard"],
  NAGI_ANALYSIS: [LITE, "standard"],
  NAGI_CARD_COMMENT: [LITE, "standard"],
  NAGI_COMMUNITY_AFFIRMATION: [LITE, "flex"],
  NAGI_CHANNEL_WELCOME: [LITE, "flex"],
  NAGI_CHANNEL_TOPIC: [LITE, "flex"],
  NAGI_NAME_INTENT: [LITE, "standard"],
  // ニュース
  NEWS_POSITIVE_GATE: [LITE, "flex"],
  NEWS_POSITIVE_COMMENT: [LITE, "flex"],
  GROUNDING_RESEARCH: [DEFAULT_OLLAMA_TEXT_MODEL, undefined],
  // ローカル Ollama
  OLLAMA_PREDEFINED_AFFIRMATION: [DEFAULT_OLLAMA_TEXT_MODEL, undefined],
  OLLAMA_NEWS_PRESCREEN: [DEFAULT_OLLAMA_TEXT_MODEL, undefined],
  OLLAMA_EMBED: ["snowflake-arctic-embed2", undefined],
  // 検索クエリの別名展開。テキスト生成なので ollama-chat と同じモデルへ乗る。
  OLLAMA_QUERY_EXPANSION: [DEFAULT_OLLAMA_TEXT_MODEL, undefined],
  OLLAMA_TRANSLATION: [DEFAULT_OLLAMA_TEXT_MODEL, undefined],
  OLLAMA_BOT_TRANSLATION: [DEFAULT_OLLAMA_TEXT_MODEL, undefined],
};

test("各機能に意図したモデル/tierが割り当たっている", () => {
  withCleanEnv(() => {
    process.env.AI_TEXT_PROVIDER = "gemini";
    resetAiRouteCache();
    for (const [feature, [model, tier]] of Object.entries(EXPECTED) as [
      AiFeatureKey,
      [string, "flex" | "standard" | undefined],
    ][]) {
      const resolved = resolveAiRoute(feature);
      assert.equal(resolved.model, model, `${feature} の model`);
      assert.equal(resolved.serviceTier, tier, `${feature} の serviceTier`);
      assert.equal(resolved.source, "default", `${feature} の source`);
    }
  });
});

test("既定では全テキスト生成を指定のOllamaモデルへ集約する", () => {
  withCleanEnv(() => {
    for (const feature of AI_FEATURE_KEYS) {
      const resolved = resolveAiRoute(feature);
      if (feature === "BSKY_IMAGE") {
        assert.equal(resolved.provider, "gemini");
        continue;
      }
      if (feature === "OLLAMA_EMBED") {
        assert.equal(resolved.model, "snowflake-arctic-embed2");
        continue;
      }
      assert.equal(resolved.provider, "ollama", `${feature} の provider`);
      assert.equal(resolved.model, DEFAULT_OLLAMA_TEXT_MODEL, `${feature} の model`);
      assert.equal(resolved.serviceTier, undefined, `${feature} の tier`);
    }
  });
});

test("EXPECTED は全機能を網羅している（機能を足したらここも足す）", () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...AI_FEATURE_KEYS].sort());
});

test("AI_FEATURES の各値は AI_ROUTES に存在する", () => {
  for (const [feature, route] of Object.entries(AI_FEATURES)) {
    assert.ok(route in AI_ROUTES, `${feature} のルート "${route}" が AI_ROUTES にない`);
  }
});

test("モデル別名の env はモジュール読み込みの後に設定しても効く", () => {
  // 最大のリスクはここ。各アプリの dotenv.config() は全 import の「後」に走るので、
  // レジストリが module scope で env を読んでいたら .env の上書きが黙って無視される。
  withCleanEnv(() => {
    process.env.AI_TEXT_PROVIDER = "gemini";
    resetAiRouteCache();
    assert.equal(aiModel("BSKY_ANALYZE"), LITE);

    process.env.MODEL_GEMINI_LITE = "gemini-9.9-flash-lite";
    resetAiRouteCache();

    assert.equal(aiModel("BSKY_ANALYZE"), "gemini-9.9-flash-lite");
    // 別名の差し替えは lite-* を使う全機能に一括で効く
    assert.equal(aiModel("NAGI_CARD_COMMENT"), "gemini-9.9-flash-lite");
    // flash 系は影響を受けない
    assert.equal(aiModel("BIORHYTHM_GOOD_NIGHT"), FLASH);
  });
});

test("AI_ROUTE_<機能> でその機能だけルートを差し替えられる", () => {
  withCleanEnv(() => {
    process.env.AI_TEXT_PROVIDER = "gemini";
    process.env.AI_ROUTE_BSKY_CONVERSATION = "flash-standard";
    resetAiRouteCache();

    const conversation = resolveAiRoute("BSKY_CONVERSATION");
    assert.equal(conversation.route, "flash-standard");
    assert.equal(conversation.model, FLASH);
    assert.equal(conversation.serviceTier, "standard");
    assert.equal(conversation.source, "env");

    // 隣の機能は既定のまま
    assert.equal(resolveAiRoute("BIORHYTHM_WHIMSICAL_POST_PLAN").model, FLASH);
  });
});

test("日記だけをGemini 3.5/3.6のFlex・Standardへ切り替えられる", () => {
  withCleanEnv(() => {
    process.env.AI_TEXT_PROVIDER = "gemini";
    process.env.AI_ROUTE_COMMON_DIARY_ATTEMPT_EARLY = "35-lite-flex";
    process.env.AI_ROUTE_COMMON_DIARY_ATTEMPT_MID = "35-lite-standard";
    process.env.AI_ROUTE_COMMON_DIARY_ATTEMPT_LATE = "36-flash-standard";
    resetAiRouteCache();

    assert.deepEqual(
      resolveAiRoute("COMMON_DIARY_ATTEMPT_EARLY"),
      {
        feature: "COMMON_DIARY_ATTEMPT_EARLY",
        route: "35-lite-flex",
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        serviceTier: "flex",
        source: "env",
      },
    );
    assert.equal(resolveAiRoute("COMMON_DIARY_ATTEMPT_MID").serviceTier, "standard");
    assert.equal(resolveAiRoute("COMMON_DIARY_ATTEMPT_LATE").model, "gemini-3.6-flash");

    process.env.MODEL_GEMINI_35_LITE = "gemini-3.5-flash-lite-pinned";
    resetAiRouteCache();
    assert.equal(
      resolveAiRoute("COMMON_DIARY_ATTEMPT_EARLY").model,
      "gemini-3.5-flash-lite-pinned",
    );
  });
});

test("不正な AI_ROUTE_* は警告して既定にフォールバックする（throw しない）", () => {
  withCleanEnv(() => {
    process.env.AI_TEXT_PROVIDER = "gemini";
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);

    try {
      process.env.AI_ROUTE_BSKY_FORTUNE = "typo-route";
      resetAiRouteCache();

      const fortune = resolveAiRoute("BSKY_FORTUNE");
      assert.equal(fortune.route, "lite-flex", "既定にフォールバックする");
      assert.equal(fortune.model, LITE);
      assert.equal(fortune.source, "env-invalid");
      assert.equal(warnings.length, 1, "1回だけ警告する");
      assert.match(String(warnings[0][0]), /AI_ROUTE_BSKY_FORTUNE/);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("未知の機能キーでも throw せずフォールバックする（ビルド不整合の保険）", () => {
  // アプリの dist だけ新しくレジストリの dist が古い、という状態で起きる。
  // ここで throw すると generateContentWithRetry ごと落ち、呼び出し元の機能が丸ごと死ぬ
  // （例: biorhythm の generateStatus が失敗すると nextStepTime が永久に空になる）。
  withCleanEnv(() => {
    process.env.AI_TEXT_PROVIDER = "gemini";
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const resolved = resolveAiRoute("BSKY_BIORHYTHM_STATUS" as AiFeatureKey); // 改名前の旧キー
      assert.equal(resolved.route, "lite-flex");
      assert.equal(resolved.model, LITE);
      assert.equal(resolved.serviceTier, "flex");
      assert.equal(resolved.source, "unknown-feature");
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0][0]), /未知の機能キー/);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("botたん翻訳モデルは専用env→OLLAMA_MODEL→既定の三段で解決する", () => {
  withCleanEnv(() => {
    assert.equal(aiModel("OLLAMA_BOT_TRANSLATION"), DEFAULT_OLLAMA_TEXT_MODEL);

    process.env.OLLAMA_MODEL = "qwen3:8b";
    resetAiRouteCache();
    assert.equal(aiModel("OLLAMA_BOT_TRANSLATION"), "qwen3:8b", "OLLAMA_MODEL に落ちる");

    process.env.OLLAMA_BOT_TRANSLATION_MODEL = "gemma3:12b";
    resetAiRouteCache();
    assert.equal(aiModel("OLLAMA_BOT_TRANSLATION"), "gemma3:12b", "専用envが最優先");
  });
});

test("AI_GROUNDING_PROVIDER は searxng か off だけを受け付ける", () => {
  withCleanEnv(() => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      assert.equal(isAiGroundingEnabled(), true, "未設定なら自前SearXNGを使う");

      process.env.AI_GROUNDING_PROVIDER = "searxng";
      assert.equal(isAiGroundingEnabled(), true);

      process.env.AI_GROUNDING_PROVIDER = "off";
      assert.equal(isAiGroundingEnabled(), false);
      assert.equal(warnings.length, 0, "正常値でwarnしない");

      // 古い .env を持ってきたケース。落とさずに有効扱いへ倒すが、必ず知らせる。
      process.env.AI_GROUNDING_PROVIDER = "gemini";
      assert.equal(isAiGroundingEnabled(), true);
      assert.match(String(warnings.at(-1)?.[0]), /撤去済み/);

      process.env.AI_GROUNDING_PROVIDER = "typo";
      assert.equal(isAiGroundingEnabled(), true, "タイポで24時間動くbotを止めない");
      assert.match(String(warnings.at(-1)?.[0]), /無効/);
    } finally {
      console.warn = originalWarn;
    }
  });
});
