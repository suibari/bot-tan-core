import assert from "node:assert/strict";
import test from "node:test";
import { resetAiRouteCache } from "@bsky-affirmative-bot/shared-configs";
import {
  KNOWN_EMBEDDING_MODELS,
  embeddingProfile,
  resetEmbeddingProfileWarnings,
} from "../src/embeddingProfiles.js";

const originalModel = process.env.OLLAMA_EMBED_MODEL;
const restore = () => {
  if (originalModel === undefined) delete process.env.OLLAMA_EMBED_MODEL;
  else process.env.OLLAMA_EMBED_MODEL = originalModel;
  resetAiRouteCache();
  resetEmbeddingProfileWarnings();
};
const withModel = <T>(model: string, fn: () => T): T => {
  process.env.OLLAMA_EMBED_MODEL = model;
  resetAiRouteCache();
  resetEmbeddingProfileWarnings();
  try {
    return fn();
  } finally {
    restore();
  }
};

test("モデルを変えると接頭辞としきい値が一括で切り替わる", () => {
  // これがテーブル化の目的。env に散らしていた頃は片方だけ変えられてしまい、
  // 「接頭辞は効かない」という誤った結論がコードに残る事故が起きた。
  const qwen = withModel("qwen3-embedding:0.6b", embeddingProfile);
  const arctic = withModel("snowflake-arctic-embed2", embeddingProfile);

  assert.match(qwen.queryPrefix, /^Instruct: /);
  assert.equal(arctic.queryPrefix, "query: ");
  assert.notEqual(qwen.semDistMax, arctic.semDistMax);
  assert.notEqual(qwen.semRelMargin, arctic.semRelMargin);
  assert.notEqual(qwen.actorDistMax, arctic.actorDistMax);
});

test("接頭辞ありのモデルはしきい値も大きい（距離スケールが押し上がるため）", () => {
  // arctic は接頭辞で距離が約 +0.19 上がる。しきい値を据え置くと上位ヒットを
  // 絶対ガードが切り落とす（実測で top-10 の 162/270 が消えた）。
  const arctic = withModel("snowflake-arctic-embed2", embeddingProfile);
  const qwen = withModel("qwen3-embedding:0.6b", embeddingProfile);
  assert.ok(arctic.semDistMax > qwen.semDistMax);
});

test("プロフィール用しきい値は投稿用より緩い", () => {
  // displayName + description + 分析の短文なので距離が出やすい。
  for (const model of KNOWN_EMBEDDING_MODELS) {
    const p = withModel(model, embeddingProfile);
    assert.ok(p.actorDistMax > p.semDistMax, `${model}: actorDistMax > semDistMax`);
  }
});

test("未知のモデルは接頭辞なし・しきい値実質無効へ落ちる", () => {
  const p = withModel("totally-unknown-model", embeddingProfile);
  // 間違った接頭辞は本文として埋め込まれて全クエリを寄せるので、付けないのが安全側。
  assert.equal(p.queryPrefix, "");
  // 距離スケールが分からない以上、切るより通す（SEMANTIC_LIMIT と relativeCut が上限を押さえる）。
  assert.ok(p.semDistMax >= 1.0);
});

test("`:latest` タグ付きでも同じプロファイルを引く", () => {
  const bare = withModel("snowflake-arctic-embed2", embeddingProfile);
  const tagged = withModel("snowflake-arctic-embed2:latest", embeddingProfile);
  assert.deepEqual(tagged, bare);
});

test("登録済みモデルの値がすべて妥当な範囲にある", () => {
  for (const model of KNOWN_EMBEDDING_MODELS) {
    const p = withModel(model, embeddingProfile);
    // cosine 距離なので 0〜2。実用域を外れていたら設定ミス。
    assert.ok(p.semDistMax > 0 && p.semDistMax <= 1, `${model}: semDistMax`);
    assert.ok(p.semRelMargin > 0 && p.semRelMargin < 0.5, `${model}: semRelMargin`);
    assert.ok(p.actorDistMax > 0 && p.actorDistMax <= 1, `${model}: actorDistMax`);
  }
});

test("未知モデルの警告は同じモデルにつき1度だけ", () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    withModel("noisy-unknown-model", () => {
      embeddingProfile();
      embeddingProfile();
      embeddingProfile();
    });
    assert.equal(warnings.length, 1, "検索のたびにログを埋めない");
  } finally {
    console.warn = original;
  }
});
