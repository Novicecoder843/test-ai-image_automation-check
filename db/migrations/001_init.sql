-- =============================================================================
-- Cleaning Verification POC — initial schema (pgvector)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- cleaning_references
-- Admin-uploaded clean-state reference images with CLIP embeddings.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cleaning_references (
    id              BIGSERIAL PRIMARY KEY,
    facility_id     INT NOT NULL,
    template_id     INT,
    label           VARCHAR(255),
    image_path      VARCHAR(500) NOT NULL,    -- storage object key (no host)
    image_url       VARCHAR(1000),            -- resolved public URL
    image_mime      VARCHAR(64),              -- mimetype written to storage
    image_width     INT,
    image_height    INT,
    image_bytes     INT,
    embedding       vector(512) NOT NULL,     -- CLIP ViT-B/32 → 512 dims
    uploaded_by     VARCHAR(100),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cleaning_refs_facility
    ON cleaning_references (facility_id, is_active);

CREATE INDEX IF NOT EXISTS idx_cleaning_refs_facility_template
    ON cleaning_references (facility_id, template_id, is_active);

-- Cosine ANN index (best-effort; requires pgvector ≥ 0.5)
DO $$
BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_cleaning_refs_embed_cosine
             ON cleaning_references
             USING ivfflat (embedding vector_cosine_ops)
             WITH (lists = 100)';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ivfflat index not created (%): pgvector may be < 0.5', SQLERRM;
END$$;

-- -----------------------------------------------------------------------------
-- cleaning_verifications
-- Janitor completion image + AI verdict per task.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cleaning_verifications (
    id                  BIGSERIAL PRIMARY KEY,
    task_id             INT NOT NULL,
    facility_id         INT NOT NULL,
    template_id         INT,
    reference_id        BIGINT REFERENCES cleaning_references(id) ON DELETE SET NULL,
    janitor_id          VARCHAR(100),
    image_path          VARCHAR(500) NOT NULL,
    image_url           VARCHAR(1000),
    image_mime          VARCHAR(64),
    image_width         INT,
    image_height        INT,
    image_bytes         INT,
    embedding           vector(512),
    similarity_score    NUMERIC(6,4),
    vision_passed       BOOLEAN,
    vision_score        INT,
    vision_confidence   INT,
    vision_issues       JSONB,
    vision_raw          JSONB,
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','PROCESSING','PASS','FAIL','MANUAL_REVIEW','ERROR')),
    rule_reason         TEXT,
    bull_job_id         VARCHAR(120),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cleaning_verif_task
    ON cleaning_verifications (task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cleaning_verif_status
    ON cleaning_verifications (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cleaning_verif_facility
    ON cleaning_verifications (facility_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- migrations bookkeeping
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
