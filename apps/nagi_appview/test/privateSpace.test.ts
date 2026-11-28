import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import {
  NAGI_PRIVATE,
  NAGI_PRIVATE_COLLECTIONS,
  NAGI_PRIVATE_SPACE_SCOPE,
  NAGI_PRIVATE_SPACE_TYPE,
  nagiPrivateSpaceUri,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { ApiError } from "../src/middleware/errors.js";
import {
  assertWritableMode,
  movedPreferenceFields,
} from "../src/privateSpace/guard.js";
import {
  InvalidPrivateRecord,
  parsePrivateSpaceRecord,
  toPrivateSpaceRecords,
  type PrivateRows,
} from "../src/privateSpace/records.js";
import {
  bookmarkRkey,
  listMemberRkey,
  muteRkey,
} from "../src/privateSpace/rkeys.js";

const OWNER = "did:plc:owner";
const BOT = "did:plc:bot";
const ctx = { ownerDid: OWNER, botDid: BOT };
const at = (iso: string) => new Date(iso);
const FOLDER = "0b6b5f3e-6c7a-4d1e-9f00-1a2b3c4d5e6f";
const DRAFT = "7d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const POST = "at://did:plc:alice/com.suibari.nagi.post/3abc";
const LEXICONS = new URL(
  "../../../packages/nagi-lexicon/lexicons/",
  import.meta.url,
);
const lexicon = (nsid: string) =>
  new URL(`${nsid.replaceAll(".", "/")}.json`, LEXICONS);

const rows: PrivateRows = {
  mutes: [
    { muterDid: OWNER, subjectType: "actor", subject: "did:plc:noisy", createdAt: at("2026-11-01T00:00:00Z") },
    { muterDid: OWNER, subjectType: "tag", subject: "ネタバレ", createdAt: at("2026-11-02T00:00:00Z") },
    { muterDid: OWNER, subjectType: "channel", subject: "at://did:plc:x/com.suibari.nagi.channel/1", createdAt: at("2026-11-03T00:00:00Z") },
  ],
  privateListMembers: [
    { ownerDid: OWNER, memberDid: "did:plc:friend", createdAt: at("2026-11-04T00:00:00Z") },
  ],
  bookmarkFolders: [
    { id: FOLDER, ownerDid: OWNER, name: "ブックマーク", isDefault: true, createdAt: at("2026-11-05T00:00:00Z"), updatedAt: at("2026-11-06T00:00:00Z") },
  ],
  bookmarks: [
    { id: "11111111-1111-4111-8111-111111111111", ownerDid: OWNER, folderId: FOLDER, subjectUri: POST, subjectType: "post", createdAt: at("2026-11-07T00:00:00Z") },
  ],
  drafts: [
    {
      id: DRAFT,
      ownerDid: OWNER,
      content: { text: "書きかけ", mentions: [], emojis: [], linkCards: [], dismissedUrls: [] },
      createdAt: at("2026-11-08T00:00:00Z"),
      updatedAt: at("2026-11-09T00:00:00Z"),
    },
  ],
  languagePreferences: { did: OWNER, postLanguage: "ja", translationLanguage: "en", translationProvider: "deepl", autoTranslate: false, updatedAt: at("2026-11-10T00:00:00Z") },
  moderationPreferences: { did: OWNER, automatic: "warn", selfAi: "hide", selfNsfw: "ignore", updatedAt: at("2026-11-11T00:00:00Z") },
  notificationPreferences: { did: OWNER, preferences: { reply: { list: true, push: false } }, updatedAt: at("2026-11-12T00:00:00Z") },
  bookmarkPreferences: { did: OWNER, lastFolderId: FOLDER, updatedAt: at("2026-11-13T00:00:00Z") },
  diaryDayPreferences: { did: OWNER, detectedTimezone: "Asia/Tokyo", detectedAt: at("2026-11-14T00:00:00Z"), manualTimezone: "Asia/Tokyo", startHour: 23, updatedAt: at("2026-11-14T00:00:00Z") },
  emojiFavorites: { did: OWNER, choices: [{ kind: "unicode", emoji: "😀" }], updatedAt: at("2026-11-15T00:00:00Z") },
  tagFavorites: { did: OWNER, tags: ["日記"], updatedAt: at("2026-11-16T00:00:00Z") },
  feedTabs: { did: OWNER, tabs: [{ id: "global", kind: "global" }], updatedAt: at("2026-11-17T00:00:00Z") },
};

test("rkey は対象から決まり、record-key に使える形になる", () => {
  for (const rkey of [
    muteRkey("tag", "ネタバレ"),
    muteRkey("actor", "did:web:example.com%3A8080"),
    listMemberRkey("did:plc:friend"),
    bookmarkRkey(POST),
  ]) {
    assert.match(rkey, /^[0-9a-f]{64}$/);
  }
  assert.equal(muteRkey("actor", "did:plc:a"), muteRkey("actor", "did:plc:a"));
  // 種別が違えば、同じ文字列でも別レコードになる。
  assert.notEqual(muteRkey("actor", "x"), muteRkey("tag", "x"));
});

test("書き出したレコードは、取り込みの検証を通って元の行に戻る", () => {
  const records = toPrivateSpaceRecords(rows);
  const parsed = records.map((record) => {
    assert.equal(record.value.$type, record.collection);
    return parsePrivateSpaceRecord(record.collection, record.rkey, record.value, ctx);
  });
  const byKind = new Map(parsed.map((item) => [item.kind, item]));

  assert.deepEqual(
    parsed.filter((item) => item.kind === "mute").map((item) => item.kind === "mute" && item.subject),
    ["did:plc:noisy", "ネタバレ"],
  );
  assert.deepEqual(byKind.get("listMember"), {
    kind: "listMember",
    memberDid: "did:plc:friend",
    createdAt: at("2026-11-04T00:00:00Z"),
  });
  assert.deepEqual(byKind.get("bookmark"), {
    kind: "bookmark",
    folderId: FOLDER,
    subjectUri: POST,
    subjectType: "post",
    createdAt: at("2026-11-07T00:00:00Z"),
  });
  assert.equal((byKind.get("draft") as { id: string }).id, DRAFT);
  assert.deepEqual(byKind.get("languagePreferences"), {
    kind: "languagePreferences",
    preferences: { post: "ja", translation: "en", provider: "deepl", autoTranslate: false },
    updatedAt: at("2026-11-10T00:00:00Z"),
  });
  assert.deepEqual(byKind.get("bookmarkPreferences"), {
    kind: "bookmarkPreferences",
    lastFolderId: FOLDER,
    updatedAt: at("2026-11-13T00:00:00Z"),
  });
  assert.deepEqual(byKind.get("diaryDay"), {
    kind: "diaryDay",
    manualTimezone: "Asia/Tokyo",
    startHour: 23,
    updatedAt: at("2026-11-14T00:00:00Z"),
  });
  assert.deepEqual((byKind.get("feedTabs") as { tabs: unknown }).tabs, [{ id: "global", kind: "global" }]);
});

test("フォルダはブックマークより先に書き出す", () => {
  const collections = toPrivateSpaceRecords(rows).map((record) => record.collection);
  assert.ok(
    collections.indexOf(NAGI_PRIVATE.bookmarkFolder) < collections.indexOf(NAGI_PRIVATE.bookmark),
  );
});

test("廃止したチャンネルのミュートと、自動検出だけの日記設定は書き出さない", () => {
  const records = toPrivateSpaceRecords({
    ...rows,
    diaryDayPreferences: { ...rows.diaryDayPreferences!, manualTimezone: null, startHour: null },
  });
  assert.equal(
    records.filter((record) => record.collection === NAGI_PRIVATE.mute).length,
    2,
  );
  assert.equal(
    records.some((record) => record.collection === NAGI_PRIVATE.diaryDay),
    false,
  );
  // 自動検出のタイムゾーンは AppView に残すので、レコードに混ぜない。
  const diaryDay = toPrivateSpaceRecords(rows).find(
    (record) => record.collection === NAGI_PRIVATE.diaryDay,
  );
  assert.equal("detectedTimezone" in diaryDay!.value, false);
});

const rejects = (collection: string, rkey: string, value: unknown) =>
  assert.throws(
    () => parsePrivateSpaceRecord(collection, rkey, value, ctx),
    (error) => error instanceof InvalidPrivateRecord,
  );

test("取り込みは対象と食い違う rkey を拒む（同じ相手が2レコードに分かれないように）", () => {
  const value = { subjectType: "actor", subject: "did:plc:noisy", createdAt: "2026-11-01T00:00:00Z" };
  rejects(NAGI_PRIVATE.mute, "3abc", value);
  rejects(NAGI_PRIVATE.mute, muteRkey("actor", "did:plc:other"), value);
  // タグは正規化してから rkey を照合する。
  const tag = parsePrivateSpaceRecord(
    NAGI_PRIVATE.mute,
    muteRkey("tag", "spoiler"),
    { subjectType: "tag", subject: "#Spoiler", createdAt: "2026-11-01T00:00:00Z" },
    ctx,
  );
  assert.equal(tag.kind === "mute" && tag.subject, "spoiler");
});

test("取り込みは従来の API と同じ値を拒む", () => {
  const createdAt = "2026-11-01T00:00:00Z";
  rejects(NAGI_PRIVATE.mute, muteRkey("actor", OWNER), { subjectType: "actor", subject: OWNER, createdAt });
  rejects(NAGI_PRIVATE.listMember, listMemberRkey(BOT), { subject: BOT, createdAt });
  rejects(NAGI_PRIVATE.listMember, listMemberRkey("not-a-did"), { subject: "not-a-did", createdAt });
  rejects(NAGI_PRIVATE.bookmark, bookmarkRkey("at://did:plc:a/app.bsky.feed.post/1"), {
    folder: FOLDER,
    subject: "at://did:plc:a/app.bsky.feed.post/1",
    createdAt,
  });
  rejects(NAGI_PRIVATE.bookmarkFolder, "not-a-uuid", { name: "x", isDefault: false, createdAt, updatedAt: createdAt });
  rejects(NAGI_PRIVATE.bookmarkFolder, FOLDER, { name: "", isDefault: false, createdAt, updatedAt: createdAt });
  rejects(NAGI_PRIVATE.draft, DRAFT, {
    content: { text: "x", mentions: [], emojis: [], linkCards: [], dismissedUrls: [], image: "data:image/png;base64,AAAA" },
    createdAt,
    updatedAt: createdAt,
  });
  rejects(NAGI_PRIVATE.feedTabs, "self", { tabs: [{ id: "x", kind: "unknown" }], updatedAt: createdAt });
  rejects(NAGI_PRIVATE.diaryDay, "self", { startHour: 12, updatedAt: createdAt });
  rejects(NAGI_PRIVATE.languagePreferences, "self", { preferences: { post: "ja" }, updatedAt: createdAt });
});

test("取り込みは形の崩れたレコードを拒む", () => {
  const updatedAt = "2026-11-01T00:00:00Z";
  rejects(NAGI_PRIVATE.tagFavorites, "other", { tags: [], updatedAt });
  rejects(NAGI_PRIVATE.tagFavorites, "self", { tags: [] });
  rejects(NAGI_PRIVATE.tagFavorites, "self", { $type: NAGI_PRIVATE.feedTabs, tags: [], updatedAt });
  rejects(NAGI_PRIVATE.tagFavorites, "self", null);
  rejects("com.suibari.nagi.private.unknown", "self", { updatedAt });
});

test("putPreferences の門番は space へ移る項目だけを見る", () => {
  assert.deepEqual(
    movedPreferenceFields({
      readPositions: [],
      preferredName: "すいぱり",
      replyFreq: 50,
      detectedTimezone: "Asia/Tokyo",
      chronicleReadYears: [],
      birthDate: "2000-01-01",
    }),
    [],
  );
  assert.deepEqual(
    movedPreferenceFields({ feedTabs: [], diaryDay: { startHour: 22 }, lastBookmarkFolderId: null }),
    ["feedTabs", "lastBookmarkFolderId", "diaryDay"],
  );
});

test("移行中は 423、移行後は 409 で従来の書き込みを止める", () => {
  assert.doesNotThrow(() => assertWritableMode("appview"));
  assert.throws(
    () => assertWritableMode("migrating"),
    (error) => error instanceof ApiError && error.status === 423,
  );
  assert.throws(
    () => assertWritableMode("space"),
    (error) => error instanceof ApiError && error.status === 409,
  );
});

test("space type の宣言と各コレクションの lexicon がそろっている", () => {
  const declaration = JSON.parse(readFileSync(lexicon(NAGI_PRIVATE_SPACE_TYPE), "utf8"));
  assert.equal(declaration.defs.main.type, "space");
  assert.equal(declaration.defs.main.key, "literal:self");
  assert.deepEqual([...declaration.defs.main.collections].sort(), [...NAGI_PRIVATE_COLLECTIONS].sort());
  for (const collection of NAGI_PRIVATE_COLLECTIONS) {
    const file = lexicon(collection);
    assert.ok(existsSync(file), `${collection} の lexicon が無い`);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.id, collection);
    assert.equal(doc.defs.main.type, "record");
  }
  assert.equal(nagiPrivateSpaceUri(OWNER), `at:space/${OWNER}/${NAGI_PRIVATE_SPACE_TYPE}/self`);
  assert.equal(NAGI_PRIVATE_SPACE_SCOPE.startsWith(`space:${NAGI_PRIVATE_SPACE_TYPE}`), true);
});

test("移行用の XRPC は permission-set に入っていて、space のスコープは入っていない", () => {
  const set = JSON.parse(readFileSync(lexicon("com.suibari.nagi.appviewAccess"), "utf8"));
  const rpc = set.defs.main.permissions.find((p: { resource: string }) => p.resource === "rpc");
  for (const method of [
    "getPrivateSpaceStatus",
    "beginPrivateSpaceMigration",
    "abortPrivateSpaceMigration",
    "exportPrivateData",
  ]) {
    assert.ok(rpc.lxm.includes(`com.suibari.nagi.${method}`), method);
  }
  // 入れると全員に再同意が要る。移行を選んだ人にだけオプトインで求める。
  assert.equal(
    set.defs.main.permissions.some((p: { resource: string }) => p.resource === "space"),
    false,
  );
});
