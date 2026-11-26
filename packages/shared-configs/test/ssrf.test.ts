import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { Socket } from "node:net";
import test from "node:test";
import tls, { type ConnectionOptions, type TLSSocket } from "node:tls";
import { fetchPublicUrl, PublicUrlError, safeFetch } from "../src/util/ssrf.js";

test("safeFetch は signal 未指定でも既定のタイムアウトを付ける", async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal;
    return new Response("ok");
  };

  try {
    const response = await safeFetch("https://93.184.216.34/image.png");
    assert.equal(await response.text(), "ok");
    assert.ok(receivedSignal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safeFetch は呼び出し側が指定した signal を置き換えない", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal;
    return new Response("ok");
  };

  try {
    await safeFetch("https://93.184.216.34/image.png", {
      signal: controller.signal,
    });
    assert.equal(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("検証した DNS 応答を接続に渡し、TLS のホスト名を維持する", async (t) => {
  const addresses = [
    { address: "192.0.2.10", family: 4 },
    { address: "2001:db8::10", family: 6 },
  ];
  const resolution = t.mock.method(dns, "lookup", async () => addresses);
  const connection = t.mock.method(tls, "connect", (options: ConnectionOptions) => {
    assert.equal(options.host, "pds.example");
    assert.equal(options.servername, "pds.example");
    assert.ok(options.lookup);
    options.lookup("pds.example", { all: true }, (error, candidates) => {
      assert.ifError(error);
      assert.deepEqual(candidates, addresses);
    });
    const socket = new Socket();
    queueMicrotask(() => socket.destroy(new Error("fixture stops before connecting")));
    return socket as TLSSocket;
  });

  await assert.rejects(
    safeFetch("https://pds.example/blob"),
    (error: Error) =>
      error.cause instanceof Error && error.cause.message === "fixture stops before connecting",
  );
  assert.equal(resolution.mock.callCount(), 1);
  assert.equal(connection.mock.callCount(), 1);
});

test("相対転送で最終 URL と本文を返し、各ホップに専用の接続を渡す", async (t) => {
  const dispatchers: unknown[] = [];
  const resolver = t.mock.method(dns, "lookup", async () => [{ address: "192.0.2.10", family: 4 }]);
  const transport = t.mock.method(globalThis, "fetch", async (url: URL, init) => {
    assert.equal(init.redirect, "manual");
    assert.ok(init.dispatcher);
    dispatchers.push(init.dispatcher);
    if (url.pathname === "/blob")
      return new Response(null, { status: 302, headers: { location: "/file" } });
    return new Response("image");
  });

  const { response, url } = await fetchPublicUrl("https://pds.example/blob");
  assert.equal(url.href, "https://pds.example/file");
  assert.equal(await response.text(), "image");
  assert.equal(transport.mock.callCount(), 2);
  assert.equal(resolver.mock.callCount(), 2);
  assert.notEqual(dispatchers[0], dispatchers[1]);
});

test("公開アドレスを確認できない転送先へ接続しない", async (t) => {
  const resolver = t.mock.method(dns, "lookup", async (host: string) =>
    host === "pds.example" ? [{ address: "192.0.2.10", family: 4 }] : [],
  );
  const transport = t.mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 302, headers: { location: "https://unresolved.example/file" } }),
  );

  await assert.rejects(safeFetch("https://pds.example/blob"), PublicUrlError);
  assert.equal(resolver.mock.callCount(), 2);
  assert.equal(transport.mock.callCount(), 1);
});

test("転送が上限に達すると接続を打ち切る", async (t) => {
  const transport = t.mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 302, headers: { location: "/next" } }),
  );
  await assert.rejects(safeFetch("https://192.0.2.10/blob"), /Too many redirects/);
  assert.equal(transport.mock.callCount(), 5);
});
