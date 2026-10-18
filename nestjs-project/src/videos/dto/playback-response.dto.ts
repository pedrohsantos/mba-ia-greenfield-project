import { ApiProperty } from '@nestjs/swagger';

export class StreamUrlResponseDto {
  @ApiProperty({
    description:
      'Short-lived presigned GET URL; storage answers Range requests with 206 Partial Content',
  })
  url: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: string;
}

export class DownloadUrlResponseDto {
  @ApiProperty({
    description:
      'Short-lived presigned GET URL served with Content-Disposition: attachment',
  })
  url: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ example: 'aula-1.mp4' })
  fileName: string;
}
