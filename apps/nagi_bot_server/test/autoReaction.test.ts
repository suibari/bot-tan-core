import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const {
  buildAutoReactionRecord,
  autoReactionCandidates,
  isAutoReactionEnabled,
  postSubjectText,
  skipReasonForPost,
  TRANSIENT_SKIP_REASONS,
  zenkatsuSubjectText,
} = await import("../src/nagiAutoReaction.js");

const postedAt = new Date("2026-10-04T00:00:00.000Z");

const emoji = (name: string, uri = `at://did:example:a/blue.moji.collection.item/${name}`) => ({
  uri,
  cid: "bafy",
  name: `:${name}:`,
  alt: null,
});

test("候補はカスタム絵文字だけで、同名と不正な名前は落とす", () => {
  assert.deepEqual(autoReactionCandidates([]), []);
  assert.deepEqual(
    autoReactionCandidates([
      { ...emoji("yatta"), alt: " やったー " },
      emoji("yatta", "at://did:example:b/blue.moji.collection.item/yatta"),
      { ...emoji("x"), name: "no-colons" },
    ]),
    [{ key: ":yatta:", description: "やったー" }],
  );
});

test("リアクションのレコードは選んだ絵文字と一致させる", () => {
  const subject = { uri: "at://did:example:u/com.suibari.nagi.post/1", cid: "bafypost" };
  const custom = [{ ...emoji("yatta"), alt: "やったー" }];
  const now = new Date("2026-10-04T03:00:00.000Z");
  assert.deepEqual(buildAutoReactionRecord(subject, ":yatta:", custom, now), {
    $type: "com.suibari.nagi.reaction",
    subject,
    createdAt: now.toISOString(),
    emoji: ":yatta:",
    bluemoji: { uri: custom[0].uri, cid: "bafy", name: ":yatta:", alt: "やったー" },
  });
  assert.equal(buildAutoReactionRecord(subject, ":unknown:", custom, now), undefined);
  assert.equal(buildAutoReactionRecord(subject, "🎉", custom, now), undefined);
});

const post = (overrides: Record<string, unknown> = {}) =>
  ({
    uri: "at://did:example:u/com.suibari.nagi.post/1",
    cid: "bafy",
    did: "did:example:u",
    text: "ケーキを焼いた",
    recordJson: {},
    embedImages: null,
    deletedAt: null,
    replyParentUri: null,
    kossori: false,
    moderationLabels: [],
    selfLabels: [],
    recordCreatedAt: postedAt,
    ...overrides,
  }) as any;

test("返信・こっそり・botたん自身の投稿は対象外", () => {
  assert.equal(skipReasonForPost(post()), undefined);
  assert.equal(skipReasonForPost(post({ deletedAt: postedAt })), "deleted");
  assert.equal(skipReasonForPost(post({ replyParentUri: "at://x" })), "reply");
  assert.equal(skipReasonForPost(post({ did: process.env.NAGI_BOT_DID })), "bot_post");
  assert.equal(skipReasonForPost(post({ kossori: true })), "kossori");
  assert.deepEqual(TRANSIENT_SKIP_REASONS, ["not_indexed"]);
});

test("ラベル・CW・モデレーション判定待ちは返信と同じく見ない", () => {
  assert.equal(skipReasonForPost(post({ moderationVersion: null })), undefined);
  assert.equal(skipReasonForPost(post({ moderationLabels: ["sexual"] })), undefined);
  assert.equal(skipReasonForPost(post({ selfLabels: ["nudity"] })), undefined);
  assert.equal(skipReasonForPost(post({ text: "||ネタバレ||" })), undefined);
  assert.equal(
    skipReasonForPost(post({ embedImages: [{ contentWarning: true }] })),
    undefined,
  );
});

test("モデルへ渡す題材は本文・リンク題名・画像の有無", () => {
  assert.equal(
    postSubjectText(
      post({
        text: " 行ってきた ",
        recordJson: { linkCards: [{ title: "水族館" }, { title: "" }] },
        embedImages: [{}, {}],
      }),
    ),
    "行ってきた\n（リンク: 水族館）\n（画像2枚付き。画像の中身は見えない）",
  );
  assert.equal(
    zenkatsuSubjectText("朝ごはん", ["トースト", "目玉焼き"]),
    "ゼンカツ（お題に合わせて手札のカードを出すゲーム）のプレイ記録。\nお題: 朝ごはん\n出したカード: トースト、目玉焼き",
  );
});

test("有効化は env で切り替えられる", () => {
  assert.equal(isAutoReactionEnabled(undefined), true);
  assert.equal(isAutoReactionEnabled("true"), true);
  assert.equal(isAutoReactionEnabled("false"), false);
  assert.equal(isAutoReactionEnabled("0"), false);
});

test("同じ人へ直近に付けた絵文字は候補から外す", () => {
  const custom = [emoji("suteki"), emoji("wakaru")];
  assert.deepEqual(
    autoReactionCandidates(custom, [":suteki:"]).map(({ key }) => key),
    [":wakaru:"],
  );
  // 全部直近に使っていたら候補は空（Unicode には倒さず、付けずに終える）。
  assert.deepEqual(autoReactionCandidates(custom, [":suteki:", ":wakaru:"]), []);
});
