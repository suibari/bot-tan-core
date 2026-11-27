import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test from "node:test";
import type { Request, Response as ExpressResponse } from "express";
import { getBlob } from "../src/routes/blob.js";

test("blob route streams an image from a validated PDS redirect", async (t) => {
  const did = "did:web:pds.example%3A8443";
  t.mock.method(dns, "lookup", async () => [{ address: "192.0.2.10", family: 4 }]);
  const visited: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    visited.push(url.href);
    switch (url.pathname) {
      case "/.well-known/did.json":
        return Response.json({
          id: did,
          service: [{
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: "https://pds.example:8443",
          }],
        });
      case "/xrpc/com.atproto.sync.getBlob":
        assert.equal(url.searchParams.get("did"), did);
        assert.equal(url.searchParams.get("cid"), "bafk");
        return new Response(null, { status: 302, headers: { location: "https://media.example/blob.png" } });
      case "/blob.png":
        return new Response("image bytes", { headers: { "content-type": "image/png" } });
      default:
        throw new Error("Unexpected fixture URL");
    }
  });

  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    const req = { params: { did, cid: "bafk" } } as unknown as Request;
    const res = {
      set: (values: Record<string, string>) => Object.assign(headers, values),
      write: (chunk: Buffer) => chunks.push(chunk),
      end: () => resolve(),
    } as unknown as ExpressResponse;
    void getBlob(req, res, reject);
  });
  assert.equal(headers["Content-Type"], "image/png");
  assert.equal(Buffer.concat(chunks).toString(), "image bytes");
  assert.equal(visited[0], "https://pds.example:8443/.well-known/did.json");
  assert.equal(visited[2], "https://media.example/blob.png");
  assert.equal(visited.length, 3);
});
