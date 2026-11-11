import webpush from "web-push";
import { db, nagiActors, nagiProfiles } from "@bsky-affirmative-bot/database";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import {
  invalidateSubscription,
  listSubscriptions,
  markSubscriptionSuccess,
} from "../queries/pushSubscriptions.js";
import { loadMutes } from "../queries/mutes.js";
import { buildPushPayload, type PushNotificationType } from "./pushPayload.js";
import {
  loadNotificationPreferences,
  notificationCategory,
  preferenceFor,
} from "./notificationPreferences.js";

let configured = false;
let warnedMissingConfig = false;
/** VAPID 未設定ならプッシュ配信を無効化（通知の挿入自体は従来どおり続く）。 */
function ensureConfigured(): boolean {
  if (!config.vapid) {
    if (!warnedMissingConfig) {
      console.warn("[push] delivery disabled: VAPID keys are not configured");
      warnedMissingConfig = true;
    }
    return false;
  }
  if (!configured) {
    webpush.setVapidDetails(
      config.vapid.subject,
      config.vapid.publicKey,
      config.vapid.privateKey,
    );
    configured = true;
  }
  return true;
}

export type { PushNotificationType };

export interface PushJob {
  recipientDid: string;
  type: PushNotificationType;
  actorDid: string;
  /**
   * 対応する nagi.notifications.id。通知タグの一意性はこの値だけで担保されるため
   * 任意にはできない（詳細は pushPayload.ts のコメント）。通知行を insert した
   * 直後の returning から必ず渡すこと。
   */
  notificationId: string;
  /** リアクション絵文字など、操作そのものを説明する短い文字列。 */
  actionText?: string;
  /** 新規内容。リアクションだけは対象投稿のプレビュー。 */
  contentText?: string;
}

async function actorName(did: string): Promise<string> {
  const [profile] = await db
    .select({ displayName: nagiProfiles.displayName })
    .from(nagiProfiles)
    .where(eq(nagiProfiles.did, did))
    .limit(1);
  if (profile?.displayName) return profile.displayName;
  const [actor] = await db
    .select({ handle: nagiActors.handle })
    .from(nagiActors)
    .where(eq(nagiActors.did, did))
    .limit(1);
  return actor?.handle ?? "だれか";
}

/**
 * 受信者の全購読へ Web Push を送信する。fire-and-forget 前提で呼び、失効した購読
 * (404/410) は掃除する。送らずに終わる場合（ミュート・購読ゼロ）も必ず理由をログに残す。
 */
export async function dispatchPush(job: PushJob): Promise<void> {
  if (!ensureConfigured()) return;
  // 通知一覧に出ないものはプッシュも送らない。ingest のトランザクション外なので、
  // ここでミュートを引いてもホットパスは重くならない。
  const [mutes, preferences] = await Promise.all([
    loadMutes(job.recipientDid),
    loadNotificationPreferences(job.recipientDid),
  ]);
  // 早期 return は必ずログを残す。無言で return していたせいで「通知は発生している
  // のに端末が1つも登録されていない」状態に長期間気づけなかった実績がある。
  if (mutes.actors.includes(job.actorDid)) {
    console.info(
      `[push] skipped by mute type=${job.type} recipient=${job.recipientDid} actor=${job.actorDid}`,
    );
    return;
  }
  // 本人が通知設定でプッシュを切ったカテゴリ。通知欄に出すかどうか（list）とは独立に見る。
  const category = notificationCategory(job.type, job.actorDid);
  if (!preferenceFor(preferences, category).push) {
    console.info(
      `[push] skipped by preference type=${job.type} category=${category} recipient=${job.recipientDid}`,
    );
    return;
  }
  const subs = await listSubscriptions(job.recipientDid);
  if (!subs.length) {
    console.info(
      `[push] no subscriptions type=${job.type} recipient=${job.recipientDid}`,
    );
    return;
  }
  const payload = JSON.stringify(
    buildPushPayload({
      type: job.type,
      notificationId: job.notificationId,
      actorName: await actorName(job.actorDid),
      actionText: job.actionText,
      contentText: job.contentText,
    }),
  );
  let accepted = 0;
  let expired = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          {
            // web-push の既定は4週間。端末が長く落ちていた場合に、もう意味のない
            // 通知が後からまとめて溢れるのを避ける。
            TTL: 86400,
            // Apple Push は urgency が低いと配信を遅延・集約する。対話的な通知なので high。
            urgency: "high",
          },
        );
        accepted += 1;
        await markSubscriptionSuccess(sub.endpoint).catch(() => {});
      } catch (e: any) {
        const status = e?.statusCode;
        if (status === 404 || status === 410) {
          await invalidateSubscription(
            sub.endpoint,
            status === 404 ? "push_service_404" : "push_service_410",
          ).catch(() => {});
          expired += 1;
        } else {
          failed += 1;
          console.error(
            `[push] send failed status=${status} service=${endpointService(sub.endpoint)}`,
            e?.body ?? e?.message,
          );
        }
      }
    }),
  );
  // accepted は「プッシュサービスが受理した数」であって「端末に表示された数」ではない。
  // 表示可否は端末側の SW と OS の通知設定に依存し、サーバーからは一切観測できない。
  // ここを sent と呼んでいたため、配信できている前提で調査が始まる事故が起きた。
  const services = [...new Set(subs.map((s) => endpointService(s.endpoint)))];
  console.info(
    `[push] dispatch type=${job.type} recipient=${job.recipientDid} ` +
      `subscriptions=${subs.length} accepted=${accepted} expired=${expired} failed=${failed} ` +
      `services=${services.join(",")}`,
  );
}

/** ログ用にエンドポイントのホスト名だけ取り出す（どの端末種別かの切り分けに使う）。 */
function endpointService(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

/** 複数ジョブをまとめて非同期発火。イングェストをブロックしないよう待たない用途で使う。 */
export function dispatchPushAll(jobs: PushJob[]): void {
  for (const job of jobs)
    void dispatchPush(job).catch((error) => {
      console.error(`[push] dispatch failed type=${job.type}`, error);
    });
}
