-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- 全肯定ニュースの取得クエリを、bot_memory が覚えた嗜好へ寄せるための表。
--
-- これまで NewsData は「日本の最新ニュースから政治・事件を除いたもの」を無指定で取り、
-- 何を載せるかは2段のゲート（Ollama の粗選別 → Gemini の最終審査）だけで決めていた。
-- つまり取得の時点ではユーザーの嗜好が一切効いていない。
--
-- ここには bot_memory_impressions の印象語をローカルLLMがジャンルへ一般化した結果を置く。
-- 入るのは作品名ではなく「アニメ」のようなジャンル。固有名で引くと当たりが宣伝と公式発表に偏り、
-- 当たらない日は0件になる（1日20クレジットしかない取得枠をそれに賭けられない）。
-- 広く取っておけば、個々の記事が誰に届くかは news_reasons と埋め込み最近傍が決める。
--
-- last_used_at はワーカーの全入れ替えでも持ち越す。消すとスコア最上位のジャンルだけが
-- 選ばれ続け、取得が1ジャンルに張り付く。

CREATE TABLE IF NOT EXISTS "nagi"."news_interest_topics" (
  "topic" text PRIMARY KEY,
  "score" integer DEFAULT 0 NOT NULL,
  "label_count" integer DEFAULT 0 NOT NULL,
  "last_used_at" timestamptz,
  "last_accepted_count" integer,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "nagi_news_interest_topics_pick_idx"
  ON "nagi"."news_interest_topics" ("last_used_at", "score");
