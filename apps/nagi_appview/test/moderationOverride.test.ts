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

function fakeDeps(
  row: Awaited<ReturnType<Deps["loadDecision"]>>,
  ensured: Awaited<ReturnType<Deps["ensureRecord"]>> = {
    status: "present",
    record: { uri: POST_URI, cid: "cid-1", value: {} } as any,
  },
) {
  const calls: string[] = [];
  const deps: Deps = {
    loadDecision: async () => row,
    writeOverride: async (_row, override, actor) => {
      calls.push(`write:${override}:${actor}`);
      if (row) Object.assign(row, { override, overrideCid: row.cid });
    },
    ensureRecord: (async (did: string, collection: string, rkey: string) => {
      calls.push(`ensure:${did}/${collection}/${rkey}`);
      return ensured;
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

const decision = (value: string) => ({
  uri: POST_URI,
  cid: "cid-1",
  did: "did:plc:author",
  collection: "com.suibari.nagi.post",
  decision: value,
  override: null as string | null,
  overrideCid: null as string | null,
});

const input = { uri: POST_URI, action: "allow" as const, actor: "mod#1 (1)" };

test("releasing a rejected post writes the override before restoring from the PDS", async () => {
  const { deps, calls } = fakeDeps(decision("reject-policy"));
  const result = await overrideModerationDecision(input, deps);
  assert.deepEqual(result, { status: "restored", decision: "reject-policy" });
  // 上書きより先に復元すると、ワーカーが同じ cid のキャッシュ判定で再び落としうる。
  assert.deepEqual(calls, [
    "write:allow:mod#1 (1)",
    "ensure:did:plc:author/com.suibari.nagi.post/3kabc",
    "requeue",
    "wake",
  ]);
});

test("releasing a label only requeues the row", async () => {
  const { deps, calls } = fakeDeps(decision("label"));
  const result = await overrideModerationDecision(input, deps);
  assert.equal(result.status, "unlabeled");
  assert.deepEqual(calls, ["write:allow:mod#1 (1)", "requeue", "wake"]);
});

test("a second press is a no-op", async () => {
  const row = decision("reject-policy");
  const { deps } = fakeDeps(row);
  await overrideModerationDecision(input, deps);
  const second = fakeDeps(row);
  const result = await overrideModerationDecision(input, second.deps);
  assert.equal(result.status, "already");
  assert.deepEqual(second.calls, []);
});

test("a record deleted in the PDS is reported and not requeued", async () => {
  const { deps, calls } = fakeDeps(decision("reject-policy"), {
    status: "absent",
  });
  const result = await overrideModerationDecision(input, deps);
  assert.equal(result.status, "absent");
  assert.ok(!calls.includes("requeue"));
});

test("an edit after the decision is reported so the operator knows it will be judged again", async () => {
  const { deps } = fakeDeps(decision("reject-policy"), {
    status: "present",
    record: { uri: POST_URI, cid: "cid-2", value: {} } as any,
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
