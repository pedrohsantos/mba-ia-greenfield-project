import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import {
  InitiateUploadResponseDto,
  SignedPartsResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-response.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as draft in the caller channel, opens a multipart upload in object storage and returns presigned URLs to PUT each part directly to storage (no file bytes go through the API).',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload started',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (size above 10 GiB, unsupported type…)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Channel not found (CHANNEL_NOT_FOUND)',
    schema: errorSchema,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-sign part upload URLs',
    description:
      'Returns fresh presigned URLs for the given parts of an in-progress upload (expired URLs or resume).',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: SignedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATUS)',
    schema: errorSchema,
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignPartsDto,
  ): Promise<SignedPartsResponseDto> {
    return this.videosService.signParts(user.sub, id, dto.partNumbers);
  }

  @Get(':id/upload')
  @ApiOperation({
    summary: 'Get upload progress',
    description:
      'Lists the parts already stored for an in-progress upload, so the client can resume it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload progress',
    type: UploadStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATUS)',
    schema: errorSchema,
  })
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadStatusResponseDto> {
    return this.videosService.getUploadStatus(user.sub, id);
  }
}
