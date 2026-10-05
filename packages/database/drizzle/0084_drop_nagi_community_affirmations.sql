-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 「みんなで全肯定」を廃止した。要約はこっそり投稿からも作っていたので、行も残さない。
DROP TABLE IF EXISTS "nagi"."community_affirmation_dismissals";
DROP TABLE IF EXISTS "nagi"."community_affirmations";
DROP TYPE IF EXISTS "nagi"."community_affirmation_state";
-- 翻訳 API はこっそりスレッドを訳さなくなったので、先回りで作られていた訳も消す。
-- push はデータを触らないため、この DELETE は手動で流すこと。
-- 公開範囲はスレッドルートが持つ（kossoriVisibility と同じ判定）。
DELETE FROM "nagi"."translations" AS t
USING "nagi"."posts" AS p
WHERE t."post_uri" = p."uri"
  AND (
    p."kossori"
    OR EXISTS (
      SELECT 1
      FROM "nagi"."posts" AS thread_root
      WHERE thread_root."uri" = p."reply_root_uri"
        AND thread_root."kossori"
    )
  );
