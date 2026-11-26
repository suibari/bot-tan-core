import dns from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "undici";

const unmapIpv4 = (address: string): string | undefined => {
  const mapped = /^::ffff:(.+)$/i.exec(address.trim())?.[1];
  if (!mapped) return undefined;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(mapped)) return mapped;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

// ループバック・リンクローカル・RFC1918 などの到達すべきでない範囲をブロックする。
export const isBlockedAddress = (address: string) => {
  const candidate = (unmapIpv4(address) ?? address).trim().toLowerCase();
  const family = isIP(candidate);
  // IPv6 はグローバルユニキャスト範囲に限る。
  if (family === 6) return !/^[23]/.test(candidate);
  if (family !== 4) return true;
  const parts = candidate.split(".").map(Number);
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    // CGNAT。ISP 配下では他の加入者へ届きうる。
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    // IETF プロトコル割当（192.0.0.0/24）と RFC1918。
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
    (parts[0] === 192 && parts[1] === 168) ||
    // ベンチマーク用（198.18.0.0/15）。
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
    parts[0] >= 224
  );
};

export class PublicUrlError extends Error {}

async function resolvePublicHost(hostname: string) {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address)))
    throw new PublicUrlError("Private or unresolvable network hosts are not supported");
  return addresses;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  await resolvePublicHost(hostname);
}

function parsePublicUrl(input: string | URL, base?: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new PublicUrlError("Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new PublicUrlError("Only public HTTP(S) URLs are supported");
  return url;
}

export async function assertPublicUrl(raw: string, base?: string | URL): Promise<URL> {
  const url = parsePublicUrl(raw, base);
  await assertPublicHost(url.hostname);
  return url;
}

const REDIRECT_LIMIT = 4;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;

export async function fetchPublicUrl(input: string | URL, init: RequestInit = {}) {
  const signal = init.signal ?? AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.delete("host");
  let url = parsePublicUrl(input);
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    const addresses = await resolvePublicHost(url.hostname);
    signal.throwIfAborted();

    // 接続時の再解決を避けつつ、元のホスト名を HTTP Host と TLS の検証に使う。
    const dispatcher = new Client(url.origin, {
      connect: {
        lookup(_hostname, options, callback) {
          const candidates = options.family
            ? addresses.filter(({ family }) => family === options.family)
            : addresses;
          const first = candidates[0];
          if (!first) {
            callback(new Error("No validated addresses for the requested family"), "", 0);
          } else if (options.all) {
            callback(null, candidates);
          } else {
            callback(null, first.address, first.family);
          }
        },
      },
      autoSelectFamily: true,
    });
    let response: Response;
    try {
      const options = { ...init, headers, signal, redirect: "manual" as const, dispatcher };
      response = await fetch(url, options);
    } finally {
      // close は取得中の本文の完了を待ってからソケットを閉じる。
      void dispatcher.close().catch(() => {});
    }

    const location = response.headers.get("location");
    if (init.redirect === "manual" || !location || ![301, 302, 303, 307, 308].includes(response.status))
      return { response, url };

    await response.body?.cancel();
    if (init.redirect === "error") throw new Error("Unexpected redirect");
    if (hop === REDIRECT_LIMIT) throw new Error("Too many redirects");
    const target = parsePublicUrl(location, url);
    if (target.origin !== url.origin) {
      for (const name of ["authorization", "cookie", "proxy-authorization"])
        headers.delete(name);
    }
    url = target;
  }
}

export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return (await fetchPublicUrl(input, init)).response;
}
