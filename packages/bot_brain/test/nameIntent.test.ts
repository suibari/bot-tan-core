import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNameIntent } from "../src/ai/judgeNameIntent.js";

/**
 * 判定モデルの出力を受け取る側の防御。
 *
 * 誤って呼び名を覚えると、以後ずっとその名前で呼び続けることになる
 * （呼称ドリフトの事故と同じ実害）。見逃しはユーザーが言い直せば済むので、
 * 迷ったら none に倒すのが正しい。ここはその「倒す」条件を固定する。
 *
 * 判定率そのものは実データを使う eval スクリプトで測る:
 *   pnpm --filter nagi-bot-server eval:name-intent
 */

const ok = {
  subject: "self",
  intent: "rename_request",
  name: "ゆき",
  confidence: 0.9,
};

test("self かつ十分な確信度なら通す", () => {
  assert.deepEqual(normalizeNameIntent(ok), {
    intent: "rename_request",
    name: "ゆき",
    confidence: 0.9,
  });
});

test("subject が self でなければ捨てる", () => {
  // モデルは「名前が訂正された」ことは拾えても誰の名前かを外す。帰属先で機械的に弾く。
  for (const subject of ["bot", "other", "pet", "work", "place", "title", "other_thing", "na"]) {
    const result = normalizeNameIntent({ ...ok, subject });
    assert.equal(result.intent, "none", `subject=${subject} が通ってしまう`);
    assert.equal(result.name, null);
  }
});

test("intent が none や未知の値なら捨てる", () => {
  for (const intent of ["none", "unknown", "", null, undefined]) {
    assert.equal(normalizeNameIntent({ ...ok, intent }).intent, "none");
  }
});

test("確信度がしきい値未満なら捨てる", () => {
  assert.equal(normalizeNameIntent({ ...ok, confidence: 0.69 }).intent, "none");
  assert.equal(normalizeNameIntent({ ...ok, confidence: 0.7 }).intent, "rename_request");
  // 数値でない/欠落は 0 扱い
  assert.equal(normalizeNameIntent({ ...ok, confidence: "0.9" }).intent, "none");
  assert.equal(normalizeNameIntent({ ...ok, confidence: undefined }).intent, "none");
});

test("名前が取れない訂正は捨てる（保存できる呼称が無い）", () => {
  for (const name of [null, undefined, "", "   ", 123]) {
    assert.equal(normalizeNameIntent({ ...ok, intent: "correction", name }).intent, "none");
  }
});

test('文字列の "null" を名前として通さない', () => {
  // null 許容スキーマでもモデルは文字列を返すことがある。通すと相手を「null」と呼び始める。
  for (const name of ["null", "NULL", "none", "undefined", "N/A", "なし"]) {
    assert.equal(normalizeNameIntent({ ...ok, name }).intent, "none", `${name} が通ってしまう`);
  }
});

test("名前の『種類』を指す語は名前ではない", () => {
  // 「名字じゃなくて下の名前で呼んで」→ name="下の名前" が実測で出た。
  for (const name of ["下の名前", "名字", "あだ名", "ハンドルネーム", "first name", "nickname"]) {
    assert.equal(normalizeNameIntent({ ...ok, name }).intent, "none", `${name} が通ってしまう`);
  }
});

test("長すぎる名前と改行入りは文の切り出しとみなして捨てる", () => {
  assert.equal(normalizeNameIntent({ ...ok, name: "あ".repeat(41) }).intent, "none");
  assert.equal(normalizeNameIntent({ ...ok, name: "あ".repeat(40) }).intent, "rename_request");
  assert.equal(normalizeNameIntent({ ...ok, name: "ゆき\nです" }).intent, "none");
});

test("前後の空白は落として保存する", () => {
  assert.equal(normalizeNameIntent({ ...ok, name: "  ゆき  " }).name, "ゆき");
});

test("壊れた入力でも例外を投げずに none を返す", () => {
  for (const input of [null, undefined, "", 0, [], "文字列"]) {
    assert.equal(normalizeNameIntent(input).intent, "none");
  }
});
