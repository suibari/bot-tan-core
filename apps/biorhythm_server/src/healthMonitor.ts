import {
  classifyHeartbeat,
  DEFAULT_DOWN_MS,
  DEFAULT_FRESH_MS,
  readHeartbeats,
  worstState,
  type HealthService,
  type HealthState,
  type HeartbeatRecord,
} from "@bsky-affirmative-bot/database";
import { safeFetch } from "@bsky-affirmative-bot/shared-configs";

/**
 * bot-tan.com のダッシュボードに出す死活監視。
 *
 * 各プロセスが書いたハートビート（bot_state の health:*）を読み、ここでしか
 * 分からないもの（ローカル LLM への疎通）はこのプロセスが自分でプローブする。
 */

/** UI 上のタイル。中身は複数のプローブの集約。 */
export type HealthTile = "jetstream" | "botServer" | "localLlm" | "webSearch";

export interface HealthPart {
  name: string;
  state: HealthState;
  /** 最後に「生きている」と分かった時刻。 */
  lastOkAt?: string;
  lastError?: string;
}

export interface HealthTileStatus {
  state: HealthState;
  parts: HealthPart[];
}

export type HealthSnapshot = Record<HealthTile, HealthTileStatus> & {
  checkedAt: string;
};

const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Jetstream は「イベントが流れていること」ではなく接続が維持されていることを
 * 30秒ごとに報告するので、既定より少し緩めでよい。
 */
const JETSTREAM_FRESH_MS = 120_000;
const JETSTREAM_DOWN_MS = 300_000;
const RELAY_URL = "https://bsky.network";


interface ProbeResult {
  state: HealthState;
  lastOkAt?: string;
  lastError?: string;
}

let localLlmProbe: ProbeResult = { state: "unknown" };
let searxngProbe: ProbeResult = { state: "unknown" };
let repoRelayProbe: ProbeResult = { state: "unknown" };

interface LatestCommit {
  cid: string;
  rev: string;
}

interface DidDocument {
  service?: Array<{
    id?: string;
    type?: string;
    serviceEndpoint?: string;
  }>;
}

interface RelayHostStatus {
  status?: string;
}

async function fetchJson<T>(url: URL): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await safeFetch(url.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const xrpcUrl = (base: string, method: string, params: Record<string, string>): URL => {
  const url = new URL(`/xrpc/${method}`, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
};

export function classifyRepoRelay(
  pds: LatestCommit,
  relay: LatestCommit,
  hostStatus: string | undefined,
): HealthState {
  if (hostStatus !== "active") return "down";
  return pds.cid === relay.cid && pds.rev === relay.rev ? "ok" : "down";
}

/** botたんの実リポジトリを使い、PDSからRelayまでcommitが届いているか確認する。 */
async function probeRepoRelay(): Promise<ProbeResult> {
  const did = process.env.BSKY_DID ?? process.env.NAGI_BOT_DID;
  if (!did) return { state: "unconfigured" };

  try {
    if (!did.startsWith("did:plc:")) throw new Error("unsupported monitored DID method");
    const document = await fetchJson<DidDocument>(
      new URL(`https://plc.directory/${encodeURIComponent(did)}`),
    );
    const pds = document.service?.find(
      (entry) => entry.id === "#atproto_pds" || entry.type === "AtprotoPersonalDataServer",
    )?.serviceEndpoint;
    if (!pds) throw new Error("monitored DID has no PDS endpoint");

    const hostname = new URL(pds).hostname;
    const commitParams = { did };
    const [pdsCommit, relayCommit, relayHost] = await Promise.all([
      fetchJson<LatestCommit>(xrpcUrl(pds, "com.atproto.sync.getLatestCommit", commitParams)),
      fetchJson<LatestCommit>(
        xrpcUrl(RELAY_URL, "com.atproto.sync.getLatestCommit", commitParams),
      ),
      fetchJson<RelayHostStatus>(
        xrpcUrl(RELAY_URL, "com.atproto.sync.getHostStatus", { hostname }),
      ),
    ]);

    let state = classifyRepoRelay(pdsCommit, relayCommit, relayHost.status);
    if (state === "down" && relayHost.status === "active") {
      // 並行取得した瞬間に新commitが入る競合だけは、PDS→Relayの順で再取得して除外する。
      const latestPds = await fetchJson<LatestCommit>(
        xrpcUrl(pds, "com.atproto.sync.getLatestCommit", commitParams),
      );
      const latestRelay = await fetchJson<LatestCommit>(
        xrpcUrl(RELAY_URL, "com.atproto.sync.getLatestCommit", commitParams),
      );
      state = classifyRepoRelay(latestPds, latestRelay, relayHost.status);
    }

    if (state !== "ok") {
      return {
        state,
        lastOkAt: repoRelayProbe.lastOkAt,
        lastError:
          relayHost.status !== "active"
            ? `Relay reports PDS host as ${relayHost.status ?? "unknown"}`
            : "Relay latest commit is behind the PDS",
      };
    }

    return { state: "ok", lastOkAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "stale",
      lastOkAt: repoRelayProbe.lastOkAt,
      lastError: `PDS/Relay probe failed: ${message.slice(0, 240)}`,
    };
  }
}

/**
 * ローカル LLM（Ollama の OpenAI 互換エンドポイント）への疎通確認。
 * `OLLAMA_BASE_URL` は `.../v1` まで含む前提（predefinedAffirmation.ts と同じ）。
 */
async function probeLocalLlm(): Promise<ProbeResult> {
  const baseUrl = process.env.OLLAMA_BASE_URL;
  if (!baseUrl) return { state: "unconfigured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // 内部ネットワークの固定アドレスなので safeFetch（SSRF 対策）は通さない。
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { state: "down", lastError: `HTTP ${response.status}` };
    }
    return { state: "ok", lastOkAt: new Date().toISOString() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state: "down", lastError: message.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自前 SearXNG の疎通。Gemini のときと違い自分で立てているサービスなので、
 * 「呼ばれたときだけ記録」ではなく能動プローブにできる。無料なので叩き放題。
 *
 * `SEARXNG_BASE_URL` は LAN/loopback の固定アドレスなので safeFetch（SSRF 対策）は
 * 通さない。通すとプライベートアドレスとして自分の検索基盤が弾かれる。
 */
async function probeSearxng(): Promise<ProbeResult> {
  const baseUrl = process.env.SEARXNG_BASE_URL;
  if (!baseUrl) return { state: "unconfigured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/healthz`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { state: "down", lastError: `HTTP ${response.status}` };
    }
    return { state: "ok", lastOkAt: new Date().toISOString() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state: "down", lastError: message.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/** ハートビート1件を、UI に渡す形へ整える。 */
function partFromHeartbeat(
  name: string,
  record: HeartbeatRecord | undefined,
  freshMs = DEFAULT_FRESH_MS,
  downMs = DEFAULT_DOWN_MS,
): HealthPart {
  const state = classifyHeartbeat(record, { freshMs, downMs });
  return {
    name,
    state,
    ...(record?.lastOkAt ? { lastOkAt: record.lastOkAt } : {}),
    // 直近が成功なら、過去のエラー文言は出さない（古い障害が残り続けて見える）。
    ...(state !== "ok" && record?.lastError ? { lastError: record.lastError } : {}),
  };
}

function partFromProbe(name: string, probe: ProbeResult): HealthPart {
  return {
    name,
    state: probe.state,
    ...(probe.lastOkAt ? { lastOkAt: probe.lastOkAt } : {}),
    ...(probe.lastError ? { lastError: probe.lastError } : {}),
  };
}

/** 高トラフィックのBluesky購読で、openだけでなくcommitも継続受信しているかを見る。 */
export function jetstreamActivityPart(
  record: HeartbeatRecord | undefined,
  now = Date.now(),
): HealthPart {
  const raw = record?.detail?.lastEventAt;
  const eventAt = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(eventAt)) {
    return { name: "Jetstream events", state: "unknown" };
  }

  const age = now - eventAt;
  const state: HealthState =
    age <= JETSTREAM_FRESH_MS ? "ok" : age <= JETSTREAM_DOWN_MS ? "stale" : "down";
  return {
    name: "Jetstream events",
    state,
    lastOkAt: new Date(eventAt).toISOString(),
    ...(state !== "ok" ? { lastError: "No recent commit events received" } : {}),
  };
}

/**
 * AppView が今どの Jetstream インスタンスを見ているか。
 *
 * 接続先は候補リストの中で自動的に切り替わるので、切り替わったこと自体に気づけないと
 * 「繋がってはいるが本命が死んでいる」状態を見逃す。ホスト名と切替回数だけを出す。
 */
export function jetstreamEndpointPart(
  record: HeartbeatRecord | undefined,
): HealthPart {
  const endpoint = record?.detail?.endpoint;
  if (typeof endpoint !== "string") {
    return { name: "AppView 接続先", state: "unknown" };
  }
  let host = endpoint;
  try {
    host = new URL(endpoint).host;
  } catch {
    // 解釈できない値はそのまま見せる。
  }
  const rotations = Number(record?.detail?.rotations ?? 0);
  const rotated = Number.isFinite(rotations) && rotations > 0;
  return {
    name: `AppView 接続先: ${host}`,
    // 切り替わった実績があるだけで異常とは限らないため、down にはしない。
    state: rotated ? "stale" : "ok",
    ...(record?.lastOkAt ? { lastOkAt: record.lastOkAt } : {}),
    ...(rotated ? { lastError: `接続先を${rotations}回切り替えました` } : {}),
  };
}

const tile = (parts: HealthPart[]): HealthTileStatus => ({
  state: worstState(parts.map((part) => part.state)),
  parts,
});

/** プロセスと、そのプロセスが所有するJetstream接続の悪いほうをサービス状態にする。 */
export function servicePart(
  name: string,
  process: HeartbeatRecord | undefined,
  jetstream: HeartbeatRecord | undefined,
): HealthPart {
  const processPart = partFromHeartbeat(name, process);
  const streamPart = partFromHeartbeat(
    name,
    jetstream,
    JETSTREAM_FRESH_MS,
    JETSTREAM_DOWN_MS,
  );
  const state = worstState([processPart.state, streamPart.state]);
  const okTimes = [processPart.lastOkAt, streamPart.lastOkAt]
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    name,
    state,
    // 両方が揃っている場合は古いほう＝弱い側の最終成功を示す。
    ...(okTimes[0] ? { lastOkAt: okTimes[0] } : {}),
    ...(state !== "ok" && (streamPart.lastError || processPart.lastError)
      ? { lastError: streamPart.lastError ?? processPart.lastError }
      : {}),
  };
}

/**
 * 3コンシューマーのどれかが接続中なら上流は到達可能。
 * 一部だけ切れている問題はbotServer側の該当サービスへ出し、ここでは外部依存だけを表す。
 */
export function upstreamPart(parts: HealthPart[]): HealthPart {
  const states = parts.map((part) => part.state);
  const state: HealthState = states.includes("ok")
    ? "ok"
    : states.every((value) => value === "down")
      ? "down"
      : states.some((value) => value === "down" || value === "stale")
        ? "stale"
        : "unknown";
  const lastOkAt = parts
    .map((part) => part.lastOkAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return {
    name: "Upstream WebSocket",
    state,
    ...(lastOkAt ? { lastOkAt } : {}),
    ...(state === "down"
      ? { lastError: parts.map((part) => part.lastError).find(Boolean) }
      : {}),
  };
}

let cached: HealthSnapshot | null = null;

/** 直近のプローブ結果とハートビートから、4タイル分の状態を組み立てる。 */
export async function buildHealthSnapshot(): Promise<HealthSnapshot> {
  const heartbeats = await readHeartbeats();
  const get = (service: HealthService) => heartbeats.get(service);
  const bskyStream = partFromHeartbeat(
    "Bluesky botたん",
    get("jetstream-bsky"),
    JETSTREAM_FRESH_MS,
    JETSTREAM_DOWN_MS,
  );
  const nagiStream = partFromHeartbeat(
    "Nagi botたん",
    get("jetstream-nagi"),
    JETSTREAM_FRESH_MS,
    JETSTREAM_DOWN_MS,
  );
  const appviewStream = partFromHeartbeat(
    "Nagi AppView",
    get("jetstream-appview"),
    JETSTREAM_FRESH_MS,
    JETSTREAM_DOWN_MS,
  );

  const snapshot: HealthSnapshot = {
    checkedAt: new Date().toISOString(),
    jetstream: tile([
      upstreamPart([bskyStream, nagiStream, appviewStream]),
      jetstreamActivityPart(get("jetstream-bsky")),
      jetstreamEndpointPart(get("jetstream-appview")),
      partFromProbe("PDS → Relay", repoRelayProbe),
    ]),
    botServer: tile([
      servicePart("Bluesky botたん", get("bsky-bot"), get("jetstream-bsky")),
      servicePart("Nagi botたん", get("nagi-bot"), get("jetstream-nagi")),
      servicePart("Nagi AppView", get("nagi-appview"), get("jetstream-appview")),
    ]),
    localLlm: tile([partFromProbe("Ollama", localLlmProbe)]),
    webSearch: tile([partFromProbe("SearXNG", searxngProbe)]),
  };

  cached = snapshot;
  return snapshot;
}

/** 直近に組み立てた結果。WS のブロードキャストは毎回 DB を叩かずこれを使う。 */
export function getCachedHealthSnapshot(): HealthSnapshot | null {
  return cached;
}

export function startHealthMonitor(): () => void {
  const runProbes = async () => {
    [localLlmProbe, repoRelayProbe, searxngProbe] = await Promise.all([
      probeLocalLlm(),
      probeRepoRelay(),
      probeSearxng(),
    ]);
    await buildHealthSnapshot();
  };

  void runProbes().catch((e) => console.error("[ERROR][BIO][HEALTH] Initial probe failed:", e));

  const timer = setInterval(() => {
    void runProbes().catch((e) => console.error("[ERROR][BIO][HEALTH] Probe failed:", e));
  }, PROBE_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
