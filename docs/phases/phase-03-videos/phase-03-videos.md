---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-18T17:14:29-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-18T17:12:58-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-18T17:12:48-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB direto para o object storage (S3/MinIO) sem passar bytes pela API, com pré-cadastro automático do vídeo como rascunho, processamento automático em segundo plano por um worker FFmpeg consumindo uma fila (extração de duração/metadados e geração de thumbnail), URL única por vídeo, reprodução via streaming (Range/206) e download — com storage, fila e worker subindo no Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços de storage/fila no Compose

**Description:** Instalar as libs da fase, criar os namespaces de configuração `storage` e `queue`, estender a validação Joi e subir Redis + MinIO (com bucket provisionado) no `compose.yaml`, além de instalar FFmpeg na imagem de desenvolvimento.

**Technical actions:**

1. Instalar em `nestjs-project`: `bullmq@^6.3.16`, `@nestjs/bullmq@^11.0.5`, `ioredis@^5.11.1` (per `phase-03-videos/TD-01`; 5.x por causa do peer `ioredis@^5` do `typeorm@0.3.28` — ver `library-refs.md`), `@aws-sdk/client-s3@^3.1152.0`, `@aws-sdk/s3-request-presigner@^3.1152.0` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`); adicionar `ffmpeg` ao `apt install` do `Dockerfile.dev` (per `phase-03-videos/TD-05`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000` — endpoint alcançável pelo cliente, usado só para presign), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY` e `S3_SECRET_KEY` (obrigatórias), `S3_BUCKET` (default `streamtube-videos`), `S3_PRESIGN_EXPIRES_SECONDS` (default `3600`) (per `phase-03-videos/TD-03`); criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `streamtube`) (per `phase-03-videos/TD-01`); registrar ambos no `load` do `ConfigModule`
3. Estender `src/config/env.validation.ts` com as novas chaves (`S3_ACCESS_KEY`/`S3_SECRET_KEY` required; demais com defaults) e atualizar `.env.example`
4. Adicionar ao `compose.yaml`: `redis` (`redis:8.8-alpine`, healthcheck `redis-cli ping`), `minio` (`cgr.dev/chainguard/minio` fixado por digest, `server /data --console-address :9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, `MINIO_API_STALE_UPLOADS_EXPIRY=168h` per `phase-03-videos/TD-11`, portas 9000/9001, volume nomeado, healthcheck via `bash /dev/tcp` em `/minio/health/live`) e `minio-init` (`cgr.dev/chainguard/minio-client` fixado por digest, `MC_HOST_local`, `mb --ignore-existing local/streamtube-videos`); `nestjs-api` passa a depender de `redis` (healthy) e `minio-init` (completed successfully)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: boot falha sem `S3_ACCESS_KEY`/`S3_SECRET_KEY`; defaults de storage/queue aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `redis` e `minio` em estado `healthy` e `minio-init` sai com código 0
- O bucket `streamtube-videos` existe no MinIO após o `minio-init` (listável via S3 API) e uma segunda execução do `minio-init` também sai com 0
- Iniciar a aplicação sem `S3_SECRET_KEY` falha na validação Joi no bootstrap
- `ffprobe -version` e `ffmpeg -version` executam dentro do container `nestjs-api`

---

### SI-03.2 — Implementar StorageModule (S3/MinIO)

**Description:** Encapsular todo acesso ao object storage em um `StorageService` reutilizável pela API e pelo worker — multipart presignado, leitura de metadados, escrita de thumbnail e URLs GET presignadas.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` com dois `S3Client` (`forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, per revisão de `phase-03-videos/TD-03`): cliente interno (`S3_ENDPOINT`) para chamadas servidor→storage e cliente público (`S3_PUBLIC_ENDPOINT`) usado apenas para assinar URLs entregues ao cliente
2. Implementar multipart: `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)` (público), `listParts(key, uploadId)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-11`); erros S3 `InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`, `EntityTooSmall` relançados como `InvalidMultipartUploadError` (classe em `src/storage/storage.errors.ts`)
3. Implementar objetos: `getObjectSize(key)` (`HeadObject`), `putObject(key, body, contentType)`, `deleteObject(key)` e `presignGetObject(key, { endpoint: 'public' | 'internal', downloadFileName? })` retornando `{ url, expiresAt }` com `ResponseContentDisposition: attachment; filename="…"` quando `downloadFileName` é informado (per `phase-03-videos/TD-07`)
4. Criar `src/storage/storage.module.ts` exportando `StorageService`; criar `src/test/video-test-env.ts` com `applyVideoTestEnv()` (aponta `S3_PUBLIC_ENDPOINT` para `S3_ENDPOINT` e define `QUEUE_PREFIX` de teste) para os testes rodarem dentro da rede do Compose (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart create → PUT de parte via URL presignada → `listParts` → complete → `getObjectSize`; `GET` presignado com `Range` retorna 206; download com `Content-Disposition: attachment`; abort → upload some; ETag inválido → `InvalidMultipartUploadError` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com config real | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — libs, config `storage` e serviço `minio` precisam existir

**Acceptance criteria:**

- Uma URL presignada de `UploadPart` aceita `PUT` direto no MinIO (sem passar pela API) e devolve `ETag`
- Após `completeMultipartUpload`, o objeto existe com tamanho igual à soma das partes
- Um `GET` na URL presignada com `Range: bytes=0-99` retorna `206 Partial Content` com `Content-Range` e 100 bytes
- Uma URL de download presignada retorna `Content-Disposition: attachment; filename="<nome>"`
- Completar com ETag inválido lança `InvalidMultipartUploadError` e não cria o objeto

---

### SI-03.3 — Criar entidade Video, migration e lookup de canal

**Description:** Persistir o vídeo ligado ao canal (`### Data Model → Video`) com a migration versionada e expor, no domínio de canais, a busca do canal do usuário autenticado.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video` (enum `VideoStatus` em `src/videos/video-status.enum.ts`, tipo `VideoMetadata`, transformers `bigint`/`numeric` → `number`) e `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`, importado no `AppModule` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-06`)
2. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate`, revisar (enum `videos_status_enum`, unique `slug`, índice `channel_id`, FK `channels`) e garantir `down` simétrico (inclui `DROP TYPE`)
3. Atualizar `src/database/migrations.integration-spec.ts` (3 migrations, tabela `videos`, drop dos enum types no setup) e `cleanAllTables` em `src/test/create-test-data-source.ts` (apagar `videos` antes de `channels`)
4. Adicionar `ChannelsService.findByUserId(userId): Promise<Channel | null>` — o domínio `channels` continua dono da consulta de canais (inherited convention de SRP)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = 'draft'`; `slug` duplicado viola unique; `channel_id` inexistente viola FK; `size_bytes` de 10 GiB volta como `number`; `metadata` jsonb round-trip | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica 3 migrations criando `videos`; revert remove `videos` | `src/database/migrations.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário e `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — ambiente com as novas variáveis validadas

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum `videos_status_enum` e a FK para `channels`; `npm run migration:revert` remove ambos
- Inserir um vídeo sem `status` persiste `status = 'draft'`
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade
- Inserir um vídeo com `channel_id` inexistente falha com violação de FK

---

### SI-03.4 — Infra: fila BullMQ compartilhada e contrato do job

**Description:** Configurar a conexão BullMQ/Redis uma única vez para API e worker, registrar a fila `video-processing` e fixar o contrato do job `video.process` (`### Events/Messages`).

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `connection: { host, port }` e `prefix` vindos de `queueConfig` (per `phase-03-videos/TD-01`); importado pelo `AppModule` (e, no SI-03.8, pelo `WorkerModule`)
2. Criar `src/videos/videos.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_PROCESS_JOB = 'video.process'`, interface `VideoProcessJobData { videoId: string }` e `VIDEO_PROCESS_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 3600 }`, `removeOnFail: { age: 604800 }`) (per `phase-03-videos/TD-08`); também `VIDEO_PART_SIZE_BYTES = 67108864`, `VIDEO_MAX_SIZE_BYTES = 10737418240`, `SUPPORTED_VIDEO_CONTENT_TYPES` (per `phase-03-videos/TD-02`)
3. Registrar `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` no `VideosModule` (produtor)
4. Extrair `src/database/typeorm-options.factory.ts` com a factory de `TypeOrmModuleOptions` hoje inline no `AppModule` (mesmo comportamento), para o `WorkerModule` reutilizar sem duplicar (inherited convention: config única de banco)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` + fila `video-processing` | Integration (Redis real): job adicionado com `jobId` aparece em `getJob` sob o prefixo configurado; segundo `add` com o mesmo `jobId` não duplica | `src/queue/queue.module.integration-spec.ts` |
| `VideosModule` | Unit: compilação com TypeORM + BullModule registrados | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 (Redis + config `queue`), SI-03.3 (`VideosModule` existe)

**Acceptance criteria:**

- Um job `video.process` adicionado com `jobId = <videoId>` é recuperável por `queue.getJob(<videoId>)` e suas chaves no Redis começam com o `QUEUE_PREFIX` configurado
- Adicionar novamente um job com o mesmo `jobId` enquanto ele existe não cria um segundo job
- A suíte e2e existente (`GET /`, auth) continua passando com o `AppModule` usando a factory extraída

---

### SI-03.5 — Iniciar upload com pré-cadastro em rascunho e retomada

**Description:** Entregar o início do upload direto ao storage — pré-cadastro do vídeo como `draft` com slug único, criação do multipart e URLs presignadas por parte — e os endpoints de retomada (re-assinar partes, listar partes enviadas).

**Technical actions:**

1. Criar `src/videos/video-slug.util.ts` — `generateVideoSlug()` = `crypto.randomBytes(8).toString('base64url')` (11 chars, per `phase-03-videos/TD-06`) e `src/videos/exceptions/video.exceptions.ts` com as exceções do `### Error Catalog` estendendo `DomainException`
2. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: canal via `ChannelsService.findByUserId` (`CHANNEL_NOT_FOUND`), `id = randomUUID()`, `storage_key = videos/{id}/original`, `title` default = `fileName` sem extensão (AMB-1), `createMultipartUpload`, insert `draft` com retry de slug em `23505` na coluna `slug` (máx. 5, inherited convention), abort do multipart se o insert falhar de vez; presign de todas as partes (`partCount = ceil(sizeBytes / 64 MiB)`) (per `phase-03-videos/TD-02`)
3. Em `VideosService`: `findOwnedById(userId, id)` (404 `VIDEO_NOT_FOUND` para inexistente ou de outro canal, per `phase-03-videos/TD-09`), `signParts(userId, id, partNumbers)` e `getUploadStatus(userId, id)` (`listParts`), ambos exigindo `draft` (`INVALID_VIDEO_STATUS`) e rejeitando parte > `partCount` (`UPLOAD_PARTS_INVALID`)
4. Criar DTOs em `src/videos/dto/` (`InitiateUploadDto`, `SignPartsDto`, `VideoResponseDto` + mapper `toVideoResponse`, `InitiateUploadResponseDto`, `PresignedPartDto`, `UploadStatusResponseDto`) conforme `### API Contracts` e `#### Validation Rules — videos`
5. Criar `src/videos/videos.controller.ts` (`@SkipThrottle()`, `@ApiBearerAuth()`, `@CurrentUser()`) com `POST /videos/uploads` (201), `POST /videos/:id/upload/parts` (200), `GET /videos/:id/upload` (200), `:id` via `ParseUUIDPipe`; registrar controller/service no `VideosModule` (imports `StorageModule`, `ChannelsModule`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` | Unit: 11 chars `[A-Za-z0-9_-]`, valores distintos | `src/videos/video-slug.util.spec.ts` |
| `VideosService` (iniciar/retomar) | Unit (mocks de repo/storage/canais): sem canal → `CHANNEL_NOT_FOUND`; título default; cálculo de `partCount`; retry de slug em `23505`; parte > `partCount`; status ≠ `draft`; vídeo de outro canal → `VIDEO_NOT_FOUND` | `src/videos/videos.service.spec.ts` |
| `VideosService` (iniciar) | Integration (Postgres + MinIO reais): cria linha `draft` com `upload_id` e multipart listável sem partes | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` (iniciar/retomar) | E2E (supertest): 201 com shape; 400 `sizeBytes` > 10 GiB e `contentType` inválido; 401 sem token; re-assinatura 200; `GET /videos/:id/upload` lista parte enviada; 404 para outro usuário | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.3 (entidade + `findByUserId`), SI-03.4 (constantes)

**Acceptance criteria:**

- `POST /videos/uploads` com `{ fileName: 'aula.mp4', contentType: 'video/mp4', sizeBytes: 134217729 }` retorna `201` com `video.status = 'draft'`, `video.title = 'aula'`, `video.slug` de 11 chars, `partSize = 67108864`, `partCount = 3` e 3 URLs em `parts`
- O vídeo pré-cadastrado aparece na tabela `videos` com `status = 'draft'` e `channel_id` do canal do usuário antes de qualquer byte ser enviado
- `POST /videos/uploads` com `sizeBytes = 10737418241` retorna `400` com `error: 'VALIDATION_ERROR'`
- `POST /videos/uploads` sem `Authorization` retorna `401`
- `GET /videos/:id/upload` após o `PUT` da parte 1 lista `uploadedParts` com `partNumber: 1` e o `etag` devolvido pelo storage
- `POST /videos/:id/upload/parts` com `partNumbers: [4]` para um vídeo de 3 partes retorna `400` com `error: 'UPLOAD_PARTS_INVALID'`
- Qualquer endpoint de upload chamado por outro usuário retorna `404` com `error: 'VIDEO_NOT_FOUND'`

---

### SI-03.6 — Concluir e abortar upload com enfileiramento do processamento

**Description:** Fechar o multipart, verificar o tamanho armazenado, mover o vídeo para `processing` e publicar o job `video.process`; permitir abortar um upload em andamento.

**Technical actions:**

1. `VideosService.completeUpload(userId, id, parts)`: `findOwnedById` + exige `draft`; `completeMultipartUpload` (`InvalidMultipartUploadError` → `UPLOAD_PARTS_INVALID`); `getObjectSize` ≠ `size_bytes` → marca `failed`, apaga o objeto e lança `UPLOAD_SIZE_MISMATCH` (per `phase-03-videos/TD-02`)
2. Em `completeUpload`: persistir `status = 'processing'` e `upload_id = null` **antes** de `queue.add(VIDEO_PROCESS_JOB, { videoId }, { ...VIDEO_PROCESS_JOB_OPTIONS, jobId: videoId })` via `@InjectQueue(VIDEO_PROCESSING_QUEUE)` (per `phase-03-videos/TD-08`, `### Events/Messages → video.process`)
3. `VideosService.abortUpload(userId, id)`: exige `draft`; `abortMultipartUpload`; `status = 'failed'`, `failure_reason = 'UPLOAD_ABORTED'`, `upload_id = null` (per `phase-03-videos/TD-11`)
4. DTOs `CompleteUploadDto` / `CompletedPartDto` (validação aninhada) e rotas `POST /videos/:id/upload/complete` (`@HttpCode(202)`) e `DELETE /videos/:id/upload` (`@HttpCode(204)`) no `VideosController`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (concluir/abortar) | Unit: ordem update-antes-de-enfileirar; size mismatch marca `failed`; mapeamento `InvalidMultipartUploadError` → `UPLOAD_PARTS_INVALID`; abort fora de `draft` → `INVALID_VIDEO_STATUS` | `src/videos/videos.service.spec.ts` |
| `VideosService` (concluir) | Integration (Postgres + MinIO + Redis reais): após concluir, linha em `processing` e job `video.process` com `jobId = videoId` na fila | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` (concluir/abortar) | E2E: 202 `processing`; segunda conclusão 409; ETag inválido 400 `UPLOAD_PARTS_INVALID`; abort 204 → `failed`; abort de vídeo `processing` 409 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 (vídeo `draft` + multipart iniciado)

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` com as partes e ETags corretos retorna `202` com `status: 'processing'` e o job `video.process` com payload `{ videoId }` passa a existir na fila `video-processing`
- Repetir `POST /videos/:id/upload/complete` no mesmo vídeo retorna `409` com `error: 'INVALID_VIDEO_STATUS'`
- `POST /videos/:id/upload/complete` com um ETag adulterado retorna `400` com `error: 'UPLOAD_PARTS_INVALID'` e o vídeo continua `draft`
- `DELETE /videos/:id/upload` em vídeo `draft` retorna `204`; o vídeo passa a `status: 'failed'` com `failureReason: 'UPLOAD_ABORTED'` e o multipart deixa de existir no storage
- Nenhuma requisição desses endpoints carrega bytes do vídeo — o corpo é JSON com números de parte e ETags

---

### SI-03.7 — Implementar MediaProbeService (ffprobe/ffmpeg)

**Description:** Wrapper tipado sobre os binários FFmpeg para extrair duração/metadados e um frame JPEG lendo o vídeo direto de uma URL presignada (range requests), sem copiar o arquivo inteiro.

**Technical actions:**

1. Criar `src/videos/processing/ffprobe-output.parser.ts` — função pura `parseProbeOutput(json)` → `{ durationSeconds, hasVideoStream, metadata: VideoMetadata }` (frame rate `"30000/1001"` → número; streams ausentes → `null`) (per `phase-03-videos/TD-05`)
2. Criar `src/videos/processing/media-probe.service.ts` — `probe(inputUrl)` executa `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process.spawn` e usa o parser; exit code ≠ 0 lança erro com o `stderr` (per `phase-03-videos/TD-05`)
3. Em `MediaProbeService`: `extractThumbnail(inputUrl, atSeconds)` executa `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1` e retorna o `Buffer` JPEG
4. Criar `src/test/generate-test-video.ts` — gera MP4 curto com `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=25` + áudio `sine` (sem binários versionados, per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: vídeo+áudio, só vídeo, sem stream de vídeo, frame rate fracionário, duração ausente | `src/videos/processing/ffprobe-output.parser.spec.ts` |
| `MediaProbeService` | Integration (ffmpeg + MinIO reais): probe de vídeo gerado via URL presignada interna → ~2s, 320x240, `h264`; thumbnail começa com `FF D8`; arquivo não-vídeo → erro | `src/videos/processing/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (ffmpeg na imagem), SI-03.2 (URL presignada interna)

**Acceptance criteria:**

- `probe` sobre o vídeo de teste de 2s retorna `durationSeconds` entre 1.9 e 2.1, `metadata.width = 320`, `metadata.height = 240` e `hasVideoStream = true`
- `extractThumbnail` retorna um JPEG válido (assinatura `FF D8 FF`) com largura 1280 px
- `probe` sobre bytes aleatórios lança erro contendo a mensagem do `ffprobe`

---

### SI-03.8 — Processar vídeos no worker dedicado (fila → metadados → thumbnail)

**Description:** Consumir `video.process` em um processo/container separado da API, extrair duração e metadados, gerar a thumbnail e fechar o ciclo `processing → ready | failed`.

**Technical actions:**

1. Criar `src/videos/processing/video-processing.service.ts` — `process(videoId)`: carrega o vídeo e sai sem mudanças se ausente ou ≠ `processing` (idempotência); presign GET **interno** do `storage_key`; `probe` (sem stream de vídeo → `UnrecoverableError('NO_VIDEO_STREAM')`); thumbnail em `duration × 10%` (ou `0` se < 1s) gravada em `thumbnails/{id}.jpg`; atualiza `duration_seconds`, `metadata`, `thumbnail_key`, `status = 'ready'`, `processed_at`. `markFailed(videoId, reason)` grava `failed`, `failure_reason` (≤255) e `processed_at` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
2. Criar `src/videos/processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)` delega ao service; `@OnWorkerEvent('failed')` chama `markFailed` só quando a falha é final (`job.attemptsMade >= job.opts.attempts` ou `UnrecoverableError`) (per `### Events/Messages → video.process`)
3. Criar `src/videos/processing/video-processing.module.ts` (TypeORM `Video`, `StorageModule`, `BullModule.registerQueue`, providers) e `src/worker.module.ts` (`ConfigModule` com os mesmos `load`/Joi, TypeORM via `typeorm-options.factory`, `QueueModule`, `VideoProcessingModule`) — o processor **não** é registrado no `AppModule` (per `phase-03-videos/TD-04`)
4. Criar `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`), scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`) e o serviço `video-worker` no `compose.yaml` (mesma imagem/volume do `nestjs-api`, `command: npm run start:worker:dev`, depende de `db` healthy, `redis` healthy, `minio-init` completed, `restart: unless-stopped`) (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit (mocks): ignora vídeo ausente/≠ `processing`; `UnrecoverableError` sem stream de vídeo; instante da thumbnail (10% / 0) | `src/videos/processing/video-processing.service.spec.ts` |
| `VideoProcessingProcessor` | Unit: falha não-final não marca `failed`; falha final e `UnrecoverableError` marcam `failed` | `src/videos/processing/video-processing.processor.spec.ts` |
| `VideoProcessingService` | Integration (Postgres + MinIO + ffmpeg reais): vídeo `processing` vira `ready` com duração, metadados e objeto `thumbnails/{id}.jpg` existente | `src/videos/processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingModule` / `WorkerModule` | Unit: compilação com config real | `src/videos/processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.4 (fila + factory TypeORM), SI-03.7 (MediaProbeService)

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker` em estado `running`, e seus logs mostram o contexto Nest inicializado sem servidor HTTP
- Um job `video.process` para um vídeo `processing` válido deixa o vídeo `ready` com `duration_seconds` > 0, `metadata.width`/`height` preenchidos e `thumbnail_key = thumbnails/{id}.jpg` com objeto `image/jpeg` no storage
- Um job para um arquivo sem stream de vídeo deixa o vídeo `failed` com `failure_reason` preenchido, sem novas tentativas
- Um job para vídeo já `ready` não altera a linha (reentrega idempotente)
- A API (`nestjs-api`) não consome jobs: com o worker parado, um vídeo concluído permanece `processing`

---

### SI-03.9 — Consultar vídeo, streaming e download por URL única

**Description:** Expor o vídeo pela URL única (`slug`) com o detalhe, a entrega de streaming (Range/206 servido pelo storage) e o download como anexo.

**Technical actions:**

1. `VideosService.findOwnedBySlug(userId, slug)` — slug fora de `^[A-Za-z0-9_-]{11}$`, inexistente ou de outro canal → `VIDEO_NOT_FOUND` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-09`)
2. `VideosService.getStreamUrl(userId, slug)` e `getDownloadUrl(userId, slug)` — exigem `ready` (`VIDEO_NOT_READY`); retornam `presignGetObject(storage_key, { endpoint: 'public' })` e, no download, com `downloadFileName = original_filename` (per `phase-03-videos/TD-07` e sua revisão: JSON `{ url, expiresAt }`)
3. `toVideoResponse` preenche `thumbnailUrl` com GET presignado público quando `thumbnail_key` existe
4. Rotas `GET /videos/:slug`, `GET /videos/:slug/stream`, `GET /videos/:slug/download` no `VideosController` com DTOs `StreamUrlResponseDto` / `DownloadUrlResponseDto`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (consulta/entrega) | Unit: slug malformado → 404; não-`ready` → `VIDEO_NOT_READY`; download carrega `downloadFileName` | `src/videos/videos.service.spec.ts` |
| `VideosController` (consulta/entrega) | E2E: detalhe 200 do dono; stream/download de vídeo `draft` → 409; outro usuário → 404; sem token → 401 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 (service/controller base)

**Acceptance criteria:**

- `GET /videos/:slug` do dono retorna `200` com o `VideoResponse` do vídeo
- `GET /videos/:slug/stream` em vídeo `draft` retorna `409` com `error: 'VIDEO_NOT_READY'`
- `GET /videos/:slug/stream` de vídeo de outro usuário retorna `404` com `error: 'VIDEO_NOT_FOUND'`
- `GET /videos/abc` (slug malformado) retorna `404` com `error: 'VIDEO_NOT_FOUND'`

---

### SI-03.10 — Fluxo completo de upload, processamento e streaming (E2E)

**Description:** Provar ponta a ponta, com infraestrutura real, que o upload direto ao storage dispara o processamento automático e termina em streaming/download funcionais, e exportar o contrato OpenAPI atualizado.

**Technical actions:**

1. Criar `test/videos-flow.e2e-spec.ts` — sobe `AppModule` (HTTP) e `WorkerModule` em processo com `QUEUE_PREFIX` de teste (per `phase-03-videos/TD-10`); registra/confirma/loga usuário; inicia upload de vídeo gerado; `PUT` das partes nas URLs presignadas; conclui; consulta `GET /videos/:slug` até `ready`
2. No mesmo spec: `GET /videos/:slug/stream` → `fetch(url, { Range: 'bytes=0-1023' })` responde `206`; `GET /videos/:slug/download` → `Content-Disposition: attachment`; `thumbnailUrl` responde `image/jpeg`; dois uploads geram slugs distintos
3. No mesmo spec: upload de bytes aleatórios declarados `video/mp4` termina `failed` com `failureReason` preenchido
4. Regerar `nestjs-project/openapi.json` com `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`) incluindo as rotas `/videos`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo upload → fila → worker → streaming | E2E (supertest + MinIO/Redis/ffmpeg reais, worker em processo) | `test/videos-flow.e2e-spec.ts` |
| Export OpenAPI | Integration: spec exportado contém os paths `/videos/*` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.8, SI-03.9

**Acceptance criteria:**

- Um vídeo enviado em partes direto ao storage e concluído chega a `status: 'ready'` sem nenhuma chamada manual além do `complete`, com `durationSeconds` > 0 e `thumbnailUrl` não nulo
- A URL de streaming responde `206 Partial Content` a um `Range: bytes=0-1023`, entregando 1024 bytes sem baixar o arquivo inteiro
- A URL de download responde com `Content-Disposition: attachment; filename="<originalFilename>"`
- Dois vídeos enviados pelo mesmo usuário recebem `slug`s diferentes
- Um arquivo que não é vídeo termina com `status: 'failed'` e `failureReason` preenchido
- `openapi.json` versionado contém `POST /videos/uploads` e `GET /videos/{slug}/stream`

---

### SI-03.11 — Atualizar documentação de IA e arquitetura

**Description:** Refletir no `CLAUDE.md` (raiz e `nestjs-project/`) e no diagrama de arquitetura o estado real após a fase: módulo de vídeos, endpoints, fila/worker e storage.

**Technical actions:**

1. Atualizar `CLAUDE.md` (raiz): Message Queue = BullMQ on Redis (`phase-03-videos/TD-01`), worker como container `video-worker`, storage MinIO local/S3 em produção
2. Atualizar `nestjs-project/CLAUDE.md`: serviços do Compose (`redis`, `minio`, `minio-init`, `video-worker`), verificação de prontidão, variáveis de ambiente novas, comandos do worker e seção "Videos" (endpoints, ciclo de status, fluxo de upload, testes que exigem MinIO/Redis/ffmpeg)
3. Atualizar `docs/diagrams/software-arch.mermaid`: fila `TBD` → `BullMQ (Redis)`

**Tests:** _(empty — documentation only; verified by review against the code)_

**Dependencies:** SI-03.10

**Acceptance criteria:**

- Todo arquivo, comando, variável e endpoint citado nas seções novas dos `CLAUDE.md` existe no código/`compose.yaml`
- O diagrama de arquitetura não contém mais `TBD` para a fila

---

## Technical Specifications

### Data Model

#### Video (`videos`) — SI-03.3

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in the service (`crypto.randomUUID()`) **before** insert, because `storage_key` derives from it (`phase-03-videos/TD-03`) |
| channel_id | uuid | not null, FK → `channels.id` (ON DELETE NO ACTION) | Owner channel — videos belong to a channel (1 user : 1 channel) |
| slug | varchar(11) | unique, not null | Unique URL identifier — 8 random bytes as base64url (`phase-03-videos/TD-06`) |
| title | varchar(100) | not null | Optional at initiation; defaults to the original file name without extension, truncated to 100 chars (validation AMB-1). Edited in Phase 04 |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` | Lifecycle per `phase-03-videos/TD-08` — `draft` = pre-registered, upload pending; publication state is Phase 04's concern |
| original_filename | varchar(255) | not null | As sent by the client at initiation |
| content_type | varchar(100) | not null | One of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` (`phase-03-videos/TD-02`) |
| size_bytes | bigint | not null | Declared size (≤ 10,737,418,240); verified against `HeadObject` on completion. Mapped to `number` via column transformer |
| storage_key | varchar(255) | not null | `videos/{id}/original` (`phase-03-videos/TD-03`) |
| upload_id | varchar(1024) | nullable | S3 multipart `UploadId`; set at initiation, cleared (`null`) on complete/abort |
| thumbnail_key | varchar(255) | nullable | `thumbnails/{id}.jpg`; set by the worker |
| duration_seconds | numeric(10,3) | nullable | Set by the worker from ffprobe `format.duration`; mapped to `number` via transformer |
| metadata | jsonb | nullable | `VideoMetadata` set by the worker (see below) |
| failure_reason | varchar(255) | nullable | Set when `status = failed` (`UPLOAD_ABORTED` or processing error message, truncated) |
| processed_at | timestamp | nullable | When the worker finished (ready or failed) |
| created_at | timestamp | not null, default now() | `@CreateDateColumn` |
| updated_at | timestamp | not null, default now() | `@UpdateDateColumn` |

**`VideoMetadata` (jsonb shape):** `{ formatName: string, bitRate: number \| null, width: number \| null, height: number \| null, videoCodec: string \| null, audioCodec: string \| null, frameRate: number \| null }` — extracted from `ffprobe -show_format -show_streams` JSON (`phase-03-videos/TD-05`).

**Relations:** `Video` → `Channel` (many-to-one, `@JoinColumn({ name: 'channel_id' })`); `Channel` gets no inverse collection in this phase (not needed by any query).
**Indexes:** unique on `slug`; non-unique on `channel_id`.
**Migration:** `src/database/migrations/<timestamp>-CreateVideos.ts` — creates `videos_status_enum`, `videos`, the indexes and the FK; `down` drops them in reverse order (enum type included, so the migration test can re-apply).

**Status transitions (enforced in services, never by the client):**

| From | To | Who | When |
|------|----|-----|------|
| — | `draft` | `VideosService.initiateUpload` | Upload started (pre-registration) |
| `draft` | `processing` | `VideosService.completeUpload` | Multipart completed and object size verified; status committed **before** the job is enqueued (`phase-03-videos/TD-08`) |
| `draft` | `failed` | `VideosService.abortUpload` | Client aborted (`failure_reason = 'UPLOAD_ABORTED'`, `phase-03-videos/TD-11`) |
| `processing` | `ready` | `VideoProcessingProcessor` | Metadata extracted and thumbnail stored |
| `processing` | `failed` | `VideoProcessingProcessor` (`failed` worker event) | Last attempt failed or `UnrecoverableError` thrown |

### API Contracts

All `/videos` endpoints require `Authorization: Bearer <access_token>` (global `JwtAuthGuard`) and are owner-only (`phase-03-videos/TD-09`); the controller is `@SkipThrottle()` (rate limiting stays scoped to auth, inherited convention). Upload-handshake routes address the video by `:id` (UUID, `ParseUUIDPipe`); viewing routes address it by its unique `:slug` (`phase-03-videos/TD-06`). No video bytes ever pass through the API (`phase-03-videos/TD-02`, `phase-03-videos/TD-07`).

**`VideoResponse`** (shared response body):
- id: string (uuid)
- slug: string — 11 chars, `[A-Za-z0-9_-]`
- title: string
- status: `'draft' | 'processing' | 'ready' | 'failed'`
- originalFilename: string
- contentType: string
- sizeBytes: number
- durationSeconds: number | null
- metadata: `VideoMetadata` | null
- thumbnailUrl: string | null — short-lived presigned GET (public endpoint) when `thumbnail_key` is set
- failureReason: string | null
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**`PresignedPart`**: `{ partNumber: number, url: string }` — presigned `UploadPart` URL on the public storage endpoint (`phase-03-videos/TD-03`).

---

#### POST /videos/uploads (SI-03.5)

Pre-registers the video as `draft`, creates the S3 multipart upload and returns presigned URLs for every part.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1..255 chars
- contentType: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- sizeBytes: integer, required — 1..10737418240 (10 GiB)
- title: string, optional — 1..100 chars; default = `fileName` without extension (truncated to 100)

**Response 201:**
- video: `VideoResponse` (status `draft`)
- uploadId: string
- partSize: number — 67108864 (64 MiB)
- partCount: number — `ceil(sizeBytes / partSize)`
- parts: `PresignedPart[]` — one per part, `partNumber` 1..partCount
- expiresAt: string (ISO-8601) — URLs expire after `S3_PRESIGN_EXPIRES_SECONDS` (default 3600)

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (including `sizeBytes` > 10 GiB or unsupported `contentType`)
- 401: missing/invalid access token
- 404 CHANNEL_NOT_FOUND: authenticated user has no channel

---

#### POST /videos/:id/upload/parts (SI-03.5)

Re-signs part URLs (expired URLs or resume after a connection failure).

**Request body:**
- partNumbers: integer[], required — 1..1000 items, each 1..partCount, unique

**Response 200:**
- parts: `PresignedPart[]`
- expiresAt: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: invalid body or a part number > `partCount`
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: id unknown or not owned by the caller
- 409 INVALID_VIDEO_STATUS: video is not `draft`

---

#### GET /videos/:id/upload (SI-03.5)

Upload progress for resume — lists the parts already stored (`ListParts`).

**Response 200:**
- uploadId: string
- partSize: number
- partCount: number
- uploadedParts: `{ partNumber: number, etag: string, size: number }[]`

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: id unknown or not owned by the caller
- 409 INVALID_VIDEO_STATUS: video is not `draft`

---

#### POST /videos/:id/upload/complete (SI-03.6)

Completes the multipart upload, verifies the stored size, moves the video to `processing` and enqueues `video.process`.

**Request body:**
- parts: `{ partNumber: integer (1..10000), etag: string (1..255) }[]`, required — 1..10000 items

**Response 202:** `VideoResponse` (status `processing`)

**Error responses:**
- 400 VALIDATION_ERROR: invalid body
- 400 UPLOAD_PARTS_INVALID: storage rejected the part list (missing/unknown part or wrong ETag)
- 400 UPLOAD_SIZE_MISMATCH: stored object size ≠ declared `sizeBytes` (video marked `failed`, object deleted)
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: id unknown or not owned by the caller
- 409 INVALID_VIDEO_STATUS: video is not `draft`

---

#### DELETE /videos/:id/upload (SI-03.6)

Aborts an in-progress upload (`AbortMultipartUpload`) — `phase-03-videos/TD-11`.

**Response 204:** No content. Video becomes `failed` with `failureReason: 'UPLOAD_ABORTED'`.

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: id unknown or not owned by the caller
- 409 INVALID_VIDEO_STATUS: video is not `draft`

---

#### GET /videos/:slug (SI-03.9)

**Request path parameters:**
- slug: string — must match `^[A-Za-z0-9_-]{11}$`, otherwise 404

**Response 200:** `VideoResponse`

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: slug unknown or not owned by the caller

---

#### GET /videos/:slug/stream (SI-03.9)

Authorizes playback and hands off a short-lived presigned `GET` on the public storage endpoint; storage serves `Range` requests with `206 Partial Content` (`phase-03-videos/TD-07` + revision).

**Response 200:**
- url: string — presigned GET, inline
- expiresAt: string (ISO-8601)

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: slug unknown or not owned by the caller
- 409 VIDEO_NOT_READY: status is not `ready`

---

#### GET /videos/:slug/download (SI-03.9)

**Response 200:**
- url: string — presigned GET with `response-content-disposition: attachment; filename="<originalFilename>"`
- expiresAt: string (ISO-8601)
- fileName: string — `originalFilename`

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: slug unknown or not owned by the caller
- 409 VIDEO_NOT_READY: status is not `ready`

---

#### Validation Rules — videos

- `fileName`: `@IsString @Length(1, 255)`
- `contentType`: `@IsIn(SUPPORTED_VIDEO_CONTENT_TYPES)`
- `sizeBytes`: `@IsInt @Min(1) @Max(10737418240)`
- `title`: `@IsOptional @IsString @Length(1, 100)`
- `partNumbers`: `@IsArray @ArrayMinSize(1) @ArrayMaxSize(1000) @ArrayUnique`, each `@IsInt @Min(1) @Max(10000)` (upper bound against `partCount` checked in the service)
- `parts`: `@IsArray @ArrayMinSize(1) @ArrayMaxSize(10000) @ValidateNested @Type(() => CompletedPartDto)`; `partNumber` `@IsInt @Min(1) @Max(10000)`, `etag` `@IsString @Length(1, 255)`
- `:id`: `ParseUUIDPipe` (non-UUID → 400 VALIDATION_ERROR)

### Authorization Matrix

Owner = the authenticated user whose channel (`channels.user_id = jwt.sub`) owns the video (`videos.channel_id`). Non-owners get **404 VIDEO_NOT_FOUND** (never 403) so a video's existence is not leaked (`phase-03-videos/TD-09`).

| Endpoint | Anonymous | Authenticated (not owner) | Owner | Notes |
|----------|-----------|---------------------------|-------|-------|
| POST /videos/uploads | ✗ (401) | ✓ | — | Creates a video in the caller's own channel |
| POST /videos/:id/upload/parts | ✗ (401) | ✗ (404) | ✓ | |
| GET /videos/:id/upload | ✗ (401) | ✗ (404) | ✓ | |
| POST /videos/:id/upload/complete | ✗ (401) | ✗ (404) | ✓ | |
| DELETE /videos/:id/upload | ✗ (401) | ✗ (404) | ✓ | |
| GET /videos/:slug | ✗ (401) | ✗ (404) | ✓ | Anonymous viewing is Phase 05 |
| GET /videos/:slug/stream | ✗ (401) | ✗ (404) | ✓ | Anonymous viewing is Phase 05 |
| GET /videos/:slug/download | ✗ (401) | ✗ (404) | ✓ | |

Presigned storage URLs are bearer links valid until `expiresAt` (≤ `S3_PRESIGN_EXPIRES_SECONDS`); authorization happens when the API issues them.

### Error Catalog

Error response format inherited from Phase 02 (`phase-02-auth/TD-07`): `{ statusCode, error, message }`; validation errors use `error: 'VALIDATION_ERROR'` with `message` as an array. New domain exceptions extend `DomainException` and live in `src/videos/exceptions/video.exceptions.ts`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | POST /videos/uploads when no channel exists for `jwt.sub` |
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:id…` or `/videos/:slug…` route with an unknown id/slug, a malformed slug, or a video owned by another channel |
| INVALID_VIDEO_STATUS | 409 | Video is not in a valid status for this operation | Upload-handshake routes (`parts`, `upload`, `complete`, `DELETE upload`) when status ≠ `draft` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | GET /videos/:slug/stream or /download when status ≠ `ready` |
| UPLOAD_PARTS_INVALID | 400 | Uploaded parts are invalid or incomplete | POST /videos/:id/upload/complete when storage rejects `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`, `EntityTooSmall`), or a requested part number exceeds `partCount` on POST /videos/:id/upload/parts |
| UPLOAD_SIZE_MISMATCH | 400 | Uploaded file size does not match the declared size | POST /videos/:id/upload/complete when `HeadObject.ContentLength ≠ size_bytes` |

Processing failures are **not** HTTP errors: they surface as `status: 'failed'` + `failureReason` on `VideoResponse`.

### Events/Messages

#### video.process (queue `video-processing`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` via `@InjectQueue('video-processing')` (per `phase-03-videos/TD-01`) — enqueued **after** the `draft → processing` update is committed (per `phase-03-videos/TD-08`).
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')`, `WorkerHost`) registered only in `WorkerModule`, running in the `video-worker` Compose service (per `phase-03-videos/TD-04`).
**Trigger:** a multipart upload was completed and its size verified.
**Job options:** `jobId = videoId` (duplicate adds while the job exists are no-ops), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 3600 }`, `removeOnFail: { age: 604800 }` (per `phase-03-videos/TD-08`).
**Queue keys prefix:** `QUEUE_PREFIX` (default `streamtube`; tests use an isolated prefix, per `phase-03-videos/TD-10`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). The processor is idempotent: it exits without changes when the video is missing or its status ≠ `processing`; re-running a `processing` video overwrites the same thumbnail key and fields.
**Processing steps (consumer):**
1. Load the video; skip if missing / not `processing`.
2. Presign an **internal-endpoint** GET for `storage_key` and run `ffprobe` on it (per `phase-03-videos/TD-05`); no video stream → throw `UnrecoverableError('NO_VIDEO_STREAM')`.
3. Extract a JPEG frame with `ffmpeg` at `duration × 10%` (or `0` when duration < 1s), width 1280 keeping aspect ratio; `PutObject` to `thumbnails/{id}.jpg` (`image/jpeg`).
4. Update `duration_seconds`, `metadata`, `thumbnail_key`, `status = 'ready'`, `processed_at = now()`.
**Failure handling:** `@OnWorkerEvent('failed')` marks the video `failed` (`failure_reason` = error message truncated to 255, `processed_at = now()`) only when the failure is final — `job.attemptsMade >= job.opts.attempts` or the error is an `UnrecoverableError`.

---

## Dependency Map

```
SI-03.1 (root — deps, config, Redis/MinIO no Compose)
├── SI-03.2 — StorageModule (precisa de MinIO + config storage)
│   └── SI-03.7 — MediaProbeService (+ SI-03.1: ffmpeg na imagem; URL presignada interna)
├── SI-03.3 — entidade Video + migration + findByUserId
│   └── SI-03.4 — QueueModule + contrato do job (+ SI-03.1: Redis)
│       └── SI-03.8 — worker/processor (+ SI-03.7)
└── SI-03.2 + SI-03.3 + SI-03.4
    └── SI-03.5 — iniciar upload / retomada
        ├── SI-03.6 — concluir/abortar + enfileirar
        └── SI-03.9 — detalhe, streaming, download

SI-03.6 + SI-03.8 + SI-03.9
└── SI-03.10 — fluxo E2E completo + openapi.json
    └── SI-03.11 — CLAUDE.md + diagrama
```

Ordem linearizada: SI-03.1 → SI-03.2, SI-03.3 (paralelos) → SI-03.4, SI-03.7 (paralelos) → SI-03.5 → SI-03.6, SI-03.8, SI-03.9 (paralelos) → SI-03.10 → SI-03.11

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços de storage/fila no Compose
- [ ] SI-03.2 — Implementar StorageModule (S3/MinIO)
- [ ] SI-03.3 — Criar entidade Video, migration e lookup de canal
- [ ] SI-03.4 — Infra: fila BullMQ compartilhada e contrato do job
- [ ] SI-03.5 — Iniciar upload com pré-cadastro em rascunho e retomada
- [ ] SI-03.6 — Concluir e abortar upload com enfileiramento do processamento
- [ ] SI-03.7 — Implementar MediaProbeService (ffprobe/ffmpeg)
- [ ] SI-03.8 — Processar vídeos no worker dedicado (fila → metadados → thumbnail)
- [ ] SI-03.9 — Consultar vídeo, streaming e download por URL única
- [ ] SI-03.10 — Fluxo completo de upload, processamento e streaming (E2E)
- [ ] SI-03.11 — Atualizar documentação de IA e arquitetura

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
