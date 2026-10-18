import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  INVALID_MULTIPART_ERROR_CODES,
  STORAGE_CLIENTS,
} from './storage.constants';
import { InvalidMultipartUploadError } from './storage.errors';
import type {
  CompletedPart,
  PresignedUrl,
  PresignGetOptions,
  UploadedPart,
} from './storage.types';

const MAX_PARTS_PER_LIST_PAGE = 1000;

@Injectable()
export class StorageService implements OnModuleDestroy {
  constructor(
    @Inject(STORAGE_CLIENTS.INTERNAL) private readonly internalClient: S3Client,
    @Inject(STORAGE_CLIENTS.PUBLIC) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(`Storage returned no UploadId for key ${key}`);
    }
    return UploadId;
  }

  /** Presigned UploadPart URL on the public endpoint — the client PUTs the bytes directly to storage. */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<PresignedUrl> {
    const url = await getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
    return { url, expiresAt: this.expiresAt() };
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            MaxParts: MAX_PARTS_PER_LIST_PAGE,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (err) {
      throw this.toMultipartError(err);
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      );
    } catch (err) {
      throw this.toMultipartError(err);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      throw this.toMultipartError(err);
    }
  }

  async getObjectSize(key: string): Promise<number> {
    const { ContentLength } = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return ContentLength ?? 0;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  /** Short-lived GET URL; storage serves Range requests (206) on it natively. */
  async presignGetObject(
    key: string,
    options: PresignGetOptions,
  ): Promise<PresignedUrl> {
    const client =
      options.endpoint === 'public' ? this.publicClient : this.internalClient;
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.downloadFileName
          ? contentDispositionAttachment(options.downloadFileName)
          : undefined,
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
    return { url, expiresAt: this.expiresAt() };
  }

  private expiresAt(): Date {
    return new Date(Date.now() + this.config.presignExpiresSeconds * 1000);
  }

  private toMultipartError(err: unknown): unknown {
    if (
      err instanceof S3ServiceException &&
      (INVALID_MULTIPART_ERROR_CODES as readonly string[]).includes(err.name)
    ) {
      return new InvalidMultipartUploadError(err.name, err.message);
    }
    return err;
  }
}

function contentDispositionAttachment(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
