-- =============================================================================
-- Scene match + percentage-based scoring
-- =============================================================================

-- Allow INVALID_TASK status (wrong area / wrong task photo)
ALTER TABLE cleaning_verifications
  DROP CONSTRAINT IF EXISTS cleaning_verifications_status_check;

ALTER TABLE cleaning_verifications
  ADD CONSTRAINT cleaning_verifications_status_check
  CHECK (status IN (
    'PENDING', 'PROCESSING', 'PASS', 'FAIL', 'MANUAL_REVIEW', 'ERROR', 'INVALID_TASK'
  ));

-- Percentage fields for dashboards and audit
ALTER TABLE cleaning_verifications
  ADD COLUMN IF NOT EXISTS scene_match_percent NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS cleanliness_percent INT,
  ADD COLUMN IF NOT EXISTS overall_percent NUMERIC(5,1);
