import { db, nagiAgeAssurance } from "@bsky-affirmative-bot/database";
import { eq } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";

/**
 * 年齢確認。
 *
 * 生年月日は PDS レコードにしない（PDS レコードは誰でも読める）。AppView の
 * Postgres だけが持ち、生年月日そのものは他ユーザーへ返さない。年齢表示制御に加え、
 * 誕生日当日は生年を含まない isBirthday フラグと本人向けカード判定にだけ使う。
 *
 * 未申告は未成年として扱う。申告は1度だけで、後から変えられない
 * （成人向けコンテンツを見るために年齢を上書きされないようにするため）。
 * 成人判定は保存した生年月日との日付比較なので、18歳の誕生日を過ぎた時点で
 * 自動的に成人になる。行を書き換える必要はない。
 */

export const ADULT_AGE = 18;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 誕生日演出用の JST 0:00 始まりの暦日。カードの4:00境界とは意図的に分ける。 */
export function jstCalendarDate(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 生年を外へ出さず、指定した瞬間が誕生日かだけを判定する。 */
export function isBirthdayToday(
  birthDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const birth = /^\d{4}-(\d{2})-(\d{2})$/.exec(birthDate ?? "");
  return !!birth && jstCalendarDate(now).slice(5) === `${birth[1]}-${birth[2]}`;
}

export type AgeAssurance = {
  isAdult: boolean;
  /** 申告済みか。未申告なら onboarding で入力を促す。 */
  declared: boolean;
  birthDate: string | null;
};

/** 生年月日から成人かどうかを判定する。境界日（18歳の誕生日当日）は成人。 */
export function isAdultBirthDate(
  birthDate: string,
  now: Date = new Date(),
): boolean {
  const birth = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  const threshold = new Date(
    Date.UTC(
      now.getUTCFullYear() - ADULT_AGE,
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  );
  return birth.getTime() <= threshold.getTime();
}

/**
 * 表示のたびに引かないための短命キャッシュ。申告は1度きりなので値はほぼ不変だが、
 * 18歳の誕生日で成人へ変わるので TTL は持たせる。
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: AgeAssurance; expiresAt: number }>();

/** テスト用。プロセス内キャッシュを捨てる。 */
export function clearAgeAssuranceCache(): void {
  cache.clear();
}

/**
 * ビューアの年齢状態を引く。未認証（did なし）は成人として扱う。
 * ログイン前の公開閲覧であり年齢が分からないため、判定待ちで公開タイムラインが
 * 遅れて見えることを避ける。
 */
export async function getAgeAssurance(
  did: string | undefined,
  now: Date = new Date(),
): Promise<AgeAssurance> {
  if (!did) return { isAdult: true, declared: false, birthDate: null };
  const cached = cache.get(did);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;
  const value = await loadAgeAssurance(did, now);
  cache.set(did, { value, expiresAt: now.getTime() + CACHE_TTL_MS });
  return value;
}

/** ビューアが成人か。フィルタ側はこれだけ使う。 */
export const viewerIsAdult = async (did?: string): Promise<boolean> =>
  (await getAgeAssurance(did)).isAdult;

async function loadAgeAssurance(
  did: string,
  now: Date,
): Promise<AgeAssurance> {
  const [row] = await db
    .select({
      birthDate: nagiAgeAssurance.birthDate,
      source: nagiAgeAssurance.source,
    })
    .from(nagiAgeAssurance)
    .where(eq(nagiAgeAssurance.did, did))
    .limit(1);
  // この機能を入れる前からいたユーザーは一律に成人として扱う。
  if (row?.source === "legacy")
    return { isAdult: true, declared: true, birthDate: null };
  if (!row?.birthDate) return { isAdult: false, declared: false, birthDate: null };
  return {
    isAdult: isAdultBirthDate(row.birthDate, now),
    declared: true,
    birthDate: row.birthDate,
  };
}

const BIRTH_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 生年月日の申告。1度だけ受け付ける。
 * 未成年で利用を続ける場合は保護者同意の自己申告を必須にする。
 */
export async function declareBirthDate(
  did: string,
  input: { birthDate: unknown; parentalConsent?: unknown },
  now: Date = new Date(),
): Promise<AgeAssurance> {
  const birthDate = input.birthDate;
  if (typeof birthDate !== "string" || !BIRTH_DATE.test(birthDate))
    throw new ApiError(400, "invalid_request", "birthDate must be YYYY-MM-DD");
  const parsed = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime())
    throw new ApiError(400, "invalid_request", "birthDate is not a valid past date");

  const isAdult = isAdultBirthDate(birthDate, now);
  if (!isAdult && input.parentalConsent !== true)
    throw new ApiError(
      400,
      "parental_consent_required",
      "Users under 18 need a parent or guardian's permission",
    );

  const inserted = await db
    .insert(nagiAgeAssurance)
    .values({
      did,
      birthDate,
      source: "self",
      parentalConsentAt: isAdult ? null : now,
    })
    .onConflictDoNothing()
    .returning({ did: nagiAgeAssurance.did });
  if (inserted.length === 0)
    throw new ApiError(
      409,
      "already_set",
      "Age has already been declared and cannot be changed",
    );
  cache.delete(did);
  return { isAdult, declared: true, birthDate };
}
