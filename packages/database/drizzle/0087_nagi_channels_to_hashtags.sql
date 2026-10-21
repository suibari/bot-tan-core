-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- チャンネル機能をハッシュタグへ統合して廃止した。channel_uri を持つ既存投稿は、
-- AppView がクエリ時にチャンネル名のタグとして扱うので、posts は書き換えない。

-- ミュートの種別に tag を足す。ADD VALUE は同じトランザクション内で新しい値を使えないので、
-- 下の移行より先に単独で流すこと（push でも追加される）。
ALTER TYPE "nagi"."mute_subject_type" ADD VALUE IF NOT EXISTS 'tag';

-- チャンネルのミュートを、チャンネル名のタグミュートへ移す。
-- push はデータを触らないため、ここから下は手動で流すこと。
-- タグは extractTags と同じく先頭の # / ＃ を除いた小文字で持つ。
BEGIN;
INSERT INTO "nagi"."mutes" ("muter_did", "subject_type", "subject", "created_at")
SELECT m."muter_did", 'tag', lower(btrim(regexp_replace(c."name", '^[#＃]+', ''))), m."created_at"
FROM "nagi"."mutes" AS m
JOIN "nagi"."channels" AS c ON c."uri" = m."subject"
WHERE m."subject_type" = 'channel'
  AND btrim(regexp_replace(c."name", '^[#＃]+', '')) <> ''
ON CONFLICT DO NOTHING;
DELETE FROM "nagi"."mutes" WHERE "subject_type" = 'channel';
COMMIT;

-- 保存済みのタブ（feed_tabs.tabs）は AppView が読み書きのたびに hashtag タブへ変換するので、
-- ここでは書き換えない（upgradeLegacyFeedTabs）。

-- 購読（参加）と、チャンネル検索だけが使っていた索引・埋め込みを捨てる。
DROP TABLE IF EXISTS "nagi"."channel_subscriptions";
DROP INDEX IF EXISTS "nagi"."nagi_channels_embedding_hnsw_idx";
DROP INDEX IF EXISTS "nagi"."nagi_channels_name_trgm_idx";
ALTER TABLE "nagi"."channels" DROP COLUMN IF EXISTS "embedding";
