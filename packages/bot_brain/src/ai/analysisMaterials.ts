/**
 * 性格分析（Bluesky の「分析して」と Nagi の名刺）で共通の材料整形。
 *
 * 分析プロンプトの事故はいつも「どこからどこまでが誰の文章か」が消えることで起きる。
 * 整形はここ1か所に置き、両方の分析が同じ形の材料を受け取るようにする。
 */

/**
 * 投稿を1件1行の箇条書きに整える。
 *
 * 以前は `posts.join("\n")`（Nagi）や配列をそのままテンプレートへ埋め込む形（Bluesky。
 * 結果は "a,b,c" のカンマ区切り）だったので、1件の境界がモデルから見えなかった。
 * 境界が無いと、本人の投稿と他人の投稿の切れ目も当然見えない。
 */
export const bulletList = (texts: string[]): string =>
  texts
    .map((text) => text.replace(/\s*\n\s*/g, " ").trim())
    .filter((text) => text.length > 0)
    .map((text) => `- ${text}`)
    .join("\n");

/**
 * いいね/リアクション先の材料を絞る上限。
 *
 * 実測（2026-09-12 の名刺事故、まさちーさんのデータ）:
 *   本人の投稿   100件 / 3,693字
 *   リアクション先 100件 / 11,058字  ← 本人の3倍
 *   うち botたんの投稿 12件 / 3,593字 ← これだけで本人の全投稿とほぼ同量
 *
 * 予算超過による切り詰めは起きていなかった（32kコンテキストに収まる）。つまり事故は
 * 量の問題ではなく帰属の問題だが、他人の文章が3倍あれば量的にも引っ張られる。
 * リアクションから読み取りたいのは「どんな話題に反応するか」だけで、全文も100件も要らない。
 */
const LIKED_MAX_ITEMS = 30;
const LIKED_MAX_CHARS = 200;

/**
 * いいね/リアクション先の投稿を、新しいものから数件・各短めに切り詰める。
 * 本人の投稿には掛けない（分析の対象そのものなので削ってはいけない）。
 */
export const limitLikedMaterial = (texts: string[]): string[] =>
  texts.slice(0, LIKED_MAX_ITEMS).map((text) =>
    text.length > LIKED_MAX_CHARS ? `${text.slice(0, LIKED_MAX_CHARS)}…` : text,
  );
