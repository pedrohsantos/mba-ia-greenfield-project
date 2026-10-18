import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { applyVideoTestEnv } from '../test/video-test-env';
import { InvalidMultipartUploadError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

describe('StorageService (integration — MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    applyVideoTestEnv();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await moduleRef.close();
  });

  function newKey(): string {
    const key = `test/${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  }

  async function putPart(url: string, body: Buffer): Promise<string> {
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  it('uploads parts directly to storage through presigned URLs and completes the object', async () => {
    const key = newKey();
    const part1 = randomBytes(FIVE_MIB);
    const part2 = randomBytes(1024);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const url1 = await storage.presignUploadPart(key, uploadId, 1);
    const url2 = await storage.presignUploadPart(key, uploadId, 2);
    const etag1 = await putPart(url1.url, part1);
    const etag2 = await putPart(url2.url, part2);

    const listed = await storage.listParts(key, uploadId);
    expect(listed).toEqual([
      { partNumber: 1, etag: etag1, size: FIVE_MIB },
      { partNumber: 2, etag: etag2, size: 1024 },
    ]);

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    await expect(storage.getObjectSize(key)).resolves.toBe(FIVE_MIB + 1024);
    expect(url1.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('serves byte ranges (206) on a presigned GET URL', async () => {
    const key = newKey();
    const content = randomBytes(4096);
    await storage.putObject(key, content, 'video/mp4');

    const { url } = await storage.presignGetObject(key, {
      endpoint: 'public',
    });
    const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/4096');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(content.subarray(0, 100))).toBe(true);
  });

  it('forces an attachment download when downloadFileName is set', async () => {
    const key = newKey();
    await storage.putObject(key, randomBytes(16), 'video/mp4');

    const { url } = await storage.presignGetObject(key, {
      endpoint: 'public',
      downloadFileName: 'minha aula.mp4',
    });
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(
      'attachment; filename="minha aula.mp4"',
    );
  });

  it('rejects completion with an invalid ETag and does not create the object', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { url } = await storage.presignUploadPart(key, uploadId, 1);
    await putPart(url, randomBytes(1024));

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(InvalidMultipartUploadError);
    await expect(storage.getObjectSize(key)).rejects.toThrow();

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('aborts a multipart upload so its parts can no longer be listed', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { url } = await storage.presignUploadPart(key, uploadId, 1);
    await putPart(url, randomBytes(1024));

    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      InvalidMultipartUploadError,
    );
  });
});
