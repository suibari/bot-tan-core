import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { blueskyVideoUrls } from "@bsky-affirmative-bot/shared-configs/blueskyVideo";

/**
 * Nagi の動画の配信元を決める。
 *
 * video.bsky.app は Bluesky の投稿から参照されていない動画の変換結果を、しばらくすると消す
 * （2026-10-16 実測: Nagi にだけ載せた動画が数日で 404、同じ blob を Bluesky にも載せた
 * 動画は残っていた）。PDS 側の mp4 は Nagi のレコードが参照しているので残る。
 *
 * そこで video.bsky.app にまだあればそちらへ回し（CDN と画質の切り替えが使える）、
 * 消えていれば PDS の mp4 を取ってきて、ここで HLS（fMP4 1本、再エンコードなし）と
 * サムネイルを作って返す。クライアントは今までどおり HLS を再生するだけでよい。
 */

/** app.bsky.embed.video と Nagi の lexicon の上限に揃える。 */
export const MAX_VIDEO_BYTES = 300_000_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const FFMPEG_TIMEOUT_MS = 120_000;
const UPSTREAM_CHECK_TIMEOUT_MS = 5_000;
/** video.bsky.app に有ると分かった結果を覚えておく時間。消えたら次の確認で手元へ切り替わる。 */
const UPSTREAM_OK_TTL_MS = 10 * 60_000;

export const VIDEO_FILE = /^(playlist\.m3u8|thumbnail\.jpg|init\.mp4|seg\d{3,5}\.m4s)$/;

export type VideoSource =
  | { kind: "upstream"; url: string }
  | { kind: "local"; path: string };

export type VideoFallbackDeps = {
  cacheDir: string;
  /** その DID の、削除されていない Nagi 投稿がこの動画を参照しているか。 */
  postExists(did: string, cid: string): Promise<boolean>;
  resolvePdsUrl(did: string): Promise<URL>;
  fetch?: typeof fetch;
  runFfmpeg?: (args: string[], cwd: string) => Promise<void>;
  now?: () => number;
};

export class VideoUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 502 = 502,
  ) {
    super(message);
  }
}

export function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

/** 入力は PDS の mp4 1本だけ。HLS や concat の参照で別のファイルを読ませない。 */
export function hlsArgs(input: string) {
  return [
    "-nostdin", "-v", "error", "-protocol_whitelist", "file",
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c", "copy",
    "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", "seg%03d.m4s",
    "playlist.m3u8",
  ];
}

export function thumbnailArgs(input: string) {
  return [
    "-nostdin", "-v", "error", "-protocol_whitelist", "file",
    "-i", input,
    "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "4",
    "thumbnail.jpg",
  ];
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** 上限を超えた時点で読むのをやめる（content-length は信用しない）。 */
function limitBytes(max: number) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > max) callback(new VideoUnavailableError("Video is too large", 404));
      else callback(null, chunk);
    },
  });
}

export function createVideoFallback(deps: VideoFallbackDeps) {
  const fetcher = deps.fetch ?? fetch;
  const ffmpeg = deps.runFfmpeg ?? runFfmpeg;
  const now = deps.now ?? Date.now;
  const upstreamOkUntil = new Map<string, number>();
  const building = new Map<string, Promise<string>>();

  const keyOf = (did: string, cid: string) => `${did}/${cid}`;
  const dirOf = (did: string, cid: string) =>
    join(deps.cacheDir, encodeURIComponent(did), encodeURIComponent(cid));

  async function upstreamAvailable(did: string, cid: string) {
    const key = keyOf(did, cid);
    if ((upstreamOkUntil.get(key) ?? 0) > now()) return true;
    try {
      const playlist = new URL(blueskyVideoUrls(did, cid).playlist);
      // 親だけが CDN に残り、子プレイリストや動画本体が消えていることがある。
      // 全画質の子と先頭セグメント（fMP4 なら init も）まで確認してから転送する。
      const signal = AbortSignal.timeout(UPSTREAM_CHECK_TIMEOUT_MS);
      async function check(url: URL, depth: number): Promise<boolean> {
        if (url.origin !== playlist.origin || depth > 2) return false;
        const response = await fetcher(url, { signal, redirect: "error" });
        if (!response.ok) {
          await response.body?.cancel();
          return false;
        }
        const text = await response.text();
        const lines = text.trim().split(/\r?\n/).map((line) => line.trim());
        if (lines[0] !== "#EXTM3U") return false;
        const references = lines.filter((line) => line && !line.startsWith("#"));
        if (!references.length) return false;
        if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"))) {
          if (references.length > 8) return false;
          for (const reference of references) {
            if (!(await check(new URL(reference, url), depth + 1))) return false;
          }
          return true;
        }
        const init = lines.find((line) => line.startsWith("#EXT-X-MAP:"))
          ?.match(/URI="([^"]+)"/)?.[1];
        for (const reference of [init, references[0]]) {
          if (!reference) continue;
          const segment = new URL(reference, url);
          if (segment.origin !== playlist.origin) return false;
          // GET + Range で実体を確認し、Range 非対応でも本文は読み込まない。
          const result = await fetcher(segment, {
            signal, redirect: "error", headers: { Range: "bytes=0-0" },
          });
          await result.body?.cancel();
          if (!result.ok) return false;
        }
        return true;
      }
      if (await check(playlist, 0)) {
        upstreamOkUntil.set(key, now() + UPSTREAM_OK_TTL_MS);
        return true;
      }
    } catch {
      // video.bsky.app が落ちているときも、手元の HLS で再生できるようにする。
    }
    upstreamOkUntil.delete(key);
    return false;
  }

  async function download(did: string, cid: string, target: string) {
    const url = await deps.resolvePdsUrl(did);
    url.pathname = "/xrpc/com.atproto.sync.getBlob";
    url.searchParams.set("did", did);
    url.searchParams.set("cid", cid);
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new VideoUnavailableError(
        `PDS returned ${response.status}`,
        response.status === 404 || response.status === 400 ? 404 : 502,
      );
    }
    if (response.headers.get("content-type") !== "video/mp4") {
      await response.body.cancel();
      throw new VideoUnavailableError("Blob is not an mp4 video", 404);
    }
    await pipeline(
      Readable.fromWeb(response.body as any),
      limitBytes(MAX_VIDEO_BYTES),
      createWriteStream(target),
    );
  }

  async function build(did: string, cid: string) {
    const dir = dirOf(did, cid);
    if (await exists(join(dir, "playlist.m3u8"))) return dir;
    if (!(await deps.postExists(did, cid)))
      throw new VideoUnavailableError("Video post not found", 404);
    // 途中で落ちても壊れたキャッシュを残さないよう、作業用ディレクトリで作ってから入れ替える。
    const work = `${dir}.tmp-${process.pid}-${now()}`;
    await mkdir(work, { recursive: true });
    try {
      const source = join(work, "source.mp4");
      await download(did, cid, source);
      await ffmpeg(hlsArgs(source), work);
      await ffmpeg(thumbnailArgs(source), work);
      await rm(source);
      await rm(dir, { recursive: true, force: true });
      await rename(work, dir);
      console.log(`[INFO][NAGI_VIDEO] built local HLS for ${did}/${cid}`);
      return dir;
    } catch (error) {
      await rm(work, { recursive: true, force: true });
      throw error;
    }
  }

  /** 同じ動画を同時に何本も作らない（タイムラインはサムネイルを一斉に取りに来る）。 */
  function ensureLocal(did: string, cid: string) {
    const key = keyOf(did, cid);
    const pending = building.get(key);
    if (pending) return pending;
    const promise = build(did, cid).finally(() => building.delete(key));
    building.set(key, promise);
    return promise;
  }

  return {
    async resolve(did: string, cid: string, file: string): Promise<VideoSource> {
      if (!VIDEO_FILE.test(file)) throw new VideoUnavailableError("Unknown video file", 404);
      const local = join(dirOf(did, cid), file);
      // いちど手元で作った動画は、video.bsky.app から消えたもの。戻ってこないので確認しない。
      if (await exists(local)) return { kind: "local", path: local };
      const entry = file === "playlist.m3u8" || file === "thumbnail.jpg";
      if (entry && (await upstreamAvailable(did, cid))) {
        const urls = blueskyVideoUrls(did, cid);
        return { kind: "upstream", url: file === "playlist.m3u8" ? urls.playlist : urls.thumbnail };
      }
      const dir = await ensureLocal(did, cid);
      const path = join(dir, file);
      if (!(await exists(path))) throw new VideoUnavailableError("Unknown video file", 404);
      return { kind: "local", path };
    },
  };
}
