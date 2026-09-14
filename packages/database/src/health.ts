import { sql } from 'drizzle-orm';
import { bot_state, db } from './db.js';

/**
 * プロセス横断の死活監視。
 *
 * 各プロセスが `bot_state` の `health:<service>` へ定期的にハートビートを書き、
 * biorhythm_server がそれを読んで鮮度で状態を決める。プロセス間に HTTP を張らずに
 * 済み、監視対象が増えてもキーを1つ足すだけで拡張できる。
 */

export const HEALTH_KEY_PREFIX = 'health:';

/** UI のサービス監視タイルへ、biorhythm_server が集約する単位。 */
export type HealthService =
  | 'jetstream-bsky'
  | 'jetstream-nagi'
  | 'jetstream-appview'
  | 'bsky-bot'
  | 'nagi-bot'
  | 'nagi-appview'
  | 'local-llm'
  | 'gemini';

export type HealthState =
  /** 鮮度内にハートビートがあり、直近の失敗もない。 */
  | 'ok'
  /** ハートビートは届いているが古い。落ちかけ、あるいは処理が詰まっている。 */
  | 'stale'
  /** 応答がない、または直近の記録が失敗だった。 */
  | 'down'
  /** 一度も記録がない（デプロイ直後など）。 */
  | 'unknown'
  /** 環境変数が未設定で、そもそも動かす気がない。 */
  | 'unconfigured';

export interface HeartbeatRecord {
  /** 最後に何かを報告した時刻（成功・失敗を問わない）。 */
  at?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  /** サービス固有の補足（Jetstream のエンドポイントなど）。 */
  detail?: Record<string, unknown>;
}

/**
 * 既定の鮮度しきい値。ハートビート間隔（30秒）の3倍を過ぎたら stale、
 * 6倍で down とみなす。Jetstream のようにイベント駆動で報告するものは、
 * 呼び出し側が個別に緩める。
 */
export const DEFAULT_FRESH_MS = 90_000;
export const DEFAULT_DOWN_MS = 180_000;

/**
 * プロセス内の書き込み間引き。Jetstream のハートビートはイベントごとに呼ばれるため、
 * これがないと1秒に何度も UPDATE が飛ぶ。
 */
const THROTTLE_MS = 60_000;
const lastWriteAt = new Map<string, number>();

const shouldWrite = (throttleKey: string, force: boolean): boolean => {
  if (force) return true;
  const now = Date.now();
  const previous = lastWriteAt.get(throttleKey) ?? 0;
  if (now - previous < THROTTLE_MS) return false;
  lastWriteAt.set(throttleKey, now);
  return true;
};

/**
 * 部分更新を jsonb のマージで行う。読んでから書くと、成功と失敗が別プロセスから
 * 同時に来たときに片方を取りこぼすので、1文で済ませる。
 */
async function patchHealth(service: HealthService, patch: HeartbeatRecord): Promise<void> {
  const key = `${HEALTH_KEY_PREFIX}${service}`;
  try {
    await db
      .insert(bot_state)
      .values({ key, value: patch })
      .onConflictDoUpdate({
        target: bot_state.key,
        set: {
          value: sql`${bot_state.value} || ${JSON.stringify(patch)}::jsonb`,
          updated_at: new Date(),
        },
      });
  } catch (e) {
    // 監視の書き込み失敗で本来の処理を止めない。
    console.error(`[ERROR][HEALTH] Failed to report heartbeat for ${service}:`, e);
  }
}

/** 生きている、と報告する。60秒に1回までに間引かれる。 */
export async function reportHeartbeat(
  service: HealthService,
  detail?: Record<string, unknown>,
): Promise<void> {
  if (!shouldWrite(`${service}:ok`, false)) return;
  const at = new Date().toISOString();
  await patchHealth(service, { at, lastOkAt: at, ...(detail ? { detail } : {}) });
}

/**
 * 失敗した、と報告する。障害中は呼び出しが集中しがちなので同じく間引くが、
 * 最初の1回は必ず書けるよう成功側とは別のカウンタを使う。
 */
export async function reportHealthFailure(
  service: HealthService,
  error: unknown,
): Promise<void> {
  if (!shouldWrite(`${service}:error`, false)) return;
  const at = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  await patchHealth(service, { at, lastErrorAt: at, lastError: message.slice(0, 300) });
}

/** `health:*` をまとめて1クエリで読む。 */
export async function readHeartbeats(): Promise<Map<HealthService, HeartbeatRecord>> {
  const result = new Map<HealthService, HeartbeatRecord>();
  try {
    const rows = await db
      .select({ key: bot_state.key, value: bot_state.value })
      .from(bot_state)
      .where(sql`${bot_state.key} LIKE ${`${HEALTH_KEY_PREFIX}%`}`);

    for (const row of rows) {
      const service = row.key.slice(HEALTH_KEY_PREFIX.length) as HealthService;
      if (row.value && typeof row.value === 'object') {
        result.set(service, row.value as HeartbeatRecord);
      }
    }
  } catch (e) {
    console.error('[ERROR][HEALTH] Failed to read heartbeats:', e);
  }
  return result;
}

export interface ClassifyOptions {
  freshMs?: number;
  downMs?: number;
  now?: number;
}

/**
 * ハートビート1件を状態に落とす。
 *
 * 直近の記録が失敗なら、鮮度に関係なく down。「最後に成功したのがいつか」だけを
 * 見ると、エラーを返し続けている Gemini が ok に見えてしまう。
 */
export function classifyHeartbeat(
  record: HeartbeatRecord | undefined,
  options: ClassifyOptions = {},
): HealthState {
  if (!record) return 'unknown';

  const { freshMs = DEFAULT_FRESH_MS, downMs = DEFAULT_DOWN_MS, now = Date.now() } = options;
  const ms = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  const okAt = ms(record.lastOkAt);
  const errorAt = ms(record.lastErrorAt);

  if (errorAt !== undefined && (okAt === undefined || errorAt > okAt)) {
    // 失敗のあと成功していない。ただし十分に古い失敗は「もう誰も呼んでいない」だけ
    // かもしれないので、鮮度切れとして扱う。
    return now - errorAt <= downMs ? 'down' : 'stale';
  }

  if (okAt === undefined) return 'unknown';

  const age = now - okAt;
  if (age <= freshMs) return 'ok';
  if (age <= downMs) return 'stale';
  return 'down';
}

/** 複数プローブを1タイルに畳む。一番悪い状態が勝つ。 */
export function worstState(states: HealthState[]): HealthState {
  const rank: Record<HealthState, number> = {
    ok: 0,
    unconfigured: 1,
    unknown: 2,
    stale: 3,
    down: 4,
  };
  if (states.length === 0) return 'unknown';
  return states.reduce((worst, state) => (rank[state] > rank[worst] ? state : worst));
}
