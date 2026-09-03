import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyFeedPost, AtpAgent } from "@atproto/api";
import { agent } from "./agent.js";
import { features } from "../features/index.js";
import { MemoryService, botBiothythmManager } from "@bsky-affirmative-bot/clients";
import { followerMap, updateFollowers } from "./followerManagement.js";
import { getLangStr, splitUri, isIgnoreTarget, hasNGWord, isIgnorePost, isReplyOrMentionToMe, hasBroadcastDomainLink, hasAffiliateDomainLink, hasAnyLink, getLatestPostOf, isReplyInThirdPartyThread, isNagiCrosspost } from "./util.js";
import { follow } from "./follow.js";
import { replyGreets } from "./replyGreets.js";
import retry from 'async-retry';
import { ProfileView } from "@atproto/api/dist/client/types/app/bsky/actor/defs.js";
import { tombstoneBotMemoriesByUri, updateBotMemoriesByUri } from "@bsky-affirmative-bot/database";

import { FeatureContext } from "../features/types.js";

function eventPostUri(event: any) {
  return `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
}

export async function onPostUpdate(event: any) {
  const text = event.commit?.record?.text;
  if (typeof text !== "string") return;
  await updateBotMemoriesByUri(eventPostUri(event), text);
}

export async function onPostDelete(event: any) {
  await tombstoneBotMemoriesByUri(eventPostUri(event));
}

export async function onPost(event: any) {
  const authorDid = event.did;
  const record = event.commit.record as AppBskyFeedPost.Record;
  const follower = followerMap.get(authorDid);
  const text = record.text || "";
  if (!follower) return; // Only handle followers for most features

  try {
    await retry(
      async () => {
        // Self filter
        if (authorDid === process.env.BSKY_DID) return;

        // NagiからのクロスポストはNagi側のbotたんが反応するため、こちらでは反応しない
        if (isNagiCrosspost(record)) {
          console.log(`[INFO][${authorDid}] Ignored as Nagi crosspost`);
          return;
        }

        // 被ブロックチェック＆キャッシュ削除
        // followerMapはフォロー発生時に更新されるが、それ以外にここでもブロックチェックする
        try {
          const { data: profile } = await agent.getProfile({ actor: authorDid });
          if (profile.viewer?.blockedBy || profile.viewer?.blocking) {
            console.log(`[INFO][${authorDid}] Block relation detected (blockedBy: ${profile.viewer?.blockedBy}, blocking: ${profile.viewer?.blocking}). Removing from follower cache and skipping.`);
            followerMap.delete(authorDid);
            return;
          }
        } catch (profileErr: any) {
          console.warn(`[WARN][${authorDid}] Failed to fetch profile for block check. Skipping. Error:`, profileErr.message);
          if (profileErr.status === 400 || profileErr.message?.includes('not found') || profileErr.message?.includes('Could not find')) {
            followerMap.delete(authorDid);
          }
          return;
        }

        // feature gating 用: active subscriber + developer のみ
        const subscribers = await MemoryService.getSubscribersOrDeveloper();
        const isSubscriber = subscribers.includes(authorDid);
        // 日記・応援など: active + discord_only + developer
        const communityMembers = await MemoryService.getCommunityMembersOrDeveloper();
        const isCommunityMember = communityMembers.includes(authorDid);
        // ラベル/スパム/botチェックのスキップ用: inactive も含む登録済み subscriber
        const registeredDids = await MemoryService.getSubscriberDidsIncludingInactive();
        const isRegisteredSubscriber = registeredDids.includes(authorDid);
        if (!isSubscriber && !isRegisteredSubscriber) {
          // Label filter
          if (isIgnoreTarget(follower.labels)) {
            console.log(`[INFO][${authorDid}] Ignored due to author labels`);
            return;
          }

          // External & Self Label filter via AppView
          // 外部ラベラー（Official Moderation等）の反映を待つため少し待機
          await new Promise(resolve => setTimeout(resolve, 3000));
          const uri = `at://${authorDid}/${event.commit.collection}/${event.commit.rkey}`;
          const response = await agent.app.bsky.feed.getPosts({ uris: [uri] });
          const postView = response.data.posts[0];
          if (postView && isIgnorePost(postView)) {
            console.log(`[INFO][${authorDid}] Ignored due to post labels (fetched from AppView)`);
            return;
          }

          // Spam filter
          if (hasNGWord(text)) {
            console.log(`[INFO][${authorDid}] Ignored due to NG word`);
            if (isReplyOrMentionToMe(record)) {
              console.log(`[INFO][${authorDid}] Saving NG word to replies table for blacklisting`);
              await MemoryService.upsertReply(authorDid, { reply: text, uri: uri, isRead: 0 });
            }
            return;
          }

          // Bot check
          if (await isBotUser(authorDid)) {
            console.log(`[INFO][${authorDid}] Ignored as bot user`);
            return;
          }

          if (await isAutoPost(authorDid, record, agent)) {
            console.log(`[INFO][${authorDid}] Ignored as auto-post`);
            return;
          }
        }

        // 第三者スレッドへの割り込みメンションは全機能をスキップ
        if (isReplyInThirdPartyThread(record, authorDid)) {
          console.log(`[INFO][${authorDid}] Skipping features: third-party thread root`);
          return;
        }

        const context: FeatureContext = { isSubscriber, isCommunityMember };

        for (const feature of features) {
          try {
            if (await feature.shouldHandle(event, follower, context)) {
              console.log(`[INFO][${authorDid}] Feature matched: ${feature.name}`);

              // 統一した3回リトライ機構で該当の handle を実行する
              await retry(
                async () => {
                  await feature.handle(event, follower, context);
                  if (!feature.handlesOwnLogging) {
                    await MemoryService.logUsage(feature.name, authorDid, { text });
                  }
                },
                {
                  retries: 2, // 初回 + リトライ2回 = 計3回
                  onRetry: (err: any, attempt) => {
                    console.warn(`[WARN][${authorDid}] Retry attempt ${attempt} for Feature ${feature.name} failed:`, err.message);
                  }
                }
              );

              break;
            }
          } catch (e) {
            console.error(`[ERROR][${authorDid}] Feature ${feature.name} failed after all retries:`, e);
            // 3回リトライしても失敗した場合は、次の機能（会話機能など）にフォールスルーさせるため、あえて break しない
          }
        }
      },
      {
        retries: 3,
        onRetry: (err, attempt) => {
          console.warn(`[WARN][${authorDid}] Retry attempt ${attempt} for onPost:`, err);
        },
      }
    );
  } catch (e) {
    console.error(`[ERROR][${authorDid}] onPost failed unexpectedly:`, e);
  }
}

export async function onFollow(event: any) {
  const did = event.did;
  const record = event.commit.record as any;

  // Bot target filter
  if (record.subject !== process.env.BSKY_DID) return;

  console.log(`[INFO] New follow detected from ${did}`);

  // Optimistic update
  if (!followerMap.has(did)) {
    try {
      const { data: profile } = await agent.getProfile({ actor: did });
      followerMap.set(did, profile as ProfileView);
      console.log(`[INFO] ${did} added to follower map optimistically.`);
    } catch (e) {
      console.warn(`[WARN] Failed to fetch profile for ${did} optimistically.`);
    }
  }

  const profile = followerMap.get(did);
  if (profile && isIgnoreTarget(profile.labels)) {
    console.log(`[INFO] ${did} is ignored due to author labels. Skipping follow-back.`);
    return;
  }

  // Background full update
  updateFollowers().catch(e => console.error("[ERROR] Background follower update failed:", e));

  // Check if new user in DB
  const isExist = await MemoryService.getFollower(did);
  if (isExist && isExist.created_at) {
    console.log(`[INFO] ${did} is an existing user. Skipping follow-back.`);
    return;
  }

  console.log(`[INFO] New follower: ${did}! Executing follow-back and greeting.`);

  try {
    // エネルギー加算の失敗でフォローバックを止めないよう、ここでは待たずに握る。
    botBiothythmManager.addFollower()
      .catch(e => console.error("[ERROR] Failed to add follower energy:", e));
    await MemoryService.logUsage('follow', did);
    await follow(did);

    const latestFeed = await getLatestPostOf(did);
    if (latestFeed) {
      const postRecord = latestFeed.post.record as AppBskyFeedPost.Record;
      const langStr = getLangStr(postRecord.langs);
      await replyGreets(latestFeed.post, langStr);
    }

    await MemoryService.ensureFollower(did);
  } catch (e) {
    console.error("[ERROR] Follow/Greet process failed:", e);
  }
}

export async function onLike(event: any) {
  const did = event.did;
  const record = event.commit.record as any;
  const { did: subjectDid, nsid, rkey } = splitUri(record.subject.uri);

  if (subjectDid !== process.env.BSKY_DID) return;
  // AI返信でいいねへ言及するのは購読者だけ。反応された本文はbotたん自身の投稿なので、
  // 横断RAGには保存しない。非購読者のいいねも既存のenergy・集計には反映する。
  const isSubscriber = (await MemoryService.getSubscribersOrDeveloper()).includes(did);

  try {
    await retry(async () => {
      const uri = record.subject.uri;
      const existingLike = await MemoryService.getLike(did);
      if (existingLike && existingLike.uri === uri) {
        return;
      }

      console.log(`[INFO] Detected like from: ${did}`);

      const response = await agent.com.atproto.repo.getRecord({
        repo: subjectDid,
        collection: nsid,
        rkey,
      });
      const text = (response.data.value as any).text;

      // Update BioRhythm and DB
      await botBiothythmManager.addLike();

      if (isSubscriber) {
        await MemoryService.upsertLike({ did, liked_post: text, uri });
      }
      // 全体の反応数とenergyは従来仕様を維持するため、集計イベントは全員分を残す。
      await MemoryService.logUsage('like', did, { uri, text });
    }, {
      retries: 3,
      onRetry: (err, attempt) => {
        console.warn(`[WARN][${did}] Retry attempt ${attempt} for onLike:`, err);
      }
    });
  } catch (e) {
    console.error(`[ERROR][${did}] onLike failed:`, e);
  }
}

export async function onLikeDelete(_event: any) {}

async function isBotUser(did: string): Promise<boolean> {
  const follower = followerMap.get(did);

  if (follower) {
    // handle に "bot" が含まれているか（大文字小文字を区別しない）
    if (follower.handle && follower.handle.toLowerCase().includes('bot')) {
      console.log(`[INFO][${did}] Bot detected: handle "${follower.handle}" contains "bot"`);
      return true;
    }
    // "bot" Label が付いているか
    if (follower.labels && follower.labels.some((l: any) => l.val === 'bot')) {
      console.log(`[INFO][${did}] Bot detected: label "bot" found`);
      return true;
    }
  }

  return false;
}

async function isAutoPost(did: string, record: AppBskyFeedPost.Record | any, agent: AtpAgent): Promise<boolean> {
  // 2. 配信ドメインリンクありの投稿 → 無視
  if (hasBroadcastDomainLink(record)) {
    console.log(`[INFO][${did}] AutoPost detected: post contains broadcast domain link`);
    return true;
  }

  // 3. アフィドメインリンクありの投稿 → 無視
  if (hasAffiliateDomainLink(record)) {
    console.log(`[INFO][${did}] AutoPost detected: post contains affiliate domain link`);
    return true;
  }

  // 直近20件の投稿を取得して判定する
  try {
    const response = await agent.getAuthorFeed({ actor: did, limit: 20 });
    const feed = response.data.feed;

    if (feed && feed.length > 0) {
      let affiliateLinkCount = 0;
      let replyCount = 0;
      let anyLinkCount = 0;

      for (const item of feed) {
        const feedRecord = item.post.record as any;

        // アフィドメインのチェック
        if (hasAffiliateDomainLink(feedRecord)) {
          affiliateLinkCount++;
        }

        // リプライ判定
        if (feedRecord.reply) {
          replyCount++;
        }

        // 何らかの外部リンク判定
        if (hasAnyLink(feedRecord)) {
          anyLinkCount++;
        }
      }

      // 4. 直近20件にアフィドメインリンクを8件以上含む → 無視
      if (affiliateLinkCount >= 8) {
        console.log(`[INFO][${did}] AutoPost detected: ${affiliateLinkCount} affiliate domain links in last 20 posts`);
        return true;
      }

      // 5. 直近20件にリプライが1件もない ＋ 全リンクつき投稿 → 無視
      if (replyCount === 0 && anyLinkCount === feed.length) {
        console.log(`[INFO][${did}] AutoPost detected: 0 replies and all posts have links in last ${feed.length} posts`);
        return true;
      }
    }
  } catch (err: any) {
    console.warn(`[WARN][${did}] Failed to fetch author feed for auto-post checks:`, err.message);
  }

  return false;
}
