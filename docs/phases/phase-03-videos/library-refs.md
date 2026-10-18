---
libs:
  "bullmq":
    version: "^6.3.16"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-18T17:12:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-10-18T17:12:00-03:00"
  "ioredis":
    version: "^6.0.0"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-10-18T17:12:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-18T17:12:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-18T17:12:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-18T17:10:35-03:00"
---

# Library References — phase-03-videos

Distilled from Context7 (fetched via the Context7 HTTP API, `context7.com/api/v2/context`, because the Context7 MCP server is not configured in this repo's `.mcp.json`). Versions are the latest on npm on 2026-10-18 that satisfy the installed stack (`@nestjs/common` 11.x, Node 25 in `node:25.6.0-slim`).

### bullmq

_Used by: `phase-03-videos/TD-01`, `phase-03-videos/TD-08`._

- **v6 breaking changes (changelog):** `ioredis` is no longer a direct dependency — Redis users install it explicitly (optional peer `ioredis >=5`). `connection` is **mandatory** in `QueueBaseOptions` (no default). High-level classes no longer expose Redis internals (`Queue#client` etc. removed; `Worker#waitUntilReady()` resolves to `void`).
- **Retries:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })` — retry delay is `2^(attemptsMade-1) * delay`.
- **Final-failure detection:** `job.attemptsMade` increments on every thrown error; when `job.attemptsMade >= job.opts.attempts` the job goes to the failed set. Throwing `UnrecoverableError` moves the job to failed **without** retries (use for permanent errors, e.g. ffprobe reports no video stream).
- **Auto-removal:** `removeOnComplete: { age, count }` / `removeOnFail: { age }` on job or worker options keep Redis bounded.
- **Prefix:** queue keys are namespaced by `prefix` (default `bull`); a test-only prefix isolates test jobs from the Compose worker (`phase-03-videos/TD-10`).
- **Connections created by BullMQ itself** (passing `{ host, port }`) are configured correctly; a manually created ioredis client for a Worker must set `maxRetriesPerRequest: null` or BullMQ throws.

### @nestjs/bullmq

_Used by: `phase-03-videos/TD-01`, `phase-03-videos/TD-04`._

- **11.0.5** peers `@nestjs/common ^10 || ^11` and `bullmq ^3..^6` (12.0.0 requires Nest 12 — do not install).
- **Root config:** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [...], useFactory: (...) => ({ connection: { host, port }, prefix, defaultJobOptions }) })`. Options other than `extraOptions` pass straight to the BullMQ `Queue` constructor.
- **Queue registration:** `BullModule.registerQueue({ name: 'video-processing' })`; inject with `@InjectQueue('video-processing') queue: Queue` (type from `bullmq`).
- **Consumer:** `@Processor('video-processing') class X extends WorkerHost { async process(job: Job) {...} }`; route by `job.name`. Consumers must be registered as providers (only in the module loaded by the worker entrypoint, so the API process does not consume).
- **Worker events:** `@OnWorkerEvent('failed')` inside the `@Processor` class receives `(job, error)`.

### ioredis

_Used by: `phase-03-videos/TD-01` (peer of bullmq)._

- **v6.0.0 breaking changes:** Node.js ≥ 20 (container runs Node 25 — OK) and **RESP3 by default** (`protocol: 2` restores v5 wire protocol). Redis 8 supports RESP3. Only installed as BullMQ's peer; the app never instantiates `Redis` directly.

### @aws-sdk/client-s3

_Used by: `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-11`._

- **MinIO client config:** `new S3Client({ endpoint: 'http://minio:9000', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })` — `forcePathStyle` (v3 name of v2 `s3ForcePathStyle`) puts the bucket in the path (`host/bucket/key`).
- **Checksums:** `requestChecksumCalculation` / `responseChecksumValidation` accept `WHEN_SUPPORTED` (default — adds checksum headers to every op with a modeled `requestAlgorithmMember`, e.g. `PutObject`, `UploadPart`) or `WHEN_REQUIRED` (only when required or `ChecksumAlgorithm` is set explicitly). Use `WHEN_REQUIRED` so presigned part URLs do not demand checksum headers from the browser.
- **Multipart:** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })`; each part response carries an `ETag` (browser access requires CORS exposing `ETag`; MinIO's default `MINIO_API_CORS_ALLOW_ORIGIN='*'`); `ListPartsCommand({ Bucket, Key, UploadId })` for resume; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`; `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- **Objects:** `HeadObjectCommand` (size check after completion), `PutObjectCommand({ Body: Buffer, ContentType: 'image/jpeg' })` (thumbnail upload by the worker), `GetObjectCommand` (presigned for stream/download).

### @aws-sdk/s3-request-presigner

_Used by: `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`._

- `getSignedUrl(client, new UploadPartCommand({...}), { expiresIn: 3600 })` / `getSignedUrl(client, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' }), { expiresIn })`.
- The signature covers the **host** of the client that signs — presign with the client configured for the endpoint the caller will use (`S3_PUBLIC_ENDPOINT` for clients, internal endpoint for the worker's ffprobe/ffmpeg input).
- `unhoistableHeaders` forces `x-amz-*` headers to be signed as headers instead of query params (not needed with `WHEN_REQUIRED`).

## Infrastructure (non-npm) references

- **MinIO server** (`/minio/minio`, image `cgr.dev/chainguard/minio`, MinIO RELEASE.2026-09-22): stale multipart uploads are expired by the server setting `MINIO_API_STALE_UPLOADS_EXPIRY` (default `24h`) checked every `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL` (default `6h`) — `phase-03-videos/TD-11` revision. `MINIO_API_CORS_ALLOW_ORIGIN` defaults to `*`. Health endpoint `/minio/health/live`. The image has `bash` (healthcheck can use `/dev/tcp`) but no `curl`.
- **MinIO client** (image `cgr.dev/chainguard/minio-client`, no shell): one-shot `mc mb --ignore-existing local/<bucket>` with the alias provided through `MC_HOST_local=http://user:pass@minio:9000`.
- **Redis** (image `redis:8.8-alpine`): BullMQ backend.
- **FFmpeg** (Debian `ffmpeg` package installed in `Dockerfile.dev`): `ffprobe -v error -print_format json -show_format -show_streams <input>`; `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1`.
