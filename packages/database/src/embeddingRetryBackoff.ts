/**
 * 埋め込みに失敗した行を、しばらく選ばないための記録（メモリ上）。
 *
 * 埋め込みワーカーは `embedding IS NULL` を新しい順に選ぶので、失敗した行は次の回も
 * 同じ組で選ばれる。2026-10-09 は長文の web_research を含む組が毎回時間切れになり、
 * 「時間切れ → cooldown → 同じ組で時間切れ」を1日130回繰り返した。その後ろの行は
 * いつまでも埋め込まれない。
 *
 * 失敗した行を指数的に待たせ、そのあいだは後ろの行へ進ませる。プロセスを再起動すれば
 * 忘れるが、そのときは1回試して失敗すれば再び待たせるだけなので害はない。
 */
export type EmbeddingRetryBackoff = {
  /** いま選んではいけない行か。 */
  blocked(key: string): boolean;
  /** 失敗を記録し、次に選べるまでの待ちを延ばす。 */
  fail(key: string): void;
  /** 成功したら記録を消す。 */
  succeed(key: string): void;
  /** 記録している行の数。取得件数をこの分だけ多めにして、待たせた行で枠が埋まらないようにする。 */
  size(): number;
};

export function createEmbeddingRetryBackoff(opts: {
  baseMs?: number;
  maxMs?: number;
  now?: () => number;
} = {}): EmbeddingRetryBackoff {
  const baseMs = opts.baseMs ?? 5 * 60_000;
  const maxMs = opts.maxMs ?? 60 * 60_000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { failures: number; until: number }>();

  return {
    blocked(key) {
      const entry = entries.get(key);
      return entry !== undefined && now() < entry.until;
    },
    fail(key) {
      const failures = (entries.get(key)?.failures ?? 0) + 1;
      const waitMs = Math.min(maxMs, baseMs * 2 ** (failures - 1));
      entries.set(key, { failures, until: now() + waitMs });
    },
    succeed(key) {
      entries.delete(key);
    },
    size() {
      // 失敗のあと削除・編集された行は二度と succeed されない。待ちが明けて
      // さらに maxMs 経ったものは忘れる（選ばれれば失敗1回目からやり直すだけ）。
      const t = now();
      for (const [key, entry] of entries) {
        if (t >= entry.until + maxMs) entries.delete(key);
      }
      return entries.size;
    },
  };
}
