import assert from "node:assert/strict";
import test from "node:test";
import { buildMonologuePrompt, monologueSimilarity, parseMonologueResponse } from "../src/ai/generateMonologue.js";
import { UnsourcedUrlError } from "../src/ai/urlGuard.js";

const input = {
  currentActivity: "飛び起きて、パンをくわえたまま制服に着替えている",
  hour: 8,
  isWeekend: false,
  energy: 15,
  weather: "くもり",
  situationJa: "平日の朝、一度起きたのに二度寝して、いま目が覚めた",
  reactionJa: "焦り。",
  recentMonologues: ["ねむ…", "メロンパン確保"],
};

const json = (textJa: string, textEn = "oh no I'm late") => JSON.stringify({ textJa, textEn });

test("プロンプトに状況・反応の型・最近のひとりごと・元気の低さが入る", () => {
  const prompt = buildMonologuePrompt(input);
  assert.match(prompt, /二度寝して/);
  assert.match(prompt, /焦り。/);
  assert.match(prompt, /- メロンパン確保/);
  assert.match(prompt, /15\/100（ほぼ空っぽ/);
  assert.match(prompt, /ハッシュタグ/);
});

test("短い日本語のひとりごとは通す", () => {
  assert.deepEqual(parseMonologueResponse(json("やば")), { textJa: "やば", textEn: "oh no I'm late" });
});

test("長すぎる・タグ付き・メンション付き・URL付きは作り直させる", () => {
  assert.throws(() => parseMonologueResponse(json("あ".repeat(81))), /too long/);
  assert.throws(() => parseMonologueResponse(json("ねむい #ひとりごと")), /hashtag/);
  assert.throws(() => parseMonologueResponse(json("ねむい ＃眠い")), /hashtag/);
  assert.throws(() => parseMonologueResponse(json("ねむい", "sleepy @friend")), /mention/);
  assert.throws(() => parseMonologueResponse(json("これ見て https://example.com")), UnsourcedUrlError);
});

test("日英の入れ違い・フィールド名の漏れ・直近と同じ本文は弾く", () => {
  assert.throws(() => parseMonologueResponse(json("so sleepy")), /not Japanese/);
  assert.throws(() => parseMonologueResponse(json("ねむい", "ねむいよ本当にねむいねむいねむいねむいねむい")), /too much Japanese/);
  assert.throws(() => parseMonologueResponse(json("textJa: ねむい")), /field name/);
  assert.throws(() => parseMonologueResponse(json("ねむ …"), ["ねむ…"]), /repeated/);
  assert.throws(() => parseMonologueResponse("not json"), /invalid JSON/);
});

test("絵文字なしの回は外し、ありの回は残す", () => {
  assert.equal(parseMonologueResponse(json("ねむい☁️")).textJa, "ねむい");
  assert.equal(parseMonologueResponse(json("ねむい☁️"), [], { emoji: true }).textJa, "ねむい☁️");
  assert.match(buildMonologuePrompt(input), /今回は絵文字を付けないこと/);
  assert.match(buildMonologuePrompt({ ...input, emoji: true }), /絵文字を1個だけ/);
});

/** 2026-10-22 のドライランで、アイスを食べている step に前の「メロン人間」が再演された。 */
test("直近と似た本文・同じ書き出しは作り直させる", () => {
  const recent = ["これ食べたら、わたしってメロン人間になっちゃうのかな。☁️"];
  assert.ok(monologueSimilarity("これ食べ終わったら、わたしってメロン人間になっちゃうのかな。", recent[0]) >= 0.5);
  assert.throws(() => parseMonologueResponse(json("これ食べ終わったら、わたしってメロン人間になっちゃうのかな。"), recent), /repeated/);
  assert.throws(() => parseMonologueResponse(json("え、うそ……部屋散らかってたかも"), ["え、うそ……やばい"]), /opening/);
  assert.doesNotThrow(() => parseMonologueResponse(json("アイス溶けるの早すぎ"), recent));
});

test("いましていることを写しただけの本文は作り直させる", () => {
  const currentActivity = "月曜の小テストのために、しぶしぶ英単語をやっている";
  assert.throws(
    () => parseMonologueResponse(json("月曜の小テストのために、しぶしぶ英単語やってる。"), [], { currentActivity }),
    /copied/,
  );
  assert.doesNotThrow(() =>
    parseMonologueResponse(json("プリント広げたまま固まってる。わたし、何やってるんだろ……"), [], {
      currentActivity: "宿題のプリントを広げたまま固まっている",
    }),
  );
});
