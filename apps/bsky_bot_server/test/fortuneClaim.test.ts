import assert from "node:assert/strict";
import test from "node:test";
import { claimedImageGenerator } from "../src/features/fortuneImage.js";

const image = { data: Buffer.from("x"), mimeType: "image/png", width: 8, height: 8 };

function harness(status: string, result: typeof image | null = image) {
  const calls = { generate: 0, released: [] as string[] };
  const generate = claimedImageGenerator(
    async () => {
      calls.generate++;
      return result;
    },
    {
      claim: async () => ({ status, day: "2026-09-16" }),
      release: async (day) => {
        calls.released.push(day);
      },
    },
    "test",
  );
  return { calls, generate };
}

test("枠を取れたら描く", async () => {
  const { calls, generate } = harness("claimed");
  assert.equal(await generate("題材"), image);
  assert.equal(calls.generate, 1);
  assert.deepEqual(calls.released, []);
});

test("枠が無ければ描かない（固定背景に戻る）", async () => {
  for (const status of ["service_limit", "disabled", "user_limit"]) {
    const { calls, generate } = harness(status);
    assert.equal(await generate("題材"), null, status);
    assert.equal(calls.generate, 0, status);
    assert.deepEqual(calls.released, [], status);
  }
});

test("描けなかったら枠を返す", async () => {
  const { calls, generate } = harness("claimed", null);
  assert.equal(await generate("題材"), null);
  assert.equal(calls.generate, 1);
  assert.deepEqual(calls.released, ["2026-09-16"]);
});
