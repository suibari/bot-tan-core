/**
 * botたんのリポジトリ（PDS）に置いていた Nagi 日記を、AppView にだけある日記へ移す。
 *
 * 日記を本人だけが読むものにしたため。PDS に置いたままだと、公開リポジトリから誰でも読めてしまう。
 *
 * 1. DB の日記行と、それを指すブックマーク・通知の URI を AppView 発行の URI
 *    （authority が AppView の DID）へ書き換える
 * 2. PDS にだけあって DB に無い日記（取り込み漏れ）を、AppView 発行の URI で DB に入れる
 * 3. bot のリポジトリに残る com.suibari.nagi.diary レコードをすべて消す
 *
 * 1・2 を先に済ませるので、3 の削除で日記の本文が失われることはない。AppView は PDS 由来の
 * 日記をもう取り込まないので、削除イベントが jetstream から届いても行は消えない。
 * 途中で落ちても、もう一度流せば続きから進む。
 *
 * 前提: 日記を AppView にだけ作る版の nagi-bot-server と nagi-appview をデプロイしてから流すこと。
 * 古い bot サーバーが動いていると、移行後にまた PDS へ日記が書かれる。
 *
 * Preview（件数を数えるだけ。何も書かない）:
 *   pnpm --filter nagi-bot-server diary:migrate-appview
 * Apply:
 *   pnpm --filter nagi-bot-server diary:migrate-appview --apply
 */
import { and, eq } from "drizzle-orm";
import {
  db,
  nagiBookmarks,
  nagiDiaries,
  nagiNotifications,
} from "@bsky-affirmative-bot/database";
import { trackedDeleteRecord } from "@bsky-affirmative-bot/clients";
import {
  NAGI,
  appviewRecordUri,
  type NagiDiary,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { agent, initAgent } from "../src/agent.js";

// pnpm 6 までの区切り記号。今は不要だが、付けて呼ばれても落ちないよう捨てる。
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const apply = args.includes("--apply");
const unknown = args.filter((arg) => arg !== "--apply");
if (unknown.length) {
  console.error(`error: unknown option: ${unknown.join(", ")}`);
  console.error("usage: diary:migrate-appview [--apply]");
  process.exit(1);
}

const botDid = process.env.NAGI_BOT_DID;
if (!botDid || !/^did:(plc|web):/.test(botDid)) {
  console.error("error: NAGI_BOT_DID is not set to a DID");
  process.exit(1);
}

const legacyPrefix = `at://${botDid}/${NAGI.diary}/`;
const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

type PdsDiary = { rkey: string; cid: string; value: NagiDiary };

async function listPdsDiaries(): Promise<PdsDiary[]> {
  const records: PdsDiary[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await agent.com.atproto.repo.listRecords({
      repo: botDid!,
      collection: NAGI.diary,
      limit: 100,
      cursor,
    });
    records.push(
      ...data.records.map((record) => ({
        rkey: rkeyOf(record.uri),
        cid: record.cid,
        value: record.value as NagiDiary,
      })),
    );
    cursor = data.records.length ? data.cursor : undefined;
  } while (cursor);
  return records;
}

async function hasDiary(subject: string, date: string): Promise<boolean> {
  const [row] = await db
    .select({ uri: nagiDiaries.uri })
    .from(nagiDiaries)
    .where(
      and(eq(nagiDiaries.subjectDid, subject), eq(nagiDiaries.diaryDate, date)),
    )
    .limit(1);
  return Boolean(row);
}

const isImportable = (value: NagiDiary) =>
  typeof value?.subject === "string" &&
  typeof value.date === "string" &&
  typeof value.text === "string" &&
  value.text.length > 0 &&
  !Number.isNaN(Date.parse(value.createdAt));

// listRecords は公開 API だが、削除に使う agent と同じ PDS を見るためにここでログインしておく。
await initAgent();

const legacyRows = (
  await db.select({ uri: nagiDiaries.uri }).from(nagiDiaries)
).filter((row) => row.uri.startsWith(legacyPrefix));
const pdsDiaries = await listPdsDiaries();

console.log(
  `${apply ? "APPLY" : "PREVIEW"}: DB の移行対象 ${legacyRows.length} 件 / PDS の日記レコード ${pdsDiaries.length} 件`,
);
if (!apply) {
  console.log("何も書いていない。実行するなら --apply を付ける。");
  process.exit(0);
}

// 1. DB の URI を書き換える。
let moved = 0;
let duplicates = 0;
for (const { uri } of legacyRows) {
  const next = appviewRecordUri(NAGI.diary, rkeyOf(uri));
  const result = await db.transaction(async (tx) => {
    const [taken] = await tx
      .select({ uri: nagiDiaries.uri })
      .from(nagiDiaries)
      .where(eq(nagiDiaries.uri, next))
      .limit(1);
    // rkey は (subject, date) で決まるので、移行先が埋まっているのは同じ日の日記が
    // AppView 側に既にあるとき。取り込み時の意味重複の解決で片方しか残らないはずだが、
    // 残っていたら AppView 側を正として PDS 由来の行を落とす。
    if (taken) {
      await tx
        .delete(nagiNotifications)
        .where(eq(nagiNotifications.reasonUri, uri));
      await tx.delete(nagiDiaries).where(eq(nagiDiaries.uri, uri));
      return "duplicate" as const;
    }
    await tx
      .update(nagiDiaries)
      .set({ uri: next })
      .where(eq(nagiDiaries.uri, uri));
    await tx
      .update(nagiBookmarks)
      .set({ subjectUri: next })
      .where(eq(nagiBookmarks.subjectUri, uri));
    await tx
      .update(nagiNotifications)
      .set({ subjectUri: next, reasonUri: next })
      .where(eq(nagiNotifications.reasonUri, uri));
    return "moved" as const;
  });
  if (result === "moved") moved += 1;
  else duplicates += 1;
}
console.log(`DB: ${moved} moved, ${duplicates} duplicates dropped`);

// 2. 取り込み漏れを DB に入れる。通知は作らない（過去の日記を今さら知らせない）。
let imported = 0;
let invalid = 0;
for (const { rkey, cid, value } of pdsDiaries) {
  if (!isImportable(value)) {
    invalid += 1;
    console.warn(`[WARN] ${rkey}: 日記として読めないので取り込まない`);
    continue;
  }
  if (await hasDiary(value.subject, value.date)) continue;
  await db
    .insert(nagiDiaries)
    .values({
      uri: appviewRecordUri(NAGI.diary, rkey),
      cid,
      did: botDid,
      subjectDid: value.subject,
      diaryDate: value.date,
      text: value.text,
      titleJa: value.titleJa ?? null,
      titleEn: value.titleEn ?? null,
      emoji: value.emoji ?? null,
      postCount: value.postCount ?? null,
      langs: value.langs ?? null,
      recordCreatedAt: new Date(value.createdAt),
    })
    .onConflictDoNothing();
  imported += 1;
}
console.log(`DB: ${imported} imported from PDS, ${invalid} invalid`);

// 3. PDS から消す。
let deleted = 0;
let failed = 0;
for (const { rkey } of pdsDiaries) {
  try {
    await trackedDeleteRecord(
      agent,
      { repo: botDid, collection: NAGI.diary, rkey },
      "nagi.diary.migrate",
    );
    deleted += 1;
  } catch (error) {
    failed += 1;
    console.error(`[ERROR] ${rkey}: PDS から消せなかった`, error);
  }
}

console.log(`PDS: ${deleted} deleted, ${failed} failed`);
process.exit(failed ? 1 : 0);
