import assert from "node:assert/strict";
import test from "node:test";
import { prepareOllamaGrounding } from "../src/ai/grounding.js";
import {
  fitOllamaMessages,
  toOllamaMessages,
} from "../src/ai/generationClient.js";

/**
 * 非同期リサーチの入口と出口。
 *
 * 語（新語）は非同期。その場では「知らない」と答え、調べた結果は次回以降に効く。
 * URL は同期。「このリンク見て」に「あとで読むね」では会話にならないので、
 * リプライ生成の前に読んでから返す。
 */

const replyParams = (text: string) => ({
  model: "local-test",
  contents: [{ role: "user", parts: [{ text }] }],
  config: { tools: [{ googleSearch: {} }] },
});

/** plan / research が呼ばれたら即失敗させる。同期パスは検索してはいけない。 */
const forbidResearch = {
  plan: async () => {
    assert.fail("同期パスで planner を呼んではいけない");
  },
  research: async () => {
    assert.fail("同期パスで検索してはいけない");
  },
};

test("調べた事実があればリプライの根拠として差し込む", async () => {
  const remembered = "- 薬屋のひとりごと 第3期 — 10月2日放送開始";
  const result = await prepareOllamaGrounding(
    "BSKY_AFFIRMATIVE_REPLY",
    replyParams("今期のアニメ何が面白い？"),
    forbidResearch,
    { researchMemory: remembered },
  );
  const contents = JSON.stringify(result.contents);
  assert.match(contents, /grounding_research/);
  assert.match(contents, /薬屋のひとりごと 第3期/);
  // 実在確認が目的なので、固有名詞の出所を調査ブロックに限定する拘束も付ける。
  assert.match(contents, /must appear verbatim in the research above/);
});

test("調べた事実が無ければ「知らないと言う」よう指示する", async () => {
  for (const remembered of [undefined, null, "   "]) {
    const result = await prepareOllamaGrounding(
      "BSKY_AFFIRMATIVE_REPLY",
      replyParams("今期のアニメ何が面白い？"),
      forbidResearch,
      { researchMemory: remembered },
    );
    const contents = JSON.stringify(result.contents);
    assert.match(contents, /do not know something, say so/);
    assert.doesNotMatch(contents, /verbatim in the research above/);
  }
});

test("会話機能でも同期パスでは検索しない", async () => {
  const result = await prepareOllamaGrounding(
    "BSKY_CONVERSATION",
    replyParams("最近のニュース教えて"),
    forbidResearch,
  );
  assert.doesNotMatch(JSON.stringify(result.config), /googleSearch|urlContext/);
});

test("「知らないと言え」は予算トリムで消えない", async () => {
  // fitOllamaMessages は予算超過時に <grounding_research> を最初に半減→削除する。
  // 指示をそこへ包むと、会話が伸びたときに真っ先に消えてしまう。deferred は
  // 全リプライが通る経路なので、包まずに残ることをここで固定する。
  const result = await prepareOllamaGrounding(
    "BSKY_AFFIRMATIVE_REPLY",
    {
      model: "local-test",
      contents: [
        { role: "user", parts: [{ text: "昔の話".repeat(2_000) }] },
        { role: "model", parts: [{ text: "うんうん".repeat(2_000) }] },
        { role: "user", parts: [{ text: "最新のアニメ教えて" }] },
      ],
      config: { systemInstruction: "ペルソナ", tools: [{ googleSearch: {} }] },
    },
    forbidResearch,
  );

  const { messages } = fitOllamaMessages(toOllamaMessages(result), { budget: 200 });
  const joined = messages.map((message) => message.content).join("\n");
  assert.match(joined, /知ったかぶり/, "トリム後も残る");
});

test("貼られたリンクはその場で読んでから返す", async () => {
  // 語と違い URL は非同期にしない。読んだ結果を根拠として同じターンで使う。
  let researched: { queries: string[]; urls: string[] } | undefined;
  const result = await prepareOllamaGrounding(
    "BSKY_AFFIRMATIVE_REPLY",
    replyParams("これ見て https://example.com/a"),
    {
      plan: async () => {
        assert.fail("URL の取得に planner は要らない");
      },
      research: async (input) => {
        researched = input;
        return "- 記事タイトル — 要約";
      },
    },
    { urls: ["https://example.com/a"] },
  );

  assert.deepEqual(researched, { queries: [], urls: ["https://example.com/a"] });
  const contents = JSON.stringify(result.contents);
  assert.match(contents, /grounding_research/);
  assert.match(contents, /記事タイトル/);
});

test("リンクが読めなければ「知らない」経路へ落とす", async () => {
  // 読めなかったのに知ったかぶりをさせない。カードの title / description は
  // プロンプト側に残っているので、リプライ自体は成立する。
  const result = await prepareOllamaGrounding(
    "BSKY_AFFIRMATIVE_REPLY",
    replyParams("これ見て https://example.com/a"),
    {
      research: async () => {
        throw new Error("SPA で本文が取れない");
      },
    },
    { urls: ["https://example.com/a"] },
  );
  assert.match(JSON.stringify(result.contents), /do not know something, say so/);
});

test("リンクと記憶の両方があれば両方を根拠にする", async () => {
  const result = await prepareOllamaGrounding(
    "BSKY_CONVERSATION",
    replyParams("これ見て https://example.com/a"),
    { research: async () => "- リンクの中身" },
    {
      urls: ["https://example.com/a"],
      researchMemory: "- 前に調べた事実",
    },
  );
  const contents = JSON.stringify(result.contents);
  assert.match(contents, /リンクの中身/);
  assert.match(contents, /前に調べた事実/);
});
