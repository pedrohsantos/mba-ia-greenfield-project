import { randomUUID } from 'crypto';
import { parse } from 'path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { InvalidMultipartUploadError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
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
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { generateVideoSlug } from './video-slug.util';
import { VideoStatus } from './video-status.enum';
import { VIDEO_PART_SIZE_BYTES, VIDEO_STORAGE_KEYS } from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const MAX_SLUG_ATTEMPTS = 5;
const TITLE_MAX_LENGTH = 100;

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

  private async findOwnedDraft(userId: string, videoId: string): Promise<Video> {
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
    fields: Omit<Video, 'slug' | 'created_at' | 'updated_at' | 'channel' | 'thumbnail_key' | 'duration_seconds' | 'metadata' | 'failure_reason' | 'processed_at'>,
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
