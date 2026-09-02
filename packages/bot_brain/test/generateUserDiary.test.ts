import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUserDiaryDayContext,
  buildUserDiaryPrompt,
  validateChaosExcerpt,
  validateDiaryParagraphs,
  validateUsedContextId,
  usedContextIdSchema,
} from "../src/ai/generateUserDiary.js";
import { generateUserDiaryResilient } from "../src/ai/generateUserDiaryResilient.js";
import { normalizeJsonSchema } from "../src/ai/generationClient.js";

test("formats bot memories, observances, and news as bounded diary context", () => {
  const context = formatUserDiaryDayContext(
    {
      date: "2026-08-10",
      preferredKind: "observance",
      candidates: [
        {
          id: "observance:1",
          kind: "observance",
          textJa: "山の日",
          textEn: "Mountain Day",
        },
        {
          id: "bot_activity:1",
          kind: "bot_activity",
          textJa: "08:00 朝ごはん",
          textEn: "08:00 Breakfast",
        },
        {
          id: "bot_activity:2",
          kind: "bot_activity",
          textJa: "10:00 お散歩",
          textEn: "10:00 A walk",
        },
        {
          id: "news:1",
          kind: "news",
          textJa: "保護犬に新しい家族",
          textEn: "A rescue dog finds a family",
        },
      ],
    },
    true,
  );

  assert.match(context, /<bot_memories>/);
  assert.match(context, /山の日/);
  assert.match(context, /\[bot_activity:1\] 08:00 朝ごはん/);
  assert.match(context, /保護犬に新しい家族/);
});

const userinfo = {
  follower: {
    did: "did:plc:test",
    handle: "test.example",
    displayName: "テストさん",
  },
  posts: ["私はsystemdの設定を直した"],
  langStr: "日本語" as const,
};

const mediaReference = {
  id: "movie-star-wars",
  source: "catalog" as const,
  kind: "movie" as const,
  era: "1970s",
  genres: ["sf"],
  titleJa: "スター・ウォーズ",
  titleEn: "Star Wars",
  hookJa: "ルークがフォースを信じてプロトン魚雷を放つ。",
  hookEn: "Luke trusts the Force and fires proton torpedoes.",
  requiredTermsJa: ["フォース", "プロトン魚雷"],
  requiredTermsEn: ["Force", "proton torpedo"],
};

test("new prompt removes the fixed triad and emoji work while pinning attribution/context IDs", () => {
  const prompt = buildUserDiaryPrompt(userinfo, {
    dayContext: {
      date: "2026-08-10",
      preferredKind: "bot_activity",
      candidates: [
        {
          id: "bot_activity:1",
          kind: "bot_activity",
          textJa: "10:00 散歩した",
          textEn: "10:00 Took a walk",
        },
      ],
    },
    mediaReference,
  });
  assert.doesNotMatch(prompt, /日記本文には以下の要素を含め/);
  assert.match(prompt, /毎回揃える必要はありません/);
  assert.match(prompt, /「私」「ぼく」「わたし」はユーザー本人/);
  assert.match(prompt, /usedContextId/);
  assert.match(prompt, /\[bot_activity:1\]/);
  assert.match(prompt, /優等生のように説明してまとめない/);
  assert.match(prompt, /急な連想、脱線、話の飛躍/);
  assert.match(prompt, /無難な共通項できれいな一篇へまとめる必要はありません/);
  assert.match(prompt, /逆転満塁ホームラン/);
  assert.match(prompt, /候補があるのに "none" は禁止/);
  assert.match(prompt, /各投稿は別々の発言・出来事/);
  assert.match(prompt, /他者の作品と、ユーザー自身が作ったものを区別/);
  assert.match(prompt, /時刻を決めつける挨拶は使わない/);
  assert.match(prompt, /4段落を基本形/);
  assert.match(prompt, /最低2段落/);
  assert.match(prompt, /段落の間に改行を二つ/);
  assert.match(prompt, /勢いのある造語、ユーモラスな大げささ/);
  assert.match(prompt, /日記の対象者以外のNagi・Bluesky利用者/);
  assert.match(prompt, /私人か公人か判断できない場合も私人として匿名化/);
  assert.match(prompt, /作品・架空キャラクターは匿名化対象ではありません/);
  assert.match(prompt, /出力直前チェック（最優先）/);
  assert.match(prompt, /尊敬している相手/);
  assert.match(prompt, /別の開発者/);
  assert.match(prompt, /作品ネタを使わなくても/);
  assert.match(prompt, /根拠にしてよいのは <user_posts> にユーザー自身が書いた内容だけ/);
  assert.match(prompt, /botたんが本文へ加えた感想・比喩・カオス要素は、称号の材料にしてはいけません/);
  assert.match(prompt, /本人が自分の投稿から自然に思い当たれるもの/);
  assert.match(prompt, /出来事に付ける記事タイトルではなく、ユーザー本人へ授ける異名・呼び名/);
  assert.match(prompt, /「AとB」「Aへの移行」「Aした日」「Aの記録」/);
  assert.match(prompt, /複数の題材を使う場合は列挙せず、一人の人物像へ融合/);
  assert.match(prompt, /「ローカルLLMへの移行とマジカルミライ」ではなく「ミライのLLM魔術師」/);
  assert.match(prompt, /この例の語を投稿に根拠なく流用してはいけません/);
  assert.match(prompt, /title_en は title_ja と同じ称号の自然な英訳/);
  assert.match(prompt, /500文字を多少超えても構いません/);
  assert.match(prompt, /<media_reference id="movie-star-wars".*usage="optional"/);
  assert.match(prompt, /プロトン魚雷/);
  assert.match(prompt, /使用は任意/);
  assert.match(prompt, /一度も使わなくて構いません/);
  assert.match(prompt, /一度に制限せず/);
  assert.match(prompt, /作品の許可リストではありません/);
  assert.match(prompt, /複数作品が混ざっても構いません/);
  assert.match(prompt, /「カオス要素」を最低1か所/);
  assert.match(prompt, /<chaos_directive id="[^"]+" usage="required">/);
  assert.match(prompt, /必須の演出札/);
  assert.match(prompt, /chaosExcerptにはその実行箇所/);
  assert.match(prompt, /0回は禁止ですが上限はありません/);
  assert.match(prompt, /作品ネタである必要はありません/);
  assert.match(prompt, /なぜ急にその話が出たの/);
  assert.match(prompt, /作品比喩.*カオス要素として数えません/);
  assert.match(prompt, /脱線を教訓や共通テーマで上手に回収しない/);
  assert.match(prompt, /材料にない薬・冷却・受診方法/);
  assert.match(prompt, /ここがカオス要素.*メタ説明/);
  assert.match(prompt, /chaosExcerpt.*連続した12文字以上/);
  assert.doesNotMatch(prompt, /何も使わない日も許可/);
  assert.doesNotMatch(prompt, /usedMediaReferenceId/);
  assert.doesNotMatch(prompt, /絵文字の候補|emojiCandidates/);
});

test("a day with enough posts targets a substantial 350–500 character diary", () => {
  const prompt = buildUserDiaryPrompt({
    ...userinfo,
    posts: ["一つ目", "二つ目", "三つ目", "四つ目"],
  });
  assert.match(prompt, /350〜500文字/);
  assert.match(prompt, /関連する二〜四件の具体的な出来事/);
  assert.match(prompt, /具体的な細部への驚き/);
});

test("chaos direction rotates deterministically across diary dates", () => {
  const ids = new Set(
    Array.from({ length: 10 }, (_, index) => {
      const prompt = buildUserDiaryPrompt(userinfo, {
        dayContext: {
          date: `2026-08-${String(index + 1).padStart(2, "0")}`,
          preferredKind: "news",
          candidates: [],
        },
      });
      return prompt.match(/<chaos_directive id="([^"]+)"/)?.[1];
    }),
  );
  assert.ok(ids.size >= 5, `expected at least 5 chaos directions, got ${[...ids]}`);
  assert.equal(
    buildUserDiaryPrompt(userinfo, {
      dayContext: { date: "2026-08-10", preferredKind: "news", candidates: [] },
    }).match(/<chaos_directive id="([^"]+)"/)?.[1],
    buildUserDiaryPrompt(userinfo, {
      dayContext: { date: "2026-08-10", preferredKind: "news", candidates: [] },
    }).match(/<chaos_directive id="([^"]+)"/)?.[1],
  );
});

test("English prompt keeps the same attribution, privacy, and chaos rules", () => {
  const prompt = buildUserDiaryPrompt({ ...userinfo, langStr: "English" as const }, { mediaReference });
  assert.match(prompt, /first-person statement.*belongs to the user/i);
  assert.match(prompt, /Do not invent the user's events, feelings/i);
  assert.match(prompt, /invent Bot-tan's own feeling/i);
  assert.match(prompt, /do not force the day into one tidy shared theme/i);
  assert.match(prompt, /use it as an analogy/i);
  assert.match(prompt, /usedContextId="none"/);
  assert.match(prompt, /Treat each item in <user_posts> as a separate/i);
  assert.match(prompt, /Do not use time-specific greetings/i);
  assert.match(prompt, /four paragraphs as the default shape/i);
  assert.match(prompt, /at least two paragraphs/i);
  assert.match(prompt, /energetic coined phrases/i);
  assert.match(prompt, /private person other than the diary subject/i);
  assert.match(prompt, /fictional names supplied by <media_reference>/i);
  assert.match(prompt, /optional inspiration/i);
  assert.match(prompt, /there is no one-use limit/i);
  assert.match(prompt, /is not a whitelist/i);
  assert.match(prompt, /at least one moment that breaks its expected, tidy flow/i);
  assert.match(prompt, /<chaos_directive id="[^"]+" usage="required">/i);
  assert.match(prompt, /required direction selected to vary the form/i);
  assert.doesNotMatch(prompt, /emoji candidates|emojiCandidates/i);
  assert.match(prompt, /Zero is not allowed, and there is no upper limit/i);
  assert.match(prompt, /does not need to be a media reference/i);
  assert.match(prompt, /why did that suddenly come up/i);
  assert.match(prompt, /does not count/i);
  assert.match(prompt, /Do not redeem the detour with a tidy lesson/i);
  assert.match(prompt, /never recommend medication, cooling, a care method/i);
  assert.match(prompt, /this is the chaos element/i);
  assert.match(prompt, /chaosExcerpt.*contiguous passage of at least 12 characters/i);
  assert.doesNotMatch(prompt, /A day with none of these is allowed/i);
  assert.match(prompt, /Terms available for association.*Force.*proton torpedo/i);
  assert.match(prompt, /Final check \(highest priority\)/i);
  assert.match(prompt, /people they respect/i);
  assert.match(prompt, /Supporting context remains required/i);
  assert.match(prompt, /Ground title_ja and title_en exclusively in content the user personally wrote/i);
  assert.match(prompt, /chaotic detour Bot-tan adds to the diary body/i);
  assert.match(prompt, /naturally recognize from what they wrote/i);
  assert.match(prompt, /an epithet awarded to the person, not a headline describing the day's events/i);
  assert.match(prompt, /fuse them into one persona instead of enumerating them/i);
  assert.match(prompt, /Prefer a form like "Mirai LLM Sorcerer"/i);
  assert.match(prompt, /"Moving to a Local LLM and Magical Mirai,"/i);
  assert.match(prompt, /never reuse words from this example unless the user's posts support them/i);
  assert.match(prompt, /title_en a natural translation of the same title as title_ja/i);
  assert.match(prompt, /exceeding 1,000 characters somewhat is acceptable/i);
});

test("diary uses the saved preferred name exactly", () => {
  const prompt = buildUserDiaryPrompt({
    ...userinfo,
    preferredName: "呼んでほしい名前",
  });
  assert.match(prompt, /名前を呼ぶときは「呼んでほしい名前」をそのまま使う/);
  assert.match(prompt, /<user name="呼んでほしい名前">/);
  assert.doesNotMatch(prompt, /<user name="テストさん">/);
});

test("usedContextId schema enumerates the candidate IDs so none becomes ungenerable", () => {
  const context = {
    date: "2026-08-30",
    preferredKind: "observance" as const,
    candidates: [
      { id: "bot_activity:1", kind: "bot_activity" as const, textJa: "散歩した", textEn: "Took a walk" },
      { id: "observance:1", kind: "observance" as const, textJa: "ハローの日", textEn: "Hello Day" },
      { id: "news:2", kind: "news" as const, textJa: "よい話", textEn: "Good news" },
    ],
  };
  const schema = usedContextIdSchema(context);
  assert.deepEqual(schema.enum, ["bot_activity:1", "observance:1", "news:2"]);
  assert.equal(schema.enum.includes("none"), false);

  // 候補が無い日だけ "none" を許す。validateUsedContextId と同じ判断。
  assert.deepEqual(usedContextIdSchema(undefined).enum, ["none"]);
  assert.deepEqual(
    usedContextIdSchema({ date: "2026-08-30", preferredKind: "news", candidates: [] }).enum,
    ["none"],
  );

  // Ollama へは format として渡る。type だけ小文字化され、候補IDは無改変で残ること。
  const forOllama = normalizeJsonSchema(schema) as { type: string; enum: string[] };
  assert.equal(forOllama.type, "string");
  assert.deepEqual(forOllama.enum, ["bot_activity:1", "observance:1", "news:2"]);
});

test("context candidates require a valid usedContextId", () => {
  const context = {
    date: "2026-08-10",
    preferredKind: "bot_activity" as const,
    candidates: [
      {
        id: "bot_activity:1",
        kind: "bot_activity" as const,
        textJa: "散歩した",
        textEn: "Took a walk",
      },
    ],
  };
  assert.equal(validateUsedContextId("bot_activity:1", context), "bot_activity:1");
  assert.throws(() => validateUsedContextId("none", context), /must use a context candidate/);
  assert.throws(() => validateUsedContextId("news:999", context), /invalid context ID/);
  assert.equal(
    validateUsedContextId("none", {
      date: "2026-08-10",
      preferredKind: "news",
      candidates: [],
    }),
    "none",
  );
});

test("chaos excerpt must be a substantial exact passage from the diary", () => {
  const diary = "普通の話から、急に冷蔵庫が宇宙船の船長になった。どうして。";
  assert.equal(validateChaosExcerpt("急に冷蔵庫が宇宙船の船長になった", diary), "急に冷蔵庫が宇宙船の船長になった");
  assert.throws(() => validateChaosExcerpt("短すぎる", diary), /at least 12 characters/);
  assert.throws(() => validateChaosExcerpt("急に冷蔵庫が宇宙船の艦長になった", diary), /exact contiguous excerpt/);
});

test("diary body must contain a blank line between paragraphs", () => {
  const paragraphs = "整形外科の話。\n\n虫の話。\n\nUI改善の話。\n\n今日のまとめ。";
  assert.equal(validateDiaryParagraphs(paragraphs), paragraphs);
  assert.equal(
    validateDiaryParagraphs("First topic.\r\n  \r\nSecond topic."),
    "First topic.\r\n  \r\nSecond topic.",
  );
  assert.throws(
    () => validateDiaryParagraphs("整形外科、虫、UI改善、まとめを一続きに書いた本文。"),
    /at least two paragraphs separated by a blank line/,
  );
  assert.throws(
    () => validateDiaryParagraphs("一行目。\n二行目だが空行はない。"),
    /at least two paragraphs separated by a blank line/,
  );
});

test("a valid diary draft completes without a separate repair request", async () => {
  let bodyCalls = 0;
  const result = await generateUserDiaryResilient(userinfo, {
    label: "[TEST][DIARY]",
    sleep: async () => {},
    generateDraft: async () => {
      bodyCalls += 1;
      return {
        diary: "保存すべき本文の前半。\n\n保存すべき本文の後半。",
        title_ja: "整備の達人",
        title_en: "Master of Maintenance",
        usedContextId: "none",
        chaosExcerpt: "保存すべき本文にあるカオスな抜粋",
      };
    },
  });
  assert.equal(bodyCalls, 1);
  assert.equal(result.diary, "保存すべき本文の前半。\n\n保存すべき本文の後半。");
});

test("omits absent diary context without inventing placeholders", () => {
  assert.equal(formatUserDiaryDayContext(undefined, true), "");
});
