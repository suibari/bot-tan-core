import assert from "node:assert/strict";
import test from "node:test";
import {
  NAGI_BLUESKY_VIEW_SCOPES,
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
  for (const scope of NAGI_BLUESKY_VIEW_SCOPES)
    assert.equal(required.includes(scope), false);
});

test("最大スコープは必須権限に任意の Bluesky 連携（クロスポストと閲覧）の権限だけを加える", () => {
  const full = scopes(NAGI_OAUTH_SCOPE_FULL);
  assert.equal(full.includes(NAGI_CROSSPOST_SCOPE), true);
  for (const scope of NAGI_BLUESKY_VIEW_SCOPES)
    assert.equal(full.filter((item) => item === scope).length, 1);
  for (const scope of NAGI_STANDARD_SITE_SCOPES) {
    assert.equal(full.filter((item) => item === scope).length, 1);
  }
});

test("3行日記の書き込み権限は通常ログインで必須になる", async () => {
  const { NAGI_TRILINES_SCOPE } = await import("../constants.js");
  assert.equal(NAGI_TRILINES_SCOPE, "repo:com.suibari.trilinesat.diary");
  assert.equal(scopes(NAGI_OAUTH_SCOPE).filter((item) => item === NAGI_TRILINES_SCOPE).length, 1);
});

 test("Bluesky プロフィールの更新権限を要求しない", () => {
  for (const scope of [NAGI_OAUTH_SCOPE, NAGI_OAUTH_SCOPE_FULL]) {
    assert.equal(scopes(scope).some((value) => value.startsWith("repo:app.bsky.actor.profile")), false);
  }
});
