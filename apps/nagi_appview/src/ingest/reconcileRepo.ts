import {
  db,
  nagiCardGets,
  nagiChannels,
  nagiEmojis,
  nagiNews,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import { BLUEMOJI_ITEM, NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq, like } from "drizzle-orm";
import { STANDARD_DOCUMENT } from "./standardDocument.js";
import { config } from "../config.js";
import { resolvePdsUrl } from "../util/pds.js";
import { applyMutation } from "./applyMutation.js";
import { withDidLock } from "./didLock.js";
import {
  isNormalizedBluemojiFormats,
  validateRecord,
} from "./validateRecord.js";

type RepoRecord = {
  uri: string;
  cid: string;
  value: unknown;
};

type LocalRecord = {
  cid?: string;
  active: boolean;
  tombstoned?: boolean;
};

type ReconcileStats = {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  invalid: number;
};

export type BluemojiAudit = {
  remote: number;
  compliant: number;
  invalid: number;
  upsert: number;
  remove: number;
};

class RecordNotFound extends Error {}

const USER_COLLECTIONS = [
  NAGI.profile,
  NAGI.channel,
  BLUEMOJI_ITEM,
  NAGI.post,
  // 旧世代の「Nagi post + standard.site コピー」を先に post として確定し、
  // 同じ rkey の document を二重索引しない。
  STANDARD_DOCUMENT,
  NAGI.reaction,
  NAGI.news,
  NAGI.cardGet,
  // ゼンカツの提出。クライアントは createRecord 直後に ensureRecord を呼び、
  // Jetstream の到着を待たずに記録へ反映させる。
  NAGI.zenkatsu,
] as const;

// 日記は PDS に置かない（AppView にだけある）ので、照合の対象にしない。
const BOT_COLLECTIONS = [...USER_COLLECTIONS, NAGI.news] as const;

export const isReconcilableCollection = (
  did: string,
  collection: string,
): boolean => {
  const allowed: readonly string[] =
    did === config.botDid ? BOT_COLLECTIONS : USER_COLLECTIONS;
  return allowed.includes(collection);
};

const recordKey = (uri: string): string => uri.slice(uri.lastIndexOf("/") + 1);

async function xrpc<T>(
  pds: URL,
  method: string,
  params: URLSearchParams,
): Promise<T> {
  const url = new URL(`/xrpc/${method}`, pds);
  url.search = params.toString();
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    if (
      method === "com.atproto.repo.getRecord" &&
      (response.status === 404 ||
        body.error === "RecordNotFound" ||
        /record not found/i.test(body.message ?? ""))
    ) {
      throw new RecordNotFound();
    }
    throw new Error(
      `${method} failed (${response.status}): ${body.error ?? body.message ?? "unknown error"}`,
    );
  }
  return response.json() as Promise<T>;
}

async function listRecords(
  pds: URL,
  did: string,
  collection: string,
): Promise<RepoRecord[]> {
  const records: RepoRecord[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      repo: did,
      collection,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const page = await xrpc<{ records: RepoRecord[]; cursor?: string }>(
      pds,
      "com.atproto.repo.listRecords",
      params,
    );
    records.push(...page.records);
    cursor = page.cursor;
  } while (cursor);
  return records;
}

async function getRecord(
  pds: URL,
  did: string,
  collection: string,
  rkey: string,
): Promise<RepoRecord> {
  return xrpc<RepoRecord>(
    pds,
    "com.atproto.repo.getRecord",
    new URLSearchParams({ repo: did, collection, rkey }),
  );
}

async function localRecords(
  did: string,
  collection: string,
): Promise<Map<string, LocalRecord>> {
  if (collection === NAGI.profile) {
    const rows = await db
      .select({ did: nagiProfiles.did })
      .from(nagiProfiles)
      .where(eq(nagiProfiles.did, did));
    return new Map(
      rows.map(
        () => [`at://${did}/${NAGI.profile}/self`, { active: true }] as const,
      ),
    );
  }
  if (collection === NAGI.post || collection === STANDARD_DOCUMENT) {
    const rows = await db
      .select({
        uri: nagiPosts.uri,
        cid: nagiPosts.cid,
        deletedAt: nagiPosts.deletedAt,
      })
      .from(nagiPosts)
      // こっそり投稿は PDS に正本が無い。ここへ混ぜると listRecords に出てこない行として
      // 毎回「PDS から消えた」と判定され、reconcile のたびに全部消える。
      .where(and(eq(nagiPosts.did, did), eq(nagiPosts.appviewOnly, false),
        like(nagiPosts.uri, `at://${did}/${collection}/%`)));
    return new Map(
      rows.map((row) => [
        row.uri,
        {
          cid: row.cid,
          active: row.deletedAt === null,
          tombstoned: row.deletedAt !== null,
        },
      ]),
    );
  }
  if (collection === NAGI.reaction) {
    const rows = await db
      .select({ uri: nagiReactions.uri, cid: nagiReactions.cid })
      .from(nagiReactions)
      .where(eq(nagiReactions.did, did));
    return new Map(
      rows.map((row) => [row.uri, { cid: row.cid, active: true }]),
    );
  }
  if (collection === NAGI.channel) {
    const rows = await db
      .select({
        uri: nagiChannels.uri,
        cid: nagiChannels.cid,
        deletedAt: nagiChannels.deletedAt,
      })
      .from(nagiChannels)
      .where(eq(nagiChannels.did, did));
    return new Map(
      rows.map((row) => [
        row.uri,
        {
          cid: row.cid,
          active: row.deletedAt === null,
          tombstoned: row.deletedAt !== null,
        },
      ]),
    );
  }
  if (collection === BLUEMOJI_ITEM) {
    const rows = await db
      .select({
        uri: nagiEmojis.uri,
        cid: nagiEmojis.cid,
        formats: nagiEmojis.formats,
      })
      .from(nagiEmojis)
      .where(eq(nagiEmojis.did, did));
    return new Map(
      rows.map((row) => [
        row.uri,
        { cid: row.cid, active: isNormalizedBluemojiFormats(row.formats) },
      ]),
    );
  }
  if (collection === NAGI.news) {
    const rows = await db
      .select({
        uri: nagiNews.uri,
        cid: nagiNews.cid,
        deletedAt: nagiNews.deletedAt,
      })
      .from(nagiNews)
      .where(eq(nagiNews.did, did));
    return new Map(
      rows.map((row) => [
        row.uri,
        {
          cid: row.cid,
          active: row.deletedAt === null,
          tombstoned: row.deletedAt !== null,
        },
      ]),
    );
  }
  if (collection === NAGI.cardGet) {
    const rows = await db
      .select({
        uri: nagiCardGets.uri,
        cid: nagiCardGets.cid,
        deletedAt: nagiCardGets.deletedAt,
      })
      .from(nagiCardGets)
      .where(eq(nagiCardGets.did, did));
    return new Map(
      rows.map((row) => [
        row.uri,
        {
          cid: row.cid,
          active: row.deletedAt === null,
          tombstoned: row.deletedAt !== null,
        },
      ]),
    );
  }
  return new Map();
}

const eventFor = (
  did: string,
  collection: string,
  operation: "create" | "update" | "delete",
  record: RepoRecord | { uri: string },
) => ({
  did,
  time_us: Date.now() * 1_000,
  commit: {
    operation,
    collection,
    rkey: recordKey(record.uri),
    ...("cid" in record ? { cid: record.cid, record: record.value } : {}),
  },
});

async function applyCurrentRecord(
  pds: URL,
  did: string,
  collection: string,
  uri: string,
): Promise<"upserted" | "deleted"> {
  return withDidLock(did, async () => {
    try {
      const current = await getRecord(pds, did, collection, recordKey(uri));
      if (!validateRecord(collection, current.value)) {
        await applyMutation(eventFor(did, collection, "delete", { uri }));
        return "deleted";
      }
      await applyMutation(eventFor(did, collection, "update", current), {
        reconcile: true,
      });
      return "upserted";
    } catch (error) {
      if (!(error instanceof RecordNotFound)) throw error;
      await applyMutation(eventFor(did, collection, "delete", { uri }));
      return "deleted";
    }
  });
}

/**
 * PDS の現在状態に AppView を合わせる。書き込み直後にクライアントから叩かれる経路で、
 * firehose を待たずに反映するために使う。
 *
 * 作成・更新だけでなく削除も扱えるよう、PDS にレコードが無い場合は例外にせず
 * `absent` を返して削除を適用する。firehose が死んでいる間、Nagi クライアント発の
 * 操作がこの経路だけで完結できるようにするため。
 */
export type EnsureResult =
  | { status: "present"; record: RepoRecord }
  | { status: "absent" };

export async function ensurePdsRecord(
  did: string,
  collection: string,
  rkey: string,
): Promise<EnsureResult> {
  if (!isReconcilableCollection(did, collection)) {
    throw new Error("Unsupported collection");
  }
  const pds = await resolvePdsUrl(did);
  return withDidLock(did, async () => {
    let current: RepoRecord;
    try {
      current = await getRecord(pds, did, collection, rkey);
    } catch (error) {
      if (!(error instanceof RecordNotFound)) throw error;
      await applyMutation(
        eventFor(did, collection, "delete", {
          uri: `at://${did}/${collection}/${rkey}`,
        }),
        { emitPush: true },
      );
      return { status: "absent" };
    }
    if (!validateRecord(collection, current.value)) {
      throw new Error("Record failed validation");
    }
    await applyMutation(eventFor(did, collection, "update", current), {
      emitPush: true,
    });
    return { status: "present", record: current };
  });
}

export async function reconcileRepo(
  did: string,
  onlyCollection?: string,
): Promise<ReconcileStats> {
  const startedAt = Date.now();
  const pds = await resolvePdsUrl(did);
  const allowed = did === config.botDid ? BOT_COLLECTIONS : USER_COLLECTIONS;
  const collections = onlyCollection
    ? allowed.filter((collection) => collection === onlyCollection)
    : allowed;
  if (onlyCollection && collections.length === 0)
    throw new Error(
      `Collection is not reconcilable for ${did}: ${onlyCollection}`,
    );

  const stats: ReconcileStats = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    invalid: 0,
  };

  for (const collection of collections) {
    const [remote, local] = await Promise.all([
      listRecords(pds, did, collection),
      localRecords(did, collection),
    ]);
    const remoteUris = new Set(remote.map((record) => record.uri));

    // listRecords が全ページ成功した後にだけ、欠落候補を個別確認する。
    // PDS にないローカル行を先に外すことで、意味重複の最新レコードが削除された場合も
    // この sweep 内で PDS に残る次のレコードへ復帰できるようにする。
    for (const [uri, localRecord] of local) {
      if (remoteUris.has(uri)) continue;
      // 投稿・チャンネル・ニュースの削除済み投影を毎回 deleted に数え直さない。
      if (localRecord.tombstoned) {
        stats.unchanged++;
        continue;
      }
      const result = await applyCurrentRecord(pds, did, collection, uri);
      if (result === "deleted") stats.deleted++;
      else stats.updated++;
    }

    for (const record of remote) {
      const localRecord = local.get(record.uri);
      if (!validateRecord(collection, record.value)) {
        stats.invalid++;
        // PDSに規格外レコードが残る限り、未投影のものを毎回 delete 扱いしない。
        if (localRecord) {
          const result = await applyCurrentRecord(
            pds,
            did,
            collection,
            record.uri,
          );
          if (result === "deleted") stats.deleted++;
          else stats.updated++;
        }
        continue;
      }
      if (localRecord?.active && localRecord.cid === record.cid) {
        stats.unchanged++;
        continue;
      }
      const result = await applyCurrentRecord(pds, did, collection, record.uri);
      if (result === "deleted") stats.deleted++;
      else if (local.has(record.uri)) stats.updated++;
      else stats.created++;
    }
  }

  console.log("[INFO][reconcile] Repository reconciled", {
    did,
    collections,
    ...stats,
    durationMs: Date.now() - startedAt,
  });
  return stats;
}

/** 本番適用前に、Bluemoji 派生DBへ加わる変更数だけを読み取りで確認する。 */
export async function auditBluemojiRepo(did: string): Promise<BluemojiAudit> {
  const pds = await resolvePdsUrl(did);
  const [remote, local] = await Promise.all([
    listRecords(pds, did, BLUEMOJI_ITEM),
    localRecords(did, BLUEMOJI_ITEM),
  ]);
  const remoteUris = new Set(remote.map((record) => record.uri));
  let compliant = 0;
  let invalid = 0;
  let upsert = 0;
  let invalidLocal = 0;
  for (const record of remote) {
    if (!validateRecord(BLUEMOJI_ITEM, record.value)) {
      invalid++;
      if (local.has(record.uri)) invalidLocal++;
      continue;
    }
    compliant++;
    const current = local.get(record.uri);
    if (!current?.active || current.cid !== record.cid) upsert++;
  }
  return {
    remote: remote.length,
    compliant,
    invalid,
    upsert,
    remove:
      [...local.keys()].filter((uri) => !remoteUris.has(uri)).length +
      invalidLocal,
  };
}
