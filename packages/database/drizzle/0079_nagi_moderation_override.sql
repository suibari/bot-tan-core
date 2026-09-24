-- Discord の解除ボタンによる判定の上書き。override_cid と一致する間だけ効く。
ALTER TABLE "nagi"."moderation_decisions"
  ADD COLUMN IF NOT EXISTS "override" text,
  ADD COLUMN IF NOT EXISTS "override_cid" text,
  ADD COLUMN IF NOT EXISTS "override_by" text,
  ADD COLUMN IF NOT EXISTS "override_at" timestamptz;
