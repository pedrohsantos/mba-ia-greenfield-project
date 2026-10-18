import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class VideoMetadataDto {
  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  formatName: string;

  @ApiProperty({ type: Number, nullable: true, example: 1500000 })
  bitRate: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  frameRate: number | null;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Unique URL identifier (11 chars, base64url)',
    example: 'dQw4w9WgXcQ',
  })
  slug: string;

  @ApiProperty({ example: 'aula-1' })
  title: string;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty({ example: 'aula-1.mp4' })
  originalFilename: string;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty({ example: 134217728 })
  sizeBytes: number;

  @ApiProperty({ type: Number, nullable: true, example: 125.375 })
  durationSeconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Short-lived presigned URL of the generated thumbnail',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'UPLOAD_ABORTED' })
  failureReason: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: string;
}
