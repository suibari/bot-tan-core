import {
  db,
  nagiNotificationPreferences,
  nagiNotifications,
} from "@bsky-affirmative-bot/database";
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  type NotificationPreference,
  type NotificationPreferenceCategory,
  type NotificationPreferences,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq, inArray, ne, not, or, type SQL } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";

type NotificationType = (typeof nagiNotifications.$inferSelect)["type"];

/**
 * botたんから来たときだけ botInteraction に振り替える種別。
 * それ以外の種別（diary / analysis など）は送り手で分けない。
 */
const BOT_INTERACTION_TYPES = [
  "reply",
  "mention",
  "reaction",
] as const satisfies readonly NotificationType[];

const isBotInteractionType = (type: NotificationType) =>
  (BOT_INTERACTION_TYPES as readonly NotificationType[]).includes(type);

const isCategory = (value: string): value is NotificationPreferenceCategory =>
  (NOTIFICATION_PREFERENCE_CATEGORIES as readonly string[]).includes(value);

const DEFAULT_PREFERENCE: NotificationPreference = { list: true, push: true };

/**
 * 通知1件がどのカテゴリの設定に従うか。undefined は設定の対象外（常に通知する）。
 * 廃止済みの emoji（絵文字の生成完了）のように、もう作られない種別がここに来る。
 */
export function notificationCategory(
  type: NotificationType,
  actorDid: string,
  botDid: string = config.botDid,
): NotificationPreferenceCategory | undefined {
  if (actorDid === botDid && isBotInteractionType(type)) return "botInteraction";
  return isCategory(type) ? type : undefined;
}

export function preferenceFor(
  preferences: NotificationPreferences,
  category: NotificationPreferenceCategory | undefined,
): NotificationPreference {
  return (category && preferences[category]) || DEFAULT_PREFERENCE;
}

/**
 * putPreferences の入力検証。
 * 知らないカテゴリは捨てる（エラーにしない）。新しいクライアントが先に出て
 * カテゴリを増やしたとき、古い AppView が設定の保存ごと弾くのを避けるため。
 * 既知カテゴリの値だけは厳密に { list: boolean, push: boolean } を要求する。
 */
export function parseNotificationPreferences(
  input: unknown,
): NotificationPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("notificationPreferences");
  const result: NotificationPreferences = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isCategory(key)) continue;
    if (!value || typeof value !== "object") invalid(`notificationPreferences.${key}`);
    const { list, push } = value as Record<string, unknown>;
    if (typeof list !== "boolean" || typeof push !== "boolean")
      invalid(`notificationPreferences.${key}`);
    result[key] = { list, push };
  }
  return result;
}

/** DB の jsonb を読み戻す。壊れた値は既定扱いにして、通知が止まる側へ倒さない。 */
export function sanitizeStoredNotificationPreferences(
  stored: unknown,
): NotificationPreferences {
  try {
    return parseNotificationPreferences(stored);
  } catch {
    return {};
  }
}

export async function loadNotificationPreferences(
  did: string,
): Promise<NotificationPreferences> {
  const [row] = await db
    .select({ preferences: nagiNotificationPreferences.preferences })
    .from(nagiNotificationPreferences)
    .where(eq(nagiNotificationPreferences.did, did))
    .limit(1);
  return row ? sanitizeStoredNotificationPreferences(row.preferences) : {};
}

/**
 * 通知欄から外すカテゴリの条件。and(...) へそのまま撒ける配列を返す。
 * 行は消さないので、設定を戻せば過去分も通知欄に戻る（ミュートと同じ扱い）。
 * 一覧（getNotifications）と未読数（getUnreadCount）で必ず同じものを使うこと。
 */
export function notificationListFilter(
  preferences: NotificationPreferences,
  botDid: string = config.botDid,
): SQL[] {
  const hidden: SQL[] = [];
  for (const category of NOTIFICATION_PREFERENCE_CATEGORIES) {
    if (preferenceFor(preferences, category).list) continue;
    if (category === "botInteraction") {
      hidden.push(
        and(
          inArray(nagiNotifications.type, [...BOT_INTERACTION_TYPES]),
          eq(nagiNotifications.actorDid, botDid),
        )!,
      );
    } else if (isBotInteractionType(category)) {
      // 人からの返信などを切っても、botたんの分は botInteraction の設定に従う。
      hidden.push(
        and(
          eq(nagiNotifications.type, category),
          ne(nagiNotifications.actorDid, botDid),
        )!,
      );
    } else {
      hidden.push(eq(nagiNotifications.type, category));
    }
  }
  return hidden.length ? [not(or(...hidden)!)] : [];
}

function invalid(field: string): never {
  throw new ApiError(400, "invalid_request", `Invalid ${field}`);
}
