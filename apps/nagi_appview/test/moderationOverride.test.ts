import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:testbot";

const { overrideModerationDecision } = await import(
  "../src/services/moderation/override.js"
);
const { allowOverrideApplies } = await import(
  "../src/services/moderation/rules.js"
);
type Deps = NonNullable<Parameters<typeof overrideModerationDecision>[1]>;

const POST_URI = "at://did:plc:author/com.suibari.nagi.post/3kabc";

type Row = NonNullable<Awaited<ReturnType<Deps["loadDecision"]>>>;

/**
 * DB の代わりに row をその場で書き換える。writeOverride は本物と同じく
 * uri と cid の両方が一致したときだけ書く。
 */
function fakeDeps(
  row: Row | undefined,
  options: {
    ensured?: Awaited<ReturnType<Deps["ensureRecord"]>>;
    ensureFails?: number;
    /** load と write の間に新しい判定が入ったことを再現する。 */
    racedCid?: string;
  } = {},
) {
  const calls: string[] = [];
  let ensureFailures = options.ensureFails ?? 0;
  const deps: Deps = {
    loadDecision: async () => (row ? { ...row } : undefined),
    writeOverride: async (subject, override, actor) => {
      if (row && options.racedCid) row.cid = options.racedCid;
      if (!row || row.uri !== subject.uri || row.cid !== subject.cid)
        return false;
      calls.push(`write:${override}:${actor}`);
      Object.assign(row, {
        override,
        overrideCid: subject.cid,
        overrideAppliedAt: null,
      });
      return true;
    },
    markApplied: async (subject) => {
      calls.push("applied");
      if (row && row.overrideCid === subject.cid)
        row.overrideAppliedAt = new Date();
    },
    ensureRecord: (async (did: string, collection: string, rkey: string) => {
      calls.push(`ensure:${did}/${collection}/${rkey}`);
      if (ensureFailures-- > 0) throw new Error("PDS timeout");
      return (
        options.ensured ?? {
          status: "present",
          record: { uri: POST_URI, cid: "cid-1", value: {} } as any,
        }
      );
    }) as Deps["ensureRecord"],
    requeue: async () => {
      calls.push("requeue");
    },
    wake: () => {
      calls.push("wake");
    },
  };
  return { deps, calls };
}

const decision = (value: string): Row => ({
  uri: POST_URI,
  cid: "cid-1",
  did: "did:plc:author",
  collection: "com.suibari.nagi.post",
  decision: value,
  override: null,
  overrideCid: null,
  overrideAppliedAt: null,
});

const input = {
  uri: POST_URI,
  cid: "cid-1",
  action: "allow" as const,
  actor: "mod#1 (1)",
};

test("releasing a rejected post writes the override before restoring from the PDS", async () => {
  const { deps, calls } = fakeDeps(decision("reject-policy"));
  const result = await overrideModerationDecision(input, deps);
  assert.deepEqual(result, { status: "restored", decision: "reject-policy" });
  // 上書きより先に復元すると、ワーカーが同じ cid のキャッシュ判定で再び落としうる。
  // 完了の記録は復元の後。
  assert.deepEqual(calls, [
    "write:allow:mod#1 (1)",
    "ensure:did:plc:author/com.suibari.nagi.post/3kabc",
    "requeue",
    "applied",
    "wake",
  ]);
});

test("releasing a label only requeues the row", async () => {
  const { deps, calls } = fakeDeps(decision("label"));
  const result = await overrideModerationDecision(input, deps);
  assert.equal(result.status, "unlabeled");
  assert.deepEqual(calls, [
    "write:allow:mod#1 (1)",
    "requeue",
    "applied",
    "wake",
  ]);
});

test("a second press after a completed release is a no-op", async () => {
  const row = decision("reject-policy");
  await overrideModerationDecision(input, fakeDeps(row).deps);
  const second = fakeDeps(row);
  const result = await overrideModerationDecision(input, second.deps);
  assert.equal(result.status, "already");
  assert.deepEqual(second.calls, []);
});

test("a release that failed half-way can be retried until the record is restored", async () => {
  const row = decision("reject-policy");
  const first = fakeDeps(row, { ensureFails: 1 });
  await assert.rejects(
    overrideModerationDecision(input, first.deps),
    /PDS timeout/,
  );
  // 上書きは残るが完了していないので、押し直しは already にならない。
  assert.equal(row.override, "allow");
  assert.equal(row.overrideAppliedAt, null);
  assert.ok(!first.calls.includes("applied"));

  const retry = fakeDeps(row);
  const result = await overrideModerationDecision(input, retry.deps);
  assert.equal(result.status, "restored");
  assert.ok(retry.calls.includes("requeue"));
  assert.ok(row.overrideAppliedAt);
});

test("a stale notice cannot approve content judged after it", async () => {
  const row = { ...decision("reject-policy"), cid: "cid-2" };
  const { deps, calls } = fakeDeps(row);
  const result = await overrideModerationDecision(input, deps);
  assert.equal(result.status, "stale");
  assert.deepEqual(calls, []);
  assert.equal(row.override, null);
});

test("a decision recorded between reading and writing is also stale", async () => {
  const row = decision("reject-policy");
  const { deps, calls } = fakeDeps(row, { racedCid: "cid-2" });
  const result = await overrideModerationDecision(input, deps);
  assert.equal(result.status, "stale");
  assert.deepEqual(calls, []);
});

test("a record deleted in the PDS is reported and not requeued", async () => {
  const { deps, calls } = fakeDeps(decision("reject-policy"), {
    ensured: { status: "absent" },
  });
  const result = await overrideModerationDecision(input, deps);
  assert.equal(result.status, "absent");
  assert.ok(!calls.includes("requeue"));
});

test("an edit after the decision is reported so the operator knows it will be judged again", async () => {
  const { deps } = fakeDeps(decision("reject-policy"), {
    ensured: {
      status: "present",
      record: { uri: POST_URI, cid: "cid-2", value: {} } as any,
    },
  });
  const result = await overrideModerationDecision(input, deps);
  assert.equal(result.cidChanged, true);
});

test("unknown subjects are not found", async () => {
  const { deps } = fakeDeps(undefined);
  assert.equal(
    (await overrideModerationDecision(input, deps)).status,
    "not-found",
  );
});

test("the override only holds for the content the operator saw", () => {
  const row = { override: "allow", overrideCid: "cid-1" };
  assert.equal(allowOverrideApplies(row, "cid-1"), true);
  assert.equal(allowOverrideApplies(row, "cid-2"), false);
  assert.equal(allowOverrideApplies({ override: null, overrideCid: null }, "cid-1"), false);
  assert.equal(allowOverrideApplies(undefined, "cid-1"), false);
});
