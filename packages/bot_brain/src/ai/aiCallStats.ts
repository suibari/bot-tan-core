import type { AiProvider } from "@bsky-affirmative-bot/shared-configs";

type AiCallOutcome = "ok" | "error";
type AiCallStatsKey = "rpd" | "rpdError" | "localRpd" | "localRpdError";
type GenerationHealthService = "local-llm" | "gemini";

export interface GenerationTelemetrySink {
  incrementStats(key: AiCallStatsKey, amount: number): Promise<void>;
  reportHeartbeat(service: GenerationHealthService): Promise<void>;
  reportHealthFailure(
    service: GenerationHealthService,
    error: unknown,
  ): Promise<void>;
}

const databaseTelemetrySink: GenerationTelemetrySink = {
  async incrementStats(key, amount) {
    const { MemoryService } = await import("@bsky-affirmative-bot/database");
    await MemoryService.incrementStats(key, amount);
  },
  async reportHeartbeat(service) {
    const { reportHeartbeat } = await import("@bsky-affirmative-bot/database");
    await reportHeartbeat(service);
  },
  async reportHealthFailure(service, error) {
    const { reportHealthFailure } =
      await import("@bsky-affirmative-bot/database");
    await reportHealthFailure(service, error);
  },
};

let telemetrySink = databaseTelemetrySink;

/**
 * 単体テストで実DBへの観測書き込みを止めるための差し替え口。
 * 本番コードは呼ばず、既定のdatabase sinkを常に使う。
 */
export function setGenerationTelemetrySinkForTest(
  sink: GenerationTelemetrySink,
): () => void {
  const previous = telemetrySink;
  telemetrySink = sink;
  return () => {
    telemetrySink = previous;
  };
}

const healthService = (provider: AiProvider): GenerationHealthService =>
  provider === "ollama" ? "local-llm" : "gemini";

/**
 * LLM 呼び出し回数の計上。クラウド（Gemini）とローカル（Ollama）を別カウンタに分ける。
 *
 * `rpd` / `rpdError` は Gemini の日次上限判定（`MemoryService.checkRPD`）にそのまま使われる
 * ため、**ローカル生成を絶対に混ぜてはいけない**。混ぜると課金枠を消費していないのに
 * 上限に達したと判定され、bsky の全機能が止まる。
 *
 * `@bsky-affirmative-bot/database` は import しただけで dotenv を読み Postgres クライアントを
 * 作るので、静的 import にすると LLM を呼ばないユニットテストまで巻き込む。実際に呼んだ
 * ときだけ遅延 import する。
 */
export async function reportAiCall(
  provider: AiProvider,
  outcome: AiCallOutcome,
): Promise<void> {
  const key: AiCallStatsKey =
    provider === "ollama"
      ? outcome === "ok"
        ? "localRpd"
        : "localRpdError"
      : outcome === "ok"
        ? "rpd"
        : "rpdError";
  try {
    await telemetrySink.incrementStats(key, 1);
  } catch {
    // 計上の失敗で生成そのものを落とさない。
  }
}

/** 失敗しても待たない呼び出し用。生成のホットパスから使う。 */
export function reportAiCallAsync(
  provider: AiProvider,
  outcome: AiCallOutcome,
): void {
  void reportAiCall(provider, outcome);
}

/** 生成成功時の死活監視。観測失敗で生成処理は落とさない。 */
export function reportGenerationHeartbeatAsync(provider: AiProvider): void {
  void telemetrySink.reportHeartbeat(healthService(provider)).catch(() => {});
}

/** 生成失敗時の死活監視。観測失敗で元の例外を置き換えない。 */
export function reportGenerationHealthFailureAsync(
  provider: AiProvider,
  error: unknown,
): void {
  void telemetrySink
    .reportHealthFailure(healthService(provider), error)
    .catch(() => {});
}
