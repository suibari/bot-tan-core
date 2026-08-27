# AI Agent Rules for bsky-affirmative-bot

## Database timestamp parameters

Drizzle の `sql` テンプレートへ JavaScript の `Date` を直接補間してはいけない。
Drizzle 管理下の timestamp 列に結び付かない raw パラメータは、postgres.js へ
`Date` のまま渡り、クエリ送信時に次の例外を起こす。

```text
TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string ...
Received an instance of Date
```

### 禁止例

```ts
sql`dismissal.expires_at > ${now}`;
sql`${now} < scheduled_end_at`;
sql`${sql.param(now)} < scheduled_end_at`;
```

`sql.param(date)` だけでは timestamp 列のエンコーダが付かないため、安全策にはならない。
raw SQL の相関サブクエリ内でも同じ規則を適用すること。

### Drizzle 管理下の列

timestamp 列と値を `eq`、`gt`、`gte`、`lt`、`lte` などの型付き演算子で比較する。
相関サブクエリは `notExists`、`and`、`alias` と型付き列を組み合わせる。

```ts
gt(dismissal.expiresAt, now);
lt(job.expiresAt, now);
```

これにより、列のエンコーダが `Date` をPostgreSQL用の文字列へ変換する。

### ORM定義のない外部テーブル

やむを得ずraw SQLを使う場合は、ISO 8601文字列へ変換し、PostgreSQL側の型を
明示する。

```ts
const currentTime = now.toISOString();
sql`${currentTime}::timestamptz < scheduled_end_at`;
```

### レビューとテスト

- 日時を含むraw `sql`を追加・変更したら、`${date}`や`${now}`の直接補間がないか確認する。
- `.toSQL()`でSQL文字列だけを確認しても、この不具合は検出できない。`params`に
  `Date`インスタンスが残っていないことも検証する。
- 可能な限り、Drizzleとpostgres.jsの実ドライバ境界を通るテストを追加する。
- raw SQLが必要な場合は、ISO文字列への変換と明示キャストをテスト対象にする。
