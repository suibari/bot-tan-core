import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  OllamaContextOverflowError,
  fitOllamaMessages,
  generateOllamaContent,
  normalizeJsonSchema,
  toOllamaMessages,
} from "../src/ai/generationClient.js";
import {
  groundingPolicyForFeature,
  prepareOllamaGrounding,
  seasonalWorksQueries,
} from "../src/ai/grounding.js";
import {
  estimateMessagesTokens,
  ollamaPromptBudget,
  ollamaTextContextLength,
} from "@bsky-affirmative-bot/shared-configs";

/**
 * `/api/chat` を1回だけ捕まえるヘルパ。応答の中身はテストごとに差し替える。
 * env の退避と restore を毎回書くと本題が埋もれるのでここへ寄せる。
 */
async function captureOllamaRequest(
  params: any,
  responseBody: Record<string, unknown> = {},
): Promise<{ body: any; response: any }> {
  const saved = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  let body: any;
  const fetchMock = mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        model: "local-test",
        message: { content: "ふふ、そうなんだね！" },
        prompt_eval_count: 100,
        eval_count: 20,
        ...responseBody,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  try {
    const response = await generateOllamaContent(params);
    return { body, response };
  } finally {
    fetchMock.mock.restore();
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
}

test("Gemini形式のsystem・履歴・画像をOllama chatへ変換する", () => {
  assert.deepEqual(
    toOllamaMessages({
      config: { systemInstruction: "persona" },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] },
        {
          role: "user",
          parts: [{ text: "look" }, { inlineData: { data: "BASE64", mimeType: "image/png" } }],
        },
      ],
    }),
    [
      { role: "system", content: "persona" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "look", images: ["BASE64"] },
    ],
  );
});

test("Google Type enumをOllama用JSON Schemaへ正規化する", () => {
  assert.deepEqual(
    normalizeJsonSchema({
      type: "OBJECT",
      properties: { values: { type: "ARRAY", items: { type: "STRING" } } },
      propertyOrdering: ["values"],
    }),
    {
      type: "object",
      properties: { values: { type: "array", items: { type: "string" } } },
    },
  );
});

test("function declarationをschema出力へ変換しfunctionCalls互換で返す", async () => {
  const saved = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  let requestBody: any;
  const fetchMock = mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: "local-test",
      message: { content: '{"title":"朝のお散歩"}' },
      prompt_eval_count: 10,
      eval_count: 5,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const response = await generateOllamaContent({
      model: "local-test",
      contents: ["plan"],
      config: {
        tools: [{
          functionDeclarations: [{
            name: "compose",
            parameters: {
              type: "OBJECT",
              properties: { title: { type: "STRING" } },
              required: ["title"],
            },
          }],
        }],
      },
    });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(requestBody.format.type, "object");
    assert.equal(requestBody.format.properties.title.type, "string");
    assert.deepEqual(response.functionCalls, [
      { name: "compose", args: { title: "朝のお散歩" } },
    ]);
  } finally {
    fetchMock.mock.restore();
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
});

test("groundingポリシーは用途ごとに分離される", () => {
  // リプライ系は同期パスで検索しない（非同期ワーカーへ回す）。
  assert.equal(groundingPolicyForFeature("BSKY_CONVERSATION"), "deferred");
  assert.equal(groundingPolicyForFeature("BSKY_AFFIRMATIVE_REPLY"), "deferred");
  // バッチ系はレイテンシに影響しないので同期で検索してよい。
  assert.equal(groundingPolicyForFeature("BIORHYTHM_SEASONAL_WORKS"), "required");
  assert.equal(groundingPolicyForFeature("NEWS_POSITIVE_COMMENT"), "preferred");
  assert.equal(groundingPolicyForFeature("BSKY_BOT_DIARY"), "off");
});

test("リプライ系は同期パスでplannerも検索も呼ばない", async () => {
  // これが今回のレイテンシ改善の本体。ローカル推論を本生成の1回に抑えるため、
  // ここで plan / research が呼ばれたら回帰。
  let planCalls = 0;
  let researchCalls = 0;
  const result = await prepareOllamaGrounding(
    "BSKY_AFFIRMATIVE_REPLY",
    {
      model: "local-test",
      contents: [{ role: "user", parts: [{ text: "最新のアニメ何かある？" }] }],
      config: { tools: [{ googleSearch: {} }, { urlContext: {} }] },
    },
    {
      plan: async () => {
        planCalls++;
        return { needed: true, queries: ["x"], urls: [] };
      },
      research: async () => {
        researchCalls++;
        return "使われないはず";
      },
    },
  );
  assert.equal(planCalls, 0, "同期パスで planner を呼んではいけない");
  assert.equal(researchCalls, 0, "同期パスで検索してはいけない");
  // 黙って素通りさせず、「知らないなら知らないと言う」ことは伝える。
  assert.match(JSON.stringify(result.contents), /do not know something, say so/);
  assert.doesNotMatch(JSON.stringify(result.config), /googleSearch|urlContext/);
});

test("調査へはplannerが作った検索語とURLだけを渡す", async () => {
  // 宛先が Gemini から自宅 SearXNG に変わってもこの契約は変えない。
  const saved = process.env.AI_GROUNDING_PROVIDER;
  process.env.AI_GROUNDING_PROVIDER = "searxng";
  const sensitive = "did:plc:secret-user 会話履歴の秘密 https://example.com/post";
  let researchInput: { queries: string[]; urls: string[] } | undefined;
  try {
    const result = await prepareOllamaGrounding(
      "NEWS_POSITIVE_COMMENT",
      {
        model: "local-test",
        contents: [{ role: "user", parts: [{ text: sensitive }] }],
        config: { tools: [{ googleSearch: {} }, { urlContext: {} }] },
      },
      {
        plan: async (_model, subject) => {
          assert.equal(subject, sensitive, "生入力を見るのはローカルplannerだけ");
          return {
            needed: true,
            queries: ["対象トピック 最新情報"],
            urls: ["https://example.com/post"],
          };
        },
        research: async (input) => {
          researchInput = input;
          return "確認済みの中立な事実 https://source.example/";
        },
      },
    );
    assert.deepEqual(researchInput, {
      queries: ["対象トピック 最新情報"],
      urls: ["https://example.com/post"],
    });
    assert.doesNotMatch(JSON.stringify(researchInput), /secret-user|会話履歴の秘密/);
    assert.doesNotMatch(JSON.stringify(result.config), /googleSearch|urlContext/);
    assert.match(JSON.stringify(result.contents), /grounding_research/);
  } finally {
    if (saved === undefined) delete process.env.AI_GROUNDING_PROVIDER;
    else process.env.AI_GROUNDING_PROVIDER = saved;
  }
});

test("検索必須機能はgrounding失敗を握り潰さない", async () => {
  await assert.rejects(
    prepareOllamaGrounding(
      "BIORHYTHM_SEASONAL_WORKS",
      {
        model: "local-test",
        contents: ["今期作品"],
        config: { tools: [{ googleSearch: {} }] },
      },
      {
        plan: async () => ({ needed: true, queries: ["今期 作品"], urls: [] }),
        research: async () => { throw new Error("grounding down"); },
      },
    ),
    /grounding down/,
  );
});

test("季節作品はplannerが空でも匿名の定型検索へフォールバックする", async () => {
  let input: { queries: string[]; urls: string[] } | undefined;
  await prepareOllamaGrounding(
    "BIORHYTHM_SEASONAL_WORKS",
    {
      model: "local-test",
      contents: ["今期作品"],
      config: { tools: [{ googleSearch: {} }] },
    },
    {
      plan: async () => ({ needed: true, queries: [], urls: [] }),
      research: async (value) => {
        input = value;
        return "verified";
      },
    },
  );
  // 入力文（"今期作品"）は検索側へ渡らず、サーバー管理の定型検索に置き換わる。
  assert.deepEqual(input?.queries, seasonalWorksQueries());
  assert.ok(input?.queries.length);
});

test("定型検索はトピック語で始まり、年が末尾に来る", () => {
  // SearXNG(Bing) の実測結果に基づく。年を先頭に置くと「2026年カレンダー」の
  // 配布サイトばかりが返り、作品名がゼロになる。相対語で始めても辞書ページに落ちる。
  const queries = seasonalWorksQueries(new Date(2026, 8, 1));
  assert.ok(queries.includes("夏アニメ 2026"), queries.join(" / "));
  for (const query of queries) {
    assert.match(query, /\s20\d{2}$/, `年が末尾にない: ${query}`);
    assert.doesNotMatch(query, /^20\d{2}/, `年で始めてはいけない: ${query}`);
    assert.doesNotMatch(query, /^(今|現在|最近|今期|latest|recent)/, query);
    // 「ヒット曲」は株式会社ヒットに食われる。実測で確認済みの禁止語。
    assert.doesNotMatch(query, /ヒット曲/, query);
  }
});

test("定型検索の季節は月から決まる", () => {
  const at = (month: number) => seasonalWorksQueries(new Date(2026, month - 1, 15))[0];
  assert.equal(at(2), "冬アニメ 2026");
  assert.equal(at(5), "春アニメ 2026");
  assert.equal(at(8), "夏アニメ 2026");
  assert.equal(at(11), "秋アニメ 2026");
});

test("maxOutputTokens未指定でもnum_predictが必ず入る", async () => {
  // これが無いと Ollama 既定の -1（残りコンテキストまで）になり、プロンプトが num_ctx を
  // 埋めた瞬間に生成余地が数トークンになる。2026-08-31 の「返信が表示名だけ」の直接原因。
  const { body } = await captureOllamaRequest({
    model: "local-test",
    contents: [{ role: "user", parts: [{ text: "こんにちは" }] }],
    config: { systemInstruction: "persona" },
  });
  assert.equal(typeof body.options.num_predict, "number");
  assert.ok(body.options.num_predict > 0);
  // num_ctx は送らない（サーバの OLLAMA_CONTEXT_LENGTH が唯一の源）。
  // ollamaTextContextLength() はプロンプト予算の計算にだけ使う。
  assert.ok(
    !("num_ctx" in body.options),
    "num_ctx はサーバ既定に任せる（送るとrunnerの作り直しを誘発する）",
  );
});

test("maxOutputTokensを明示した場合はその値をnum_predictへ渡す", async () => {
  const { body } = await captureOllamaRequest({
    model: "local-test",
    contents: ["判定して"],
    config: { maxOutputTokens: 256 },
  });
  assert.equal(body.options.num_predict, 256);
});

test("巨大な履歴はsystemと最後の入力を残して中間だけ落とす", async () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "model",
    parts: [{ text: `${index}番目の発言。` + "あ".repeat(5_000) }],
  }));
  const { body, response } = await captureOllamaRequest({
    model: "local-test",
    contents: [...history, { role: "user", parts: [{ text: "いまの気持ちを聞かせて" }] }],
    config: { systemInstruction: "ペルソナ設定".repeat(100) },
  });

  assert.equal(body.messages[0].role, "system", "ペルソナは絶対に落とさない");
  assert.match(body.messages[0].content, /ペルソナ設定/);
  assert.equal(
    body.messages.at(-1).content,
    "いまの気持ちを聞かせて",
    "今回の入力は絶対に落とさない",
  );
  assert.ok(body.messages.length < history.length, "中間の履歴は落ちている");
  assert.ok(response.ollamaMetadata.trimmed.droppedTurns > 0);
  assert.ok(!response.ollamaMetadata.trimmed.truncatedInput, "入力まで切る必要はないはず");

  const budget = ollamaPromptBudget({
    numCtx: ollamaTextContextLength(),
    outputTokens: body.options.num_predict,
  });
  assert.ok(estimateMessagesTokens(body.messages) <= budget);
});

test("履歴を落としきっても溢れるならgrounding調査ブロックを縮める", () => {
  const research = "調査結果。".repeat(4_000);
  const { messages, trim } = fitOllamaMessages(
    [
      { role: "system", content: "ペルソナ" },
      {
        role: "user",
        content: `質問\n\n<grounding_research>\n${research}\n</grounding_research>\n注記`,
      },
    ],
    { budget: 2_000 },
  );
  assert.equal(trim.groundingShrunk, true);
  assert.ok(!messages.at(-1)!.content.includes(research));
  assert.match(messages[0].content, /ペルソナ/);
});

test("予算内に収まっているときは何も削らない", () => {
  const original = [
    { role: "system" as const, content: "ペルソナ" },
    { role: "user" as const, content: "こんにちは" },
  ];
  const { messages, trim } = fitOllamaMessages(original, { budget: 10_000 });
  assert.deepEqual(messages, original);
  assert.equal(trim.droppedTurns, 0);
  assert.equal(trim.truncatedInput, false);
});

test("トリムは呼び出し側のメッセージ配列を壊さない", () => {
  // 履歴は会話記録として conv_history へ保存されるので、破壊すると記憶が欠ける。
  const original = [
    { role: "system" as const, content: "ペルソナ" },
    { role: "user" as const, content: "あ".repeat(10_000) },
    { role: "assistant" as const, content: "い".repeat(10_000) },
    { role: "user" as const, content: "今回の入力" },
  ];
  const snapshot = JSON.parse(JSON.stringify(original));
  fitOllamaMessages(original, { budget: 500 });
  assert.deepEqual(original, snapshot);
});

test("done_reasonがlengthなら切り詰めとして報告する", async () => {
  const { response } = await captureOllamaRequest(
    { model: "local-test", contents: ["ねえねえ"], config: {} },
    { done_reason: "length" },
  );
  assert.equal(response.ollamaMetadata.truncated, true);
});

test("プロンプトがnum_ctxを埋めた応答は投稿させず例外にする", async () => {
  await assert.rejects(
    captureOllamaRequest(
      { model: "local-test", contents: ["ねえねえ"], config: {} },
      { prompt_eval_count: ollamaTextContextLength() - 5 },
    ),
    OllamaContextOverflowError,
  );
});

test("SYSTEM_INSTRUCTION・巨大履歴・grounding8000字が同時に来ても予算を超えない", async () => {
  // 2026-08-31 の事故そのものの回帰テスト。
  const { SYSTEM_INSTRUCTION } = await import("@bsky-affirmative-bot/shared-configs");
  const history = Array.from({ length: 100 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "model",
    parts: [{ text: `${index}: ` + "会話の記録。".repeat(50) }],
  }));
  const { body } = await captureOllamaRequest({
    model: "local-test",
    contents: [
      ...history,
      {
        role: "user",
        parts: [
          {
            text:
              "ユーザ名: Lisya Myata 🦊\nメッセージ: それ、私です =w=" +
              `\n\n<grounding_research>\n${"調査。".repeat(2_700)}\n</grounding_research>`,
          },
          { inlineData: { data: "BASE64", mimeType: "image/png" } },
        ],
      },
    ],
    config: { systemInstruction: SYSTEM_INSTRUCTION },
  });

  const budget = ollamaPromptBudget({
    numCtx: ollamaTextContextLength(),
    outputTokens: body.options.num_predict,
  });
  assert.ok(
    estimateMessagesTokens(body.messages) <= budget,
    `見積もり ${estimateMessagesTokens(body.messages)} が予算 ${budget} を超えている`,
  );
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages.at(-1).content, /それ、私です/);
});
