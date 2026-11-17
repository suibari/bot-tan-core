import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { rateLimit, ipKeyGenerator, type Options } from "express-rate-limit";

type LimiterOptions = Partial<Options>;

/**
 * AppView のレート制限はすべてここで作る。
 *
 * `enabled=false`（開発環境）のときは数えずに素通しする。開発ではホットリロードと
 * 画面の作り直しで同じ API を短時間に何度も叩くので、本番用の枠ではすぐ 429 になり、
 * 「429 で絵文字が出ない」が本物の不具合と見分けられなくなる。
 */
export function createRateLimit(
  enabled: boolean,
  options: LimiterOptions,
) {
  const { skip, ...rest } = options;
  return rateLimit({
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...rest,
    skip: (req, res) => (!enabled ? true : skip ? skip(req, res) : false),
  });
}

/**
 * atproto-proxy 経由の authed リクエストは送信元 IP がユーザの PDS になり、IP キーだと
 * 同一 PDS 配下の全ユーザが 1 バケットを共有してしまう。Bearer（PDS 発行の service auth
 * JWT）の iss（=ユーザ DID）をキーにし、Bearer 無しの公開直 fetch は IP キーへフォールバック。
 * rate-limit のバケット用途なので iss は未検証デコードで十分。
 */
export const issFromBearer = (
  authorization: string | undefined,
): string | undefined => {
  const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return typeof claims.iss === "string" ? claims.iss : undefined;
  } catch {
    return undefined;
  }
};

export const viewerKey: NonNullable<Options["keyGenerator"]> = (req) => {
  const r = req as unknown as {
    header(name: string): string | undefined;
    ip?: string;
  };
  return issFromBearer(r.header("authorization")) ?? ipKeyGenerator(r.ip ?? "");
};

/**
 * 絵文字の読み取り（DB を引くだけのもの）。
 *
 * クライアントは起動時にお気に入り・使用履歴のカスタム絵文字を1件ずつ getEmoji で
 * 確かめ直し、ピッカーは一覧をスクロールで searchEmojis し続ける。API 全体の
 * 60回/分の枠を共有すると、絵文字が多い人ほど開いた直後にタイムラインごと 429 になる。
 * 意味検索（semantic=true）は埋め込み生成で Ollama を叩くので、こちらには入れない。
 */
export function isEmojiReadRequest(request: unknown): boolean {
  // express-rate-limit が持つ express の型と、アプリ側の型の版がずれるので構造で受ける。
  const req = request as { path: string; query: Record<string, unknown> };
  if (req.path === `/${NAGI.getEmoji}`) return true;
  return req.path === `/${NAGI.searchEmojis}` && req.query.semantic !== "true";
}
