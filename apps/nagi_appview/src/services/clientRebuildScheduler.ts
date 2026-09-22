import { requestClientRebuild } from "@bsky-affirmative-bot/bot-runtime";

export const DEFAULT_CLIENT_REBUILD_MIN_INTERVAL_MS = 30 * 60 * 1000;

type RebuildRequest = (reason: string) => Promise<boolean>;
type TimerHandle = ReturnType<typeof setTimeout>;

export function parseClientRebuildMinIntervalMs(
  value = process.env.NAGI_CLIENT_REBUILD_MIN_INTERVAL_MS,
): number {
  if (value === undefined || value.trim() === "")
    return DEFAULT_CLIENT_REBUILD_MIN_INTERVAL_MS;
  const intervalMs = Number(value);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < DEFAULT_CLIENT_REBUILD_MIN_INTERVAL_MS
  )
    throw new Error(
      `NAGI_CLIENT_REBUILD_MIN_INTERVAL_MS must be an integer of at least ${DEFAULT_CLIENT_REBUILD_MIN_INTERVAL_MS}`,
    );
  return intervalMs;
}

/**
 * Sends the first rebuild immediately, then folds every change in the cooldown
 * window into one trailing rebuild. This bounds user-triggered Vercel builds
 * without making an ordinary article publication wait for the cooldown.
 *
 * AppView is the sole article indexer in production, so process-wide state is
 * enough to put one global ceiling over all authors. Vercel also deduplicates
 * repeated requests for the same hook/version as a second line of defence.
 */
export class ClientRebuildScheduler {
  private nextRequestAt = 0;
  private pendingCount = 0;
  private latestReason = "";
  private timer: TimerHandle | undefined;

  constructor(
    private readonly options: {
      minIntervalMs: number;
      request?: RebuildRequest;
      now?: () => number;
      setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
    },
  ) {}

  async notify(reason: string): Promise<"requested" | "coalesced"> {
    const now = (this.options.now ?? Date.now)();
    if (!this.timer && now >= this.nextRequestAt) {
      // Reserve the window before awaiting fetch so simultaneous mutations
      // cannot both pass the gate.
      this.nextRequestAt = now + this.options.minIntervalMs;
      await (this.options.request ?? requestClientRebuild)(reason);
      return "requested";
    }

    this.pendingCount += 1;
    this.latestReason = reason;
    if (!this.timer) {
      const setTimer = this.options.setTimer ?? setTimeout;
      this.timer = setTimer(
        () => {
          void this.flushPending().catch((error) =>
            console.error("[ERROR][DEPLOY_HOOK] trailing rebuild failed:", error),
          );
        },
        Math.max(0, this.nextRequestAt - now),
      );
      this.timer.unref?.();
    }
    return "coalesced";
  }

  private async flushPending(): Promise<void> {
    this.timer = undefined;
    if (this.pendingCount === 0) return;

    const count = this.pendingCount;
    const reason = this.latestReason;
    this.pendingCount = 0;
    this.latestReason = "";
    this.nextRequestAt =
      (this.options.now ?? Date.now)() + this.options.minIntervalMs;
    await (this.options.request ?? requestClientRebuild)(
      `${reason}; coalesced_changes=${count}`,
    );
  }
}

const articleRebuildScheduler = new ClientRebuildScheduler({
  minIntervalMs: parseClientRebuildMinIntervalMs(),
});

export const requestArticleClientRebuild = (reason: string) =>
  articleRebuildScheduler.notify(reason);
