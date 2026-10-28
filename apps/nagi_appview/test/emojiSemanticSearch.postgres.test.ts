import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";

// Dedicated disposable database only; never run fixtures against the app database.
const testUrl = process.env.NAGI_EMOJI_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_emoji_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_emoji_test";
}
// 較正値（emojiDistMax 0.52 / emojiRelMargin 0.08）を固定するため、モデルを明示する。
process.env.OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b";
process.env.OLLAMA_EMBED_BASE_URL = "http://embed.test/v1";
const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { searchEmojisSemantic } = await import("../src/services/emoji.js");
const { syncUnicodeEmojis } = await import("../src/services/unicodeEmojiIndex.js");

const DIMENSIONS = 1024;
/** e0 との cosine 距離が distance になる単位ベクトル（e0 と e1 の平面上）。 */
function vectorAt(distance: number): number[] {
  const cos = 1 - distance;
  const vector = new Array(DIMENSIONS).fill(0);
  vector[0] = cos;
  vector[1] = Math.sqrt(1 - cos * cos);
  return vector;
}
const literal = (vector: number[]) => `[${vector.join(",")}]`;

/** 埋め込みの問い合わせを、送られた文を記録しつつ e0 で返す。 */
let embedInputs: string[] = [];
let embedAvailable = true;
const fetchMock = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
  assert.equal(url, "http://embed.test/v1/embeddings");
  const { input } = JSON.parse(String(init.body));
  const inputs: string[] = Array.isArray(input) ? input : [input];
  embedInputs.push(...inputs);
  if (!embedAvailable) throw new Error("offline");
  return Response.json({ data: inputs.map(() => ({ embedding: vectorAt(0) })) });
});

before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  for (const table of [database.nagiEmojis, database.nagiUnicodeEmojis]) {
    const { schema = "public", name, columns } = getTableConfig(table);
    const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(`drop table if exists ${quote(schema)}.${quote(name)}`);
    await client.unsafe(
      `create table ${quote(schema)}.${quote(name)} (${columns
        .map((column) => `${quote(column.name)} ${column.getSQLType()}${column.primary ? " primary key" : ""}`)
        .join(", ")})`,
    );
  }
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.emojis, nagi.unicode_emojis`;
  embedInputs = [];
  embedAvailable = true;
});
after(async () => {
  fetchMock.mock.restore();
  await client.end();
});

let seq = 0;
async function emoji(
  name: string,
  opts: {
    did?: string;
    searchText?: string;
    distance?: number;
    adultOnly?: boolean;
    indexedAt?: string;
  } = {},
) {
  const did = opts.did ?? "did:plc:alice";
  const uri = `at://${did}/blue.moji.collection.item/${name.replaceAll(":", "")}-${++seq}`;
  const formats = { version: 1, asset: { kind: "blob", value: "bafkrei", mediaType: "image/png" } };
  await client`insert into nagi.emojis
    (uri, cid, did, name, formats, adult_only, moderation_labels, created_at, indexed_at,
     search_text, search_text_cid, embedding)
    values (${uri}, 'cid', ${did}, ${name}, ${JSON.stringify(formats)}::jsonb, ${opts.adultOnly ?? false}, '{}',
      '2026-10-01T00:00:00Z', ${opts.indexedAt ?? "2026-10-01T00:00:00Z"},
      ${opts.searchText ?? null}, 'cid',
      ${opts.distance === undefined ? null : literal(vectorAt(opts.distance))}::vector)`;
  return uri;
}
async function unicode(emojiChar: string, labels: string, keywords: string, distance?: number, order = 0) {
  await client`insert into nagi.unicode_emojis
    (emoji, label_ja, label_en, labels, keywords, sort_order, embed_text, embedding, data_version)
    values (${emojiChar}, ${labels.split("\n")[0]}, ${labels.split("\n").at(-1)!}, ${labels},
      ${keywords}, ${order}, ${keywords},
      ${distance === undefined ? null : literal(vectorAt(distance))}::vector, 'test')`;
}
const names = (result: { emojis: { name: string }[] }) => result.emojis.map((e) => e.name);

test("名前の一致を先に、意味の近いものを後ろに並べ、遠いものは出さない", { skip: !testUrl }, async () => {
  await emoji(":otsukare:", { distance: 0.3 });
  await emoji(":kanpai:", { distance: 0.1 });
  await emoji(":wp:", { searchText: "WP\n紫の文字\nお疲れ様", distance: 0.12 });
  await emoji(":unrelated:", { distance: 0.6 });
  await emoji(":edge:", { distance: 0.2 }); // 最良 0.1 + 0.08 を超える
  await emoji(":adult:", { distance: 0.1, adultOnly: true });
  const result = await searchEmojisSemantic({ q: "otsu", limit: 60, includeUnicode: false });
  assert.deepEqual(names(result), [":otsukare:", ":kanpai:", ":wp:"]);
  assert.equal(result.unicode, undefined);
});

test("相対カットの基準は名前一致も含めた最良距離で決める", { skip: !testUrl }, async () => {
  // 名前一致の :neko: が 0.05。除いてから切ると 0.2 が基準になり 0.25 まで入ってしまう。
  await emoji(":neko:", { distance: 0.05 });
  await emoji(":kitten:", { distance: 0.1 });
  await emoji(":bird:", { distance: 0.2 });
  const result = await searchEmojisSemantic({ q: "neko", limit: 60, includeUnicode: false });
  assert.deepEqual(names(result), [":neko:", ":kitten:"]);
});

test("名前の一致度が同じなら preferRepo の絵文字を先に出す", { skip: !testUrl }, async () => {
  await emoji(":yatta_a:", { did: "did:plc:other", indexedAt: "2026-10-02T00:00:00Z" });
  await emoji(":yatta_b:", { did: "did:plc:me" });
  await emoji(":yatta:", { did: "did:plc:other" });
  const result = await searchEmojisSemantic({
    q: "yatta",
    limit: 60,
    includeUnicode: false,
    preferRepo: "did:plc:me",
  });
  // 完全一致がいちばん上。前方一致の中では本人の絵文字が先。
  assert.deepEqual(names(result), [":yatta:", ":yatta_b:", ":yatta_a:"]);
});

test("かなの検索語はローマ字の名前と、読み取り文はかな揺れを畳んで照合する", { skip: !testUrl }, async () => {
  await emoji(":yoroshiku_onegaishimasu:");
  await emoji(":zannen:");
  await emoji(":cat:", { searchText: "ネコ\n猫の顔\nかわいい" });
  assert.deepEqual(names(await searchEmojisSemantic({ q: "ざんねん", limit: 60, includeUnicode: false })), [
    ":zannen:",
  ]);
  assert.deepEqual(
    names(await searchEmojisSemantic({ q: "よろしくおねがい", limit: 60, includeUnicode: false })),
    [":yoroshiku_onegaishimasu:"],
  );
  assert.deepEqual(names(await searchEmojisSemantic({ q: "ねこ", limit: 60, includeUnicode: false })), [":cat:"]);
});

test("名前の区切り（- _ 空白）の違いは無視して照合する", { skip: !testUrl }, async () => {
  await emoji(":bot-tan_duel:");
  await emoji(":bottan-igyo:");
  await emoji(":bot_icon:");
  for (const q of ["bottan", "bot-tan", "bot_tan", "bot tan", "botたん", "ぼったん"])
    assert.deepEqual(
      names(await searchEmojisSemantic({ q, limit: 60, includeUnicode: false })).sort(),
      [":bot-tan_duel:", ":bottan-igyo:"],
      q,
    );
});

test("外来語のかなは L/R と促音の違いを無視して名前と照合する", { skip: !testUrl }, async () => {
  await emoji(":latte-daijoubu:");
  await emoji(":rate_limit:");
  await emoji(":ramen:");
  for (const q of ["ラテ", "らて"])
    assert.deepEqual(
      names(await searchEmojisSemantic({ q, limit: 60, includeUnicode: false })).sort(),
      [":latte-daijoubu:", ":rate_limit:"],
      q,
    );
  // 英字の検索語にはゆるい照合を使わない（latte で rate_limit は出さない）。
  assert.deepEqual(names(await searchEmojisSemantic({ q: "latte", limit: 60, includeUnicode: false })), [
    ":latte-daijoubu:",
  ]);
});

test("埋め込みには打ったままの表記を送る（カタカナ化しない）", { skip: !testUrl }, async () => {
  await searchEmojisSemantic({ q: ":かなしい:", limit: 60, includeUnicode: false });
  assert.equal(embedInputs.length, 1);
  assert.match(embedInputs[0], /Query: かなしい$/);
});

test("Unicode 絵文字は表示名の一致を先に、意味の近いものを後ろに並べる", { skip: !testUrl }, async () => {
  await unicode("🔥", "火\nfire", "火\nfire\nファイアー\n炎", 0.3, 2);
  await unicode("🧯", "消火器\nfire extinguisher", "消火器\nfire extinguisher", 0.35, 3);
  await unicode("😡", "ふくれっつら\nenraged face", "ふくれっつら\nenraged face\n怒り", 0.1, 1);
  await unicode("🌸", "桜\ncherry blossom", "桜\ncherry blossom", 0.7, 0);
  const result = await searchEmojisSemantic({ q: "fire", limit: 60, includeUnicode: true });
  assert.deepEqual(
    result.unicode!.map((u) => u.emoji),
    ["🔥", "🧯", "😡"],
  );
  assert.deepEqual(result.unicode![0], { emoji: "🔥", labelJa: "火", labelEn: "fire" });
});

test("埋め込みが取れなければ名前の一致だけで返す", { skip: !testUrl }, async () => {
  embedAvailable = false;
  await emoji(":fire_dance:", { distance: 0.4 });
  await emoji(":hot:", { distance: 0 });
  await unicode("🔥", "火\nfire", "火\nfire", 0);
  // 前のテストの「fire」は埋め込みがキャッシュされているので別の語で引く。
  const result = await searchEmojisSemantic({ q: "fir", limit: 60, includeUnicode: true });
  assert.equal(embedInputs.length, 1);
  assert.deepEqual(names(result), [":fire_dance:"]);
  assert.deepEqual(result.unicode!.map((u) => u.emoji), ["🔥"]);
});

test("Unicode 絵文字の同期は全件を入れ、変わらない行の埋め込みを保つ", { skip: !testUrl }, async () => {
  await syncUnicodeEmojis();
  const [{ count }] = await client`select count(*)::int as count from nagi.unicode_emojis`;
  assert.ok(count > 1800, `${count}`);
  const [fire] = await client`select labels, keywords from nagi.unicode_emojis where emoji = '🔥'`;
  assert.match(fire.labels, /^火$/m);
  assert.match(fire.keywords, /^fire$/m);

  await client`update nagi.unicode_emojis set embedding = ${literal(vectorAt(0))}::vector`;
  // 版が古い行だけ作り直す。埋め込み文が変わった行だけ embedding を捨てる。
  await client`update nagi.unicode_emojis set data_version = 'old' where emoji in ('🔥', '🌸')`;
  await client`update nagi.unicode_emojis set embed_text = 'stale' where emoji = '🔥'`;
  await syncUnicodeEmojis();
  const rows = await client`select emoji, embedding is null as cleared, data_version from nagi.unicode_emojis
    where emoji in ('🔥', '🌸')`;
  const byEmoji = Object.fromEntries(rows.map((row) => [row.emoji, row]));
  assert.equal(byEmoji["🔥"].cleared, true);
  assert.equal(byEmoji["🌸"].cleared, false);
  assert.notEqual(byEmoji["🌸"].data_version, "old");
});
