import {
  db,
  followers,
  nagiCardCommentJobs,
  nagiCardDraws,
  nagiGuestCardDraws,
  nagiCardInstances,
  nagiAgeAssurance,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  anniversaryCardNumber,
  buildAnniversaryCardDef,
  CARD_DEFS,
  CARD_VOLUME_ANNIVERSARY,
  cardDrawDate,
  cardKey,
  isAnniversaryCard,
  nextCardDrawAt,
  parseAnniversaryCardNumber,
  resolveCardDef,
  resolveTodayAnniversaries,
  rollCard,
  SLOT_USER_ANNIVERSARY,
  type CardDefinition,
  type TodayAnniversary,
} from "@bsky-affirmative-bot/shared-configs";
import type {
  CardCollectionView,
  CardGachaSource,
  CardDrawStatus,
  CardView,
  DrawCardResult,
  GuestCardDrawResult,
  PendingAnniversary,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { createHash } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { verifyReactionCardTrigger } from "../services/reactionCardEligibility.js";
import { jstCalendarDate } from "../services/ageAssurance.js";

/**
 * 全肯定カード。カード定義そのもの（名前/フレーバー/ATK）は shared-configs の JSON が真実源で、
 * DB が持つのは「誰がどの1枚を持っているか」だけ。だから定義側の文言を直せば全ユーザーに即反映される。
 *
 * 抽選は必ずここ（サーバ側）で行う。クライアントに引かせると当然ながら AAR を自称できてしまう。
 */

export type InstanceRow = {
  id: string;
  cardVolume: number;
  cardNumber: number;
  commentJa: string | null;
  commentEn: string | null;
  duplicateCount: number;
  acquiredAt: Date;
  firstOwnerDid: string;
  anniversaryLabel: string | null;
};

/**
 * 定義 + 所持情報の合成。未所持でも定義部分は返す（コレクションの空き枠を描くため）。
 * カード定義はリポジトリに入っている静的データで秘密ではないので、伏せるのは UI の演出だけ。
 * export しているのはテストから直接叩くため。
 */
export const cardView = (
  def: CardDefinition & { anniversary?: boolean; year?: number },
  row?: InstanceRow,
): CardView => ({
  ...def,
  owned: !!row,
  ...(row
    ? {
        instanceId: row.id,
        ...(row.commentJa ? { commentJa: row.commentJa } : {}),
        ...(row.commentEn ? { commentEn: row.commentEn } : {}),
        duplicateCount: row.duplicateCount,
        acquiredAt: row.acquiredAt.toISOString(),
        firstOwnerDid: row.firstOwnerDid,
      }
    : {}),
});

const INSTANCE_COLUMNS = {
  id: nagiCardInstances.id,
  cardVolume: nagiCardInstances.cardVolume,
  cardNumber: nagiCardInstances.cardNumber,
  commentJa: nagiCardInstances.commentJa,
  commentEn: nagiCardInstances.commentEn,
  duplicateCount: nagiCardInstances.duplicateCount,
  acquiredAt: nagiCardInstances.acquiredAt,
  firstOwnerDid: nagiCardInstances.firstOwnerDid,
  anniversaryLabel: nagiCardInstances.anniversaryLabel,
} as const;

type OwnedCards = {
  /** 図鑑（通常段）の所持。コンプ率はこちらだけで数える。 */
  regular: Map<string, InstanceRow>;
  /** 記念日カード（volume 0）。取得の古い順。 */
  anniversary: InstanceRow[];
};

async function loadInstances(did: string): Promise<OwnedCards> {
  const rows = await db
    .select(INSTANCE_COLUMNS)
    .from(nagiCardInstances)
    .where(eq(nagiCardInstances.ownerDid, did));
  // 記念日カードは図鑑の枠を持たない別枠なので、ここで分けておく。混ぜると ownedCount が
  // 汚れてコンプ率が動いてしまう（記念日はコンプ率に数えない、が仕様）。
  const regular = new Map<string, InstanceRow>();
  const anniversary: InstanceRow[] = [];
  for (const row of rows) {
    if (isAnniversaryCard(row.cardVolume)) anniversary.push(row);
    else
      regular.set(cardKey({ volume: row.cardVolume, id: row.cardNumber }), row);
  }
  anniversary.sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime());
  return { regular, anniversary };
}

/** 所持している記念日カードを CardView に起こす。定義が引けない行（将来の削除など）は落とす。 */
function anniversaryViews(rows: InstanceRow[]): CardView[] {
  const views: CardView[] = [];
  for (const row of rows) {
    const { year, slot } = parseAnniversaryCardNumber(row.cardNumber);
    const def = buildAnniversaryCardDef(
      slot,
      year,
      row.anniversaryLabel ?? undefined,
    );
    if (def) views.push(cardView(def, row));
  }
  return views;
}

/**
 * 本日その人に配るべき記念日。ユーザー記念日は Bluesky 側と同じ followers の1行を見る
 * （Nagi とお部屋と Bluesky で同じ記念日を共有する）。
 */
async function loadTodayAnniversaries(
  did: string,
  now: Date,
): Promise<TodayAnniversary[]> {
  const [[follower], [profile], [ageAssurance]] = await Promise.all([
    db
      .select({
        name: followers.user_anniv_name,
        date: followers.user_anniv_date,
        isAnniv: followers.is_anniv,
      })
      .from(followers)
      .where(eq(followers.did, did))
      .limit(1),
    db
      .select({ createdAt: nagiProfiles.createdAt })
      .from(nagiProfiles)
      .where(eq(nagiProfiles.did, did))
      .limit(1),
    db
      .select({ birthDate: nagiAgeAssurance.birthDate })
      .from(nagiAgeAssurance)
      .where(eq(nagiAgeAssurance.did, did))
      .limit(1),
  ]);
  return resolveTodayAnniversaries(cardDrawDate(now), {
    userAnnivName: follower?.name,
    userAnnivDate: follower?.date,
    isAnnivEnabled: follower?.isAnniv !== 0,
    birthDate: ageAssurance?.birthDate,
    birthdayDateKey: jstCalendarDate(now),
    nagiCreatedAt: profile?.createdAt,
  });
}

const pendingView = (a: TodayAnniversary): PendingAnniversary => ({
  slot: a.slot,
  nameJa: a.nameJa,
  nameEn: a.nameEn,
  ...(a.art ? { art: a.art } : {}),
});

type TodayDraw = {
  source: CardGachaSource;
  cardVolume: number;
  cardNumber: number;
};

/** 本日ぶんの通常枠・リアクション枠。 */
async function loadTodayDraws(did: string, now: Date): Promise<TodayDraw[]> {
  return db
    .select({
      source: nagiCardDraws.drawSource,
      cardVolume: nagiCardDraws.cardVolume,
      cardNumber: nagiCardDraws.cardNumber,
    })
    .from(nagiCardDraws)
    .where(
      and(
        eq(nagiCardDraws.did, did),
        eq(nagiCardDraws.drawDate, cardDrawDate(now)),
      ),
    );
}

export function drawStatusOf(today: TodayDraw[], now: Date): CardDrawStatus {
  const myNagi = today.find((draw) => draw.source === "my_nagi");
  const reaction = today.find((draw) => draw.source === "reaction");
  return {
    // 旧クライアントが2枚目を通常ボタンから引こうとしないよう、canDrawは通常枠のまま。
    canDraw: !myNagi,
    nextDrawAt: nextCardDrawAt(now).toISOString(),
    ...(myNagi
      ? {
          todayCardVolume: myNagi.cardVolume,
          todayCardId: myNagi.cardNumber,
        }
      : {}),
    myNagi: {
      canDraw: !myNagi,
      ...(myNagi
        ? { cardVolume: myNagi.cardVolume, cardId: myNagi.cardNumber }
        : {}),
    },
    reaction: {
      canDraw: !reaction,
      ...(reaction
        ? { cardVolume: reaction.cardVolume, cardId: reaction.cardNumber }
        : {}),
    },
  };
}

const guestTokenHash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

function parseGuestToken(value: unknown, field = "deviceToken"): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 128)
    throw new ApiError(400, "invalid_request", `Invalid ${field}`);
  return value;
}

/**
 * DID の無い端末にも、通常枠と同じ定義・確率・JST 4:00 境界で1枚返す。
 * 同じ端末秘密と同じ日付の insert は一意索引へ収束するため、再送や二重押しでも同じカードになる。
 */
export async function drawGuestCard(input: unknown): Promise<GuestCardDrawResult> {
  const deviceToken = parseGuestToken(
    (input as { deviceToken?: unknown } | undefined)?.deviceToken,
  );
  const now = new Date();
  const drawDate = cardDrawDate(now);
  const expiresAt = nextCardDrawAt(now);
  const tokenHash = guestTokenHash(deviceToken);

  await db.delete(nagiGuestCardDraws).where(lt(nagiGuestCardDraws.expiresAt, now));
  const rolled = rollCard();
  const [created] = await db
    .insert(nagiGuestCardDraws)
    .values({
      deviceTokenHash: tokenHash,
      drawDate,
      cardVolume: rolled.volume,
      cardNumber: rolled.id,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: nagiGuestCardDraws.id });
  const [row] = await db
    .select({
      cardVolume: nagiGuestCardDraws.cardVolume,
      cardNumber: nagiGuestCardDraws.cardNumber,
      expiresAt: nagiGuestCardDraws.expiresAt,
    })
    .from(nagiGuestCardDraws)
    .where(
      and(
        eq(nagiGuestCardDraws.deviceTokenHash, tokenHash),
        eq(nagiGuestCardDraws.drawDate, drawDate),
        gt(nagiGuestCardDraws.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError(409, "conflict", "Guest draw is being processed");
  const def = resolveCardDef(row.cardVolume, row.cardNumber);
  if (!def) throw new ApiError(500, "internal_error", "Unknown guest card");
  return {
    card: cardView(def),
    source: "my_nagi",
    alreadyDrawn: !created,
    isNew: true,
    commentPending: false,
    drawStatus: {
      ...drawStatusOf(
        [
          {
            source: "my_nagi",
            cardVolume: row.cardVolume,
            cardNumber: row.cardNumber,
          },
        ],
        now,
      ),
      // リアクション枠はサインインした本人のPDS検証が必要なので、ゲスト表示では案内しない。
      reaction: { canDraw: false },
    },
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * 指定ユーザーのコレクション。未所持のカードも定義だけ返す（何が埋まっていないかを見せたい）。
 * 所持状況は公開情報なので誰から見ても同じ内容を返すが、drawStatus は本人にしか付けない。
 */
export async function getCards(
  actor: string,
  viewerDid?: string,
): Promise<CardCollectionView> {
  if (!/^did:(plc|web):/.test(actor))
    throw new ApiError(400, "invalid_request", "actor must be a DID");

  const now = new Date();
  const isSelf = !!viewerDid && viewerDid === actor;
  const [owned, todayDraws, today] = await Promise.all([
    loadInstances(actor),
    isSelf ? loadTodayDraws(actor, now) : Promise.resolve([]),
    isSelf ? loadTodayAnniversaries(actor, now) : Promise.resolve([]),
  ]);

  // 並びは CARD_DEFS の順（= 図鑑の順）。所持状況で並べ替えないこと。
  const cards = CARD_DEFS.map((def) =>
    cardView(def, owned.regular.get(cardKey(def))),
  );
  const anniversaryCards = anniversaryViews(owned.anniversary);
  // 「まだ受け取っていない」の判定は所持カードの差集合で出す。card_draws を使わないので、
  // これがそのまま自動モーダルを出すかどうかの根拠になる。
  const held = new Set(owned.anniversary.map((r) => r.cardNumber));
  const pending = today.filter(
    (a) => !held.has(anniversaryCardNumber(a.year, a.slot)),
  );

  return {
    cards,
    // 記念日カードは図鑑の枠外なので ownedCount / totalCount には数えない（コンプ率を動かさない）。
    ownedCount: owned.regular.size,
    totalCount: CARD_DEFS.length,
    ...(isSelf
      ? {
          drawStatus: drawStatusOf(todayDraws, now),
        }
      : {}),
    ...(anniversaryCards.length ? { anniversaryCards } : {}),
    ...(isSelf ? { pendingAnniversary: pending.map(pendingView) } : {}),
  };
}

/**
 * 本日ぶんの記念日カードを受け取る。ガチャではないので抽選もしないし、1日1回の枠も消費しない。
 *
 * 「同じ記念日は1年に1枚」は card_instances の一意索引 (owner_did, card_volume, card_number)
 * だけで担保する。card_number に西暦が入っているので、日次ロック（card_draws）は要らない。
 * 同時押しでも onConflictDoNothing で片方に収束し、二重に配られることはない。
 *
 * 同じ日に複数の記念日が重なる（例: ハロウィン + ユーザー記念日）ことがあるので、
 * 未受領ぶんはまとめて配って cards に全部返す。
 */
export async function claimAnniversaryCards(
  viewerDid: string,
): Promise<DrawCardResult> {
  const now = new Date();
  const today = await loadTodayAnniversaries(viewerDid, now);
  if (!today.length)
    throw new ApiError(400, "invalid_request", "Today is not an anniversary");

  const claimed = await db.transaction(async (tx) => {
    const rows: InstanceRow[] = [];
    for (const anniversary of today) {
      const [instance] = await tx
        .insert(nagiCardInstances)
        .values({
          cardVolume: CARD_VOLUME_ANNIVERSARY,
          cardNumber: anniversaryCardNumber(anniversary.year, anniversary.slot),
          ownerDid: viewerDid,
          firstOwnerDid: viewerDid,
          // ユーザー記念日だけ、受け取った時点の名前を焼き付ける（あとで改名されても変わらない）。
          anniversaryLabel:
            anniversary.slot === SLOT_USER_ANNIVERSARY
              ? (anniversary.label ?? null)
              : null,
        })
        // 記念日カードに重複という概念は無いので、既に持っていれば何もしない
        // （duplicate_count を上げないし、コメントも作り直さない）。
        .onConflictDoNothing()
        .returning(INSTANCE_COLUMNS);
      if (!instance) continue;
      rows.push(instance);
      await tx
        .insert(nagiCardCommentJobs)
        .values({ instanceId: instance.id })
        .onConflictDoNothing();
    }
    return rows;
  });

  const [owned, todayDraws] = await Promise.all([
    loadInstances(viewerDid),
    loadTodayDraws(viewerDid, now),
  ]);
  const drawStatus = drawStatusOf(todayDraws, now);

  // 全部受け取り済みだった場合は、エラーにせず本日ぶんの記念日カードをそのまま返す
  // （通常枠と同じ冪等方針。リロードしても「今日の1枚」が見えるほうが UI が素直）。
  const numbers = new Set(
    (claimed.length ? claimed : []).map((r) => r.cardNumber),
  );
  const todayNumbers = new Set(
    today.map((a) => anniversaryCardNumber(a.year, a.slot)),
  );
  const rows = claimed.length
    ? owned.anniversary.filter((r) => numbers.has(r.cardNumber))
    : owned.anniversary.filter((r) => todayNumbers.has(r.cardNumber));
  const cards = anniversaryViews(rows);
  if (!cards.length)
    throw new ApiError(500, "internal_error", "Anniversary card is missing");

  return {
    card: cards[0],
    cards,
    source: "anniversary",
    alreadyDrawn: !claimed.length,
    isNew: !!claimed.length,
    commentPending: cards.some((c) => !c.commentJa),
    drawStatus,
  };
}

/**
 * 通常枠・リアクション枠を1日各1回引く。
 *
 * 「今日引いたか」の判定はアプリ側の事前チェックではなく、card_draws の主キー
 * (did, draw_date, draw_source) の一意索引への衝突で行う。同時押しや二重送信でも各枠1回に収束するため。
 * 既に引いていた場合はエラーにせず、その日のカードをそのまま返す（updateSeen / setMute と
 * 同じ冪等方針。リロードしても「今日のカード」が見えるほうが UI が素直になる）。
 */
export async function drawCard(
  viewerDid: string,
  source: CardGachaSource = "my_nagi",
  reactionUri?: string,
  guestToken?: string,
): Promise<DrawCardResult> {
  const now = new Date();
  const drawDate = cardDrawDate(now);
  const normalizedGuestToken =
    guestToken === undefined ? undefined : parseGuestToken(guestToken, "guestToken");
  if (normalizedGuestToken && source !== "my_nagi")
    throw new ApiError(
      400,
      "invalid_request",
      "guestToken is only valid for my_nagi draws",
    );
  if (source === "reaction") {
    if (!reactionUri)
      throw new ApiError(
        400,
        "invalid_request",
        "reactionUri is required for reaction draws",
      );
    await verifyReactionCardTrigger(viewerDid, reactionUri, now);
  } else if (reactionUri) {
    throw new ApiError(
      400,
      "invalid_request",
      "reactionUri is only valid for reaction draws",
    );
  }

  const result = await db.transaction(async (tx) => {
    let rolled = rollCard();
    let guestDrawId: string | undefined;
    if (normalizedGuestToken) {
      const [guest] = await tx
        .select({
          id: nagiGuestCardDraws.id,
          cardVolume: nagiGuestCardDraws.cardVolume,
          cardNumber: nagiGuestCardDraws.cardNumber,
        })
        .from(nagiGuestCardDraws)
        .where(
          and(
            eq(nagiGuestCardDraws.deviceTokenHash, guestTokenHash(normalizedGuestToken)),
            eq(nagiGuestCardDraws.drawDate, drawDate),
            gt(nagiGuestCardDraws.expiresAt, now),
            isNull(nagiGuestCardDraws.claimedByDid),
          ),
        )
        .limit(1)
        .for("update");
      if (!guest)
        throw new ApiError(404, "not_found", "Guest card has expired or was claimed");
      const def = resolveCardDef(guest.cardVolume, guest.cardNumber);
      if (!def) throw new ApiError(500, "internal_error", "Unknown guest card");
      rolled = def;
      guestDrawId = guest.id;
    }

    // 1) まず日次ロックを取りに行く。ON CONFLICT DO NOTHING なので同時押しでも例外にならず、
    //    行が返らなかった側が「既に引いていた」経路へ落ちる。事前 SELECT で判定すると
    //    二重送信で両方が通過してしまうため、必ず insert の衝突で判定すること。
    const [won] = await tx
      .insert(nagiCardDraws)
      .values({
        did: viewerDid,
        drawDate,
        drawSource: source,
        triggerUri: source === "reaction" ? reactionUri : null,
        cardVolume: rolled.volume,
        cardNumber: rolled.id,
      })
      .onConflictDoNothing()
      .returning({ cardNumber: nagiCardDraws.cardNumber });

    if (!won) {
      const [existing] = await tx
        .select({
          cardVolume: nagiCardDraws.cardVolume,
          cardNumber: nagiCardDraws.cardNumber,
        })
        .from(nagiCardDraws)
        .where(
          and(
            eq(nagiCardDraws.did, viewerDid),
            eq(nagiCardDraws.drawDate, drawDate),
            eq(nagiCardDraws.drawSource, source),
          ),
        )
        .limit(1);
      if (!existing)
        throw new ApiError(409, "conflict", "Draw is being processed");
      // ゲストカードは通常枠そのもの。アカウント側で同日の通常枠を既に引いていたら、
      // カードの種類にかかわらずゲスト分は破棄扱いにし、既存カードだけを返す。
      // ここで2枚目を所持化しないことで、サインアウトを使った追加取得を防ぐ。
      if (guestDrawId)
        await tx
          .update(nagiGuestCardDraws)
          .set({ claimedByDid: viewerDid, claimedAt: now })
          .where(eq(nagiGuestCardDraws.id, guestDrawId));
      return {
        card: { volume: existing.cardVolume, id: existing.cardNumber },
        source,
        alreadyDrawn: true,
        isNew: false,
      };
    }

    // 2) ロックを取れた側だけがコレクションを更新する。
    //    同種の引き直しは行を増やさず duplicate_count を上げ、コメントは一旦クリアして
    //    生成し直させる（「同種カードを引いた場合、コメントは上書き」の仕様）。
    const [instance] = await tx
      .insert(nagiCardInstances)
      .values({
        cardVolume: rolled.volume,
        cardNumber: rolled.id,
        ownerDid: viewerDid,
        firstOwnerDid: viewerDid,
      })
      .onConflictDoUpdate({
        target: [
          nagiCardInstances.ownerDid,
          nagiCardInstances.cardVolume,
          nagiCardInstances.cardNumber,
        ],
        set: {
          duplicateCount: sql`${nagiCardInstances.duplicateCount} + 1`,
          acquiredAt: new Date(),
          commentJa: null,
          commentEn: null,
          commentModel: null,
          commentPromptVersion: null,
        },
      })
      .returning({
        id: nagiCardInstances.id,
        duplicateCount: nagiCardInstances.duplicateCount,
      });

    // 3) ドロー履歴に実体を紐づける（1 の時点では instance がまだ無いので後埋め）。
    await tx
      .update(nagiCardDraws)
      .set({ instanceId: instance.id })
      .where(
        and(
          eq(nagiCardDraws.did, viewerDid),
          eq(nagiCardDraws.drawDate, drawDate),
          eq(nagiCardDraws.drawSource, source),
        ),
      );

    // 4) コメント生成は Gemini 呼び出しなので同期では待たない。nagi_bot_server の
    // NagiCardCommentWorker が拾う（自動分析と同じ「enqueue は AppView / worker は bot」構成）。
    await tx
      .insert(nagiCardCommentJobs)
      .values({ instanceId: instance.id })
      .onConflictDoUpdate({
        target: nagiCardCommentJobs.instanceId,
        set: {
          state: "pending",
          attempts: 0,
          leaseExpiresAt: null,
          nextAttemptAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      });

    if (guestDrawId)
      await tx
        .update(nagiGuestCardDraws)
        .set({ claimedByDid: viewerDid, claimedAt: now })
        .where(eq(nagiGuestCardDraws.id, guestDrawId));

    return {
      card: { volume: rolled.volume, id: rolled.id },
      source,
      alreadyDrawn: false,
      isNew: instance.duplicateCount === 1,
    };
  });

  const [owned, todayDraws] = await Promise.all([
    loadInstances(viewerDid),
    loadTodayDraws(viewerDid, now),
  ]);
  const def = resolveCardDef(result.card.volume, result.card.id);
  if (!def)
    // 定義から消えた番号が draws に残っているケース。番号は変更禁止なので通常起きない。
    throw new ApiError(
      500,
      "internal_error",
      `unknown card v${result.card.volume}-${result.card.id}`,
    );
  const row = owned.regular.get(cardKey(result.card));

  return {
    card: cardView(def, row),
    source: result.source,
    alreadyDrawn: result.alreadyDrawn,
    isNew: result.isNew,
    commentPending: !row?.commentJa,
    drawStatus: drawStatusOf(todayDraws, now),
  };
}
