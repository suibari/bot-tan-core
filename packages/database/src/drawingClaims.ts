import { and, count, eq, lt, sql } from "drizzle-orm";
import { db, drawing_claims } from "./db.js";

/**
 * botたんが絵を描くときの日次サービス枠。
 *
 * 絵は GPU 機のサイドカーが1枚ずつ直列に描く。同じ GPU に Ollama が常駐しているので、
 * 描いた枚数はそのままテキスト生成の遅延になる。**GPU は面も用途も区別しない**ので、
 * 枠は面ごとではなく全体で1本、1日 DRAWING_SERVICE_DAILY_LIMIT 枚として数える
 * （0 でお絵描きと占いを止める）。surface は記録用のラベルとして残す。
 *
 * 数える対象はサイドカーを回すすべての経路。
 *  - お絵描き（Bluesky の依頼 / Nagi の依頼と贈り物）: 枠が無ければ描かない
 *  - 占いの背景: 枠が無ければ固定背景へ戻る
 *  - おやすみポストの絵: botたん自身の定期投稿なので **必ず描く**。枠は消費するが
 *    上限では止めない（bypassServiceLimit）。止めると毎晩の絵が人の依頼次第で欠ける。
 *
 * 本人からの依頼にユーザーごとの日次上限はないが、Nagi の自動プレゼントだけは1人1日1枚にする。
 *
 * 「1日」は JST の暦日。24時間の窓にすると、昨夜に頼んだ人は今夜まで頼めなくなる。
 * day を文字列で持つのは、枠の判定に Date を一切使わないため（AGENTS.md の timestamp の規則）。
 */

/** 記録用のラベル。枠の数え方には影響しない（全体で1本）。"scheduled" は定期投稿の絵。 */
export type DrawingSurface = "bsky" | "nagi" | "scheduled";
export type DrawingKind = "request" | "gift";

/** 本人の依頼は無制限、Nagi の自動プレゼントだけを日次制限する。 */
export const hasDrawingUserDailyLimit = (kind: DrawingKind): boolean => kind === "gift";

export type DrawingClaimResult = {
  status: "claimed" | "user_limit" | "service_limit" | "disabled";
  /** JST の "YYYY-MM-DD"。描けなかったときに枠を返す（release）ためのキー。 */
  day: string;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 1枚60秒として、GPU が絵に取られるのが1日の半分（12時間 = 720枚）までなら、
 * 同居する Ollama の遅延は許容できるという見立て。上限は「GPU を占有しすぎない」ための
 * 運用上の歯止めであって、1日に何人が頼めるかを決める数ではない。
 */
const DEFAULT_SERVICE_DAILY_LIMIT = 720;
/** 枠の判定には当日分しか使わない。記録として少しだけ残して、古い行は枠取りのついでに消す。 */
const RETENTION_DAYS = 30;

/** JST の "YYYY-MM-DD"。サーバーのタイムゾーン設定に依存させないためオフセットで出す。 */
export const drawingDay = (now: Date = new Date()): string =>
  new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * 1日の上限枚数。面も用途もまとめて全体で1本の枠。
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
 * 後から記録するとサービス上限を超えて GPU を回してしまう。描けなかったときは
 * releaseDailyDrawing で返す。
 *
 * **同じ投稿で取り直したときは claimed を返す。** Nagi の返信ジョブは失敗するとリトライされ、
 * そのたびにここを通る。「今日はもう描いた」と返すと、自分の依頼で自分の枠を塞ぐことになる。
 */
export async function claimDailyDrawing(input: {
  surface: DrawingSurface;
  did: string;
  sourceUri: string;
  kind?: DrawingKind;
  now?: Date;
  serviceDailyLimit?: number;
  /**
   * 枠は消費するが、上限でも止めない。おやすみポストの絵だけがこれを使う。
   * 0（機能停止）も素通りする。`.env.example` が「0 はおやすみポストの絵に影響しない」と
   * 書いているとおりで、止めるとその日の定期投稿から絵が消える。
   */
  bypassServiceLimit?: boolean;
}): Promise<DrawingClaimResult> {
  const now = input.now ?? new Date();
  const day = drawingDay(now);
  const limit = input.serviceDailyLimit ?? drawingServiceDailyLimit();
  const kind = input.kind ?? "request";
  if (limit === 0 && !input.bypassServiceLimit) return { status: "disabled", day };

  return db.transaction(async (tx): Promise<DrawingClaimResult> => {
    // 主キーだけではサービス枠を守れない（数えてから入れるまでの間に他の人が入る）。
    // 枠は全体で1本なので、面をまたいで直列にする。描く頻度は低いので、ロックの待ちは
    // 問題にならない。
    const lockKey = "drawing-claims-v1:all";
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

    await tx
      .delete(drawing_claims)
      .where(lt(drawing_claims.day, drawingDay(new Date(now.getTime() - RETENTION_DAYS * DAY_MS))));

    const [existing] = await tx
      .select({ sourceUri: drawing_claims.source_uri })
      .from(drawing_claims)
      .where(
        and(
          eq(drawing_claims.surface, input.surface),
          eq(drawing_claims.day, day),
          eq(drawing_claims.source_uri, input.sourceUri),
        ),
      )
      .limit(1);
    if (existing) return { status: "claimed", day };

    // 自動で贈る絵だけは1人1日1枚。本人からの依頼とは別に数える。
    if (hasDrawingUserDailyLimit(kind)) {
      const [gift] = await tx
        .select({ sourceUri: drawing_claims.source_uri })
        .from(drawing_claims)
        .where(
          and(
            eq(drawing_claims.did, input.did),
            eq(drawing_claims.day, day),
            eq(drawing_claims.kind, "gift"),
          ),
        )
        .limit(1);
      if (gift) return { status: "user_limit", day };
    }

    // 面で絞らない。GPU の混み具合を見るための枠なので、どの面の何の絵でも1枚は1枚。
    const [usage] = await tx
      .select({ total: count() })
      .from(drawing_claims)
      .where(eq(drawing_claims.day, day));
    if (!input.bypassServiceLimit && Number(usage?.total ?? 0) >= limit) {
      return { status: "service_limit", day };
    }

    await tx.insert(drawing_claims).values({
      surface: input.surface,
      did: input.did,
      day,
      source_uri: input.sourceUri,
      kind,
    });
    return { status: "claimed", day };
  });
}

/** Nagi の自動プレゼントを今日すでに贈ったか。枠は取らない。 */
export async function hasDailyDrawingGift(input: {
  did: string;
  now?: Date;
}): Promise<boolean> {
  const [row] = await db
    .select({ did: drawing_claims.did })
    .from(drawing_claims)
    .where(
      and(
        eq(drawing_claims.surface, "nagi"),
        eq(drawing_claims.did, input.did),
        eq(drawing_claims.day, drawingDay(input.now)),
        eq(drawing_claims.kind, "gift"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** 描けなかった・投稿できなかったときに枠を返す。本人がもう一度頼めるようにする。 */
export async function releaseDailyDrawing(input: {
  surface: DrawingSurface;
  sourceUri: string;
  day: string;
}): Promise<void> {
  await db
    .delete(drawing_claims)
    .where(
      and(
        eq(drawing_claims.surface, input.surface),
        eq(drawing_claims.source_uri, input.sourceUri),
        eq(drawing_claims.day, input.day),
      ),
    );
}
