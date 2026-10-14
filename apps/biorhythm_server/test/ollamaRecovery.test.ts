import assert from "node:assert/strict";
import test from "node:test";
import { GiB, OllamaRecovery, parsePlacement, gpuPercent, type Placement, reloadOllama, type ReloadOperations } from "../src/ollamaRecovery.js";
const mixed: Placement = { model: "test", sizeBytes: 7 * GiB, gpuBytes: 4 * GiB, freeBytes: 6 * GiB, contextLength: 32768 };
const full: Placement = { ...mixed, gpuBytes: 8 * GiB };

test("placement validates metrics and selects only the configured model", () => {
  assert.equal(parsePlacement({ models: [] }, "test", GiB), null);
  assert.throws(() => parsePlacement({}, "test", GiB));
  assert.throws(() => parsePlacement({ models: [{ model: "test", size: 0, size_vram: 1, context_length: 32768 }] }, "test", GiB));
  const p = parsePlacement({ models: [{ model: "other" }, { model: "test", size: 7 * GiB, size_vram: 4 * GiB, context_length: 32768 }] }, "test", GiB)!;
  assert.equal(gpuPercent(p), 57);
  assert.equal(gpuPercent(full), 100);
});

test("insufficient capacity resets the two-minute window; full GPU and unloaded never reload", async () => {
  const policy = new OllamaRecovery();
  let reloads = 0; let status: any;
  const tick = (p: Placement | null, time: number) => policy.tick(p, time, true, async () => { reloads++; return full; }, async d => { status = d; }, async () => {});
  await tick(mixed, 1000);
  assert.equal(status.recovery, "stabilizing");
  await tick({ ...mixed, freeBytes: GiB }, 121000);
  assert.equal(status.recovery, "capacity");
  await tick(mixed, 122000);
  await tick(mixed, 241000);
  assert.equal(reloads, 0);
  await tick(mixed, 242000);
  assert.equal(reloads, 1);
  assert.equal(status.recovery, "recovered");
  await tick(full, 243000); await tick(null, 244000);
  assert.equal(reloads, 1);
});

test("failure persists cooldown, blocks after three failures, and full placement unlocks", async () => {
  const policy = new OllamaRecovery();
  let reloads = 0; let status: any;
  const tick = (p: Placement, time: number) => policy.tick(p, time, true, async () => { reloads++; throw new Error("capacity changed"); }, async d => { status = d; }, async () => {});
  for (const time of [1000, 2_000_000, 4_000_000]) { await tick(mixed, time); await tick(mixed, time + 120_000); }
  assert.equal(reloads, 3);
  assert.equal(policy.state.failures, 3);
  await tick(mixed, 8_000_000);
  assert.equal(status.recovery, "blocked");
  assert.equal(reloads, 3);
  const restored = new OllamaRecovery({ ...policy.state });
  assert.equal(restored.state.lastAttemptAt, policy.state.lastAttemptAt);
  await tick(full, 8_001_000);
  assert.equal(policy.state.failures, 0);
  assert.equal(status.failures, 0);
  assert.equal(status.lastResult, "全GPU配置を確認しました");
});

test("disabled recovery, cooldown and incorrect reload context do not report success", async () => {
  const policy = new OllamaRecovery(); let status: any; let reloads = 0;
  const publish = async (d: any) => { status = d; };
  const reload = async () => { reloads++; return { ...full, contextLength: 4096 }; };
  await policy.tick(mixed, 1000, false, reload, publish, async () => {});
  await policy.tick(mixed, 121000, false, reload, publish, async () => {});
  assert.equal(reloads, 0); assert.equal(status.recovery, "disabled");
  await policy.tick(mixed, 122000, true, reload, publish, async () => {});
  assert.equal(status.recovery, "failed");
  await policy.tick(mixed, 123000, true, reload, publish, async () => {});
  assert.equal(status.recovery, "cooldown");
  assert.equal(reloads, 1);
});

test("reentrant ticks cannot issue overlapping reloads", async () => {
  const policy = new OllamaRecovery(); let reloads = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const tick = (now: number) => policy.tick(mixed, now, true, async () => { reloads++; await gate; return full; }, async () => {}, async () => {});
  await tick(1000);
  const pending = tick(121000);
  await new Promise(r => setImmediate(r));
  await tick(121001);
  release(); await pending;
  assert.equal(reloads, 1);
});


function operations(sequence: (Placement | null)[]) {
  const bodies: any[] = []; let restarts = 0; let time = 1000;
  const ops: ReloadOperations = {
    probe: async () => sequence.shift() ?? null,
    freeBytes: async () => 10 * GiB,
    request: async body => { bodies.push(body); },
    restart: async () => { restarts++; },
    wait: async () => { time += 180_000; }, now: () => time,
  };
  return { ops, bodies, restarts: () => restarts };
}

test("reload rechecks capacity before stop and after release; lifecycle bodies have no num_ctx", async () => {
  const good = operations([mixed, null, full]);
  assert.equal(await reloadOllama("test", 9 * GiB, good.ops), full);
  assert.deepEqual(good.bodies.map(b => b.keep_alive), [0, -1]);
  for (const body of good.bodies) {
    assert.deepEqual(body.messages, []);
    assert.equal(JSON.stringify(body).includes("num_ctx"), false);
  }
  const low = operations([{ ...mixed, freeBytes: 0 }]);
  await assert.rejects(reloadOllama("test", 9 * GiB, low.ops), /capacity changed/);
  assert.equal(low.bodies.length, 0);
  const changed = operations([mixed, null]);
  changed.ops.freeBytes = async () => GiB;
  await assert.rejects(reloadOllama("test", 9 * GiB, changed.ops), /Insufficient free/);
  assert.equal(changed.bodies.length, 1);
});

test("sustained shared traffic restarts only after timeout; concurrent replacement is reused", async () => {
  const busy = operations([mixed, mixed, mixed, null, full]);
  assert.equal(await reloadOllama("test", 9 * GiB, busy.ops), full);
  assert.equal(busy.restarts(), 1);
  const replaced = operations([mixed, full]);
  assert.equal(await reloadOllama("test", 9 * GiB, replaced.ops), full);
  assert.equal(replaced.restarts(), 0);
  assert.equal(replaced.bodies.length, 1);
  const denied = operations([mixed, mixed, mixed]);
  denied.ops.restart = async () => { throw new Error("Permission denied"); };
  await assert.rejects(reloadOllama("test", 9 * GiB, denied.ops), /Permission denied/);
});
