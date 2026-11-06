# 日記の区切りと書き先

日記の1日は `shared-configs/src/diaryDay.ts` が決める。AppView と両 bot は
`database/src/diaryDay.ts` で同じ設定履歴を読む。タイムゾーンと区切りの時刻は
AppView の非公開テーブルに保存し、公開の atproto レコードには書かない。

タイムゾーンの優先順は、手動指定、自動検出、Nagi の最新の日記の言語、
Nagi の最新の投稿の言語、Bluesky の最新の投稿の言語、UTC。
履歴がある人は当時の設定を使い、区切りの既定値は22時。
設定はクライアントの「botたんの設定 → 日記を書く時間」で変更する。

## 決定と実行

両 bot が5分ごとに同じ `decideDiaryJobs()` を呼ぶ。どちらかが止まっても
書き先は決められる。実際に書けるのは、決まった面の bot が稼働している間だけ。
窓の終わり際の投稿の取り込みを待つため、終わりから5分の猶予を置く。
通常は区切りから5〜10分後にジョブが作られ、そこから生成する。

`affirmative_bot.diary_jobs` は `(did, diary_date)` を主キーとし、
窓の始まり・終わり、タイムゾーン、区切り時刻と書き先を1行に固定する。

1. その窓に Nagi の投稿があれば `nagi`。
2. なければ、日記モードがオンのコミュニティメンバー（または開発者）は `bsky`。
3. それ以外は `none` / `skipped` として記録する。

Bluesky 側は1時間ごとに最新の投稿の言語を `followers.diary_bsky_lang` に記録する。
Bluesky に材料があるかは実行時に API で調べ、窓の中に投稿がなければ `skipped`。
Nagi で選んだ設定は、Bluesky だけを使うようになっても有効。
すでに決定した日は、設定を変えても窓を変更しない。

各 bot は自分の面のジョブを単一の UPDATE で取得する。
`pending → running → done / skipped`、失敗は `pending` に戻り1時間後から再取得できる。
実行中のリースは4時間。落ちた実行はリース後に回収し、古い試行からの完了通知は無視する。
再試行は次の実在する日の窓が閉じるまで。夏時間や区切り変更で24時間にならない日も、
共通の窓の計算を使う。翌日の設定変更時には、既存ジョブの再試行期限も更新する。

この仕組みが防ぐのは、同じ人・日付の書き先が Nagi と Bluesky の両方になること。
Bluesky への公開と DB の完了記録は別の処理なので、公開直後にプロセスが落ちると、
回収で Bluesky に同じ日記を再送する可能性は残る。
Nagi は本人・日付の存在確認と一意な rkey で既存の日記を再利用する。
管理用の手動実行 `/diaries/run` は通常の書き先決定を経由しない。

## デプロイ

1. DB を先に更新する。`packages/database` の `pnpm drizzle:push` で
   `diary_day_preferences`、`diary_day_schedules`、`diary_jobs` と
   `followers.diary_bsky_lang` を作る。手動適用用 SQL は
   `packages/database/drizzle/0101_nagi_diary_day.sql`。
2. AppView を更新する。
3. 旧版の両 bot を停止し、両方を新版へ切り替えてから起動する。
   旧版と新版を混ぜると、旧版がジョブを見ずに書くため二重生成の可能性がある。

移行前の Nagi の日記がある日、および `followers.last_diary_date` と一致する日は
完了済みのジョブとして記録する。旧列は移行時の参照用に残し、新版は更新しない。
DB の列とテーブルは旧版とも共存するが、bot の片方だけのロールバックは避ける。

クライアントと AppView はどちらが先でも動く。旧 AppView には設定項目を表示せず、
日ごとの窓がなければ従来のタイムゾーン・22時で描画する。
旧クライアントでは変更後の区切りを正しく描けないため、クライアントも更新する。

## 検証

通常のテストに加え、`NAGI_MOOD_TEST_DATABASE_URL` に専用の使い捨て DB
`nagi_mood_test` を指定して、次のテストをそれぞれ単独・順番に実行する。
これらは対象テーブルを作り直すため、共有 DB や本番 DB へ向けない。

- `packages/database/test/diaryJobs.postgres.test.ts`: 同時決定・取得、再試行、リース、
  移行済みの日、夏時間、設定済みの人が Bluesky に戻る場合。
- `apps/nagi_appview/test/diaryDay.postgres.test.ts`: 設定履歴と有効日、決定済みの日の保護、再試行期限。
- `apps/nagi_appview/test/postMood.postgres.test.ts`: 投稿の気分と日記の日付の対応。

実際の Bluesky への公開やログイン済みクライアントと AppView の通しの動作は、
これらのテストでは確認しない。
