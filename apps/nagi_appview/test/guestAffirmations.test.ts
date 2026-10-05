import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const xrpc = await readFile(new URL("../src/routes/xrpc.ts", import.meta.url), "utf8");
const query = await readFile(
  new URL("../src/queries/guestAffirmations.ts", import.meta.url),
  "utf8",
);

test("guest affirmations are separate from authenticated kossori creation", () => {
  assert.match(
    xrpc,
    /NAGI\.createKossoriPost}`,[\s\S]{0,100}requiredServiceAuth\(NAGI\.createKossoriPost\)/,
  );
  assert.match(xrpc, /NAGI\.createGuestAffirmation}`,[\s\S]{0,100}guestAffirmationLimiter/);
});

test("guest jobs cannot enter post or community-affirmation tables", () => {
  assert.doesNotMatch(query, /nagiPosts|applyMutation/);
  assert.match(query, /nagiGuestAffirmationJobs/);
});

test("guest access uses hashed capability tokens and bounded retention", () => {
  assert.match(query, /createHash\("sha256"\)/);
  assert.match(query, /24 \* 60 \* 60_000/);
  assert.doesNotMatch(query, /accessToken:\s*token/);
});
