import {
  db,
  nagiCardBoardStock,
  nagiCardCommentJobs,
  nagiCardInstances,
  nagiNotifications,
  nagiZennyBalances,
  nagiZennyLedger,
  RECEIVED_FROM_ANONYMOUS,
} from "@bsky-affirmative-bot/database";
import {
  CARD_DEFS,
  CARD_SHELF_AAR_PRICE,
  cardDrawDate,
  cardKey,
  donatableCount,
  isAnniversaryCard,
  resolveCardDef,
  ZENNY_PER_CARD,
  ZENNY_WELCOME,
  zenkatsuAvailability,
  type CardDefinition,
  type ZenkatsuHolding,
} from "@bsky-affirmative-bot/shared-configs";
import type {
  CardBoardEntry,
  CardBoardView,
  CardView,
  DonateCardsResult,
  DonatedCard,
  TakeBoardCardResult,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { randomInt } from "node:crypto";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import { dispatchPush } from "../services/pushDispatch.js";
import { cardView, INSTANCE_COLUMNS, loadReceivedFrom } from "./cards.js";
import { loadRecentPlays, type DbLike } from "./zenkatsu.js";

/**
 * おすそわけボード。だぶったカードを置いて Ƶ を受け取り、未所持のカードを Ƶ で受け取る。
 * 決定の経緯は docs/zenkatsu.md 13章。
 *
 * カードと同じく AppView が権威で、PDS レコードは書かない。受け渡しは2人の所持にまたがるので、
 * 1トランザクションの中で「減らす・増やす・Ƶ を動かす・台帳を書く」をまとめて行う。
 */

type CardRef = { volume: number; id: number };

function parseCardRef(value: unknown): CardRef {
  const ref = value as { volume?: unknown; id?: unknown } | undefined;
  if (!Number.isInteger(ref?.volume) || !Number.isInteger(ref?.id))
    throw new ApiError(400, "invalid_request", "card must be { volume, id }");
  return { volume: ref!.volume as number, id: ref!.id as number };
}

/** ボードで扱えるカード。記念日カードは持ち主ごとのカードなので対象外。 */
function boardCardDef(ref: CardRef): CardDefinition {
  const def = isAnniversaryCard(ref.volume)
    ? undefined
    : resolveCardDef(ref.volume, ref.id);
  if (!def) throw new ApiError(400, "invalid_request", "Unknown card");
  return def;
}

/** 残高に Ƶ を足す（引くときは負の値）。行が無ければ作る。CHECK が負の残高を弾く。 */
async function addBalance(tx: DbLike, did: string, delta: number) {
  // 引くときは upsert にしない。Postgres は ON CONFLICT より先に「挿入しようとした行」
  // （残高 = delta < 0）で CHECK を評価するので、行があっても必ず違反になる。
  if (delta < 0) {
    const [row] = await tx
      .update(nagiZennyBalances)
      .set({
        balance: sql`${nagiZennyBalances.balance} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(nagiZennyBalances.did, did))
      .returning({ balance: nagiZennyBalances.balance });
    if (!row) throw new ApiError(409, "insufficient_zenny", "Not enough Ƶ");
    return row.balance;
  }
  const [row] = await tx
    .insert(nagiZennyBalances)
    .values({ did, balance: delta })
    .onConflictDoUpdate({
      target: nagiZennyBalances.did,
      set: {
        balance: sql`${nagiZennyBalances.balance} + ${delta}`,
        updatedAt: new Date(),
      },
    })
    .returning({ balance: nagiZennyBalances.balance });
  return row.balance;
}

async function readBalance(handle: DbLike, did: string, lock = false) {
  const query = handle
    .select({ balance: nagiZennyBalances.balance })
    .from(nagiZennyBalances)
    .where(eq(nagiZennyBalances.did, did))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row?.balance ?? 0;
}

/**
 * 図鑑のカードごとの所持と、今置ける枚数。
 * lock を立てると所持の行を押さえる（置く処理で、同時に2回置かれて減らしすぎないため）。
 */
async function loadDonatable(handle: DbLike, did: string, lock = false) {
  const query = handle
    .select({
      cardVolume: nagiCardInstances.cardVolume,
      cardNumber: nagiCardInstances.cardNumber,
      duplicateCount: nagiCardInstances.duplicateCount,
    })
    .from(nagiCardInstances)
    .where(
      and(
        eq(nagiCardInstances.ownerDid, did),
        // 記念日カード（volume 0）は置けない。
        ne(nagiCardInstances.cardVolume, 0),
      ),
    );
  const rows = lock ? await query.for("update") : await query;
  const holdings: ZenkatsuHolding[] = [];
  for (const row of rows) {
    const def = resolveCardDef(row.cardVolume, row.cardNumber);
    if (!def) continue;
    holdings.push({
      volume: row.cardVolume,
      id: row.cardNumber,
      rarity: def.rarity,
      stock: row.duplicateCount,
    });
  }
  const today = cardDrawDate(new Date());
  const plays = await loadRecentPlays(did, today, handle);
  const availability = zenkatsuAvailability(holdings, plays, today);
  const donatable = new Map<string, number>();
  holdings.forEach((holding, i) =>
    donatable.set(cardKey(holding), donatableCount(holding, availability[i])),
  );
  return { owned: new Set(holdings.map((h) => cardKey(h))), donatable };
}

/** ボードに1枚以上あるカード。枚数は見せないので、ここでもキーだけ返す。 */
async function loadStockedCards(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({
      cardVolume: nagiCardBoardStock.cardVolume,
      cardNumber: nagiCardBoardStock.cardNumber,
    })
    .from(nagiCardBoardStock)
    .where(gt(nagiCardBoardStock.count, 0));
  return new Set(
    rows.map((r) => cardKey({ volume: r.cardVolume, id: r.cardNumber })),
  );
}

/** はじめての Ƶ。台帳の部分一意索引で1人1回に収束する。配ったらその額を返す。 */
async function grantWelcome(did: string): Promise<number | undefined> {
  return db.transaction(async (tx) => {
    const [granted] = await tx
      .insert(nagiZennyLedger)
      .values({ did, delta: ZENNY_WELCOME, reason: "welcome", quantity: 0 })
      .onConflictDoNothing()
      .returning({ id: nagiZennyLedger.id });
    if (!granted) return undefined;
    await addBalance(tx, did, ZENNY_WELCOME);
    return ZENNY_WELCOME;
  });
}

export async function getCardBoard(viewerDid: string): Promise<CardBoardView> {
  const welcomeGranted = await grantWelcome(viewerDid);
  const [balance, mine, stocked] = await Promise.all([
    readBalance(db, viewerDid),
    loadDonatable(db, viewerDid),
    loadStockedCards(),
  ]);

  const entry = (
    def: CardDefinition,
    available: boolean,
    price: number,
    donatable: number,
  ): CardBoardEntry => {
    const owned = mine.owned.has(cardKey(def));
    return {
      card: { ...def, owned },
      available,
      price,
      zenny: ZENNY_PER_CARD[def.rarity],
      donatable,
      canTake: !owned && available && balance >= price,
    };
  };

  return {
    balance,
    ...(welcomeGranted ? { welcomeGranted } : {}),
    cards: CARD_DEFS.map((def) => {
      const stockedHere = stocked.has(cardKey(def));
      return entry(
        def,
        // AAR はボードに無くても botたんの分が常にある（13.2）。
        stockedHere || def.rarity === "AAR",
        takePrice(def, stockedHere),
        mine.donatable.get(cardKey(def)) ?? 0,
      );
    }),
  };
}

/** ボードに置かれた分は置いたときと同じ額、無い AAR は botたんの分で 600Ƶ。 */
function takePrice(def: CardDefinition, stocked: boolean) {
  return !stocked && def.rarity === "AAR"
    ? CARD_SHELF_AAR_PRICE
    : ZENNY_PER_CARD[def.rarity];
}

function parseDonateInput(input: unknown) {
  const body = input as
    | { mode?: unknown; card?: unknown; quantity?: unknown }
    | undefined;
  if (body?.mode === "all") return { mode: "all" as const };
  if (body?.mode !== "single")
    throw new ApiError(400, "invalid_request", "mode must be all or single");
  const quantity = body.quantity ?? 1;
  if (!Number.isInteger(quantity) || (quantity as number) < 1)
    throw new ApiError(400, "invalid_request", "quantity must be >= 1");
  const card = parseCardRef(body.card);
  boardCardDef(card);
  return { mode: "single" as const, card, quantity: quantity as number };
}

export async function donateCards(
  viewerDid: string,
  input: unknown,
): Promise<DonateCardsResult> {
  const request = parseDonateInput(input);

  return db.transaction(async (tx) => {
    const { donatable } = await loadDonatable(tx, viewerDid, true);

    let targets: { ref: CardRef; quantity: number }[];
    if (request.mode === "single") {
      const available = donatable.get(cardKey(request.card)) ?? 0;
      if (request.quantity > available)
        throw new ApiError(
          409,
          "not_donatable",
          `Only ${available} of this card can be donated`,
        );
      targets = [{ ref: request.card, quantity: request.quantity }];
    } else {
      // 図鑑の順に並べる。クライアントの吸い込み演出はこの順で流す。
      targets = CARD_DEFS.flatMap((def) => {
        const quantity = donatable.get(cardKey(def)) ?? 0;
        return quantity > 0
          ? [{ ref: { volume: def.volume, id: def.id }, quantity }]
          : [];
      });
    }

    const donated: DonatedCard[] = [];
    for (const { ref, quantity } of targets) {
      const def = boardCardDef(ref);
      const zenny = ZENNY_PER_CARD[def.rarity] * quantity;
      await tx
        .update(nagiCardInstances)
        .set({
          duplicateCount: sql`${nagiCardInstances.duplicateCount} - ${quantity}`,
        })
        .where(
          and(
            eq(nagiCardInstances.ownerDid, viewerDid),
            eq(nagiCardInstances.cardVolume, ref.volume),
            eq(nagiCardInstances.cardNumber, ref.id),
          ),
        );
      await tx
        .insert(nagiCardBoardStock)
        .values({
          donorDid: viewerDid,
          cardVolume: ref.volume,
          cardNumber: ref.id,
          count: quantity,
        })
        .onConflictDoUpdate({
          target: [
            nagiCardBoardStock.donorDid,
            nagiCardBoardStock.cardVolume,
            nagiCardBoardStock.cardNumber,
          ],
          set: { count: sql`${nagiCardBoardStock.count} + ${quantity}` },
        });
      await tx.insert(nagiZennyLedger).values({
        did: viewerDid,
        delta: zenny,
        reason: "donate",
        cardVolume: ref.volume,
        cardNumber: ref.id,
        quantity,
      });
      donated.push({
        volume: ref.volume,
        id: ref.id,
        rarity: def.rarity,
        quantity,
        zenny,
      });
    }

    const earned = donated.reduce((sum, d) => sum + d.zenny, 0);
    const balance = earned
      ? await addBalance(tx, viewerDid, earned)
      : await readBalance(tx, viewerDid);
    return { donated, earned, balance };
  });
}

/** 提供者を枚数で重み付けして1人選ぶ。1枚ずつが等しく選ばれる（時系列順にしない）。 */
export function pickDonor(
  stock: { donorDid: string; count: number }[],
  roll: (max: number) => number = randomInt,
): string {
  const total = stock.reduce((sum, s) => sum + s.count, 0);
  let r = roll(total);
  for (const s of stock) {
    if (r < s.count) return s.donorDid;
    r -= s.count;
  }
  return stock[stock.length - 1].donorDid;
}

function parseTakeInput(input: unknown) {
  const body = input as { card?: unknown; price?: unknown } | undefined;
  if (!Number.isInteger(body?.price) || (body?.price as number) < 1)
    throw new ApiError(400, "invalid_request", "price must be >= 1");
  const card = parseCardRef(body?.card);
  const def = boardCardDef(card);
  return { card, def, shownPrice: body?.price as number };
}

export async function takeBoardCard(
  viewerDid: string,
  input: unknown,
): Promise<TakeBoardCardResult> {
  const { card, def, shownPrice } = parseTakeInput(input);

  const taken = await db.transaction(async (tx) => {
    // 残高の行を先に押さえる。同じ人の二重送信は、ここで直列になる。
    const balance = await readBalance(tx, viewerDid, true);

    const [owned] = await tx
      .select({ id: nagiCardInstances.id })
      .from(nagiCardInstances)
      .where(
        and(
          eq(nagiCardInstances.ownerDid, viewerDid),
          eq(nagiCardInstances.cardVolume, card.volume),
          eq(nagiCardInstances.cardNumber, card.id),
        ),
      )
      .limit(1);
    // ラベルをカードの種類ごとに1つしか持てないので、未所持のカードだけ取れる（13.4）。
    if (owned)
      throw new ApiError(409, "already_owned", "You already own this card");

    // 最後の1枚を2人が同時に取りに来るので、そのカードの在庫行をまとめて押さえる。
    const stock = await tx
      .select({
        donorDid: nagiCardBoardStock.donorDid,
        count: nagiCardBoardStock.count,
      })
      .from(nagiCardBoardStock)
      .where(
        and(
          eq(nagiCardBoardStock.cardVolume, card.volume),
          eq(nagiCardBoardStock.cardNumber, card.id),
          gt(nagiCardBoardStock.count, 0),
        ),
      )
      .orderBy(nagiCardBoardStock.donorDid)
      .for("update");
    const fromBot = !stock.length;
    // 在庫が無いのは AAR だけ botたんの分で受け取れる。
    if (fromBot && def.rarity !== "AAR")
      throw new ApiError(409, "out_of_stock", "This card is gone");
    const price = takePrice(def, !fromBot);
    // 見ていた額より高くは取らない（100Ƶ の AAR が直前に取られ、600Ƶ になっていた）。
    if (price > shownPrice)
      throw new ApiError(409, "out_of_stock", "This card is gone");
    if (balance < price)
      throw new ApiError(409, "insufficient_zenny", "Not enough Ƶ");

    const donorDid = fromBot ? config.botDid : pickDonor(stock);
    if (!fromBot)
      await tx
        .update(nagiCardBoardStock)
        .set({ count: sql`${nagiCardBoardStock.count} - 1` })
        .where(
          and(
            eq(nagiCardBoardStock.donorDid, donorDid),
            eq(nagiCardBoardStock.cardVolume, card.volume),
            eq(nagiCardBoardStock.cardNumber, card.id),
          ),
        );

    const [instance] = await tx
      .insert(nagiCardInstances)
      .values({
        cardVolume: card.volume,
        cardNumber: card.id,
        ownerDid: viewerDid,
        firstOwnerDid: viewerDid,
        receivedFromDid: donorDid,
      })
      // 同じ瞬間に自分でそのカードを引いていた。未所持の前提が崩れたので取引ごと戻す。
      .onConflictDoNothing()
      .returning({ id: nagiCardInstances.id });
    if (!instance)
      throw new ApiError(409, "already_owned", "You already own this card");

    // 「〜からもらった」を文脈に入れたコメントを付ける（NagiCardCommentWorker）。
    await tx
      .insert(nagiCardCommentJobs)
      .values({ instanceId: instance.id })
      .onConflictDoNothing();

    const remaining = await addBalance(tx, viewerDid, -price);
    const [ledger] = await tx
      .insert(nagiZennyLedger)
      .values({
        did: viewerDid,
        delta: -price,
        reason: fromBot ? "shelf" : "take",
        cardVolume: card.volume,
        cardNumber: card.id,
        counterpartyDid: donorDid,
      })
      .returning({ id: nagiZennyLedger.id });

    // 置いた人へ「あなたのカードが届きました」。botたんと退会者には送らない。
    let notificationId: string | undefined;
    if (!fromBot && donorDid !== RECEIVED_FROM_ANONYMOUS) {
      const [notification] = await tx
        .insert(nagiNotifications)
        .values({
          recipientDid: donorDid,
          type: "gift",
          actorDid: viewerDid,
          subjectUri: giftSubjectUri(viewerDid, ledger.id),
          reasonUri: giftSubjectUri(viewerDid, ledger.id),
        })
        .onConflictDoNothing()
        .returning({ id: nagiNotifications.id });
      notificationId = notification?.id;
    }
    return { donorDid, price, balance: remaining, notificationId };
  });

  if (taken.notificationId)
    // 通知行は確定済み。プッシュの失敗で取引を取り消さない（ingest と同じ fire-and-forget）。
    void dispatchPush({
      recipientDid: taken.donorDid,
      type: "gift",
      actorDid: viewerDid,
      notificationId: taken.notificationId,
      actionText: def.nameJa,
    });

  const [row] = await db
    .select(INSTANCE_COLUMNS)
    .from(nagiCardInstances)
    .where(
      and(
        eq(nagiCardInstances.ownerDid, viewerDid),
        eq(nagiCardInstances.cardVolume, card.volume),
        eq(nagiCardInstances.cardNumber, card.id),
      ),
    )
    .limit(1);
  const receivedFrom = await loadReceivedFrom([taken.donorDid]);
  return {
    card: cardView(def, row, receivedFrom.get(taken.donorDid)),
    paid: taken.price,
    balance: taken.balance,
  };
}

/**
 * 「届きました」通知の subject。台帳の行を指す（受け取りは PDS レコードを持たない）。
 * 名刺更新の analysis 通知と同じく、AppView 内だけで解決する URI。
 */
export const giftSubjectUri = (takerDid: string, ledgerId: string) =>
  `at://${takerDid}/gift/${ledgerId}`;

export const giftLedgerIdOf = (uri: string) =>
  uri.split("/")[3] === "gift" ? uri.split("/")[4] : undefined;

/** 通知に載せる、届いた1枚。台帳の行から引く。 */
export async function loadGiftCards(
  ledgerIds: string[],
): Promise<Map<string, CardView>> {
  if (!ledgerIds.length) return new Map();
  const rows = await db
    .select({
      id: nagiZennyLedger.id,
      cardVolume: nagiZennyLedger.cardVolume,
      cardNumber: nagiZennyLedger.cardNumber,
    })
    .from(nagiZennyLedger)
    .where(inArray(nagiZennyLedger.id, ledgerIds));
  const map = new Map<string, CardView>();
  for (const row of rows) {
    if (row.cardVolume === null || row.cardNumber === null) continue;
    const def = resolveCardDef(row.cardVolume, row.cardNumber);
    if (def) map.set(row.id, { ...def, owned: true });
  }
  return map;
}
