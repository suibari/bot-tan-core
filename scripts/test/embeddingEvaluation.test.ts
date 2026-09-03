import assert from "node:assert/strict";
import test from "node:test";
import {
  ENCODERS,
  buildJudgeRequestBody,
  parseReview,
  type EvaluationResult,
} from "../evaluateEmbeddingModels.mts";

/**
 * AGENTS.md「Ollama の num_ctx」の実行時ガード。
 *
 * 評価スクリプトが本番と違う num_ctx を送ると、Ollama が同じモデルでも runner を
 * 作り直す。11GB の 26B が丸ごと読み直され、同居している別アプリまで巻き込む。
 * 「評価を回すだけでリロード地獄」を二度とやらないため、リクエスト本体を直接見る。
 */
test("LLM 採点のリクエストに num_ctx を入れず、num_predict は必ず送る", () => {
  const body = buildJudgeRequestBody("test-model", "採点してください", 256);

  assert.equal("num_ctx" in body.options, false);
  assert.equal(body.options.num_predict, 256);
  assert.equal(body.options.temperature, 0);
  // JSON.stringify した本体にも紛れ込んでいないこと（options 以外の階層も含めて確認）。
  assert.equal(/num_ctx/.test(JSON.stringify(body)), false);
});

test("LLM 採点は think を切り、scores 配列を強制する", () => {
  const body = buildJudgeRequestBody("test-model", "採点してください", 8);

  // think を切らないと reasoning が生成枠を食い、scores が空のまま返る。
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.format.required, ["scores"]);
  assert.equal(body.format.properties.scores.items.type, "integer");
});

/**
 * ruri-v3 は接頭辞が必須で、付けないと性能が出ない。ここが抜けると
 * 「ruri が弱い」ではなく「使い方が間違っている」結果を出してしまう。
 */
test("接頭辞が要るエンコーダに接頭辞が設定されている", () => {
  const ruri = ENCODERS.find((e) => e.id === "ruri310");
  assert.ok(ruri);
  assert.equal(ruri.queryPrefix, "検索クエリ: ");
  assert.equal(ruri.docPrefix, "検索文書: ");

  const e5 = ENCODERS.find((e) => e.id === "e5-large");
  assert.ok(e5);
  assert.equal(e5.queryPrefix, "query: ");
  assert.equal(e5.docPrefix, "passage: ");

  // 現行本番の再現アームが使う arctic は接頭辞なし（hybridSearch.ts の既定と同じ）。
  const arctic = ENCODERS.find((e) => e.id === "arctic");
  assert.ok(arctic);
  assert.equal(arctic.queryPrefix, "");
  assert.equal(arctic.docPrefix, "");
});

test("エンコーダ id が重複していない", () => {
  const ids = ENCODERS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

const resultFixture = (): EvaluationResult =>
  ({
    generatedAt: "2026-09-04T00:00:00.000Z",
    source: "posts",
    corpusSize: 3,
    corpusHash: "deadbeef",
    judgeModel: "test-model",
    arms: [],
    queries: [{ id: "walpurgis", category: "proper-noun", text: "ワルプルギス" }],
    rankings: {},
    pool: {
      walpurgis: [
        { key: "q01-d01", docId: "at://a/1", text: "まどマギ見た" },
        { key: "q01-d02", docId: "at://a/2", text: "今日は雨" },
      ],
    },
    judgments: { llm: { walpurgis: { "at://a/1": 1, "at://a/2": 1 } } },
    encoderLatencyMs: {},
  }) as EvaluationResult;

test("review.md の判定列を読み戻して docId へ対応づける", () => {
  const markdown = [
    "| key | 判定 | LLM | 本文 |",
    "| --- | --- | --- | --- |",
    "| q01-d01 | 2 | 1 | まどマギ見た |",
    "| q01-d02 | 0 | 1 | 今日は雨 |",
  ].join("\n");

  const judgments = parseReview(markdown, resultFixture());

  assert.deepEqual(judgments, { walpurgis: { "at://a/1": 2, "at://a/2": 0 } });
});

test("未知の key と見出し行は無視する", () => {
  const markdown = [
    "| key | 判定 | LLM | 本文 |",
    "| --- | --- | --- | --- |",
    "| q09-d99 | 2 | 1 | 存在しない候補 |",
    "| q01-d01 | 1 | 1 | まどマギ見た |",
  ].join("\n");

  const judgments = parseReview(markdown, resultFixture());

  assert.deepEqual(judgments, { walpurgis: { "at://a/1": 1 } });
});
