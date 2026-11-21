import { startBotJetstream, type BotJetstreamConnection } from "@bsky-affirmative-bot/bot-runtime";
import { BLUESKY_PUSH_CATEGORIES } from "@bsky-affirmative-bot/nagi-lexicon";
import { db, nagiNotificationPreferences } from "@bsky-affirmative-bot/database";
import { config } from "../config.js";
import { viewerIsAdult } from "./ageAssurance.js";
import { blueskyPushTargets, type BlueskyPushTarget, type PostPreview } from "./blueskyPushTargets.js";
import {
  loadNotificationPreferences,
  preferenceFor,
  sanitizeStoredNotificationPreferences,
} from "./notificationPreferences.js";
import { deliverPush } from "./pushDispatch.js";
import { buildBlueskyPushPayload, postPushBody } from "./pushPayload.js";

/**
 * Bluesky の通知の Push（クライアント仕様 NOTIFY-08・09）。
 *
 * Push を有効にした利用者宛ての公開された操作を Jetstream から受け、Web Push を送る。
 * Bluesky の投稿・表示名・操作は配信のために公開 API から一時的に引くだけで、DB に保存しない（BSKY-01）。
 * ミュートは本人の認証なしに知る手段が無いので反映しない（2026-11-21 に許容）。ブロックは公開されて
 * いるので確かめ、確かめられなければ送らない。
 */

const PUBLIC_API = "https://public.api.bsky.app/xrpc";
const COLLECTIONS = [
  "app.bsky.feed.post",
  "app.bsky.feed.like",
  "app.bsky.feed.repost",
  "app.bsky.graph.follow",
];
/** 年齢の保護で本文を伏せるラベル。クライアントの BLUESKY_MEDIA_BLUR_LABELS と揃える。 */
const ADULT_LABELS = new Set(["porn", "sexual", "nudity", "graphic-media"]);
/** 処理が詰まったら古いものから捨てる。捨てた分の Push は届かないが、通知タブで確かめられる。 */
const QUEUE_LIMIT = 1000;
const FETCH_TIMEOUT_MS = 5_000;
const RECIPIENT_RELOAD_MS = 10 * 60_000;

/** Push を1種類でも有効にしている利用者。受信のたびに DB を読まないよう覚えておく。 */
const recipients = new Set<string>();

const wantsAnyBlueskyPush = (stored: unknown) => {
  const preferences = sanitizeStoredNotificationPreferences(stored);
  return BLUESKY_PUSH_CATEGORIES.some((category) => preferenceFor(preferences, category).push);
};

async function reloadRecipients(): Promise<void> {
  const rows = await db
    .select({
      did: nagiNotificationPreferences.did,
      preferences: nagiNotificationPreferences.preferences,
    })
    .from(nagiNotificationPreferences);
  recipients.clear();
  for (const row of rows) if (wantsAnyBlueskyPush(row.preferences)) recipients.add(row.did);
}

/** 通知設定を保存したあとに呼ぶ。保存の結果を読み直して宛先の集合に反映する。 */
export async function refreshBlueskyPushRecipient(did: string): Promise<void> {
  const preferences = await loadNotificationPreferences(did);
  if (BLUESKY_PUSH_CATEGORIES.some((category) => preferenceFor(preferences, category).push))
    recipients.add(did);
  else recipients.delete(did);
}

async function publicGet<T>(method: string, params: Record<string, string | string[]>): Promise<T> {
  const url = new URL(`${PUBLIC_API}/${method}`);
  for (const [key, value] of Object.entries(params))
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${method} failed: ${response.status}`);
  return (await response.json()) as T;
}

type Label = { val?: string };
const hasAdultLabel = (labels: (Label | string)[] | undefined) =>
  (labels ?? []).some((label) => ADULT_LABELS.has(typeof label === "string" ? label : (label.val ?? "")));

type Profile = { name: string; labels: Label[] };
const profileCache = new Map<string, { value: Profile; expiresAt: number }>();

async function profile(did: string): Promise<Profile> {
  const cached = profileCache.get(did);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await publicGet<{ displayName?: string; handle?: string; labels?: Label[] }>(
    "app.bsky.actor.getProfile",
    { actor: did },
  ).then(
    (data) => ({ name: data.displayName || data.handle || "だれか", labels: data.labels ?? [] }),
    () => ({ name: "だれか", labels: [] }),
  );
  if (profileCache.size > 5_000) profileCache.clear();
  profileCache.set(did, { value, expiresAt: Date.now() + 10 * 60_000 });
  return value;
}

/** どちらかがブロックしていれば true。確かめられなかったときも送らない側へ倒す。 */
async function blocked(recipientDid: string, actorDid: string): Promise<boolean> {
  try {
    const data = await publicGet<{ relationships?: Record<string, unknown>[] }>(
      "app.bsky.graph.getRelationships",
      { actor: recipientDid, others: [actorDid] },
    );
    const relation = data.relationships?.[0] ?? {};
    return ["blocking", "blockedBy", "blockingByList", "blockedByList"].some((key) => relation[key]);
  } catch (error) {
    console.warn(`[bluesky-push] block check failed recipient=${recipientDid}`, error);
    return true;
  }
}

/** いいね・リポストされた自分の投稿の本文とラベル。 */
async function subjectPreview(
  uri: string,
): Promise<{ preview: PostPreview; labels: Label[] } | undefined> {
  const data = await publicGet<{
    posts?: { record?: Record<string, unknown>; embed?: { $type?: string }; labels?: Label[] }[];
  }>("app.bsky.feed.getPosts", { uris: [uri] }).catch(() => undefined);
  const post = data?.posts?.[0];
  if (!post) return undefined;
  const embed = post.embed?.$type ?? "";
  return {
    preview: {
      text: typeof post.record?.text === "string" ? post.record.text : "",
      hasImages: embed.startsWith("app.bsky.embed.images"),
      hasVideo: embed.startsWith("app.bsky.embed.video"),
      hasQuote: embed.startsWith("app.bsky.embed.record"),
    },
    labels: post.labels ?? [],
  };
}

async function deliver(actorDid: string, target: BlueskyPushTarget): Promise<void> {
  const preferences = await loadNotificationPreferences(target.recipientDid);
  if (!preferenceFor(preferences, target.type).push) return;
  if (await blocked(target.recipientDid, actorDid)) {
    console.info(`[bluesky-push] skipped by block type=${target.type} recipient=${target.recipientDid}`);
    return;
  }
  await deliverPush(target.recipientDid, target.type, async () => {
    const [actor, adult, subject] = await Promise.all([
      profile(actorDid),
      viewerIsAdult(target.recipientDid),
      target.subjectUri ? subjectPreview(target.subjectUri) : Promise.resolve(undefined),
    ]);
    const preview = target.post ?? subject?.preview;
    // 成人確認できない人には、成人向けのラベルが付いた投稿の本文を入れない（BSKY-02）。
    // 返信などのラベルは投稿の直後にはまだ付いていないことが多いので、セルフラベルと作者のラベルも見る。
    const adultContent =
      hasAdultLabel(target.selfLabels) ||
      hasAdultLabel(actor.labels) ||
      hasAdultLabel(subject?.labels);
    return buildBlueskyPushPayload({
      type: target.type,
      recordUri: target.recordUri,
      actorName: actor.name,
      body: preview && (adult || !adultContent) ? postPushBody(preview) : "",
    });
  });
}

/**
 * Bluesky 用の受信を始める。Nagi の取り込み（公式 Jetstream に直接つなぐ）とは別の接続で、
 * bot と同じ自作の proxy へ向ける。proxy は cursor を上流へ渡さないので、止まっていた間の分は送らない。
 */
export async function startBlueskyPush(): Promise<BotJetstreamConnection | undefined> {
  if (!config.vapid) return undefined;
  await reloadRecipients();
  const reload = setInterval(() => {
    reloadRecipients().catch((error) => console.error("[bluesky-push] reload failed", error));
  }, RECIPIENT_RELOAD_MS);
  reload.unref();

  const queue: { actorDid: string; target: BlueskyPushTarget }[] = [];
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift()!;
      await deliver(job.actorDid, job.target).catch((error) =>
        console.error(`[bluesky-push] deliver failed type=${job.target.type}`, error),
      );
    }
    running = false;
  };
  const onEvent = (event: Parameters<typeof blueskyPushTargets>[0]) => {
    if (!recipients.size) return;
    for (const target of blueskyPushTargets(event, (did) => recipients.has(did))) {
      if (queue.length >= QUEUE_LIMIT) {
        queue.shift();
        console.warn("[bluesky-push] queue full, dropping the oldest push");
      }
      queue.push({ actorDid: event.did, target });
    }
    void drain();
  };

  const connection = startBotJetstream({
    endpoint: config.blueskyPushJetstreamUrl,
    wantedCollections: COLLECTIONS,
    onCreate: Object.fromEntries(COLLECTIONS.map((collection) => [collection, onEvent])),
  });
  console.info(`[bluesky-push] started recipients=${recipients.size}`);
  return {
    close: () => {
      clearInterval(reload);
      connection.close();
    },
  };
}
