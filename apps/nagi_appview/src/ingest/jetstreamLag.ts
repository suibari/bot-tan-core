/**
 * Jetstream の「繋がっているのに届かない」を検知する目印。
 *
 * 接続の生死だけを見ていると、上流のインスタンスが数十分遅れて配っている状態を
 * 正常と判定してしまう（2026-10-01、jetstream2.us-east が約52分遅れたまま接続は
 * 保たれていた）。イベントの time_us は配信側が送出時に付ける値で、このときも
 * 受信時刻との差は0だったため、遅延の物差しにならない。
 *
 * そこで、到着すべき時刻が分かっているイベントを目印にする。botたんは PDS へ書いた
 * 直後に internal API で AppView へ取り込みを依頼するので、その時点で
 * 「このレコードの commit がそのうち Jetstream から来るはず」と分かる。
 * Nagi のコレクションは流量が少なく「イベントが来ない」だけでは遅延と区別できないが、
 * この目印なら確実に比べられる。
 */

type Expected = {
  cid: string;
  /** 取り込み依頼を受けた時刻。遅延の起点。 */
  since: number;
  /** これを過ぎても届かなければ遅延とみなす。切り替えのたびに延長する。 */
  deadline: number;
  /** この目印が原因で遅延判定した回数。 */
  strikes: number;
};

export type OverdueWrite = { uri: string; waitedMs: number; strikes: number };

export type JetstreamLagSnapshot = {
  pendingBotWrites: number;
  oldestPendingMs?: number;
  lastBotWriteLagMs?: number;
  lastBotWriteSeenAt?: string;
  lastEventAt?: string;
};

export type JetstreamLagWatchOptions = {
  /** 目印にするのは botたんの書き込みだけ。他人のイベントは到着を覚えない。 */
  botDid: string;
  stallAfterMs: number;
  /** 何回切り替えても届かない目印は諦める（no-op の putRecord などで永久に来ない場合）。 */
  maxStrikes: number;
  now?: () => number;
};

/** 依頼より先に Jetstream が届いた場合に取りこぼさないため、直近の到着を覚えておく幅。 */
const RECENT_SEEN_MS = 10 * 60_000;
/** 想定外の大量登録でメモリを食わないための上限。 */
const MAX_PENDING = 500;

const key = (uri: string, cid: string) => `${uri}#${cid}`;

export class JetstreamLagWatch {
  private readonly pending = new Map<string, Expected>();
  private readonly recentlySeen = new Map<string, number>();
  private lastBotWriteLagMs: number | undefined;
  private lastBotWriteSeenAt: number | undefined;
  private lastEventAt: number | undefined;
  private readonly now: () => number;

  constructor(private readonly options: JetstreamLagWatchOptions) {
    this.now = options.now ?? Date.now;
  }

  /** botたんの書き込みを、Jetstream から届くべきものとして登録する。 */
  expect(uri: string, cid: string): void {
    const now = this.now();
    this.pruneSeen(now);
    if (this.recentlySeen.has(key(uri, cid))) return;
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(uri, {
      cid,
      since: now,
      deadline: now + this.options.stallAfterMs,
      strikes: 0,
    });
  }

  /** Jetstream から届いたイベントを1件ずつ渡す。 */
  observe(evt: any): void {
    const now = this.now();
    this.lastEventAt = now;
    const commit = evt?.commit;
    if (!commit || typeof evt.did !== "string") return;
    const uri = `at://${evt.did}/${commit.collection}/${commit.rkey}`;
    const cid = typeof commit.cid === "string" ? commit.cid : "";
    const expected = this.pending.get(uri);
    if (expected && (expected.cid === cid || commit.operation === "delete")) {
      this.pending.delete(uri);
      this.lastBotWriteLagMs = now - expected.since;
      this.lastBotWriteSeenAt = now;
      return;
    }
    if (cid && evt.did === this.options.botDid) {
      this.recentlySeen.set(key(uri, cid), now);
      this.pruneSeen(now);
    }
  }

  /** 期限を過ぎてもまだ届かない目印。古い順。 */
  overdue(): OverdueWrite[] {
    const now = this.now();
    return [...this.pending.entries()]
      .filter(([, expected]) => expected.deadline <= now)
      .sort(([, a], [, b]) => a.since - b.since)
      .map(([uri, expected]) => ({
        uri,
        waitedMs: now - expected.since,
        strikes: expected.strikes,
      }));
  }

  /**
   * 遅延が続いているか。期限切れの目印に加え、一度でも遅延判定の原因になって
   * 期限を延ばしてもらっている目印が残っていれば、まだ解消していない。
   */
  isLagging(): boolean {
    const now = this.now();
    for (const expected of this.pending.values())
      if (expected.strikes > 0 || expected.deadline <= now) return true;
    return false;
  }

  /**
   * 遅延と判定して手を打った（接続先を切り替えた）ことを記録し、期限を延ばす。
   * 切り替え直後の接続にも追いつく時間を与えるため。上限に達した目印は捨て、その URI を返す。
   */
  markStalled(): string[] {
    const now = this.now();
    const abandoned: string[] = [];
    for (const [uri, expected] of this.pending) {
      if (expected.deadline > now) continue;
      expected.strikes += 1;
      if (expected.strikes >= this.options.maxStrikes) {
        this.pending.delete(uri);
        abandoned.push(uri);
        continue;
      }
      expected.deadline = now + this.options.stallAfterMs;
    }
    return abandoned;
  }

  snapshot(): JetstreamLagSnapshot {
    const now = this.now();
    let oldest: number | undefined;
    for (const expected of this.pending.values())
      oldest = oldest === undefined ? expected.since : Math.min(oldest, expected.since);
    return {
      pendingBotWrites: this.pending.size,
      ...(oldest !== undefined ? { oldestPendingMs: now - oldest } : {}),
      ...(this.lastBotWriteLagMs !== undefined
        ? { lastBotWriteLagMs: this.lastBotWriteLagMs }
        : {}),
      ...(this.lastBotWriteSeenAt !== undefined
        ? { lastBotWriteSeenAt: new Date(this.lastBotWriteSeenAt).toISOString() }
        : {}),
      ...(this.lastEventAt !== undefined
        ? { lastEventAt: new Date(this.lastEventAt).toISOString() }
        : {}),
    };
  }

  private pruneSeen(now: number): void {
    for (const [seenKey, at] of this.recentlySeen) {
      if (now - at <= RECENT_SEEN_MS) break;
      this.recentlySeen.delete(seenKey);
    }
  }
}
