-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 18歳未満の保護者同意の要件を廃止した。今後は書き込まないので、既存の自己申告日時も消す。
-- 列そのものは残し、削除は別に行う。
UPDATE nagi.age_assurance
SET parental_consent_at = NULL
WHERE parental_consent_at IS NOT NULL;
