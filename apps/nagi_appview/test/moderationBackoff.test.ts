import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseRetryAfter } from "../src/services/moderation/openai.js";
import {
  MODERATION_LEGACY,
  MODERATION_RULE_VERSION,
  MODERATION_SKIPPED,
} from "../src/services/moderation/rules.js";

/**
 * バックフィルをやめた経緯（開発環境で 429 に当たった）を踏まえた回帰。
 * moderationWorker は DB を掴むので、純関数と番兵の値だけをここで固定する。
 */

const NOW = Date.parse("2026-09-02T00:00:00Z");

test("parses Retry-After given in seconds", () => {
  assert.equal(parseRetryAfter("30", NOW), 30_000);
  assert.equal(parseRetryAfter(" 1.5 ", NOW), 1_500);
});

test("parses Retry-After given as an HTTP date", () => {
  assert.equal(
    parseRetryAfter("Wed, 02 Sep 2026 00:01:00 GMT", NOW),
    60_000,
  );
});

test("ignores Retry-After values we cannot act on", () => {
  for (const header of [
    null,
    undefined,
    "",
    "   ",
    "soon",
    "0",
    "-5",
    // 過ぎた日付。待つ意味がないので通常のバックオフに任せる。
    "Tue, 01 Sep 2026 00:00:00 GMT",
  ])
    assert.equal(parseRetryAfter(header, NOW), undefined, `header=${header}`);
});

test("caps an absurd Retry-After so the worker never stalls for hours", () => {
  assert.equal(parseRetryAfter("86400", NOW), 15 * 60_000);
});

test("backoff grows exponentially and stops at the ceiling", async () => {
  const { moderationBackoffMs } = await import(
    "../src/ingest/moderationWorker.js"
  );
  assert.equal(moderationBackoffMs(1), 30_000);
  assert.equal(moderationBackoffMs(2), 60_000);
  assert.equal(moderationBackoffMs(3), 120_000);
  assert.equal(moderationBackoffMs(99), 15 * 60_000);
  // 0 回目（呼ばれないはずだが）でも最小値を下回らない。
  assert.equal(moderationBackoffMs(0), 30_000);
});

test("Retry-After wins over the exponential backoff", async () => {
  const { moderationBackoffMs } = await import(
    "../src/ingest/moderationWorker.js"
  );
  assert.equal(moderationBackoffMs(1, 5_000), 5_000);
  assert.equal(moderationBackoffMs(9, 5_000), 5_000);
  // ただし上限は超えさせない。
  assert.equal(moderationBackoffMs(1, 60 * 60_000), 15 * 60_000);
});

test("the three moderation_version sentinels are distinct", () => {
  const values = [MODERATION_SKIPPED, MODERATION_LEGACY, MODERATION_RULE_VERSION];
  assert.equal(new Set(values).size, 3);
  // NULL だけが「判定待ち」を意味する。番兵はどれも非 NULL の文字列。
  for (const value of values) assert.equal(typeof value, "string");
});

test("existing rows are marked legacy by the migration instead of being backfilled", async () => {
  const migration = await readFile(
    new URL(
      "../../../packages/database/drizzle/0055_nagi_moderation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = await readFile(
    new URL(
      "../../../packages/database/src/nagiSchema.ts",
      import.meta.url,
    ),
    "utf8",
  );
  for (const table of ["posts", "profiles", "channels", "emojis", "news"])
    assert.match(
      migration,
      new RegExp(
        `UPDATE "nagi"\\."${table}"\\s+SET "moderation_version" = 'legacy'`,
      ),
      `${table} is not marked legacy`,
    );
  assert.equal(
    schema.match(
      /moderationVersion: text\("moderation_version"\)\.default\("legacy"\)/g,
    )?.length,
    5,
    "drizzle:push must add moderation_version with a legacy default",
  );
  // 判定待ちの部分索引は legacy を埋めた後に作る（ほぼ空の索引にするため）。
  assert.ok(
    migration.indexOf("SET \"moderation_version\" = 'legacy'") <
      migration.indexOf("nagi_posts_moderation_pending_idx"),
  );
});
