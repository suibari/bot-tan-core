-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
-- （これはスキーマ変更ではなくデータ移行なので、push では流れない。手で実行すること。）
--
-- author_id の名前空間を揃える。
--
-- この列には Nagi/Bluesky の did:plc:... と YouTube のチャンネルID UC... が
-- 印なしで同居していた。形式が違うので衝突はしていないが、こっそり投稿の可視判定が
-- author_id の一致に乗った（0059）以上、その偶然に依存したくない。
--
-- 名寄せはしない。同一人物が Nagi と YouTube で別人として扱われるのは意図的な割り切り。
--
-- 冪等。二度流しても youtube:youtube: にはならない。
-- 書き込み側は TS(normalizeMemorySubjectKey) と Python(live/memory.py の
-- normalize_subject_key) の両方を同時に出すこと。片方だけだと author_id での
-- 絞り込みが静かに0件になる。
UPDATE affirmative_bot.bot_memory_documents
   SET author_id = 'youtube:' || author_id
 WHERE source_type = 'youtube_live_comment'
   AND author_id IS NOT NULL
   AND author_id NOT LIKE 'youtube:%';
