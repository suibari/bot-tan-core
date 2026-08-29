import type { AiProvider } from "@bsky-affirmative-bot/shared-configs";

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
  outcome: "ok" | "error",
): Promise<void> {
  const key =
    provider === "ollama"
      ? outcome === "ok"
        ? "localRpd"
        : "localRpdError"
      : outcome === "ok"
        ? "rpd"
        : "rpdError";
  try {
    const { MemoryService } = await import("@bsky-affirmative-bot/database");
    await MemoryService.incrementStats(key, 1);
  } catch {
    // 計上の失敗で生成そのものを落とさない。
  }
}

/** 失敗しても待たない呼び出し用。生成のホットパスから使う。 */
export function reportAiCallAsync(
  provider: AiProvider,
  outcome: "ok" | "error",
): void {
  void reportAiCall(provider, outcome);
}
