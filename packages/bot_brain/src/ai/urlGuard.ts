import { trimBotPostUrl } from "@bsky-affirmative-bot/shared-configs";

/**
 * 生成文に「材料として渡していない URL」が混ざっていないか検査する。
 *
 * モデルは指示に無くても、文脈から「ありそうな URL」を作って書く。2026-10-06 の
 * おやすみポストでは、表示名「📛 Transgender Mahou Shoujo 🦊 | 🌹🌙🌲」が
 * `https://x.com/TransgenderMahouShoujo` に化け、X アカウントを持たない人の x.com
 * リンクが Bluesky と Nagi の両方へ公開された。プロンプトで禁じても確率が下がるだけで、
 * 0 にはならない。
 *
 * 判定は「その URL がプロンプトの材料のどこかに書いてあったか」。材料に無い URL は
 * すべてモデルの創作として扱う。呼び出し側は例外を受けて再生成し、尽きたら投稿しない
 * （または定型文へ落とす）。黙って URL だけ消す方式にしないのは、URL の前後の文
 * （「このアカウントもフォローしてね」など）が宙に浮くため。
 *
 * 新しい生成経路を足すときは、材料（プロンプトに入れた文字列やオブジェクト）を
 * `createUrlAllowance` に渡し、投稿前に `assertSourcedUrls` を通すこと。
 */

export interface UrlAllowance {
  /** この origin 配下の URL はすべて許可する（自前サービスの固定 URL など）。 */
  readonly origins: ReadonlySet<string>;
  /** 材料に含まれていた文字列（小文字化して連結したもの）。 */
  readonly corpus: string;
}

export class UnsourcedUrlError extends Error {
  constructor(
    readonly label: string,
    readonly urls: string[],
  ) {
    super(`${label} wrote an unexpected URL: ${urls.join(", ")}`);
    this.name = "UnsourcedUrlError";
  }
}

/**
 * 本文中の `http(s)://` で始まる URL を取り出す。切り出し規則は投稿の facet 生成
 * （`sanitizeBotPostFacets`）と共通で、ASCII 以外の文字と末尾の句読点は URL に含めない。
 * 検査した URL と実際にリンクになる URL がずれないようにするため。
 */
export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[\x21-\x7E]+/gi) ?? [])
    .map((url) => trimBotPostUrl(url))
    .filter((url): url is string => Boolean(url));
}

function collectStrings(value: unknown, out: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  // 画像のバイト列などを文字列として舐めない。
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(item, out, seen);
  }
}

/**
 * @param sources.materials プロンプトに入れた材料。文字列でもオブジェクトでもよく、
 *   中の文字列を再帰的に集める（UserInfoGemini をそのまま渡せる）。
 * @param sources.origins 材料に無くても書いてよい origin（例: `https://room.bot-tan.com`）。
 */
export function createUrlAllowance(sources: {
  materials?: unknown[];
  origins?: Iterable<string>;
}): UrlAllowance {
  const strings: string[] = [];
  const seen = new WeakSet<object>();
  for (const material of sources.materials ?? []) collectStrings(material, strings, seen);
  const origins = new Set<string>();
  for (const origin of sources.origins ?? []) {
    try {
      origins.add(new URL(origin).origin);
    } catch {
      /* 不正な origin は無視する。 */
    }
  }
  return { origins, corpus: strings.join("\n").toLowerCase() };
}

/**
 * 材料に「スキーム無しの形（host + path）」で現れていれば出典ありとみなす。
 * 利用者が `example.com/page` と書き、モデルが `https://example.com/page` と
 * 書き直すのは捏造ではないので通す。
 * 前後が英数字に続いている一致（`x.com` が `netflix.com` に含まれる等）は数えない。
 */
function appearsInCorpus(corpus: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const index = corpus.indexOf(needle, from);
    if (index < 0) return false;
    const before = corpus[index - 1] ?? "";
    const after = corpus[index + needle.length] ?? "";
    if (!/[a-z0-9._@-]/.test(before) && !/[a-z0-9_-]/.test(after)) return true;
    from = index + 1;
  }
}

function isSourced(url: string, allowance: UrlAllowance): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (allowance.origins.has(parsed.origin)) return true;
  // URL() は host を小文字化し、path の非ASCIIをエンコードする。比較は元の表記で行う。
  const withoutScheme = url.replace(/^https?:\/\//i, "").replace(/#.*$/, "").replace(/\/$/, "");
  return appearsInCorpus(allowance.corpus, withoutScheme.toLowerCase());
}

/** 材料に無い URL を返す。重複は1つにまとめる。 */
export function findUnsourcedUrls(text: string, allowance: UrlAllowance): string[] {
  return [...new Set(extractUrls(text).filter((url) => !isSourced(url, allowance)))];
}

/**
 * 材料に無い URL があれば `UnsourcedUrlError` を投げる。
 * @param label エラーとログに出す生成経路名。
 */
export function assertSourcedUrls(
  texts: string | readonly (string | null | undefined)[],
  allowance: UrlAllowance,
  label: string,
): void {
  const list = typeof texts === "string" ? [texts] : texts;
  const urls = [...new Set(list.flatMap((text) => (text ? findUnsourcedUrls(text, allowance) : [])))];
  if (urls.length) throw new UnsourcedUrlError(label, urls);
}
