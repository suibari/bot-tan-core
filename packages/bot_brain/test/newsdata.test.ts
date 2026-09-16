import assert from "node:assert/strict";
import test from "node:test";
import { PositiveNewsService } from "../src/api/newsdata/index.js";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function article(id: string, title: string) {
  return {
    article_id: id,
    title,
    description: `${title}の説明`,
    source_name: "テストニュース",
    image_url: `https://cdn.example.com/${id}.jpg`,
    category: ["top"],
  };
}

const silentLogger = { log() {}, warn() {} };

test("候補が3件集まるまでページングし、NewsDataの必須条件を付ける", async () => {
  const calls: string[] = [];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://newsdata.io")) {
      const parsedUrl = new URL(url);
      assert.equal(parsedUrl.searchParams.get("language"), "ja");
      assert.equal(parsedUrl.searchParams.get("country"), "jp");
      assert.equal(parsedUrl.searchParams.get("removeduplicate"), "1");
      assert.equal(parsedUrl.searchParams.get("excludecategory"), "politics,crime");
      assert.equal(parsedUrl.searchParams.get("excludedomain"), "news.google.com");
      assert.equal(parsedUrl.searchParams.get("prioritydomain"), "top");
      if (!parsedUrl.searchParams.has("page")) {
        return response({
          status: "success",
          totalResults: 100,
          nextPage: "page-2",
          results: [article("a1", "明るい発見"), article("r1", "未解決の話"), article("a2", "うれしい受賞")],
        });
      }
      return response({
        status: "success",
        totalResults: 100,
        results: [article("a3", "完全復旧")],
      });
    }

    const payload = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const content = payload.messages[1].content;
    const accepted = !content.includes("未解決");
    return response({
      message: {
        content: JSON.stringify({
          decision: accepted ? "accept" : "reject",
          promotional: false,
          reasonCode: accepted ? "positive_result" : "unresolved",
        }),
      },
    });
  };

  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434/v1",
    getOllamaModel: () => "local-test-model",
    logger: silentLogger,
  });
  const result = await service.getCandidates();

  assert.deepEqual(result.candidates.map((item) => item.articleId), ["a1", "a2", "a3"]);
  assert.equal(result.candidates[0]?.imageUrl, "https://cdn.example.com/a1.jpg");
  assert.equal(result.diagnostics.pagesFetched, 2);
  assert.equal(result.diagnostics.articlesFetched, 4);
  assert.equal(calls.filter((url) => url.startsWith("https://newsdata.io")).length, 2);
  assert.equal(calls.filter((url) => url.endsWith("/api/chat")).length, 4);
});

test("HTTPS以外の画像URLは候補に持ち込まない", async () => {
  const fetchMock = async (input: string | URL | Request) => {
    if (String(input).startsWith("https://newsdata.io")) {
      return response({
        status: "success",
        totalResults: 1,
        results: [{ ...article("a1", "明るい発見"), image_url: "http://example.com/news.jpg" }],
      });
    }
    return response({
      message: {
        content: JSON.stringify({
          decision: "accept",
          promotional: false,
          reasonCode: "positive_result",
        }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  const result = await service.getCandidates({ maxPages: 1 });
  assert.equal(result.candidates[0]?.imageUrl, undefined);
});

test("Gemma判定は同時2件までに制限する", async () => {
  let active = 0;
  let maxActive = 0;
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://newsdata.io")) {
      return response({
        status: "success",
        totalResults: 4,
        results: [article("a1", "一"), article("a2", "二"), article("a3", "三"), article("a4", "四")],
      });
    }
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response({
      message: {
        content: JSON.stringify({
          decision: "accept",
          promotional: false,
          reasonCode: "positive_result",
        }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  await service.getCandidates();
  assert.equal(maxActive, 2);
});

test("Gemmaの不正JSONは不採用にする", async () => {
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://newsdata.io")) {
      return response({ status: "success", totalResults: 1, results: [article("a1", "候補")] });
    }
    return response({ message: { content: "not-json" } });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  const result = await service.getCandidates();
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.decisions[0]?.reasonCode, "classifier_error");
});

test("宣伝性があっても分類器が採用した明るい記事は候補に残す", async () => {
  const fetchMock = async (input: string | URL | Request) => {
    if (String(input).startsWith("https://newsdata.io")) {
      return response({
        status: "success",
        totalResults: 1,
        results: [article("event-1", "アニメの新イベント開催決定")],
      });
    }
    return response({
      message: {
        content: JSON.stringify({
          decision: "accept",
          promotional: true,
          reasonCode: "positive_result",
        }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  const result = await service.getCandidates({ maxPages: 1 });
  assert.deepEqual(result.candidates.map((item) => item.articleId), ["event-1"]);
  assert.equal(result.diagnostics.decisions[0]?.promotional, true);
});

test("30分キャッシュを使い、利用済み記事を結果から除く", async () => {
  let now = 1_000;
  let newsCalls = 0;
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://newsdata.io")) {
      newsCalls++;
      return response({
        status: "success",
        totalResults: 3,
        results: [article("a1", "一"), article("a2", "二"), article("a3", "三")],
      });
    }
    return response({
      message: {
        content: JSON.stringify({
          decision: "accept",
          promotional: false,
          reasonCode: "positive_result",
        }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    now: () => now,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  await service.getCandidates();
  const cached = await service.getCandidates({ excludeArticleIds: ["a1"] });
  assert.equal(cached.diagnostics.cacheHit, true);
  assert.deepEqual(cached.candidates.map((item) => item.articleId), ["a2", "a3"]);
  assert.equal(newsCalls, 1);

  now += 30 * 60 * 1000 + 1;
  await service.getCandidates();
  assert.equal(newsCalls, 2);
});

test("APIキーがなければ外部通信せず候補ゼロにする", async () => {
  let calls = 0;
  const service = new PositiveNewsService({
    fetchImpl: (async () => {
      calls++;
      return response({});
    }) as typeof fetch,
    getNewsDataApiKey: () => undefined,
    logger: silentLogger,
  });

  const result = await service.getCandidates();
  assert.equal(calls, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.diagnostics.errors.length, 1);
});

test("同時取得はNewsDataページHTTPを1回に集約する", async () => {
  let newsCalls = 0;
  let gemmaCalls = 0;
  const fetchMock = async (input: string | URL | Request) => {
    if (String(input).startsWith("https://newsdata.io")) {
      newsCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response({ status: "success", totalResults: 1, results: [article("a1", "受賞")] });
    }
    gemmaCalls++;
    return response({ message: { content: JSON.stringify({ decision: "accept", promotional: false, reasonCode: "positive_result" }) } });
  };
  const service = new PositiveNewsService({ fetchImpl: fetchMock as typeof fetch, getNewsDataApiKey: () => "key", getOllamaBaseUrl: () => "http://ollama", logger: silentLogger });
  await Promise.all([service.getCandidates(), service.getCandidates({ excludeArticleIds: ["other"] })]);
  assert.equal(newsCalls, 1);
  assert.equal(gemmaCalls, 1);
});

test("NewsData再取得後も24時間はGemma判定を再利用する", async () => {
  let now = 0, newsCalls = 0, gemmaCalls = 0;
  const fetchMock = async (input: string | URL | Request) => {
    if (String(input).startsWith("https://newsdata.io")) { newsCalls++; return response({ status: "success", results: [article("a1", "受賞")] }); }
    gemmaCalls++; return response({ message: { content: JSON.stringify({ decision: "accept", promotional: false, reasonCode: "positive_result" }) } });
  };
  const service = new PositiveNewsService({ fetchImpl: fetchMock as typeof fetch, now: () => now, getNewsDataApiKey: () => "key", getOllamaBaseUrl: () => "http://ollama", logger: silentLogger });
  await service.getCandidates();
  now += 31 * 60 * 1000;
  await service.getCandidates();
  assert.equal(newsCalls, 2);
  assert.equal(gemmaCalls, 1);
});

test("再起動相当の別サービスでも永続Gemmaキャッシュを利用する", async () => {
  const store = new Map<string, { decision: "accept" | "reject"; reasonCode: "positive_result" }>();
  let gemmaCalls = 0;
  const dependencies = {
    fetchImpl: (async (input: string | URL | Request) => {
      if (String(input).startsWith("https://newsdata.io")) return response({ status: "success", results: [article("a1", "受賞")] });
      gemmaCalls++; return response({ message: { content: JSON.stringify({ decision: "accept", promotional: false, reasonCode: "positive_result" }) } });
    }) as typeof fetch,
    getNewsDataApiKey: () => "key", getOllamaBaseUrl: () => "http://ollama", logger: silentLogger,
    getPersistentScreening: async (key: string) => store.get(key),
    setPersistentScreening: async (key: string, _articleId: string, decision: any) => { store.set(key, { decision: decision.decision, reasonCode: decision.reasonCode }); },
  };
  await new PositiveNewsService(dependencies).getCandidates();
  await new PositiveNewsService(dependencies).getCandidates();
  assert.equal(gemmaCalls, 1);
});

// 思考するモデルは reasoning が num_predict を食い切り、content が空文字のまま
// done_reason=length で返る。format を付けていても防げず、JSON.parse("") に落ちて
// 全件 classifier_error になるため、think は必ず切る。
test("Gemma判定リクエストでは必ず思考を切る", async () => {
  let body: any;
  const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://newsdata.io")) {
      return response({ status: "success", results: [article("a1", "受賞")] });
    }
    body = JSON.parse(String(init?.body));
    return response({
      message: {
        content: JSON.stringify({
          decision: "accept",
          promotional: false,
          reasonCode: "positive_result",
        }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "key",
    getOllamaBaseUrl: () => "http://ollama.test:11434/v1",
    getOllamaModel: () => "local-test-model",
    logger: silentLogger,
  });
  await service.getCandidates();
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
});

test("関心ジャンルを渡すとqを付け、配信元の絞り込みを広げる", async () => {
  const urls: string[] = [];
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://newsdata.io")) {
      urls.push(url);
      return response({ status: "success", totalResults: 1, results: [article("a1", "アニメの受賞")] });
    }
    return response({
      message: {
        content: JSON.stringify({ decision: "accept", promotional: false, reasonCode: "positive_result" }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  const result = await service.getCandidates({ topicQuery: "アニメ OR 声優", maxPages: 1 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.topicQuery, "アニメ OR 声優");
  const parsed = new URL(urls[0]);
  assert.equal(parsed.searchParams.get("q"), "アニメ OR 声優");
  // ジャンルと配信元の両方を絞ると1ページが空になりやすいので medium まで広げる。
  assert.equal(parsed.searchParams.get("prioritydomain"), "medium");
  // ネガティブ記事の除外は従来どおり効かせる。
  assert.equal(parsed.searchParams.get("excludecategory"), "politics,crime");
});

test("ジャンル指定と無指定はページキャッシュを共有しない", async () => {
  // 共有すると、片方の取得結果がもう片方のクレジット節約に化けて、
  // 「ジャンルを指定したのに無指定の記事が返る」ことになる。
  const queries: Array<string | null> = [];
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://newsdata.io")) {
      queries.push(new URL(url).searchParams.get("q"));
      return response({ status: "success", totalResults: 1, results: [article(`a${queries.length}`, "話題")] });
    }
    return response({
      message: {
        content: JSON.stringify({ decision: "accept", promotional: false, reasonCode: "positive_result" }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  const topic = await service.getCandidates({ topicQuery: "アニメ", maxPages: 1 });
  const plain = await service.getCandidates({ maxPages: 1 });
  assert.deepEqual(queries, ["アニメ", null]);
  assert.equal(topic.diagnostics.creditsUsed, 1);
  assert.equal(plain.diagnostics.creditsUsed, 1);
  assert.equal(plain.diagnostics.cacheHit, false);
});

test("ジャンル無指定の取得は従来どおりqを付けない", async () => {
  const urls: string[] = [];
  const fetchMock = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://newsdata.io")) {
      urls.push(url);
      return response({ status: "success", totalResults: 1, results: [article("a1", "話題")] });
    }
    return response({
      message: {
        content: JSON.stringify({ decision: "accept", promotional: false, reasonCode: "positive_result" }),
      },
    });
  };
  const service = new PositiveNewsService({
    fetchImpl: fetchMock as typeof fetch,
    getNewsDataApiKey: () => "test-key",
    getOllamaBaseUrl: () => "http://ollama.test:11434",
    logger: silentLogger,
  });

  const result = await service.getCandidates({ maxPages: 1, topicQuery: "   " });
  const parsed = new URL(urls[0]);
  assert.equal(parsed.searchParams.has("q"), false);
  assert.equal(parsed.searchParams.get("prioritydomain"), "top");
  assert.equal(result.diagnostics.topicQuery, undefined);
});
