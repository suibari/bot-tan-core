import assert from "node:assert/strict";
import { and } from "drizzle-orm";
import test from "node:test";
import {
  BOT_MEMORY_ACTIVE_SOURCE_TYPES,
  activeBotMemorySourceTypes,
  botMemoryContentHash,
  dailyPlanImpressionCooldownCondition,
  isBotMemorySourceType,
  isBotMemoryImpressionSourceType,
  addBotMemoryRanks,
  finalizeBotMemoryRanks,
  clampSalience,
  isBotMemoryVisibility,
  normalizeMemorySubjectKey,
  selectNotableMemory,
  searchConditions,
  memoryDigestDate,
  memoryDigestDayRange,
  mergeBotMemoryRanks,
  visibilityCondition,
  purgeReactionBotMemory,
  selectRecentBotMemoryImpressions,
  shouldRememberAffirmedPost,
  selectReplyMemoryContext,
} from "../src/botMemory.js";
import { bot_memory_documents, bot_memory_impressions, db } from "../src/db.js";
import {
  isEligiblePronunciationSurface,
  isValidSpokenForm,
  mergeAutomaticPronunciation,
} from "../src/botMemoryPronunciation.js";

const row = (id: number, occurredAt = new Date("2026-08-21T00:00:00Z")) => ({
  id,
  sourceType: "bsky_affirmed_post" as const,
  sourceId: String(id),
  sourceUri: `at://example/${id}`,
  authorId: `did:example:${id}`,
  content: `memory ${id}`,
  botResponse: null,
  occurredAt,
  affirmationScore: null,
  metadata: null,
});

test("reaction event sources remain API-compatible but are not searchable", () => {
  assert.equal(isBotMemorySourceType("bsky_received_like"), true);
  assert.equal(isBotMemorySourceType("nagi_received_reaction"), true);
  assert.equal(BOT_MEMORY_ACTIVE_SOURCE_TYPES.includes("bsky_received_like"), false);
  assert.equal(BOT_MEMORY_ACTIVE_SOURCE_TYPES.includes("nagi_received_reaction"), false);
  assert.deepEqual(activeBotMemorySourceTypes([
    "bsky_received_reply",
    "bsky_received_like",
    "nagi_received_reaction",
  ]), ["bsky_received_reply"]);
  assert.deepEqual(activeBotMemorySourceTypes([
    "bsky_received_like",
    "nagi_received_reaction",
  ]), []);
});

test("reaction memory purge is dry-run by default and idempotent when applied", async () => {
  let remaining = 2;
  let deleteCalls = 0;
  const dependencies = {
    loadSummary: async () => [{
      sourceType: "bsky_received_like" as const,
      documents: remaining,
      usages: remaining,
    }, {
      sourceType: "nagi_received_reaction" as const,
      documents: 0,
      usages: 0,
    }],
    deleteDocuments: async () => {
      deleteCalls += 1;
      const deleted = remaining;
      remaining = 0;
      return deleted;
    },
  };

  assert.equal((await purgeReactionBotMemory(false, dependencies)).deleted, 0);
  assert.equal(deleteCalls, 0);
  assert.equal((await purgeReactionBotMemory(true, dependencies)).deleted, 2);
  assert.equal((await purgeReactionBotMemory(true, dependencies)).deleted, 0);
  assert.equal(deleteCalls, 2);
});

test("memory content hash is deterministic and content-sensitive", () => {
  assert.equal(botMemoryContentHash("same"), botMemoryContentHash("same"));
  assert.notEqual(botMemoryContentHash("same"), botMemoryContentHash("different"));
});

test("source type guard rejects unknown values", () => {
  assert.equal(isBotMemorySourceType("nagi_affirmed_post"), true);
  assert.equal(isBotMemorySourceType("nagi_received_reaction"), true);
  assert.equal(isBotMemorySourceType("kossori"), false);
});

test("daily plan theme memory includes public Bsky replies regardless of subscription", () => {
  assert.equal(isBotMemoryImpressionSourceType("bsky_received_reply"), true);
  assert.equal(isBotMemoryImpressionSourceType("nagi_received_reply"), true);
  assert.equal(isBotMemoryImpressionSourceType("youtube_live_comment"), true);
  assert.equal(isBotMemoryImpressionSourceType("bsky_received_like"), false);
});

test("daily plan theme cooldown encodes Date as a timestamp string", () => {
  const cooldown = new Date("2026-08-08T00:10:54.434Z");
  const query = db
    .select({ id: bot_memory_impressions.id })
    .from(bot_memory_impressions)
    .where(dailyPlanImpressionCooldownCondition(cooldown))
    .toSQL();

  assert.deepEqual(query.params, [cooldown.toISOString()]);
});

test("recent public impressions keep newest unique labels and active readings only", () => {
  const rows = [
    {
      label: "攻殻機動隊",
      spokenForm: "コウカク、キドウタイ",
      pronunciationStatus: "active",
      occurredAt: new Date("2026-08-23T03:00:00Z"),
    },
    {
      label: "攻殻機動隊",
      spokenForm: "コウカク、キドウタイ",
      pronunciationStatus: "active",
      occurredAt: new Date("2026-08-22T03:00:00Z"),
    },
    {
      label: "別の作品",
      spokenForm: "ベツノサクヒン",
      pronunciationStatus: "disabled",
      occurredAt: new Date("2026-08-21T03:00:00Z"),
    },
  ];

  assert.deepEqual(selectRecentBotMemoryImpressions(rows, 20), [
    {
      label: "攻殻機動隊",
      spokenForm: "コウカク、キドウタイ",
      occurredAt: rows[0].occurredAt,
    },
    {
      label: "別の作品",
      spokenForm: null,
      occurredAt: rows[2].occurredAt,
    },
  ]);
});

test("affirmed post memory keeps Nagi AI posts and subscriber-only Bluesky AI posts", () => {
  const base = { aiReplyPosted: true, isTopLevel: true, sourceAlive: true };
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "nagi" }), true);
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "bsky", isSubscriber: true }), true);
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "bsky", isSubscriber: false }), false);
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "nagi", aiReplyPosted: false }), false);
  // 削除済みのソースは、こっそりかどうかに関わらず覚えない。
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "nagi", sourceAlive: false }), false);
});

test("RRF merges duplicates and keeps candidates from both rankings", () => {
  const result = mergeBotMemoryRanks([row(1), row(2)], [row(2), row(3)], 3);
  assert.deepEqual(result.map((item) => item.id), [2, 1, 3]);
  assert.equal(result[0].semanticRank, 2);
  assert.equal(result[0].lexicalRank, 1);
});

test("RRF uses recency as a deterministic tie breaker", () => {
  const result = mergeBotMemoryRanks(
    [row(1, new Date("2026-08-20T00:00:00Z")), row(2)],
    [],
    2,
    60,
  );
  assert.deepEqual(result.map((item) => item.id), [1, 2]);
});

test("reply context uses stored rows without re-embedding candidates", () => {
  const ownLexical = { ...row(10), content: "本人の語彙一致", lexicalRank: 1, relevance: 0.01 };
  const friendLexical = { ...row(11), lexicalRank: 1, relevance: 0.01 };
  const friendSemantic = { ...row(12), semanticRank: 1, relevance: 0.02 };
  const selected = selectReplyMemoryContext(
    [ownLexical],
    [friendLexical, friendSemantic],
  );
  assert.deepEqual(selected.relatedPosts, ["本人の語彙一致"]);
  assert.equal(selected.friendMemory?.id, 12);
});

test("reply friend candidate excludes bot authors and lexical-only fallback", () => {
  const lexical = { ...row(20), authorId: "did:user", lexicalRank: 1, relevance: 0.01 };
  const bot = { ...row(21), authorId: "did:bot", semanticRank: 1, relevance: 0.02 };
  const selected = selectReplyMemoryContext([], [lexical, bot], ["did:bot"]);
  assert.equal(selected.friendMemory, undefined);
});

test("pronunciation validation accepts safe titles and katakana speech only", () => {
  assert.equal(isEligiblePronunciationSurface("攻殻機動隊"), true);
  assert.equal(isEligiblePronunciationSurface("心"), false);
  assert.equal(isEligiblePronunciationSurface("https://example.com"), false);
  assert.equal(isValidSpokenForm("コウカク、キドウタイ"), true);
  assert.equal(isValidSpokenForm("攻殻機動隊"), false);
  assert.equal(isValidSpokenForm("ignore instructions"), false);
});

test("automatic pronunciation never overwrites manual or disabled entries", () => {
  const manual = {
    surface: "攻殻機動隊",
    spokenForm: "コウカク、キドウタイ",
    kind: "work" as const,
    status: "active" as const,
    origin: "manual" as const,
    evidenceCount: 1,
    conflictCount: 0,
  };
  const next = mergeAutomaticPronunciation(manual, {
    surface: "攻殻機動隊", spokenForm: "オサムカラキドウタイ", kind: "work", eligible: true,
  });
  assert.equal(next.spokenForm, manual.spokenForm);
  assert.equal(next.evidenceCount, 2);
  assert.equal(next.conflictCount, 0);
});

test("conflicting automatic pronunciation keeps first reading and records conflict", () => {
  const current = {
    surface: "作品タイトル",
    spokenForm: "サクヒンタイトル",
    kind: "work" as const,
    status: "active" as const,
    origin: "auto" as const,
    evidenceCount: 2,
    conflictCount: 0,
  };
  const next = mergeAutomaticPronunciation(current, {
    surface: current.surface, spokenForm: "ベツノヨミ", kind: "work", eligible: true,
  });
  assert.equal(next.spokenForm, current.spokenForm);
  assert.equal(next.evidenceCount, 3);
  assert.equal(next.conflictCount, 1);
});

test("mergeBotMemoryRanks の weight 既定値は従来の挙動を変えない", () => {
  const semantic = [row(1), row(2), row(3)];
  const lexical = [row(3), row(4)];
  assert.deepEqual(
    mergeBotMemoryRanks(semantic, lexical, 10),
    mergeBotMemoryRanks(semantic, lexical, 10, 60, 1),
  );
});

test("addBotMemoryRanks はフィルタせず係数だけで本人の記憶を押し上げる", () => {
  // 本人レグでは2位（1/62）、全体レグの 20 は1位（1/61）。重み無しなら 20 が先。
  const subject = [row(90), row(10)];
  const global = [row(20)];
  const rank = (weight: number) =>
    finalizeBotMemoryRanks(
      addBotMemoryRanks(
        addBotMemoryRanks(new Map(), subject, [], 60, weight),
        global,
        [],
        60,
        1,
      ),
      10,
    ).map((item) => item.id);

  const unweighted = rank(1);
  const weighted = rank(3);
  assert.ok(unweighted.indexOf(20) < unweighted.indexOf(10));
  assert.ok(weighted.indexOf(10) < weighted.indexOf(20));
  // 係数であってフィルタではない。他人の記憶は落ちない。
  assert.deepEqual([...weighted].sort((a, b) => a - b), [10, 20, 90]);
});

test("addBotMemoryRanks は複数レグで出た文書の上位順位を残す", () => {
  // 本人レグで3位、全体レグで1位。劣化時ガードが見る semanticRank は 1 であるべき。
  const merged = addBotMemoryRanks(
    addBotMemoryRanks(new Map(), [row(1), row(2), row(9)], [], 60, 2),
    [row(9)],
    [],
    60,
    1,
  );
  assert.equal(merged.get(9)!.semanticRank, 1);
});

test("memoryDigestDate は JST の日付を返す", () => {
  // UTC 2026-08-20T15:00Z = JST 2026-08-21T00:00
  assert.equal(memoryDigestDate(new Date("2026-08-20T15:00:00Z")), "2026-08-21");
  assert.equal(memoryDigestDate(new Date("2026-08-20T14:59:00Z")), "2026-08-20");
});

test("memoryDigestDayRange は JST の一日を UTC の半開区間へ開く", () => {
  const { from, to } = memoryDigestDayRange("2026-08-21");
  assert.equal(from.toISOString(), "2026-08-20T15:00:00.000Z");
  assert.equal(to.toISOString(), "2026-08-21T15:00:00.000Z");
  assert.throws(() => memoryDigestDayRange("not-a-date"));
});

const renderVisibility = (scope: Parameters<typeof visibilityCondition>[0]) => {
  const rendered = db
    .select({ id: bot_memory_documents.id })
    .from(bot_memory_documents)
    .where(visibilityCondition(scope))
    .toSQL();
  return { text: rendered.sql.replace(/\s+/g, " "), params: rendered.params };
};

test("visibility の既定は public のみ（こっそりは1件も混ざらない）", () => {
  const { text, params } = renderVisibility({});
  assert.match(text, /"visibility" = \$1/);
  assert.deepEqual(params, ["public"]);
  // こっそりを許す枝がそもそも組み立てられていないこと。
  assert.doesNotMatch(text, / or /);
  assert.ok(!params.includes("kossori"));
});

test("こっそりの文脈でも、許されるのは本人の author_id と一致する分だけ", () => {
  const { text, params } = renderVisibility({ kossoriSubjectKey: "did:plc:teller" });
  assert.match(text, /or/i);
  assert.match(text, /"author_id" =/);
  assert.deepEqual(params, ["public", "kossori", "did:plc:teller"]);
});

test("こっそりの許可は author_id と AND で結ばれる（OR にすると全員分が漏れる）", () => {
  const { text } = renderVisibility({ kossoriSubjectKey: "did:plc:teller" });
  // ("visibility" = 'kossori' and "author_id" = $3) の形であること。
  assert.match(text, /"visibility" = \$2 and \S*"author_id" = \$3/);
});

test("空文字の subjectKey ではこっそりを開けない", () => {
  const { params } = renderVisibility({ kossoriSubjectKey: "" });
  assert.deepEqual(params, ["public"]);
});

test("isBotMemoryVisibility は既知の2値だけを通す", () => {
  assert.equal(isBotMemoryVisibility("public"), true);
  assert.equal(isBotMemoryVisibility("kossori"), true);
  assert.equal(isBotMemoryVisibility("channel"), false);
  assert.equal(isBotMemoryVisibility(undefined), false);
});


test("どの検索条件にも可視範囲が必ず入る", () => {
  const render = (request: Parameters<typeof searchConditions>[0]) => {
    const rendered = db
      .select({ id: bot_memory_documents.id })
      .from(bot_memory_documents)
      .where(and(...searchConditions(request)))
      .toSQL();
    return { text: rendered.sql.replace(/\s+/g, " "), params: rendered.params };
  };

  const base = { query: "話", purpose: "reply_history" as const };
  // 通常の検索: public だけ。kossori はパラメータにすら現れない。
  const normal = render(base);
  assert.match(normal.text, /"visibility" = \$/);
  assert.ok(!normal.params.includes("kossori"));

  // 作者で絞る検索でも、可視範囲の条件が落ちない。
  const byAuthor = render({ ...base, authorId: "did:plc:someone" });
  assert.ok(!byAuthor.params.includes("kossori"));
  assert.match(byAuthor.text, /"visibility" = \$/);

  // こっそりの文脈のときだけ kossori が現れ、必ず本人の did と対で入る。
  const kossori = render({ ...base, kossoriSubjectKey: "did:plc:teller" });
  assert.ok(kossori.params.includes("kossori"));
  assert.ok(kossori.params.includes("did:plc:teller"));
});

test("author_id は source ごとに名前空間を揃える（名寄せはしない）", () => {
  // YouTube のチャンネルIDだけ印を付ける。DID と同じ列に入るため。
  assert.equal(
    normalizeMemorySubjectKey("youtube_live_comment", "UCabc"),
    "youtube:UCabc",
  );
  // atproto 由来は did: がすでに名前空間なので触らない。
  assert.equal(
    normalizeMemorySubjectKey("nagi_affirmed_post", "did:plc:someone"),
    "did:plc:someone",
  );
  assert.equal(
    normalizeMemorySubjectKey("bsky_affirmed_post", "did:plc:someone"),
    "did:plc:someone",
  );
  // web_research のように author を持たない source。
  assert.equal(normalizeMemorySubjectKey("web_research", null), null);
  assert.equal(normalizeMemorySubjectKey("youtube_live_comment", "  "), null);
});

test("author_id の正規化は冪等（バックフィルを二度流しても壊れない）", () => {
  const once = normalizeMemorySubjectKey("youtube_live_comment", "UCabc");
  const twice = normalizeMemorySubjectKey("youtube_live_comment", once);
  assert.equal(twice, "youtube:UCabc");
  assert.equal(twice, once);
});

test("同じ人物でも Nagi と YouTube は別キーのまま（名寄せしない割り切り）", () => {
  assert.notEqual(
    normalizeMemorySubjectKey("youtube_live_comment", "UCabc"),
    normalizeMemorySubjectKey("nagi_affirmed_post", "did:plc:abc"),
  );
});

test("clampSalience は LLM の雑な出力を 0-100 の整数へ潰す", () => {
  assert.equal(clampSalience(85), 85);
  assert.equal(clampSalience(85.6), 86);
  assert.equal(clampSalience("72"), 72);
  assert.equal(clampSalience(120), 100);
  assert.equal(clampSalience(-5), 0);
  assert.equal(clampSalience("たかい"), null);
  // 未評価(null/undefined/空文字)は 0 ではなく null。0 は「確定した低評価」なので
  // 意味が違い、あとで付け直せなくなる。Number(null) が 0 になる罠。
  assert.equal(clampSalience(undefined), null);
  assert.equal(clampSalience(null), null);
  assert.equal(clampSalience(""), null);
});

const memoryRow = (
  id: number,
  overrides: Partial<ReturnType<typeof row>> & {
    salience?: number | null;
    semanticRank?: number;
    relevance?: number;
  } = {},
) => ({
  ...row(id),
  salience: 90,
  relevance: 0.5,
  semanticRank: 1,
  ...overrides,
});

test("印象度が高く、意味的に繋がっている記憶だけを思い出にする", () => {
  const picked = selectNotableMemory([
    memoryRow(1, { salience: 20 }),
    memoryRow(2, { salience: 95 }),
  ]);
  assert.equal(picked?.id, 2);
});

test("印象度が閾値に届かなければ思い出は出さない（節ごとプロンプトに出ない）", () => {
  assert.equal(selectNotableMemory([memoryRow(1, { salience: 50 })]), undefined);
  // 未評価（NULL）も出さない。評価前の記憶で昔話を始めない。
  assert.equal(selectNotableMemory([memoryRow(1, { salience: null })]), undefined);
});

test("語彙一致だけの記憶は思い出にしない（embedding障害時に昔話を始めない）", () => {
  // semanticRank が無い = 同じ単語がたまたま出ただけ。印象度が高くても採らない。
  assert.equal(
    selectNotableMemory([memoryRow(1, { salience: 100, semanticRank: undefined })]),
    undefined,
  );
});

test("思い出は必ず1件だけ返る", () => {
  const picked = selectNotableMemory([
    memoryRow(1, { salience: 95 }),
    memoryRow(2, { salience: 99 }),
    memoryRow(3, { salience: 100 }),
  ]);
  // 配列ではなく1件。供給量で制御するので、複数渡して水増しさせない。
  assert.equal(picked?.id, 3);
  assert.ok(!Array.isArray(picked));
});

test("印象度が同点なら、今回の話に近い方を選ぶ", () => {
  const picked = selectNotableMemory([
    memoryRow(1, { salience: 90, relevance: 0.1 }),
    memoryRow(2, { salience: 90, relevance: 0.9 }),
  ]);
  assert.equal(picked?.id, 2);
});

test("候補が無ければ undefined（空配列や null を返さない）", () => {
  assert.equal(selectNotableMemory([]), undefined);
});
