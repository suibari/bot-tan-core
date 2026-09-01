import assert from "node:assert/strict";
import test from "node:test";
import {
  clearlyNeedsFreshFacts,
  prepareOllamaGrounding,
  urlsFromText,
} from "../src/gemini/grounding.js";
import {
  fitOllamaMessages,
  toOllamaMessages,
} from "../src/gemini/generationClient.js";

/**
 * 非同期リサーチの入口と出口。
 *
 * 入口 = リプライ後のエンキュー判定（LLM を使わない正規表現だけ）。
 * 出口 = 先に調べておいた事実を同期パスのリプライへ差し込む経路。
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

test("エンキュー判定はLLMを使わず鮮度の要る文とURLだけを拾う", () => {
  assert.equal(clearlyNeedsFreshFacts("最新のアニメ教えて"), true);
  assert.equal(clearlyNeedsFreshFacts("2026年のニュースある？"), true);
  assert.equal(clearlyNeedsFreshFacts("今日はしんどかった"), false);
  assert.equal(urlsFromText("これ見て https://example.com/a").length, 1);
  assert.equal(urlsFromText("リンクなしの雑談").length, 0);
});

test("調べた事実があればリプライの根拠として差し込む", async () => {
  const remembered = "- 薬屋のひとりごと 第3期 — 10月2日放送開始";
  const result = await prepareOllamaGrounding(
    "BSKY_AFFIRMATIVE_REPLY",
    replyParams("今期のアニメ何が面白い？"),
    forbidResearch,
    remembered,
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
      remembered,
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
