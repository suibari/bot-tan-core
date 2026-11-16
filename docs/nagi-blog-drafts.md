# ブログ下書きのメタデータ

`com.suibari.nagi.putDraft#draftContent` と `#draftView`、`getDrafts#draftSummary` は、任意の `articleTitle`（文字列）と `articleTags`（文字列配列）を保持する。本文が空の下書きも受理し、従来の本文・参照フィールドは変更しない。フィールドを持たない旧下書きには追加値を補わない。

保存先は従来の `nagi.drafts.content`（JSONB）で、テーブル移行は不要。既存の本人認証とowner DIDによる検索・更新・削除、128KBの要求サイズ上限、画像などのバイナリ拒否を維持する。PDSへは書き込まない。

クライアントは保存応答の実内容を現在の入力と照合する。旧サーバが追加フィールドを捨てた場合は、空でないタイトル・タグを保存済みと表示してはならない。画像は引き続き下書きの保存対象外である。

## 検証

入力検証は `pnpm exec tsx --test apps/nagi_appview/test/drafts.test.ts` で実行する。

HTTPとPostgresを通る往復テストは、使い捨ての `nagi_draft_test` データベースだけを対象に、`NAGI_DRAFT_TEST_DATABASE_URL` を設定して `pnpm exec tsx --test apps/nagi_appview/test/drafts.postgres.test.ts` で実行する。テストは同DBに下書き用テーブルを作成し、テスト所有者の新規UUIDだけを使って保存・取得・一覧・所有者分離・旧下書き互換を確認した後、その行を削除する。認証ミドルウェアはこの往復テストの対象外で、変更もしていない。

本番反映時はAppViewをクライアントより先に更新する。本番のセッションを使った往復確認やデプロイは、ローカルのHTTP/Postgresテストとは区別する。
