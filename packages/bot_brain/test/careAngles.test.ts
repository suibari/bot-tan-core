import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import {
  CARE_ANGLES,
  careAnglesForTier,
  careTierForValence,
  selectCareAngle,
} from "../src/ai/careAngles.js";
import { buildAffirmativePrompt, resolveReplyDirectives } from "../src/ai/generateAffirmativeWord.js";

const userinfo = (text: string, langStr: "日本語" | "English" = "日本語"): UserInfoGemini =>
  ({
    follower: { did: "did:plc:test", handle: "test.example", displayName: "テストさん" },
    posts: [text],
    langStr,
  }) as UserInfoGemini;

test("気分の段で tier が決まる", () => {
  assert.equal(careTierForValence(0), undefined);
  assert.equal(careTierForValence(3), undefined);
  assert.equal(careTierForValence(-1), "light");
  assert.equal(careTierForValence(-2), "light");
  assert.equal(careTierForValence(-3), "heavy");
  assert.equal(careTierForValence(-5), "heavy");
});

/** 重い話で助言・「できていること」の評価をさせない（CARE_TOPIC_RULES の禁止と同じ線）。 */
test("heavy には解決策と「できていること」の札が入らない", () => {
  const heavy = careAnglesForTier("heavy").map((angle) => angle.id);
  assert.ok(!heavy.includes("small-step"));
  assert.ok(!heavy.includes("already-doing"));
  assert.ok(heavy.includes("stay-close"));
  const light = careAnglesForTier("light").map((angle) => angle.id);
  assert.deepEqual(light, CARE_ANGLES.map((angle) => angle.id));
});

test("角度は同じ投稿なら同じで、投稿が変われば散らばる", () => {
  for (let i = 0; i < 50; i++) {
    const seed = `did:plc:x:${i}`;
    assert.equal(selectCareAngle(seed, "light").id, selectCareAngle(seed, "light").id);
  }
  for (const tier of ["light", "heavy"] as const) {
    const used = new Set(
      Array.from({ length: 500 }, (_, i) => selectCareAngle(`did:plc:${i}:しんどい`, tier).id),
    );
    assert.equal(used.size, careAnglesForTier(tier).length);
    for (let i = 0; i < 500; i++) {
      assert.ok(careAnglesForTier(tier).some((angle) => angle.id === selectCareAngle(`s${i}`, tier).id));
    }
  }
});

test("気分の段に応じた tier の札を引く", async () => {
  const tiers: string[] = [];
  const selectAngle = (_seed: string, tier: "light" | "heavy") => {
    tiers.push(tier);
    return careAnglesForTier(tier)[0];
  };
  await resolveReplyDirectives(userinfo("ちょっと疲れた"), {
    selectAngle,
    scoreMood: async () => ({ valence: -2, expressive: true }),
  });
  await resolveReplyDirectives(userinfo("もう限界"), {
    selectAngle,
    scoreMood: async () => ({ valence: -4, expressive: true }),
  });
  assert.deepEqual(tiers, ["light", "heavy"]);
});

test("角度札はユーザ投稿より前（指示側）に入り、CARE の禁止を優先させる", async () => {
  const angle = CARE_ANGLES.find((a) => a.id === "small-step")!;
  const ja = await buildAffirmativePrompt(userinfo("ちょっと疲れた"), { careAngle: angle });
  assert.match(ja, /<care_angle id="small-step">/);
  assert.ok(ja.indexOf("<care_angle") < ja.indexOf("### 今回のポスト"));
  assert.ok(ja.indexOf("<care_angle") < ja.indexOf("## つらい話を打ち明けられたときの書き方"));
  assert.match(ja, /禁止事項は、この指示より優先します/);
  assert.match(ja, /材料が無ければ/);

  const en = await buildAffirmativePrompt(userinfo("A bit tired", "English"), { careAngle: angle });
  assert.match(en, /<care_angle id="small-step">/);
  assert.ok(en.indexOf("<care_angle") < en.indexOf("### This post"));

  assert.doesNotMatch(await buildAffirmativePrompt(userinfo("カレー作った")), /care_angle/);
});

/** 26B / 12B は例文を写す。落ち込み向けの例文と「3点セット」の指定を戻さない。 */
test("落ち込み向けの例文と3点セットの指定がプロンプトに無い", async () => {
  const ja = await buildAffirmativePrompt(userinfo("しんどい"));
  assert.doesNotMatch(ja, /よく考えていてえらいね/);
  assert.doesNotMatch(ja, /そういう時もあるよね/);
  assert.doesNotMatch(ja, /そばにいるという気持ちを中心に/);
  const en = await buildAffirmativePrompt(userinfo("I'm down", "English"));
  assert.doesNotMatch(en, /Everyone has those days/);
  assert.doesNotMatch(en, /letting them know you are here\./);
});
