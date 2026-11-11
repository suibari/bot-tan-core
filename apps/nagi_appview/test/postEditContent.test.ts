import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  POST_CONTENT_FIELDS,
  POST_METADATA_FIELDS,
  hasPostContentChange,
} from "../src/ingest/postEditContent.js";

const base = {
  $type: "com.suibari.nagi.post",
  text: "こんにちは",
  facets: [],
  langs: ["ja"],
  createdAt: "2026-11-12T00:00:00.000Z",
};
const crosspost = {
  root: { uri: "at://did:plc:a/app.bsky.feed.post/1", cid: "bafyroot" },
  tail: { uri: "at://did:plc:a/app.bsky.feed.post/1", cid: "bafyroot" },
};

test("every lexicon property is classified as content or metadata", () => {
  const lexicon = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/nagi-lexicon/lexicons/com/suibari/nagi/post.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const properties = Object.keys(lexicon.defs.main.record.properties);
  const unclassified = properties.filter(
    (key) => !POST_CONTENT_FIELDS.has(key) && !POST_METADATA_FIELDS.has(key),
  );
  assert.deepEqual(unclassified, []);
  for (const key of POST_CONTENT_FIELDS)
    assert.ok(!POST_METADATA_FIELDS.has(key), `${key} is in both sets`);
});

test("adding only a crosspost reference is not an edit", () => {
  assert.equal(hasPostContentChange(base, { ...base, crosspost }), false);
});

test("key order differences from jsonb are not an edit", () => {
  const reordered = {
    createdAt: base.createdAt,
    langs: ["ja"],
    facets: [],
    text: base.text,
    $type: base.$type,
  };
  assert.equal(hasPostContentChange(base, reordered), false);
});

test("changing the text together with crosspost is an edit", () => {
  assert.equal(
    hasPostContentChange(base, { ...base, text: "こんばんは", crosspost }),
    true,
  );
});

test("unknown fields are treated as content", () => {
  assert.equal(hasPostContentChange(base, { ...base, article: true }), true);
});

test("legacy rows without a stored record are treated as edits", () => {
  assert.equal(hasPostContentChange(null, base), true);
});
