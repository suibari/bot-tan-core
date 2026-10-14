import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { startWorkerLoop } from "../packages/bot-runtime/src/workerLoop.js";
import { reportHeartbeat, reportHealthFailure } from "../packages/database/src/health.js";
import { OllamaRecovery, parsePlacement, reloadOllama, type RecoveryState } from "../apps/biorhythm_server/src/ollamaRecovery.js";

const exec = promisify(execFile);
const model = process.env.OLLAMA_MODEL;
const gpu = process.env.OLLAMA_RECOVERY_GPU_UUID;
const base = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/v1\/?$/, "").replace(/\/$/, "");
const statePath = process.env.OLLAMA_RECOVERY_STATE_FILE;
if (!model || !gpu || !statePath) throw new Error("OLLAMA_MODEL, OLLAMA_RECOVERY_GPU_UUID and OLLAMA_RECOVERY_STATE_FILE are required");
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Recovery must run on the GPU host against loopback Ollama");
let initial: RecoveryState | undefined;
try { initial = JSON.parse(await readFile(statePath, "utf8")); }
catch (error: any) { if (error.code !== "ENOENT") throw error; }
// Restart unlocks failure circuit, but retains cooldown and measured capacity.
if (initial) initial.failures = 0;
const policy = new OllamaRecovery(initial);
async function save(state: RecoveryState) {
  await mkdir(dirname(statePath!), { recursive: true });
  await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath!);
}
async function request(path: string, body?: object, timeout = 5000): Promise<any> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeout),
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Ollama ${path}: HTTP ${response.status}`);
  return response.json();
}
async function probe() {
  const [{ stdout }, data] = await Promise.all([
    exec("nvidia-smi", ["-i", gpu!, "--query-gpu=memory.free", "--format=csv,noheader,nounits"], { timeout: 5000 }),
    request("/api/ps"),
  ]);
  const free = Number(stdout.trim());
  if (!stdout.trim() || !Number.isFinite(free)) throw new Error("Invalid GPU free memory");
  return parsePlacement(data, model!, free * 1024 ** 2);
}
let lastDetail: Record<string, unknown> = {};
async function publish(detail: Record<string, unknown>) {
  lastDetail = { ...detail, gpuUuid: gpu };
  // State transitions must not be delayed by heartbeat throttling.
  await reportHeartbeat("ollama-placement", lastDetail, { force: true });
}
async function recover() {
  // Unloading/loading can take minutes. Keep the recovery status fresh while
  // the main guarded worker awaits the lifecycle operation.
  const progress = startWorkerLoop({ name: "OLLAMA_RECOVERY_PROGRESS", intervalMs: 30_000,
    tick: () => reportHeartbeat("ollama-placement", lastDetail, { force: true }) });
  progress.unref();
  try { return await reloadOllama(model!, policy.state.requiredBytes, {
    probe, now: Date.now,
    request: body => request("/api/chat", body, 180_000),
    freeBytes: async () => {
      const { stdout } = await exec("nvidia-smi", ["-i", gpu!, "--query-gpu=memory.free", "--format=csv,noheader,nounits"], { timeout: 5000 });
      if (!stdout.trim()) throw new Error("Missing GPU free memory");
      return Number(stdout.trim()) * 1024 ** 2;
    },
    wait: () => new Promise(resolve => setTimeout(resolve, 1000)),
    // Explicitly accepted short interruption; missing systemd authorization is
    // reported, never bypassed or converted to an interactive password prompt.
    restart: () => exec("systemctl", ["--no-ask-password", "start", "ollama-recovery-restart.service"], { timeout: 35_000 }),
  }); } finally { clearInterval(progress); }
}
startWorkerLoop({ name: "OLLAMA_RECOVERY", intervalMs: 30_000, immediate: true, tick: async () => {
  try {
    await policy.tick(await probe(), Date.now(), process.env.OLLAMA_RECOVERY_ENABLED !== "0", recover, publish, save);
  } catch (error) {
    policy.resetWindow();
    console.error("[ERROR][OLLAMA_RECOVERY]", error);
    await reportHealthFailure("ollama-placement", error);
  }
} });
