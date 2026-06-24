# Batch Upload Progress — Server-Sent Events (SSE) Design

> Real-time progress delivery for **async reference batch uploads**
> (`POST /api/admin/reference-batches`). Replaces high-frequency polling with a
> single long-lived HTTP stream while keeping the existing poll endpoint as a
> fallback.
>
> **Related documents**
> - [`REFERENCE_UPLOAD_API.md`](./REFERENCE_UPLOAD_API.md) — batch REST contract, DB schema, pipeline stages
> - [`DESIGN.md`](../DESIGN.md) — system architecture, image pipeline, async worker pattern
> - [`README.md`](../README.md) — install and run

---

## Table of contents

1. [Problem & goals](#1-problem--goals)
2. [Scope](#2-scope)
3. [Transport choice: SSE vs alternatives](#3-transport-choice-sse-vs-alternatives)
4. [High-level architecture](#4-high-level-architecture)
5. [End-to-end sequence](#5-end-to-end-sequence)
6. [API contract](#6-api-contract)
7. [Event schema](#7-event-schema)
8. [Server components](#8-server-components)
9. [Worker integration](#9-worker-integration)
10. [Client integration](#10-client-integration)
11. [State model & progress calculation](#11-state-model--progress-calculation)
12. [Reliability: reconnect, fallback, ordering](#12-reliability-reconnect-fallback-ordering)
13. [Security & authorization](#13-security--authorization)
14. [Deployment & proxy configuration](#14-deployment--proxy-configuration)
15. [Observability](#15-observability)
16. [Implementation plan & file map](#16-implementation-plan--file-map)
17. [Testing strategy](#17-testing-strategy)
18. [Open questions & future work](#18-open-questions--future-work)

---

## 1. Problem & goals

### Problem

When an admin submits **Upload Multiple → tag → Submit**, the API accepts up to
25 images and processes each item asynchronously in a BullMQ worker. The mobile
UI needs a live progress overlay (e.g. “Processing 3 of 12…”) and per-item
status updates until the batch reaches a terminal state (`COMPLETED`, `PARTIAL`,
or `FAILED`).

The current API design specifies **polling**:

```
GET /api/admin/reference-batches/:batchId   every 1500 ms
```

Polling works but has drawbacks at scale:

| Issue | Impact |
|-------|--------|
| Fixed interval regardless of activity | Wasted requests while idle; delayed UI when busy |
| One DB read per poll × N clients | Unnecessary load during large uploads |
| No per-stage granularity without very short intervals | Progress bar feels “steppy” |
| Battery / network on mobile | Repeated wake-ups on poor connectivity |

### Goals

| Goal | Measure |
|------|---------|
| **Real-time UI** | Item/batch updates visible within ~200 ms of DB commit |
| **Single connection** | One HTTP stream per active batch on the client |
| **Source of truth unchanged** | Postgres remains authoritative; SSE is a read projection |
| **Backward compatible** | Keep `GET …/:batchId` polling as fallback |
| **Multi-instance safe** | Works when API and worker run on separate processes/hosts |
| **Graceful degradation** | Client falls back to poll if SSE fails |

### Non-goals (this document)

- WebSocket bidirectional channel (no client → server commands over the stream)
- Push notifications when the app is backgrounded (use platform push separately)
- Progress for **janitor verification** jobs (different domain; may reuse pattern later)
- Replacing BullMQ job events — we publish **domain events** after DB updates

---

## 2. Scope

### In scope

- SSE endpoint for reference batch upload progress
- Redis pub/sub bridge between worker and API
- Event types aligned with existing batch poll payload
- Web (`EventSource`) and mobile integration guidance
- Retry batch (`POST …/retry`) reusing the same SSE channel

### Out of scope

- Implementing the batch upload feature itself (see `REFERENCE_UPLOAD_API.md`)
- Authentication middleware (document hooks only)
- CDN / edge caching of events

---

## 3. Transport choice: SSE vs alternatives

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Polling** (`GET /:id`) | Simple; works everywhere | Latency; DB load; chatty | **Fallback** |
| **SSE** (`text/event-stream`) | Native browser API; auto-reconnect; one-way fits progress | No RN built-in; proxies must disable buffering | **Primary** |
| **WebSocket** | Bidirectional; RN libraries mature | Overkill for server→client only; more infra | Defer |
| **Long polling** | Better than short poll | Still one request per update burst | Not chosen |

**Decision:** Use **SSE as the primary** progress channel. The worker runs in a
separate process from Express, so events are **published to Redis** and
**forwarded** by whichever API instance holds the client’s SSE connection.

---

## 4. High-level architecture

```
┌─────────────┐     POST /reference-batches      ┌─────────────────────────────┐
│ Mobile /    │ ───────────────────────────────► │ Express API                  │
│ Web client  │ ◄── 202 { batch_id, events_url }│  - create batch + items      │
└──────┬──────┘                                  │  - stage files               │
       │                                         │  - enqueue BullMQ jobs         │
       │ GET …/events (SSE)                      └───────────┬─────────────────┘
       │◄═══════════════════════════════════════►            │
       │         text/event-stream                           │ INSERT / UPDATE
       │                                                     ▼
       │                                         ┌─────────────────────────────┐
       │                                         │ PostgreSQL                   │
       │                                         │  reference_upload_batches    │
       │                                         │  reference_upload_items      │
       │                                         └───────────▲─────────────────┘
       │                                                     │
       │              Redis PUBLISH batch:{id}:events        │ UPDATE after each stage
       │         ┌───────────────────────────────────────────┤
       │         │                                           │
       │         ▼                                           │
       │  ┌──────────────┐         pull jobs        ┌────────┴────────────┐
       └──│ SSE handler  │◄── SUBSCRIBE ──────────│ Reference batch      │
          │ (per client) │     (dedicated Redis     │ worker (BullMQ)      │
          └──────────────┘      subscriber conn)    └─────────────────────┘
```

### Key design decisions

1. **Postgres is source of truth.** SSE never invents state; it relays committed
   DB state (initial snapshot + incremental updates).
2. **Publish after commit.** Worker publishes to Redis only after the
   transaction that updates `reference_upload_items` / batch counters succeeds.
3. **Dedicated Redis subscriber per SSE connection.** The shared `redis` client
   used for BullMQ must not enter `SUBSCRIBE` mode (blocks other commands).
4. **Terminal event closes the stream.** When batch status is
   `COMPLETED` | `PARTIAL` | `FAILED`, send `done` and `res.end()`.

---

## 5. End-to-end sequence

```
Client          API                 DB              Redis           Worker
  |              |                    |                 |                |
  |-- POST batch ------------------->|                 |                |
  |              |-- INSERT batch/items ------------->|                |
  |              |-- stage bytes --------------------->|                |
  |              |-- enqueue N jobs ----------------------------------->|
  |<- 202 batch_id, events_url ------|                 |                |
  |              |                    |                 |                |
  |-- GET …/events (SSE) ----------->|                 |                |
  |              |-- SELECT batch snapshot ----------->|                |
  |<- event: snapshot ---------------|                 |                |
  |              |-- SUBSCRIBE batch:{id}:events ----->|                |
  |              |                    |                 |                |
  |              |                    |                 |<-- job start --|
  |              |                    |<-- UPDATE item PROCESSING -------|
  |              |                    |                 |<-- PUBLISH ----|
  |              |<-- message -------------------------|                |
  |<- event: item_update -------------|                 |                |
  |              |                    |                 |                |
  |              |                    |<-- UPDATE item COMPLETED --------|
  |              |                    |<-- refresh batch counters -------|
  |              |                    |                 |<-- PUBLISH progress
  |<- event: progress ----------------|                 |                |
  |              |                    |                 |                |
  |              |                    |   (repeat per item)              |
  |              |                    |                 |                |
  |              |                    |<-- batch terminal status --------|
  |              |                    |                 |<-- PUBLISH done |
  |<- event: done -------------------|                 |                |
  |   (stream closed)                |-- UNSUBSCRIBE -->|                |
```

---

## 6. API contract

### 6.1 New endpoint

| Method | Path | `Content-Type` (response) | Description |
|--------|------|---------------------------|-------------|
| `GET` | `/api/admin/reference-batches/:batchId/events` | `text/event-stream; charset=utf-8` | Live batch progress stream |

### 6.2 Changes to existing endpoints

**`POST /api/admin/reference-batches`** — add to `202` response:

```json
{
  "success": true,
  "results": {
    "batch_id": "b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c",
    "status": "QUEUED",
    "events_url": "/api/admin/reference-batches/b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c/events",
    "poll_url": "/api/admin/reference-batches/b7c2a1f0-3e4d-5f6a-8b9c-0d1e2f3a4b5c",
    "poll_interval_ms": 1500
  }
}
```

**`POST /api/admin/reference-batches/:batchId/retry`** — same `events_url` /
`poll_url` in `202` response (client reconnects to the **same** `batchId`).

**`GET /api/upload-requirements`** — extend `results.batch`:

```json
{
  "batch": {
    "max_items": 25,
    "poll_interval_ms": 1500,
    "prefer_events": true,
    "events_path_template": "/api/admin/reference-batches/{batchId}/events"
  }
}
```

**`GET /api/admin/reference-batches/:batchId`** — unchanged; remains the
authoritative snapshot for poll fallback and post-stream reconciliation.

### 6.3 HTTP headers (SSE response)

| Header | Value |
|--------|-------|
| `Content-Type` | `text/event-stream; charset=utf-8` |
| `Cache-Control` | `no-cache, no-transform` |
| `Connection` | `keep-alive` |
| `X-Accel-Buffering` | `no` (nginx — disable response buffering) |

Optional: `Last-Event-ID` request header on reconnect (see §12).

### 6.4 Error responses (non-SSE)

These apply **before** the stream starts (wrong `Accept`, unknown batch, auth):

| Condition | HTTP | Body |
|-----------|------|------|
| Unknown `batchId` | `404` | `{ "success": false, "error": "Batch not found" }` |
| Invalid UUID | `400` | `{ "success": false, "error": "Invalid batchId" }` |
| Unauthorized | `401` / `403` | Standard envelope |

Once `200` + stream headers are sent, errors use an `event: error` (see §7).

---

## 7. Event schema

SSE format follows the [WHATWG spec](https://html.spec.whatwg.org/multipage/server-sent-events.html):

```
event: <name>
data: <json>

```

Comments (heartbeats): `: ping\n\n` (no `event` or `data` fields).

### 7.1 Event types

| Event | When emitted | `data` shape |
|-------|--------------|--------------|
| `snapshot` | Immediately after connection; also after reconnect gap-fill | Full batch DTO (same as `GET /:batchId` → `results`) |
| `item_update` | Item `status` or `stage` changes | Partial item object |
| `progress` | Batch counters or `status` change | `{ status, progress }` |
| `done` | Batch reaches terminal status | Full batch DTO (includes `failed_items` when partial) |
| `error` | Unrecoverable stream/server error | `{ code, message }` |

### 7.2 `snapshot` / `done` payload

Identical to the poll response in [`REFERENCE_UPLOAD_API.md` §6.2](./REFERENCE_UPLOAD_API.md#62-get-apiadminreference-batchesbatchid):

```typescript
interface BatchProgressDto {
  batch_id: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  facility_id: number;
  template_id: number | null;
  progress: {
    total: number;
    queued: number;
    processing: number;
    completed: number;   // terminal items (succeeded + failed)
    failed: number;
    succeeded: number;
  };
  items: BatchItemDto[];
  failed_items?: BatchItemDto[];  // present on PARTIAL / FAILED in done
  created_at: string;
  completed_at: string | null;
}
```

### 7.3 `item_update` payload

```typescript
interface BatchItemUpdateDto {
  item_id: string;
  client_ref: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  stage?: string;           // e.g. 'image-quality', 'clip-embedding'
  reference_id?: number;    // when COMPLETED
  error?: ItemErrorDto;     // when FAILED
  processed_at?: string;
}
```

Clients should **merge** `item_update` into local state keyed by `item_id` or
`client_ref`.

### 7.4 `progress` payload

```typescript
interface BatchProgressSummaryDto {
  status: BatchProgressDto['status'];
  progress: BatchProgressDto['progress'];
}
```

### 7.5 Example stream (abbreviated)

```
event: snapshot
data: {"batch_id":"b7c2...","status":"PROCESSING","progress":{"total":2,"queued":1,"processing":1,"completed":0,"failed":0,"succeeded":0},"items":[...]}

event: item_update
data: {"item_id":"i111...","client_ref":"uuid-001","status":"PROCESSING","stage":"image-preprocess"}

event: item_update
data: {"item_id":"i111...","client_ref":"uuid-001","status":"COMPLETED","reference_id":101,"processed_at":"2026-06-23T10:20:03.000Z"}

event: progress
data: {"status":"PROCESSING","progress":{"total":2,"queued":0,"processing":1,"completed":1,"failed":0,"succeeded":1}}

event: item_update
data: {"item_id":"i222...","client_ref":"uuid-002","status":"FAILED","stage":"image-quality","error":{"code":"LOW_QUALITY_IMAGE","message":"...","retriable":true}}

event: progress
data: {"status":"PARTIAL","progress":{"total":2,"queued":0,"processing":0,"completed":2,"failed":1,"succeeded":1}}

event: done
data: {"batch_id":"b7c2...","status":"PARTIAL","progress":{...},"failed_items":[...],"items":[...]}

```

### 7.6 Redis message envelope

Published to channel `batch:{batchId}:events`:

```typescript
interface RedisBatchEvent {
  event: 'item_update' | 'progress' | 'done';
  data: unknown;
  /** Monotonic per batch — optional, for Last-Event-ID */
  id?: string;
  published_at: number; // Date.now()
}
```

JSON-serialized as a single string argument to `PUBLISH`.

---

## 8. Server components

### 8.1 Module layout

```
src/
  services/
    batch-progress.service.ts      # publish(), channel name, terminal check
  controllers/
    reference-batch.controller.ts    # POST, GET, SSE, retry
  repositories/
    reference-upload-batch.repo.ts   # snapshot + counter refresh
```

### 8.2 `batch-progress.service.ts`

Responsibilities:

- `batchChannel(batchId: string): string` → `batch:{batchId}:events`
- `publishBatchEvent(batchId, event, data, id?)` → `redis.publish(...)`
- `isTerminalBatchStatus(status)` → boolean
- `TERMINAL_STATUSES` constant

Uses the **shared** Redis client (publish-only; never subscribe).

### 8.3 SSE controller handler

Pseudocode flow:

```
1. Validate batchId (UUID)
2. Load batch snapshot from DB
3. If not found → 404 JSON (do not open stream)
4. Set SSE headers; flush
5. Write event: snapshot
6. If terminal → write event: done; end
7. Create dedicated IORedis subscriber (getBullMQConnection())
8. SUBSCRIBE batch:{batchId}:events
9. Start heartbeat interval (25s): res.write(': ping\n\n')
10. On Redis message → parse → write SSE event (+ optional id: field)
11. On event done → cleanup; res.end()
12. On req.close / res.close → cleanup (unsubscribe, quit subscriber, clear interval)
```

**Important:** Never reuse `export const redis` from `src/queue/redis.ts` for
`SUBSCRIBE`. BullMQ and pub/sub require separate connections.

### 8.4 Connection registry (optional, single-instance only)

For graceful shutdown of open SSE connections, keep a `Set<Response>` and close
all on `SIGTERM`. Not required for correctness in multi-instance deployments.

---

## 9. Worker integration

### 9.1 When to publish

| Worker action | Redis event | Notes |
|---------------|-------------|-------|
| Job picked up; item → `PROCESSING` | `item_update` | Include current `stage` |
| Stage transition (e.g. quality → storage) | `item_update` | Optional; improves UX |
| Item → `COMPLETED` or `FAILED` | `item_update` | Include `reference_id` or `error` |
| After `refreshBatchCounters()` | `progress` | Recompute from DB |
| Batch becomes terminal | `done` | Full snapshot; then stop publishing |

### 9.2 Publish helper (worker)

```typescript
async function emitItemUpdate(batchId: string, item: BatchItemUpdateDto) {
  await publishBatchEvent(batchId, 'item_update', item);
}

async function emitBatchProgress(batchId: string) {
  const summary = await batchRepo.refreshBatchCounters(batchId);
  await publishBatchEvent(batchId, 'progress', {
    status: summary.status,
    progress: summary.progress,
  });
  if (isTerminalBatchStatus(summary.status)) {
    await publishBatchEvent(batchId, 'done', summary);
  }
}
```

Call `emitBatchProgress` after every terminal item update so batch-level status
and counters stay in sync.

### 9.3 Transaction ordering

```
BEGIN
  UPDATE reference_upload_items SET status = ..., stage = ... WHERE id = ...
  SELECT ... FOR UPDATE batch row (optional)
  UPDATE reference_upload_batches SET succeeded_count = ..., status = ...
COMMIT
→ publishBatchEvent(...)   // only after COMMIT
```

If publish fails after commit, the client still has poll fallback; a reconnect
gets a fresh `snapshot` from DB.

### 9.4 Retry flow

`POST …/retry` resets failed items to `QUEUED`, re-stages bytes, re-enqueues
jobs. The **same** `batchId` and SSE channel apply. Client:

1. Keeps or reopens SSE to `events_url`
2. Receives new `item_update` / `progress` events as retried items process

---

## 10. Client integration

### 10.1 Recommended flow

```
1. POST /reference-batches
2. Open EventSource(results.events_url)
3. On snapshot → render initial progress UI
4. On item_update → merge into items map; update row/spinner
5. On progress → update bar and "N of M" label
6. On done → close EventSource; show error modal if PARTIAL; enable Next if COMPLETED
7. On error / connection failure → fall back to poll_url every poll_interval_ms
```

### 10.2 Web (`EventSource`)

```javascript
function watchBatch({ eventsUrl, pollUrl, pollIntervalMs, onSnapshot, onProgress, onDone }) {
  const es = new EventSource(eventsUrl);
  let closed = false;

  const close = () => {
    if (!closed) {
      closed = true;
      es.close();
    }
  };

  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
  es.addEventListener('item_update', (e) => onProgress({ type: 'item', data: JSON.parse(e.data) }));
  es.addEventListener('progress', (e) => onProgress({ type: 'batch', data: JSON.parse(e.data) }));
  es.addEventListener('done', (e) => {
    onDone(JSON.parse(e.data));
    close();
  });

  es.onerror = () => {
    close();
    pollUntilDone(pollUrl, pollIntervalMs, onDone);
  };

  return close;
}
```

### 10.3 React Native

`EventSource` is not built into React Native. Options:

| Library | Notes |
|---------|-------|
| `react-native-sse` | Lightweight EventSource polyfill |
| `expo-fetch` + manual SSE parser | More control; more code |
| Poll-only | Acceptable fallback on RN if SSE libs are problematic |

Recommendation: try SSE via polyfill; fall back to poll using `poll_url`.

### 10.4 UI mapping (unchanged from API doc)

| `batch.status` | UI |
|----------------|-----|
| `QUEUED` / `PROCESSING` | Progress overlay; disable Next |
| `COMPLETED` | Enable Next |
| `PARTIAL` | Error modal + Retry |
| `FAILED` | Error modal |

Progress bar formula:

```
percent = Math.round((progress.succeeded + progress.failed) / progress.total * 100)
```

Or show succeeded-only if product prefers: `succeeded / total`.

---

## 11. State model & progress calculation

### 11.1 Item statuses

```
QUEUED → PROCESSING → COMPLETED
                    → FAILED
QUEUED → CANCELLED   (admin cancel — future)
FAILED → QUEUED      (retry)
```

### 11.2 Batch statuses

| Condition | Batch status |
|-----------|--------------|
| All items terminal, zero failures | `COMPLETED` |
| All items terminal, some failures | `PARTIAL` |
| All items terminal, all failed | `FAILED` |
| Otherwise | `PROCESSING` (or `QUEUED` if none started) |

### 11.3 `refreshBatchCounters(batchId)` (repository)

Single SQL transaction:

```sql
-- Aggregate item counts
SELECT
  COUNT(*) FILTER (WHERE status = 'QUEUED')      AS queued,
  COUNT(*) FILTER (WHERE status = 'PROCESSING')  AS processing,
  COUNT(*) FILTER (WHERE status = 'COMPLETED')   AS succeeded,
  COUNT(*) FILTER (WHERE status = 'FAILED')      AS failed,
  COUNT(*)                                       AS total
FROM reference_upload_items
WHERE batch_id = $1;

-- Derive batch.status from counts + UPDATE reference_upload_batches
-- Set completed_at when terminal
```

Return full DTO for `snapshot` / `done`.

---

## 12. Reliability: reconnect, fallback, ordering

### 12.1 Heartbeat

Send `: ping\n\n` every **25 seconds** to prevent idle timeouts (load balancers,
nginx `proxy_read_timeout`, mobile NAT).

### 12.2 Client reconnect

`EventSource` auto-reconnects by default. On reconnect:

1. Server sends fresh `snapshot` from DB (always)
2. If already terminal → `done` → close (client may have missed prior `done`)

Optional enhancement: client sends `Last-Event-ID: <id>`; server includes
monotonic `id:` field on each event and could skip replay (DB snapshot makes this
optional for v1).

### 12.3 Poll fallback

Trigger fallback when:

- `EventSource.onerror` fires
- No event (including ping) received for **60 s**
- HTTP `events_url` returns non-200

Use existing `GET /:batchId` until terminal status.

### 12.4 Event ordering

Per batch, worker processes items concurrently (BullMQ concurrency > 1). Events
may arrive out of order relative to `sort_order`. Clients must merge by
`item_id`, not assume sequence.

### 12.5 Missed events

Redis pub/sub is **fire-and-forget**. If no SSE client is connected, events are
lost — acceptable because:

- `GET /:batchId` always returns current DB state
- Reconnect sends `snapshot`

---

## 13. Security & authorization

### 13.1 Requirements (production)

| Check | Rationale |
|-------|-----------|
| Authenticate admin | Batch IDs are UUIDs but not secret |
| Authorize `facility_id` on batch | Prevent cross-tenant progress snooping |
| Rate-limit SSE connections per user | Prevent connection exhaustion |

Hook: run auth middleware **before** SSE handler; return `401`/`403` JSON if
failed (before stream opens).

### 13.2 POC phase

May defer auth if aligned with other admin routes; document as tech debt.

### 13.3 CORS

If web admin is on another origin, ensure `Access-Control-Allow-Origin` for
`GET` and that credentials mode matches cookie/token strategy. `EventSource`
does not support custom headers in all browsers — prefer cookie auth or
query-token (`?token=`) only if unavoidable (prefer cookie).

---

## 14. Deployment & proxy configuration

### 14.1 nginx

```nginx
location /api/admin/reference-batches/ {
  proxy_pass http://api_upstream;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600s;
  chunked_transfer_encoding off;  # some setups need this off for SSE
}
```

### 14.2 Load balancers

- Enable **sticky sessions** not required (any API instance can subscribe to Redis)
- Increase idle timeout > heartbeat interval

### 14.3 Horizontal scaling

```
Worker (any host) ──PUBLISH──► Redis ◄──SUBSCRIBE── API instance A → Client 1
                                      ◄──SUBSCRIBE── API instance B → Client 2
```

Multiple subscribers on the same channel each receive all messages — correct
for SSE fan-out.

---

## 15. Observability

### 15.1 Metrics (recommended)

| Metric | Type |
|--------|------|
| `sse_connections_active` | gauge |
| `sse_events_sent_total` | counter by `event` |
| `batch_progress_publish_total` | counter |
| `sse_connection_duration_seconds` | histogram |

### 15.2 Logging

- Log SSE connect/disconnect with `batchId`, `duration_ms`
- Log publish failures at `warn` (DB already committed)
- Do not log full image bytes or PII in event payloads

### 15.3 Tracing

Optional: propagate `batch_id` in worker logs and SSE handler for correlation.

---

## 16. Implementation plan & file map

### Phase 1 — Batch foundation (prerequisite)

| Task | File(s) |
|------|---------|
| Migration for batch tables | `db/migrations/002_reference_upload_batches.sql` |
| Repository | `src/repositories/reference-upload-batch.repo.ts` |
| POST / GET batch | `src/controllers/reference-batch.controller.ts` |
| Queue + worker | `src/queue/reference-batch.queue.ts`, `src/workers/reference-batch.worker.ts` |

See [`REFERENCE_UPLOAD_API.md` §10](./REFERENCE_UPLOAD_API.md#10-implementation-status).

### Phase 2 — SSE layer

| Task | File(s) |
|------|---------|
| Redis publish helpers | `src/services/batch-progress.service.ts` |
| SSE route handler | `src/controllers/reference-batch.controller.ts` |
| Wire route | `src/routes/index.ts` |
| Worker publish calls | `src/workers/reference-batch.worker.ts` |
| Extend upload-requirements | `src/services/cleaning.service.ts` |
| Update API doc cross-links | `docs/REFERENCE_UPLOAD_API.md` |

### Phase 3 — Client

| Task | File(s) |
|------|---------|
| Demo web UI | `public/index.html` or admin batch page |
| Mobile integration notes | app repo (out of scope here) |

---

## 17. Testing strategy

### 17.1 Unit tests

- `isTerminalBatchStatus` mapping
- `refreshBatchCounters` SQL logic (queued/processing/succeeded/failed → batch status)
- Redis message JSON round-trip

### 17.2 Integration tests

1. Create batch with 2 items (mock worker or fast stub pipeline)
2. Open SSE with `fetch` + stream reader or `eventsource` package in Node
3. Assert: `snapshot` first; at least one `item_update`; terminal `done`
4. Kill SSE mid-flight; `GET /:batchId` returns consistent state

### 17.3 Manual curl (snapshot-only terminal batch)

```bash
curl -N -H 'Accept: text/event-stream' \
  http://localhost:4000/api/admin/reference-batches/<batchId>/events
```

### 17.4 Load

- 10 concurrent SSE clients on one batch — all receive identical events
- Verify Redis subscriber connections are closed on client disconnect (no leak)

---

## 18. Open questions & future work

| Topic | Options | Recommendation |
|-------|---------|----------------|
| Per-stage events | Emit on every pipeline stage vs only status changes | Emit on status + stage change (better UX, low cost) |
| `Last-Event-ID` replay | Redis Streams vs DB snapshot on reconnect | v1: snapshot only; add Streams if needed |
| Janitor verification SSE | Reuse channel pattern for `GET /tasks/:id/events` | Future; same Redis pub/sub design |
| Admin cancel in-flight batch | `POST …/cancel` + `CANCELLED` items | Out of scope v1 |
| Compression of SSE payloads | gzip breaks SSE | Do not compress event-stream |

---

## Appendix A — Comparison with janitor verification polling

Today, janitor completion uses the same **poll** pattern as batch upload was
originally designed:

```
GET /api/tasks/:taskId/result   every ~1500 ms
```

The SSE architecture in this document can be reused later with channel
`task:{taskId}:events` and events `snapshot` / `progress` / `done` — but that
is a separate feature with different payload shape (single verification row).

---

## Appendix B — Document history

| Date | Change |
|------|--------|
| 2026-06-24 | Initial design — SSE primary, poll fallback, Redis pub/sub bridge |
