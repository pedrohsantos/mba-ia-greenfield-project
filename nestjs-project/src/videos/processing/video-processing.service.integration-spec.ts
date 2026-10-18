import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { generateTestVideo } from '../../test/generate-test-video';
import { applyVideoTestEnv } from '../../test/video-test-env';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration — Postgres + MinIO + ffmpeg)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let service: VideoProcessingService;
  let channelId: string;
  let sampleVideo: Buffer;

  beforeAll(async () => {
    applyVideoTestEnv();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [MediaProbeService, VideoProcessingService],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = moduleRef.get(StorageService);
    service = moduleRef.get(VideoProcessingService);
    sampleVideo = await generateTestVideo(2);
  }, 60000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `vp_${randomUUID().slice(0, 8)}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'proc',
      nickname: `proc_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
    channelId = channel.id;
  });

  async function storedVideo(
    content: Buffer,
    status = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const id = randomUUID();
    const video = await videos.save({
      id,
      channel_id: channelId,
      slug: randomUUID().replace(/-/g, '').slice(0, 11),
      title: 'sample',
      status,
      original_filename: 'sample.mp4',
      content_type: 'video/mp4',
      size_bytes: content.length,
      storage_key: `videos/${id}/original`,
    });
    await storage.putObject(video.storage_key, content, 'video/mp4');
    return video;
  }

  it('turns a processing video into ready with duration, metadata and a stored thumbnail', async () => {
    const video = await storedVideo(sampleVideo);

    await expect(service.process(video.id)).resolves.toBe('ready');

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeGreaterThan(1.9);
    expect(row.metadata).toMatchObject({ width: 320, height: 240 });
    expect(row.thumbnail_key).toBe(`thumbnails/${video.id}.jpg`);
    expect(row.processed_at).toBeInstanceOf(Date);
    const { url } = await storage.presignGetObject(row.thumbnail_key!, {
      endpoint: 'internal',
    });
    const thumb = await fetch(url);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');

    await storage.deleteObject(row.thumbnail_key!);
    await storage.deleteObject(row.storage_key);
  });

  it('leaves an already ready video untouched (idempotent redelivery)', async () => {
    const video = await storedVideo(sampleVideo, VideoStatus.READY);

    await expect(service.process(video.id)).resolves.toBe('skipped');

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.thumbnail_key).toBeNull();
    await storage.deleteObject(video.storage_key);
  });

  it('rejects a non-video file as unrecoverable and markFailed persists the reason', async () => {
    const video = await storedVideo(randomBytes(4096));

    const error = await service.process(video.id).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    await service.markFailed(video.id, (error as Error).message);

    const row = await videos.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toBeTruthy();
    expect(error instanceof UnrecoverableError || /ffprobe/.test((error as Error).message)).toBe(true);
    await storage.deleteObject(video.storage_key);
  });
});
