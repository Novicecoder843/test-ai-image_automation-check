-- Migration 003: Add batch_id to track bulk uploads

ALTER TABLE cleaning_verifications
ADD COLUMN batch_id VARCHAR(255);

CREATE INDEX idx_cleaning_verifications_batch_id
ON cleaning_verifications (batch_id);

ALTER TABLE cleaning_references
ADD COLUMN batch_id VARCHAR(255);

CREATE INDEX idx_cleaning_references_batch_id
ON cleaning_references (batch_id);
