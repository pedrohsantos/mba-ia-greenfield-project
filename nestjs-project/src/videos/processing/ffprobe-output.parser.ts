import type { VideoMetadata } from '../entities/video.entity';

/** Subset of `ffprobe -print_format json -show_format -show_streams` output we rely on. */
export interface FfprobeOutput {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

export interface ProbeResult {
  durationSeconds: number | null;
  hasVideoStream: boolean;
  metadata: VideoMetadata;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ffprobe frame rates are fractions such as "30000/1001"; "0/0" means unknown. */
export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (
    !Number.isFinite(num) ||
    !Number.isFinite(den) ||
    den === 0 ||
    num === 0
  ) {
    return null;
  }
  return Math.round((num / den) * 1000) / 1000;
}

export function parseProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = output.format ?? {};

  return {
    durationSeconds: toNumber(format.duration),
    hasVideoStream: video !== undefined,
    metadata: {
      formatName: format.format_name ?? 'unknown',
      bitRate: toNumber(format.bit_rate),
      width: video?.width ?? null,
      height: video?.height ?? null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      frameRate:
        parseFrameRate(video?.avg_frame_rate) ??
        parseFrameRate(video?.r_frame_rate),
    },
  };
}
