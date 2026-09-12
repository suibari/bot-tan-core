import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  generalizeInterestLabels,
  isNewsInterestGenre,
  MAX_LABELS_PER_CALL,
  NEWS_INTEREST_GENRES,
  normalizeInterestTopics,
} from "../src/ai/newsInterestTopics.js";

function withOllamaEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    base: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
  };
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  process.env.OLLAMA_MODEL = "local-test-model";
  return run().finally(() => {
    if (previous.base === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previous.model;
  });
}

test("ジャンル一覧に合致しない語は捨てる（固有名がそのまま検索へ漏れない）", () => {
  // これが緩むと作品名で NewsData を引くことになり、当たるのは公式発表と宣伝だけ、
  // 当たらない日は0件になる。一般化の要はここ。
  const out = normalizeInterestTopics(
    JSON.stringify({ topics: ["アニメ", "とある作品のタイトル", "ゲーム"] }),
    3,
  );
  assert.deepEqual(out, ["アニメ", null, "ゲーム"]);
});

test("件数が合わなくてもラベルとジャンルがずれない", () => {
  assert.deepEqual(normalizeInterestTopics(JSON.stringify({ topics: ["猫"] }), 3), ["猫", null, null]);
  assert.deepEqual(
    normalizeInterestTopics(JSON.stringify({ topics: ["猫", "猫", "猫"] }), 2),
    ["猫", "猫"],
  );
});

test("壊れた出力は全件 null になり例外を投げない", () => {
  assert.deepEqual(normalizeInterestTopics("not json", 2), [null, null]);
  assert.deepEqual(normalizeInterestTopics(JSON.stringify({ topics: "アニメ" }), 2), [null, null]);
  assert.deepEqual(normalizeInterestTopics(JSON.stringify({}), 1), [null]);
});

test("ジャンル名はそのまま検索語になる形で並んでいる", () => {
  assert.ok(NEWS_INTEREST_GENRES.length > 0);
  const seen = new Set<string>();
  for (const genre of NEWS_INTEREST_GENRES) {
    assert.ok(genre.trim(), "ジャンル名が空");
    assert.ok(!seen.has(genre), `ジャンルが重複: ${genre}`);
    seen.add(genre);
    // そのまま NewsData の q に入るので、1語で成立する短い言葉にしておく。
    assert.ok(genre.length <= 8, `${genre} は検索語として長すぎる`);
    assert.ok(!/[\s/・]/.test(genre), `${genre} は1語になっていない`);
    assert.ok(isNewsInterestGenre(genre));
  }
  assert.equal(isNewsInterestGenre("とある作品のタイトル"), false);
});

test("同じジャンルへ寄った印象語の重みを合算し、大きい順に返す", async () => {
  await withOllamaEnv(async () => {
    const calls: string[][] = [];
    const fetchMock = mock.method(globalThis, "fetch", async (_input: any, init: any) => {
      const body = JSON.parse(String(init.body));
      const labels = String(body.messages[1].content)
        .split("\n")
        .map((line: string) => line.replace(/^\d+\.\s*/, ""));
      calls.push(labels);
      // 作品名は属するジャンルへ。話題として成立しない語は null。
      const topics = labels.map((label) =>
        label.startsWith("作品")
          ? "アニメ"
          : label.startsWith("ゲームタイトル")
            ? "ゲーム"
            : null,
      );
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ topics }) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const out = await generalizeInterestLabels([
        { label: "作品タイトルA", weight: 3 },
        { label: "作品タイトルB", weight: 2 },
        { label: "ゲームタイトルC", weight: 4 },
        { label: "おはよう", weight: 9 },
      ]);
      assert.deepEqual(out, [
        { topic: "アニメ", score: 5, labelCount: 2 },
        { topic: "ゲーム", score: 4, labelCount: 1 },
      ]);
      assert.equal(calls.length, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("印象語が多いときは分割して呼ぶ", async () => {
  await withOllamaEnv(async () => {
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async (_input: any, init: any) => {
      calls++;
      const body = JSON.parse(String(init.body));
      const count = String(body.messages[1].content).split("\n").length;
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ topics: new Array(count).fill("猫") }) },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const labels = Array.from({ length: MAX_LABELS_PER_CALL + 5 }, (_, i) => ({
        label: `ラベル${i}`,
        weight: 1,
      }));
      const out = await generalizeInterestLabels(labels);
      assert.equal(calls, 2);
      assert.deepEqual(out, [
        { topic: "猫", score: MAX_LABELS_PER_CALL + 5, labelCount: MAX_LABELS_PER_CALL + 5 },
      ]);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("印象語が無ければ LLM を呼ばない", async () => {
  await withOllamaEnv(async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("should not be called");
    });
    try {
      assert.deepEqual(await generalizeInterestLabels([]), []);
      assert.deepEqual(await generalizeInterestLabels([{ label: "  ", weight: 3 }]), []);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
