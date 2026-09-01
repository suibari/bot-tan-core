import assert from "node:assert/strict";
import test from "node:test";
import { fetchReadableText } from "../src/readable.js";
import { LinkMetadataError } from "../src/errors.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** ホスト名を書くと assertPublicHost が DNS を引きに行くので、テストは IP 直書きで固定する。 */
const PUBLIC = "https://93.184.216.34/article";

const html = (body: string, head = "") =>
  new Response(`<html><head>${head}</head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

test("extracts plain text and title from an HTML page", async () => {
  globalThis.fetch = async () =>
    html(
      "<p>2026年秋アニメの話題作</p><p>放送は10月から</p>",
      "<title>秋アニメ一覧</title>",
    );

  const value = await fetchReadableText(PUBLIC);
  assert.equal(value.title, "秋アニメ一覧");
  assert.match(value.text, /2026年秋アニメの話題作/);
  assert.match(value.text, /放送は10月から/);
  assert.doesNotMatch(value.text, /</, "タグが残っていない");
});

test("drops script and style contents so they cannot eat the length budget", async () => {
  globalThis.fetch = async () =>
    html(
      "<script>var secret='SHOULD_NOT_APPEAR';</script>" +
        "<style>.a{color:red}</style>" +
        "<p>本文だけ残る</p>",
    );

  const value = await fetchReadableText(PUBLIC);
  assert.doesNotMatch(value.text, /SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(value.text, /color:red/);
  assert.match(value.text, /本文だけ残る/);
});

test("prefers the article region over navigation boilerplate", async () => {
  // ナビの定型文が長いページ。本文が上限に押し出されると固有名詞が落ちる。
  const nav = `<nav>${"ホーム ログイン お問い合わせ ".repeat(40)}</nav>`;
  globalThis.fetch = async () =>
    html(`${nav}<article><p>${"見つけたい固有名詞。".repeat(30)}</p></article>`);

  const value = await fetchReadableText(PUBLIC);
  assert.match(value.text, /見つけたい固有名詞/);
  assert.doesNotMatch(value.text, /お問い合わせ/);
});

test("truncates the body to the requested limit", async () => {
  globalThis.fetch = async () => html(`<p>${"あ".repeat(5_000)}</p>`);

  const value = await fetchReadableText(PUBLIC, 100);
  assert.equal(value.text.length, 100);
});

/** Shift_JIS の「テスト」。日本語サイトにはまだこの文字コードが残っている。 */
const SJIS_TEST = Uint8Array.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);

const sjisPage = (contentType: string, metaTag = "") => {
  const head = new TextEncoder().encode(
    `<html><head>${metaTag}<title>`,
  );
  const mid = new TextEncoder().encode("</title></head><body><p>");
  const tail = new TextEncoder().encode("</p></body></html>");
  const body = new Uint8Array(
    head.length + SJIS_TEST.length + mid.length + SJIS_TEST.length + tail.length,
  );
  let at = 0;
  for (const part of [head, SJIS_TEST, mid, SJIS_TEST, tail]) {
    body.set(part, at);
    at += part.length;
  }
  return new Response(body, { headers: { "content-type": contentType } });
};

test("decodes Shift_JIS declared in the content-type header", async () => {
  // 実測: オリコンの記事が UTF-8 決め打ちで「�y�ăh���}2026」になった。
  globalThis.fetch = async () => sjisPage("text/html; charset=Shift_JIS");

  const value = await fetchReadableText(PUBLIC);
  assert.equal(value.title, "テスト");
  assert.match(value.text, /テスト/);
  assert.doesNotMatch(value.text, /�/, "置換文字が残っていない");
});

test("falls back to the meta charset when the header omits it", async () => {
  globalThis.fetch = async () =>
    sjisPage("text/html", '<meta charset="shift_jis">');

  const value = await fetchReadableText(PUBLIC);
  assert.equal(value.title, "テスト");
  assert.doesNotMatch(value.text, /�/);
});

test("keeps decoding as UTF-8 when the declared charset is unknown", async () => {
  globalThis.fetch = async () =>
    new Response(
      new TextEncoder().encode("<html><head><title>日本語</title></head><body><p>本文</p></body></html>"),
      { headers: { "content-type": "text/html; charset=x-not-a-charset" } },
    );

  const value = await fetchReadableText(PUBLIC);
  assert.equal(value.title, "日本語");
  assert.match(value.text, /本文/);
});

test("rejects a non-HTML response instead of returning binary noise", async () => {
  globalThis.fetch = async () =>
    new Response("%PDF-1.7 ...", { headers: { "content-type": "application/pdf" } });

  await assert.rejects(fetchReadableText(PUBLIC), (error: unknown) => {
    assert.ok(error instanceof LinkMetadataError);
    assert.equal(error.status, 415);
    return true;
  });
});

test("rejects a page whose body extracts to nothing", async () => {
  globalThis.fetch = async () => html("<script>var a=1;</script>");

  await assert.rejects(fetchReadableText(PUBLIC), (error: unknown) => {
    assert.ok(error instanceof LinkMetadataError);
    assert.equal(error.status, 422);
    return true;
  });
});

test("enforces the size cap from the content-length header", async () => {
  globalThis.fetch = async () =>
    new Response("<html><body><p>x</p></body></html>", {
      headers: {
        "content-type": "text/html",
        "content-length": String(50_000_000),
      },
    });

  await assert.rejects(fetchReadableText(PUBLIC), (error: unknown) => {
    assert.ok(error instanceof LinkMetadataError);
    assert.equal(error.status, 413);
    return true;
  });
});

/**
 * ここから下が今回の変更で新たに増えたリスク。
 *
 * Gemini の URL Context は Google 側がページを取得していたが、自前化すると
 * **利用者が投稿した任意の URL を自宅サーバが叩く**。同一 LAN の Ollama(11434) や
 * Postgres へ向けた SSRF を通してはいけない。
 */
test("refuses loopback targets such as the local Ollama port", async () => {
  globalThis.fetch = async () => {
    assert.fail("SSRF 検証より先に fetch してはいけない");
  };

  await assert.rejects(fetchReadableText("http://127.0.0.1:11434/api/tags"), (error: unknown) => {
    assert.ok(error instanceof LinkMetadataError);
    assert.equal(error.status, 400);
    return true;
  });
});

test("refuses RFC1918 targets such as the LAN SearXNG host", async () => {
  globalThis.fetch = async () => {
    assert.fail("SSRF 検証より先に fetch してはいけない");
  };

  await assert.rejects(fetchReadableText("http://192.168.1.220:8080/search"), (error: unknown) => {
    assert.ok(error instanceof LinkMetadataError);
    assert.equal(error.status, 400);
    return true;
  });
});

test("re-validates the redirect target so a public URL cannot bounce into the LAN", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
  };

  await assert.rejects(fetchReadableText(PUBLIC), (error: unknown) => {
    assert.ok(error instanceof LinkMetadataError);
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(calls, 1, "リダイレクト先は取得せずに拒否する");
});

test("refuses non-HTTP schemes", async () => {
  globalThis.fetch = async () => {
    assert.fail("スキーム検証より先に fetch してはいけない");
  };

  await assert.rejects(fetchReadableText("file:///etc/passwd"), (error: unknown) => {
    assert.ok(error instanceof LinkMetadataError);
    assert.equal(error.status, 400);
    return true;
  });
});
