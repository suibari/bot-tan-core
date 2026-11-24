import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NAGI } from "../constants.js";

const lexicon = JSON.parse(
  readFileSync(new URL("../../lexicons/com/suibari/nagi/longPost.json", import.meta.url), "utf8"),
);

test("長文の目印は mochott と同じく uri と cid を必須にした object", () => {
  assert.equal(lexicon.id, NAGI.longPost);
  const main = lexicon.defs.main;
  assert.equal(main.type, "object");
  assert.deepEqual(main.required, ["uri", "cid"]);
  assert.equal(main.properties.uri.format, "at-uri");
  assert.equal(main.properties.cid.format, "cid");
});
