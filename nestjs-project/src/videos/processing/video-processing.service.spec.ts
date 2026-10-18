import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import { MediaProbeService } from './media-probe.service';
import {
  VideoProcessingService,
  thumbnailTimestamp,
} from './video-processing.service';

const METADATA = {
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitRate: 1000,
  width: 320,
  height: 240,
  videoCodec: 'h264',
  audioCodec: 'aac',
  frameRate: 25,
};

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  const repo = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = { presignGetObject: jest.fn(), putObject: jest.fn() };
  const probe = { probe: jest.fn(), extractThumbnail: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    storage.presignGetObject.mockResolvedValue({
      url: 'http://minio:9000/signed',
      expiresAt: new Date(),
    });
    probe.extractThumbnail.mockResolvedValue(Buffer.from([0xff, 0xd8]));
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: MediaProbeService, useValue: probe },
      ],
    }).compile();
    service = moduleRef.get(VideoProcessingService);
  });

  it.each([null, { id: 'v1', status: VideoStatus.READY }])(
    'should skip without side effects when the video is %p',
    async (video) => {
      repo.findOneBy.mockResolvedValue(video);

      await expect(service.process('v1')).resolves.toBe('skipped');
      expect(probe.probe).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    },
  );

  it('should throw UnrecoverableError when the file has no video stream', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'v1',
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/v1/original',
    });
    probe.probe.mockResolvedValue({
      durationSeconds: 3,
      hasVideoStream: false,
      metadata: METADATA,
    });

    await expect(service.process('v1')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('should read through the internal endpoint, store the thumbnail and mark the video ready', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'v1',
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/v1/original',
    });
    probe.probe.mockResolvedValue({
      durationSeconds: 120,
      hasVideoStream: true,
      metadata: METADATA,
    });

    await expect(service.process('v1')).resolves.toBe('ready');

    expect(storage.presignGetObject).toHaveBeenCalledWith('videos/v1/original', {
      endpoint: 'internal',
    });
    expect(probe.extractThumbnail).toHaveBeenCalledWith(
      'http://minio:9000/signed',
      12,
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'thumbnails/v1.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'v1', status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.READY,
        duration_seconds: 120,
        metadata: METADATA,
        thumbnail_key: 'thumbnails/v1.jpg',
      }),
    );
  });

  it('should truncate the failure reason to 255 chars', async () => {
    await service.markFailed('v1', 'x'.repeat(400));

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'v1', status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.FAILED,
        failure_reason: 'x'.repeat(255),
      }),
    );
  });
});

describe('thumbnailTimestamp', () => {
  it.each([
    [120, 12],
    [10, 1],
    [0.5, 0],
    [null, 0],
  ])('should pick %s s → %s s', (duration, expected) => {
    expect(thumbnailTimestamp(duration)).toBe(expected);
  });
});
