import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class PresignedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    description: 'Presigned UploadPart URL — PUT the part bytes here',
  })
  url: string;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ description: 'Multipart upload id' })
  uploadId: string;

  @ApiProperty({ example: 67108864 })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: string;
}

export class SignedPartsResponseDto {
  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: string;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: '"5d41402abc4b2a76b9719d911017c592"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size: number;
}

export class UploadStatusResponseDto {
  @ApiProperty()
  uploadId: string;

  @ApiProperty({ example: 67108864 })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;

  @ApiProperty({ type: [UploadedPartDto] })
  uploadedParts: UploadedPartDto[];
}
