import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  db,
  nagiActorAnalyses,
  nagiActors,
  nagiChannelSubscriptions,
  nagiChannels,
  nagiDiaries,
  nagiNews,
  nagiNewsApprovals,
  nagiNotifications,
  nagiPostScores,
  nagiPosts,
  nagiPrivateListMembers,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { assertSafeDevDatabase } from "./seedDevSafety.js";

const FIXTURE_AUTHOR_DID = "did:web:nagi-fixture.localhost";
const FIXTURE_FRIEND_DID = "did:web:nagi-friend.localhost";
const FIXTURE_PDS = "http://127.0.0.1:2583";
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

function requiredDid(name: string, value: string | undefined): string {
  if (!value || !DID_PATTERN.test(value)) {
    throw new Error(`${name} must be set to a valid DID`);
  }
  return value;
}

const atUri = (did: string, collection: string, rkey: string) =>
  `at://${did}/${collection}/${rkey}`;

const daysAgo = (now: Date, days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);

function localDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function seedDevelopmentDatabase(env = process.env) {
  const database = assertSafeDevDatabase(env);
  const botDid = requiredDid("NAGI_BOT_DID", env.NAGI_BOT_DID);
  const viewerDid = env.DEVELOPER_DID
    ? requiredDid("DEVELOPER_DID", env.DEVELOPER_DID)
    : FIXTURE_AUTHOR_DID;
  const now = new Date();
  const rootCreatedAt = daysAgo(now, 2);
  const replyCreatedAt = daysAgo(now, 1);
  const channelCreatedAt = daysAgo(now, 3);
  const channelPostCreatedAt = new Date(now.getTime() - 6 * 60 * 60 * 1_000);
  const newsCreatedAt = new Date(now.getTime() - 3 * 60 * 60 * 1_000);

  const rootUri = atUri(FIXTURE_AUTHOR_DID, NAGI.post, "dev-root-post");
  const replyUri = atUri(FIXTURE_FRIEND_DID, NAGI.post, "dev-reply-post");
  const channelUri = atUri(FIXTURE_AUTHOR_DID, NAGI.channel, "dev-channel");
  const channelPostUri = atUri(
    FIXTURE_FRIEND_DID,
    NAGI.post,
    "dev-channel-post",
  );
  const reactionUri = atUri(FIXTURE_FRIEND_DID, NAGI.reaction, "dev-reaction");
  const newsUri = atUri(botDid, NAGI.news, "dev-positive-news");
  const diaryDate = localDate(now);
  const diaryUri = atUri(botDid, NAGI.diary, `dev-diary-${diaryDate}`);

  const actorRows = [
    {
      did: botDid,
      handle: "bot-tan.com",
      pdsUrl: FIXTURE_PDS,
      status: "active",
      resolvedAt: now,
    },
    {
      did: FIXTURE_AUTHOR_DID,
      handle: "nagi-fixture.localhost",
      pdsUrl: FIXTURE_PDS,
      status: "active",
      resolvedAt: now,
    },
    {
      did: FIXTURE_FRIEND_DID,
      handle: "nagi-friend.localhost",
      pdsUrl: FIXTURE_PDS,
      status: "active",
      resolvedAt: now,
    },
    ...(viewerDid === FIXTURE_AUTHOR_DID || viewerDid === botDid
      ? []
      : [
          {
            did: viewerDid,
            handle: "developer.localhost",
            pdsUrl: FIXTURE_PDS,
            status: "active",
            resolvedAt: now,
          },
        ]),
  ];
  const profileRows = [
    {
      did: botDid,
      displayName: "Botたん（開発用）",
      description: "ローカルfixtureのBotたんです。",
      createdAt: daysAgo(now, 120),
      indexedAt: now,
    },
    {
      did: FIXTURE_AUTHOR_DID,
      displayName: "凪野 みなも",
      description: "ローカルAppViewの画面確認に使う開発用プロフィールです。",
      createdAt: daysAgo(now, 30),
      indexedAt: now,
    },
    {
      did: FIXTURE_FRIEND_DID,
      displayName: "風間 そよぎ",
      description: "返信やリアクション表示を確認するための開発用ユーザーです。",
      createdAt: daysAgo(now, 20),
      indexedAt: now,
    },
    ...(viewerDid === FIXTURE_AUTHOR_DID || viewerDid === botDid
      ? []
      : [
          {
            did: viewerDid,
            displayName: "開発ユーザー",
            description: "DEVELOPER_DID に対応するローカルfixtureです。",
            createdAt: daysAgo(now, 10),
            indexedAt: now,
          },
        ]),
  ];

  await db.transaction(async (tx) => {
    for (const actor of actorRows) {
      const insert = tx.insert(nagiActors).values(actor);
      if (
        actor.did === viewerDid &&
        ![FIXTURE_AUTHOR_DID, botDid].includes(viewerDid)
      ) {
        await insert.onConflictDoNothing();
      } else {
        await insert.onConflictDoUpdate({
          target: nagiActors.did,
          set: {
            handle: actor.handle,
            pdsUrl: actor.pdsUrl,
            status: actor.status,
            resolvedAt: actor.resolvedAt,
          },
        });
      }
    }
    for (const profile of profileRows) {
      const insert = tx.insert(nagiProfiles).values(profile);
      if (
        profile.did === viewerDid &&
        ![FIXTURE_AUTHOR_DID, botDid].includes(viewerDid)
      ) {
        await insert.onConflictDoNothing();
      } else {
        await insert.onConflictDoUpdate({
          target: nagiProfiles.did,
          set: {
            displayName: profile.displayName,
            description: profile.description,
            indexedAt: profile.indexedAt,
          },
        });
      }
    }

    await tx
      .insert(nagiChannels)
      .values({
        uri: channelUri,
        cid: "bafyreidevchannel",
        rkey: "dev-channel",
        did: FIXTURE_AUTHOR_DID,
        name: "静かな開発室",
        description: "チャンネル一覧・詳細・限定投稿を確認するfixtureです。",
        pinnedPostUri: channelPostUri,
        pinnedPostCid: "bafyreidevchannelpost",
        recordCreatedAt: channelCreatedAt,
        indexedAt: now,
      })
      .onConflictDoUpdate({
        target: nagiChannels.uri,
        set: {
          name: "静かな開発室",
          description: "チャンネル一覧・詳細・限定投稿を確認するfixtureです。",
          pinnedPostUri: channelPostUri,
          pinnedPostCid: "bafyreidevchannelpost",
          indexedAt: now,
          deletedAt: null,
        },
      });

    const postRows = [
      {
        uri: rootUri,
        cid: "bafyreidevrootpost",
        rkey: "dev-root-post",
        did: FIXTURE_AUTHOR_DID,
        text: "ローカルAppViewから、穏やかな開発の一日を始めます。 #開発",
        tags: ["開発"],
        langs: ["ja"],
        recordJson: {
          $type: NAGI.post,
          text: "ローカルAppViewから、穏やかな開発の一日を始めます。 #開発",
          createdAt: rootCreatedAt.toISOString(),
        },
        recordCreatedAt: rootCreatedAt,
        indexedAt: rootCreatedAt,
      },
      {
        uri: replyUri,
        cid: "bafyreidevreplypost",
        rkey: "dev-reply-post",
        did: FIXTURE_FRIEND_DID,
        text: "いいですね。返信と会話表示も確認できます。",
        langs: ["ja"],
        recordJson: {
          $type: NAGI.post,
          text: "いいですね。返信と会話表示も確認できます。",
          reply: {
            root: { uri: rootUri, cid: "bafyreidevrootpost" },
            parent: { uri: rootUri, cid: "bafyreidevrootpost" },
          },
          createdAt: replyCreatedAt.toISOString(),
        },
        replyRootUri: rootUri,
        replyParentUri: rootUri,
        recordCreatedAt: replyCreatedAt,
        indexedAt: replyCreatedAt,
      },
      {
        uri: channelPostUri,
        cid: "bafyreidevchannelpost",
        rkey: "dev-channel-post",
        did: FIXTURE_FRIEND_DID,
        text: "この投稿は開発用チャンネルだけに表示されます。",
        langs: ["ja"],
        recordJson: {
          $type: NAGI.post,
          text: "この投稿は開発用チャンネルだけに表示されます。",
          channel: { uri: channelUri, cid: "bafyreidevchannel" },
          createdAt: channelPostCreatedAt.toISOString(),
        },
        channelUri,
        recordCreatedAt: channelPostCreatedAt,
        indexedAt: channelPostCreatedAt,
      },
    ];
    for (const post of postRows) {
      await tx
        .insert(nagiPosts)
        .values(post)
        .onConflictDoUpdate({
          target: nagiPosts.uri,
          set: {
            cid: post.cid,
            text: post.text,
            tags: post.tags ?? null,
            langs: post.langs,
            recordJson: post.recordJson,
            replyRootUri: post.replyRootUri ?? null,
            replyParentUri: post.replyParentUri ?? null,
            channelUri: post.channelUri ?? null,
            recordCreatedAt: post.recordCreatedAt,
            indexedAt: post.indexedAt,
            deletedAt: null,
          },
        });
    }

    await tx
      .insert(nagiPostScores)
      .values({ postUri: rootUri, score: 94, updatedAt: now })
      .onConflictDoUpdate({
        target: nagiPostScores.postUri,
        set: { score: 94, updatedAt: now },
      });
    await tx
      .insert(nagiReactions)
      .values({
        uri: reactionUri,
        cid: "bafyreidevreaction",
        did: FIXTURE_FRIEND_DID,
        subjectUri: rootUri,
        emoji: "🌿",
        emojiKey: "🌿",
        createdAt: replyCreatedAt,
        indexedAt: replyCreatedAt,
      })
      .onConflictDoUpdate({
        target: nagiReactions.uri,
        set: {
          subjectUri: rootUri,
          emoji: "🌿",
          emojiKey: "🌿",
          createdAt: replyCreatedAt,
          indexedAt: replyCreatedAt,
        },
      });

    await tx
      .insert(nagiNews)
      .values({
        uri: newsUri,
        cid: "bafyreidevnews",
        rkey: "dev-positive-news",
        did: botDid,
        articleId: "dev-positive-news",
        url: "https://example.com/nagi-dev-news",
        normalizedUrl: "https://example.com/nagi-dev-news",
        titleJa: "地域の小さな庭に新しい交流スペース",
        sourceName: "Nagi Dev News",
        sourceUrl: "https://example.com/",
        publishedAt: newsCreatedAt,
        langs: ["ja"],
        recordCreatedAt: newsCreatedAt,
        indexedAt: newsCreatedAt,
      })
      .onConflictDoUpdate({
        target: nagiNews.uri,
        set: {
          cid: "bafyreidevnews",
          titleJa: "地域の小さな庭に新しい交流スペース",
          publishedAt: newsCreatedAt,
          recordCreatedAt: newsCreatedAt,
          indexedAt: newsCreatedAt,
          deletedAt: null,
        },
      });
    await tx
      .insert(nagiNewsApprovals)
      .values({
        newsUri,
        newsCid: "bafyreidevnews",
        status: "approved",
        botCommentJa:
          "身近な場所に、ゆっくり話せる居場所が増えるニュースです。",
        titleEn: "A new community space opens in a small local garden",
        botCommentEn: "A gentle new place for neighbors to meet and talk.",
        reviewedAt: newsCreatedAt,
      })
      .onConflictDoUpdate({
        target: [nagiNewsApprovals.newsUri, nagiNewsApprovals.newsCid],
        set: {
          status: "approved",
          botCommentJa:
            "身近な場所に、ゆっくり話せる居場所が増えるニュースです。",
          titleEn: "A new community space opens in a small local garden",
          botCommentEn: "A gentle new place for neighbors to meet and talk.",
          reviewedAt: newsCreatedAt,
          hiddenAt: null,
        },
      });

    await tx
      .insert(nagiActorAnalyses)
      .values({
        did: FIXTURE_AUTHOR_DID,
        analysisJa: "小さな気づきを丁寧に言葉にする人です。",
        analysisEn: "Someone who carefully puts small observations into words.",
        taglineJa: "水面のように穏やかな観察者",
        taglineEn: "A calm observer like still water",
        tagsJa: ["穏やか", "観察", "開発"],
        tagsEn: ["calm", "observant", "developer"],
        source: "nagi",
        postCountAt: 1,
        model: "dev-fixture",
        promptVersion: "dev-fixture-v1",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: nagiActorAnalyses.did,
        set: {
          analysisJa: "小さな気づきを丁寧に言葉にする人です。",
          analysisEn:
            "Someone who carefully puts small observations into words.",
          taglineJa: "水面のように穏やかな観察者",
          taglineEn: "A calm observer like still water",
          tagsJa: ["穏やか", "観察", "開発"],
          tagsEn: ["calm", "observant", "developer"],
          updatedAt: now,
        },
      });
    await tx
      .insert(nagiDiaries)
      .values({
        uri: diaryUri,
        cid: "bafyreidevdiary",
        did: botDid,
        subjectDid: viewerDid,
        diaryDate,
        text: "今日はローカル開発環境を整えました。画面をゆっくり確認できる準備ができました。",
        titleJa: "開発環境が整った日",
        titleEn: "A day for setting up the development environment",
        emoji: "🌱🫧💻",
        postCount: 1,
        langs: ["ja", "en"],
        recordCreatedAt: now,
        indexedAt: now,
      })
      .onConflictDoNothing();

    const privateListMember =
      viewerDid === FIXTURE_AUTHOR_DID
        ? FIXTURE_FRIEND_DID
        : FIXTURE_AUTHOR_DID;
    await tx
      .insert(nagiPrivateListMembers)
      .values({
        ownerDid: viewerDid,
        memberDid: privateListMember,
        createdAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(nagiChannelSubscriptions)
      .values({ ownerDid: viewerDid, channelUri, createdAt: now })
      .onConflictDoNothing();
    await tx
      .insert(nagiNotifications)
      .values({
        recipientDid: viewerDid,
        type: "reaction",
        actorDid: FIXTURE_FRIEND_DID,
        subjectUri: rootUri,
        reasonUri: reactionUri,
        createdAt: replyCreatedAt,
      })
      .onConflictDoNothing();
  });

  return {
    database: database.pathname.slice(1),
    viewerDid,
    profileDid: FIXTURE_AUTHOR_DID,
    channelUri,
    rootUri,
    newsUri,
  };
}

async function main() {
  try {
    const seeded = await seedDevelopmentDatabase();
    console.log("Development fixtures seeded:", seeded);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
