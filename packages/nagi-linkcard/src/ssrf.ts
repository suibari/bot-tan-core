import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LinkMetadataError } from "./errors.js";

/**
 * IPv4射影IPv6（`::ffff:127.0.0.1` / `::ffff:7f00:1`）を素の IPv4 へ戻す。
 *
 * これを畳まないと IPv4 の判定を丸ごと迂回できる。攻撃者が自ドメインの AAAA へ
 * `::ffff:127.0.0.1` を置くだけで、DNS 解決結果の検査をすり抜けてループバックへ
 * 到達できてしまう（実測で素通りすることを確認済み）。
 */
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
export const blockedAddress = (address: string) => {
  const candidate = (unmapIpv4(address) ?? address).trim().toLowerCase();
  if (
    candidate === "::1" ||
    candidate === "::" ||
    candidate.startsWith("fe80:") ||
    candidate.startsWith("fc") ||
    candidate.startsWith("fd")
  )
    return true;
  const parts = candidate.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
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

// プライベート/ループバックアドレスに解決されるホスト名を拒否する。
// 信頼できない入力由来のホスト（例: did:web のオーソリティ）へアクセスする前に使う。
export async function assertPublicHost(hostname: string) {
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => blockedAddress(address)))
    throw new LinkMetadataError(400, "invalid_request", "Private network hosts are not supported");
}

// URL が公開 HTTP(S) エンドポイント（認証情報の埋め込みが無く、非プライベート
// アドレスに解決される）であることを検証し、パース済み URL を返す。
export async function safeUrl(raw: string, base?: URL) {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new LinkMetadataError(400, "invalid_request", "Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new LinkMetadataError(400, "invalid_request", "Only public HTTP(S) URLs are supported");
  await assertPublicHost(url.hostname);
  return url;
}
