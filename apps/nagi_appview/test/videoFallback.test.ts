import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createVideoFallback,
  runFfmpeg,
  hlsArgs,
  thumbnailArgs,
  VideoUnavailableError,
} from "../src/services/videoFallback.js";

const DID = "did:plc:author";
const CID = "bafkreivideo";
const UPSTREAM = `https://video.bsky.app/watch/did%3Aplc%3Aauthor/${CID}`;
const PDS_BLOB = `https://pds.example/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aauthor&cid=${CID}`;

type Setup = {
  upstreamStatus?: number;
  upstreamFiles?: Record<string, { status?: number; body: string }>;
  blob?: { status?: number; type?: string; body?: Uint8Array | ReadableStream<Uint8Array> };
  postExists?: boolean;
  runFfmpeg?: (args: string[], cwd: string) => Promise<void>;
};

/** ffmpeg の代わりに、出力ファイルの名前だけ合わせた空ファイルを作る。 */
async function fakeFfmpeg(args: string[], cwd: string) {
  const { writeFile } = await import("node:fs/promises");
  const output = args.at(-1)!;
  if (output === "playlist.m3u8") {
    await writeFile(join(cwd, "init.mp4"), "init");
    await writeFile(join(cwd, "seg000.m4s"), "seg");
    await writeFile(join(cwd, output), "#EXTM3U\n");
  } else await writeFile(join(cwd, output), "jpeg");
}

async function setup(options: Setup = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), "nagi-video-test-"));
  const requests: string[] = [];
  let ffmpegRuns = 0;
  const fallback = createVideoFallback({
    cacheDir,
    postExists: async () => options.postExists ?? true,
    resolvePdsUrl: async () => new URL("https://pds.example"),
    fetch: (async (input: string | URL) => {
      const url = input.toString();
      requests.push(url);
      if (url.startsWith(UPSTREAM)) {
        const file = url.slice(UPSTREAM.length + 1);
        const entry = options.upstreamFiles?.[file];
        return new Response(entry?.body ?? (file === "playlist.m3u8"
          ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n360p/video.m3u8?session_id=test\n"
          : file.startsWith("360p/video.m3u8")
            ? '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg000.m4s\n'
            : "segment"), { status: entry?.status ?? options.upstreamStatus ?? 404 });
      }
      if (url === PDS_BLOB) {
        const blob = options.blob ?? {};
        return new Response(blob.body ?? new Uint8Array([1, 2, 3]), {
          status: blob.status ?? 200,
          headers: { "content-type": blob.type ?? "video/mp4" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch,
    runFfmpeg: async (args, cwd) => {
      ffmpegRuns++;
      await (options.runFfmpeg ?? fakeFfmpeg)(args, cwd);
    },
  });
  return {
    cacheDir,
    fallback,
    requests,
    ffmpegRuns: () => ffmpegRuns,
    [Symbol.asyncDispose]: () => rm(cacheDir, { recursive: true, force: true }),
  };
}

test("video.bsky.app に残っている動画はそちらへ回し、PDS には取りに行かない", async () => {
  await using env = await setup({ upstreamStatus: 200 });
  assert.deepEqual(await env.fallback.resolve(DID, CID, "playlist.m3u8"), {
    kind: "upstream",
    url: `${UPSTREAM}/playlist.m3u8`,
  });
  assert.deepEqual(await env.fallback.resolve(DID, CID, "thumbnail.jpg"), {
    kind: "upstream",
    url: `${UPSTREAM}/thumbnail.jpg`,
  });
  assert.equal(env.requests.length, 4, "有ると分かった結果はしばらく覚えておく");
  assert.equal(env.ffmpegRuns(), 0);
});

test("親だけ200でも、子・init・動画が404ならPDSへ切り替える", async () => {
  for (const file of ["360p/video.m3u8?session_id=test", "360p/init.mp4", "360p/seg000.m4s"]) {
    await using env = await setup({
      upstreamStatus: 200,
      upstreamFiles: { [file]: { status: 404, body: "video not found" } },
    });
    assert.equal((await env.fallback.resolve(DID, CID, "playlist.m3u8")).kind, "local", file);
    assert.ok(env.requests.includes(PDS_BLOB));
  }
});

test("一部の画質だけ消えていてもPDSへ切り替える", async () => {
  await using env = await setup({
    upstreamStatus: 200,
    upstreamFiles: {
      "playlist.m3u8": { body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n360p/video.m3u8?session_id=test\n#EXT-X-STREAM-INF:BANDWIDTH=2000\n720p/video.m3u8\n" },
      "720p/video.m3u8": { status: 404, body: "video not found" },
    },
  });
  assert.equal((await env.fallback.resolve(DID, CID, "playlist.m3u8")).kind, "local");
});

test("空の一覧や外部ホストへの参照は転送せずPDSへ切り替える", async () => {
  for (const body of ["#EXTM3U", "not a playlist", "#EXTM3U\nhttps://internal.example/secret"]) {
    await using env = await setup({ upstreamStatus: 200, upstreamFiles: { "playlist.m3u8": { body } } });
    assert.equal((await env.fallback.resolve(DID, CID, "playlist.m3u8")).kind, "local");
    assert.ok(env.requests.every((url) => !url.includes("internal.example")));
  }
});

test("video.bsky.app から消えた動画は、PDS の mp4 から HLS とサムネイルを作って返す", async () => {
  await using env = await setup({ upstreamStatus: 404 });
  const playlist = await env.fallback.resolve(DID, CID, "playlist.m3u8");
  assert.equal(playlist.kind, "local");
  assert.equal(await readFile((playlist as { path: string }).path, "utf8"), "#EXTM3U\n");
  assert.equal(env.ffmpegRuns(), 2);

  const dir = join(env.cacheDir, encodeURIComponent(DID), CID);
  assert.deepEqual((await readdir(dir)).sort(), [
    "init.mp4",
    "playlist.m3u8",
    "seg000.m4s",
    "thumbnail.jpg",
  ], "元の mp4 は残さない");

  const requestsBefore = env.requests.length;
  assert.equal((await env.fallback.resolve(DID, CID, "thumbnail.jpg")).kind, "local");
  assert.equal((await env.fallback.resolve(DID, CID, "seg000.m4s")).kind, "local");
  assert.equal(env.requests.length, requestsBefore, "手元にあれば video.bsky.app を見に行かない");
  assert.equal(env.ffmpegRuns(), 2);
});

test("PDS の動画は300MB まで取得でき、1バイトでも超えたら処理せず片付ける", async () => {
  for (const size of [100_000_001, 300_000_000, 300_000_001]) {
    let remaining = size;
    const chunk = new Uint8Array(1_000_000);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) return controller.close();
        const length = Math.min(remaining, chunk.length);
        controller.enqueue(chunk.subarray(0, length));
        remaining -= length;
      },
    });
    await using env = await setup({ blob: { body } });
    if (size <= 300_000_000) {
      assert.equal((await env.fallback.resolve(DID, CID, "playlist.m3u8")).kind, "local");
      assert.equal(env.ffmpegRuns(), 2);
    } else {
      await assert.rejects(
        env.fallback.resolve(DID, CID, "playlist.m3u8"),
        (error) => error instanceof VideoUnavailableError && error.status === 404,
      );
      assert.equal(env.ffmpegRuns(), 0);
      assert.deepEqual(await readdir(join(env.cacheDir, encodeURIComponent(DID))), []);
    }
  }
});

test("同時に来たリクエストでも、作るのは1回だけ", async () => {
  await using env = await setup();
  await Promise.all([
    env.fallback.resolve(DID, CID, "thumbnail.jpg"),
    env.fallback.resolve(DID, CID, "thumbnail.jpg"),
    env.fallback.resolve(DID, CID, "playlist.m3u8"),
  ]);
  assert.equal(env.ffmpegRuns(), 2);
  assert.equal(env.requests.filter((url) => url === PDS_BLOB).length, 1);
});

test("Nagi の投稿が参照していない動画は作らない", async () => {
  await using env = await setup({ postExists: false });
  await assert.rejects(
    env.fallback.resolve(DID, CID, "playlist.m3u8"),
    (error) => error instanceof VideoUnavailableError && error.status === 404,
  );
  assert.ok(!env.requests.includes(PDS_BLOB));
});

test("mp4 でない blob・決まった名前以外のファイルは返さない", async () => {
  await using env = await setup({ blob: { type: "text/html" } });
  await assert.rejects(env.fallback.resolve(DID, CID, "playlist.m3u8"), VideoUnavailableError);
  await assert.rejects(env.fallback.resolve(DID, CID, "../secret"), VideoUnavailableError);
  await assert.rejects(env.fallback.resolve(DID, CID, "source.mp4"), VideoUnavailableError);
  assert.equal(env.ffmpegRuns(), 0);
});

test("変換に失敗したら作業ディレクトリを残さず、次のリクエストでやり直す", async () => {
  let fail = true;
  await using env = await setup({
    runFfmpeg: async (args, cwd) => {
      if (fail) throw new Error("ffmpeg failed");
      await fakeFfmpeg(args, cwd);
    },
  });
  await assert.rejects(env.fallback.resolve(DID, CID, "playlist.m3u8"), /ffmpeg failed/);
  assert.deepEqual(await readdir(join(env.cacheDir, encodeURIComponent(DID))), []);
  fail = false;
  assert.equal((await env.fallback.resolve(DID, CID, "playlist.m3u8")).kind, "local");
});

test("ffmpeg は PDS の mp4 1本だけを読む（HLS や concat の参照で他を読ませない）", () => {
  for (const args of [hlsArgs("/cache/source.mp4"), thumbnailArgs("/cache/source.mp4")]) {
    assert.deepEqual(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-protocol_whitelist") + 2), [
      "-protocol_whitelist",
      "file",
    ]);
    assert.equal(args[args.indexOf("-i") + 1], "/cache/source.mp4");
  }
  assert.deepEqual(hlsArgs("x").slice(hlsArgs("x").indexOf("-c"), hlsArgs("x").indexOf("-c") + 2), ["-c", "copy"], "再エンコードしない");
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("本物の ffmpeg で、h264/aac の mp4 が fMP4 の HLS とサムネイルになる", { skip: !hasFfmpeg }, async () => {
  const work = await mkdtemp(join(tmpdir(), "nagi-video-src-"));
  try {
    const source = join(work, "in.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=8",
      "-f", "lavfi", "-i", "sine=duration=8", "-c:v", "libx264", "-g", "30", "-c:a", "aac",
      "-shortest", source,
    ]);
    const body = await readFile(source);
    const real = createVideoFallback({
      cacheDir: join(work, "cache"),
      postExists: async () => true,
      resolvePdsUrl: async () => new URL("https://pds.example"),
      fetch: (async (input: string | URL) =>
        input.toString().startsWith(UPSTREAM)
          ? new Response(null, { status: 404 })
          : new Response(body, { headers: { "content-type": "video/mp4" } })) as typeof fetch,
      runFfmpeg,
    });
    const playlist = await real.resolve(DID, CID, "playlist.m3u8");
    const text = await readFile((playlist as { path: string }).path, "utf8");
    assert.match(text, /#EXT-X-MAP:URI="init\.mp4"/);
    assert.match(text, /seg000\.m4s/);
    assert.match(text, /#EXT-X-ENDLIST/);
    const thumb = await real.resolve(DID, CID, "thumbnail.jpg");
    const jpeg = await readFile((thumb as { path: string }).path);
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
