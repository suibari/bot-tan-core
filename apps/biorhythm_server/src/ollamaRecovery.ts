/** Placement and recovery policy. No generation requests are used for monitoring. */
export const GiB = 1024 ** 3;
export interface Placement {
  model: string;
  sizeBytes: number;
  gpuBytes: number;
  freeBytes: number;
  contextLength: number;
}
export function parsePlacement(data: unknown, model: string, freeBytes: number): Placement | null {
  const models = (data as { models?: unknown[] })?.models;
  if (!Array.isArray(models)) throw new Error("Invalid Ollama model list");
  const entry = models.find((value: any) => value?.model === model || value?.name === model) as any;
  if (!entry) return null;
  if (![entry.size, entry.size_vram, entry.context_length, freeBytes].every(Number.isFinite)
      || entry.size <= 0 || entry.size_vram < 0 || freeBytes < 0 || entry.context_length <= 0) {
    throw new Error("Invalid Ollama placement metrics");
  }
  return { model, sizeBytes: entry.size, gpuBytes: entry.size_vram, freeBytes, contextLength: entry.context_length };
}
export function gpuPercent(p: Placement): number {
  return Math.min(100, Math.floor(100 * p.gpuBytes / p.sizeBytes));
}
export interface ReloadOperations {
  probe(): Promise<Placement | null>;
  freeBytes(): Promise<number>;
  request(body: object): Promise<unknown>;
  restart(): Promise<unknown>;
  wait(): Promise<void>;
  now(): number;
}
/** Recheck capacity and verify unload; an empty chat request only loads/unloads. */
export async function reloadOllama(model: string, requiredBytes: number, ops: ReloadOperations): Promise<Placement> {
  const before = await ops.probe();
  if (!before || before.gpuBytes + before.freeBytes < requiredBytes) throw new Error("GPU capacity changed before reload");
  await ops.request({ model, messages: [], keep_alive: 0, stream: false });
  const deadline = ops.now() + 180_000;
  while (true) {
    const loaded = await ops.probe();
    if (!loaded) break;
    if (gpuPercent(loaded) === 100) return loaded;
    if (ops.now() >= deadline) {
      await ops.restart();
      const replacement = await ops.probe();
      if (replacement && gpuPercent(replacement) === 100) return replacement;
      if (replacement) throw new Error("Another client reloaded a mixed runner after restart");
      break;
    }
    await ops.wait();
  }
  const free = await ops.freeBytes();
  if (!Number.isFinite(free) || free < requiredBytes) throw new Error("Insufficient free memory after unload");
  await ops.request({ model, messages: [], keep_alive: -1, stream: false });
  const result = await ops.probe();
  if (!result) throw new Error("Model absent after reload");
  return result;
}
export interface RecoveryState {
  lastAttemptAt: number;
  failures: number;
  requiredBytes: number;
  lastResult?: string;
}
export class OllamaRecovery {
  state: RecoveryState;
  private sufficientSince: number | null = null;
  private inFlight = false;
  constructor(state?: RecoveryState) {
    this.state = state ?? { lastAttemptAt: 0, failures: 0, requiredBytes: 9 * GiB };
    if (![this.state.lastAttemptAt, this.state.failures, this.state.requiredBytes].every(Number.isFinite)
        || this.state.failures < 0 || this.state.requiredBytes < 9 * GiB) throw new Error("Invalid recovery state");
  }
  resetWindow(): void { this.sufficientSince = null; }
  async tick(p: Placement | null, now: number, enabled: boolean,
    recover: () => Promise<Placement>, publish: (detail: Record<string, unknown>) => Promise<void>,
    save: (state: RecoveryState) => Promise<void>): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const detail: Record<string, unknown> = {
        model: p?.model, placement: p ? gpuPercent(p) === 100 ? "gpu" : "mixed" : "unloaded",
        gpuPercent: p ? gpuPercent(p) : null, gpuBytes: p?.gpuBytes, freeBytes: p?.freeBytes,
        requiredBytes: this.state.requiredBytes, contextLength: p?.contextLength,
        lastAttemptAt: this.state.lastAttemptAt ? new Date(this.state.lastAttemptAt).toISOString() : null,
        failures: this.state.failures,
        lastResult: this.state.lastResult,
      };
      if (!p || gpuPercent(p) === 100) {
        this.resetWindow();
        if (p) {
          if (this.state.failures > 0) this.state.lastResult = "全GPU配置を確認しました";
          this.state.failures = 0;
          this.state.requiredBytes = Math.max(this.state.requiredBytes, p.gpuBytes + GiB);
          await save(this.state);
        }
        await publish({ ...detail, failures: this.state.failures, lastResult: this.state.lastResult, recovery: "idle" }); return;
      }
      const enough = p.freeBytes + p.gpuBytes >= this.state.requiredBytes;
      if (!enough) this.resetWindow();
      else this.sufficientSince ??= now;
      const cooling = this.state.lastAttemptAt > 0 && now - this.state.lastAttemptAt < 30 * 60_000;
      const reason = !enabled ? "disabled" : this.state.failures >= 3 ? "blocked" : !enough ? "capacity"
        : cooling ? "cooldown" : now - this.sufficientSince! < 120_000 ? "stabilizing" : "recovering";
      await publish({ ...detail, recovery: reason });
      if (reason !== "recovering") return;
      this.state.lastAttemptAt = now;
      // Save before unloading: a crash must not cause immediate repeated reloads.
      await save(this.state);
      try {
        const result = await recover();
        if (gpuPercent(result) !== 100 || result.contextLength !== p.contextLength) {
          throw new Error("Reload did not restore full GPU placement and context length");
        }
        this.state.failures = 0;
        this.state.requiredBytes = Math.max(this.state.requiredBytes, result.gpuBytes + GiB);
        this.state.lastResult = "全GPU配置に復旧しました";
        await publish({ ...detail, placement: "gpu", gpuPercent: 100, gpuBytes: result.gpuBytes,
          requiredBytes: this.state.requiredBytes, failures: 0, recovery: "recovered",
          lastAttemptAt: new Date(now).toISOString(), lastResult: "全GPU配置に復旧しました" });
      } catch (error) {
        this.state.failures++;
        this.state.lastResult = String(error).slice(0, 240);
        await publish({ ...detail, failures: this.state.failures,
          recovery: this.state.failures >= 3 ? "blocked" : "failed",
          lastAttemptAt: new Date(now).toISOString(), lastResult: String(error).slice(0, 240) });
      } finally { this.resetWindow(); await save(this.state); }
    } finally { this.inFlight = false; }
  }
}
