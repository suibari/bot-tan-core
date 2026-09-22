import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/middleware/errors.js";
import {
  bookmarkSubjectType,
  normalizeBookmarkFolderName,
} from "../src/queries/bookmarks.js";

test("bookmark subject accepts Nagi posts, standard.site blogs, news, and diaries", () => {
  assert.equal(
    bookmarkSubjectType("at://did:plc:alice/site.standard.document/blog"),
    "post",
  );
  assert.equal(
    bookmarkSubjectType("at://did:plc:alice/com.suibari.nagi.post/one"),
    "post",
  );
  assert.equal(
    bookmarkSubjectType("at://did:plc:alice/com.suibari.nagi.news/two"),
    "news",
  );
  assert.equal(
    bookmarkSubjectType("at://did:plc:bot/com.suibari.nagi.diary/three"),
    "diary",
  );
});

test("bookmark subject rejects malformed and unrelated records", () => {
  for (const uri of [
    "not-an-at-uri",
    "at://did:plc:alice/app.bsky.feed.post/one",
    "at://did:plc:alice/com.suibari.nagi.post",
  ]) {
    assert.throws(
      () => bookmarkSubjectType(uri),
      (error) => error instanceof ApiError && error.status === 400,
    );
  }
});

test("bookmark folder names are trimmed and limited by Unicode characters", () => {
  assert.equal(normalizeBookmarkFolderName("  読み返す  "), "読み返す");
  assert.equal(normalizeBookmarkFolderName("😀".repeat(80)), "😀".repeat(80));
  for (const name of ["   ", "a".repeat(81), null]) {
    assert.throws(
      () => normalizeBookmarkFolderName(name),
      (error) => error instanceof ApiError && error.status === 400,
    );
  }
});
