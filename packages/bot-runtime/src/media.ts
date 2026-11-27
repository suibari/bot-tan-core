import { safeFetch } from "@bsky-affirmative-bot/shared-configs/ssrf";
import { blueskyVideoUrls } from "@bsky-affirmative-bot/shared-configs/blueskyVideo";

export type BlobImage = {
  image?: {
    ref?: { $link?: string } | { toString(): string };
    mimeType?: string;
  };
};

export type RuntimeImageRef = {
  image_url: string;
  mimeType: string;
};

export async function resolvePdsUrl(did: string): Promise<string> {
  const decoded = did.startsWith("did:") ? did : decodeURIComponent(did);
  let didUrl: string;
  if (decoded.startsWith("did:plc:")) {
    didUrl = `https://plc.directory/${decoded}`;
  } else if (decoded.startsWith("did:web:")) {
    const [host, ...path] = decoded.slice("did:web:".length).split(":");
    didUrl = path.length
      ? `https://${decodeURIComponent(host)}/${path.map(decodeURIComponent).join("/")}/did.json`
      : `https://${decodeURIComponent(host)}/.well-known/did.json`;
  } else {
    throw new Error(`Unsupported DID method: ${decoded}`);
  }
  const response = await safeFetch(didUrl, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Failed to resolve DID: HTTP ${response.status}`);
  }
  const document = (await response.json()) as {
    service?: Array<{ type?: string; serviceEndpoint?: string }>;
  };
  const service = document.service?.find(
    (item) =>
      item.type === "AtprotoPersonalDataServer" &&
      typeof item.serviceEndpoint === "string",
  );
  if (!service?.serviceEndpoint)
    throw new Error(`PDS service not found for ${decoded}`);
  return service.serviceEndpoint;
}

export function blobImagesToImageRefs(
  did: string,
  pdsUrl: string,
  images: readonly BlobImage[] | null | undefined,
): RuntimeImageRef[] {
  if (!images?.length || !pdsUrl) return [];
  const endpoint = pdsUrl.replace(/\/$/, "");
  return images.flatMap((item) => {
    const ref = item.image?.ref;
    const cid =
      (ref as { $link?: string } | undefined)?.$link ?? ref?.toString();
    const mimeType = item.image?.mimeType;
    if (!cid || !mimeType?.startsWith("image/")) return [];
    const url = new URL("/xrpc/com.atproto.sync.getBlob", endpoint);
    url.searchParams.set("did", did);
    url.searchParams.set("cid", cid);
    return [{ image_url: url.toString(), mimeType }];
  });
}

export type BlobVideo = {
  video?: {
    ref?: { $link?: string } | { toString(): string };
    mimeType?: string;
  };
};

/**
 * 動画はモデルへ渡せないので、video.bsky.app のサムネイルを1枚の画像として扱う。
 * Nagi の動画は uploadVideo を通って変換済みなので、PDS ではなくこちらから取る。
 * Bluesky から参照されていない動画は数日で消えるが、返信の文脈は投稿直後に作るので足りる。
 */
export function blobVideoToImageRefs(
  did: string,
  video: BlobVideo | null | undefined,
): RuntimeImageRef[] {
  const ref = video?.video?.ref;
  const cid = (ref as { $link?: string } | undefined)?.$link ?? ref?.toString();
  if (!cid || video?.video?.mimeType !== "video/mp4") return [];
  return [{ image_url: blueskyVideoUrls(did, cid).thumbnail, mimeType: "image/jpeg" }];
}
