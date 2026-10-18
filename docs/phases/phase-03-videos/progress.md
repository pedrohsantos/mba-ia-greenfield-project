# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/11 completed

### SI-03.1 — Infra: dependências, configuração e serviços de storage/fila no Compose
- **Status:** completed
- **Tests:** 8/8 passing (env.validation.integration-spec.ts); app.e2e-spec.ts 1/1 boot check
- **Observations:** 
  - `ioredis` pinned to `^5.11.1` instead of `^6.0.0`: `typeorm@0.3.28` declares `peerOptional ioredis@^5.0.4` and npm failed with ERESOLVE; 5.x still satisfies BullMQ 6's `ioredis >=5` peer (plan + library-refs updated).
  - The Chainguard MinIO image has bash but no `grep`/`curl`; the healthcheck uses bash `/dev/tcp` + `read`/`[[ ]]` builtins.
  - `.env.example` had an unquoted `MAIL_FROM="StreamTube" <…>` that breaks Compose's `.env` parsing, which is now required because `compose.yaml` interpolates `S3_*` vars — value is now single-quoted.
  - Host port 5432 was held by another project's container (`postgres_rag`), stopped to bring the stack up (outside this repo).

### SI-03.2 — Implementar StorageModule (S3/MinIO)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Criar entidade Video, migration e lookup de canal
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Infra: fila BullMQ compartilhada e contrato do job
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Iniciar upload com pré-cadastro em rascunho e retomada
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
