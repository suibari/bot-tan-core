/**
 * Nagi への公開に同意していない3行日記を Nagi から取り下げる。
 *
 * shareToNagi を導入する前（#146/#147）は、TriLinesAt だけで書いた日記まで投稿として取り込み、
 * botたんが返信していた。印の無い日記について、次のものを消す。
 * - botたんの返信とリアクション（bot の PDS から消し、AppView にも反映）
 * - 日記の投稿行（PDS の日記は本人のものなので触らず、Nagi 側だけ削除扱いにする）
 * - 残っている返信ジョブ
 *
 * 使い方:
 *   pnpm --filter nagi-appview trilines:purge-unshared            # 対象を表示するだけ
 *   pnpm --filter nagi-appview trilines:purge-unshared --apply    # 実行
 *   ... --keep at://did:plc:xxx/com.suibari.trilinesat.diary/3abc                     # 残す日記（複数可）
 */
import {
  client,
  db,
  nagiBotReplyJobs,
  nagiPosts,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import {
  TRILINES,
  isTrilinesDiarySharedToNagi,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { createBotAgent } from "@bsky-affirmative-bot/bot-runtime";
import { and, eq, isNull, like, or } from "drizzle-orm";
import { config } from "../src/config.js";
import { ensurePdsRecord } from "../src/ingest/reconcileRepo.js";
import { parseRecordUri } from "../src/ingest/recordUri.js";
import { resolvePdsUrl } from "../src/util/pds.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keep = new Set(
  args.flatMap((arg, index) => (arg === "--keep" && args[index + 1] ? [args[index + 1]] : [])),
);

/** PDS 上の日記の値。消えていれば undefined。 */
async function currentDiary(did: string, rkey: string): Promise<unknown | undefined> {
  const url = new URL("/xrpc/com.atproto.repo.getRecord", await resolvePdsUrl(did));
  url.search = new URLSearchParams({ repo: did, collection: TRILINES.diary, rkey }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 400 || response.status === 404) return undefined;
  if (!response.ok) throw new Error(`getRecord failed (${response.status}) for ${did}/${rkey}`);
  return ((await response.json()) as { value?: unknown }).value;
}

async function main() {
  const diaries = await db
    .select({ uri: nagiPosts.uri, did: nagiPosts.did, text: nagiPosts.text })
    .from(nagiPosts)
    .where(and(like(nagiPosts.uri, `at://%/${TRILINES.diary}/%`), isNull(nagiPosts.deletedAt)));

  type Target = { uri: string; did: string; rkey: string; text: string; botRecords: string[] };
  const targets: Target[] = [];
  for (const diary of diaries) {
    const parsed = parseRecordUri(diary.uri);
    if (!parsed) continue;
    if (keep.has(diary.uri)) {
      console.log(`[keep] ${diary.uri}`);
      continue;
    }
    if (isTrilinesDiarySharedToNagi(await currentDiary(parsed.did, parsed.rkey))) {
      console.log(`[shared] ${diary.uri}`);
      continue;
    }
    const replies = await db
      .select({ uri: nagiPosts.uri })
      .from(nagiPosts)
      .where(
        and(
          eq(nagiPosts.did, config.botDid),
          isNull(nagiPosts.deletedAt),
          or(eq(nagiPosts.replyParentUri, diary.uri), eq(nagiPosts.replyRootUri, diary.uri)),
        ),
      );
    const jobs = await db
      .select({ replyUri: nagiBotReplyJobs.replyUri })
      .from(nagiBotReplyJobs)
      .where(eq(nagiBotReplyJobs.sourceUri, diary.uri));
    const reactions = await db
      .select({ uri: nagiReactions.uri })
      .from(nagiReactions)
      .where(and(eq(nagiReactions.did, config.botDid), eq(nagiReactions.subjectUri, diary.uri)));
    const botRecords = [
      ...new Set([
        ...replies.map((row) => row.uri),
        ...jobs.flatMap((row) => (row.replyUri ? [row.replyUri] : [])),
        ...reactions.map((row) => row.uri),
      ]),
    ];
    targets.push({ uri: diary.uri, did: parsed.did, rkey: parsed.rkey, text: diary.text, botRecords });
  }

  for (const target of targets) {
    console.log(`[target] ${target.uri} ${JSON.stringify(target.text.slice(0, 40))}`);
    for (const uri of target.botRecords) console.log(`  bot record: ${uri}`);
  }
  if (!apply) {
    console.log(`Dry run: ${targets.length} diaries. Pass --apply to purge them.`);
    return;
  }

  const runtime = createBotAgent({
    identifier: config.botDid,
    password: process.env.NAGI_BOT_APP_PASSWORD,
  });
  await runtime.login();
  for (const target of targets) {
    for (const uri of target.botRecords) {
      const parsed = parseRecordUri(uri);
      if (!parsed || parsed.did !== config.botDid) continue;
      await runtime.agent.com.atproto.repo.deleteRecord({
        repo: config.botDid,
        collection: parsed.collection,
        rkey: parsed.rkey,
      });
      // Jetstream を待たずに AppView から消す（PDS に無いので削除として適用される）。
      await ensurePdsRecord(parsed.did, parsed.collection, parsed.rkey);
      console.log(`  deleted ${uri}`);
    }
    // PDS の日記は印が無いので、AppView では削除扱いになる。
    await ensurePdsRecord(target.did, TRILINES.diary, target.rkey);
    await db.delete(nagiBotReplyJobs).where(eq(nagiBotReplyJobs.sourceUri, target.uri));
    console.log(`[purged] ${target.uri}`);
  }
}

main()
  .catch((error) => {
    console.error("[ERROR][TRILINES_PURGE]", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end();
  });
