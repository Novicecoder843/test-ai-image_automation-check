# Cleaning Verification POC

**Stack:** Node.js · TypeScript · PostgreSQL · Redis · BullMQ · CLIP · GPT-4o / Gemini / Claude

---

## Table of Contents

1. [What This Project Does](#1-what-this-project-does)
2. [System Architecture](#2-system-architecture)
3. [Full Verification Pipeline](#3-full-verification-pipeline)
4. [Project Structure](#4-project-structure)
5. [Prerequisites](#5-prerequisites)
6. [Setup & Installation](#6-setup--installation)
7. [Environment Variables Reference](#7-environment-variables-reference)
8. [Running the Project](#8-running-the-project)
9. [Using the Web UI](#9-using-the-web-ui)
10. [API Reference](#10-api-reference)
11. [Scoring & Decision Logic](#11-scoring--decision-logic)
12. [Vision Providers](#12-vision-providers)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. What This Project Does

This system automatically verifies whether a janitor has cleaned a facility correctly by comparing photos using AI.

### The Core Idea

```
BEFORE (Reference Photo)          AFTER (Janitor's Photo)
        +                    vs           +
 Clean washroom baseline            Janitor's completion snap
        |                                  |
        └─────────── AI Comparison ────────┘
                          |
              ┌───────────┴───────────┐
              │                       │
            PASS                    FAIL
        (Area is clean)        (Still dirty)
```

### Key Capabilities

| Feature | Description |
|---|---|
| Multi-image upload | Upload multiple reference + task photos in one batch |
| CLIP Scene Matching | Verifies the photo is of the correct room before spending API credits |
| Vision LLM Check | GPT-4o / Gemini / Claude inspects the image for cleanliness |
| Rule Engine | Combines scene score + AI score into a final PASS / FAIL / MANUAL_REVIEW |
| Async Queue | BullMQ processes all jobs in the background — no request blocking |
| pgvector | Stores CLIP embeddings in PostgreSQL for fast scene matching |

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Web Browser                             │
│                    http://localhost:4000                          │
│                       batch.html  (UI)                           │
└────────────────────────┬─────────────────────────────────────────┘
                         │  HTTP (multipart/form-data)
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Express API  (port 4000)                       │
│                                                                  │
│   POST /api/admin/upload-references/bulk  ──► sync embed+save    │
│   POST /api/janitor/upload-completions/bulk ──► enqueue jobs     │
│   GET  /api/janitor/batches/:id/status     ──► poll results      │
│   GET  /api/health                         ──► health check      │
└────────────┬───────────────────────────────┬─────────────────────┘
             │                               │
    PostgreSQL + pgvector             Redis (BullMQ)
    (embeddings + results)           (job queue)
             │                               │
             │                               ▼
             │                ┌──────────────────────────┐
             │                │   BullMQ Worker           │
             │                │   cleaning.worker.ts      │
             │                │                          │
             │                │  1. CLIP embedding        │
             │                │  2. Scene match check     │
             │                │  3. Vision LLM call       │
             │                │  4. Rule engine decision  │
             │                │  5. Save result to DB     │
             └────────────────┴──────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js >= 18.18  +  TypeScript (tsx) |
| API | Express 4 |
| Queue | BullMQ 5 + Redis (ioredis) |
| DB | PostgreSQL + pgvector extension |
| ML | CLIP (Xenova/clip-vit-base-patch32) |
| Vision | OpenAI GPT-4o / Google Gemini 2.5 / Anthropic Claude |
| Images | sharp (resize, HEIC conversion, quality gate) |
| Logs | pino + pino-pretty |

---

## 3. Full Verification Pipeline

When a janitor uploads a completion photo, here is exactly what happens step by step:

```
UPLOAD (janitor submits photo)
        │
        ▼
┌─────────────────────────┐
│  1. Image Quality Gate  │  ← sharp library checks:
│     (synchronous)       │    • min dimension (480px)
│                         │    • min brightness, entropy
│                         │    • HEIC → JPEG conversion
└──────────┬──────────────┘
           │ pass
           ▼
┌─────────────────────────┐
│  2. Save + Enqueue      │  ← saves to disk/GCS, writes PENDING
│     (API process)       │    record to PostgreSQL, pushes job
│                         │    to Redis BullMQ queue
└──────────┬──────────────┘
           │
           ▼  (async — BullMQ worker picks up job)
┌─────────────────────────┐
│  3. Mark PROCESSING     │  ← status updated in DB
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  4. CLIP Embedding      │  ← Xenova/CLIP generates a 512-dim
│     (local model)       │    vector for the uploaded image
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  5. Scene Match Check   │  ← cosine similarity vs all stored
│     (pgvector)          │    reference embeddings for this
│                         │    facility + template
└──────────┬──────────────┘
           │
    ┌──────┴──────┐
    │  similarity │
    │   < 0.88?   │
    └──────┬──────┘
           │ yes                      no
           ▼                          │
  INVALID_TASK                        ▼
  (wrong room,           ┌─────────────────────────┐
   skip vision)          │  6. Vision LLM Call     │  ← fetches both images as
                         │     (cloud API)         │    base64, sends to model
                         └──────────┬──────────────┘
                                    │
                                    ▼
                         ┌─────────────────────────┐
                         │  7. Rule Engine v2       │  ← combines:
                         │                         │    scene_match_percent +
                         │                         │    cleanliness_percent +
                         │                         │    vision.passed flag
                         └──────────┬──────────────┘
                                    │
                       ┌────────────┼────────────┐
                       ▼            ▼             ▼
                     PASS         FAIL      MANUAL_REVIEW
```

---

## 4. Project Structure

```
cleaning-verification-poc/
│
├── public/
│   └── batch.html                    Web UI (drag-and-drop image uploader)
│
├── src/
│   ├── index.ts                      Entry point (API + optional worker)
│   ├── app.ts                        Express app factory
│   │
│   ├── config/
│   │   ├── env.ts                    Zod-validated environment variables
│   │   └── logger.ts                 Pino structured logger
│   │
│   ├── routes/
│   │   └── index.ts                  All API route definitions
│   │
│   ├── controllers/
│   │   └── cleaning.controller.ts    HTTP handlers (parse, validate, respond)
│   │
│   ├── services/
│   │   ├── embedding.service.ts      CLIP embedding (Xenova/transformers)
│   │   ├── vision.service.ts         Vision LLM (OpenAI / Gemini / Anthropic)
│   │   ├── rule-engine.service.ts    PASS/FAIL/MANUAL_REVIEW decision logic
│   │   ├── scene-match.service.ts    Cosine similarity + best-reference picker
│   │   └── batch.service.ts          Batch ID generation + status aggregation
│   │
│   ├── workers/
│   │   ├── cleaning.worker.ts        BullMQ job processor (main pipeline)
│   │   └── start.ts                  Standalone worker entry point
│   │
│   ├── queue/
│   │   ├── cleaning.queue.ts         BullMQ queue definition + job dispatcher
│   │   └── redis.ts                  ioredis connection factory
│   │
│   ├── repositories/
│   │   ├── cleaning-reference.repo.ts      DB queries for reference images
│   │   └── cleaning-verification.repo.ts   DB queries for verification records
│   │
│   ├── middlewares/
│   │   └── upload.ts                 Multer + sharp image preprocessing
│   │
│   ├── storage/
│   │   └── storage.service.ts        Local disk / GCS abstraction
│   │
│   └── db/
│       ├── pool.ts                   PostgreSQL connection pool (pg)
│       └── migrate.ts                Schema migration script
│
├── uploads/                          Local image storage (gitignored)
├── docker-compose.yml                PostgreSQL + Redis for local dev
├── .env.example                      All env variables with descriptions
├── package.json
└── tsconfig.json
```

---

## 5. Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | >= 18.18 | Runtime |
| npm | >= 9 | Package manager |
| Docker Desktop | any recent | PostgreSQL + Redis via docker-compose |
| Git | any | Clone the repo |

You will also need at least one Vision AI API key:

- OpenAI API key (`OPENAI_API_KEY`) — for GPT-4o
- Google AI API key (`GEMINI_API_KEY`) — for Gemini 2.5 Flash
- Anthropic API key (`ANTHROPIC_API_KEY`) — for Claude

---

## 6. Setup & Installation

### Step 1 — Clone the Repository

```bash
git clone https://github.com/Novicecoder843/test-ai-image_automation-check.git
cd test-ai-image_automation-check/cleaning-verification-poc/cleaning-verification-poc
```

### Step 2 — Install Dependencies

```bash
npm install
```

Note: On first run, `@xenova/transformers` will download the CLIP model (~150 MB) from HuggingFace. This only happens once and is cached locally.

### Step 3 — Start Infrastructure (PostgreSQL + Redis)

```bash
npm run infra:up
```

This spins up:
- PostgreSQL on port `5432` (user: `cleaning`, password: `cleaning`, db: `cleaning_poc`)
- Redis on port `6379`

### Step 4 — Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum one API key and the matching provider:

```bash
# Required: at least one of these
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...
ANTHROPIC_API_KEY=sk-ant-...

# Set which provider to use
VISION_PROVIDER=gemini   # or openai, anthropic
```

### Step 5 — Run Database Migrations

```bash
npm run migrate
```

This creates the tables and enables the `pgvector` extension in PostgreSQL.

### Step 6 — Start the Server

```bash
npm run dev
```

The API starts on **http://localhost:4000** and the BullMQ worker starts automatically in the same process (controlled by `RUN_WORKER_IN_API=true` in `.env`).

Open **http://localhost:4000/batch.html** in your browser to access the UI.

---

## 7. Environment Variables Reference

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | API server port |
| `LOG_LEVEL` | `info` | Pino log level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | `development` | Environment label |

### Database

| Variable | Default | Description |
|---|---|---|
| `PGHOST` | `localhost` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | `cleaning` | PostgreSQL username |
| `PGPASSWORD` | `cleaning` | PostgreSQL password |
| `PGDATABASE` | `cleaning_poc` | Database name |

### Redis / Queue

| Variable | Default | Description |
|---|---|---|
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_TLS` | `false` | Enable TLS (set `true` in production) |

### AI / Vision

| Variable | Default | Description |
|---|---|---|
| `VISION_PROVIDER` | `anthropic` | Active provider: `openai`, `gemini`, or `anthropic` |
| `OPENAI_API_KEY` | — | OpenAI secret key |
| `OPENAI_VISION_MODEL` | `gpt-4o` | Model name |
| `GEMINI_API_KEY` | — | Google AI key |
| `GEMINI_VISION_MODEL` | `gemini-2.5-flash` | Model name |
| `ANTHROPIC_API_KEY` | — | Anthropic key |
| `ANTHROPIC_VISION_MODEL` | `claude-sonnet-4-5` | Model name |
| `CLIP_MODEL_NAME` | `Xenova/clip-vit-base-patch32` | CLIP model (downloaded from HuggingFace) |

### Scoring Thresholds

| Variable | Default | Description |
|---|---|---|
| `SCENE_MATCH_MIN_SIMILARITY` | `0.88` | Cosine similarity below this → INVALID_TASK |
| `SCENE_MATCH_ENFORCE` | `true` | If false, wrong-room photos still proceed to vision |
| `CLEANING_VISION_PASS_SCORE` | `80` | Cleanliness score >= 80 → PASS |
| `CLEANING_VISION_FAIL_SCORE` | `50` | Cleanliness score < 50 → FAIL |
| `CLEANING_VISION_REVIEW_SCORE` | `65` | Score in 50–80 → MANUAL_REVIEW |
| `CLEANING_SCENE_WEIGHT` | `0.3` | Weight of scene match in overall % |
| `CLEANING_CLEANLINESS_WEIGHT` | `0.7` | Weight of cleanliness in overall % |

---

## 8. Running the Project

### Development (all-in-one)

```bash
npm run dev
```

Runs both the API server and the BullMQ worker in a single process with hot reload via `tsx watch`.

### Production / Separate Processes

```bash
# Terminal 1: API only
npm run start

# Terminal 2: Worker only
npm run start:worker
```

Set `RUN_WORKER_IN_API=false` in `.env` when running the worker separately.

### Infrastructure Commands

```bash
npm run infra:up       # Start Docker containers (PostgreSQL + Redis)
npm run infra:down     # Stop and remove containers
npm run infra:logs     # Stream docker-compose logs
npm run migrate        # Run database schema migrations
npm run build          # TypeScript type-check (no emit)
```

---

## 9. Using the Web UI

Open **http://localhost:4000/batch.html**

The interface follows a 3-step flow:

```
[1] Upload References  -->  [2] Upload Tasks  -->  [3] Compare & Verify
```

---

### Step 1 — Upload Reference Images

Reference images are baseline "what clean looks like" photos for a specific room.

1. Drag and drop, or click the left dropzone to select images
2. Click **Upload References** below the dropzone
3. A 5-character Batch ID appears at the bottom (e.g. `8XF2A`)

You only need to upload references once per room. They are stored in the database with CLIP embeddings and reused across all future verifications.

---

### Step 2 — Upload Task Images

Task images are the photos submitted by the janitor after cleaning.

1. Drag and drop, or click the right dropzone to select images

---

### Step 3 — Compare & Verify

1. Click **Compare & Verify**
2. The system uploads the task photos, enqueues verification jobs, and polls for results automatically
3. Each thumbnail receives a badge overlay:

| Badge | Colour | Meaning |
|---|---|---|
| PASS | Green | Area is clean, meets the standard |
| FAIL | Red | Area is dirty or has visible issues |
| MANUAL REVIEW | Amber | Ambiguous — needs a human to check |

---

### Settings Panel

Use the Settings panel at the top to configure:

| Field | Description |
|---|---|
| Facility ID | Identifies which facility or building |
| Template ID | Identifies the room or area type |
| Task ID | Starting task number (auto-increments per image in the batch) |

---

## 10. API Reference

### Upload Reference Images (bulk)

```
POST /api/admin/upload-references/bulk
Content-Type: multipart/form-data

Fields:
  images[]     one or more image files
  metadata     JSON array: [{ facility_id, template_id, label }]
```

Response:

```json
{
  "success": true,
  "batch_id": "8XF2A",
  "results": [
    { "ok": true, "input_filename": "washroom.jpg", "data": { "id": 13 } }
  ]
}
```

---

### Upload Completion Images (bulk)

```
POST /api/janitor/upload-completions/bulk
Content-Type: multipart/form-data

Fields:
  images[]     one or more image files
  metadata     JSON array: [{ task_id, facility_id, template_id, janitor_id }]
```

Response:

```json
{
  "success": true,
  "batch_id": "W9KL4",
  "count": 4,
  "results": [...]
}
```

---

### Poll Batch Status

```
GET /api/janitor/batches/:batchId/status
```

Response:

```json
{
  "success": true,
  "results": {
    "summary": {
      "batch_id": "W9KL4",
      "total": 4,
      "pending": 0,
      "processing": 0,
      "pass": 2,
      "fail": 1,
      "manual_review": 1
    },
    "results": [
      {
        "verification_id": 161,
        "task_id": 9001,
        "status": "PASS",
        "similarity_score": 0.9999,
        "cleanliness_percent": 88,
        "overall_percent": 91.6,
        "rule_reason": "scene match 100%, cleanliness 88%"
      }
    ]
  }
}
```

---

### Get Single Task Result

```
GET /api/tasks/:taskId/result
```

---

### Health Check

```
GET /api/health

Response: { "success": true, "results": { "db": "ok", "timestamp": "..." } }
```

---

### Queue Stats

```
GET /api/queue-stats

Response: { "success": true, "results": { "waiting": 0, "active": 2, ... } }
```

---

## 11. Scoring & Decision Logic

### How Scores Are Calculated

```
Scene Match % = cosine_similarity(uploaded_embedding, reference_embedding) x 100

Overall %     = (Scene Match % x 0.3) + (Cleanliness % x 0.7)
```

### Decision Tree

```
Is scene similarity < 0.88?
    YES --> INVALID_TASK  (wrong room, skip vision entirely)
    NO  --> continue

Did Vision LLM respond?
    NO  --> MANUAL_REVIEW (provider unavailable or timed out)
    YES --> continue

Is cleanliness score < 50?
    YES --> FAIL

Is cleanliness score < 65 AND visible defects in issues list?
    YES --> FAIL

Is cleanliness score >= 80 AND vision.passed = true?
    YES --> PASS

Otherwise --> MANUAL_REVIEW (gray zone, not clean enough to pass, not dirty enough to fail)
```

### What the Vision LLM Returns

The LLM is prompted to return a strict JSON object with no additional prose:

```json
{
  "passed": true,
  "score": 87,
  "confidence": 90,
  "issues": []
}
```

- `passed` — boolean verdict
- `score` — 0 to 100 cleanliness score (100 = spotless, 0 = filthy)
- `confidence` — how certain the model is about its verdict
- `issues` — list of specific problems found (e.g. `"floor stain"`, `"trash visible"`)

---

## 12. Vision Providers

The system supports three Vision LLM providers. Set `VISION_PROVIDER` in `.env` to switch between them.

### Comparison

| Provider | Model | Speed | Notes |
|---|---|---|---|
| Gemini | `gemini-2.5-flash` | Fast | Recommended for development — low cost |
| OpenAI | `gpt-4o` | Medium | High accuracy |
| Anthropic | `claude-sonnet-4-5` | Medium | Strong reasoning |

### Why Images Are Sent as Base64

All providers receive images as **inline base64 data**, never as URL strings. This is essential because:

Cloud APIs (OpenAI, Gemini, Anthropic) run on external internet servers. They cannot access `http://localhost:4000/...` URLs from your local machine.

The system downloads each image locally and converts it to base64 before sending it to the API.

### Retry Logic

All providers use exponential backoff (2s, 4s, 8s, up to 5 retries) for rate limit errors (HTTP 429/503).

---

## 13. Troubleshooting

### `postgres unreachable — exiting`

```bash
# Make sure Docker is running, then:
npm run infra:up

# Verify containers are healthy
docker ps
```

---

### Vision always returns MANUAL_REVIEW with score 0

1. Check that your API key is valid and has available credits
2. Confirm `VISION_PROVIDER` in `.env` matches the key you configured
3. Check the health endpoint: `GET /api/health`
4. Review the server logs — pino will show the exact error from the provider

---

### Scene match always returns INVALID_TASK

Your reference images and task images may be from different room types, or the CLIP similarity threshold is too strict.

Options:
- Lower `SCENE_MATCH_MIN_SIMILARITY` in `.env` (e.g. from `0.88` to `0.75`)
- Upload new reference images that are a closer visual match to your task photos
- Set `SCENE_MATCH_ENFORCE=false` to disable the scene check entirely

---

### CLIP model download fails on first run

The CLIP model requires an internet connection on first run to download from HuggingFace. After the initial download, it is cached under `node_modules/@xenova/transformers/.cache` and does not require internet access again.

---

### Key log lines to watch

```bash
# Server started correctly
[INFO] postgres connected
[INFO] API listening  { port: 4000 }
[INFO] cleaning worker started  { queue: "cleaning-verification", concurrency: 2 }
[INFO] CLIP model ready

# Job processed successfully
[INFO] job: complete  { status: "PASS", similarity: 0.99, cleanliness_percent: 87 }

# Errors to investigate
[ERROR] openai vision failed
[ERROR] postgres unreachable
[WARN]  res.arrayBuffer is not a function
```

---

*Wooloo Tech — AI Cleaning Verification POC*
