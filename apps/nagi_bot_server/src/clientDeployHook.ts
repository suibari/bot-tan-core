/**
 * Nagi クライアント（Vercel）の再ビルドを要求する。
 *
 * ニュース一覧 `/news` と記事ページ `/news/<rkey>` は、検索エンジンへ本文を出すために
 * **ビルド時にプリレンダ**している。つまり新しく公開した記事は、次のビルドが走るまで
 * sitemap にもパーマリンクにも現れない。公開直後にここを叩くことで、その待ち時間を
 * スロット間隔（6時間）からビルド1回分へ縮める。
 *
 * 呼び出し元を**絶対に失敗させない**。取りこぼしても次のスロットのビルドが拾うので、
 * デプロイの不調でニュース公開そのものを止める理由がない。
 *
 * 環境変数が未設定なら何もしない（VAPID や PASSPORT と同じ扱い）。開発機の .env に
 * 本番のフックURLを入れないこと —— 入れると開発中の実行が本番ビルドを蹴る。
 */
export async function requestClientRebuild(reason: string): Promise<boolean> {
  const url = process.env.NAGI_CLIENT_DEPLOY_HOOK_URL;
  if (!url) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`[INFO][DEPLOY_HOOK] requested client rebuild (${reason})`);
    return true;
  } catch (error) {
    console.error(
      `[ERROR][DEPLOY_HOOK] client rebuild request failed (${reason}):`,
      error,
    );
    return false;
  }
}
