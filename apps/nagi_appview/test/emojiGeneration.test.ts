import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_APPVIEW_DID ??= "did:web:localhost";
process.env.NAGI_BOT_DID ??= "did:plc:testbot";

const { HourlyWindow, drawCandidate, ollamaFullyOnGpu, recoveryBlocked } = await import(
  "../src/services/emojiGeneration.js"
);

test("ollamaFullyOnGpu waits for every model to be fully on the GPU", () => {
  const gemma = { size: 7_444_994_456, size_vram: 7_444_994_456 };
  assert.equal(ollamaFullyOnGpu({ models: [gemma] }), true);
  // 2026-10-28 10:42 の状態（49層中11層）
  assert.equal(ollamaFullyOnGpu({ models: [{ size: 7_609_114_405, size_vram: 2_287_426_600 }] }), false);
  assert.equal(ollamaFullyOnGpu({ models: [gemma, { size: 100, size_vram: 50 }] }), false);
  // OOM で降ろされた直後。ここで ComfyUI を立てると読み直しが一部しか載らない
  assert.equal(ollamaFullyOnGpu({ models: [] }), false);
  assert.equal(ollamaFullyOnGpu(undefined), false);
});

test("recoveryBlocked reads the ollama-placement heartbeat", () => {
  assert.equal(recoveryBlocked({ recovery: "blocked" }), true);
  assert.equal(recoveryBlocked({ recovery: "cooldown" }), false);
  assert.equal(recoveryBlocked(undefined), false);
});

test("HourlyWindow is a global sliding window", () => {
  const w = new HourlyWindow(2);
  w.add(0);
  w.add(1_000);
  assert.equal(w.full(2_000), true);
  assert.equal(w.full(60 * 60_000 + 1), false);
});

const params = {
  plan: { name: "sorena", description: "それな", subject: "Lettering of それな.", lettering: "それな", aspect: "wide" as const, outfit: "none" as const },
  style: 0,
  prompt: "それな",
};
const result = (key: "magenta" | "green", conflict: number, empty = false) => ({
  image: `img-${key}`,
  width: 128,
  height: 68,
  key,
  conflict,
  empty,
});

test("drawCandidate keeps the first key when the cutout is clean", async () => {
  const calls: string[] = [];
  const candidate = await drawCandidate(
    { generate: async (request, key) => (calls.push(key), assert.match(request.prompt, /#FF00FF/), result(key, 0.002)) },
    params,
  );
  assert.deepEqual(calls, ["magenta"]);
  assert.equal(candidate.key, "magenta");
});

test("drawCandidate redraws once with the other key on conflict", async () => {
  const calls: string[] = [];
  const candidate = await drawCandidate(
    { generate: async (_r, key) => (calls.push(key), result(key, key === "magenta" ? 0.418 : 0)) },
    params,
  );
  assert.deepEqual(calls, ["magenta", "green"]);
  assert.equal(candidate.image, "img-green");
});

test("drawCandidate keeps the better one when both conflict", async () => {
  const candidate = await drawCandidate(
    { generate: async (_r, key) => result(key, key === "magenta" ? 0.1 : 0.3) },
    params,
  );
  assert.equal(candidate.key, "magenta");
});

test("drawCandidate starts green for pink subjects and fails when nothing is left", async () => {
  const calls: string[] = [];
  await assert.rejects(
    drawCandidate(
      { generate: async (_r, key) => (calls.push(key), result(key, 0, true)) },
      { ...params, prompt: "ピンクのそれな" },
    ),
  );
  assert.deepEqual(calls, ["green", "magenta"]);
});
