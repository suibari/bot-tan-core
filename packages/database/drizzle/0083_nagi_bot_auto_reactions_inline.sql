-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- botたんの自動リアクションを返信・総評と同時に付ける形へ変えた（遅延ワーカーは廃止）。
-- state の既定値 'pending' は回収されない行を作るので外す。
ALTER TABLE "nagi"."bot_auto_reactions" ALTER COLUMN "state" DROP DEFAULT;
-- 旧ワーカーが予定表に積んだまま処理しなかった行。もう誰も拾わないので閉じる。
-- 新しい経路の processing 行はリースを持たないので、lease_expires_at で旧行だけを選ぶ。
UPDATE "nagi"."bot_auto_reactions"
SET "state" = 'skipped',
    "last_error" = 'delayed_worker_removed',
    "lease_expires_at" = NULL,
    "updated_at" = now()
WHERE "state" = 'pending'
   OR ("state" = 'processing' AND "lease_expires_at" IS NOT NULL);
