import { getQueueToken } from '@nestjs/bullmq';
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
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { VideoStatus } from './video-status.enum';
import {
  VIDEO_PART_SIZE_BYTES,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
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
    update: jest.fn(),
    findOneByOrFail: jest.fn(),
  };
  const queue = { add: jest.fn() };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    presignGetObject: jest.fn(),
    completeMultipartUpload: jest.fn(),
    getObjectSize: jest.fn(),
    deleteObject: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.create.mockImplementation((v: Partial<Video>) => ({
      ...v,
      created_at: new Date(),
      updated_at: new Date(),
    }));
    repo.save.mockImplementation((v: Video) => Promise.resolve(v));
    storage.createMultipartUpload.mockResolvedValue('upload-1');
    storage.presignUploadPart.mockImplementation(
      (_k: string, _u: string, n: number) =>
        Promise.resolve({
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
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
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

      const [[saved]] = repo.save.mock.calls as [Video][];
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
        .mockImplementation((v: Video) => Promise.resolve(v));

      await service.initiateUpload(USER_ID, dto);

      expect(repo.save).toHaveBeenCalledTimes(2);
      const [[first], [second]] = repo.save.mock.calls as [Video][];
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

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, etag: '"etag-1"' }];

    beforeEach(() => {
      repo.findOne.mockResolvedValue(buildVideo({ size_bytes: 1024 }));
      repo.findOneByOrFail.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );
    });

    it('should commit the processing status before enqueueing video.process', async () => {
      storage.getObjectSize.mockResolvedValue(1024);
      const order: string[] = [];
      repo.update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve();
      });
      queue.add.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve();
      });

      const result = await service.completeUpload(USER_ID, 'video-1', parts);

      expect(order).toEqual(['update', 'enqueue']);
      expect(repo.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(queue.add).toHaveBeenCalledWith(
        VIDEO_PROCESS_JOB,
        { videoId: 'video-1' },
        expect.objectContaining({ jobId: 'video-1', attempts: 3 }),
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('should map storage part errors to UPLOAD_PARTS_INVALID without enqueueing', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new InvalidMultipartUploadError('InvalidPart', 'bad etag'),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-1', parts),
      ).rejects.toBeInstanceOf(UploadPartsInvalidException);
      expect(repo.update).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should fail the video and delete the object on a size mismatch', async () => {
      storage.getObjectSize.mockResolvedValue(999);

      await expect(
        service.completeUpload(USER_ID, 'video-1', parts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repo.update).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({ status: VideoStatus.FAILED }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should reject completing a video that is already processing', async () => {
      repo.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.completeUpload(USER_ID, 'video-1', parts),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and mark the video failed', async () => {
      repo.findOne.mockResolvedValue(buildVideo());

      await service.abortUpload(USER_ID, 'video-1');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
      );
      expect(repo.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.FAILED,
        failure_reason: 'UPLOAD_ABORTED',
        upload_id: null,
      });
    });

    it('should reject aborting a video that is not a draft', async () => {
      repo.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.READY, upload_id: null }),
      );

      await expect(
        service.abortUpload(USER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
    });
  });

  describe('playback', () => {
    it('should report VIDEO_NOT_FOUND for a malformed slug without querying', async () => {
      await expect(service.getStreamUrl(USER_ID, 'abc')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('should refuse to stream a video that is not ready', async () => {
      repo.findOne.mockResolvedValue(
        buildVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getStreamUrl(USER_ID, 'AbCdEfGhIjK'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('should presign an attachment download named after the original file', async () => {
      repo.findOne.mockResolvedValue(buildVideo({ status: VideoStatus.READY }));
      storage.presignGetObject.mockResolvedValue({
        url: 'http://minio/dl',
        expiresAt: new Date('2026-01-01T01:00:00Z'),
      });

      const result = await service.getDownloadUrl(USER_ID, 'AbCdEfGhIjK');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original',
        { endpoint: 'public', downloadFileName: 'aula.mp4' },
      );
      expect(result).toEqual({
        url: 'http://minio/dl',
        expiresAt: '2026-01-01T01:00:00.000Z',
        fileName: 'aula.mp4',
      });
    });
  });
});
