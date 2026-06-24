# Reference Image Upload — API Design Document

End-to-end contract for **single upload** (per-slot mobile UI) and **batch upload** (Upload Multiple → tag carousel → Submit). Aligns with the mobile Facility Images screens, existing `{ success, results }` envelope, and current pipeline (preprocess → quality gate → optional scene validation → storage → CLIP → DB).

---

## Table of contents

1. [Overview](#1-overview)
2. [Shared conventions](#2-shared-conventions)
3. [Database schema](#3-database-schema)
4. [Supporting read APIs](#4-supporting-read-apis)
5. [Single upload](#5-single-upload)
6. [Batch upload](#6-batch-upload)
7. [Error codes catalog](#7-error-codes-catalog)
8. [Processing pipeline](#8-processing-pipeline)
9. [Mobile UI mapping](#9-mobile-ui-mapping)
10. [Implementation status](#10-implementation-status)

---

## 1. Overview

### Actors

| Actor | Action |
|-------|--------|
| Mobile admin app | Upload reference photos for a facility, tagged by category |
| API | Validate, process, persist references + batch/item audit |
| Worker | Async per-item processing for batch uploads |

### Endpoints summary

| Method | Path | Mode | Status |
|--------|------|------|--------|
| `GET` | `/api/upload-requirements` | Config | **Exists** |
| `GET` | `/api/templates/:templateId/reference-slots` | Slot config | **New** |
| `POST` | `/api/admin/upload-reference` | Single sync | **Exists** (extend metadata) |
| `POST` | `/api/admin/reference-batches` | Batch async | **New** |
| `GET` | `/api/admin/reference-batches/:batchId` | Poll batch (fallback) | **New** |
| `GET` | `/api/admin/reference-batches/:batchId/events` | SSE progress stream | **New** — see [`BATCH_UPLOAD_SSE.md`](./BATCH_UPLOAD_SSE.md) |
| `POST` | `/api/admin/reference-batches/:batchId/retry` | Retry failed items | **New** |
| `GET` | `/api/facilities/:facilityId/references` | List library | **New** |
| `DELETE` | `/api/admin/references/:referenceId` | Soft delete | **New** |

---

## 2. Shared conventions

### 2.1 Response envelope

**Success**

```json
{
  "success": true,
  "results": { }
}
```

**Failure (request-level — malformed batch, auth, etc.)**

```json
{
  "success": false,
  "error": "Human-readable message",
  "details": { }
}
```

**Item-level failure (batch only)** — HTTP still `200`/`202` on batch create; failures appear inside `items[]`, not as top-level `success: false`.

### 2.2 Shared types (TypeScript / JSON Schema)

```typescript
/** Maps to mobile "Image Tag" dropdown + slot label e.g. "Bathroom Floor" */
type ObjectCategory =
  | 'bathroom_floor'
  | 'commode'
  | 'sink_fittings'
  | 'hand_soap'
  | string; // extensible slug

interface ReferenceMetadata {
  /** Display tag — e.g. "Floor Cleaning", "Deep Cleaning" */
  label?: string;
  /** Slot/category slug — e.g. "bathroom_floor" → UI "Bathroom Floor" */
  object_category?: ObjectCategory;
  /** Optional extra tags */
  tags?: string[];
  /** Client-generated id for correlation (required for batch) */
  client_ref?: string;
}

interface QualityMetrics {
  width: number;
  height: number;
  megapixels: number;
  sharpness: number;
  brightness: number;
  entropy: number;
  bytes: number;
}

interface ItemError {
  code: ItemErrorCode;
  message: string;
  stage: PipelineStage;
  retriable: boolean;
  reasons?: string[];
  metrics?: QualityMetrics;
  hint?: string;
  /** Scene validation only */
  similarity?: number;
  required_min?: number;
  compared_to?: {
    reference_id?: number;
    object_category?: string;
    label?: string;
  };
}

type ItemErrorCode =
  | 'LOW_QUALITY_IMAGE'
  | 'INVALID_REFERENCE_SCENE'
  | 'UNSUPPORTED_MIME'
  | 'FILE_TOO_LARGE'
  | 'IMAGE_PREPROCESS_ERROR'
  | 'STORAGE_UPLOAD_ERROR'
  | 'CLIP_EMBEDDING_ERROR'
  | 'DB_INSERT_ERROR'
  | 'WORKER_EXHAUSTED';

type PipelineStage =
  | 'validate'
  | 'parse-input'
  | 'image-preprocess'
  | 'image-quality'
  | 'reference-scene-validation'
  | 'storage-upload'
  | 'clip-embedding'
  | 'db-insert';

type BatchStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
type ItemStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface ReferenceResult {
  id: number;
  facility_id: number;
  template_id: number | null;
  label: string | null;
  object_category: string | null;
  tags: string[];
  image_path: string;
  image_url: string;
  image_mime: string;
  image_width: number;
  image_height: number;
  image_bytes: number;
  embedding_dim: number;
  preprocess_ms: number;
  source_bytes: number;
  quality: QualityMetrics;
  created_at: string; // ISO 8601
}
```

### 2.3 Multipart rules

| Rule | Value |
|------|-------|
| Image field (single) | `image` |
| Image field (batch) | `images[]` (same order as `items` JSON) |
| Metadata (batch) | `items` — JSON string array |
| Max files per batch | `25` (configurable `REF_BATCH_MAX_ITEMS`) |
| Max file size | From `GET /upload-requirements` (`max_size_mb`, default 15) |
| Allowed MIME | From `GET /upload-requirements` |

---

## 3. Database schema

### 3.1 Extend `cleaning_references` (migration `003_reference_metadata.sql`)

```sql
ALTER TABLE cleaning_references
  ADD COLUMN IF NOT EXISTS object_category VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS batch_item_id UUID;

CREATE INDEX IF NOT EXISTS idx_cleaning_refs_facility_category
  ON cleaning_references (facility_id, template_id, object_category, is_active);
```

### 3.2 `reference_upload_batches`

```sql
CREATE TABLE reference_upload_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     INT NOT NULL,
    template_id     INT,
    uploaded_by     VARCHAR(100),
    status          VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED','PROCESSING','COMPLETED','PARTIAL','FAILED')),
    total_count     INT NOT NULL DEFAULT 0,
    succeeded_count INT NOT NULL DEFAULT 0,
    failed_count    INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ref_batches_facility ON reference_upload_batches (facility_id, created_at DESC);
```

### 3.3 `reference_upload_items`

```sql
CREATE TABLE reference_upload_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id            UUID NOT NULL REFERENCES reference_upload_batches(id) ON DELETE CASCADE,
    client_ref          VARCHAR(64) NOT NULL,
    sort_order          INT NOT NULL DEFAULT 0,
    original_filename   VARCHAR(500) NOT NULL,
    label               VARCHAR(255),
    object_category     VARCHAR(100),
    tags                JSONB NOT NULL DEFAULT '[]'::jsonb,
    status              VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED','PROCESSING','COMPLETED','FAILED','CANCELLED')),
    stage               VARCHAR(50),
    error_code          VARCHAR(50),
    error_message       TEXT,
    error_details       JSONB,
    staging_path        VARCHAR(500),
    reference_id        BIGINT REFERENCES cleaning_references(id) ON DELETE SET NULL,
    attempts            INT NOT NULL DEFAULT 0,
    bull_job_id         VARCHAR(120),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at        TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (batch_id, client_ref)
);

CREATE INDEX idx_ref_items_batch ON reference_upload_items (batch_id, sort_order);
CREATE INDEX idx_ref_items_status ON reference_upload_items (batch_id, status);
```

### 3.4 `reference_slot_templates` (optional — drives empty slots in UI)

```sql
CREATE TABLE reference_slot_templates (
    id              SERIAL PRIMARY KEY,
    template_id     INT NOT NULL,
    object_category VARCHAR(100) NOT NULL,
    display_name    VARCHAR(255) NOT NULL,
    sort_order      INT NOT NULL DEFAULT 0,
    required        BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (template_id, object_category)
);
```

---

## 4. Supporting read APIs

### 4.1 `GET /api/upload-requirements`

**Exists today.** Mobile should use this for file-type/size copy (not hardcoded 5 MB).

**Response `200`**

```json
{
  "success": true,
  "results": {
    "upload": {
      "max_size_mb": 15,
      "allowed_mime_types": ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]
    },
    "preprocess": { "max_dimension_px": 1024, "output_format": "jpeg", "output_quality": 80 },
    "quality_gate": {
      "enforce": true,
      "min_dimension_px": 480,
      "min_megapixels": 0.3,
      "min_sharpness": 2.0,
      "min_brightness": 25,
      "max_brightness": 235,
      "min_entropy": 2.5,
      "min_bytes": 15360
    },
    "scene_match": {
      "enforce": true,
      "min_similarity": 0.88,
      "strict_template": true,
      "template_id_required": true
    },
    "batch": {
      "max_items": 25,
      "poll_interval_ms": 1500
    },
    "tips": ["Hold the camera steady and ensure good lighting.", "..."]
  }
}
```

### 4.2 `GET /api/templates/:templateId/reference-slots`

Powers Screen 1 empty slots (`Bathroom Floor`, `Commode`, …).

**Response `200`**

```json
{
  "success": true,
  "results": {
    "template_id": 168,
    "template_name": "Male Washroom",
    "slots": [
      {
        "object_category": "bathroom_floor",
        "display_name": "Bathroom Floor",
        "required": true,
        "sort_order": 1
      },
      {
        "object_category": "commode",
        "display_name": "Commode",
        "required": true,
        "sort_order": 2
      },
      {
        "object_category": "sink_fittings",
        "display_name": "Wipe Sink & Fittings",
        "required": false,
        "sort_order": 3
      }
    ]
  }
}
```

### 4.3 `GET /api/templates/:templateId/reference-categories`

Powers Screen 2 tag dropdown in bulk carousel.

**Response `200`**

```json
{
  "success": true,
  "results": {
    "template_id": 168,
    "categories": [
      { "object_category": "bathroom_floor", "display_name": "Bathroom Floor" },
      { "object_category": "commode", "display_name": "Commode" },
      { "object_category": "floor_cleaning", "display_name": "Floor Cleaning" },
      { "object_category": "deep_cleaning", "display_name": "Deep Cleaning" }
    ]
  }
}
```

---

## 5. Single upload

For **one slot** tap → pick photo → immediate upload (Screen 1 per-slot flow).

### 5.1 `POST /api/admin/upload-reference`

**Content-Type:** `multipart/form-data`

#### Request fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | file | yes | Single image |
| `facility_id` | integer | yes | Facility scope |
| `template_id` | integer | no | Task/area template (recommended) |
| `label` | string | no | Display tag, max 255 |
| `object_category` | string | no | Slot slug, e.g. `bathroom_floor` |
| `tags` | string (JSON) | no | `["floor","deep-clean"]` |
| `client_ref` | string | no | Client correlation id |
| `uploaded_by` | string | no | Admin user id |

#### Sample request (cURL)

```bash
curl -X POST http://localhost:4000/api/admin/upload-reference \
  -F 'image=@washroom-floor.jpg' \
  -F 'facility_id=42' \
  -F 'template_id=168' \
  -F 'label=Floor Cleaning' \
  -F 'object_category=bathroom_floor' \
  -F 'tags=["floor","standard"]' \
  -F 'client_ref=slot-bathroom-floor-001' \
  -F 'uploaded_by=admin@example.com'
```

#### Zod validation schema

```typescript
const singleUploadBody = z.object({
  facility_id: z.coerce.number().int().positive(),
  template_id: z.coerce.number().int().positive().optional(),
  label: z.string().min(1).max(255).optional(),
  object_category: z.string().min(1).max(100).optional(),
  tags: z
    .string()
    .optional()
    .transform((s) => (s ? JSON.parse(s) : []))
    .pipe(z.array(z.string().max(50)).max(10)),
  client_ref: z.string().max(64).optional(),
  uploaded_by: z.string().max(100).optional(),
});
```

#### Success response `201 Created`

```json
{
  "success": true,
  "results": {
    "id": 101,
    "facility_id": 42,
    "template_id": 168,
    "label": "Floor Cleaning",
    "object_category": "bathroom_floor",
    "tags": ["floor", "standard"],
    "client_ref": "slot-bathroom-floor-001",
    "image_path": "cleaning/references/f42_1716457800_x9k2qf_washroom-floor.jpg",
    "image_url": "http://localhost:4000/files/cleaning/references/f42_1716457800_x9k2qf_washroom-floor.jpg",
    "image_mime": "image/jpeg",
    "image_width": 1024,
    "image_height": 768,
    "image_bytes": 142318,
    "embedding_dim": 512,
    "preprocess_ms": 41,
    "source_bytes": 3287654,
    "quality": {
      "width": 1024,
      "height": 768,
      "megapixels": 0.79,
      "sharpness": 4.2,
      "brightness": 128.5,
      "entropy": 6.1,
      "bytes": 142318
    },
    "created_at": "2026-06-23T10:15:00.000Z"
  }
}
```

#### Error responses

**400 — missing file**

```json
{
  "success": false,
  "error": "[parse-input] image file is required (form field \"image\")"
}
```

**400 — invalid body**

```json
{
  "success": false,
  "error": "[parse-input] Invalid body",
  "details": {
    "facility_id": { "_errors": ["Expected number, received nan"] }
  }
}
```

**413 — file too large**

```json
{
  "success": false,
  "error": "File too large",
  "details": {
    "code": "FILE_TOO_LARGE",
    "max_size_mb": 15
  }
}
```

**422 — quality gate failed**

```json
{
  "success": false,
  "error": "[image-quality] Image quality too low — please retake the photo",
  "details": {
    "code": "LOW_QUALITY_IMAGE",
    "stage": "image-quality",
    "retriable": true,
    "reasons": ["image_too_dark", "image_blurry"],
    "metrics": {
      "width": 1024,
      "height": 768,
      "megapixels": 0.79,
      "sharpness": 1.1,
      "brightness": 18.4,
      "entropy": 3.9,
      "bytes": 142318
    },
    "hint": "Turn on more lights or move to a brighter area before retaking.",
    "client_ref": "slot-bathroom-floor-001",
    "label": "Floor Cleaning",
    "object_category": "bathroom_floor",
    "original_filename": "washroom-floor.jpg"
  }
}
```

**422 — reference scene validation failed** *(new, optional)*

```json
{
  "success": false,
  "error": "[reference-scene-validation] Photo does not match the declared area",
  "details": {
    "code": "INVALID_REFERENCE_SCENE",
    "stage": "reference-scene-validation",
    "retriable": true,
    "similarity": 0.42,
    "required_min": 0.88,
    "compared_to": {
      "reference_id": 99,
      "object_category": "bathroom_floor",
      "label": "Anchor floor shot"
    },
    "hint": "Use a photo of the same area as other references for this template.",
    "client_ref": "slot-bathroom-floor-001",
    "label": "Floor Cleaning",
    "object_category": "bathroom_floor",
    "original_filename": "kitchen-floor.jpg"
  }
}
```

#### Single upload sequence

```
Mobile                    API                         Worker
  |                        |                            |
  |-- POST upload-reference (1 file) ----------------->|
  |                        |-- preprocess               |
  |                        |-- quality gate             |
  |                        |-- scene validation (opt)   |
  |                        |-- storage + CLIP + INSERT   |
  |<-- 201 or 422 -------------------------------------|
  |  update slot UI        |                            |
```

---

## 6. Batch upload

For **Upload Multiple → tag carousel → Submit** (Screens 2–4).

### 6.1 `POST /api/admin/reference-batches`

**Content-Type:** `multipart/form-data`

#### Request fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `facility_id` | integer | yes | Shared facility |
| `template_id` | integer | no | Shared template |
| `uploaded_by` | string | no | Admin user |
| `items` | JSON string | yes | Metadata array, one entry per file |
| `images[]` | files | yes | Must match `items.length`, same order |

#### `items` JSON schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "minItems": 1,
  "maxItems": 25,
  "items": {
    "type": "object",
    "required": ["client_ref", "object_category"],
    "properties": {
      "client_ref": { "type": "string", "minLength": 1, "maxLength": 64 },
      "original_filename": { "type": "string", "maxLength": 500 },
      "label": { "type": "string", "maxLength": 255 },
      "object_category": { "type": "string", "maxLength": 100 },
      "tags": {
        "type": "array",
        "items": { "type": "string", "maxLength": 50 },
        "maxItems": 10
      },
      "sort_order": { "type": "integer", "minimum": 0 }
    },
    "additionalProperties": false
  }
}
```

#### Sample request body (logical)

```
facility_id=42
template_id=168
uploaded_by=admin@example.com
items=[
  {
    "client_ref": "uuid-001",
    "original_filename": "IMG256123.jpg",
    "label": "Floor Cleaning",
    "object_category": "bathroom_floor",
    "tags": ["floor"],
    "sort_order": 0
  },
  {
    "client_ref": "uuid-002",
    "original_filename": "WhatsApp_32193242341.jpg",
    "label": "Deep Cleaning",
    "object_category": "commode",
    "tags": ["commode"],
    "sort_order": 1
  }
]
images[]=@IMG256123.jpg
images[]=@WhatsApp_32193242341.jpg
```

#### Sample cURL

```bash
curl -X POST http://localhost:4000/api/admin/reference-batches \
  -F 'facility_id=42' \
  -F 'template_id=168' \
  -F 'uploaded_by=admin@example.com' \
  -F 'items=[{"client_ref":"uuid-001","original_filename":"IMG256123.jpg","label":"Floor Cleaning","object_category":"bathroom_floor","sort_order":0},{"client_ref":"uuid-002","original_filename":"WhatsApp_32193242341.jpg","label":"Deep Cleaning","object_category":"commode","sort_order":1}]' \
  -F 'images[]=@IMG256123.jpg' \
  -F 'images[]=@WhatsApp_32193242341.jpg'
```

#### Success response `202 Accepted`

```json
{
  "success": true,
  "results": {
    "batch_id": "b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c",
    "status": "QUEUED",
    "facility_id": 42,
    "template_id": 168,
    "total_count": 2,
    "succeeded_count": 0,
    "failed_count": 0,
    "events_url": "/api/admin/reference-batches/b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c/events",
    "poll_url": "/api/admin/reference-batches/b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c",
    "poll_interval_ms": 1500,
    "items": [
      {
        "item_id": "i1111111-1111-1111-1111-111111111111",
        "client_ref": "uuid-001",
        "original_filename": "IMG256123.jpg",
        "label": "Floor Cleaning",
        "object_category": "bathroom_floor",
        "status": "QUEUED"
      },
      {
        "item_id": "i2222222-2222-2222-2222-222222222222",
        "client_ref": "uuid-002",
        "original_filename": "WhatsApp_32193242341.jpg",
        "label": "Deep Cleaning",
        "object_category": "commode",
        "status": "QUEUED"
      }
    ],
    "created_at": "2026-06-23T10:20:00.000Z"
  }
}
```

#### Request-level errors

**400 — count mismatch**

```json
{
  "success": false,
  "error": "[parse-input] images count (3) must match items count (2)",
  "details": { "code": "BATCH_COUNT_MISMATCH" }
}
```

**400 — duplicate client_ref**

```json
{
  "success": false,
  "error": "[parse-input] Duplicate client_ref in batch",
  "details": { "code": "DUPLICATE_CLIENT_REF", "client_ref": "uuid-001" }
}
```

---

### 6.2 `GET /api/admin/reference-batches/:batchId`

Poll until `status` is terminal: `COMPLETED` | `PARTIAL` | `FAILED`.

#### Response `200` — in progress

```json
{
  "success": true,
  "results": {
    "batch_id": "b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c",
    "status": "PROCESSING",
    "facility_id": 42,
    "template_id": 168,
    "progress": {
      "total": 12,
      "queued": 5,
      "processing": 1,
      "completed": 4,
      "failed": 2,
      "succeeded": 4
    },
    "items": [
      {
        "item_id": "i1111111-1111-1111-1111-111111111111",
        "client_ref": "uuid-001",
        "original_filename": "IMG256123.jpg",
        "label": "Floor Cleaning",
        "object_category": "bathroom_floor",
        "status": "COMPLETED",
        "reference_id": 101,
        "processed_at": "2026-06-23T10:20:03.000Z"
      },
      {
        "item_id": "i2222222-2222-2222-2222-222222222222",
        "client_ref": "uuid-002",
        "original_filename": "dark-floor.jpg",
        "label": "Deep Cleaning",
        "object_category": "commode",
        "status": "FAILED",
        "stage": "image-quality",
        "error": {
          "code": "LOW_QUALITY_IMAGE",
          "message": "Image quality too low — please retake the photo",
          "stage": "image-quality",
          "retriable": true,
          "reasons": ["image_too_dark"],
          "metrics": {
            "width": 1024,
            "height": 768,
            "megapixels": 0.79,
            "sharpness": 1.1,
            "brightness": 18.4,
            "entropy": 3.9,
            "bytes": 142318
          },
          "hint": "Turn on more lights or move to a brighter area before retaking."
        },
        "processed_at": "2026-06-23T10:20:04.000Z"
      }
    ],
    "created_at": "2026-06-23T10:20:00.000Z",
    "completed_at": null
  }
}
```

#### Response `200` — finished (partial — powers Screen 4 error modal)

```json
{
  "success": true,
  "results": {
    "batch_id": "b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c",
    "status": "PARTIAL",
    "facility_id": 42,
    "template_id": 168,
    "progress": {
      "total": 4,
      "queued": 0,
      "processing": 0,
      "completed": 4,
      "failed": 2,
      "succeeded": 2
    },
    "failed_items": [
      {
        "item_id": "i3333333-3333-3333-3333-333333333333",
        "original_filename": "IMG256123",
        "label": "Floor Cleaning",
        "object_category": "bathroom_floor",
        "error": {
          "code": "UNSUPPORTED_MIME",
          "message": "We could not upload the following images. Please upload JPG/PNG files under 5 MB.",
          "stage": "validate",
          "retriable": true,
          "hint": "Convert the file to JPG or PNG and try again."
        }
      },
      {
        "item_id": "i4444444-4444-4444-4444-444444444444",
        "original_filename": "WhatsApp_32193242341",
        "label": "Sweeping",
        "object_category": "floor_cleaning",
        "error": {
          "code": "INVALID_REFERENCE_SCENE",
          "message": "Photo does not match the declared area",
          "stage": "reference-scene-validation",
          "retriable": true,
          "similarity": 0.51,
          "required_min": 0.88,
          "hint": "Retake the photo in the correct facility area."
        }
      }
    ],
    "items": [ "..." ],
    "created_at": "2026-06-23T10:20:00.000Z",
    "completed_at": "2026-06-23T10:20:45.000Z"
  }
}
```

**UI binding for Screen 4 error modal table:**

| File Name | Image Tag | Source field |
|-----------|-----------|--------------|
| `IMG256123` | Floor Cleaning | `failed_items[].original_filename` + `label` |
| `WhatsApp_32193242341` | Sweeping | same |

---

### 6.3 `POST /api/admin/reference-batches/:batchId/retry`

Retry **failed items only** with replacement files.

**Content-Type:** `multipart/form-data`

| Field | Type | Required |
|-------|------|----------|
| `items` | JSON string | yes — `[{ "item_id": "...", "client_ref": "..." }]` |
| `images[]` | files | yes — one per retry item |

#### Request

```bash
curl -X POST http://localhost:4000/api/admin/reference-batches/b7c2a1f0-.../retry \
  -F 'items=[{"item_id":"i2222222-2222-2222-2222-222222222222","client_ref":"uuid-002"}]' \
  -F 'images[]=@retake-commode.jpg'
```

#### Response `202 Accepted`

```json
{
  "success": true,
  "results": {
    "batch_id": "b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c",
    "status": "PROCESSING",
    "retried_item_ids": ["i2222222-2222-2222-2222-222222222222"],
    "poll_url": "/api/admin/reference-batches/b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c"
  }
}
```

---

### 6.4 Batch processing sequence

```
Mobile                         API                    DB              Worker
  |                             |                      |                |
  |-- POST reference-batches -->|                      |                |
  |                             |-- INSERT batch/items |                |
  |                             |-- stage bytes        |                |
  |                             |-- enqueue N jobs     |                |
  |<-- 202 batch_id ------------|                      |                |
  |                             |                      |                |
  |-- GET batch (poll) -------->|                      |                |
  |<-- PROCESSING 3/12 ---------|                      |                |
  |                             |                      |<-- job item ---|
  |                             |                      |    preprocess  |
  |                             |                      |    quality     |
  |                             |                      |    scene check |
  |                             |                      |    store+CLIP  |
  |                             |                      |    UPDATE item |
  |                             |                      |                |
  |-- GET batch (poll) -------->|                      |                |
  |<-- PARTIAL + failed_items --|                      |                |
  |  show error modal           |                      |                |
  |-- POST retry -------------->|                      |                |
  |<-- 202, poll again ---------|                      |                |
  |<-- COMPLETED --------------|                      |                |
  |  navigate Next              |                      |                |
```

---

## 7. Error codes catalog

| Code | HTTP (single) | Item status (batch) | Retriable | Mobile message |
|------|---------------|---------------------|-----------|----------------|
| `FILE_TOO_LARGE` | 413 | FAILED | yes | File exceeds max size |
| `UNSUPPORTED_MIME` | 400 | FAILED | yes | Use JPG/PNG (per upload-requirements) |
| `LOW_QUALITY_IMAGE` | 422 | FAILED | yes | Retake — too dark/blurry |
| `INVALID_REFERENCE_SCENE` | 422 | FAILED | yes | Wrong area for this tag |
| `IMAGE_PREPROCESS_ERROR` | 400 | FAILED | yes | Corrupt or unreadable image |
| `STORAGE_UPLOAD_ERROR` | 500 | FAILED | yes | Try again |
| `CLIP_EMBEDDING_ERROR` | 500 | FAILED | yes | Server busy — retry |
| `DB_INSERT_ERROR` | 500 | FAILED | yes | Try again |
| `WORKER_EXHAUSTED` | — | FAILED | yes | Max retries reached |
| `BATCH_COUNT_MISMATCH` | 400 | — | — | Client bug |
| `DUPLICATE_CLIENT_REF` | 400 | — | — | Client bug |

---

## 8. Processing pipeline

Same stages for single (sync) and batch (async per item):

| Step | Stage | On fail |
|------|-------|---------|
| 1 | `validate` | MIME / size / required fields |
| 2 | `image-preprocess` | sharp decode/resize |
| 3 | `image-quality` | `LOW_QUALITY_IMAGE` |
| 4 | `reference-scene-validation` | Compare to anchor ref or template refs → `INVALID_REFERENCE_SCENE` |
| 5 | `storage-upload` | Write to object storage |
| 6 | `clip-embedding` | CLIP 512-dim vector |
| 7 | `db-insert` | Insert `cleaning_references`, link `reference_id` on item |

**Scene validation rule (reference upload):**

- If other active refs exist for `(facility_id, template_id)`: new image cosine ≥ `SCENE_MATCH_MIN_SIMILARITY` vs best existing ref **or** first completed item in same batch (anchor).
- First item in batch becomes anchor when no prior refs exist.

---

## 9. Mobile UI mapping

| Screen / action | API call |
|-----------------|----------|
| Load empty slots | `GET /templates/:id/reference-slots` |
| Load tag dropdown | `GET /templates/:id/reference-categories` |
| Load file limits | `GET /upload-requirements` |
| Tap one slot → upload | `POST /admin/upload-reference` |
| Upload Multiple → tag → Submit | `POST /admin/reference-batches` |
| Progress overlay | SSE `GET /reference-batches/:id/events` (fallback: poll `GET /reference-batches/:id`) |
| Error modal table | `results.failed_items[]` or filter `items` where `status=FAILED` |
| Retry failed | `POST /reference-batches/:id/retry` |
| Trash icon (after save) | `DELETE /admin/references/:id` |
| Next (enabled when done) | `batch.status === COMPLETED` OR required slots all `COMPLETED` |

### Batch status → UI

| `batch.status` | UI behavior |
|----------------|-------------|
| `QUEUED` / `PROCESSING` | Show progress; disable Next |
| `COMPLETED` | Enable Next |
| `PARTIAL` | Show error modal + Retry; block Next until required slots OK |
| `FAILED` | Show error modal; all items failed |

---

## 10. Implementation status

| Piece | Status |
|-------|--------|
| `POST /admin/upload-reference` | Implemented (needs `object_category`, `tags`, richer 422 `details`) |
| `GET /upload-requirements` | Implemented |
| Batch tables + worker | **Not implemented** |
| `POST/GET reference-batches` | **Not implemented** |
| Batch SSE progress (`GET …/events`) | **Not implemented** — design: [`BATCH_UPLOAD_SSE.md`](./BATCH_UPLOAD_SSE.md) |
| Reference slots/categories API | **Not implemented** |
| `DELETE` reference | **Not implemented** |
| Reference scene validation on admin upload | **Not implemented** |

---

## Related documents

- [`DESIGN.md`](../DESIGN.md) — system architecture and verification flows
- [`BATCH_UPLOAD_SSE.md`](./BATCH_UPLOAD_SSE.md) — real-time batch progress via Server-Sent Events
- [`README.md`](../README.md) — install, run, and current API reference
