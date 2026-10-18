import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  SUPPORTED_VIDEO_CONTENT_TYPES,
  VIDEO_MAX_SIZE_BYTES,
} from '../videos.constants';

export class InitiateUploadDto {
  /** Original file name, e.g. `aula-1.mp4`. */
  @IsString()
  @Length(1, 255)
  fileName: string;

  /** MIME type of the video file. */
  @IsIn(SUPPORTED_VIDEO_CONTENT_TYPES)
  contentType: string;

  /** File size in bytes — up to 10 GiB (10737418240). */
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_SIZE_BYTES)
  sizeBytes: number;

  /** Video title; defaults to the file name without extension. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}
