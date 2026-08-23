const MAX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_STEP_INTERVAL_MS = 60 * 60 * 1000;

export interface StartupStepSchedule {
  nextStepTime: string;
  delayMs: number;
  needsPersistence: boolean;
}

/** 永続化された次回実行時刻を、起動時に待つ時間へ変換する。 */
export function getStartupStepDelayMs(
  nextStepTime: unknown,
  nowMs = Date.now(),
): number {
  if (typeof nextStepTime !== "string" || nextStepTime.trim() === "") return 0;

  const scheduledAt = Date.parse(nextStepTime);
  if (!Number.isFinite(scheduledAt)) return 0;

  return Math.min(Math.max(0, scheduledAt - nowMs), MAX_TIMEOUT_MS);
}

export function getNextStepTime(
  intervalMs: number,
  nowMs = Date.now(),
): string {
  return new Date(nowMs + intervalMs).toISOString();
}

/** 旧状態ではデプロイ時に実行せず、まず通常の1時間後を次回予定として確定する。 */
export function resolveStartupStepSchedule(
  nextStepTime: unknown,
  nowMs = Date.now(),
): StartupStepSchedule {
  if (
    typeof nextStepTime === "string"
    && Number.isFinite(Date.parse(nextStepTime))
  ) {
    return {
      nextStepTime,
      delayMs: getStartupStepDelayMs(nextStepTime, nowMs),
      needsPersistence: false,
    };
  }

  const initializedTime = getNextStepTime(DEFAULT_STEP_INTERVAL_MS, nowMs);
  return {
    nextStepTime: initializedTime,
    delayMs: DEFAULT_STEP_INTERVAL_MS,
    needsPersistence: true,
  };
}
