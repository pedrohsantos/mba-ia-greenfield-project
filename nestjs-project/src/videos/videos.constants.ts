import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'video.process';

/** Payload of the `video.process` job (see Events/Messages in the phase plan). */
export interface VideoProcessJobData {
  videoId: string;
}

export const VIDEO_PROCESS_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 604800 },
} as const satisfies JobsOptions;

/** Fixed multipart part size: 10 GiB / 64 MiB = 160 parts, within S3's 5 MiB–5 GiB / 10,000-part limits. */
export const VIDEO_PART_SIZE_BYTES = 64 * 1024 * 1024;
export const VIDEO_MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const SUPPORTED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export const VIDEO_STORAGE_KEYS = {
  original: (videoId: string) => `videos/${videoId}/original`,
  thumbnail: (videoId: string) => `thumbnails/${videoId}.jpg`,
} as const;
