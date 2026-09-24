import assert from "node:assert/strict";
import test from "node:test";
import { createLastFmRequester, LastFmRateLimitError } from "../src/api/lastfm/request.js";
import { getLastFmArtistTags, getLastFmTrackInfo } from "../src/api/lastfm/index.js";

const params = (method: string) => new URLSearchParams({ method, api_key: "test-key" });
const ok = () => new Response(JSON.stringify({ message: "ok" }));

function fixture() {
  let time = Date.parse("2026-09-24T00:00:00Z");
  const request = createLastFmRequester({
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  return { request, now: () => time, advance: (ms: number) => { time += ms; } };
}

test("並列の異なるメソッドを1000ms以上離し、同じ問い合わせは1通信にまとめる", async () => {
  const f = fixture();
  const starts: number[] = [];
  let active = 0;
  const fetchImpl: typeof fetch = async () => {
    assert.equal(active++, 0);
    starts.push(f.now());
    await Promise.resolve();
    active--;
    return ok();
  };
  const a = f.request(params("track.getInfo"), fetchImpl);
  const duplicate = f.request(params("track.getInfo"), fetchImpl);
  const b = f.request(params("artist.getInfo"), fetchImpl);
  assert.equal(a, duplicate);
  await Promise.all([a, duplicate, b]);
  assert.equal(starts.length, 2);
  assert.equal(starts[1]! - starts[0]!, 1_000);
  await f.request(params("track.getInfo"), fetchImpl);
  assert.equal(starts.length, 3);
});

for (const retryAfter of ["120", "Thu, 24 Sep 2026 00:02:00 GMT", "invalid", null]) {
  test(`429後はキューと新規通信を停止し、待機期限後に回復する: ${retryAfter}`, async () => {
    const f = fixture();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return calls === 1 ? new Response("rate limited", {
        status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {},
      }) : ok();
    };
    const results = await Promise.allSettled([
      f.request(params("track.getInfo"), fetchImpl),
      f.request(params("artist.getInfo"), fetchImpl),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.ok(result.reason instanceof LastFmRateLimitError);
    }
    assert.equal(calls, 1);
    const cooldown = retryAfter === "invalid" || retryAfter === null ? 60_000 : 120_000;
    f.advance(cooldown - 1);
    await assert.rejects(f.request(params("tag.getTopTracks"), fetchImpl), LastFmRateLimitError);
    assert.equal(calls, 1);
    f.advance(1);
    await f.request(params("tag.getTopTracks"), fetchImpl);
    assert.equal(calls, 2);
  });
}

test("HTTP 200のAPI error 29も全メソッドの通信を止める", async () => {
  const f = fixture();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: 29, message: "Rate limit exceeded" }));
  };
  await assert.rejects(f.request(params("track.search"), fetchImpl), LastFmRateLimitError);
  await assert.rejects(f.request(params("artist.search"), fetchImpl), LastFmRateLimitError);
  assert.equal(calls, 1);
});

test("通常のAPIエラー後はキューが回復し、エラーを成功キャッシュしない", async () => {
  const f = fixture();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => ++calls === 1
    ? new Response(JSON.stringify({ error: 6, message: "Invalid parameters" })) : ok();
  await assert.rejects(f.request(params("track.search"), fetchImpl), /Last.fm API 6/);
  await f.request(params("track.search"), fetchImpl);
  assert.equal(calls, 2);
});

test("公開APIの曲詳細とアーティスト情報も同じクールダウンを共有する", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response(null, { status: 429 }); };
  const options = { apiKey: "test-key", fetchImpl };
  await assert.rejects(getLastFmTrackInfo("title", "artist", options), LastFmRateLimitError);
  await assert.rejects(getLastFmArtistTags("artist", options), LastFmRateLimitError);
  assert.equal(calls, 1);
});
