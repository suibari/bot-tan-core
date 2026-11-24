import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

// 使い捨ての専用 DB でだけ走らせる。アプリの DB に対してフィクスチャを流さないこと。
// getRecommended はハイドレートで多くの表を引くので、開発DBのスキーマを写して使う:
//   docker exec bsky-affirmative-bot-postgres-1 sh -c 'createdb -U postgres nagi_recommended_test &&
//     pg_dump -U postgres -s nagi_dev | psql -q -U postgres -d nagi_recommended_test'
//   NAGI_RECOMMENDED_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/nagi_recommended_test
const testUrl = process.env.NAGI_RECOMMENDED_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_recommended_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_recommended_test";
}
const BOT = "did:plc:testbot";
process.env.NAGI_BOT_DID = BOT;
process.env.OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b";
const { client } = await import("@bsky-affirmative-bot/database");
const { getRecommended, resolveInterestSource } = await import("../src/queries/recommended.js");

const skip = testUrl ? false : "NAGI_RECOMMENDED_TEST_DATABASE_URL が未設定";

const VIEWER = "did:plc:viewer";
const A = "did:plc:a";
const B = "did:plc:b";
const C = "did:plc:c";
const D = "did:plc:d";

/** i 番目の軸の単位ベクトル。軸が同じなら距離 0、違えば 1。 */
const axis = (i: number) =>
  `[${Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0)).join(",")}]`;
/** 軸0から少しだけ軸1へ傾けたベクトル。軸0との距離は 1 - 1/√(1+t²)（t=0.3 で 0.04、0.6 で 0.14）。 */
const tilted = (t: number) =>
  `[${Array.from({ length: 1024 }, (_, k) => (k === 0 ? 1 : k === 1 ? t : 0)).join(",")}]`;

// JST の正午。同じ日の投稿は分単位でずらす。
const at = (day: number, minute = 0) =>
  new Date(Date.UTC(2026, 10, day, 3, minute)).toISOString();

let seq = 0;
async function post(
  did: string,
  opts: {
    day: number;
    minute?: number;
    embedding?: number | string;
    reply?: string;
    kossori?: boolean;
  },
): Promise<string> {
  const rkey = String(++seq).padStart(4, "0");
  const uri = `at://${did}/com.suibari.nagi.post/${rkey}`;
  const when = at(opts.day, opts.minute);
  await client`insert into nagi.posts (uri, cid, rkey, did, text, moderation_labels, moderation_version,
      self_labels, kossori, reply_root_uri, reply_parent_uri, record_created_at, indexed_at, embedding)
    values (${uri}, 'cid', ${rkey}, ${did}, ${"text " + rkey}, '{}', 'v1', '{}', ${opts.kossori ?? false},
      ${opts.reply ?? null}, ${opts.reply ?? null}, ${when}, ${when},
      ${opts.embedding === undefined ? null : typeof opts.embedding === "string" ? opts.embedding : axis(opts.embedding)}::vector)`;
  return uri;
}

async function react(subject: string, ...dids: string[]) {
  for (const did of dids)
    await client`insert into nagi.reactions (uri, cid, did, subject_uri, emoji, emoji_key, created_at)
      values (${`at://${did}/com.suibari.nagi.reaction/${++seq}`}, 'cid', ${did}, ${subject}, '👍', '👍', now())`;
}

/** 投稿者・閲覧者・botたんのどれでもない n 人から反応を付ける。 */
async function fans(subject: string, n: number) {
  await react(subject, ...Array.from({ length: n }, (_, i) => `did:plc:fan${i}`));
}


/** 閲覧者の興味の材料として、Nagi の埋め込み済み投稿を n 件置く（直近10日より前）。 */
async function viewerPosts(n: number, embedding: number) {
  for (let i = 0; i < n; i++) await post(VIEWER, { day: 1, minute: i, embedding });
}

const uris = async (viewerDid?: string, limit = 50) =>
  (await getRecommended({ limit, viewerDid })).items.map((item) => item.uri);

beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.posts, nagi.reactions, nagi.actor_interest_probes, nagi.actors, nagi.profiles`;
  for (const did of [VIEWER, A, B, C, D, BOT])
    await client`insert into nagi.actors (did, handle, pds_url, status, resolved_at)
      values (${did}, ${did.slice(8) + ".test"}, 'x', 'active', now())`;
});
after(() => client.end());

test("未サインインでは、本人とbotたん以外の5人以上が反応したトップ投稿だけを新しい順に出す", { skip }, async () => {
  const five = await post(A, { day: 10 });
  await fans(five, 5);
  const four = await post(B, { day: 11 });
  await fans(four, 4);
  const selfAndBot = await post(C, { day: 12 });
  await fans(selfAndBot, 4);
  await react(selfAndBot, C, BOT);
  const later = await post(D, { day: 13 });
  await fans(later, 6);
  const reply = await post(A, { day: 14, reply: five });
  await fans(reply, 5);
  const kossori = await post(C, { day: 15, kossori: true });
  await fans(kossori, 5);
  const bot = await post(BOT, { day: 16 });
  await fans(bot, 5);

  assert.deepEqual(await uris(), [later, five]);
});

test("Nagi 投稿が足りる人には、反応が無くても興味に近い投稿を出す", { skip }, async () => {
  await viewerPosts(5, 0);
  const near = await post(A, { day: 10, embedding: 0 });
  const far = await post(B, { day: 11, embedding: 1 });
  const popular = await post(C, { day: 12, embedding: 1 });
  await fans(popular, 5);

  assert.equal(await resolveInterestSource(VIEWER), "nagi");
  const got = await uris(VIEWER);
  assert.deepEqual(got, [popular, near]);
  assert.equal(got.includes(far), false);
});

test("Nagi 投稿が足りない新規登録者は、Bluesky 由来の材料で測る", { skip }, async () => {
  await viewerPosts(2, 1);
  const near = await post(A, { day: 10, embedding: 0 });
  await post(B, { day: 11, embedding: 1 });
  assert.equal(await resolveInterestSource(VIEWER), "none");
  assert.deepEqual(await uris(VIEWER), []);

  await client`insert into nagi.actor_interest_probes (did, position, embedding)
    values (${VIEWER}, 0, ${axis(0)}::vector)`;
  assert.equal(await resolveInterestSource(VIEWER), "bluesky");
  assert.deepEqual(await uris(VIEWER), [near]);
});

test("同じ人の同じ日の候補は、興味に近い順→反応した人数→新しさで1件だけ残す", { skip }, async () => {
  await viewerPosts(5, 0);
  // 10日: 反応が多くても、興味に近い投稿が勝つ。
  const popular = await post(A, { day: 10, minute: 1, embedding: 1 });
  await fans(popular, 9);
  const nearA = await post(A, { day: 10, minute: 2, embedding: tilted(0.6) });
  // 11日: 興味に近い投稿どうしは近いほう（反応の数より優先）。
  const closer = await post(B, { day: 11, minute: 1, embedding: tilted(0.3) });
  const lessClose = await post(B, { day: 11, minute: 2, embedding: tilted(0.6) });
  await fans(lessClose, 7);
  // 12日: 興味から遠い投稿どうしは、距離の差を見ずに反応の多いほう。
  const moreFans = await post(C, { day: 12, minute: 1, embedding: 1 });
  await fans(moreFans, 6);
  const fewerFans = await post(C, { day: 12, minute: 2, embedding: tilted(10) });
  await fans(fewerFans, 5);
  // 13日: 同じ距離なら新しいほう。候補でない投稿は代表を奪わない。
  await post(D, { day: 13, minute: 1, embedding: 0 });
  const newest = await post(D, { day: 13, minute: 2, embedding: 0 });
  await post(D, { day: 13, minute: 3, embedding: 5 });

  assert.deepEqual(await uris(VIEWER), [newest, moreFans, closer, nearA]);
});

test("1件ずつページを送っても、代表が変わらず重複も欠けも出ない", { skip }, async () => {
  await viewerPosts(5, 0);
  for (const day of [10, 11, 12])
    for (const did of [A, B]) {
      await post(did, { day, minute: 1, embedding: tilted(0.6) });
      await post(did, { day, minute: 2, embedding: 0 });
    }
  const all = await uris(VIEWER);
  assert.equal(all.length, 6);

  const paged: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await getRecommended({ limit: 1, cursor, viewerDid: VIEWER });
    paged.push(...page.items.map((item) => item.uri));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(paged, all);
});
