import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import type { VideoProcessJobData } from '../videos.constants';
import { VideoProcessingService } from './video-processing.service';
import type { ProcessOutcome } from './video-processing.service';

/** True when BullMQ will not retry the job anymore. */
export function isFinalFailure(
  job: Pick<Job, 'attemptsMade' | 'opts'>,
  error: Error,
): boolean {
  if (
    error instanceof UnrecoverableError ||
    error.name === 'UnrecoverableError'
  ) {
    return true;
  }
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/** Consumer of `video.process` — registered only in the worker process (WorkerModule). */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<ProcessOutcome> {
    const outcome = await this.videoProcessingService.process(job.data.videoId);
    this.logger.log(`video ${job.data.videoId}: ${outcome}`);
    return outcome;
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }
    if (!isFinalFailure(job, error)) {
      this.logger.warn(
        `video ${job.data.videoId}: attempt ${job.attemptsMade} failed (${error.message}); retrying`,
      );
      return;
    }
    try {
      await this.videoProcessingService.markFailed(
        job.data.videoId,
        error.message,
      );
      this.logger.error(`video ${job.data.videoId}: failed (${error.message})`);
    } catch (err) {
      // Background event handler: rethrowing would only crash the worker.
      this.logger.error(
        `video ${job.data.videoId}: could not persist failure`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
