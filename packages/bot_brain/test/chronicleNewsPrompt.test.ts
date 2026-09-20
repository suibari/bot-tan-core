import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptChronicleNews,
  CHRONICLE_NEWS_SKIP,
  buildChronicleNewsInstruction,
  buildChronicleNewsMaterial,
  chronicleNewsSchema,
  type ChronicleNewsInput,
} from "../src/ai/generateChronicleNews.js";

const input: ChronicleNewsInput = {
  month: "2026-08",
  candidates: [
    { date: "2026-08-03", title: "令和の“写ルンです”を再体験" },
    { date: "2026-08-14", title: "トイレットペーパーの芯の活用法" },
    { date: "2026-08-27", title: "女子ゴルフ第2日の写真特集" },
  ],
};

test("候補は番号付きで並び、指示は材料に混ぜない", () => {
  const material = buildChronicleNewsMaterial(input);
  assert.ok(material.includes("0. (2026-08-03) 令和の“写ルンです”を再体験"));
  assert.ok(material.includes("2. (2026-08-27)"));
  // fitOllamaMessages は中間を落とし末尾を残すので、指示は systemInstruction 側へ。
  assert.ok(!material.includes("選び方"));
  assert.ok(buildChronicleNewsInstruction("2026-08").includes("選び方"));
});

test("利用者の話と結びつけないことを明示する", () => {
  // ここが「日記と響き合うものを選ぶ」だと、関係ある月にしか出なくなる。
  // この欄は世の中の出来事なので、誰の話とも無関係でよい。
  const instruction = buildChronicleNewsInstruction("2026-08");
  assert.ok(instruction.includes("特定の誰かの話と結びつける必要はありません"));
  // 候補プールは全肯定ニュース。事件・事故は入らないので、そちらを優先させない。
  assert.ok(instruction.includes("明るい話題しか入っていません"));
});

test("選べるのは候補の添字だけ。棄権は明示的な -1", () => {
  const schema = chronicleNewsSchema(input.candidates.length) as any;
  assert.equal(schema.properties.index.minimum, CHRONICLE_NEWS_SKIP);
  assert.equal(schema.properties.index.maximum, 2);
  /*
   * **3つとも required。** 以前は required: [] で「キーを省けば棄権」にしていたが、
   * それだと {} が文法上いちばん短い正解になり、本番の7月・8月とも必ず棄権した。
   * 選ばせたいなら、選ばないほうを楽にしないこと。
   */
  assert.deepEqual(schema.required, ["index", "titleJa", "titleEn"]);
});

test("index が -1 なら棄権として扱う", () => {
  assert.deepEqual(
    acceptChronicleNews(input, { index: CHRONICLE_NEWS_SKIP, titleJa: "あ", titleEn: "a" }),
    {},
  );
});

test("範囲外・空・トーン違反は選ばなかったことにする", () => {
  const ok = { index: 1, titleJa: "写ルンです再燃", titleEn: "Film cameras are back" };
  assert.deepEqual(acceptChronicleNews(input, ok), {
    index: 1,
    titleJa: "写ルンです再燃",
    titleEn: "Film cameras are back",
  });
  for (const bad of [
    {},
    { ...ok, index: 3 },
    { ...ok, index: -1 },
    { ...ok, titleJa: "" },
    { ...ok, titleJa: "3か月連続で話題" },
  ])
    assert.deepEqual(acceptChronicleNews(input, bad), {}, JSON.stringify(bad));
});

test("候補が無ければ何も選ばない", () => {
  assert.deepEqual(acceptChronicleNews({ month: "2026-08", candidates: [] }, { index: 0 }), {});
});
