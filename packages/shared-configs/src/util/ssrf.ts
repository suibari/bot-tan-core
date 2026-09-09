import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ループバック・リンクローカル・RFC1918 のプライベート範囲（IPv4/IPv6）をブロックする。
// ユーザー由来 URL へのサーバーサイド fetch が内部ホストへ到達するのを防ぐために使う。
export const isBlockedAddress = (address: string): boolean => {
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

// URL をパースし、認証情報を含まない公開 HTTP(S) スキームであることを要求し、
// ホストがプライベート/ループバックアドレスに解決される場合は拒否する。
export async function assertPublicUrl(raw: string, base?: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw, base);
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
  return url;
}

const REDIRECT_LIMIT = 4;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;

// fetch の差し替え用。リクエスト前に対象 URL（およびリダイレクトの各ホップ）を
// assertPublicUrl で検証する。
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // 呼び出し側が明示した signal は尊重する。未指定時だけ全ホップ共通の期限を設け、
  // 画像配信元などが応答しないまま bot の返信処理を止め続けることを防ぐ。
  const signal = init.signal ?? AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS);
  let url = await assertPublicUrl(input);
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    const response = await fetch(url, { ...init, signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return response;
      url = await assertPublicUrl(location, url);
      continue;
    }
    return response;
  }
  throw new Error("Too many redirects");
}
