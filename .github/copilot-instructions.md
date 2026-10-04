# Copilot への指示

## 言語

- プルリクエストのレビューコメント・サマリー・提案は、すべて**日本語**で書いてください。
- コードの識別子、ファイルパス、ライブラリ名、技術用語は原文のまま残してください。

## レビュー観点

このリポジトリの規則は `AGENTS.md` にまとまっています。特に次の点を確認してください。

- Drizzle の `sql` テンプレートへ `Date` を直接補間していないか（`${now}` など）。
  timestamp 列は `gt` / `lt` などの型付き演算子で比較する。
- Ollama へのリクエストの `options` に `num_ctx` を入れていないか。
  `num_predict` と `temperature` は必ず送る。
- 定期ワーカーを `setInterval` で直に回していないか（`startWorkerLoop` を使う）。
- モデルへ送る画像が `prepareModelImages` を通っているか。
- ユーザーの投稿がプロンプトの末尾に置かれているか。
- botたんが PDS へ書いたレコードの直後に `ensureNagiBotRecordIndexed` を呼んでいるか。
