# Cleaning Verification POC

Standalone Node.js / TypeScript proof of concept for an **AI facility-cleaning verification** workflow:

```
Admin uploads reference image
        │
        ▼
 store in GCS / local FS
        │
        ▼
 generate CLIP embedding (Xenova/clip-vit-base-patch32)
        │
        ▼
 store in PostgreSQL + pgvector
========================================================
Janitor uploads completion image
        │
        ▼
 store image + insert PENDING row
        │
        ▼
 BullMQ job → cleaning worker
        │
        ▼
 CLIP embed → cosine vs references
        │
        ▼
 GPT-4o Vision (strict JSON verdict)
        │
        ▼
 Rule engine → PASS / FAIL / MANUAL_REVIEW
        │
        ▼
 result persisted; GET /api/tasks/:id/result
```

No coupling with the main Woloo repo. All you need is **Docker + Node 18+** to run end-to-end on your machine.

---

## 1. Folder layout

```
cleaning-verification-poc/
├── .env.example
├── docker-compose.yml         (postgres+pgvector, redis)
├── package.json
├── tsconfig.json
├── db/migrations/001_init.sql
├── scripts/
│   ├── test-admin-upload.sh
│   ├── test-janitor-upload.sh
│   ├── test-get-result.sh
│   └── poll-result.sh
├── src/
│   ├── index.ts                          (API entrypoint)
│   ├── app.ts                            (Express app builder)
│   ├── config/{env,logger}.ts            (zod-validated env + pino)
│   ├── db/{pool,migrate}.ts              (pg pool + SQL migrate runner)
│   ├── queue/{redis,cleaning.queue}.ts   (ioredis + BullMQ queue)
│   ├── storage/index.ts                  (local + GCS adapters)
│   ├── middlewares/{upload,error-handler}.ts
│   ├── services/
│   │   ├── embedding.service.ts          (CLIP @xenova/transformers)
│   │   ├── vision.service.ts             (GPT-4o Vision)
│   │   ├── similarity.service.ts         (cosine)
│   │   ├── rule-engine.service.ts        (PASS/FAIL/MANUAL_REVIEW)
│   │   └── cleaning.service.ts           (orchestrator)
│   ├── repositories/
│   │   ├── cleaning-reference.repo.ts
│   │   └── cleaning-verification.repo.ts
│   ├── controllers/cleaning.controller.ts
│   ├── routes/index.ts
│   └── workers/
│       ├── cleaning.worker.ts            (BullMQ worker)
│       └── start.ts                      (standalone worker process)
├── test-images/                          (drop sample images here, git-ignored)
└── uploads/                              (local storage driver target, git-ignored)
```

---

## 2. Setup

### 2.1 Prerequisites

- Node.js **>= 18.18**
- Docker + Docker Compose (only for the bundled Postgres + Redis)
- An **OpenAI API key** (only needed for GPT-4o Vision; without it, jobs still run but vision step fails and verifications land in `MANUAL_REVIEW`)

### 2.2 Install

```bash
cd cleaning-verification-poc
cp .env.example .env
# edit .env → set OPENAI_API_KEY
npm install
```

### 2.3 Start infra

```bash
npm run infra:up        # postgres+pgvector + redis via docker
npm run migrate         # creates pgvector ext + tables
```

### 2.4 Run

```bash
npm run dev             # API + worker (default RUN_WORKER_IN_API=true)
```

You should see:

```
INFO  postgres connected { db: "cleaning_poc", pgVersion: "16.x" }
INFO  API listening { port: 4000, storage: "local" }
INFO  cleaning worker started { queue: "cleaning-verification-queue", concurrency: 2 }
```

> The first request that needs CLIP triggers a one-time ~150 MB model download
> under `node_modules/@xenova/transformers/.cache`. Subsequent runs are instant.

### 2.5 (Optional) Run worker as a separate process

If you'd rather scale the worker independently:

```env
# .env
RUN_WORKER_IN_API=false
```

```bash
# in one terminal
npm run dev
# in another
npm run dev:worker
```

---

## 3. API

All routes are under `/api`.

| Method | Path                                  | Purpose                                         |
| ------ | ------------------------------------- | ----------------------------------------------- |
| POST   | `/admin/upload-reference`             | Save reference image + CLIP embedding           |
| POST   | `/janitor/upload-completion`          | Save completion image + queue AI verification   |
| GET    | `/tasks/:taskId/result`               | Latest verification result (with `?includeHistory=true` for full history) |
| GET    | `/health`                             | DB ping                                         |
| GET    | `/queue-stats`                        | BullMQ counts                                   |

### 3.1 `POST /api/admin/upload-reference`

`multipart/form-data`:

| Field         | Type    | Required | Notes                                            |
| ------------- | ------- | -------- | ------------------------------------------------ |
| `image`       | file    | yes      | jpg / jpeg / png / webp / heic / heif (≤ 15 MB)  |
| `facility_id` | integer | yes      |                                                  |
| `template_id` | integer | no       | Scope reference to template                      |
| `label`       | string  | no       | Free-form tag                                    |
| `uploaded_by` | string  | no       | Free-form admin id                               |

**cURL**

```bash
curl -X POST http://localhost:4000/api/admin/upload-reference \
  -F 'image=@test-images/ref-washroom-clean.jpg' \
  -F 'facility_id=42' \
  -F 'template_id=168' \
  -F 'label=male-washroom-after-cleaning'
```

**Response (201)**

```json
{
  "success": true,
  "results": {
    "id": 1,
    "facility_id": 42,
    "template_id": 168,
    "image_path": "cleaning/references/f42_1716457800_x9k2qf_ref.jpg",
    "image_url": "http://localhost:4000/files/cleaning/references/f42_1716457800_x9k2qf_ref.jpg",
    "image_mime": "image/jpeg",
    "image_width": 1024,
    "image_height": 768,
    "image_bytes": 142318,
    "label": "male-washroom-after-cleaning",
    "embedding_dim": 512,
    "preprocess_ms": 41,
    "source_bytes": 3287654
  }
}
```

### 3.2 `POST /api/janitor/upload-completion`

`multipart/form-data`:

| Field         | Type    | Required | Notes                                           |
| ------------- | ------- | -------- | ----------------------------------------------- |
| `image`       | file    | yes      | jpg / jpeg / png / webp / heic / heif (≤ 15 MB) |
| `task_id`     | integer | yes      |                                                 |
| `facility_id` | integer | yes      |                                                 |
| `template_id` | integer | no       |                                                 |
| `janitor_id`  | string  | no       |                                                 |

**cURL**

```bash
curl -X POST http://localhost:4000/api/janitor/upload-completion \
  -F 'image=@test-images/completion-good.jpg' \
  -F 'task_id=9001' \
  -F 'facility_id=42' \
  -F 'template_id=168' \
  -F 'janitor_id=jane.doe'
```

**Response (202)** — request returns immediately while the worker processes in the background:

```json
{
  "success": true,
  "results": {
    "verification_id": 7,
    "task_id": 9001,
    "status": "PENDING",
    "image_path": "cleaning/completions/t9001_f42_1716458100_a7d3bm_x.jpg",
    "image_url": "http://localhost:4000/files/cleaning/completions/t9001_f42_1716458100_a7d3bm_x.jpg",
    "image_mime": "image/jpeg",
    "image_width": 1024,
    "image_height": 768,
    "image_bytes": 138942,
    "bull_job_id": "cleaning-verify-1716458100123-7f3a9b21",
    "queued_at": "2026-06-03T11:15:00.000Z",
    "preprocess_ms": 37,
    "source_bytes": 3104872
  }
}
```

### 3.3 `GET /api/tasks/:taskId/result`

**Success — 200 (PASS)**

```json
{
  "success": true,
  "results": {
    "verification_id": 7,
    "task_id": 9001,
    "facility_id": 42,
    "template_id": 168,
    "reference_id": 1,
    "status": "PASS",
    "image_url": "http://localhost:4000/files/cleaning/completions/...",
    "similarity_score": 0.9132,
    "vision": {
      "passed": true,
      "score": 91,
      "confidence": 94,
      "issues": []
    },
    "rule_reason": "similarity 0.913 > pass_threshold 0.85 and vision passed",
    "error_message": null,
    "bull_job_id": "cleaning-verify-...",
    "created_at": "2026-06-03T11:15:00.000Z",
    "processed_at": "2026-06-03T11:15:08.421Z"
  }
}
```

**FAIL**

```json
{
  "success": true,
  "results": {
    "status": "FAIL",
    "similarity_score": 0.5821,
    "vision": {
      "passed": false,
      "score": 32,
      "confidence": 88,
      "issues": ["trash near sink", "wet floor", "overflowing bin"]
    },
    "rule_reason": "similarity 0.582 < fail_threshold 0.65"
  }
}
```

**MANUAL_REVIEW**

```json
{
  "success": true,
  "results": {
    "status": "MANUAL_REVIEW",
    "similarity_score": 0.7402,
    "vision": {
      "passed": true,
      "score": 72,
      "confidence": 60,
      "issues": ["minor dust on counter"]
    },
    "rule_reason": "similarity 0.740 in [0.65, 0.85] or vision verdict not pass (passed=true, confidence=60)"
  }
}
```

---

## 4. End-to-end smoke test (3 commands)

```bash
# 1. Boot infra + app
npm run infra:up && npm run migrate && npm run dev &

# 2. Upload reference (do once per facility)
./scripts/test-admin-upload.sh 42 test-images/ref.jpg

# 3. Upload a completion and poll for the verdict
./scripts/test-janitor-upload.sh 9001 42 test-images/completion.jpg
./scripts/poll-result.sh 9001
```

---

## 5. Configuration cheatsheet (`.env`)

| Variable                              | Default                            | Notes |
| ------------------------------------- | ---------------------------------- | ----- |
| `PORT`                                | `4000`                             |       |
| `LOG_LEVEL`                           | `info`                             | `debug` for noisier output |
| `STORAGE_DRIVER`                      | `local`                            | `local` or `gcs` |
| `PUBLIC_BASE_URL`                     | `http://localhost:4000`            | used to build `/files/...` URLs |
| `GCS_BUCKET_NAME`                     | —                                  | when `STORAGE_DRIVER=gcs` |
| `CLIP_MODEL_NAME`                     | `Xenova/clip-vit-base-patch32`     | **no quotes / no inline `#` comments** |
| `VISION_PROVIDER`                     | `anthropic`                        | `anthropic` (Claude) or `openai` (GPT-4o) |
| `ANTHROPIC_API_KEY`                   | —                                  | required when `VISION_PROVIDER=anthropic` |
| `ANTHROPIC_VISION_MODEL`              | `claude-sonnet-4-5`                | any Claude vision model your key allows |
| `ANTHROPIC_API_URL`                   | `https://api.anthropic.com/v1/messages` | |
| `ANTHROPIC_VERSION`                   | `2023-06-01`                       | Anthropic-Version header |
| `ANTHROPIC_TIMEOUT_MS`                | `45000`                            |       |
| `ANTHROPIC_MAX_TOKENS`                | `600`                              | enough for the JSON verdict |
| `OPENAI_API_KEY`                      | —                                  | required when `VISION_PROVIDER=openai` |
| `OPENAI_VISION_MODEL`                 | `gpt-4o`                           |       |
| `CLEANING_SIMILARITY_PASS_THRESHOLD`  | `0.85`                             | cosine pass cut-off |
| `CLEANING_SIMILARITY_FAIL_THRESHOLD`  | `0.65`                             | cosine fail cut-off |
| `RUN_WORKER_IN_API`                   | `true`                             | set `false` to run worker separately |
| `WORKER_CONCURRENCY`                  | `2`                                | per worker process |
| `IMG_MAX_DIMENSION`                   | `1024`                             | sharp resize longest-side cap (px)   |
| `IMG_OUTPUT_FORMAT`                   | `jpeg`                             | `jpeg` or `webp` after preprocessing |
| `IMG_OUTPUT_QUALITY`                  | `80`                               | encoder quality 1–100                |
| `IMG_DECODE_PIXEL_LIMIT`              | `50000000`                         | decompression-bomb guard             |
| `IMG_ALLOW_HEIC`                      | `true`                             | accept iPhone HEIC/HEIF uploads      |
| `IMG_MAX_UPLOAD_MB`                   | `15`                               | multer fileSize cap (MB)             |

> All env values are sanitized — stray surrounding quotes and inline `# comments`
> are stripped automatically. Don't intentionally rely on that; keep `.env` clean.

---

## 5a. Vision provider (Anthropic Claude / OpenAI GPT-4o)

The cleanliness verdict is produced by a vision LLM. Two providers are wired
in; flip between them with the `VISION_PROVIDER` env var:

| Provider     | When to use                                           | Image transport                                 |
| ------------ | ----------------------------------------------------- | ----------------------------------------------- |
| `anthropic`  | **Default.** Works with local storage out of the box. | Image bytes are fetched and inlined as base64.  |
| `openai`     | When you specifically want GPT-4o (or hit your Claude quota). | Image URLs are sent directly to the API — the URLs must be publicly reachable from OpenAI's network. |

Recommended for development (local file storage isn't reachable from the
public internet):

```env
VISION_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_VISION_MODEL=claude-sonnet-4-5
```

Switching is hot — restart the API/worker and the next job will use the
new provider. Both providers feed exactly the same prompt and produce the
same `VisionResult` shape, so the rule engine and DB schema don't change.

The response now also includes `provider` and `model` so you can correlate
verdicts with the model that produced them when reviewing in the DB.

---

## 5b. Image preprocessing (sharp)

Every upload — admin reference **and** janitor completion — runs through the
same `sharp` pipeline in `src/services/image-preprocess.service.ts` BEFORE
storage and embedding. This is the single biggest quality lever for the AI
pipeline:

| Step                        | Why                                                                 |
| --------------------------- | ------------------------------------------------------------------- |
| `limitInputPixels`          | Refuse decompression-bomb images (defence against malicious upload) |
| `.rotate()` (EXIF)          | Phone photos arrive sideways → CLIP/Vision think it's a new scene   |
| `toColorspace('srgb')`      | Predictable colour for both CLIP and GPT-4o Vision                  |
| `.resize(maxDim, fit:inside, withoutEnlargement)` | Keep aspect, no upscale of small refs |
| `.jpeg({ mozjpeg, ... })` or `.webp` | ~15× smaller than raw 12 MP phone photo at quality 80       |
| Strip EXIF/GPS/ICC          | Privacy + smaller files; CLIP doesn't need it                       |

The same processed bytes are written to storage **and** fed to CLIP, so
references and completions are always compared apples-to-apples (no drift
from HEIC vs JPEG, sideways orientation, or wildly different resolutions).

Both upload responses now include `image_mime`, `image_width`, `image_height`,
`image_bytes`, `preprocess_ms`, and `source_bytes` so you can verify the
compression ratio on each request.

Tune the pipeline via the `IMG_*` env vars above. Defaults are tuned for
photographic content at industry-standard 1024 px / quality 80.

---

## 6. Inspect the DB

```bash
docker exec -it cleaning_poc_pg psql -U cleaning -d cleaning_poc

# Reference rows
SELECT id, facility_id, template_id, image_path, image_mime, image_width, image_height, created_at FROM cleaning_references;

# Latest verifications
SELECT id, task_id, status, similarity_score, vision_score, vision_passed, rule_reason
FROM cleaning_verifications ORDER BY id DESC LIMIT 20;

# Try a vector search by hand
SELECT id, 1 - (embedding <=> (SELECT embedding FROM cleaning_references WHERE id=1)) AS sim
FROM cleaning_references WHERE facility_id = 42
ORDER BY embedding <=> (SELECT embedding FROM cleaning_references WHERE id=1)
LIMIT 5;
```

---

## 7. Production-readiness notes

This is a POC — but the structure is production-shaped:

- **Strict env validation** (zod) → no silent typos.
- **Structured logging** (pino) → swap transport for prod (`NODE_ENV=production`).
- **Per-stage try/catch** → 4xx vs 5xx with stage tags in error messages.
- **Idempotent migrations** → safe to re-run.
- **BullMQ retry + backoff** → vision/embedding failures retry once with 5s exponential backoff.
- **Graceful shutdown** → both API and worker close pool / queue / redis cleanly.

To harden for prod you would mainly want:

- Auth middleware (currently open)
- Rate limiting on upload endpoints
- Image size + dimension limits (already 10 MB cap via multer)
- Observability (OpenTelemetry, Sentry)
- Containerized Dockerfile + CI

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `postgres unreachable` on startup | docker compose not running | `npm run infra:up` |
| `relation "cleaning_references" does not exist` | migration not applied | `npm run migrate` |
| Verification stays `PENDING` forever | worker not running | check logs for `cleaning worker started`; if absent set `RUN_WORKER_IN_API=true` or run `npm run dev:worker` |
| Worker errors `OPENAI_API_KEY is not configured` | missing env | set `OPENAI_API_KEY` in `.env`; until then, jobs land in `MANUAL_REVIEW` with `vision_error:` in `vision_issues` |
| `Unauthorized access to file: "https://huggingface.co/..."` | bad `.env` quoting of `CLIP_MODEL_NAME` | remove surrounding `"`/`'` and any inline `# comment` |
| `Failed to load image (...)` from CLIP | `PUBLIC_BASE_URL` not reachable from inside the container/worker | for local driver, leave it as `http://localhost:4000` (worker runs in same process); for GCS make sure the bucket is public or use signed URLs |
