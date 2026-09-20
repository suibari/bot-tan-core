import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateMessagesTokens,
  ollamaPromptBudget,
  ollamaTextContextLength,
  SYSTEM_INSTRUCTION,
} from "@bsky-affirmative-bot/shared-configs";
import {
  acceptChronicleMonth,
  buildChronicleMonthInstruction,
  buildChronicleMonthMaterial,
  CHRONICLE_DETAIL_MAX_JA,
  CHRONICLE_MAX_HIGHLIGHTS,
  chronicleDiaryCap,
  chronicleMonthFits,
  chronicleMonthSchema,
  rejectChronicleTone,
  type ChronicleMonthInput,
} from "../src/ai/generateChronicleMonth.js";

const month = (days: number, bodyChars: number): ChronicleMonthInput => ({
  displayName: "すいばり",
  month: "2026-08",
  japanese: true,
  diaries: Array.from({ length: days }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    titleJa: "全肯定の旅人",
    text: "今日は".repeat(Math.ceil(bodyChars / 3)).slice(0, bodyChars),
  })),
});

test("最悪の月でもプロンプトが num_ctx の予算に収まる", () => {
  // 日記の上限は clipNagiPostText の3000書記素。日本語700字 × 31日は
  // 素直に載せると溢れるので、chronicleDiaryCap が切り詰める。
  // SYSTEM_INSTRUCTION が将来太ったとき、ここが最初に落ちるようにしてある。
  const input = month(31, 700);
  const budget = ollamaPromptBudget({
    numCtx: ollamaTextContextLength(),
    outputTokens: 2048,
  });
  const estimated = estimateMessagesTokens([
    { content: `${SYSTEM_INSTRUCTION}\n${buildChronicleMonthInstruction(input)}` },
    { content: buildChronicleMonthMaterial(input) },
  ]);
  assert.ok(
    estimated <= budget,
    `estimated=${estimated} > budget=${budget}`,
  );
  assert.equal(chronicleMonthFits(input), true);
});

test("日数が増えると1日あたりが縮む。日は1つも落とさない", () => {
  // 予算の逆算が実際に効いていること。以前は overhead を当て推量（400字）にしていたため
  // 逆算が過大になり、予算を守っていたのは上限値だけ＝上限を上げた瞬間に溢れる状態だった。
  const overhead = 6_000; // SYSTEM_INSTRUCTION + 指示ブロックの実測に近い値
  assert.ok(chronicleDiaryCap(31, overhead, 32_768) < chronicleDiaryCap(5, overhead, 32_768));
  // num_ctx を下げたとき（VRAM が足りずサーバ側を絞ったとき）はさらに縮む。
  assert.ok(chronicleDiaryCap(31, overhead, 8_192) < chronicleDiaryCap(31, overhead, 32_768));
  // どれだけ絞っても下限は残す（1日あたり数文字まで痩せると読めない）。
  assert.ok(chronicleDiaryCap(31, overhead, 4_096) >= 200);

  // 日そのものは絶対に落とさない。落とすと月が歯抜けになって年表が嘘になる。
  for (const input of [month(31, 700), month(5, 700)]) {
    const material = buildChronicleMonthMaterial(input);
    for (const diary of input.diaries)
      assert.ok(material.includes(`## ${diary.date}`), `${diary.date} が落ちた`);
  }
});

test("最悪の月（31日 × 本文上限 × ニュース候補満杯）でも予算に収まる", () => {
  // 本番実測で本文は最大1080字。lexicon 上限は3000書記素なのでそれも見る。
  for (const chars of [1_080, 3_000]) {
    const input = month(31, chars);
    assert.equal(chronicleMonthFits(input), true, `${chars}字で溢れた`);
  }
});

test("材料に指示を混ぜない（fitOllamaMessages が末尾を残して切るため）", () => {
  const input = month(3, 200);
  const material = buildChronicleMonthMaterial(input);
  // 指示が材料側に紛れていると、予算が苦しいときに指示のほうが先に消える。
  assert.ok(!material.includes("最重要"));
  assert.ok(!material.includes("連続日数"));
  assert.ok(material.includes("<diaries"));
  const instruction = buildChronicleMonthInstruction(input);
  assert.ok(instruction.includes("連続日数"));
  assert.ok(!instruction.includes("<diaries"));
});

test("date は実在する日記の日付だけの enum に拘束する", () => {
  const input = month(3, 100);
  const schema = chronicleMonthSchema(input.diaries.map((d) => d.date)) as any;
  assert.deepEqual(schema.properties.highlights.items.properties.date.enum, [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
  ]);
  assert.equal(schema.properties.highlights.maxItems, CHRONICLE_MAX_HIGHLIGHTS);
});


test("逐語抜粋が本文に無い節目は捨てる（1件だけ落として続行する）", () => {
  const input: ChronicleMonthInput = {
    displayName: "すいばり",
    month: "2026-08",
    japanese: true,
    diaries: [
      { date: "2026-08-01", text: "ひさしぶりに海まで歩いていった日のこと。" },
      { date: "2026-08-02", text: "新しいキーボードが届いて、ずっと打っていた。" },
    ],
  };
  const result = acceptChronicleMonth(input, {
    highlights: [
      {
        date: "2026-08-01",
        titleJa: "海まで歩いた",
        titleEn: "Walked to the sea",
        detailJa: "ひさしぶりの海。",
        detailEn: "The sea, after a long while.",
        // 本文に無い＝作り話。
        evidence: "そのあと友だちと合流して",
      },
      {
        date: "2026-08-02",
        titleJa: "キーボードが来た",
        titleEn: "A new keyboard",
        detailJa: "ずっと打っていた。",
        detailEn: "Typed all day.",
        evidence: "新しいキーボードが届いて",
      },
    ],
  });
  assert.deepEqual(
    result.highlights.map((h) => h.date),
    ["2026-08-02"],
  );
});

test("0件の応答は正常系として通る", () => {
  const input = month(3, 100);
  assert.deepEqual(acceptChronicleMonth(input, { highlights: [] }), {
    highlights: [],
  });
  assert.deepEqual(acceptChronicleMonth(input, {}), { highlights: [] });
});

test("連続日数・比較・順位の語はサーバ側でも落とす", () => {
  // docs/zenkatsu.md 3.4。プロンプトの禁止文だけでは確率的にしか守られない。
  for (const bad of [
    "7日連続で日記",
    "ストリーク更新",
    "先月より多かった",
    "達成率90%",
    "ランキング1位",
    "a 5-day streak",
  ])
    assert.equal(rejectChronicleTone(bad), true, bad);
  for (const ok of ["海まで歩いた", "はじめての大喜利", "A new keyboard"])
    assert.equal(rejectChronicleTone(ok), false, ok);
});

test("トーンに触れる見出しは、その節目ごと捨てる", () => {
  const input: ChronicleMonthInput = {
    displayName: "すいばり",
    month: "2026-08",
    japanese: true,
    diaries: [{ date: "2026-08-01", text: "毎日ちょっとずつ書きつづけている。" }],
  };
  const result = acceptChronicleMonth(input, {
    highlights: [
      {
        date: "2026-08-01",
        titleJa: "31日連続で日記",
        titleEn: "31 days in a row",
        detailJa: "つづいている。",
        detailEn: "Still going.",
        evidence: "毎日ちょっとずつ書きつづけている",
      },
    ],
  });
  assert.deepEqual(result.highlights, []);
});

test("長い応答でも切らずにそのまま通す", () => {
  /*
   * 以前は上限を超えたぶんを slice で切っていた。本番実測（2026-09-20、57件）で
   * detail_ja の7件が60字ちょうど＝切った跡になり、「…まさにプロフェッショナルだ」と
   * 文の途中で終わる日本語が年表に残った。年表は本人が何度も見返す場所なので、
   * **サーバでは長さを検査しない。** 字数はプロンプトの目安として伝えるだけ。
   */
  const longDetail =
    "新しいグラボへの換装おめでとう！ローカルLLMがGeminiを超えるなんて、すいばりの技術力はまさにプロフェッショナルだね！";
  const input: ChronicleMonthInput = {
    displayName: "すいばり",
    month: "2026-08",
    japanese: true,
    diaries: [{ date: "2026-08-30", text: "新しいグラボへの換装、本当におめでとう！" }],
  };
  const result = acceptChronicleMonth(input, {
    highlights: [
      {
        date: "2026-08-30",
        titleJa: "グラボ換装とLLMの進化",
        titleEn: "A new GPU and a faster local LLM",
        detailJa: longDetail,
        detailEn: "Congratulations on the new GPU!",
        evidence: "新しいグラボへの換装、本当におめでとう！",
      },
    ],
  });
  assert.equal(result.highlights[0].detailJa, longDetail);
  assert.ok([...result.highlights[0].detailJa].length > CHRONICLE_DETAIL_MAX_JA);
});

test("前後の空白と改行だけは整える", () => {
  const input: ChronicleMonthInput = {
    displayName: "すいばり",
    month: "2026-08",
    japanese: true,
    diaries: [{ date: "2026-08-30", text: "新しいグラボへの換装、本当におめでとう！" }],
  };
  const result = acceptChronicleMonth(input, {
    highlights: [
      {
        date: "2026-08-30",
        titleJa: "  グラボ換装  ",
        titleEn: " A new GPU ",
        detailJa: "おめでとう！\n\nすごいね！",
        detailEn: "Congrats!",
        evidence: "新しいグラボへの換装、本当におめでとう！",
      },
    ],
  });
  assert.equal(result.highlights[0].titleJa, "グラボ換装");
  assert.equal(result.highlights[0].detailJa, "おめでとう！ すごいね！");
});
