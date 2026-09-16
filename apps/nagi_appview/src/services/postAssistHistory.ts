/**
 * ポストおたすけの短期履歴。直近に取り上げた話題とセリフを DID ごとにメモリへ置く。
 *
 * クライアントはモーダルを閉じるたびに `previous` を空へ戻すので、それだけでは
 * 開き直すたびに同じ話題・同じセリフへ戻ってしまう。そこでサーバー側でも数時間だけ覚えておく。
 *
 * 持つのは botたんが言ったセリフと話題キーだけで、書きかけの本文は持たない。
 * DB へは保存せず、プロセスが落ちれば消える（消えても話題がランダムに戻るだけ）。
 */

export type PostAssistTopicKind =
  | "affirmation"
  | "diary"
  | "whatDay"
  | "interest"
  | "news"
  | "relatedPost"
  | "question";

export type PostAssistHistoryEntry = {
  kind: PostAssistTopicKind;
  key: string;
  message: string;
  at: number;
};

export const POST_ASSIST_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
export const POST_ASSIST_HISTORY_PER_ACTOR = 10;
export const POST_ASSIST_HISTORY_MAX_ACTORS = 5_000;

type PostAssistHistoryOptions = {
  now?: () => number;
  ttlMs?: number;
  perActor?: number;
  maxActors?: number;
};

export class PostAssistHistory {
  private readonly entries = new Map<string, PostAssistHistoryEntry[]>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly perActor: number;
  private readonly maxActors: number;

  constructor(options: PostAssistHistoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? POST_ASSIST_HISTORY_TTL_MS;
    this.perActor = options.perActor ?? POST_ASSIST_HISTORY_PER_ACTOR;
    this.maxActors = options.maxActors ?? POST_ASSIST_HISTORY_MAX_ACTORS;
  }

  /** 期限内の履歴を古い順に返す。期限切れはここで捨てる。 */
  get(did: string): PostAssistHistoryEntry[] {
    const current = this.entries.get(did);
    if (!current) return [];
    const cutoff = this.now() - this.ttlMs;
    const kept = current.filter((entry) => entry.at > cutoff);
    if (!kept.length) this.entries.delete(did);
    else if (kept.length !== current.length) this.entries.set(did, kept);
    return kept;
  }

  record(did: string, entry: Omit<PostAssistHistoryEntry, "at">): void {
    const next = [...this.get(did), { ...entry, at: this.now() }].slice(-this.perActor);
    // 挿入し直して Map の末尾（＝いちばん最近）へ移し、溢れたら先頭（いちばん古い）から消す。
    this.entries.delete(did);
    this.entries.set(did, next);
    while (this.entries.size > this.maxActors) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
