import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
const { db } = await import("../src/db.js");
const {
  flushPolaritySamples,
  polaritySampleHash,
  polaritySampleRate,
  recordPolaritySample,
  resetPolaritySamplesForTest,
} = await import("../src/polaritySamples.js");

const sample = (text: string) => ({
  text,
  languageName: "日本語",
  label: "positive" as const,
  labelVersion: "three-way-v1",
});

const withEnv = async (values: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPolaritySamplesForTest();
  }
};

test("積む割合は未設定で全件、0 で停止、壊れた値は全件に倒す", async () => {
  await withEnv({ POLARITY_SAMPLE_RATE: undefined }, async () => assert.equal(polaritySampleRate(), 1));
  await withEnv({ POLARITY_SAMPLE_RATE: "0" }, async () => assert.equal(polaritySampleRate(), 0));
  await withEnv({ POLARITY_SAMPLE_RATE: "0.25" }, async () => assert.equal(polaritySampleRate(), 0.25));
  await withEnv({ POLARITY_SAMPLE_RATE: "abc" }, async () => assert.equal(polaritySampleRate(), 1));
});

test("本文の前後の空白はハッシュに影響しない", () => {
  assert.equal(polaritySampleHash(" うれしい "), polaritySampleHash("うれしい"));
  assert.notEqual(polaritySampleHash("うれしい"), polaritySampleHash("かなしい"));
});

test("埋め込みとラベルだけを保存し、本文は保存しない", async (t) => {
  await withEnv(
    { OLLAMA_EMBED_BASE_URL: "http://embed.test/v1", POLARITY_SAMPLE_RATE: undefined },
    async () => {
      const requests: Array<{ input: string[] }> = [];
      t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { input: string[] };
        requests.push(body);
        return new Response(
          JSON.stringify({ data: body.input.map(() => ({ embedding: Array(1024).fill(0.5) })) }),
          { status: 200 },
        );
      });
      const saved: Array<Record<string, unknown>> = [];
      t.mock.method(db, "insert", () => ({
        values: (rows: Array<Record<string, unknown>>) => ({
          onConflictDoNothing: async () => { saved.push(...rows); },
        }),
      }));

      recordPolaritySample(sample(" 最高の一日だった "));
      recordPolaritySample(sample("   "));
      await flushPolaritySamples();

      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].input, ["最高の一日だった"]);
      assert.equal(saved.length, 1);
      const row = saved[0];
      assert.equal(row.label, "positive");
      assert.equal(row.label_version, "three-way-v1");
      assert.equal(row.text_chars, 8);
      assert.equal(row.content_hash, polaritySampleHash("最高の一日だった"));
      assert.equal((row.embedding as number[]).length, 1024);
      assert.ok(!Object.values(row).includes("最高の一日だった"));
    },
  );
});

test("16件たまったら待たずに1回で送る", async (t) => {
  await withEnv({ OLLAMA_EMBED_BASE_URL: "http://embed.test/v1", POLARITY_SAMPLE_RATE: undefined }, async () => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
      calls++;
      const body = JSON.parse(init.body) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map(() => ({ embedding: Array(1024).fill(0) })) }),
        { status: 200 },
      );
    });
    let saved = 0;
    t.mock.method(db, "insert", () => ({
      values: (rows: unknown[]) => ({ onConflictDoNothing: async () => { saved += rows.length; } }),
    }));
    for (let i = 0; i < 16; i++) recordPolaritySample(sample(`投稿${i}`));
    await flushPolaritySamples();
    assert.equal(calls, 1);
    assert.equal(saved, 16);
  });
});

test("割合 0 では積まず、埋め込みが失敗しても例外を外へ出さない", async (t) => {
  await withEnv({ OLLAMA_EMBED_BASE_URL: "http://embed.test/v1", POLARITY_SAMPLE_RATE: "0" }, async () => {
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
    recordPolaritySample(sample("止めているので送らない"));
    await flushPolaritySamples();
    assert.equal(fetch.mock.callCount(), 0);
  });
  await withEnv({ OLLAMA_EMBED_BASE_URL: "http://embed.test/v1", POLARITY_SAMPLE_RATE: undefined }, async () => {
    const error = console.error;
    console.error = () => {};
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
    const insert = t.mock.method(db, "insert", () => { throw new Error("must not save"); });
    try {
      recordPolaritySample(sample("落ちても返信は止めない"));
      await flushPolaritySamples();
      assert.equal(insert.mock.callCount(), 0);
    } finally {
      console.error = error;
    }
  });
});
