import { and, count, eq, lt, sql } from "drizzle-orm";
import { db, drawing_claims } from "./db.js";

/**
 * botたんのお絵描き（Bluesky の依頼 / Nagi の依頼と贈り物）の日次枠。
 *
 * 絵は GPU 機のサイドカーが1枚ずつ直列に描く。同じ GPU に Ollama が常駐しているので、
 * 描いた枚数はそのままテキスト生成の遅延になる。そこで2段で縛る。
 *  - ユーザー枠: 面（bsky / nagi）ごとに、1人1日1枚。Nagi では依頼と贈り物で共通
 *  - サービス枠: 面ごとに1日 DRAWING_SERVICE_DAILY_LIMIT 枚（0 で機能ごと止める）
 *
 * **面ごとに分けている。** Nagi の絵には botたんの判断で届く贈り物があり、本人が頼んだものとは
 * 限らない。共通の枠にすると、Nagi で勝手に届いた絵が Bluesky での依頼の枠を食ってしまう。
 *
 * 「1日」は JST の暦日。24時間の窓にすると、昨夜に頼んだ人は今夜まで頼めなくなる。
 * day を文字列で持つのは、枠の判定に Date を一切使わないため（AGENTS.md の timestamp の規則）。
 */

export type DrawingSurface = "bsky" | "nagi";

export type DrawingClaimResult = {
  status: "claimed" | "user_limit" | "service_limit" | "disabled";
  /** JST の "YYYY-MM-DD"。描けなかったときに枠を返す（release）ためのキー。 */
  day: string;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SERVICE_DAILY_LIMIT = 30;
/** 枠の判定には当日分しか使わない。記録として少しだけ残して、古い行は枠取りのついでに消す。 */
const RETENTION_DAYS = 30;

/** JST の "YYYY-MM-DD"。サーバーのタイムゾーン設定に依存させないためオフセットで出す。 */
export const drawingDay = (now: Date = new Date()): string =>
  new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * 面ごとの1日の上限枚数。
 *
 * 壊れた値で throw しない。呼び出し元は投稿のハンドラで、throw すると機能のリトライが回り、
 * そのたびに LLM の判定までやり直すことになる。既定値へ倒して警告だけ残す。
 */
export function drawingServiceDailyLimit(raw = process.env.DRAWING_SERVICE_DAILY_LIMIT): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SERVICE_DAILY_LIMIT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    console.warn(
      `[WARN][DRAWING] DRAWING_SERVICE_DAILY_LIMIT=${raw} は非負の整数ではないので ${DEFAULT_SERVICE_DAILY_LIMIT} を使う`,
    );
    return DEFAULT_SERVICE_DAILY_LIMIT;
  }
  return value;
}

/**
 * 今日の枠を1つ取る。取れたら status: "claimed"。
 *
 * 描き終わってから記録するのではなく、**描く前に取る。** Jetstream のイベントは並行に届くので、
 * 後から記録すると、同じ人の連投で GPU を2回回してしまう。描けなかったときは
 * releaseDailyDrawing で返す。
 *
 * **同じ投稿で取り直したときは claimed を返す。** Nagi の返信ジョブは失敗するとリトライされ、
 * そのたびにここを通る。「今日はもう描いた」と返すと、自分の依頼で自分の枠を塞ぐことになる。
 */
export async function claimDailyDrawing(input: {
  surface: DrawingSurface;
  did: string;
  sourceUri?: string;
  now?: Date;
  serviceDailyLimit?: number;
}): Promise<DrawingClaimResult> {
  const now = input.now ?? new Date();
  const day = drawingDay(now);
  const limit = input.serviceDailyLimit ?? drawingServiceDailyLimit();
  if (limit === 0) return { status: "disabled", day };

  return db.transaction(async (tx): Promise<DrawingClaimResult> => {
    // 主キーだけではサービス枠を守れない（数えてから入れるまでの間に他の人が入る）。
    // 面ごとに直列にする。描く頻度は低いので、ロックの待ちは問題にならない。
    const lockKey = `drawing-claims-v1:${input.surface}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

    await tx
      .delete(drawing_claims)
      .where(
        and(
          eq(drawing_claims.surface, input.surface),
          lt(drawing_claims.day, drawingDay(new Date(now.getTime() - RETENTION_DAYS * DAY_MS))),
        ),
      );

    const [existing] = await tx
      .select({ sourceUri: drawing_claims.source_uri })
      .from(drawing_claims)
      .where(
        and(
          eq(drawing_claims.surface, input.surface),
          eq(drawing_claims.did, input.did),
          eq(drawing_claims.day, day),
        ),
      )
      .limit(1);
    if (existing) {
      const sameSource = Boolean(input.sourceUri) && existing.sourceUri === input.sourceUri;
      return { status: sameSource ? "claimed" : "user_limit", day };
    }

    const [usage] = await tx
      .select({ total: count() })
      .from(drawing_claims)
      .where(and(eq(drawing_claims.surface, input.surface), eq(drawing_claims.day, day)));
    if (Number(usage?.total ?? 0) >= limit) return { status: "service_limit", day };

    await tx.insert(drawing_claims).values({
      surface: input.surface,
      did: input.did,
      day,
      source_uri: input.sourceUri ?? null,
    });
    return { status: "claimed", day };
  });
}

/** 描けなかった・投稿できなかったときに枠を返す。本人がもう一度頼めるようにする。 */
export async function releaseDailyDrawing(input: {
  surface: DrawingSurface;
  did: string;
  day: string;
}): Promise<void> {
  await db
    .delete(drawing_claims)
    .where(
      and(
        eq(drawing_claims.surface, input.surface),
        eq(drawing_claims.did, input.did),
        eq(drawing_claims.day, input.day),
      ),
    );
}

/**
 * 今日もう描いたか。枠は取らない。
 *
 * Nagi の贈り物は、判定の LLM を回す前にこれで足切りする。すでに贈った人の投稿を
 * 毎回判定しても、枠が埋まっていて描けないので無駄になる。
 */
export async function hasDailyDrawing(input: {
  surface: DrawingSurface;
  did: string;
  now?: Date;
}): Promise<boolean> {
  const [row] = await db
    .select({ did: drawing_claims.did })
    .from(drawing_claims)
    .where(
      and(
        eq(drawing_claims.surface, input.surface),
        eq(drawing_claims.did, input.did),
        eq(drawing_claims.day, drawingDay(input.now)),
      ),
    )
    .limit(1);
  return Boolean(row);
}
