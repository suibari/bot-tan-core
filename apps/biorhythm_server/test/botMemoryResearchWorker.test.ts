import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 調査ワーカーは startWorkerLoop 経由でしか回らないことを、ソースの形で固定する。
 *
 * 1回の調査は検索＋5ページ取得＋Ollama 要約で、間隔（60秒）を超えうる。素の setInterval や
 * tick の直接呼び出しを足されると、重なった分がそのまま Ollama への同時要求になる。
 * 動作テストでは DB と検索基盤が要るので、ここでは入口の形だけを見る。
 */
const source = readFileSync(
  new URL("../src/botMemoryResearchWorker.ts", import.meta.url),
  "utf8",
);
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("調査ワーカーは setInterval で直接回さない", () => {
  assert.doesNotMatch(code, /\bsetInterval\s*\(/);
  assert.match(code, /startWorkerLoop\(\{[\s\S]*?tick:\s*researchOnce/);
});

test("調査の tick は外から直接呼べない", () => {
  assert.doesNotMatch(code, /export\s+(async\s+)?function\s+researchOnce\b/);
  assert.doesNotMatch(code, /export\s*\{[^}]*\bresearchOnce\b/);
  // export しているのは起動関数だけ。
  assert.deepEqual(
    [...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((match) => match[1]),
    ["startBotMemoryResearchWorker"],
  );
});
