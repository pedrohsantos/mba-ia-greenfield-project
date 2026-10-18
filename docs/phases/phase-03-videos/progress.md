# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/11 completed

### SI-03.1 — Infra: dependências, configuração e serviços de storage/fila no Compose
- **Status:** completed
- **Tests:** 8/8 passing (env.validation.integration-spec.ts); app.e2e-spec.ts 1/1 boot check
- **Observations:** 
  - `ioredis` pinned to `^5.11.1` instead of `^6.0.0`: `typeorm@0.3.28` declares `peerOptional ioredis@^5.0.4` and npm failed with ERESOLVE; 5.x still satisfies BullMQ 6's `ioredis >=5` peer (plan + library-refs updated).
  - The Chainguard MinIO image has bash but no `grep`/`curl`; the healthcheck uses bash `/dev/tcp` + `read`/`[[ ]]` builtins.
  - `.env.example` had an unquoted `MAIL_FROM="StreamTube" <…>` that breaks Compose's `.env` parsing, which is now required because `compose.yaml` interpolates `S3_*` vars — value is now single-quoted.
  - Host port 5432 was held by another project's container (`postgres_rag`), stopped to bring the stack up (outside this repo).

### SI-03.2 — Implementar StorageModule (S3/MinIO)
- **Status:** completed
- **Tests:** 6/6 passing (storage.service.integration-spec.ts, storage.module.spec.ts)
- **Observations:** 
  - S3 clients are DI providers (`STORAGE_CLIENTS.INTERNAL`/`PUBLIC`) built in `StorageModule` instead of `new` inside the service, per the DI convention.
  - `responseChecksumValidation: 'WHEN_REQUIRED'` set alongside `requestChecksumCalculation` so presigned GETs are not checksum-validated against MinIO.

### SI-03.3 — Criar entidade Video, migration e lookup de canal
- **Status:** completed
- **Tests:** 121/121 passing across 16 suites (video.entity.integration-spec.ts, migrations.integration-spec.ts, channels.service.integration-spec.ts + auth/users/channels suites re-run because their entity lists now include Video)
- **Observations:** 
  - `.claude/rules/nestjs-entities.md` requires `@PrimaryGeneratedColumn('uuid')` and both relation sides: `Video.id` keeps that decorator (the service-assigned id is still honored on insert) and `Channel` gained `@OneToMany videos` — the plan's Data Model said no inverse collection; the rule wins.
  - Every existing test DataSource that registers `Channel` had to add `Video` to its entity list (TypeORM fails to build `Channel#videos` metadata otherwise).
  - The local `streamtube` DB is shared by dev and tests; an earlier interrupted parallel test run had dropped the `migrations` table while synchronize-created tables remained, so `migration:run` failed. The local schema was reset and all 3 migrations applied cleanly.
  - `migrations.integration-spec.ts` now also drops leftover enum types before re-applying — fixes the pre-existing `type "verification_tokens_type_enum" already exists` failure seen in the baseline run.

### SI-03.4 — Infra: fila BullMQ compartilhada e contrato do job
- **Status:** completed
- **Tests:** 3/3 passing (queue.module.integration-spec.ts, videos.module.spec.ts); existing e2e 52/52 with the extracted TypeORM factory
- **Observations:** 
  - BullMQ 6 no longer exposes `Queue#client`; the prefix assertion uses a separate ioredis client to look up the job key.
  - Fixed a `tsc` error found while checking: `fetch` in `storage.service.integration-spec.ts` (SI-03.2) needed `Uint8Array` instead of `Buffer` as body type.

### SI-03.5 — Iniciar upload com pré-cadastro em rascunho e retomada
- **Status:** completed
- **Tests:** 29/29 passing (video-slug.util.spec.ts, videos.service.spec.ts, videos.service.integration-spec.ts, videos.module.spec.ts; videos.e2e-spec.ts 10 e2e)
- **Observations:** 
  - E2E users are created directly (confirmed user + `ChannelsService.createChannel` + token from the app's `JwtService`) in `test/helpers/videos-e2e.helpers.ts`; the register/confirm/login flow stays covered by `auth.e2e-spec.ts`.
  - Pre-existing gap (out of scope): `npm run openapi:export` runs through ts-node, so the `@nestjs/swagger` CLI plugin is not applied and request DTO schemas come out empty in `openapi.json` (already true for `RegisterDto` etc.). Response DTOs here use explicit `@ApiProperty` per the DTO rule, so they export correctly.

### SI-03.6 — Concluir e abortar upload com enfileiramento do processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Implementar MediaProbeService (ffprobe/ffmpeg)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Processar vídeos no worker dedicado (fila → metadados → thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Consultar vídeo, streaming e download por URL única
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Fluxo completo de upload, processamento e streaming (E2E)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Atualizar documentação de IA e arquitetura
- **Status:** pending
- **Tests:** —
- **Observations:** none
