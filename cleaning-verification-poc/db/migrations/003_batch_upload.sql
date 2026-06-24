ALTER TABLE cleaning_references ADD COLUMN IF NOT EXISTS batch_id UUID;
ALTER TABLE cleaning_verifications ADD COLUMN IF NOT EXISTS batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_cleaning_refs_batch ON cleaning_references (batch_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_verif_batch ON cleaning_verifications (batch_id);
