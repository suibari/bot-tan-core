import assert from "node:assert/strict";
import test from "node:test";
import { isReplyGate, replyGateAllows } from "../replyGate.js";

const AUTHOR = "did:plc:author";
const OTHER = "did:plc:other";
const BOT = "did:plc:bot";

test("replyGate が無ければ誰でも返信できる", () => {
  assert.equal(replyGateAllows(undefined, AUTHOR, OTHER, BOT), true);
  assert.equal(replyGateAllows(undefined, AUTHOR, BOT, BOT), true);
});

test("nobody は投稿者本人だけ", () => {
  assert.equal(replyGateAllows("nobody", AUTHOR, AUTHOR, BOT), true);
  assert.equal(replyGateAllows("nobody", AUTHOR, OTHER, BOT), false);
  assert.equal(replyGateAllows("nobody", AUTHOR, BOT, BOT), false);
});

test("bot は投稿者本人と botたん", () => {
  assert.equal(replyGateAllows("bot", AUTHOR, AUTHOR, BOT), true);
  assert.equal(replyGateAllows("bot", AUTHOR, BOT, BOT), true);
  assert.equal(replyGateAllows("bot", AUTHOR, OTHER, BOT), false);
});

test("未知の値は制限しない", () => {
  assert.equal(replyGateAllows("followers", AUTHOR, OTHER, BOT), true);
  assert.equal(isReplyGate("followers"), false);
  assert.equal(isReplyGate("bot"), true);
});
