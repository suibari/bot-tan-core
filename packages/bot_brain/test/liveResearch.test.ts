import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardMatchesContext,
  contextKeyword,
  excerptsAround,
  runLiveResearch,
  sanitizePlannedTerms,
  searchWikipediaExcerpt,
  clipWorkCard,
  wikipediaLanguage,
  type LiveResearchCard,
} from "../src/ai/liveResearch.js";

/**
 * リプライのその場調べ。
 *
 * 例は 2026-11 に Nagi で実際に多かった遊戯王の投稿から。裏で語だけを調べていた頃は
 * 「トリシューラ」がシヴァ神の槍、「ポルターガイスト」が心霊現象のカードになり、
 * 遊戯王の話にそのまま混ざっていた。
 */

const post = "あかん氷水とかいうやついきなりボクのデッキ上から3枚除外してくるしトリシューラも搭載されてて殺意が強すぎるw";
const userinfo = (extra: Record<string, unknown> = {}) => ({
  follower: { did: "did:plc:test", handle: "test.example", displayName: "テスト" },
  posts: [post],
  langStr: "日本語",
  ...extra,
}) as any;

const never = (label: string) => async () => {
  assert.fail(`${label} を呼んではいけない`);
};

test("申告は投稿に実際に出ている語だけを採用する", () => {
  const terms = sanitizePlannedTerms(
    {
      terms: [
        { term: "トリシューラ", context: "遊戯王" },
        // モデルが補った語。投稿には「ラーの翼神竜」は出ていない。
        { term: "ラーの翼神竜", context: "遊戯王" },
        { term: "https://example.com", context: "リンク" },
        { term: "@someone", context: "人" },
        { term: "ト", context: "短すぎる" },
      ],
    },
    post,
  );
  assert.deepEqual(terms, [{ term: "トリシューラ", context: "遊戯王" }]);
});

test("申告の照合は中黒・空白・全角半角の揺れを吸収する", () => {
  const terms = sanitizePlannedTerms(
    { terms: [{ term: "シャイニングネオスウィングマン", context: "遊戯王" }, { term: "ＫＣカップ", context: "遊戯王" }] },
    "シャイニング・ネオス・ウィングマンに負けた。KCカップきつい",
  );
  assert.deepEqual(terms.map((item) => item.term), ["シャイニングネオスウィングマン", "ＫＣカップ"]);
});

test("句読点を含む申告は文なので採用しない", () => {
  const terms = sanitizePlannedTerms(
    { terms: [{ term: "目覚める神秘、神！", context: "メイドインアビス" }, { term: "目覚める神秘", context: "メイドインアビス" }] },
    "メイドインアビス目覚める神秘、神！感動が何回も押し寄せて",
  );
  assert.deepEqual(terms.map((item) => item.term), ["目覚める神秘"]);
});

test("申告は重複を除き最大3つまで", () => {
  const terms = sanitizePlannedTerms(
    { terms: ["氷水", "氷水", "トリシューラ", "デッキ", "除外"].map((term) => ({ term, context: "遊戯王" })) },
    post,
  );
  assert.deepEqual(terms.map((item) => item.term), ["氷水", "トリシューラ", "デッキ"]);
});

test("壊れた申告は空として扱う", () => {
  assert.deepEqual(sanitizePlannedTerms(null, post), []);
  assert.deepEqual(sanitizePlannedTerms({ terms: "トリシューラ" }, post), []);
});

test("ジャンルは最初の区切りまでを使う", () => {
  assert.equal(contextKeyword("遊戯王OCG/デュエルモンスターズ"), "遊戯王OCG");
  assert.equal(contextKeyword("アニメ・漫画（ジョジョ）"), "アニメ");
  assert.equal(contextKeyword(""), "");
});

test("一般的な意味の古いカードは、遊戯王の話には使わない", () => {
  const trident = { term: "トリシューラ", context: null, content: "トリシューラは、ヒンドゥー教の神シヴァが持つ三叉槍です。" };
  assert.equal(cardMatchesContext(trident, "遊戯王"), false);
  const card = { term: "トリシューラ", context: null, content: "《氷結界の龍 トリシューラ》は遊☆戯☆王OCGのシンクロモンスター。" };
  assert.equal(cardMatchesContext(card, "遊戯王"), true, "遊☆戯☆王 と 遊戯王 を同じものとして扱う");
  assert.equal(cardMatchesContext(card, "遊戯王OCG"), true);
  assert.equal(cardMatchesContext({ ...trident, context: "遊戯王" }, "遊戯王"), true, "そのジャンルで調べたカードは使う");
  assert.equal(cardMatchesContext(trident, ""), true, "ジャンルが分からなければ使う");
});

test("記事の本文から語の周辺だけを切り出す", () => {
  const article = `${"前置き。".repeat(100)}主人公のエースは《氷結界の龍 トリシューラ》で、相手の手札・墓地・フィールドを除外する。${"後書き。".repeat(100)}`;
  const excerpts = excerptsAround(article, "トリシューラ");
  assert.equal(excerpts.length, 1);
  assert.match(excerpts[0], /氷結界の龍 トリシューラ/);
  assert.ok(excerpts[0].length < 600, "記事全体は渡さない");
  assert.deepEqual(excerptsAround(article, "ニビル"), [], "語が出てこない記事は使わない");
  assert.equal(excerptsAround("BF－アーマード・ウィングを召喚", "BFアーマードウィング").length, 1, "区切り記号の有無を吸収する");
});

test("記憶にジャンルの合うカードがあれば Wikipedia を引かない", async () => {
  const result = await runLiveResearch(userinfo(), {
    plan: async () => [{ term: "トリシューラ", context: "遊戯王" }],
    findCards: async () => [{ term: "トリシューラ", context: "遊戯王", content: "トリシューラ（遊戯王）\n氷結界の龍。" }],
    searchWikipedia: never("searchWikipedia"),
    saveCard: never("saveCard"),
  });
  assert.deepEqual(result.cards.map((card) => card.source), ["memory"]);
  assert.match(result.researchMemory ?? "", /氷結界の龍/);
});

test("記憶に無ければ Wikipedia を「語＋ジャンル」で引き、公開の文脈なら保存する", async () => {
  const searched: string[][] = [];
  const saved: LiveResearchCard[] = [];
  const result = await runLiveResearch(userinfo({ persistLiveResearch: true }), {
    plan: async () => [{ term: "トリシューラ", context: "遊戯王" }],
    // 一般的な意味の古いカードしか無い。ジャンルが合わないので使わない。
    findCards: async () => [{ term: "トリシューラ", context: null, content: "シヴァ神の三叉槍" }],
    searchWikipedia: async (term, context) => {
      searched.push([term, context]);
      return { content: "Wikipedia「遊☆戯☆王5D's」より: 《氷結界の龍 トリシューラ》", titles: ["遊☆戯☆王5D's"] };
    },
    saveCard: async (card) => {
      saved.push(card);
    },
  });
  assert.deepEqual(searched, [["トリシューラ", "遊戯王"]]);
  assert.equal(saved.length, 1);
  assert.match(result.researchMemory ?? "", /^トリシューラ（遊戯王）\nWikipedia「遊☆戯☆王5D's」より/);
  assert.doesNotMatch(result.researchMemory ?? "", /シヴァ/);
});

test("こっそりの文脈（保存の許可なし）では調べても保存しない", async () => {
  const result = await runLiveResearch(userinfo(), {
    plan: async () => [{ term: "トリシューラ", context: "遊戯王" }],
    findCards: async () => [],
    searchWikipedia: async () => ({ content: "氷結界の龍 トリシューラ", titles: ["遊☆戯☆王5D's"] }),
    saveCard: never("saveCard"),
  });
  assert.equal(result.cards.length, 1, "返信の材料には使う");
});

test("既存の材料のうち、申告された語でジャンルが合わないカードを外す", async () => {
  const result = await runLiveResearch(
    userinfo({
      researchMemory: "使われない",
      researchCards: [
        { term: "トリシューラ", content: "トリシューラ\nヒンドゥー教の神シヴァの三叉槍。" },
        { term: "氷水", content: "氷水\n氷水浴とは、氷水に体を浸すこと。" },
        { term: "デッキ", content: "デッキ\nカードの束。" },
      ],
    }),
    {
      plan: async () => [{ term: "トリシューラ", context: "遊戯王" }, { term: "氷水", context: "遊戯王" }],
      findCards: async () => [],
      searchWikipedia: async () => null,
    },
  );
  assert.deepEqual(result.droppedTerms, ["トリシューラ", "氷水"]);
  assert.equal(result.researchMemory, "デッキ\nカードの束。", "申告されていない語のカードは残す");
});

test("申告が無ければ、渡された材料をそのまま使う", async () => {
  const result = await runLiveResearch(userinfo({ researchMemory: "既存の材料" }), {
    plan: async () => [],
    findCards: never("findCards"),
    searchWikipedia: never("searchWikipedia"),
  });
  assert.equal(result.researchMemory, "既存の材料");
  assert.deepEqual(result.terms, []);
});

test("申告に失敗しても throw せず、材料なしで返信へ進む", async () => {
  const result = await runLiveResearch(userinfo({ researchMemory: "既存の材料" }), {
    plan: async () => {
      throw new Error("Ollama HTTP 500");
    },
  });
  assert.equal(result.researchMemory, "既存の材料");
  assert.equal(result.timedOut, false);
});

test("締め切りを過ぎたら、そこまでの材料で返信へ進む", async () => {
  const saved = process.env.AI_LIVE_RESEARCH_DEADLINE_MS;
  process.env.AI_LIVE_RESEARCH_DEADLINE_MS = "50";
  try {
    const result = await runLiveResearch(userinfo(), {
      plan: async () => [{ term: "トリシューラ", context: "遊戯王" }, { term: "氷水", context: "遊戯王" }],
      findCards: async () => [],
      searchWikipedia: (term, _context, signal) => {
        if (term === "トリシューラ") return Promise.resolve({ content: "氷結界の龍 トリシューラ", titles: ["x"] });
        // 2語目は締め切りまで返ってこない。中断の合図で reject する。
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
    });
    assert.equal(result.timedOut, true);
    assert.deepEqual(result.cards.map((card) => card.term), ["トリシューラ"], "取れた分は使う");
    assert.ok(result.elapsedMs < 2_000);
  } finally {
    if (saved === undefined) delete process.env.AI_LIVE_RESEARCH_DEADLINE_MS;
    else process.env.AI_LIVE_RESEARCH_DEADLINE_MS = saved;
  }
});

test("引用している投稿の本文も申告の材料にする", async () => {
  let planned = "";
  await runLiveResearch(userinfo({ posts: ["これ強すぎ"], embed: { text_embed: "トリシューラ召喚！" } }), {
    plan: async (text) => {
      planned = text;
      return [];
    },
  });
  assert.match(planned, /これ強すぎ/);
  assert.match(planned, /トリシューラ召喚/);
});

/** ゲートウェイの /wikipedia/ja を差し替える。検索と本文取得を URL のパラメータで振り分ける。 */
async function withWikipedia(
  routes: { search: { title: string; snippet: string }[]; pages?: Record<string, string> },
  body: (requests: URL[]) => Promise<void>,
) {
  const savedFetch = globalThis.fetch;
  const savedBase = process.env.SEARXNG_BASE_URL;
  process.env.SEARXNG_BASE_URL = "http://gateway.test";
  const requests: URL[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    requests.push(url);
    const json = url.searchParams.get("list") === "search"
      ? { query: { search: routes.search } }
      : { query: { pages: { 1: { extract: routes.pages?.[url.searchParams.get("titles") ?? ""] ?? "" } } } };
    return new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await body(requests);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedBase === undefined) delete process.env.SEARXNG_BASE_URL;
    else process.env.SEARXNG_BASE_URL = savedBase;
  }
}

test("抜粋に語とジャンルがあれば、本文を取らずに1回で済ませる", async () => {
  // ゲートウェイは1リクエストごとに1秒以上空けるので、回数がそのまま待ち時間になる。
  await withWikipedia(
    {
      search: [{
        title: "遊☆戯☆王デュエルモンスターズ",
        snippet: "<span class=\"searchmatch\">ラーの翼神竜</span>（太陽の神） 3体の神の中で頂点に君臨するカード。",
      }],
    },
    async (requests) => {
      const found = await searchWikipediaExcerpt("ラーの翼神竜", "遊戯王", new AbortController().signal);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].searchParams.get("srsearch"), "ラーの翼神竜 遊戯王", "語とジャンルで検索する");
      assert.match(found?.content ?? "", /3体の神の中で頂点に君臨するカード/);
      assert.doesNotMatch(found?.content ?? "", /searchmatch/, "HTML のハイライトは取り除く");
    },
  );
});

test("ジャンルの語が出てこない記事は、語が出ていても使わない", async () => {
  // 実際に「氷水 遊戯王」で『はねるのトびら』の「氷水プールに落下する」が取れたことがある。
  await withWikipedia(
    {
      search: [{ title: "はねるのトびらの企画", snippet: "敗者は<span>氷水</span>プールに落下する。" }],
      pages: { "はねるのトびらの企画": "にらめっこして笑わせた方が勝者で、敗者は氷水プールに落下する。" },
    },
    async () => {
      const found = await searchWikipediaExcerpt("氷水", "遊戯王", new AbortController().signal);
      assert.equal(found, null);
    },
  );
});

test("抜粋に語が無ければ本文から語の周辺を取る（遊☆戯☆王 も 遊戯王 として扱う）", async () => {
  await withWikipedia(
    {
      search: [{ title: "遊☆戯☆王5D's", snippet: "テレビ東京系で放送されたアニメ。" }],
      pages: { "遊☆戯☆王5D's": `${"前置き。".repeat(50)}主人公のエースの1体は《氷結界の龍 トリシューラ》。${"後書き。".repeat(50)}` },
    },
    async (requests) => {
      const found = await searchWikipediaExcerpt("トリシューラ", "遊戯王", new AbortController().signal);
      assert.equal(requests.length, 2);
      assert.match(found?.content ?? "", /^Wikipedia「遊☆戯☆王5D's」より: .*氷結界の龍 トリシューラ/);
      assert.deepEqual(found?.titles, ["遊☆戯☆王5D's"]);
    },
  );
});

test("Wikipedia を引く語は最大2つまで（記憶との照合は全部の語で行う）", async () => {
  const searched: string[] = [];
  const result = await runLiveResearch(userinfo(), {
    plan: async () => ["氷水", "トリシューラ", "デッキ"].map((term) => ({ term, context: "遊戯王" })),
    findCards: async () => [],
    searchWikipedia: async (term) => {
      searched.push(term);
      return null;
    },
  });
  assert.deepEqual(searched, ["氷水", "トリシューラ"]);
  assert.equal(result.terms.length, 3);
});

test("作品そのもののカードを、語のカードの後ろに1枚だけ足す", async () => {
  // 投稿に出ていない同じ作品の要素（別のシリーズ・キャラ）を返信で出すための引き出し。
  let looked: string[] = [];
  const result = await runLiveResearch(userinfo(), {
    plan: async () => [{ term: "トリシューラ", context: "遊戯王OCG/デュエルモンスターズ" }, { term: "氷水", context: "遊戯王" }],
    findCards: async (terms) => {
      looked = terms;
      return [
        { term: "トリシューラ", context: "遊戯王", content: "トリシューラ（遊戯王）\n氷結界の龍。" },
        { term: "遊戯王OCG", context: null, content: "遊戯王OCG\nコナミのトレーディングカードゲーム。" },
        { term: "遊戯王", context: null, content: "遊戯王\n高橋和希の漫画。5D's、ZEXAL などのシリーズがある。" },
      ];
    },
    searchWikipedia: async () => null,
  });
  assert.deepEqual(looked, ["トリシューラ", "氷水", "遊戯王OCG", "遊戯王"], "語とジャンルを1回の問い合わせで引く");
  assert.deepEqual(result.cards.map((card) => [card.term, card.kind ?? "term"]), [
    ["トリシューラ", "term"],
    ["遊戯王OCG", "work"],
  ]);
  assert.match(result.researchMemory ?? "", /氷結界の龍[\s\S]*コナミのトレーディングカードゲーム/);
});

test("作品のカードが記憶に無ければ何も足さない", async () => {
  const result = await runLiveResearch(userinfo(), {
    plan: async () => [{ term: "トリシューラ", context: "遊戯王" }],
    findCards: async () => [],
    searchWikipedia: async () => null,
  });
  assert.deepEqual(result.cards, []);
});

test("作品のカードは冒頭の概要に絞り、文の途中で切らない", () => {
  // 長い作品のカードは名前が多く並び、語と語の関係を取り違える元になる。
  const long = "遊戯王\n" + "高橋和希の漫画で、カードゲームを題材にしている。".repeat(40);
  const clipped = clipWorkCard(long);
  assert.ok(clipped.length <= 600);
  assert.ok(clipped.endsWith("。"));
  assert.equal(clipWorkCard("短いカード。"), "短いカード。");
});

test("投稿の言語に合わせて Wikipedia の言語版を選ぶ（分からなければ日本語版）", () => {
  // デプロイ直後、英語の投稿の「energy drink」を日本語版で引いていた。
  assert.equal(wikipediaLanguage("English"), "en");
  assert.equal(wikipediaLanguage("日本語"), "ja");
  assert.equal(wikipediaLanguage("Korean"), "ko");
  assert.equal(wikipediaLanguage(undefined), "ja");
});

test("英語の投稿は英語版の Wikipedia を引き、保存にも言語を渡す", async () => {
  const languages: string[] = [];
  const saved: string[] = [];
  await runLiveResearch(
    userinfo({ posts: ["I chugged an energy drink before the raid"], langStr: "English", persistLiveResearch: true }),
    {
      plan: async () => [{ term: "energy drink", context: "" }],
      findCards: async () => [],
      searchWikipedia: async (_term, _context, _signal, language) => {
        languages.push(language);
        return { content: "An energy drink is a type of drink containing stimulant compounds.", titles: ["Energy drink"] };
      },
      saveCard: async (_card, _titles, language) => {
        saved.push(language);
      },
    },
  );
  assert.deepEqual(languages, ["en"]);
  assert.deepEqual(saved, ["en"]);
});

test("英語版のゲートウェイへは /wikipedia/en で問い合わせる", async () => {
  await withWikipedia(
    { search: [{ title: "Energy drink", snippet: "An <span>energy drink</span> is a type of drink." }] },
    async (requests) => {
      const found = await searchWikipediaExcerpt("energy drink", "", new AbortController().signal, "en");
      assert.equal(requests[0].pathname, "/wikipedia/en");
      assert.match(found?.content ?? "", /energy drink is a type of drink/);
    },
  );
});
