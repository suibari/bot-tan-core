import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { blueskyVideoUrls } from "@bsky-affirmative-bot/shared-configs/blueskyVideo";

// ホストがプライベート/ループバックアドレスに解決される URL を拒否し、DID 解決が
// 内部サービスへ向けられる（SSRF）のを防ぐ。bot-runtime は余分なワークスペース依存を
// 増やさないよう、この処理を自己完結で持つ。
const isBlockedAddress = (address: string): boolean => {
  if (address === "::1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] >= 224
  );
};

async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error(`Only public HTTP(S) URLs are allowed (got ${url.protocol})`);
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address)))
    throw new Error(`Refusing request to private or unresolvable host: ${url.hostname}`);
}

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
  const decoded = decodeURIComponent(did);
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
  await assertPublicUrl(didUrl);
  const response = await fetch(didUrl, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Failed to resolve DID: HTTP ${response.status}`);
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
