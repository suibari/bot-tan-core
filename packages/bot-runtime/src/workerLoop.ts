/**
 * 定期ワーカーの tick を回す共通ループ。
 *
 * **前の tick が終わるまで次を起こさない。** `setInterval` は前回の完了を待たないので、
 * 素で書くと「1回の処理時間 ÷ 間隔」本が同時に走る。キューワーカーは1件ずつ掴む
 * 作りなので、溜まったジョブを一気に並列で処理してしまい、Ollama のような
 * 共有資源を間隔に反比例した本数で殴ることになる。
 *
 * 掴み取りのリース（`state`/`lease_expires_at`）はプロセスをまたぐ重複を防ぐためのもので、
 * 同一プロセス内の多重起動は止められない（別の行を掴むだけ）。だからここで塞ぐ。
 */
export interface WorkerLoopOptions {
  /** ログの識別子。`[ERROR][<name>]` として出す。 */
  name: string;
  intervalMs: number;
  /** 戻り値は使わない。定期実行と単発呼び出しで同じ関数をそのまま渡せるようにしている。 */
  tick: () => Promise<unknown>;
  /** 起動直後に一度回す。既定は最初の間隔を待つ。 */
  immediate?: boolean;
}

export function startWorkerLoop({
  name,
  intervalMs,
  tick,
  immediate,
}: WorkerLoopOptions): NodeJS.Timeout {
  let inFlight = false;
  // 例外を内側で受け切るので、呼び出し側は void で捨ててよい。
  const fire = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await tick();
    } catch (error) {
      console.error(`[ERROR][${name}] worker tick failed:`, error);
    } finally {
      inFlight = false;
    }
  };

  if (immediate) void fire();
  return setInterval(() => void fire(), intervalMs);
}
