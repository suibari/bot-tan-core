import assert from "node:assert/strict";
import test from "node:test";
import {
  appviewDeliveryLagPart,
  botReplyIndexPart,
  classifyDiskUsage,
  classifyRepoRelay,
  jetstreamActivityPart,
  servicePart,
  upstreamPart,
  type HealthPart,
} from "../src/healthMonitor.js";

const now = () => new Date().toISOString();

test("サービスはプロセスとJetstream接続の両方が正常なときだけok", () => {
  const okAt = now();
  assert.equal(
    servicePart(
      "Nagi AppView",
      { at: okAt, lastOkAt: okAt },
      { at: okAt, lastOkAt: okAt },
    ).state,
    "ok",
  );

  assert.equal(
    servicePart(
      "Nagi AppView",
      { at: okAt, lastOkAt: okAt },
      {
        at: okAt,
        lastOkAt: new Date(Date.now() - 1_000).toISOString(),
        lastErrorAt: okAt,
        lastError: "connection closed",
      },
    ).state,
    "down",
  );
});

test("上流は1接続でも生きていればok、全接続断でdown", () => {
  const part = (state: HealthPart["state"]): HealthPart => ({ name: state, state });
  assert.equal(upstreamPart([part("down"), part("ok"), part("down")]).state, "ok");
  assert.equal(upstreamPart([part("down"), part("down"), part("down")]).state, "down");
});

test("WebSocketが開いていてもcommit受信が止まればJetstreamをdownにする", () => {
  const current = Date.parse("2026-08-17T00:10:00.000Z");
  assert.equal(jetstreamActivityPart(undefined, current).state, "unknown");
  assert.equal(
    jetstreamActivityPart(
      { detail: { lastEventAt: "2026-08-17T00:09:00.000Z" } },
      current,
    ).state,
    "ok",
  );
  assert.equal(
    jetstreamActivityPart(
      { detail: { lastEventAt: "2026-08-17T00:07:30.000Z" } },
      current,
    ).state,
    "stale",
  );
  assert.equal(
    jetstreamActivityPart(
      { detail: { lastEventAt: "2026-08-17T00:04:00.000Z" } },
      current,
    ).state,
    "down",
  );
});

test("PDSとRelayの最新commitが一致しない場合はdown", () => {
  const pds = { cid: "pds-cid", rev: "3m-pds" };
  assert.equal(classifyRepoRelay(pds, pds, "active"), "ok");
  assert.equal(
    classifyRepoRelay(pds, { cid: "relay-cid", rev: "3m-relay" }, "active"),
    "down",
  );
  assert.equal(classifyRepoRelay(pds, pds, "offline"), "down");
});

test("ディスク使用率は80%で注意、90%で要対応になる", () => {
  assert.equal(classifyDiskUsage(79.9), "ok");
  assert.equal(classifyDiskUsage(80), "stale");
  assert.equal(classifyDiskUsage(89.9), "stale");
  assert.equal(classifyDiskUsage(90), "down");
});

test("AppViewの配送遅延はbotたんの書き込みの到着時間で判定する", () => {
  assert.equal(appviewDeliveryLagPart(undefined).state, "unknown");
  assert.equal(
    appviewDeliveryLagPart({ detail: { lastBotWriteLagMs: 1_500 } }).state,
    "ok",
  );
  const late = appviewDeliveryLagPart({
    detail: { lastBotWriteLagMs: 52 * 60_000 },
  });
  assert.equal(late.state, "stale");
  assert.match(late.lastError ?? "", /52分遅れ/);
  const waiting = appviewDeliveryLagPart({
    detail: { lastBotWriteLagMs: 1_000, oldestPendingMs: 6 * 60_000 },
  });
  assert.equal(waiting.state, "stale");
  assert.match(waiting.lastError ?? "", /6分届いていません/);
});

test("AppViewに未反映のbotたん返信が1件でもあれば注意表示にする", () => {
  assert.equal(botReplyIndexPart(undefined).state, "unknown");
  assert.equal(
    botReplyIndexPart({ detail: { unindexedBotReplies: 0 } }).state,
    "ok",
  );
  const missing = botReplyIndexPart({
    detail: { unindexedBotReplies: 3, oldestUnindexedReplyMs: 10 * 60_000 },
  });
  assert.equal(missing.state, "stale");
  assert.equal(missing.lastError, "3件が AppView に未反映（最古 10分前）");
});
