import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import {
  CHAOS_DIRECTIVES,
  REPLY_NETA_DIRECTIVES,
  replyNetaRate,
  selectReplyNetaDirective,
} from "../src/ai/chaosDirectives.js";
import { buildAffirmativePrompt, resolveReplyDirectives } from "../src/ai/generateAffirmativeWord.js";

const userinfo = (text: string, langStr: "日本語" | "English" = "日本語"): UserInfoGemini =>
  ({
    follower: { did: "did:plc:test", handle: "test.example", displayName: "テストさん" },
    posts: [text],
    langStr,
  }) as UserInfoGemini;

const card = REPLY_NETA_DIRECTIVES[0];

/** 日記の札は `did:日付` のハッシュで選ばれる。並びが変わると既存ユーザの札が入れ替わる。 */
test("日記の演出札の並びは切り出し前と同じ", () => {
  assert.deepEqual(
    CHAOS_DIRECTIVES.map((directive) => directive.id),
    [
      "absurd-job",
      "nonsense-unit",
      "tiny-emergency",
      "object-agenda",
      "image-collision",
      "detail-obsession",
      "sentence-hijack",
      "imaginary-bureau",
      "sound-effect",
      "mock-trailer",
    ],
  );
});

test("リプライの札は同じ投稿なら何度引いても同じ", () => {
  for (let i = 0; i < 50; i++) {
    const seed = `did:plc:x:${i}`;
    assert.equal(selectReplyNetaDirective(seed, 0.4)?.id, selectReplyNetaDirective(seed, 0.4)?.id);
  }
});

test("リプライの札は割合どおりに当たり、0なら引かない", () => {
  const seeds = Array.from({ length: 2000 }, (_, i) => `did:plc:${i}:今日はカレーを作った`);
  const hits = seeds.filter((seed) => selectReplyNetaDirective(seed, 0.4)).length;
  assert.ok(hits > 700 && hits < 900, `hits=${hits}`);
  assert.equal(seeds.filter((seed) => selectReplyNetaDirective(seed, 0)).length, 0);
  assert.equal(seeds.filter((seed) => selectReplyNetaDirective(seed, 1)).length, seeds.length);
  const used = new Set(seeds.map((seed) => selectReplyNetaDirective(seed, 1)?.id));
  assert.equal(used.size, REPLY_NETA_DIRECTIVES.length);
});

test("AI_REPLY_NETA_RATE は0〜1に丸め、壊れた値は既定へ戻す", () => {
  assert.equal(replyNetaRate({}), 0.4);
  assert.equal(replyNetaRate({ AI_REPLY_NETA_RATE: "0" }), 0);
  assert.equal(replyNetaRate({ AI_REPLY_NETA_RATE: "2" }), 1);
  assert.equal(replyNetaRate({ AI_REPLY_NETA_RATE: "abc" }), 0.4);
});

test("沈んでいる投稿には演出札を入れず、角度札を入れる", async () => {
  const selectNeta = () => card;
  const tired = await resolveReplyDirectives(userinfo("今日ちょっと疲れた"), {
    selectNeta,
    scoreMood: async () => ({ valence: -1, expressive: true }),
  });
  assert.equal(tired.neta, undefined);
  assert.ok(tired.careAngle);
  const curry = await resolveReplyDirectives(userinfo("カレー作った"), {
    selectNeta,
    scoreMood: async () => ({ valence: 0, expressive: false }),
  });
  assert.equal(curry.neta?.id, card.id);
  assert.equal(curry.careAngle, undefined);
});

test("気分を採点できないときはどちらの札も入れない", async () => {
  const selectNeta = () => card;
  assert.deepEqual(await resolveReplyDirectives(userinfo("カレー作った"), { selectNeta, scoreMood: async () => null }), {});
  assert.deepEqual(
    await resolveReplyDirectives(userinfo("カレー作った"), {
      selectNeta,
      scoreMood: async () => {
        throw new Error("ollama down");
      },
    }),
    {},
  );
});

test("本文が空の投稿では気分採点を呼ばない", async () => {
  let called = 0;
  const scoreMood = async () => {
    called++;
    return { valence: 3, expressive: true };
  };
  assert.deepEqual(await resolveReplyDirectives(userinfo("  "), { selectNeta: () => card, scoreMood }), {});
  assert.equal(called, 0);
});

test("札はユーザ投稿より前（指示側）に入り、引かなければ出ない", async () => {
  const ja = await buildAffirmativePrompt(userinfo("カレー作った"), { neta: card });
  assert.match(ja, /<neta_directive id="nonsense-unit">/);
  assert.ok(ja.indexOf("<neta_directive") < ja.indexOf("### 今回のポスト"));
  assert.match(ja, /1文だけ/);

  const en = await buildAffirmativePrompt(userinfo("I made curry", "English"), { neta: card });
  assert.match(en, /<neta_directive id="nonsense-unit">/);
  assert.ok(en.indexOf("<neta_directive") < en.indexOf("### This post"));

  assert.doesNotMatch(await buildAffirmativePrompt(userinfo("カレー作った")), /neta_directive/);
});
