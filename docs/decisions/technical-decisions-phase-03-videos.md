---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-18
scope_description: "Backend foundation for video upload and processing: object storage usage, processing queue technology, 10GB upload protocol, video worker runtime and FFmpeg tooling, unique video URL, streaming/download delivery, video status lifecycle and failure handling, and how queue/worker/storage are exercised by tests."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the new `videos` module (upload handshake, status lifecycle, stream/download endpoints), the video worker process, the new Compose services (object storage, queue broker, worker) and the `videos` table migration.
- `next-frontend/` — Frontend deferred: the video upload/player UI is out of scope for this phase (Phase 05 delivers the player page). The only frontend-facing items are the Cross-layer contracts (upload handshake TD-02, stream/download delivery TD-07), decided here once so the future UI consumes them unchanged. No frontend-only open decision in this document.

**Fixed inputs (not reopened here):**

- Object storage technology is S3-compatible (architecture diagram `docs/diagrams/software-arch.mermaid`: "Object Storage — S3 or MinIO"). MinIO runs locally in Docker; S3 in production. This document decides *how* storage is used (TD-03), not *which* storage.
- Inherited from prior phases: `@nestjs/config` + Joi env validation with `registerAs` namespaces (phase-01-configuracao-base/TD-01..04), custom JWT guard global with `@Public()` opt-out (phase-02-auth/TD-02), domain exception filter (phase-02-auth/TD-07), `class-validator` DTOs (phase-02-auth/TD-06), `@nestjs/throttler` (phase-02-auth/TD-08), TypeORM migrations, shared test DB run `--runInBand`.

**Version facts gathered for this research (2026-10-18, `npm view` + Context7 `/taskforcesh/bullmq`):**

- Installed: `@nestjs/common` 11.x, `typeorm` 0.3.28, `pg` 8.20, Node 25 (container `node:25.6.0-slim`).
- `bullmq` latest is **6.3.16**. v6 changelog: `ioredis` is no longer a direct dependency (optional peer — Redis users install it explicitly); a **PostgreSQL backend** was added (`pg` optional peer, explicit `runMigrations(client)`); `connection` is now mandatory.
- `@nestjs/bullmq` **11.0.5** peers `@nestjs/common ^10 || ^11` and `bullmq ^3..^6` (12.0.0 targets Nest 12 — not compatible with the installed Nest 11).
- `fluent-ffmpeg` 2.1.3 is **deprecated on npm** ("Package no longer supported").
- `nanoid` 6 is ESM-only (`"type": "module"`), friction with the project's CommonJS + ts-jest setup.
- `minio/minio` no longer resolves on Docker Hub (pull access denied) and `quay.io/minio/minio` requires authentication; `cgr.dev/chainguard/minio` (MinIO RELEASE.2026-09-22) and `cgr.dev/chainguard/minio-client` are publicly pullable.
- `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` latest 3.1152.0.

---

## TD-01: Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan and the architecture diagram leave the message queue as "TBD". After an upload completes, the API must hand a processing job to a separate worker without blocking the request; the job must survive API/worker restarts, support retries with backoff, and be observable (failed jobs inspectable). This is the main stack decision of the phase and every other async TD depends on it.

**Options:**

### Option A: BullMQ on Redis (`bullmq` 6 + `ioredis` + `@nestjs/bullmq` 11)
- Redis-backed job queue; the API adds jobs via an injected `Queue`, the worker consumes with a `WorkerHost` processor. Retries/backoff, concurrency, delayed jobs and failed-job retention are built in. Adds a `redis` service to Compose.
- **Pros:** Official NestJS integration (`@nestjs/bullmq` documented in the Nest "Queues" recipe); the most mature and documented BullMQ backend; job-level retry/backoff and `failed` event map directly to TD-08; Redis is a small, standard container.
- **Cons:** New infrastructure dependency (Redis) to operate and back up; jobs live outside PostgreSQL, so "update DB + enqueue" is not atomic (needs ordering care, see TD-08).

### Option B: pg-boss (queue in PostgreSQL)
- Job queue implemented on PostgreSQL tables using `SKIP LOCKED`. No new container — reuses `db`.
- **Pros:** Zero new infrastructure; enqueue can share the TypeORM transaction (atomic status change + job); retries and dead-letter supported.
- **Cons:** No first-party NestJS module (manual provider wiring); polling-based, adds load to the primary DB that also serves the API; the architecture diagram models the queue as a separate container, which this option collapses into the DB.

### Option C: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- Dedicated AMQP broker; API publishes a message, worker consumes with manual ack; retries via dead-letter exchanges + TTL.
- **Pros:** True message broker, language-agnostic consumers, strong delivery semantics; matches "Message Queue" container literally.
- **Cons:** Heaviest option to run and configure; retry/backoff and job state are DIY (DLX topology); job status/inspection not built in; no official Nest module (community package).

### Option D: BullMQ on PostgreSQL backend (BullMQ 6 `pg` backend)
- Same BullMQ API as Option A, but persisted in PostgreSQL (new in v6, schema created via `runMigrations`).
- **Pros:** BullMQ ergonomics without a new container.
- **Cons:** Brand-new backend (introduced in the v6 major) with little production track record; its schema migrations live outside TypeORM's migration history; same "queue inside the primary DB" drawback as Option B.

**Recommendation:** **Option A (BullMQ on Redis)** — it is the only option with an official NestJS module compatible with the installed Nest 11 (`@nestjs/bullmq` 11.0.5), gives retries/backoff/failed-job retention out of the box (needed by TD-08), and keeps queue load off the PostgreSQL instance that serves the API, matching the separate "Message Queue" container in the architecture diagram. The non-atomic DB+enqueue gap is handled by ordering (commit status first, enqueue second, idempotent job — see TD-08) rather than by co-locating the queue in the DB.

**Decision:** A (BullMQ on Redis)
**Libraries:** bullmq, @nestjs/bullmq, ioredis

---

## TD-02: Large File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB body must not flow through the NestJS process (memory, event loop, request timeouts, horizontal scaling). The project plan's "Pontos de Atenção" also asks that the upload can be **resumed** after a connection failure. The protocol is a contract between the API, the storage and the (future) frontend client, hence Cross-layer. Note the S3 hard limit: a single `PUT` object is capped at 5GB, so 10GB requires multipart.

**Options:**

### Option A: Direct-to-storage S3 multipart upload with presigned part URLs
- API pre-registers the video and calls `CreateMultipartUpload`; it returns presigned `UploadPart` URLs. The client `PUT`s each part straight to storage, collects ETags, and calls the API to `CompleteMultipartUpload`. Uploaded parts can be listed (`ListParts`) to resume.
- **Backend impact:** 3–4 small JSON endpoints (initiate, sign parts / list uploaded parts, complete); zero file bytes through the API.
- **Frontend impact:** client slices the `File` into parts, uploads them (optionally in parallel) and reports ETags — a standard browser pattern; storage CORS must expose `ETag`.
- **Pros:** API never touches the payload; supports >5GB (up to 10,000 parts); natively resumable per part; identical on MinIO and AWS S3.
- **Cons:** Multi-step handshake; incomplete uploads leave orphan parts unless aborted/expired; storage must be reachable by the client (public endpoint for presigning, see TD-03).

### Option B: Single presigned `PUT` URL
- API pre-registers the video and returns one presigned `PutObject` URL; the client uploads the whole file in one request.
- **Pros:** Simplest handshake (1 URL); payload still bypasses the API.
- **Cons:** S3 caps single `PUT` at 5GB — **cannot satisfy 10GB**; no resume (a dropped connection restarts from zero).

### Option C: tus resumable protocol through the API (tus server in Nest)
- A tus server (e.g., `@tus/server` + S3 store) mounted in the API receives chunks and writes them to storage.
- **Pros:** Open resumable-upload protocol with ready clients (Uppy, tus-js-client).
- **Cons:** All bytes still flow through the API process (CPU/network of the API scales with uploads — the exact load the capability forbids); extra server library + state store.

### Option D: Streaming multipart/form-data through the API
- Client posts `multipart/form-data`; the API streams the body to storage (e.g., `@aws-sdk/lib-storage`).
- **Pros:** Single request, familiar.
- **Cons:** The API holds the connection for the whole 10GB transfer (ties up workers, timeouts, proxies); no resume; violates "sem travar o sistema".

**Recommendation:** **Option A (direct-to-storage multipart with presigned part URLs)** — it is the only option that both keeps every byte out of the API and supports objects above 5GB with per-part resume, and it works unchanged on MinIO (dev) and S3 (prod). Policies proposed for the plan: max size **10 GiB (10,737,418,240 bytes)** validated at initiation; fixed part size **64 MiB** (10 GiB → 160 parts, well within S3's 5 MiB–5 GiB per part and 10,000-part limits); presigned part URLs expire after **1 hour** and can be re-signed for resume; accepted content types limited to video MIME types (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`).

**Decision:** A (Direct-to-storage S3 multipart upload with presigned part URLs)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Object Storage Organization and Endpoint Strategy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** S3/MinIO is fixed; what must be decided is how objects are laid out, how the bucket is provisioned in Compose, and how presigned URLs work when the API talks to storage via the Compose network (`minio:9000`) but clients reach it through the host. A presigned URL signs the host, so the signing endpoint must be the one the client will call. Cross-component: env keys (Joi schema + `.env.example` + `compose.yaml`) and the storage service.

**Options:**

### Option A: Single private bucket, prefixed keys, two S3 clients (internal + public endpoint)
- One private bucket (e.g., `streamtube-videos`) with keys `videos/{videoId}/original` and `thumbnails/{videoId}.jpg`. API/worker use an internal client (`S3_ENDPOINT=http://minio:9000`) for server-side calls; presigned URLs are generated by a second client configured with `S3_PUBLIC_ENDPOINT` (host-reachable). Bucket created by a one-shot `mc mb --ignore-existing` init container.
- **Pros:** Keys derive from the immutable `videoId` (no collision, no user-controlled path); one bucket = one CORS/lifecycle policy; endpoint split keeps the "service name, never localhost" rule for server-to-server traffic while giving clients a reachable URL; same code on S3 (both endpoints = AWS).
- **Cons:** Two clients to configure; public endpoint must be overridden in tests that run inside the Compose network.

### Option B: Separate buckets for videos and thumbnails
- `videos` (private) and `thumbnails` (could be public-read) buckets.
- **Pros:** Thumbnails could be served without signing; independent lifecycle policies.
- **Cons:** Two buckets to provision; a public bucket bypasses the access policy of TD-09 and draft semantics; marginal gain in a phase with no listing UI.

### Option C: Keys by user-provided filename
- `videos/{channelId}/{originalFilename}`.
- **Pros:** Human-readable keys.
- **Cons:** Collisions and path-injection risk, rename problems; violates "sem conflito".

**Recommendation:** **Option A** — immutable `videoId`-based keys in one private bucket remove any collision/injection surface, and the internal/public endpoint split is the only way to presign URLs a client can use while keeping server-to-server traffic on the Compose service name. MinIO image: `cgr.dev/chainguard/minio` + `cgr.dev/chainguard/minio-client` pinned by digest (the `minio/minio` Docker Hub image is no longer available).

**Decision:** A (Single private bucket, prefixed keys, internal + public endpoint clients)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-18 — Both S3 clients set `forcePathStyle: true` (MinIO path-style addressing) and `requestChecksumCalculation: 'WHEN_REQUIRED'` (the SDK default `WHEN_SUPPORTED` adds flexible-checksum parameters to presigned `UploadPart`/`PutObject` URLs that a browser `PUT` would then have to satisfy). Rationale: Param updated to match the installed AWS SDK v3 behavior (Context7 `/aws/aws-sdk-js-v3`, CLIENTS.md `requestChecksumCalculation`).

---

## TD-04: Video Worker Runtime and Deployment

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The architecture diagram defines a "Video Worker (FFmpeg)" container separate from the API. FFmpeg work is CPU-heavy and must not compete with HTTP handling. Decide where the worker code lives and how it runs in Compose. Depends on TD-01.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- A second bootstrap (`src/worker.ts`) creates a Nest application context (`NestFactory.createApplicationContext(WorkerModule)`) that registers only the queue processor plus the modules it needs (TypeORM, storage, videos repository). Compose runs it as a `video-worker` service from the same dev image (with `ffmpeg` installed), command `npm run start:worker`.
- **Pros:** Reuses entities, config namespaces, repository and storage service — no duplicated domain code; separate process/container satisfies the diagram; scales independently (`docker compose up --scale video-worker=N`).
- **Cons:** Worker and API share one `package.json`/image (API image gains `ffmpeg`); module boundaries must be kept clean so the worker does not boot HTTP-only modules.

### Option B: Separate subproject (`video-worker/`) with its own package
- Standalone Node project with its own dependencies, reading the same DB/storage.
- **Pros:** Hard isolation, slim worker image.
- **Cons:** Duplicates the `Video` entity, config and storage code (drift risk); new subproject tooling (lint, tsconfig, tests) — large cost for one processor.

### Option C: Processor inside the API process
- Register the BullMQ processor in the API's `AppModule`.
- **Pros:** Simplest — no new service.
- **Cons:** FFmpeg CPU load competes with HTTP requests in the same container — contradicts "sem impacto na performance" and the diagram's separate worker container.

**Recommendation:** **Option A** — a separate container from the same codebase gives the process isolation the diagram requires while reusing the entity, repository and storage service already needed by the API, avoiding a second subproject for a single processor.

**Decision:** A (Same NestJS codebase, separate entrypoint and Compose service)
**Libraries:** —

---

## TD-05: Media Probing and Thumbnail Tooling

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration/metadata and grab a frame for the thumbnail. Decide the library layer and how the worker reads a possibly 10GB object. Depends on TD-04.

**Options:**

### Option A: `ffprobe`/`ffmpeg` binaries via `child_process.spawn`, reading the object over a presigned HTTP URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` returns JSON metadata; `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=… -f image2 pipe:1` outputs one JPEG frame which is uploaded to storage. The input is a short-lived presigned GET (internal endpoint); FFmpeg's HTTP demuxer uses range requests, so only the needed bytes are read.
- **Pros:** No third-party wrapper (Node built-in only); JSON output parsed into a typed DTO; avoids copying 10GB to local disk; binaries from Debian's `ffmpeg` package in the dev image.
- **Cons:** Must build argument arrays and parse JSON manually; error handling on exit codes/stderr is ours.

### Option B: `fluent-ffmpeg` wrapper
- Fluent API over the same binaries.
- **Pros:** Convenience API (`ffprobe()`, `screenshots()`).
- **Cons:** **Deprecated on npm** (2.1.3, "no longer supported") — adopting an unmaintained dependency in a new phase.

### Option C: Download the object to a temp file, then run the binaries locally
- Worker streams the object to `/tmp`, runs ffprobe/ffmpeg on the file, deletes it.
- **Pros:** Works with any FFmpeg input limitation; deterministic local seeks.
- **Cons:** Up to 10GB of disk and network per job just to read headers and one frame; slower; temp-disk sizing becomes an ops concern.

**Recommendation:** **Option A** — the binaries are the actual capability ("Video Worker (FFmpeg)"), a thin typed `spawn` wrapper avoids a deprecated dependency, and reading via presigned HTTP URL with range requests avoids pulling 10GB per job just to read metadata and one frame. Thumbnail frame: at 10% of the duration capped to 1s minimum (falls back to the first frame for very short videos), JPEG, width 1280 keeping aspect ratio.

**Decision:** A (`ffprobe`/`ffmpeg` binaries via `child_process.spawn` over a presigned HTTP URL)
**Libraries:** —

---

## TD-06: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, non-conflicting public identifier for its URL (Pontos de Atenção: "URL curta e única que nunca conflite"). The identifier appears in API routes and future frontend routes, hence Cross-layer. It must not leak the internal UUID or be enumerable.

**Options:**

### Option A: Random 11-char base64url slug from `crypto.randomBytes` + unique index + retry
- 8 random bytes → 11 base64url chars (64 bits of entropy, YouTube-like). Stored in `videos.slug` with a `UNIQUE` constraint; on the (astronomically rare) unique violation the insert is retried with a new slug.
- **Pros:** Short, non-sequential, non-enumerable; Node built-in (no dependency); uniqueness guaranteed by the DB, not by probability alone.
- **Cons:** Needs a retry path on unique violation (same savepoint pattern used for nicknames in Phase 02).

### Option B: Expose the UUID primary key
- Use `videos.id` (UUID v4) in the URL.
- **Pros:** Zero extra column; uniqueness inherent.
- **Cons:** 36 chars — not "short"; couples public URLs to the internal key.

### Option C: Sqids/Hashids over a sequential integer
- Encode an auto-increment id into a short string.
- **Pros:** Very short, deterministic, no collision.
- **Cons:** Reversible/enumerable (reveals upload volume, lets anyone walk ids); requires a sequential column alongside the UUID PK; extra dependency.

### Option D: `nanoid`
- Random ID library with custom alphabet.
- **Pros:** Popular, configurable length.
- **Cons:** v6 is ESM-only — friction with the CommonJS/ts-jest setup; adds a dependency for what `crypto.randomBytes` does in one line.

**Recommendation:** **Option A** — 64 random bits give non-enumerable short URLs with Node's built-in `crypto`, and the DB `UNIQUE` constraint plus retry makes "never conflicts" a guarantee rather than a probability.

**Decision:** A (Random 11-char base64url slug + UNIQUE index + retry)
**Libraries:** —

---

## TD-07: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file (HTTP Range / `206 Partial Content`), and the user must be able to download the original. The architecture diagram draws "Frontend → Object Storage: Streams", i.e., bytes are served by storage, not the API. Cross-layer: the player/download button will consume this contract.

**Options:**

### Option A: API authorizes, then redirects (302) to a short-lived presigned GET; storage serves Range/206
- `GET /videos/:slug/stream` and `GET /videos/:slug/download` check access and status, then `302` to a presigned URL (download adds `response-content-disposition=attachment; filename=…`). The `<video>` element follows the redirect and issues Range requests directly to storage.
- **Backend impact:** two tiny endpoints, no byte proxying.
- **Frontend impact:** `<video src="/videos/:slug/stream">` and `<a href="/videos/:slug/download">` — native browser behavior.
- **Pros:** Matches the diagram; Range/206, seeking and resumable downloads handled natively by S3/MinIO; API cost is constant per request.
- **Cons:** Presigned URL is a bearer link until it expires (mitigated by short TTL, e.g., 1h); requires the public storage endpoint (TD-03).

### Option B: API proxies bytes with Range support
- API parses `Range`, calls `GetObject` with the same range, pipes the body with `206`/`Content-Range`.
- **Pros:** Storage never exposed; full control over headers/auth per chunk.
- **Cons:** Every streamed byte passes through the API (the load profile the phase forbids for uploads applies equally to playback); more code (range parsing, edge cases).

### Option C: Adaptive streaming (HLS/DASH transcoding in the worker)
- Worker transcodes to HLS renditions; player fetches playlists/segments.
- **Pros:** Adaptive bitrate, best playback UX at scale.
- **Cons:** Heavy transcoding (CPU/time/storage multiplied per rendition); not required by the phase ("sem necessidade de download completo" is satisfied by progressive Range streaming); out of proportion for this phase.

**Recommendation:** **Option A** — progressive streaming with Range/206 served by storage meets "sem download completo" exactly as the architecture diagram draws it, while the API keeps the authorization decision; HLS (Option C) can be a later phase if adaptive bitrate becomes a requirement.

**Decision:** A (API authorizes; storage serves Range/206 through a short-lived presigned GET)
**Libraries:** @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-18 — Hand-off format changed from `302` redirect to a JSON body `{ url, expiresAt }` returned by `GET /videos/:slug/stream` and `GET /videos/:slug/download` (download URL carries `response-content-disposition: attachment`). Rationale: resolves phase-03-videos validation IC-1 — owner-only access (TD-09) uses a Bearer token that a native `<video>`/`<a>` request cannot send, and the inherited strict-BFF model (`next-frontend-config-base/TD-03`) means the browser never calls Nest directly; storage still serves Range/`206` exactly as Option A describes.

---

## TD-08: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video is pre-registered when the upload starts and must expose its processing state; failures in processing must be visible and must not leave a video stuck. Publication (draft → published) is explicitly Phase 04 ("Fluxo de rascunho → publicação"), so this lifecycle covers upload/processing only. Depends on TD-01.

**Options:**

### Option A: Single `status` enum `draft → processing → ready | failed`, BullMQ retries, terminal `failed` with reason
- `draft` on initiation (upload in progress, not yet usable); `processing` when the API completes the multipart upload and enqueues the job; worker sets `ready` (with duration, metadata, thumbnail) or, after the last retry, `failed` with `failure_reason`. Job: 3 attempts, exponential backoff (5s base). Order: commit `processing` first, then enqueue; job is idempotent (re-processing a `processing` video is safe; non-`processing` videos are skipped). Phase 04 adds publication state as a separate concern.
- **Pros:** Directly mirrors the phase wording ("rascunho" at upload start); one column to query; retries absorb transient storage/network errors; `failed` is explicit and inspectable.
- **Cons:** `draft` here means "pre-registered/upload pending", which Phase 04 must keep distinct from its publication workflow (documented in the Data Model).

### Option B: Separate `upload_status` and `processing_status` columns
- Two state machines (upload: pending/completed/aborted; processing: pending/running/succeeded/failed).
- **Pros:** Finer-grained states.
- **Cons:** More combinations to validate; no capability requires the extra granularity.

### Option C: No retries — fail fast to `failed`
- Any processor error marks the video `failed` immediately.
- **Pros:** Simplest.
- **Cons:** Transient errors (storage hiccup, worker restart mid-job) permanently fail valid uploads.

**Recommendation:** **Option A** — one enum matches the phase's "rascunho → processando → pronto/erro" vocabulary, BullMQ's built-in attempts/backoff cover transient errors at no extra code, and committing the status before enqueueing plus an idempotent processor closes the DB↔queue atomicity gap introduced by TD-01.

**Decision:** A (Single `status` enum draft → processing → ready | failed, 3 attempts with exponential backoff)
**Libraries:** bullmq

---

## TD-09: Access Policy for Video Endpoints in Phase 03

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Upload is clearly owner-only (authenticated user uploading to their own channel). Streaming/download access is less obvious: anonymous viewing is a Phase 05 capability ("Acesso anônimo à visualização de vídeos") and public/unlisted visibility is Phase 04. Phase 03 must still make streaming and download work. Defines the Authorization Matrix.

**Options:**

### Option A: Owner-only in Phase 03 (JWT + channel ownership) for all video endpoints
- Every `/videos` endpoint requires the global JWT guard; the service checks the video belongs to the caller's channel (`404` otherwise, to avoid existence leaks). Phases 04/05 relax read access according to visibility.
- **Pros:** Consistent with videos still being "rascunho" (not published); no premature public surface; Phase 05 opens anonymous access deliberately.
- **Cons:** Streaming can only be demonstrated by the owner in this phase.

### Option B: Public stream/download by slug for `ready` videos
- Stream/download marked `@Public()`; anyone with the slug can watch.
- **Pros:** Demonstrates "URL única" sharing immediately.
- **Cons:** Exposes unpublished drafts publicly — pre-empts the visibility rules of Phases 04/05.

**Recommendation:** **Option A** — keeping every Phase 03 endpoint owner-only respects the draft semantics and leaves the public/unlisted/anonymous rules to the phases that own them.

**Decision:** A (Owner-only in Phase 03)
**Libraries:** —

---

## TD-10: Testing Strategy for Queue, Worker and Storage

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The project's testing guide prefers real infrastructure from Compose over mocks. Integration/e2e tests must exercise real MinIO, Redis and FFmpeg, but the long-running `video-worker` container consumes the same queue and could steal test jobs (or run stale code). Cross-component: test env keys + compose + worker bootstrap.

**Options:**

### Option A: Real services, in-process worker, isolated queue prefix for tests
- Tests use the Compose `minio`, `redis` and the `ffmpeg` binary inside the `nestjs-api` container; the e2e boots the worker module in-process and both sides use a test-only BullMQ prefix (`QUEUE_PREFIX`), so the Compose worker never sees test jobs. Test videos are generated on the fly with `ffmpeg -f lavfi -i testsrc` (no binary fixtures in git).
- **Pros:** Exercises the real code under test with real infra; deterministic (no race with the container worker); no committed binaries.
- **Cons:** Requires `ffmpeg` in the API dev image too (shared image per TD-04); tests must wait/poll for job completion.

### Option B: Rely on the Compose `video-worker` for e2e
- e2e enqueues and waits for the running container to process.
- **Pros:** Tests the deployed topology.
- **Cons:** Container may run stale code; depends on container health; nondeterministic contention.

### Option C: Mock S3 and the queue (aws-sdk-client-mock, in-memory queue)
- **Pros:** Fast, no infra.
- **Cons:** Contradicts the project testing guide ("do not mock what can be tested with the Compose infra"); misses presigning/multipart/Range behavior.

**Recommendation:** **Option A** — it keeps tests on real MinIO/Redis/FFmpeg as the testing guide demands while the queue prefix isolates test jobs from the always-on `video-worker` container. Unit tests still mock collaborators per `*.spec.ts` rules.

**Decision:** A (Real services, in-process worker, isolated queue prefix for tests)
**Libraries:** —

**Revisions:**
- 2026-10-18 — Confirmed that this TD supersedes the testing guide's object-storage strategy ("local filesystem adapter in dev/tests", `testing-guide-nestjs-project/references/external-systems.md`) for Phase 03: storage tests run against the real Compose `minio`. Rationale: resolves phase-03-videos validation ICC-1 — presigning, multipart and Range semantics only exist on a real S3-compatible server.

---

## TD-11: Abandoned Upload Handling

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Raised by `phase-03-videos` validation (MD-1). With direct multipart upload (TD-02), a client may initiate an upload and never complete it (tab closed, network lost for good). This leaves a `draft` row and orphan multipart parts that consume storage until aborted — and "Pontos de Atenção" asks to plan storage growth and cost from the start. Depends on TD-02 and TD-08.

**Options:**

### Option A: Explicit abort endpoint + bucket lifecycle rule for incomplete multipart uploads
- `DELETE /videos/:id/upload` calls `AbortMultipartUpload` and marks the video `failed` (reason `UPLOAD_ABORTED`). Independently, the bucket gets an `AbortIncompleteMultipartUpload` lifecycle rule (e.g., 7 days) applied by the `minio-init` container, so parts of uploads that are simply abandoned are reclaimed by the storage itself.
- **Pros:** Client-initiated cancel frees storage immediately; storage-side rule guarantees cleanup even when the client vanishes; no scheduler code in the API.
- **Cons:** The `draft` row of a silently abandoned upload stays `draft` (no DB sweep in this phase); one extra endpoint.

### Option B: Lifecycle rule only
- Only the bucket rule; no API endpoint.
- **Pros:** Zero API code.
- **Cons:** A user cannot cancel an upload; parts persist for the whole rule window.

### Option C: Scheduled sweeper job (BullMQ repeatable job)
- A repeatable job finds `draft` videos older than N hours, aborts their multipart uploads and marks them `failed`.
- **Pros:** DB and storage both converge.
- **Cons:** Adds scheduling logic, timing configuration and tests for a capability the phase does not list; overlaps with Phase 04's draft management.

### Option D: Out of scope — document as known gap
- **Pros:** No work.
- **Cons:** Orphan parts accumulate in storage indefinitely, contradicting the storage-cost attention point.

**Recommendation:** **Option A** — the lifecycle rule makes storage self-cleaning with one line in the bucket provisioning, and the abort endpoint gives the client the cancel path the multipart protocol already expects; a DB sweeper (Option C) is left to Phase 04, which owns draft management.

**Decision:** A (Explicit abort endpoint + storage-side expiry of incomplete multipart uploads)
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-10-18 — On MinIO the storage-side cleanup is the server setting `MINIO_API_STALE_UPLOADS_EXPIRY` (set to `168h` = 7 days in `compose.yaml`; cleanup interval `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL`, default `6h`), not an `mc ilm` lifecycle rule; on AWS S3 (production) the equivalent is an `AbortIncompleteMultipartUpload` bucket lifecycle rule. Rationale: Param updated to match MinIO docs (Context7 `/minio/minio`, docs/config/README.md — `stale_uploads_expiry`).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Processing Queue Technology | A (BullMQ on Redis) | A |
| TD-02 | Cross-layer | Large File Upload Protocol (10GB) | A (Direct-to-storage multipart, presigned parts) | A |
| TD-03 | Backend | Object Storage Organization and Endpoint Strategy | A (Single private bucket, videoId keys, internal+public endpoints) | A |
| TD-04 | Backend | Video Worker Runtime and Deployment | A (Same codebase, separate entrypoint + Compose service) | A |
| TD-05 | Backend | Media Probing and Thumbnail Tooling | A (ffprobe/ffmpeg via spawn over presigned URL) | A |
| TD-06 | Cross-layer | Unique Video URL Identifier | A (Random 11-char base64url slug + UNIQUE + retry) | A |
| TD-07 | Cross-layer | Streaming and Download Delivery | A (302 to presigned GET; storage serves Range/206) | A |
| TD-08 | Backend | Video Status Lifecycle and Failure Policy | A (draft → processing → ready/failed, 3 attempts) | A |
| TD-09 | Cross-layer | Access Policy for Video Endpoints in Phase 03 | A (Owner-only) | A |
| TD-10 | Backend | Testing Strategy for Queue, Worker and Storage | A (Real services, in-process worker, test queue prefix) | A |
| TD-11 | Backend | Abandoned Upload Handling | A (Abort endpoint + lifecycle rule) | A |
