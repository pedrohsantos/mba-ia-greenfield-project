import { Test } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { VideoProcessJobData } from '../videos.constants';
import {
  VideoProcessingProcessor,
  isFinalFailure,
} from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

function job(attemptsMade: number, attempts = 3): Job<VideoProcessJobData> {
  return {
    data: { videoId: 'v1' },
    attemptsMade,
    opts: { attempts },
  } as Job<VideoProcessJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  const service = { process: jest.fn(), markFailed: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: VideoProcessingService, useValue: service },
      ],
    }).compile();
    processor = moduleRef.get(VideoProcessingProcessor);
  });

  it('should delegate the job to VideoProcessingService', async () => {
    service.process.mockResolvedValue('ready');

    await expect(processor.process(job(0))).resolves.toBe('ready');
    expect(service.process).toHaveBeenCalledWith('v1');
  });

  it('should not mark the video failed while retries remain', async () => {
    await processor.onFailed(job(1), new Error('storage hiccup'));

    expect(service.markFailed).not.toHaveBeenCalled();
  });

  it('should mark the video failed after the last attempt', async () => {
    await processor.onFailed(job(3), new Error('ffprobe exited with code 1'));

    expect(service.markFailed).toHaveBeenCalledWith(
      'v1',
      'ffprobe exited with code 1',
    );
  });

  it('should mark the video failed immediately on UnrecoverableError', async () => {
    await processor.onFailed(job(1), new UnrecoverableError('NO_VIDEO_STREAM'));

    expect(service.markFailed).toHaveBeenCalledWith('v1', 'NO_VIDEO_STREAM');
  });

  it('should log instead of throwing when persisting the failure fails', async () => {
    service.markFailed.mockRejectedValue(new Error('db down'));

    await expect(
      processor.onFailed(job(3), new Error('boom')),
    ).resolves.toBeUndefined();
  });
});

describe('isFinalFailure', () => {
  it('treats a job without explicit attempts as single-attempt', () => {
    expect(
      isFinalFailure({ attemptsMade: 1, opts: {} } as Job, new Error('x')),
    ).toBe(true);
  });
});
