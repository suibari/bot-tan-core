import {
  NAGI,
  STANDARD_SITE_DOCUMENT,
  TRILINES,
  type PostView,
} from "@bsky-affirmative-bot/nagi-lexicon";

/**
 * 引用カードとして posts から読み込める引用先か。Nagi の投稿のほか、投稿形へ射影して
 * posts に載せているブログ記事と3行日記も含む（ニュースは別の経路で読む）。
 */
export function isQuotablePostUri(uri: string | null | undefined): boolean {
  const collection = uri?.split("/")[3];
  return (
    collection === NAGI.post ||
    collection === STANDARD_SITE_DOCUMENT ||
    collection === TRILINES.diary
  );
}

/**
 * 3行日記の行ビュー。URI のコレクションが日記のときだけ返す。
 * 投稿レコードに trilines を書き込んでも、日記の URI でなければ日記として扱わない。
 */
export function trilinesView(
  uri: string,
  record: any,
): Pick<PostView, "trilines"> {
  if (uri.split("/")[3] !== TRILINES.diary) return {};
  const lines = record?.trilines?.lines;
  if (!Array.isArray(lines)) return {};
  return {
    trilines: {
      lines: lines.flatMap((line: any) =>
        typeof line?.text === "string"
          ? [
              {
                text: line.text,
                ...(Number.isInteger(line.imageIndex)
                  ? { imageIndex: line.imageIndex }
                  : {}),
              },
            ]
          : [],
      ),
    },
  };
}
