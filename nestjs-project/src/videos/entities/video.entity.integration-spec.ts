import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';
import type { VideoMetadata } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 * 1024 * 1024;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_entity_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'videochan',
      nickname: `vc_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      channel_id: channel.id,
      slug: randomUUID().replace(/-/g, '').slice(0, 11),
      title: 'Aula 1',
      original_filename: 'aula-1.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/original`,
      ...overrides,
    });
  }

  it('should default status to draft and keep optional fields null', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.upload_id).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
  });

  it('should keep the service-assigned id', async () => {
    const video = buildVideo();

    const saved = await videoRepository.save(video);

    expect(saved.id).toBe(video.id);
  });

  it('should reject a duplicated slug', async () => {
    await videoRepository.save(buildVideo({ slug: 'AbCdEfGhIjK' }));

    await expect(
      videoRepository.save(buildVideo({ slug: 'AbCdEfGhIjK' })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject a channel_id that does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should round-trip a 10 GiB size and a fractional duration as numbers', async () => {
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: TEN_GIB, duration_seconds: 125.375 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(TEN_GIB);
    expect(found.duration_seconds).toBe(125.375);
  });

  it('should persist metadata as jsonb', async () => {
    const metadata: VideoMetadata = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitRate: 512000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameRate: 29.97,
    };
    const saved = await videoRepository.save(buildVideo({ metadata }));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
  });
});
