import { db, nagiPrivateSpaces } from "@bsky-affirmative-bot/database";
import type {
  PrivateStorageMode,
  PutPreferencesInput,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { eq } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";

/**
 * 従来の書き込み API の門番。queries/* から呼ぶので、queries/* を import する
 * records.ts / storage.ts とは分けている（循環 import を作らないため）。
 */

export type StorageRow = typeof nagiPrivateSpaces.$inferSelect;
export type Executor = Pick<typeof db, "select">;

export async function loadPrivateStorage(
  did: string,
  executor: Executor = db,
): Promise<StorageRow | undefined> {
  const [row] = await executor
    .select()
    .from(nagiPrivateSpaces)
    .where(eq(nagiPrivateSpaces.did, did))
    .limit(1);
  return row;
}

export const storageMode = (row: StorageRow | undefined): PrivateStorageMode =>
  (row?.storage as PrivateStorageMode | undefined) ?? "appview";

/**
 * 従来の書き込み API が受け付けてよいか。appview 以外なら投げる。
 *
 * - migrating: 423。移行が終わるか戻すまで待ってもらう（クライアントは書き込みを保留する）。
 * - space: 409。正本は本人の PDS にあるので、AppView にだけ書くと分岐する。
 *   古いタブからの書き込みがここに来る。クライアントは再読み込みで space 経路へ切り替わる。
 */
export function assertWritableMode(mode: PrivateStorageMode) {
  if (mode === "migrating")
    throw new ApiError(
      423,
      "private_space_migrating",
      "Private data is being moved to your PDS",
    );
  if (mode === "space")
    throw new ApiError(
      409,
      "moved_to_private_space",
      "Private data is stored in your PDS",
    );
}

export async function assertAppviewWritable(did: string, executor: Executor = db) {
  assertWritableMode(storageMode(await loadPrivateStorage(did, executor)));
}

/**
 * putPreferences のうち、space へ移る項目。ここに無い項目（既読位置・呼び名・返信頻度・
 * 生年月日・自動検出のタイムゾーンなど）は、移行後も AppView が正本なので止めない。
 */
const MOVED_PREFERENCE_FIELDS = [
  "emojiFavorites",
  "feedTabs",
  "tagFavorites",
  "languagePreferences",
  "moderationPreferences",
  "notificationPreferences",
  "lastBookmarkFolderId",
  "diaryDay",
] as const satisfies readonly (keyof PutPreferencesInput)[];

export const movedPreferenceFields = (input: PutPreferencesInput) =>
  MOVED_PREFERENCE_FIELDS.filter((field) => input[field] !== undefined);

/** putPreferences の門番。移る項目を1つも含まなければ、保存先によらず通す。 */
export async function assertPreferencesWritable(
  did: string,
  input: PutPreferencesInput,
) {
  if (!movedPreferenceFields(input).length) return;
  await assertAppviewWritable(did);
}
