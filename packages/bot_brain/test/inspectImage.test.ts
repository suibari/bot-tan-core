import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { inspectGeneratedImage, judgeImageInspection } from "../src/ai/inspectImage.js";
import { generateImage } from "../src/ai/generateImage.js";

const arm = (shoulder: string, hand: string) => ({
  visible: true,
  shoulder_side: shoulder,
  hand_side: hand,
  crosses_body: shoulder !== hand,
  occluded_by: "nothing",
});
const clean = { right_arm: arm("viewer_right", "viewer_right"), left_arm: arm("viewer_left", "viewer_left"), arm_count: 2, verdict: "ok" };
// 2026-10-01 に投稿された絵を本番の gemma が読んだ結果そのまま。
const swapped = { right_arm: arm("viewer_right", "viewer_left"), left_arm: arm("viewer_left", "viewer_left"), arm_count: 2, verdict: "wrong" };

test("腕の付き方が正しければ合格", () => {
  assert.deepEqual(judgeImageInspection(clean), { ok: true });
});

test("腕の左右逆は不合格で、どの腕かを理由に残す", () => {
  const result = judgeImageInspection(swapped);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reasons[0] : "", /right_arm: viewer_right -> viewer_left/);
});

test("人物が2人いて腕を4本と数えても、verdict が ok なら落とさない", () => {
  assert.equal(judgeImageInspection({ ...clean, arm_count: 4 }).ok, true);
});

test("形の壊れた結果は不合格に倒す", () => {
  for (const parsed of [null, {}, { ...clean, verdict: "maybe" }]) {
    assert.equal(judgeImageInspection(parsed).ok, false);
  }
});

const ENV_KEYS = ["OLLAMA_BASE_URL", "OLLAMA_MODEL", "IMAGEGEN_BASE_URL", "IMAGEGEN_INSPECT", "IMAGEGEN_INSPECT_REDRAWS", "AI_ROUTE_BSKY_IMAGE"];

function withEnv(t: TestContext, env: Record<string, string | undefined>): void {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const png = createCanvas(64, 64).toBuffer("image/png");
const image = { data: png, mimeType: "image/png", width: 64, height: 64 };
const ollamaReply = (content: unknown) =>
  new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }));

test("検査は整形した画像を送り、num_ctx を送らず temperature を載せる。失敗は不合格", async (t) => {
  withEnv(t, { OLLAMA_BASE_URL: "http://ollama.test:11434/v1", OLLAMA_MODEL: "test-model" });
  let body: any;
  let fail = false;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    if (fail) throw new Error("ollama down");
    return ollamaReply(clean);
  });

  assert.deepEqual(await inspectGeneratedImage(image), { ok: true });
  // 腕の繋がりは全体を見ないと分からないので、タイルは送らず全体像1枚だけ。
  assert.equal(body.messages[1].images.length, 1);
  assert.notEqual(body.messages[1].images[0], png.toString("base64"));
  assert.equal("num_ctx" in body.options, false);
  assert.equal(typeof body.options.temperature, "number");
  assert.equal(typeof body.options.num_predict, "number");

  fail = true;
  const failed = await inspectGeneratedImage(image);
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.inspectionFailed, true);
});

test("IMAGEGEN_INSPECT=0 なら検査しない", async (t) => {
  withEnv(t, { OLLAMA_BASE_URL: "http://ollama.test:11434/v1", OLLAMA_MODEL: "test-model", IMAGEGEN_INSPECT: "0" });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });
  assert.equal((await inspectGeneratedImage(image)).ok, true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

/** シーン変換・生成サイドカー・検査を URL と system プロンプトで振り分ける。 */
function mockPipeline(t: TestContext, inspections: unknown[]) {
  const counts = { generate: 0, inspect: 0 };
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    if (String(url).endsWith("/generate")) {
      counts.generate++;
      return new Response(JSON.stringify({ image_b64: png.toString("base64"), mime_type: "image/png", width: 64, height: 64 }));
    }
    const body = JSON.parse(init.body);
    if (String(body.messages[0].content).includes("arms attached to the wrong side")) {
      const result = inspections[counts.inspect++];
      if (result instanceof Error) throw result;
      return ollamaReply(result);
    }
    return ollamaReply({
      pose: ["sitting"],
      expression: ["smile"],
      action: ["reading book"],
      setting: ["indoors", "living room"],
      objects: ["book", "cup"],
      companions: [],
      framing: "upper-body",
      outdoor: false,
    });
  });
  return counts;
}

const pipelineEnv = {
  OLLAMA_BASE_URL: "http://ollama.test:11434/v1",
  OLLAMA_MODEL: "test-model",
  IMAGEGEN_BASE_URL: "http://imagegen.test:7998",
};

test("不合格なら描き直し、通った絵を返す", async (t) => {
  withEnv(t, pipelineEnv);
  const counts = mockPipeline(t, [swapped, clean]);
  assert.ok(await generateImage("今日は本を読んだよ"));
  assert.deepEqual(counts, { generate: 2, inspect: 2 });
});

test("描き直しても通らなければ絵を添えない", async (t) => {
  withEnv(t, pipelineEnv);
  const counts = mockPipeline(t, [swapped, swapped]);
  assert.equal(await generateImage("今日は本を読んだよ"), null);
  assert.deepEqual(counts, { generate: 2, inspect: 2 });
});

test("検査そのものが落ちたら描き直さず、絵も添えない", async (t) => {
  withEnv(t, pipelineEnv);
  const counts = mockPipeline(t, [new Error("ollama down")]);
  assert.equal(await generateImage("今日は本を読んだよ"), null);
  assert.deepEqual(counts, { generate: 1, inspect: 1 });
});
