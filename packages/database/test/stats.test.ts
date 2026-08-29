import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { MemoryService } from "../src/index.js";

/** 指標が増える前に保存された totalStats。新しいキーを持っていない。 */
const legacyStats = {
  followers: 3,
  likes: 10,
  reply: 2,
  affirmationCount: 5,
  conversation: 1,
  fortune: 0,
  cheer: 0,
  analysis: 0,
  dj: 0,
  anniversary: 0,
  answer: 0,
  recap: 0,
  lang: { 日本語: 4 },
  bskyrate: 0,
  rpd: 7,
  rpdError: 1,
};

async function incrementAgainstLegacy(type: string) {
  const getBotState = mock.method(
    MemoryService,
    "getBotState",
    async () => structuredClone(legacyStats),
  );
  let saved: any;
  const setBotState = mock.method(
    MemoryService,
    "setBotState",
    async (_key: string, value: any) => {
      saved = value;
    },
  );
  try {
    await MemoryService.incrementStats(type, 1);
    return saved;
  } finally {
    getBotState.mock.restore();
    setBotState.mock.restore();
  }
}

/**
 * 保存済みの行にキーが無いまま `currentStats.localRpd += 1` をすると NaN になり、
 * それが jsonb へ書き戻されて以後ずっと壊れる。読み出し時に既定値で埋めること。
 */
test("保存済み統計に無い新しい指標も、NaNにせず1から数え始める", async () => {
  const saved = await incrementAgainstLegacy("localRpd");
  assert.equal(saved.localRpd, 1);
  assert.equal(saved.localRpdError, 0);
});

test("既存の指標は保存済みの値を引き継ぐ", async () => {
  const saved = await incrementAgainstLegacy("rpd");
  assert.equal(saved.rpd, 8);
  assert.equal(saved.followers, 3);
  // 既定値で埋めても、保存済みの他の値を0へ潰さないこと。
  assert.equal(saved.likes, 10);
  assert.deepEqual(saved.lang, { 日本語: 4 });
});
