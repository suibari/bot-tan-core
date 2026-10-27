import assert from "node:assert/strict";
import test from "node:test";
import { CARD_BOARD_KEEP, donatableCount } from "../src/cardBoard.js";

test("手元に3枚を残した残りだけ置ける", () => {
  assert.equal(CARD_BOARD_KEEP, 3);
  assert.equal(donatableCount({ stock: 3 }, { available: 3 }), 0);
  assert.equal(donatableCount({ stock: 4 }, { available: 4 }), 1);
  assert.equal(donatableCount({ stock: 10 }, { available: 10 }), 7);
});

test("お休み中の在庫は置けない", () => {
  // 5枚のうち4枚がお休み中なら、置けるのは1枚。
  assert.equal(donatableCount({ stock: 5 }, { available: 1 }), 1);
  // お休みが3枚以下なら、残す3枚の中に収まる。
  assert.equal(donatableCount({ stock: 5 }, { available: 3 }), 2);
  assert.equal(donatableCount({ stock: 4 }, { available: 0 }), 0);
});

test("所持が少なければ0", () => {
  assert.equal(donatableCount({ stock: 1 }, { available: 1 }), 0);
  assert.equal(donatableCount({ stock: 0 }, { available: 0 }), 0);
});
