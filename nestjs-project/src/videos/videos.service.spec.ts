import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { InvalidMultipartUploadError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStatusException,
  UploadPartsInvalidException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { VideoStatus } from './video-status.enum';
import { VIDEO_PART_SIZE_BYTES } from './videos.constants';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID };

function slugCollision(): QueryFailedError {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
    detail: 'Key (slug)=(abc) already exists.',
  } as unknown as Error);
}

function buildVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    channel_id: CHANNEL.id,
    slug: 'AbCdEfGhIjK',
    title: 'aula',
    status: VideoStatus.DRAFT,
    original_filename: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: 3 * VIDEO_PART_SIZE_BYTES,
    storage_key: 'videos/video-1/original',
    upload_id: 'upload-1',
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    failure_reason: null,
    processed_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    channel: CHANNEL as Video['channel'],
    ...overrides,
  };
}

describe('VideosService', () => {
  let service: VideosService;
  const repo = {
    create: jest.fn((v: Partial<Video>) => ({
      ...v,
      created_at: new Date(),
      updated_at: new Date(),
    })),
    save: jest.fn(),
    findOne: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    presignGetObject: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.create.mockImplementation((v: Partial<Video>) => ({
      ...v,
      created_at: new Date(),
      updated_at: new Date(),
    }));
    repo.save.mockImplementation(async (v: Video) => v);
    storage.createMultipartUpload.mockResolvedValue('upload-1');
    storage.presignUploadPart.mockImplementation(
      async (_k: string, _u: string, n: number) => ({
        url: `http://minio/part-${n}`,
        expiresAt: new Date('2026-01-01T01:00:00Z'),
      }),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  describe('initiateUpload', () => {
    const dto = {
      fileName: 'aula de redes.mp4',
      contentType: 'video/mp4',
      sizeBytes: 2 * VIDEO_PART_SIZE_BYTES + 1,
    };

    it('should throw CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload(USER_ID, dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should pre-register a draft titled after the file name and presign every part', async () => {
      channels.findByUserId.mockResolvedValue(CHANNEL);

      const result = await service.initiateUpload(USER_ID, dto);

      const saved = repo.save.mock.calls[0][0] as Video;
      expect(saved).toMatchObject({
        channel_id: CHANNEL.id,
        title: 'aula de redes',
        status: VideoStatus.DRAFT,
        upload_id: 'upload-1',
        storage_key: `videos/${saved.id}/original`,
      });
      expect(result.partCount).toBe(3);
      expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(result.video.status).toBe(VideoStatus.DRAFT);
    });

    it('should keep an explicit title', async () => {
      channels.findByUserId.mockResolvedValue(CHANNEL);

      const result = await service.initiateUpload(USER_ID, {
        ...dto,
        title: 'Redes — aula 1',
      });

      expect(result.video.title).toBe('Redes — aula 1');
    });

    it('should retry with a new slug on a slug unique violation', async () => {
      channels.findByUserId.mockResolvedValue(CHANNEL);
      repo.save
        .mockRejectedValueOnce(slugCollision())
        .mockImplementation(async (v: Video) => v);

      await service.initiateUpload(USER_ID, dto);

      expect(repo.save).toHaveBeenCalledTimes(2);
      const [first, second] = repo.save.mock.calls.map((c) => c[0] as Video);
      expect(first.id).toBe(second.id);
    });

    it('should abort the multipart upload when the insert fails for good', async () => {
      channels.findByUserId.mockResolvedValue(CHANNEL);
      const failure = new Error('db down');
      repo.save.mockRejectedValue(failure);

      await expect(service.initiateUpload(USER_ID, dto)).rejects.toBe(failure);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-1',
      );
    });
  });

  describe('signParts', () => {
    it('should reject a part number above partCount', async () => {
      repo.findOne.mockResolvedValue(buildVideo());

      await expect(
        service.signParts(USER_ID, 'video-1', [4]),
      ).rejects.toBeInstanceOf(UploadPartsInvalidException);
    });

    it('should reject a video that is not a draft', async () => {
      repo.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.signParts(USER_ID, 'video-1', [1]),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
    });

    it('should report VIDEO_NOT_FOUND for a video of another channel', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.signParts('someone-else', 'video-1', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'video-1', channel: { user_id: 'someone-else' } },
        }),
      );
    });
  });

  describe('getUploadStatus', () => {
    it('should map a vanished multipart upload to UPLOAD_PARTS_INVALID', async () => {
      repo.findOne.mockResolvedValue(buildVideo());
      storage.listParts.mockRejectedValue(
        new InvalidMultipartUploadError('NoSuchUpload', 'gone'),
      );

      await expect(
        service.getUploadStatus(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(UploadPartsInvalidException);
    });
  });
});
