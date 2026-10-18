import { randomUUID } from 'crypto';
import { parse } from 'path';
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { InvalidMultipartUploadError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CompletedPartDto } from './dto/complete-upload.dto';
import type {
  DownloadUrlResponseDto,
  StreamUrlResponseDto,
} from './dto/playback-response.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type {
  InitiateUploadResponseDto,
  PresignedPartDto,
  SignedPartsResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStatusException,
  UploadPartsInvalidException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { VIDEO_SLUG_PATTERN, generateVideoSlug } from './video-slug.util';
import { VideoStatus } from './video-status.enum';
import {
  VIDEO_PART_SIZE_BYTES,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESS_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_STORAGE_KEYS,
} from './videos.constants';
import type { VideoProcessJobData } from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 5;
const TITLE_MAX_LENGTH = 100;
const UPLOAD_ABORTED_REASON = 'UPLOAD_ABORTED';
const SIZE_MISMATCH_REASON = 'UPLOAD_SIZE_MISMATCH';

function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as { code?: string; detail?: string };
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(`(${column})`)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<VideoProcessJobData>,
  ) {}

  /** Pre-registers the video as `draft` and opens a direct-to-storage multipart upload. */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const storageKey = VIDEO_STORAGE_KEYS.original(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title ?? defaultTitle(dto.fileName),
        status: VideoStatus.DRAFT,
        original_filename: dto.fileName,
        content_type: dto.contentType,
        size_bytes: dto.sizeBytes,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (err) {
      // Compensate: do not leave an orphan multipart upload behind.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    const partCount = partCountFor(video.size_bytes);
    const signed = await this.signPartRange(
      video,
      Array.from({ length: partCount }, (_, i) => i + 1),
    );

    return {
      video: await this.toResponse(video),
      uploadId,
      partSize: VIDEO_PART_SIZE_BYTES,
      partCount,
      parts: signed.parts,
      expiresAt: signed.expiresAt,
    };
  }

  /** Re-signs part URLs of an in-progress upload (expired URLs or resume). */
  async signParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<SignedPartsResponseDto> {
    const video = await this.findOwnedDraft(userId, videoId);
    const partCount = partCountFor(video.size_bytes);
    if (partNumbers.some((n) => n > partCount)) {
      throw new UploadPartsInvalidException();
    }
    return this.signPartRange(video, partNumbers);
  }

  /** Lists the parts already stored, so a client can resume an interrupted upload. */
  async getUploadStatus(
    userId: string,
    videoId: string,
  ): Promise<UploadStatusResponseDto> {
    const video = await this.findOwnedDraft(userId, videoId);
    const uploadId = video.upload_id as string;
    let uploadedParts: UploadStatusResponseDto['uploadedParts'];
    try {
      uploadedParts = await this.storageService.listParts(
        video.storage_key,
        uploadId,
      );
    } catch (err) {
      if (err instanceof InvalidMultipartUploadError) {
        throw new UploadPartsInvalidException();
      }
      throw err;
    }
    return {
      uploadId,
      partSize: VIDEO_PART_SIZE_BYTES,
      partCount: partCountFor(video.size_bytes),
      uploadedParts,
    };
  }

  /**
   * Completes the multipart upload, verifies the stored size, moves the video to
   * `processing` and only then enqueues `video.process` (status committed first).
   */
  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPartDto[],
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedDraft(userId, videoId);
    const uploadId = video.upload_id as string;

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        parts,
      );
    } catch (err) {
      if (err instanceof InvalidMultipartUploadError) {
        throw new UploadPartsInvalidException();
      }
      throw err;
    }

    const storedSize = await this.storageService.getObjectSize(
      video.storage_key,
    );
    if (storedSize !== video.size_bytes) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.update(video.id, {
        status: VideoStatus.FAILED,
        failure_reason: SIZE_MISMATCH_REASON,
        upload_id: null,
      });
      throw new UploadSizeMismatchException();
    }

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });
    await this.processingQueue.add(
      VIDEO_PROCESS_JOB,
      { videoId: video.id },
      { ...VIDEO_PROCESS_JOB_OPTIONS, jobId: video.id },
    );

    return this.toResponse(
      await this.videoRepository.findOneByOrFail({ id: video.id }),
    );
  }

  /** Aborts an in-progress upload: storage drops the parts, the video becomes `failed`. */
  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedDraft(userId, videoId);
    try {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id as string,
      );
    } catch (err) {
      // Already expired/aborted on the storage side — nothing left to free.
      if (!(err instanceof InvalidMultipartUploadError)) {
        throw err;
      }
    }
    await this.videoRepository.update(video.id, {
      status: VideoStatus.FAILED,
      failure_reason: UPLOAD_ABORTED_REASON,
      upload_id: null,
    });
  }

  /** Owner-only lookup: videos of other channels are reported as not found. */
  async findOwnedById(userId: string, videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel: { user_id: userId } },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Owner-only lookup by the unique URL slug; malformed slugs are simply not found. */
  async findOwnedBySlug(userId: string, slug: string): Promise<Video> {
    if (!VIDEO_SLUG_PATTERN.test(slug)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { slug, channel: { user_id: userId } },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getVideo(userId: string, slug: string): Promise<VideoResponseDto> {
    return this.toResponse(await this.findOwnedBySlug(userId, slug));
  }

  /** Hands off playback to storage: it serves Range requests (206) on the presigned URL. */
  async getStreamUrl(
    userId: string,
    slug: string,
  ): Promise<StreamUrlResponseDto> {
    const video = await this.findOwnedReady(userId, slug);
    const { url, expiresAt } = await this.storageService.presignGetObject(
      video.storage_key,
      { endpoint: 'public' },
    );
    return { url, expiresAt: expiresAt.toISOString() };
  }

  async getDownloadUrl(
    userId: string,
    slug: string,
  ): Promise<DownloadUrlResponseDto> {
    const video = await this.findOwnedReady(userId, slug);
    const { url, expiresAt } = await this.storageService.presignGetObject(
      video.storage_key,
      { endpoint: 'public', downloadFileName: video.original_filename },
    );
    return {
      url,
      expiresAt: expiresAt.toISOString(),
      fileName: video.original_filename,
    };
  }

  async toResponse(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl = video.thumbnail_key
      ? (
          await this.storageService.presignGetObject(video.thumbnail_key, {
            endpoint: 'public',
          })
        ).url
      : null;
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      originalFilename: video.original_filename,
      contentType: video.content_type,
      sizeBytes: video.size_bytes,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
      failureReason: video.failure_reason,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
    };
  }

  private async findOwnedReady(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwnedBySlug(userId, slug);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findOwnedDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedById(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStatusException();
    }
    return video;
  }

  private async signPartRange(
    video: Video,
    partNumbers: number[],
  ): Promise<{ parts: PresignedPartDto[]; expiresAt: string }> {
    const uploadId = video.upload_id as string;
    const signed = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        presigned: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
        ),
      })),
    );
    return {
      parts: signed.map(({ partNumber, presigned }) => ({
        partNumber,
        url: presigned.url,
      })),
      expiresAt: (signed[0]?.presigned.expiresAt ?? new Date()).toISOString(),
    };
  }

  private async insertWithUniqueSlug(
    fields: Omit<
      Video,
      | 'slug'
      | 'created_at'
      | 'updated_at'
      | 'channel'
      | 'thumbnail_key'
      | 'duration_seconds'
      | 'metadata'
      | 'failure_reason'
      | 'processed_at'
    >,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, slug: generateVideoSlug() }),
        );
      } catch (err) {
        if (
          !isUniqueViolationOn(err, SLUG_COLUMN) ||
          attempt >= MAX_SLUG_ATTEMPTS
        ) {
          throw err;
        }
      }
    }
  }
}

function partCountFor(sizeBytes: number): number {
  return Math.ceil(sizeBytes / VIDEO_PART_SIZE_BYTES);
}

function defaultTitle(fileName: string): string {
  const base = parse(fileName).name.trim() || fileName;
  return base.slice(0, TITLE_MAX_LENGTH);
}
