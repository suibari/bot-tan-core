import assert from "node:assert/strict";
import test from "node:test";
import {
  NAGI_CROSSPOST_SCOPE,
  NAGI_OAUTH_SCOPE,
  NAGI_OAUTH_SCOPE_FULL,
  NAGI_STANDARD_SITE_SCOPES,
} from "../constants.js";

const scopes = (value: string) => value.split(" ");

test("standard.site の書き込み権限は通常ログインで必須になる", () => {
  const required = scopes(NAGI_OAUTH_SCOPE);
  for (const scope of NAGI_STANDARD_SITE_SCOPES) {
    assert.equal(required.filter((item) => item === scope).length, 1);
  }
  assert.equal(required.includes(NAGI_CROSSPOST_SCOPE), false);
});

test("最大スコープは必須権限に任意の Bluesky クロスポスト権限だけを加える", () => {
  const full = scopes(NAGI_OAUTH_SCOPE_FULL);
  assert.equal(full.includes(NAGI_CROSSPOST_SCOPE), true);
  for (const scope of NAGI_STANDARD_SITE_SCOPES) {
    assert.equal(full.filter((item) => item === scope).length, 1);
  }
});
