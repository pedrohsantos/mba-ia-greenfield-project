import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { applyVideoTestEnv } from '../test/video-test-env';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — Postgres + MinIO)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let userId: string;

  beforeAll(async () => {
    applyVideoTestEnv();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot({
          ...createTestDataSource(ALL_ENTITIES).options,
          synchronize: false,
        }),
        QueueModule,
        VideosModule,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const email = `vs_int_${randomUUID().slice(0, 8)}@example.com`;
    const user = await dataSource
      .getRepository(User)
      .save({ email, password: 'hashed' });
    await moduleRef.get(ChannelsService).createChannel(user.id, email);
    userId = user.id;
  });

  it('pre-registers a draft row and opens a multipart upload with no parts yet', async () => {
    const result = await service.initiateUpload(userId, {
      fileName: 'aula.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: result.video.id });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.upload_id).toBe(result.uploadId);
    expect(row.slug).toBe(result.video.slug);
    await expect(
      storage.listParts(row.storage_key, result.uploadId),
    ).resolves.toEqual([]);

    await storage.abortMultipartUpload(row.storage_key, result.uploadId);
  });
});
