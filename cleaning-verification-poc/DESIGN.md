# Cleaning Verification — Design & Implementation Document

> A deep, end-to-end design doc for the AI facility-cleaning verification POC.
> It explains the architecture, every request flow step-by-step, the image
> compression standard, what each stage outputs (compression → embedding → AI
> comparison → decision), and a proposed **image quality gate** to stop
> low-quality photos from silently producing wrong `FAIL` verdicts.
>
> For install/run instructions see [`README.md`](./README.md). This document is
> the "why + how it works internally" companion.

---

## Table of contents

1. [What this system does](#1-what-this-system-does)
2. [High-level architecture](#2-high-level-architecture)
3. [Tech stack](#3-tech-stack)
4. [Data model](#4-data-model)
5. [Layered code structure (file map)](#5-layered-code-structure-file-map)
6. [Flow A — Admin upload reference (synchronous)](#6-flow-a--admin-upload-reference-synchronous)
7. [Flow B — Janitor upload completion (async)](#7-flow-b--janitor-upload-completion-async)
8. [Flow C — Reading the result](#8-flow-c--reading-the-result)
9. [Image preprocessing & compression standard](#9-image-preprocessing--compression-standard)
10. [The low-quality image problem & the Quality Gate](#10-the-low-quality-image-problem--the-quality-gate)
11. [Embeddings — what CLIP produces](#11-embeddings--what-clip-produces)
12. [Similarity — what cosine produces](#12-similarity--what-cosine-produces)
13. [Vision AI — what the LLM produces](#13-vision-ai--what-the-llm-produces)
14. [Rule engine — the decision matrix](#14-rule-engine--the-decision-matrix)
15. [Status lifecycle](#15-status-lifecycle)
16. [Error handling, retries & timeouts](#16-error-handling-retries--timeouts)
17. [Output format reference](#17-output-format-reference)
18. [Configuration reference](#18-configuration-reference)
19. [Edge cases & failure modes](#19-edge-cases--failure-modes)
20. [Production hardening checklist](#20-production-hardening-checklist)

---

## 1. What this system does

The system verifies that a janitor actually cleaned a facility, by comparing a
**completion photo** (taken after cleaning) against a **reference photo** (the
"this is what clean looks like" gold standard the admin registered earlier).

There are two actors and two phases:

- **Admin phase** — an admin uploads one or more reference images per facility
  (optionally scoped to a `task_id`, e.g. "male washroom"). Each reference
  is turned into a numeric fingerprint (a CLIP **embedding**) and stored.
- **Janitor phase** — a janitor uploads a completion photo for a task. The
  system compares it to the reference using **two independent AI signals** and
  returns one of: `PASS`, `FAIL`, or `MANUAL_REVIEW`.

The two AI signals:

1. **Vector similarity (CLIP + cosine)** — fast, cheap, numeric "do these two
   images look like the same scene in the same state?".
2. **Vision LLM (Claude / GPT-4o)** — semantic "is this actually clean, are
   there visible trash/stains/spills?".

A **rule engine** combines both signals into the final verdict. Anything
uncertain is routed to a human (`MANUAL_REVIEW`) instead of being guessed.

---

## 2. High-level architecture

```
                          ┌──────────────────────────────────────────┐
                          │                CLIENTS                    │
                          │   Admin app            Janitor app        │
                          └───────┬───────────────────────┬──────────┘
                                  │ POST reference         │ POST completion
                                  ▼                        ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                          EXPRESS API (src/app.ts)                     │
   │  routes → upload middleware (Multer) → controller (Zod) → service     │
   └───────────────┬───────────────────────────────────────┬─────────────┘
                   │ (admin: synchronous)                   │ (janitor: enqueue)
                   ▼                                        ▼
   ┌───────────────────────────┐                 ┌──────────────────────────┐
   │  cleaning.service          │                 │  cleaning.service        │
   │  - preprocess (sharp)      │                 │  - preprocess (sharp)    │
   │  - store bytes             │                 │  - store bytes           │
   │  - CLIP embed              │                 │  - INSERT PENDING row     │
   │  - INSERT reference row    │                 │  - enqueue BullMQ job     │
   └───────────┬───────────────┘                 └───────────┬──────────────┘
               │                                              │
               ▼                                              ▼
   ┌──────────────────────────┐                  ┌────────────────────────────┐
   │  PostgreSQL + pgvector    │◄─────────────────│  Redis (BullMQ queue)       │
   │  cleaning_references      │                  └─────────────┬──────────────┘
   │  cleaning_verifications   │                                │ pulls job
   └──────────────────────────┘                                ▼
               ▲                              ┌──────────────────────────────────┐
               │ saveResult()                 │   WORKER (cleaning.worker.ts)      │
               └──────────────────────────────│   1. CLIP embed uploaded image     │
                                              │   2. cosine vs references          │
                                              │   3. Vision LLM verdict            │
                                              │   4. rule engine → status          │
                                              │   5. persist                       │
                                              └──────────────────────────────────┘
```

**Key design decision:** the admin path is **synchronous** (you get the result
in the HTTP response), while the janitor path is **asynchronous** (the API
returns `202 PENDING` immediately and a background worker does the slow AI work
via a Redis-backed queue). This keeps the upload endpoint fast and responsive
even though the AI calls take several seconds.

---

## 3. Tech stack

| Concern              | Choice                                   | Notes |
| -------------------- | ---------------------------------------- | ----- |
| Runtime / language   | Node.js ≥ 18.18, TypeScript (ESM)        | |
| HTTP framework       | Express 4                                | |
| File upload          | Multer (`memoryStorage`)                 | image lands in `req.file.buffer` |
| Validation           | Zod                                      | coerces multipart strings → numbers |
| Image processing     | sharp (libvips)                          | resize / re-encode / strip metadata |
| Embeddings           | `@xenova/transformers`, CLIP ViT-B/32    | runs locally, 512-dim output |
| Vector store         | PostgreSQL + `pgvector`                  | cosine ANN search |
| Vision LLM           | Anthropic Claude (default) / OpenAI GPT-4o | pluggable via `VISION_PROVIDER` |
| Queue                | BullMQ on Redis (ioredis)                | retries + backoff |
| Storage              | Local FS (`/files/*`) or Google Cloud Storage | pluggable via `STORAGE_DRIVER` |
| Logging              | pino                                     | structured JSON logs |

---

## 4. Data model

Two tables (defined in `db/migrations/001_init.sql`).

### `cleaning_references` — admin's clean-state fingerprints

| Column        | Type          | Meaning |
| ------------- | ------------- | ------- |
| `id`          | BIGSERIAL PK  | |
| `facility_id` | INT           | which facility this reference belongs to |
| `task_id` | INT (null)    | optional sub-scope (e.g. "male washroom") |
| `label`       | VARCHAR(255)  | free-form tag |
| `image_path`  | VARCHAR(500)  | storage object key (no host) |
| `image_url`   | VARCHAR(1000) | resolved public URL |
| `image_mime`  | VARCHAR(64)   | mimetype **after** preprocessing |
| `image_width/height/bytes` | INT | dimensions/size **after** preprocessing |
| `embedding`   | `vector(512)` | CLIP fingerprint (the heart of matching) |
| `uploaded_by` | VARCHAR(100)  | admin id |
| `is_active`   | BOOLEAN       | only active refs are matched against |
| `created_at/updated_at` | TIMESTAMPTZ | |

Indexes: `(facility_id, is_active)`, `(facility_id, task_id, is_active)`,
and an `ivfflat` cosine ANN index on `embedding`.

### `cleaning_verifications` — janitor submissions + verdicts

| Column              | Type            | Meaning |
| ------------------- | --------------- | ------- |
| `id`                | BIGSERIAL PK    | also the `verification_id` |
| `task_id`           | INT             | the cleaning task |
| `facility_id`       | INT             | |
| `task_id`       | INT (null)      | |
| `reference_id`      | BIGINT FK       | which reference it matched against |
| `janitor_id`        | VARCHAR(100)    | |
| `image_*`           | …               | path/url/mime/width/height/bytes after preprocessing |
| `embedding`         | `vector(512)`   | embedding of the uploaded image |
| `similarity_score`  | NUMERIC(6,4)    | cosine score 0..1 |
| `vision_passed`     | BOOLEAN         | LLM verdict |
| `vision_score`      | INT (0..100)    | LLM cleanliness score |
| `vision_confidence` | INT (0..100)    | LLM confidence |
| `vision_issues`     | JSONB           | list of problems found |
| `vision_raw`        | JSONB           | full raw LLM response (audit) |
| `status`            | VARCHAR(20)     | `PENDING/PROCESSING/PASS/FAIL/MANUAL_REVIEW/ERROR` |
| `rule_reason`       | TEXT            | human-readable explanation of the decision |
| `bull_job_id`       | VARCHAR(120)    | queue job id (traceability) |
| `error_message`     | TEXT            | populated on `ERROR` |
| `created_at/processed_at/updated_at` | TIMESTAMPTZ | timeline |

Every janitor submission is a **new row** — the table is an append-only audit
trail, and `GET /tasks/:id/result` returns the latest row (with optional full
history).

---

## 5. Layered code structure (file map)

The code follows a strict request pipeline. Each layer has exactly one job.

```
HTTP request
  │
  ├─ src/routes/index.ts            map URL → handler, attach Multer middleware
  ├─ src/middlewares/upload.ts      Multer: parse multipart, MIME + size guard → req.file.buffer
  ├─ src/controllers/cleaning.controller.ts
  │                                 HTTP concerns: validate (Zod), log, respond
  │
  └─ src/services/cleaning.service.ts        ★ ORCHESTRATOR (only layer controllers call)
        ├─ src/services/image-preprocess.service.ts   sharp pipeline
        ├─ src/storage/index.ts                        local / GCS adapters
        ├─ src/services/embedding.service.ts           CLIP → 512-vector
        ├─ src/repositories/cleaning-reference.repo.ts SQL: references
        ├─ src/repositories/cleaning-verification.repo.ts SQL: verifications
        └─ src/queue/cleaning.queue.ts                 enqueue BullMQ job

Background:
  src/workers/cleaning.worker.ts    consume job → embed → cosine → vision → rules → persist
        ├─ src/services/similarity.service.ts      cosine + best-match
        ├─ src/services/vision.service.ts          Claude / GPT-4o
        └─ src/services/rule-engine.service.ts     PASS / FAIL / MANUAL_REVIEW

Cross-cutting:
  src/config/env.ts                 Zod-validated env (all thresholds/limits live here)
  src/config/logger.ts              pino logger
  src/db/pool.ts                    pg pool + query() helper
  src/middlewares/error-handler.ts  AppError, 4xx/5xx mapping, stage tagging
```

---

## 6. Flow A — Admin upload reference (synchronous)

**Endpoint:** `POST /api/admin/upload-reference` (`multipart/form-data`, field `image`).

### Step-by-step (function → function, file → file)

| # | Where | Function | What happens | Output |
| - | ----- | -------- | ------------ | ------ |
| 1 | `routes/index.ts` | route + `uploadImage.single('image')` | Multer parses the multipart body | `req.file.buffer` (raw bytes in RAM), `req.body` (text fields) |
| 2 | `middlewares/upload.ts` | `fileFilter` + `limits` | reject non-image MIME, reject > `IMG_MAX_UPLOAD_MB` (15 MB) | passes or `400/413` |
| 3 | `controllers/cleaning.controller.ts` | `adminUploadReference` | check `req.file` exists; validate `facility_id` etc. with `adminUploadBody` (Zod) | typed, validated input |
| 4 | `services/cleaning.service.ts` | `adminUploadReference` | orchestrates steps 5–8 | `AdminUploadResult` |
| 5 | `services/image-preprocess.service.ts` | `preprocessImage(buffer)` | sharp: rotate→sRGB→resize→re-encode→strip metadata | normalized JPEG buffer + dims |
| 6 | `storage/index.ts` | `uploadBuffer` + `getPublicUrl` | write normalized bytes to disk/GCS | object key + public URL |
| 7 | `services/embedding.service.ts` | `generateImageEmbeddingFromBuffer` | CLIP on the **same** normalized bytes | 512-dim L2-normalized vector |
| 8 | `repositories/cleaning-reference.repo.ts` | `insertReference` | `INSERT ... $10::vector` | new row id |
| 9 | controller | — | respond `201 Created` | JSON (see §17) |

**Why embed the same bytes that were stored?** So the reference fingerprint
exactly matches the image on disk — no drift between "what we vectorised" and
"what we kept".

### Visual

```
client → Multer → controller(Zod)
  → cleaning.service.adminUploadReference
      → preprocessImage (sharp)          [normalized JPEG]
      → uploadBuffer / getPublicUrl      [stored key + URL]
      → generateImageEmbeddingFromBuffer [512-vector]
      → referenceRepo.insertReference    [DB row]
  → 201 { id, embedding_dim: 512, image_width, image_height, ... }
```

---

## 7. Flow B — Janitor upload completion (async)

**Endpoint:** `POST /api/janitor/upload-completion` (`multipart/form-data`, field `image`).

This flow has **two halves**: the fast API half (returns a ticket) and the slow
worker half (does the verification).

### Half 1 — API request (returns `202 PENDING`)

| # | Where | Function | What happens | Output |
| - | ----- | -------- | ------------ | ------ |
| 1 | `routes/index.ts` + `upload.ts` | Multer | parse multipart | `req.file.buffer` |
| 2 | `controllers/cleaning.controller.ts` | `janitorUploadCompletion` | validate `task_id`, `facility_id`, … with `janitorUploadBody` (Zod) | validated input |
| 3 | `services/cleaning.service.ts` | `janitorUploadCompletion` | orchestrates 4–7 | `JanitorUploadResult` |
| 4 | `image-preprocess.service.ts` | `preprocessImage` | **same** sharp pipeline as admin | normalized JPEG |
| 5 | `storage/index.ts` | `uploadBuffer` / `getPublicUrl` | persist bytes | key + URL |
| 6 | `repositories/cleaning-verification.repo.ts` | `createPending` | `INSERT ... status='PENDING'` | row id = `verification_id` |
| 7 | `queue/cleaning.queue.ts` | `enqueueCleaningVerification` | push minimal job onto Redis; then `attachJobId` | `bull_job_id` |
| 8 | controller | — | respond `202 Accepted` | JSON ticket (see §17) |

> **Important:** the embedding is **not** computed here. Unlike the admin path,
> the slow CLIP + Vision work is deferred to the worker so the HTTP request
> returns in milliseconds.

### Half 2 — Worker (`processCleaningJob` in `workers/cleaning.worker.ts`)

BullMQ pulls a waiting job and runs:

| # | Function | What happens | Output |
| - | -------- | ------------ | ------ |
| 1 | `verificationRepo.markProcessing` | status → `PROCESSING` | — |
| 2 | `embedding.service.generateImageEmbeddingFromUrl` | CLIP-embed the uploaded image (fetched from its stored URL) | 512-vector |
| 3 | `referenceRepo.getActiveReferencesByFacility` | load candidate references for `(facility_id, task_id)` | rows with embeddings |
| 4 | `similarity.service.findBestMatch` | cosine vs every reference, pick highest | `{ match, score }` |
| 5 | `vision.service.analyzeCleanliness` | send reference + uploaded image to the LLM | `{ passed, score, confidence, issues[] }` |
| 6 | `rule-engine.service.evaluateRules` | combine similarity + vision | `PASS / FAIL / MANUAL_REVIEW` |
| 7 | `verificationRepo.saveResult` | persist verdict, scores, `reference_id`, `processed_at` | updated row |

Special rule in the worker: if the vision call failed (`vision.raw == null`) but
the rule engine still said `PASS`, the worker downgrades it to `MANUAL_REVIEW` —
we never auto-pass on a single signal.

### Visual

```
── API (fast) ───────────────────────────────────────────
client → Multer → controller(Zod)
  → cleaning.service.janitorUploadCompletion
      → preprocessImage (sharp)
      → uploadBuffer / getPublicUrl
      → verificationRepo.createPending     [status=PENDING]
      → enqueueCleaningVerification        [Redis job]
  → 202 { verification_id, status: PENDING, bull_job_id }

── Worker (slow, background) ─────────────────────────────
BullMQ → processCleaningJob
  → markProcessing
  → generateImageEmbeddingFromUrl          [512-vector]
  → getActiveReferencesByFacility
  → findBestMatch (cosine)                 [similarity 0..1]   ← signal 1
  → analyzeCleanliness (Claude/GPT-4o)     [vision JSON]       ← signal 2
  → evaluateRules                          [PASS/FAIL/REVIEW]
  → saveResult
```

---

## 8. Flow C — Reading the result

**Endpoint:** `GET /api/tasks/:taskId/result?includeHistory=true|false`

```
client → controller.getTaskResult (Zod params/query)
  → cleaning.service.getTaskVerificationResult
      → verificationRepo.getLatestByTaskId   [latest row by created_at]
  → 200 { status, similarity_score, vision:{...}, rule_reason, ... }
```

The janitor app polls this until `status` is no longer `PENDING`/`PROCESSING`.
With `?includeHistory=true` it also returns every prior attempt for that task.

---

## 9. Image preprocessing & compression standard

Every upload — admin **and** janitor — goes through the **same** sharp pipeline
in `src/services/image-preprocess.service.ts` **before** both storage and
embedding. This is the single biggest quality lever in the system, because it
guarantees the reference and the completion are compared apples-to-apples.

### The pipeline (in order)

| Step | sharp call | Why |
| ---- | ---------- | --- |
| 1. Safe decode | `sharp(input, { limitInputPixels: 50,000,000, failOn:'truncated' })` | defend against decompression-bomb DoS & corrupt files |
| 2. Auto-orient | `.rotate()` | phone photos carry EXIF orientation; without this CLIP/Vision think a sideways photo is a different scene |
| 3. Normalize colour | `.toColorspace('srgb')` | predictable colour for both CLIP and the LLM |
| 4. Resize | `.resize({ width:1024, height:1024, fit:'inside', withoutEnlargement:true })` | cap longest side at `IMG_MAX_DIMENSION` (1024px), keep aspect, never upscale a small reference |
| 5. Re-encode | `.jpeg({ quality:80, mozjpeg:true, progressive:true, chromaSubsampling:'4:2:0', trellisQuantisation:true, overshootDeringing:true })` | compress to the standard output format |
| 6. Strip metadata | (implicit on re-encode) | drops EXIF/GPS/ICC → privacy + smaller file |

### The compression standard (output format)

- **Default output format: JPEG** (`IMG_OUTPUT_FORMAT=jpeg`), encoded with
  **mozjpeg** at **quality 80** — the industry sweet spot for photographic
  content. WebP is available (`IMG_OUTPUT_FORMAT=webp`) and produces even
  smaller files; both are accepted everywhere the pipeline reads images.
- **Max dimension: 1024px longest side.** CLIP internally rescales to 224×224
  anyway, but ~1024px keeps the Vision LLM happy while cutting storage/network
  cost ~15× vs a raw 12-megapixel phone upload.
- **Accepted inputs:** JPEG, PNG, WebP, and (when `IMG_ALLOW_HEIC=true`) iPhone
  HEIC/HEIF — all transcoded to the standard JPEG output.
- The stored object key extension is normalized to match the output format
  (`normaliseKeyExtension`), so the file on disk, its mimetype in the DB, and
  the bytes fed to CLIP all agree.

### What compression produces (example)

A typical 12 MP iPhone HEIC of ~3.2 MB becomes:

```
source:  { format: 'heif', width: 4032, height: 3024, bytes: 3,287,654 }
output:  { format: 'jpeg', width: 1024, height: 768,  bytes: 142,318 }   (≈ 23× smaller)
preprocess_ms: ~40
```

These numbers are returned on **every** upload response as `image_mime`,
`image_width`, `image_height`, `image_bytes`, `preprocess_ms`, and
`source_bytes`, so you can verify the compression ratio per request.

> **Note:** compression to quality 80 is *not* the cause of false `FAIL`s — both
> sides are compressed identically, and quality 80 preserves more than enough
> detail for cleanliness comparison. The real risk is a genuinely low-quality
> *source* photo (blurry, dark, tiny). That is what the next section addresses.

---

## 10. The low-quality image problem & the Quality Gate

### The problem (why it matters)

CLIP and the Vision LLM compare *visual content*. If a janitor uploads a photo
that is **blurry, too dark, overexposed, tiny, or framed completely
differently** than the reference, then:

- the CLIP embedding lands far from the reference embedding → **low cosine
  similarity** → the rule engine returns `FAIL` (or `MANUAL_REVIEW`), *even if
  the room is actually clean*; and
- the Vision LLM may also lower its score because it literally cannot see the
  detail.

In other words: **a bad photo is indistinguishable from a bad cleaning job to
the AI.** The janitor gets punished for a camera problem, not a cleaning
problem. The same applies on the admin side — a poor reference image poisons
*every* future comparison for that facility.

### Implemented behavior

The quality gate is **implemented** in `src/services/image-quality.service.ts` and
enforced on **both** admin and janitor uploads (after preprocessing, before
storage). Rejection returns HTTP **422** with code `LOW_QUALITY_IMAGE`.

Mobile clients can fetch live thresholds via `GET /api/upload-requirements`.

### Quality Gate flow

```
preprocessImage (sharp normalize)
        │
        ▼
assessImageQuality(buffer)   ◄── NEW: compute metrics, compare to thresholds
        │
   ┌────┴─────┐
   │ pass     │ fail
   ▼          ▼
store+embed   throw AppError 422 (LOW_QUALITY_IMAGE)  → client re-uploads
```

Run it on the **already-preprocessed** buffer so the metrics reflect what will
actually be embedded.

### Metrics & thresholds (all sourced from `sharp` — no extra dependency)

`sharp(buffer).stats()` returns per-channel stats plus `sharpness` and
`entropy`; `sharp(buffer).metadata()` gives dimensions. Proposed checks:

| Check | Signal | How (sharp) | Suggested reject threshold |
| ----- | ------ | ----------- | -------------------------- |
| Too small | resolution | `metadata.width * height` | longest side < 480px, or < 0.30 MP |
| Blurry | focus | `stats.sharpness` | sharpness < ~2.0 (tune empirically) |
| Too dark | exposure | mean of channel means | mean luma < 25 (of 255) |
| Overexposed / washed out | exposure | mean of channel means | mean luma > 235 |
| Near-blank / low detail | content | `stats.entropy` | entropy < ~2.5 |
| Suspiciously tiny file | compression artefacts | output `bytes` | < 15 KB after re-encode |

> Thresholds above are **starting points** — calibrate them on a sample of real
> "good" vs "bad" photos before enabling enforcement. Recommended rollout:
> first run in **log-only / warn** mode (record the metrics in `vision_raw` or a
> log line), gather data, then switch to hard rejection.

### Proposed implementation sketch

A new `src/services/image-quality.service.ts`:

```ts
import sharp from 'sharp';
import { AppError } from '../middlewares/error-handler.js';

export interface QualityReport {
  ok: boolean;
  width: number;
  height: number;
  megapixels: number;
  sharpness: number;
  brightness: number; // 0..255 mean luma
  entropy: number;
  reasons: string[];   // why it failed (empty when ok)
}

export async function assessImageQuality(buffer: Buffer): Promise<QualityReport> {
  const [meta, stats] = await Promise.all([
    sharp(buffer).metadata(),
    sharp(buffer).stats(),
  ]);

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const megapixels = (width * height) / 1_000_000;
  const sharpness = stats.sharpness ?? 0;
  const entropy = stats.entropy ?? 0;
  const brightness =
    stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) /
    Math.min(3, stats.channels.length);

  const reasons: string[] = [];
  if (Math.max(width, height) < 480) reasons.push('resolution_too_low');
  if (megapixels < 0.3) reasons.push('too_few_pixels');
  if (sharpness < 2.0) reasons.push('image_blurry');
  if (brightness < 25) reasons.push('image_too_dark');
  if (brightness > 235) reasons.push('image_overexposed');
  if (entropy < 2.5) reasons.push('image_low_detail');

  return { ok: reasons.length === 0, width, height, megapixels, sharpness, brightness, entropy, reasons };
}

export function enforceQuality(report: QualityReport): void {
  if (report.ok) return;
  throw new AppError('Image quality too low — please retake the photo', {
    status: 422,
    stage: 'image-quality',
    details: {
      code: 'LOW_QUALITY_IMAGE',
      reasons: report.reasons,
      metrics: {
        width: report.width,
        height: report.height,
        sharpness: Number(report.sharpness.toFixed(2)),
        brightness: Number(report.brightness.toFixed(1)),
        entropy: Number(report.entropy.toFixed(2)),
      },
      hint: 'Hold steady, ensure good lighting, and frame the same area as the reference.',
    },
  });
}
```

Wire it into **both** service methods in `cleaning.service.ts`, right after
`preprocessImage`:

```ts
const preprocessed = await preprocessImage(file.buffer);
const quality = await assessImageQuality(preprocessed.buffer);
enforceQuality(quality); // throws 422 → never stores/embeds a bad image
```

### Proposed error response (both admin & janitor)

```json
{
  "success": false,
  "error": {
    "message": "Image quality too low — please retake the photo",
    "stage": "image-quality",
    "code": "LOW_QUALITY_IMAGE",
    "reasons": ["image_blurry", "image_too_dark"],
    "metrics": { "width": 1024, "height": 768, "sharpness": 1.1, "brightness": 18.4, "entropy": 3.9 },
    "hint": "Hold steady, ensure good lighting, and frame the same area as the reference."
  }
}
```

HTTP **422 Unprocessable Entity** is the right status: the request was
well-formed, but the *content* can't be processed reliably.

### Why this fixes the "always FAIL" problem

- **Janitor side:** the janitor is told *immediately* "retake the photo" while
  they're still on-site, instead of getting a confusing `FAIL` later. A genuine
  clean room is no longer failed because of a blurry/dark shot.
- **Admin side:** a weak reference can never be registered, so it can't poison
  every future comparison for that facility.
- Because the gate is **shared** and runs on the **preprocessed** buffer, admin
  and janitor are held to identical standards — preserving the apples-to-apples
  guarantee.

### Optional refinements

- **Soft vs hard fail:** below a *hard* threshold → reject (422); between hard
  and *soft* thresholds → accept but force `MANUAL_REVIEW` and attach a
  `low_quality_warning` issue, so a human checks borderline shots.
- **Frame/coverage check:** optionally require a minimum CLIP similarity to *any*
  reference of the facility as a "is this even the right room?" sanity check
  before running the expensive Vision call.
- **Client-side pre-check:** mirror the lightest checks (resolution, brightness)
  in the mobile app so the user gets instant feedback before the upload even
  leaves the device.

---

## 11. Embeddings — what CLIP produces

`src/services/embedding.service.ts` loads `Xenova/clip-vit-base-patch32` once
per process (≈150 MB ONNX model, downloaded on first use) and exposes:

- `generateImageEmbeddingFromBuffer(buffer, mime)` — used by the **admin** path.
- `generateImageEmbeddingFromUrl(url)` — used by the **worker** for the janitor
  image.

Both decode the image, run the extractor with `{ pooling: 'mean', normalize:
true }`, and then **L2-normalize** the result.

**Output:** a fixed-length **512-dimension** vector of floats, L2-normalized
(its length is 1). Example (truncated):

```json
[0.0123, -0.0456, 0.0789, ..., 0.0021]   // 512 numbers, ||v|| = 1
```

Because vectors are L2-normalized, **cosine similarity reduces to a simple dot
product**, which is exactly what `pgvector`'s `<=>` operator and our
`cosineSimilarity` helper compute. In Postgres the vector is stored in a
`vector(512)` column via the textual literal `[0.0123,-0.0456,...]`
(`toPgVectorLiteral`).

---

## 12. Similarity — what cosine produces

`src/services/similarity.service.ts`:

- `cosineSimilarity(a, b)` → a number in **[-1, 1]** (1 = identical direction,
  0 = unrelated, -1 = opposite). For real photos it's typically 0.4–0.99.
- `findBestMatch(target, candidates)` → picks the reference with the highest
  cosine score: `{ match, score, index }`.

The worker clamps the score to `[-1, 1]` and stores it rounded to 4 decimals as
`similarity_score` (e.g. `0.9132`).

There are two cosine paths in the codebase:

- **In-process** (`findBestMatch`) — used by the worker after loading candidate
  rows. Exact, no index needed.
- **In-database** (`findBestMatchByVector` in the reference repo) — uses
  pgvector's `1 - (embedding <=> $1::vector)` with the `ivfflat` ANN index for
  scale. Available for when reference counts grow large.

---

## 13. Vision AI — what the LLM produces

`src/services/vision.service.ts` is provider-pluggable (`VISION_PROVIDER`):

- **`anthropic`** (default, Claude `claude-sonnet-4-5`): fetches both images and
  **inlines them as base64**, so it works even with local-storage URLs that
  aren't publicly reachable.
- **`openai`** (GPT-4o): sends image **URLs** directly (URLs must be publicly
  reachable).

Both use the **same** strict system prompt: they're shown the reference image
first and the uploaded image second, told to look for trash/stains/spills/dirt/
overflowing bins/water/etc. (and to ignore benign lighting/angle differences),
and must return **only** a JSON object:

```json
{
  "passed": true,
  "score": 91,
  "confidence": 94,
  "issues": []
}
```

- `passed` — boolean: clean and comparable to the reference?
- `score` — 0..100 cleanliness (100 = spotless).
- `confidence` — 0..100 how sure the model is.
- `issues` — short list of concrete problems (empty when passed).

The parser (`parseStrictJson` → `normalize`) strips any markdown fences, clamps
ints to range, and coerces the shape. The full raw response is stored in
`vision_raw` for audit. The result object also carries `provider` and `model`.

**Graceful fallback:** if the vision call throws (timeout, quota, bad key), the
worker does **not** crash — it substitutes
`{ passed:false, score:0, confidence:0, issues:['vision_error:...'], raw:null }`,
which pushes the verdict to `MANUAL_REVIEW`.

---

## 14. Rule engine — the decision matrix

`src/services/rule-engine.service.ts` combines the two signals. Thresholds come
from env (`CLEANING_SIMILARITY_PASS_THRESHOLD=0.85`,
`CLEANING_SIMILARITY_FAIL_THRESHOLD=0.65`).

| Condition | Decision | Reason |
| --------- | -------- | ------ |
| `similarity` not finite | `MANUAL_REVIEW` | `similarity_unavailable` |
| `similarity < 0.65` | **`FAIL`** | too visually different from clean reference |
| `similarity > 0.85` **AND** `vision.passed === true` | **`PASS`** | both signals agree it's clean |
| anything else (0.65 ≤ sim ≤ 0.85, or vision not passed) | **`MANUAL_REVIEW`** | uncertain → human |

Plus the worker's safety override: if vision was unavailable (`raw == null`) but
the rule said `PASS`, it's downgraded to `MANUAL_REVIEW`. **Both signals must
agree to auto-pass.**

Decision matrix at a glance:

```
                         vision.passed = true        vision.passed = false / unknown
 similarity > 0.85       PASS                         MANUAL_REVIEW
 0.65 ≤ sim ≤ 0.85       MANUAL_REVIEW                MANUAL_REVIEW
 similarity < 0.65       FAIL                         FAIL
```

---

## 15. Status lifecycle

```
                 (janitor upload)
                       │
                       ▼
                   ┌────────┐    worker picks up    ┌────────────┐
                   │PENDING │ ────────────────────► │ PROCESSING │
                   └────────┘                       └─────┬──────┘
                                                          │ saveResult
                        ┌───────────────┬─────────────────┼───────────────┐
                        ▼               ▼                 ▼               ▼
                     ┌──────┐        ┌──────┐      ┌──────────────┐   ┌───────┐
                     │ PASS │        │ FAIL │      │MANUAL_REVIEW │   │ ERROR │
                     └──────┘        └──────┘      └──────────────┘   └───────┘
```

- `PENDING` — row created, job queued (API response state).
- `PROCESSING` — worker started.
- `PASS` / `FAIL` / `MANUAL_REVIEW` — terminal verdicts from the rule engine.
- `ERROR` — worker threw (e.g. no reference for facility); `error_message` set,
  BullMQ retries per config.

Admin references don't have this lifecycle — they're inserted directly with
`is_active = true`.

---

## 16. Error handling, retries & timeouts

- **`AppError`** (`middlewares/error-handler.ts`) carries `status`, `stage`, and
  optional `details`/`cause`. Every service step wraps failures with a `stage`
  tag (`parse-input`, `image-preprocess`, `storage-upload`, `clip-embedding`,
  `db-insert`, `queue-enqueue`, …) so responses say *where* it broke.
- **Input guards:** Multer rejects bad MIME / oversized files; Zod rejects
  malformed bodies (`400`).
- **Worker retries:** BullMQ `attempts: 2` with exponential backoff (5s). On the
  final failure the row is marked `ERROR`.
- **Vision timeout:** `ANTHROPIC_TIMEOUT_MS` / `OPENAI_TIMEOUT_MS` (45s) via an
  `AbortController`; a timeout → fallback → `MANUAL_REVIEW`.
- **No-reference case:** if a facility has no active reference, the worker throws
  → `ERROR` (the janitor image can't be compared against anything).
- **Graceful shutdown:** `index.ts` closes server, worker, queue, redis, and pg
  pool on `SIGINT`/`SIGTERM`.

---

## 17. Output format reference

All success responses are `{ "success": true, "results": { ... } }`.

### Admin upload — `201`

```json
{
  "success": true,
  "results": {
    "id": 1,
    "facility_id": 42,
    "task_id": 168,
    "image_path": "cleaning/references/f42_..._ref.jpg",
    "image_url": "http://localhost:4000/files/cleaning/references/f42_..._ref.jpg",
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

### Janitor upload — `202` (ticket)

```json
{
  "success": true,
  "results": {
    "verification_id": 7,
    "task_id": 9001,
    "status": "PENDING",
    "image_path": "cleaning/completions/t9001_f42_..._x.jpg",
    "image_url": "http://localhost:4000/files/cleaning/completions/t9001_f42_..._x.jpg",
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

### Result — `200`

PASS:

```json
{ "success": true, "results": {
  "verification_id": 7, "task_id": 9001, "facility_id": 42, "task_id": 168,
  "reference_id": 1, "status": "PASS",
  "similarity_score": 0.9132,
  "vision": { "passed": true, "score": 91, "confidence": 94, "issues": [] },
  "rule_reason": "similarity 0.913 > pass_threshold 0.85 and vision passed",
  "created_at": "...", "processed_at": "..."
}}
```

FAIL:

```json
{ "success": true, "results": {
  "status": "FAIL", "similarity_score": 0.5821,
  "vision": { "passed": false, "score": 32, "confidence": 88,
              "issues": ["trash near sink", "wet floor", "overflowing bin"] },
  "rule_reason": "similarity 0.582 < fail_threshold 0.65"
}}
```

MANUAL_REVIEW:

```json
{ "success": true, "results": {
  "status": "MANUAL_REVIEW", "similarity_score": 0.7402,
  "vision": { "passed": true, "score": 72, "confidence": 60, "issues": ["minor dust on counter"] },
  "rule_reason": "similarity 0.740 in [0.65, 0.85] or vision verdict not pass (passed=true, confidence=60)"
}}
```

### Proposed low-quality rejection — `422` (see §10)

```json
{ "success": false, "error": {
  "message": "Image quality too low — please retake the photo",
  "stage": "image-quality", "code": "LOW_QUALITY_IMAGE",
  "reasons": ["image_blurry", "image_too_dark"],
  "metrics": { "width": 1024, "height": 768, "sharpness": 1.1, "brightness": 18.4, "entropy": 3.9 },
  "hint": "Hold steady, ensure good lighting, and frame the same area as the reference."
}}
```

---

## 18. Configuration reference

All config is Zod-validated in `src/config/env.ts` (invalid env → process exits).
The verification-relevant knobs:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `CLIP_MODEL_NAME` | `Xenova/clip-vit-base-patch32` | embedding model (512-dim) |
| `VISION_PROVIDER` | `anthropic` | `anthropic` (Claude) or `openai` (GPT-4o) |
| `ANTHROPIC_VISION_MODEL` | `claude-sonnet-4-5` | vision model |
| `ANTHROPIC_TIMEOUT_MS` / `OPENAI_TIMEOUT_MS` | `45000` | vision call timeout |
| `CLEANING_SIMILARITY_PASS_THRESHOLD` | `0.85` | cosine pass cut-off |
| `CLEANING_SIMILARITY_FAIL_THRESHOLD` | `0.65` | cosine fail cut-off |
| `WORKER_CONCURRENCY` | `2` | parallel jobs per worker |
| `RUN_WORKER_IN_API` | `true` | run worker inside API process |
| `IMG_MAX_DIMENSION` | `1024` | resize longest-side cap (px) |
| `IMG_OUTPUT_FORMAT` | `jpeg` | output format (`jpeg`/`webp`) |
| `IMG_OUTPUT_QUALITY` | `80` | encoder quality 1–100 |
| `IMG_DECODE_PIXEL_LIMIT` | `50000000` | decompression-bomb guard |
| `IMG_ALLOW_HEIC` | `true` | accept iPhone HEIC/HEIF |
| `IMG_MAX_UPLOAD_MB` | `15` | Multer max upload size |

> Proposed (not yet implemented) quality-gate knobs would live here too, e.g.
> `IMG_QUALITY_MIN_DIMENSION`, `IMG_QUALITY_MIN_SHARPNESS`,
> `IMG_QUALITY_MIN_BRIGHTNESS`, `IMG_QUALITY_MIN_ENTROPY`,
> `IMG_QUALITY_ENFORCE` (hard reject vs warn-only).

---

## 19. Edge cases & failure modes

| Scenario | Current behavior | Recommended handling |
| -------- | ---------------- | -------------------- |
| Janitor uploads blurry/dark photo | accepted → likely false `FAIL`/`MANUAL_REVIEW` | **Quality Gate** rejects with `422` (§10) |
| Admin uploads weak reference | accepted → poisons all future comparisons | Quality Gate rejects on admin path too |
| No active reference for facility | worker → `ERROR` | block janitor upload (or clearer message) until a reference exists |
| Vision API down / no key | fallback → `MANUAL_REVIEW` with `vision_error:` issue | acceptable; alert on rate of vision errors |
| Wrong room photographed | **422** at upload or **INVALID_TASK** in worker | scene match at 0.88 |
| Unsupported MIME / > 15 MB | Multer rejects (`400`/`413`) | as-is |
| Decompression bomb | sharp `limitInputPixels` rejects | as-is |
| Duplicate submissions for a task | each is a new row; latest wins | as-is (full history via `?includeHistory=true`) |

---

## 20. Production hardening checklist

The structure is production-shaped; before shipping, add:

- **Image Quality Gate** (§10) — implemented.
- **Scene match + percentage scoring** (§21–22) — implemented.
- **Auth** on upload endpoints (currently open) + **rate limiting**.
- **Reference existence check** before accepting janitor uploads.
- **Threshold calibration** on real data; consider per-facility/template
  thresholds.
- **Observability** — metrics on status distribution, vision error rate,
  similarity histogram; tracing (OpenTelemetry) + error reporting (Sentry).
- **Signed URLs** for GCS (so the Vision provider can fetch without making the
  bucket public).
- **Dockerfile + CI**, and a dead-letter strategy for repeatedly failing jobs.

---

## 21. Scene / task matching (implemented)

Wrong-area photos (corridor task + kitchen image) are rejected via
`src/services/scene-match.service.ts`:

1. **Sync at janitor upload** — CLIP embed + compare to template-scoped references;
   if best cosine < `SCENE_MATCH_MIN_SIMILARITY` (0.88) → HTTP **422**
   `INVALID_TASK_IMAGE` before storage.
2. **Worker double-check** — same logic; if fail → status **`INVALID_TASK`**, vision
   skipped.

`template_id` is **required** on janitor upload when `SCENE_MATCH_ENFORCE=true`.
References are loaded with **exact** `template_id` match when
`SCENE_MATCH_STRICT_TEMPLATE=true` (no NULL fallback).

---

## 22. Percentage-based scoring (implemented)

Rule engine v2 (`src/services/rule-engine.service.ts`) computes:

| Field | Formula |
|-------|---------|
| `scene_match_percent` | `similarity × 100` |
| `cleanliness_percent` | vision LLM score (0–100) |
| `overall_percent` | `0.30 × scene + 0.70 × cleanliness` |

**Decision matrix** (after scene match passes):

| Condition | Status |
|-----------|--------|
| similarity ≥ 0.85 AND cleanliness ≥ 80 AND vision.passed | **PASS** |
| cleanliness < 50 OR (cleanliness < 65 + stain-type issues) | **FAIL** |
| gray zone | **MANUAL_REVIEW** |
| scene match < 0.88 | **INVALID_TASK** / 422 |

Persisted in `cleaning_verifications.scene_match_percent`, `cleanliness_percent`,
`overall_percent` (migration `002_scene_match_scoring.sql`).

Run `npm run migrate` after pulling these changes.
