import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 明示的に有効化した期間だけ失敗応答を保存する。通常ログに本文を出さない。
 * 20個の排他的なスロットを使い、再起動や複数プロセスでも上限を共有する。
 * 期限は収集の終了時刻。保存済みファイルの削除は運用手順で行う。
 */
export async function saveDiaryDiagnosticSample(payload: Record<string, unknown>): Promise<void> {
  const dir = process.env.DIARY_DIAGNOSTICS_DIR?.trim();
  const until = Date.parse(process.env.DIARY_DIAGNOSTICS_UNTIL ?? "");
  if (!dir || !Number.isFinite(until) || Date.now() >= until) return;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (let slot = 0; slot < 20; slot++) {
      try {
        await writeFile(join(dir, `diary-failure-${slot.toString().padStart(2, "0")}.json`), JSON.stringify({
          ...payload,
          collectedAt: new Date().toISOString(),
          collectionUntil: new Date(until).toISOString(),
        }, null, 2), { flag: "wx", mode: 0o600 });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
  } catch {
    // 診断保存の障害で日記の再試行や欠測を増やさない。パスや本文もログへ出さない。
    console.warn("[WARN][DIARY_DIAGNOSTICS] Failed to save a bounded diagnostic sample");
  }
}
