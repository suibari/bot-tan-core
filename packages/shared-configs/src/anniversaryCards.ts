import holidays from "./json/holidays.json" with { type: "json" };
import anniversaryCards from "./json/anniversary_cards.json" with { type: "json" };
import {
  CARD_ART_PATTERN,
  cardDrawDate,
  getCardDef,
  type CardAttribute,
  type CardDefinition,
} from "./cards.js";
import { dateForHoliday, toMonthDayIso } from "./util/dateRules.js";
import type { Holiday } from "./types.js";

/**
 * 記念日カード。ハロウィンや誕生日など「その年その日にしか手に入らない1枚」で、
 * 通常の全肯定カード（cards_v{n}.json をガチャで引く）とは出どころが別。
 *
 * 通常カードと同じ (card_volume, card_number) の座標系に乗せるが、**段は 0 を予約**して
 * ガチャの段（1以上）と混ざらないようにする。抽選は CARD_DEFS しか見ないので、
 * 記念日カードがガチャから出ることはない。
 *
 * 定義は静的 JSON に置けない（名前に年が入り、ユーザー記念日は名前が本人入力）ため、
 * CardDefinition と同じ形を実行時に合成する。これで演出（レアリティ UR 相当の箔押し・
 * コンフェッティ）も botたんコメント生成も、通常カードの経路をそのまま通せる。
 */

/** 記念日カードの段。通常段は 1 以上なので、0 なら記念日カードだと判別できる。 */
export const CARD_VOLUME_ANNIVERSARY = 0;

/**
 * 記念日ごとの通し番号。card_number = year * 100 + slot で1枚に対応する。
 *
 * **一度割り当てた slot は絶対に変更してはならない。** nagi.card_instances.card_number から
 * 永続参照されるので、振り直すと既存カードの指す先が変わる（= 所持データの破壊）。
 * 記念日を増やすときは必ず末尾に足す。記念日をやめるときも番号は欠番のまま空ける。
 */
export const ANNIVERSARY_SLOTS: Record<string, number> = {
  user_anniversary: 0,
  new_year: 1,
  valentines_day: 2,
  bottan_birthday: 3,
  white_day: 4,
  kotomi_birthday: 5,
  april_fools: 6,
  easter: 7,
  latte_birthday: 8,
  star_wars_day: 9,
  mothers_day: 10,
  fathers_day: 11,
  tanabata: 12,
  halloween: 13,
  thanksgiving_us: 14,
  christmas: 15,
  new_years_eve: 16,
  birthday: 17,
  nagi_registered_day: 99,
};

/** holidays.json に無い、ユーザーごとに決まる記念日。 */
export const SLOT_USER_ANNIVERSARY = ANNIVERSARY_SLOTS.user_anniversary;
export const SLOT_BIRTHDAY = ANNIVERSARY_SLOTS.birthday;
export const SLOT_NAGI_REGISTERED_DAY = ANNIVERSARY_SLOTS.nagi_registered_day;

/** 記念日カードのカード面のうち、年に依らない静的な部分。 */
export interface AnniversaryCardArt {
  id: string;
  attribute: CardAttribute;
  atk: number;
  def: number;
  textJa: string;
  textEn: string;
  art?: string;
}

/** 合成された記念日カード。CardDefinition として通常カードの経路に流せる。 */
export type AnniversaryCardDefinition = CardDefinition & {
  anniversary: true;
  /** 何年ぶんの1枚か。カード面では図鑑番号の代わりにこれを出す。 */
  year: number;
  /** ANNIVERSARY_SLOTS の値。 */
  slot: number;
  /** holidays.json の id、または user_anniversary / nagi_registered_day。 */
  anniversaryId: string;
};

const HOLIDAYS = holidays as Holiday[];
const ART_BY_ID = new Map(
  (anniversaryCards as AnniversaryCardArt[]).map((a) => [a.id, a]),
);

/**
 * 定義の健全性チェック。壊れたまま配ると所持データが汚れて戻せないので起動時に落とす。
 * cards.ts の assertCardDefs と同じ方針。
 */
function assertAnniversaryDefs(): Map<number, string> {
  const bySlot = new Map<number, string>();
  for (const [id, slot] of Object.entries(ANNIVERSARY_SLOTS)) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 99)
      throw new Error(`anniversary: slot must be 0..99 (${id} = ${slot})`);
    const clash = bySlot.get(slot);
    if (clash)
      throw new Error(`anniversary: slot ${slot} used by both ${clash} and ${id}`);
    bySlot.set(slot, id);
    const art = ART_BY_ID.get(id);
    if (!art)
      throw new Error(`anniversary: ${id} has no entry in anniversary_cards.json`);
    if (art.art !== undefined && !CARD_ART_PATTERN.test(art.art))
      throw new Error(`anniversary: invalid art "${art.art}" (${id})`);
    for (const field of ["textJa", "textEn"] as const) {
      if (!art[field]?.trim())
        throw new Error(`anniversary: empty ${field} (${id})`);
    }
  }
  // 祝日を足したのに slot を振り忘れると、その記念日だけ静かにカードが出ない。
  for (const holiday of HOLIDAYS) {
    if (ANNIVERSARY_SLOTS[holiday.id] === undefined)
      throw new Error(`anniversary: holiday ${holiday.id} has no slot`);
  }
  return bySlot;
}

const ID_BY_SLOT = assertAnniversaryDefs();
const HOLIDAY_BY_ID = new Map(HOLIDAYS.map((h) => [h.id, h]));

/** その年その記念日を指す card_number。年の下2桁ではなく西暦をそのまま使う。 */
export function anniversaryCardNumber(year: number, slot: number): number {
  return year * 100 + slot;
}

export function isAnniversaryCard(volume: number): boolean {
  return volume === CARD_VOLUME_ANNIVERSARY;
}

/** card_number から year と slot に戻す。 */
export function parseAnniversaryCardNumber(cardNumber: number): {
  year: number;
  slot: number;
} {
  return { year: Math.floor(cardNumber / 100), slot: cardNumber % 100 };
}

/** ユーザー記念日・Nagi登録記念日は名前が固定でないので、呼び出し側から渡す。 */
const DYNAMIC_NAMES: Record<number, { ja: string; en: string }> = {
  [SLOT_BIRTHDAY]: {
    ja: "ハッピーバースデー!",
    en: "Happy Birthday!",
  },
  [SLOT_NAGI_REGISTERED_DAY]: { ja: "Nagi記念日", en: "Nagi Anniversary" },
};

/**
 * 記念日の表示名（年を含まない）。label はユーザー記念日の本人入力名。
 * ユーザー入力は ja/en を分けられないので両方に同じ文字列を使う（BADGE_DEF.anniversary と同じ割り切り）。
 */
export function anniversaryNames(
  slot: number,
  label?: string,
): { ja: string; en: string } | undefined {
  const id = ID_BY_SLOT.get(slot);
  if (!id) return undefined;
  if (slot === SLOT_USER_ANNIVERSARY) {
    const name = label?.trim();
    return name ? { ja: name, en: name } : { ja: "記念日", en: "Anniversary" };
  }
  const holiday = HOLIDAY_BY_ID.get(id);
  if (holiday) return holiday.names;
  return DYNAMIC_NAMES[slot];
}

/**
 * 記念日カード1枚の定義を組み立てる。
 *
 * レアリティは常に UR。抽選で出るわけではないので確率的な意味は無く、
 * 「UR 相当の演出・UR 相当の掘り下げコメントに乗せる」ためのスイッチとして使っている。
 */
export function buildAnniversaryCardDef(
  slot: number,
  year: number,
  label?: string,
): AnniversaryCardDefinition | undefined {
  const id = ID_BY_SLOT.get(slot);
  const art = id ? ART_BY_ID.get(id) : undefined;
  const names = anniversaryNames(slot, label);
  if (!id || !art || !names) return undefined;
  return {
    id: anniversaryCardNumber(year, slot),
    volume: CARD_VOLUME_ANNIVERSARY,
    rarity: "UR",
    attribute: art.attribute,
    atk: art.atk,
    def: art.def,
    nameJa:
      slot === SLOT_BIRTHDAY ? `${names.ja} ${year}` : `${names.ja}${year}`,
    nameEn: `${names.en} ${year}`,
    raceJa: "記念日",
    raceEn: "Anniversary",
    textJa: art.textJa,
    textEn: art.textEn,
    ...(art.art ? { art: art.art } : {}),
    anniversary: true,
    year,
    slot,
    anniversaryId: id,
  };
}

/**
 * 通常カードと記念日カードのどちらでも定義を引く。
 * DB には (card_volume, card_number) しか無いので、読み出し側はこれを通す。
 */
export function resolveCardDef(
  volume: number,
  cardNumber: number,
  label?: string,
): CardDefinition | AnniversaryCardDefinition | undefined {
  if (!isAnniversaryCard(volume)) return getCardDef(volume, cardNumber);
  const { year, slot } = parseAnniversaryCardNumber(cardNumber);
  return buildAnniversaryCardDef(slot, year, label);
}

export interface TodayAnniversary {
  /** この1枚に焼き付ける西暦。誕生日は暦日、ほかはカード日付境界に従う。 */
  year: number;
  slot: number;
  anniversaryId: string;
  nameJa: string;
  nameEn: string;
  /** ユーザー記念日のみ。card_instances に焼き付けて名前を不変にする。 */
  label?: string;
  art?: string;
}

export interface AnniversaryContext {
  /** followers.user_anniv_name */
  userAnnivName?: string | null;
  /** followers.user_anniv_date（"--MM-DD"） */
  userAnnivDate?: string | null;
  /** followers.is_anniv。0 のときユーザー記念日を祝わない。 */
  isAnnivEnabled?: boolean;
  /** nagi.age_assurance.birth_date（"YYYY-MM-DD"）。本人のカード判定にだけ使う。 */
  birthDate?: string | null;
  /** 誕生日だけが使う JST 0:00 始まりの暦日。省略時は dateKey。 */
  birthdayDateKey?: string;
  /** nagi.profiles.created_at。Nagi 登録記念日の判定に使う。 */
  nagiCreatedAt?: Date | null;
}

/** "--MM-DD" を受け取り、"MM-DD" に正規化する。形式が違えば undefined。 */
function monthDayOf(value: string | null | undefined): string | undefined {
  const match = /^--(\d{2})-(\d{2})$/.exec(value ?? "");
  return match ? `${match[1]}-${match[2]}` : undefined;
}

/** "YYYY-MM-DD" の非公開生年月日から "MM-DD" だけを取り出す。 */
function birthMonthDayOf(value: string | null | undefined): string | undefined {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value ?? "");
  return match ? `${match[1]}-${match[2]}` : undefined;
}

/**
 * その日の記念日をすべて返す。
 *
 * `dateKey` は cardDrawDate() が返す JST 4:00 始まりの "YYYY-MM-DD" を渡す。カードの日付境界と
 * 記念日の判定日を同じ物差しで測るためで、これがずれると「元旦カードが大晦日に出る」ことになる。
 *
 * 月日の比較は "--MM-DD" 文字列のまま行い、parseMonthDay は使わない
 * （あちらはダミー年 2025 を入れるので 2/29 が 3/1 にロールする）。
 */
export function resolveTodayAnniversaries(
  dateKey: string,
  ctx: AnniversaryContext = {},
): TodayAnniversary[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return [];
  const year = Number(match[1]);
  const todayMD = `${match[2]}-${match[3]}`;

  const found: TodayAnniversary[] = [];
  const push = (slot: number, label?: string, cardYear = year) => {
    const id = ID_BY_SLOT.get(slot);
    const names = anniversaryNames(slot, label);
    if (!id || !names) return;
    const art = ART_BY_ID.get(id)?.art;
    found.push({
      year: cardYear,
      slot,
      anniversaryId: id,
      nameJa: names.ja,
      nameEn: names.en,
      ...(label ? { label } : {}),
      ...(art ? { art } : {}),
    });
  };

  // 生年月日は AppView の非公開テーブルから本人のカード判定にだけ渡される。
  // 誕生日カードを常に先頭へ置き、自動表示でも他の記念日より先にプレゼントする。
  const birthdayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    ctx.birthdayDateKey ?? dateKey,
  );
  const birthdayMD = birthdayMatch
    ? `${birthdayMatch[2]}-${birthdayMatch[3]}`
    : todayMD;
  const isBirthday = birthMonthDayOf(ctx.birthDate) === birthdayMD;
  if (isBirthday)
    push(SLOT_BIRTHDAY, undefined, Number(birthdayMatch?.[1] ?? year));

  for (const holiday of HOLIDAYS) {
    const slot = ANNIVERSARY_SLOTS[holiday.id];
    if (slot === undefined) continue;
    if (toMonthDayIso(dateForHoliday(year, holiday)).slice(2) === todayMD)
      push(slot);
  }

  // ユーザーが自分で登録した記念日。Bluesky 側の記念日オフ（is_anniv=0）をそのまま尊重する。
  if (!isBirthday && ctx.isAnnivEnabled !== false) {
    const userMD = monthDayOf(ctx.userAnnivDate);
    if (userMD === todayMD)
      push(SLOT_USER_ANNIVERSARY, ctx.userAnnivName?.trim() || undefined);
  }

  // Nagi に登録した日。登録したその年は「1周年」ではないので祝わない。
  // 登録時刻も dateKey と同じ物差し（JST 4:00 始まり）に直してから月日を比べる。
  // UTC のまま比べると、日本時間の早朝に登録した人だけ1日ずれた日に祝われる。
  const created = ctx.nagiCreatedAt;
  if (created && !Number.isNaN(created.getTime())) {
    const createdKey = cardDrawDate(created);
    if (
      createdKey.slice(5) === todayMD &&
      Number(createdKey.slice(0, 4)) < year
    )
      push(SLOT_NAGI_REGISTERED_DAY);
  }

  return found;
}
