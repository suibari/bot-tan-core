-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- 全肯定ニュースの推薦を、具体的な興味語との厳密一致から広い関心ジャンルとの一致へ移す。
-- actor_interest_keywords はプロフィール表示にも使うため残し、推薦専用ジャンルを別表に置く。

CREATE TABLE IF NOT EXISTS "nagi"."actor_interest_genres" (
  "did" text NOT NULL,
  "genre" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "actor_interest_genres_did_genre_pk" PRIMARY KEY ("did", "genre")
);

-- 旧結果は具体語を格納しているため、そのままジャンルとして扱わない。
DELETE FROM "nagi"."news_reasons";
ALTER TABLE "nagi"."news_reasons" RENAME COLUMN "keyword" TO "genre";

-- 全ユーザーの具体テーマ＋ジャンルと記事突合をワーカーに作り直させる。
UPDATE "nagi"."actors"
   SET "themes_checked_at" = NULL,
       "news_reasons_checked_at" = NULL;
