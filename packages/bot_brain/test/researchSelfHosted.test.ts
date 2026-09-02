import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  researchKnowledgeCardSelfHosted,
  researchSelfHosted,
} from "../src/ai/grounding.js";
import { MemoryService } from "@bsky-affirmative-bot/database";

/**
 * 計上とエンキューは fire-and-forget で database を動的importする。実DBへ抜けると
 * 接続が開いたままになり、テストが全部通ってもプロセスが終了しない（実測）。
 * ファイル全体で差し替えて、単体テストが DB に触らないようにする。
 */
mock.method(MemoryService, "incrementStats", async () => {});


/**
 * 自前調査（SearXNG 検索 → 本文取得 → ローカル要約）を fetch 差し替えで通しで見る。
 * 3 つの外部呼び出しがすべて fetch なので、URL で振り分ければ実サービス無しで検証できる。
 */

const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

test.beforeEach(() => {
  process.env.SEARXNG_BASE_URL = "http://127.0.0.1:8080";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
});

type Routes = {
  search?: unknown;
  page?: { body: string | ((url: string) => string); contentType?: string };
  summary?: unknown;
  onSummaryPrompt?: (prompt: string) => void;
  onPageFetch?: (url: string) => void;
};

/** SearXNG / ページ取得 / Ollama を URL で振り分ける。 */
function stubFetch(routes: Routes) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("127.0.0.1:8080")) {
      return new Response(JSON.stringify(routes.search ?? { results: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("ollama.test")) {
      const body = JSON.parse(init.body);
      routes.onSummaryPrompt?.(
        body.messages.map((message: any) => message.content).join("\n"),
      );
      return new Response(
        JSON.stringify({
          model: "local-test",
          message: { content: JSON.stringify(routes.summary ?? { items: [] }) },
          prompt_eval_count: 10,
          eval_count: 5,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (!routes.page) throw new Error(`unexpected fetch: ${url}`);
    routes.onPageFetch?.(url);
    const pageBody = typeof routes.page.body === "function"
      ? routes.page.body(url)
      : routes.page.body;
    return new Response(pageBody, {
      headers: { "content-type": routes.page.contentType ?? "text/html" },
    });
  }) as typeof fetch;
}

const SEARCH_HIT = {
  results: [
    {
      url: "https://93.184.216.34/summer",
      title: "2026夏アニメ一覧",
      content: "7月放送開始の新作まとめ",
    },
  ],
  infoboxes: [
    {
      infobox: "薬屋のひとりごと",
      content: "日向夏による日本のライトノベル。",
      id: "https://ja.wikipedia.org/wiki/x",
    },
  ],
};

test("検索・本文取得・要約を通して調査ブロックを組み立てる", async () => {
  let prompt = "";
  stubFetch({
    search: SEARCH_HIT,
    page: { body: "<html><body><p>薬屋のひとりごと 第3期 10月2日放送</p></body></html>" },
    summary: {
      items: [
        {
          name: "薬屋のひとりごと 第3期",
          detail: "10月2日放送開始",
          source: "https://93.184.216.34/summer",
        },
      ],
    },
    onSummaryPrompt: (value) => {
      prompt = value;
    },
  });

  const research = await researchSelfHosted({ queries: ["夏アニメ 2026"], urls: [] });

  assert.match(research, /薬屋のひとりごと 第3期 — 10月2日放送開始/);
  // infobox は実在確認の核心なので必ず要約の入力に入れる。
  assert.match(prompt, /日向夏による日本のライトノベル/);
  // 本文まで取りに行っていること（スニペットだけで済ませない）。
  assert.match(prompt, /10月2日放送/);
});

test("出典は取得したURLから機械的に並べる", async () => {
  stubFetch({
    search: SEARCH_HIT,
    page: { body: "<html><body><p>本文</p></body></html>" },
    // 要約モデルが存在しないURLを書いてきても、Sources には混ぜない。
    summary: {
      items: [{ name: "作品A", detail: "説明", source: "https://hallucinated.example/" }],
    },
  });

  const research = await researchSelfHosted({ queries: ["夏アニメ 2026"], urls: [] });
  const sources = research.slice(research.indexOf("Sources:"));
  assert.match(sources, /https:\/\/93\.184\.216\.34\/summer/);
  assert.doesNotMatch(sources, /hallucinated/);
});

test("本文取得に失敗してもスニペットで続行する", async () => {
  let prompt = "";
  stubFetch({
    search: SEARCH_HIT,
    // HTML 以外を返して本文取得を失敗させる。SPA や bot 避けサイトの再現。
    page: { body: "%PDF-1.7", contentType: "application/pdf" },
    summary: { items: [{ name: "作品A", detail: "説明" }] },
    onSummaryPrompt: (value) => {
      prompt = value;
    },
  });

  const research = await researchSelfHosted({ queries: ["夏アニメ 2026"], urls: [] });
  assert.match(research, /作品A/);
  assert.match(prompt, /7月放送開始の新作まとめ/, "スニペットへ落ちている");
});

test("素材がまったく集まらなければthrowする", async () => {
  // required 機能の「調べられなければ生成しない」契約を守るため、握り潰さない。
  stubFetch({ search: { results: [], infoboxes: [] } });
  await assert.rejects(
    researchSelfHosted({ queries: ["何も出ないクエリ"], urls: [] }),
    /no material/,
  );
});

test("要約が空配列を返したらthrowする", async () => {
  stubFetch({
    search: SEARCH_HIT,
    page: { body: "<html><body><p>本文</p></body></html>" },
    summary: { items: [] },
  });
  await assert.rejects(
    researchSelfHosted({ queries: ["夏アニメ 2026"], urls: [] }),
    /no items/,
  );
});

test("SearXNGが落ちていてもinfoboxもヒットも無ければthrowする", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
  await assert.rejects(
    researchSelfHosted({ queries: ["夏アニメ 2026"], urls: [] }),
    /no material/,
  );
});

test("URLだけでも検索せず本文を読んで調査できる", async () => {
  // Gemini の URL Context の置き換え。利用者が貼ったリンクは検索を挟まず直接読む。
  let searched = false;
  let prompt = "";
  stubFetch({
    search: { results: [] },
    page: {
      body: "<html><head><title>秋アニメ特集</title></head><body><p>薬屋のひとりごと 第3期 10月2日</p></body></html>",
    },
    summary: { items: [{ name: "薬屋のひとりごと 第3期", detail: "10月2日" }] },
    onSummaryPrompt: (value) => {
      prompt = value;
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input?.url ?? input).includes("127.0.0.1:8080")) searched = true;
    return realFetch(input, init);
  }) as typeof fetch;

  const research = await researchSelfHosted({
    queries: [],
    urls: ["https://93.184.216.34/fall"],
  });

  assert.equal(searched, false, "URLジョブでは検索しない");
  assert.match(prompt, /薬屋のひとりごと 第3期 10月2日/, "本文が要約の入力に入る");
  assert.match(research, /薬屋のひとりごと 第3期/);
  assert.match(research, /93\.184\.216\.34\/fall/, "出典に元URLが載る");
});

test("URLが読めなければthrowして再試行に回す", async () => {
  // カードの title / description はプロンプト側に残るので、リプライ自体は成立する。
  stubFetch({ search: { results: [] }, page: { body: "%PDF", contentType: "application/pdf" } });
  await assert.rejects(
    researchSelfHosted({ queries: [], urls: ["https://93.184.216.34/x"] }),
    /no material/,
  );
});

test("非同期メモリー調査は上位5ページを読み統合知識カードを作る", async () => {
  const pageFetches: string[] = [];
  let prompt = "";
  const results = Array.from({ length: 6 }, (_, index) => ({
    url: `https://93.184.216.34/source-${index + 1}`,
    title: `資料${index + 1}`,
    content: `スニペット${index + 1}`,
  }));
  stubFetch({
    search: { results, infoboxes: [] },
    page: {
      body: (url) => `<html><body><main><p>${url.split("-").at(-1)}番目の本文情報</p></main></body></html>`,
    },
    summary: {
      overview: "対象Aは、複数の資料で説明されている作品です。",
      sections: [
        {
          heading: "位置づけ",
          detail: "資料を横断すると、前作に続く作品として位置づけられています。",
          sources: [
            "https://93.184.216.34/source-1",
            "https://hallucinated.example/source",
          ],
        },
      ],
    },
    onSummaryPrompt: (value) => {
      prompt = value;
    },
    onPageFetch: (url) => pageFetches.push(url),
  });

  const research = await researchKnowledgeCardSelfHosted("対象A");

  assert.equal(pageFetches.length, 5);
  for (let index = 1; index <= 5; index++) {
    assert.match(prompt, new RegExp(`${index}番目の本文情報`));
  }
  assert.doesNotMatch(prompt, /6番目の本文情報/);
  assert.match(research, /^概要\n対象Aは/);
  assert.match(research, /位置づけ\n資料を横断すると/);
  assert.match(research, /source-1/);
  assert.doesNotMatch(research, /hallucinated\.example/);
});
