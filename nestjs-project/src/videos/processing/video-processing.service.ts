import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import { VIDEO_STORAGE_KEYS } from '../videos.constants';
import { MediaProbeService } from './media-probe.service';

export const NO_VIDEO_STREAM_REASON = 'NO_VIDEO_STREAM';
const FAILURE_REASON_MAX_LENGTH = 255;
const THUMBNAIL_POSITION_RATIO = 0.1;

export type ProcessOutcome = 'ready' | 'skipped';

/** Thumbnail frame at 10% of the duration; first frame for very short or unknown durations. */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (durationSeconds === null || durationSeconds < 1) {
    return 0;
  }
  return durationSeconds * THUMBNAIL_POSITION_RATIO;
}

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
  ) {}

  /**
   * Extracts duration/metadata and stores a thumbnail, then marks the video `ready`.
   * Idempotent: a missing video or one not in `processing` is skipped (at-least-once delivery).
   */
  async process(videoId: string): Promise<ProcessOutcome> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      return 'skipped';
    }

    // Internal endpoint: the worker reaches storage through the Compose network.
    const { url } = await this.storageService.presignGetObject(
      video.storage_key,
      { endpoint: 'internal' },
    );
    const probe = await this.mediaProbeService.probe(url);
    if (!probe.hasVideoStream) {
      throw new UnrecoverableError(NO_VIDEO_STREAM_REASON);
    }

    const thumbnail = await this.mediaProbeService.extractThumbnail(
      url,
      thumbnailTimestamp(probe.durationSeconds),
    );
    const thumbnailKey = VIDEO_STORAGE_KEYS.thumbnail(video.id);
    await this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg');

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        duration_seconds: probe.durationSeconds,
        metadata: probe.metadata,
        thumbnail_key: thumbnailKey,
        status: VideoStatus.READY,
        processed_at: new Date(),
      },
    );
    return 'ready';
  }

  /** Terminal failure: only a video still `processing` is moved to `failed`. */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        failure_reason: reason.slice(0, FAILURE_REASON_MAX_LENGTH),
        processed_at: new Date(),
      },
    );
  }
}
