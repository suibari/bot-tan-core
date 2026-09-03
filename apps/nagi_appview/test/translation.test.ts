import assert from "node:assert/strict";
import test from "node:test";
import { ollamaTextContextLength } from "@bsky-affirmative-bot/shared-configs";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:testbot";

const {
  botTranslationPrompt,
  cachedTranslationResult,
  hasTranslationText,
  isNagiPostUri,
  normalizeSeedEntries,
  MAX_TRANSLATION_BATCH_SIZE,
  requestTranslationWithRetry,
  shouldPrewarmEnglish,
  shouldStartEnglishPrewarm,
  SingleFlight,
  startEnglishPrewarm,
  TRANSLATION_CACHE_VERSION,
  TranslationMissQuota,
  translatePosts,
  translationPrompt,
} = await import("../src/services/translation.js");

const validUri = "at://did:plc:example/com.suibari.nagi.post/3mtranslation";
const english = { code: "en", name: "English" } as any;
// 呼び出し回数の計上はダッシュボード向けの副作用なので、テストではDBへ触らせない。
const reportCall = () => {};

// Ollamaネイティブ /api/chat の応答形。OpenAI互換の choices[] ではない。
const successResponse = (text = "Translated text") =>
  new Response(JSON.stringify({ message: { content: text } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("rejects only empty translation output and leaves content judgment to the model", () => {
  assert.equal(hasTranslationText(""), false);
  assert.equal(hasTranslationText(" \n\t"), false);
  assert.equal(hasTranslationText("Excellent work!"), true);
  assert.equal(hasTranslationText("x".repeat(100_000)), true);
});

test("uses the TranslateGemma source/target prompt for posts by other users", () => {
  const prompt = translationPrompt(
    { code: "ja", name: "日本語" } as any,
    { code: "en", name: "English" } as any,
    "こんにちは",
  );
  assert.match(prompt, /日本語 \(ja\) to English \(en\) translator/);
  assert.ok(prompt.endsWith("English:\n\n\nこんにちは"));
  // 他人の投稿を botたん口調にすると発言の捏造になるので、ペルソナは絶対に混ぜない。
  assert.ok(!prompt.includes("Bot-tan"));
});

test("bot-authored posts get a voice-preserving prompt that forbids changing the content", () => {
  const prompt = botTranslationPrompt(
    { code: "en", name: "English" } as any,
    { code: "ja", name: "日本語" } as any,
    "Good morning!",
  );
  assert.match(prompt, /Bot-tan/);
  assert.match(prompt, /NEVER uses keigo/);
  assert.match(prompt, /from English \(en\) into 日本語 \(ja\)/);
  assert.match(prompt, /Do not add, remove, or invent any information/);
  assert.ok(prompt.endsWith("Post:\n\n\nGood morning!"));
});

test("prewarms only new supported non-English posts outside reconciliation", () => {
  assert.equal(shouldPrewarmEnglish(["ja"]), true);
  assert.equal(shouldPrewarmEnglish(["ja-JP"]), true);
  assert.equal(shouldPrewarmEnglish(["en"]), false);
  assert.equal(shouldPrewarmEnglish(["xx"]), false);
  assert.equal(shouldPrewarmEnglish(undefined), false);

  assert.equal(shouldStartEnglishPrewarm(false, false, ["ja"]), true);
  assert.equal(shouldStartEnglishPrewarm(true, false, ["ja"]), false);
  assert.equal(shouldStartEnglishPrewarm(false, true, ["ja"]), false);
  assert.equal(shouldStartEnglishPrewarm(false, false, ["en"]), false);
});

test("background prewarm failures do not propagate to the caller", async () => {
  let attempted = false;
  assert.doesNotThrow(() => {
    startEnglishPrewarm(validUri, async () => {
      attempted = true;
      throw new Error("temporary");
    });
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempted, true);
});

test("cache-only results mark misses without generating replacements", () => {
  const missingUri =
    "at://did:plc:example/com.suibari.nagi.post/3mtranslation-missing";
  assert.deepEqual(
    cachedTranslationResult(
      [validUri, missingUri],
      new Map([[validUri, "Cached translation"]]),
    ),
    {
      translations: [{ uri: validUri, text: "Cached translation" }],
      failures: [{ uri: missingUri, code: "not_cached" }],
    },
  );
});

test("cache hits consume no miss quota and the fixed window resets", () => {
  let now = 1_000;
  const quota = new TranslationMissQuota(2, 60_000, () => now);
  assert.equal(quota.take("client", 0), true);
  assert.equal(quota.take("client", 2), true);
  assert.equal(quota.take("client", 1), false);
  now += 60_000;
  assert.equal(quota.take("client", 1), true);
});

test("single-flight shares one task and removes failed requests for retry", async () => {
  const requests = new SingleFlight<string>();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = requests.run("same", async () => {
    calls += 1;
    await gate;
    return "translated";
  });
  const second = requests.run("same", async () => {
    calls += 1;
    return "duplicate";
  });
  assert.equal(first, second);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    "translated",
    "translated",
  ]);
  assert.equal(calls, 1);

  await assert.rejects(
    requests.run("retry", async () => {
      throw new Error("temporary");
    }),
  );
  assert.equal(
    await requests.run("retry", async () => "recovered"),
    "recovered",
  );
});

test("sends the requested model and temperature, defaulting to the shared Gemma 4 at 0", async () => {
  const model = "hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S";
  const bodies: any[] = [];
  const urls: string[] = [];
  const fetcher = (async (url: any, init: any) => {
    urls.push(String(url));
    bodies.push(JSON.parse(init.body));
    return successResponse();
  }) as any;
  await requestTranslationWithRetry("prompt", english, { fetcher, reportCall });
  await requestTranslationWithRetry("prompt", english, {
    fetcher,
    reportCall,
    model,
    temperature: 0.3,
  });
  assert.equal(bodies[0].model, model);
  assert.equal(bodies[0].options.temperature, 0);
  assert.equal(bodies[1].model, model);
  assert.equal(bodies[1].options.temperature, 0.3);
  // ネイティブ /api/chat を使い、思考を切る。OpenAI互換だと think を切れず、訳文の前に
  // reasoning を数百トークン吐いてレイテンシが倍増する。
  // num_ctx は送らない（サーバの OLLAMA_CONTEXT_LENGTH が唯一の源）。
  assert.ok(urls.every((url) => url.endsWith("/api/chat")), urls.join(", "));
  assert.equal(bodies[0].think, false);
  for (const body of bodies) {
    assert.ok(
      !("num_ctx" in body.options),
      "num_ctx はサーバ既定に任せる（送るとrunnerの作り直しを誘発する）",
    );
  }
  // num_predict を省くと Ollama 既定の -1（残りコンテキストまで）になり、プロンプトが
  // num_ctx を埋めた瞬間に訳文が数トークンで切れて、それが正常な訳として保存される。
  assert.equal(typeof bodies[0].options.num_predict, "number");
  assert.ok(bodies[0].options.num_predict > 0);
  assert.ok(
    bodies[0].options.num_predict <= ollamaTextContextLength(),
    "出力枠が num_ctx を超えてはいけない",
  );
});

test("rejects an over-long prompt instead of silently truncating the translation", async () => {
  // 黙って途中で切れた訳文を保存するより「翻訳できません」の方がよい（原文は必ず読める）。
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    requestTranslationWithRetry("あ".repeat(ollamaTextContextLength() * 2), english, {
      reportCall,
      fetcher: async () => {
        calls += 1;
        return successResponse();
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      log: () => undefined,
    }),
    /prompt_too_long/,
  );
  assert.equal(calls, 0, "予算超過はモデルを呼ぶ前に落とす");
  assert.deepEqual(sleeps, [], "retryable=false なので再試行しない");
});

test("retries once after a timeout without holding the retry delay", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = await requestTranslationWithRetry("prompt", english, {
    reportCall,
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw new DOMException("timed out", "TimeoutError");
      return successResponse();
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    log: () => undefined,
  });
  assert.equal(result, "Translated text");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1_000]);
});

test("retries once after a server error and succeeds", async () => {
  let calls = 0;
  const result = await requestTranslationWithRetry("prompt", english, {
    reportCall,
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? new Response("", { status: 503 })
        : successResponse();
    },
    sleep: async () => undefined,
    log: () => undefined,
  });
  assert.equal(result, "Translated text");
  assert.equal(calls, 2);
});

test("retries once after an empty response and succeeds", async () => {
  let calls = 0;
  const result = await requestTranslationWithRetry("prompt", english, {
    reportCall,
    fetcher: async () => {
      calls += 1;
      return successResponse(calls === 1 ? " \n" : "Translated text");
    },
    sleep: async () => undefined,
    log: () => undefined,
  });
  assert.equal(result, "Translated text");
  assert.equal(calls, 2);
});

test("returns failure after two temporary upstream errors", async () => {
  let calls = 0;
  await assert.rejects(
    requestTranslationWithRetry("prompt", english, {
      reportCall,
      fetcher: async () => {
        calls += 1;
        return new Response("", { status: 503 });
      },
      sleep: async () => undefined,
      log: () => undefined,
    }),
    (error: any) =>
      error.code === "upstream_unavailable" && error.reason === "http_503",
  );
  assert.equal(calls, 2);
});

test("does not retry a client error", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    requestTranslationWithRetry("prompt", english, {
      reportCall,
      fetcher: async () => {
        calls += 1;
        return new Response("", { status: 400 });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      log: () => undefined,
    }),
    (error: any) =>
      error.code === "upstream_unavailable" && error.reason === "http_400",
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("validates batch size, URI, and target language before database access", async () => {
  await assert.rejects(
    translatePosts(
      Array(MAX_TRANSLATION_BATCH_SIZE + 1).fill(validUri),
      "en",
      "client",
    ),
    (error: any) => error.status === 400 && error.error === "invalid_request",
  );
  await assert.rejects(
    translatePosts(["https://example.com/post"], "en", "client"),
    (error: any) => error.status === 400 && error.error === "invalid_request",
  );
  await assert.rejects(
    translatePosts([validUri], "xx-invalid", "client"),
    (error: any) => error.status === 400 && error.error === "invalid_request",
  );
});

test("new translation cache generation is version 4", () => {
  assert.equal(TRANSLATION_CACHE_VERSION, 4);
});

test("seed entries keep only supported languages with non-empty text", () => {
  assert.deepEqual(
    normalizeSeedEntries([
      { lang: "en", text: "Good morning!" },
      { lang: "EN-US", text: "duplicate" },
      { lang: "xx", text: "unsupported" },
      { lang: "ja", text: "   " },
      { lang: "ja", text: 42 },
      "not an object",
      null,
    ]),
    [{ lang: "en", text: "Good morning!" }],
  );
  assert.deepEqual(normalizeSeedEntries(undefined), []);
  assert.deepEqual(normalizeSeedEntries("en"), []);
});

test("only Nagi post URIs may be seeded", () => {
  assert.equal(isNagiPostUri(validUri), true);
  assert.equal(isNagiPostUri("at://did:plc:example/app.bsky.feed.post/3m"), false);
  assert.equal(isNagiPostUri("https://example.com/post"), false);
  assert.equal(isNagiPostUri(undefined), false);
});
