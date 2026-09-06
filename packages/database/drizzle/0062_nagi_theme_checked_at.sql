-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- NagiThemeWorker のスケジューリングを「何が書けたか」から「いつ試したか」へ移す。
--
-- これまで対象者の抽出は nagi.actor_interest_keywords の max(updated_at) を見ていた。
-- つまり「行が書けたこと」でしか実行済みを判定していないので、テーマが1つも取れない人は
-- updated_at が NULL のまま永久に候補に残り、10秒間隔（BUSY_INTERVAL_MS）で回り続けた。
-- 本番で実際に1人が該当し、[nagi-theme] のログが10秒おきに出続けていた。
--
-- 結果が空でも「試した」時刻を入れることで、LLM の当たり外れとスケジューリングを切り離す。
-- news_reasons 側も同じ穴（承認済み記事が0件だと1行も書かずに return する）を持つので同じ形にする。
-- NULL は未実施＝最優先で拾う、という意味。

ALTER TABLE "nagi"."actors"
  ADD COLUMN IF NOT EXISTS "themes_checked_at" timestamptz;

ALTER TABLE "nagi"."actors"
  ADD COLUMN IF NOT EXISTS "news_reasons_checked_at" timestamptz;

-- 一度きりのバックフィル。既存ユーザーが全員 NULL だと、初回に全員ぶんのテーマ抽出が
-- 走り直す（LLM 呼び出しが無駄になる）。これまでの判定材料だった max(updated_at) を
-- そのまま移し、実績のある人は TTL の続きから再開させる。
UPDATE "nagi"."actors" a
   SET "themes_checked_at" = t.updated_at
  FROM (select did, max(updated_at) as updated_at
          from "nagi"."actor_interest_keywords" group by did) t
 WHERE t.did = a.did and a."themes_checked_at" is null;

UPDATE "nagi"."actors" a
   SET "news_reasons_checked_at" = r.updated_at
  FROM (select did, max(updated_at) as updated_at
          from "nagi"."news_reasons" group by did) r
 WHERE r.did = a.did and a."news_reasons_checked_at" is null;
