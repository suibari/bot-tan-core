-- 既存本文を保存する。英語の挨拶を優先し、それ以前の本文は仮名の有無で判定。
-- 新しい両言語版がある行は上書きしない。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'nagi' AND table_name = 'radio_tracks' AND column_name = 'comment'
  ) THEN
    UPDATE nagi.radio_tracks
    SET comment_en = comment
    WHERE comment IS NOT NULL AND comment_ja IS NULL AND comment_en IS NULL
      AND (comment ~* '^(Good (morning|afternoon|evening)|I read your recent posts)'
        OR comment !~ '[ぁ-んァ-ヶ]');
    UPDATE nagi.radio_tracks
    SET comment_ja = comment
    WHERE comment IS NOT NULL AND comment_ja IS NULL AND comment_en IS NULL;
    ALTER TABLE nagi.radio_tracks DROP COLUMN comment;
  END IF;
END $$;
