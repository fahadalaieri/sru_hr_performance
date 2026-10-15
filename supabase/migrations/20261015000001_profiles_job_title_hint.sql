-- 2026-10-15 — staff bulk onboarding
-- (docs/superpowers/specs/2026-10-15-staff-bulk-onboarding-design.md §4-ب item 4).
--
-- The HR file carries free-text job titles (189 distinct) that do not match
-- the platform's 280 official titles. They are kept as a HINT for the platform
-- admin to confirm against the official list, never turned into job_titles rows.
BEGIN;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_title_hint text;
COMMENT ON COLUMN profiles.job_title_hint IS 'Free-text title from the HR import (or the SSO directory); shown next to the official title picker until a job_title_id is chosen. Never a source of truth.';

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'job_title_hint';

COMMIT;
