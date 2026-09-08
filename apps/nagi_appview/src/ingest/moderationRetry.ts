/**
 * 判定1件ごとの再試行台帳。
 *
 * OpenAI が「この画像を取りに行けなかった」と返す失敗は、サービス障害ではなく
 * その1件だけの問題なので、バッチ全体を止めずに間隔をあけて粘る。ただし無限に
 * 粘ると、取得できない画像1件が indexed_at DESC の上位に居座り続けてワーカー全体を
 * 止めてしまう（実際に reject-invalid になった投稿はどちらも画像取得の一時失敗だった）。
 * そこで予算を切り、使い切ったら reject-invalid へ落とす。
 *
 * ワーカーは専用ジョブ表を持たない方針（NULL 列スキャンで新規・バックフィル・編集を
 * すべて同じ経路に乗せる）なので、この台帳もメモリに置く。再起動で忘れるが、忘れた
 * 場合は予算が振り出しに戻るだけで実害は無い。
 *
 * config も DB も import しないこと。ここが純粋なままだと単体テストが環境変数無しで走る。
 */

/**
 * 再試行の待ち時間。失敗1回目のあと30秒、2回目のあと1分…と空ける。
 * 5回の再試行で合計およそ15分半粘ってから諦める（初回を含めて最大6回判定を試みる）。
 */
export const MODERATION_RETRY_DELAYS_MS = [
  30_000,
  60_000,
  120_000,
  240_000,
  480_000,
] as const;

/** 予算として認める再試行回数。初回の判定はこれに含まない。 */
export const MODERATION_MAX_RETRIES = MODERATION_RETRY_DELAYS_MS.length;

/**
 * 台帳のキー。cid（プロフィール行は内容ハッシュ）を含めるので、内容が変われば
 * 別キーになる＝編集で予算が自動的にリセットされる。
 */
export const moderationRetryKey = (uri: string, cid: string): string =>
  `${uri}\t${cid}`;

/** 予算を使い切ったあとも残ると無駄なので、総予算より十分長い所で捨てる。 */
const ENTRY_TTL_MS = 60 * 60_000;
/** 想定外に膨らんだときの最後の防波堤。古い順に落とす。 */
const MAX_ENTRIES = 2_000;

export type RetryState = {
  /** 何回目の失敗か。1 が最初の失敗。 */
  failures: number;
  /** 次に判定してよい時刻。exhausted のときは意味を持たない。 */
  nextAttemptAt: number;
  /** 予算を使い切ったか。呼び出し側はここで reject-invalid を確定させる。 */
  exhausted: boolean;
};

type Entry = { failures: number; nextAttemptAt: number; touchedAt: number };

export class ModerationRetryLedger {
  private readonly entries = new Map<string, Entry>();

  /** 今この item を判定してよいか。台帳に無ければ常に true。 */
  ready(key: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(key);
    return !entry || entry.nextAttemptAt <= now;
  }

  /** 入力取得に失敗した。失敗回数を1つ進めて次回時刻を決める。 */
  record(key: string, now: number = Date.now()): RetryState {
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    const delay = MODERATION_RETRY_DELAYS_MS[failures - 1];
    if (delay === undefined) {
      // 予算切れ。ここで台帳から外し、呼び出し側が reject-invalid を確定させる。
      this.entries.delete(key);
      return { failures, nextAttemptAt: now, exhausted: true };
    }
    const nextAttemptAt = now + delay;
    this.entries.set(key, { failures, nextAttemptAt, touchedAt: now });
    this.prune(now);
    return { failures, nextAttemptAt, exhausted: false };
  }

  /** 判定が通った item を台帳から外す。 */
  clear(key: string): void {
    this.entries.delete(key);
  }

  /** 待機中の item のうち最も早い再試行時刻。次周回までの待ち時間に使う。 */
  earliestDeferredAt(now: number = Date.now()): number | undefined {
    let earliest: number | undefined;
    for (const entry of this.entries.values())
      if (
        entry.nextAttemptAt > now &&
        (earliest === undefined || entry.nextAttemptAt < earliest)
      )
        earliest = entry.nextAttemptAt;
    return earliest;
  }

  /** 削除された投稿・cid が変わった行の残骸を捨てる。無制限に太らせない。 */
  prune(now: number = Date.now()): void {
    for (const [key, entry] of this.entries)
      if (now - entry.touchedAt > ENTRY_TTL_MS) this.entries.delete(key);
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries].sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt,
    );
    for (const [key] of oldest.slice(0, this.entries.size - MAX_ENTRIES))
      this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
