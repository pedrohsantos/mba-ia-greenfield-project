# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (queue):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO (object storage):** `docker compose ps minio` shows `(healthy)` and `docker compose ps -a minio-init` shows `Exited (0)` (bucket provisioned)
- **Video worker:** `docker compose logs video-worker` ends with `Video worker started — consuming video-processing` (the first watch compile takes a few minutes)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (container idles; start the server with `npm run start:dev`)
- `video-worker` — video processing worker (same image/codebase, `npm run start:worker:dev`, no HTTP port); consumes the `video-processing` BullMQ queue and runs FFmpeg
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, SMTP `1025`, UI `8025`
- `redis` — Redis 8 (BullMQ backend), port `6379`
- `minio` — S3-compatible object storage (Chainguard image pinned by digest), API `9000`, console `9001`, credentials `S3_ACCESS_KEY`/`S3_SECRET_KEY` from `.env`
- `minio-init` — one-shot `mc mb --ignore-existing` that creates the `S3_BUCKET` bucket; `nestjs-api` and `video-worker` wait for it to exit 0

`compose.yaml` interpolates `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `S3_BUCKET` from `.env` — copy `.env.example` to `.env` before `docker compose up`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video worker (dist/worker.js)
npm run start:worker:dev                 # Video worker in watch mode (what the video-worker service runs; builds to dist-worker/)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

### Tests that touch videos

Video tests use the real Compose services — MinIO, Redis and the `ffmpeg`/`ffprobe` binaries installed in the dev image — never mocks or a local-filesystem storage adapter (`phase-03-videos/TD-10`). Before compiling a testing module they call `applyVideoTestEnv()` (`src/test/video-test-env.ts`), which:

- points `S3_PUBLIC_ENDPOINT` at `S3_ENDPOINT` (tests run inside the Compose network, where `localhost:9000` is unreachable), and
- sets `QUEUE_PREFIX=streamtube-test`, so the always-on `video-worker` container never consumes test jobs.

Test videos are generated on the fly with `generateTestVideo()` (`src/test/generate-test-video.ts`, FFmpeg `lavfi` sources) — no binary fixtures in git. The full upload → worker → streaming flow is `test/videos-flow.e2e-spec.ts`, which boots `WorkerModule` in-process.

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos (Phase 03 — upload and processing)

Plan, decisions and progress: `docs/phases/phase-03-videos/` and `docs/decisions/technical-decisions-phase-03-videos.md`.

### Modules

- `src/videos/` — `VideosModule` (API side): `Video` entity (`videos` table, migration `1792356053947-CreateVideos`), `VideosService`, `VideosController`, DTOs, domain exceptions (`exceptions/video.exceptions.ts`), constants (`videos.constants.ts`: queue/job names, job options, 64 MiB part size, 10 GiB limit, accepted MIME types, storage keys).
- `src/videos/processing/` — `VideoProcessingModule` (worker side): `VideoProcessingProcessor` (`@Processor('video-processing')`), `VideoProcessingService` (probe → thumbnail → `ready`), `MediaProbeService` (`ffprobe`/`ffmpeg` via `child_process.spawn`). Imported **only** by `WorkerModule` — the API never consumes jobs.
- `src/storage/` — `StorageModule`/`StorageService`: S3 client wrapper (multipart, presigned part/GET URLs, head/put/delete). Two clients: internal (`S3_ENDPOINT`, server-to-storage) and public (`S3_PUBLIC_ENDPOINT`, only for signing URLs handed to clients); both `forcePathStyle: true` and `requestChecksumCalculation: 'WHEN_REQUIRED'`.
- `src/queue/` — `QueueModule`: shared `BullModule.forRootAsync` (Redis connection + `QUEUE_PREFIX`), imported by `AppModule` and `WorkerModule`.
- `src/worker.module.ts` + `src/worker.ts` — worker process root (`NestFactory.createApplicationContext`, no HTTP).
- `src/database/typeorm-options.factory.ts` — TypeORM options shared by `AppModule` and `WorkerModule`.

### Environment variables

`S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000` — host-reachable endpoint that presigned URLs are signed for), `S3_REGION`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` (required), `S3_BUCKET` (default `streamtube-videos`), `S3_PRESIGN_EXPIRES_SECONDS` (default `3600`), `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `streamtube`). Validated in `src/config/env.validation.ts`; namespaces `storage` and `queue` in `src/config/`.

### Endpoints (all JWT-protected and owner-only; `@SkipThrottle()`)

| Method | Path | Result |
|--------|------|--------|
| POST | `/videos/uploads` | 201 — pre-registers the video as `draft`, opens a multipart upload, returns `parts[]` presigned PUT URLs (`partSize` 64 MiB, ≤ 10 GiB) |
| POST | `/videos/:id/upload/parts` | 200 — re-signs part URLs (resume / expired URLs) |
| GET | `/videos/:id/upload` | 200 — parts already stored (resume) |
| POST | `/videos/:id/upload/complete` | 202 — completes the multipart upload, checks the size, sets `processing`, enqueues `video.process` |
| DELETE | `/videos/:id/upload` | 204 — aborts the upload, video becomes `failed` (`UPLOAD_ABORTED`) |
| GET | `/videos/:slug` | 200 — video (status, duration, metadata, `thumbnailUrl`) |
| GET | `/videos/:slug/stream` | 200 — `{ url, expiresAt }` presigned GET; storage serves `Range` → `206` |
| GET | `/videos/:slug/download` | 200 — `{ url, expiresAt, fileName }` presigned GET with `Content-Disposition: attachment` |

Other users' videos answer `404 VIDEO_NOT_FOUND` (existence is not leaked). Error codes: `CHANNEL_NOT_FOUND`, `VIDEO_NOT_FOUND`, `INVALID_VIDEO_STATUS`, `VIDEO_NOT_READY`, `UPLOAD_PARTS_INVALID`, `UPLOAD_SIZE_MISMATCH` (plus `VALIDATION_ERROR`).

### Upload and processing flow

1. Client calls `POST /videos/uploads` → video row `draft` with an 11-char base64url `slug` (unique index; retried on collision) and storage key `videos/{id}/original`.
2. Client `PUT`s each part **directly to MinIO/S3** with the presigned URLs and keeps the `ETag`s — no video bytes go through the API.
3. Client calls `POST /videos/:id/upload/complete` with `{ parts: [{ partNumber, etag }] }`; the status is committed as `processing` **before** the `video.process` job (`{ videoId }`, `jobId = videoId`, 3 attempts, exponential backoff 5 s) is added.
4. `video-worker` runs `ffprobe` and `ffmpeg` against an internal presigned URL (range reads, no full download), stores `thumbnails/{id}.jpg` and sets `ready` with `duration_seconds` and `metadata`. A file without a video stream (`UnrecoverableError`) or the last failed attempt sets `failed` with `failure_reason`.

Status lifecycle: `draft → processing → ready | failed` (publication is Phase 04). Incomplete multipart uploads are expired by MinIO after 7 days (`MINIO_API_STALE_UPLOADS_EXPIRY=168h` in `compose.yaml`).
