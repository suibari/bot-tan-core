import assert from "node:assert/strict";
import test from "node:test";
import holidays from "../src/json/holidays.json" with { type: "json" };
import {
  ANNIVERSARY_SLOTS,
  CARD_VOLUME_ANNIVERSARY,
  anniversaryCardNumber,
  anniversaryNames,
  buildAnniversaryCardDef,
  isAnniversaryCard,
  parseAnniversaryCardNumber,
  resolveCardDef,
  resolveTodayAnniversaries,
  SLOT_NAGI_REGISTERED_DAY,
  SLOT_USER_ANNIVERSARY,
} from "../src/anniversaryCards.js";
import { CARD_ART_PATTERN, rollCard } from "../src/cards.js";

test("slot は 0..99 で重複が無い", () => {
  const seen = new Set<number>();
  for (const [id, slot] of Object.entries(ANNIVERSARY_SLOTS)) {
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot <= 99, id);
    assert.ok(!seen.has(slot), `slot ${slot} が重複している (${id})`);
    seen.add(slot);
  }
});

test("holidays.json の全 id に slot がある", () => {
  // 祝日を足して slot を振り忘れると、その記念日だけ静かにカードが出ない。
  for (const holiday of holidays as { id: string }[]) {
    assert.notEqual(
      ANNIVERSARY_SLOTS[holiday.id],
      undefined,
      `${holiday.id} に slot が無い`,
    );
  }
});

test("card_number は 西暦*100 + slot で往復できる", () => {
  const number = anniversaryCardNumber(2026, ANNIVERSARY_SLOTS.halloween);
  assert.equal(number, 2026 * 100 + ANNIVERSARY_SLOTS.halloween);
  assert.deepEqual(parseAnniversaryCardNumber(number), {
    year: 2026,
    slot: ANNIVERSARY_SLOTS.halloween,
  });
});

test("カード名は記念日名 + 年。ユーザー記念日は本人の入力をそのまま使う", () => {
  const halloween = buildAnniversaryCardDef(ANNIVERSARY_SLOTS.halloween, 2026);
  assert.equal(halloween?.nameJa, "ハロウィン2026");
  assert.equal(halloween?.nameEn, "Halloween 2026");
  assert.equal(halloween?.volume, CARD_VOLUME_ANNIVERSARY);
  assert.equal(halloween?.raceJa, "記念日");

  const user = buildAnniversaryCardDef(
    SLOT_USER_ANNIVERSARY,
    2026,
    "結婚記念日",
  );
  // ユーザー入力は ja/en を分けられないので両方に同じ文字列を使う。
  assert.equal(user?.nameJa, "結婚記念日2026");
  assert.equal(user?.nameEn, "結婚記念日 2026");
});

test("記念日カードは UR 相当。演出とコメントの深掘りをそのまま借りるため", () => {
  for (const slot of Object.values(ANNIVERSARY_SLOTS)) {
    assert.equal(buildAnniversaryCardDef(slot, 2026)?.rarity, "UR");
  }
});

test("art はパスになりうる文字を含まない（そのまま URL に埋まるため）", () => {
  for (const slot of Object.values(ANNIVERSARY_SLOTS)) {
    const art = buildAnniversaryCardDef(slot, 2026)?.art;
    if (art !== undefined) assert.match(art, CARD_ART_PATTERN);
  }
});

test("resolveCardDef は通常段と記念日段のどちらも引ける", () => {
  assert.equal(resolveCardDef(1, 1)?.volume, 1);
  const number = anniversaryCardNumber(2026, ANNIVERSARY_SLOTS.tanabata);
  assert.equal(resolveCardDef(0, number)?.nameJa, "七夕2026");
  assert.ok(isAnniversaryCard(CARD_VOLUME_ANNIVERSARY));
  assert.ok(!isAnniversaryCard(1));
});

test("ガチャは記念日カードを引かない", () => {
  // 抽選は CARD_DEFS しか見ないので段 0 は絶対に出ない。混ざるとコンプ率が壊れる。
  for (let i = 0; i < 3000; i++) assert.notEqual(rollCard().volume, 0);
});

test("その日のプリセット記念日を返す", () => {
  const found = resolveTodayAnniversaries("2026-10-31");
  assert.deepEqual(
    found.map((a) => a.anniversaryId),
    ["halloween"],
  );
  assert.equal(found[0].art, "anniv-halloween");
});

test("セントパトリックデーは削除済みで、追加した5件は拾える", () => {
  assert.deepEqual(resolveTodayAnniversaries("2026-03-17"), []);
  const ids = (key: string) =>
    resolveTodayAnniversaries(key).map((a) => a.anniversaryId);
  assert.deepEqual(ids("2026-02-19"), ["bottan_birthday"]);
  assert.deepEqual(ids("2026-03-31"), ["kotomi_birthday"]);
  assert.deepEqual(ids("2026-04-27"), ["latte_birthday"]);
  assert.deepEqual(ids("2026-05-04"), ["star_wars_day"]);
  assert.deepEqual(ids("2026-07-07"), ["tanabata"]);
});

test("同じ日に複数の記念日が重なることがある", () => {
  const found = resolveTodayAnniversaries("2026-10-31", {
    userAnnivDate: "--10-31",
    userAnnivName: "結婚記念日",
  });
  assert.deepEqual(
    found.map((a) => a.slot).sort((a, b) => a - b),
    [SLOT_USER_ANNIVERSARY, ANNIVERSARY_SLOTS.halloween].sort((a, b) => a - b),
  );
});

test("誕生日はユーザー記念日より優先し、先頭の1枚だけを残す", () => {
  const found = resolveTodayAnniversaries("2026-06-01", {
    birthDate: "1990-06-01",
    userAnnivDate: "--06-01",
    userAnnivName: "入籍記念日",
  });
  assert.equal(found[0].anniversaryId, "birthday");
  assert.equal(found[0].art, "anniv-hbd");
  assert.ok(!found.some((a) => a.anniversaryId === "user_anniversary"));
  const card = buildAnniversaryCardDef(ANNIVERSARY_SLOTS.birthday, 2026);
  assert.equal(card?.nameJa, "ハッピーバースデー! 2026");
  assert.equal(card?.nameEn, "Happy Birthday! 2026");
});

test("誕生日はプリセット記念日とは併存する", () => {
  assert.deepEqual(
    resolveTodayAnniversaries("2026-10-31", {
      birthDate: "2000-10-31",
    }).map((a) => a.anniversaryId),
    ["birthday", "halloween"],
  );
});

test("誕生日はカードの4時境界ではなくJST暦日とその西暦を使う", () => {
  const found = resolveTodayAnniversaries("2026-12-31", {
    birthDate: "1990-01-01",
    birthdayDateKey: "2027-01-01",
  });
  const birthday = found.find((a) => a.anniversaryId === "birthday");
  assert.equal(birthday?.year, 2027);
});

test("記念日オフ（is_anniv = 0）のユーザー記念日は祝わない", () => {
  // Bluesky 側で切った人の意思をそのまま尊重する。プリセット祝日には影響しない。
  const found = resolveTodayAnniversaries("2026-06-01", {
    userAnnivDate: "--06-01",
    userAnnivName: "誕生日",
    isAnnivEnabled: false,
  });
  assert.deepEqual(found, []);
});

test("Nagi 登録記念日は翌年から。登録したその年は祝わない", () => {
  const ctx = (iso: string) => ({ nagiCreatedAt: new Date(iso) });
  assert.deepEqual(
    resolveTodayAnniversaries("2026-06-01", ctx("2025-06-01T05:00:00Z")).map(
      (a) => a.slot,
    ),
    [SLOT_NAGI_REGISTERED_DAY],
  );
  assert.deepEqual(
    resolveTodayAnniversaries("2026-06-01", ctx("2026-06-01T05:00:00Z")),
    [],
  );
});

test("登録時刻は JST 4:00 始まりに直してから月日を比べる", () => {
  // UTC のまま比べると、日本時間の早朝に登録した人だけ1日ずれた日に祝われる。
  // 2025-05-31T20:00Z は JST では 6/1 05:00 なので「6/1 の登録」。
  assert.deepEqual(
    resolveTodayAnniversaries("2026-06-01", {
      nagiCreatedAt: new Date("2025-05-31T20:00:00Z"),
    }).map((a) => a.slot),
    [SLOT_NAGI_REGISTERED_DAY],
  );
});

test("記念日名は年を含まない（コメント生成にはこちらを渡す）", () => {
  assert.deepEqual(anniversaryNames(ANNIVERSARY_SLOTS.halloween), {
    ja: "ハロウィン",
    en: "Halloween",
  });
  // 名前未設定のユーザー記念日でも空にはしない。
  assert.deepEqual(anniversaryNames(SLOT_USER_ANNIVERSARY), {
    ja: "記念日",
    en: "Anniversary",
  });
});

test("壊れた日付キーでは何も返さない", () => {
  assert.deepEqual(resolveTodayAnniversaries(""), []);
  assert.deepEqual(resolveTodayAnniversaries("2026-13"), []);
});
