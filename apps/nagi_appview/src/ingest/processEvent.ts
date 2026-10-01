import { db, nagiIngestState } from "@bsky-affirmative-bot/database";
import { sql } from "drizzle-orm";
import { applyMutation } from "./applyMutation.js";

/**
 * Jetstream イベントだけが重複排除ログと再開カーソルを更新する。
 * 戻り値は AppView がそのイベントを取り込んだか（対象外・検証不成立なら false）。
 */
export async function processEvent(evt: any): Promise<boolean> {
  const result = await applyMutation(evt, {
    trackJetstream: true,
    emitPush: true,
  });
  if (result.cursorAdvanced) return true;
  if (!Number.isFinite(Number(evt?.time_us))) return false;

  // 対象外・検証不成立は AppView の状態を変えないため、評価済み位置だけを進める。
  await db
    .insert(nagiIngestState)
    .values({ key: "jetstream", cursor: Number(evt.time_us) })
    .onConflictDoUpdate({
      target: nagiIngestState.key,
      set: {
        cursor: sql`greatest(${nagiIngestState.cursor}, excluded.cursor)`,
        updatedAt: new Date(),
      },
    });
  return false;
}
