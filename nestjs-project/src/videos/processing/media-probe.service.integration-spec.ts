import { randomBytes, randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { generateTestVideo } from '../../test/generate-test-video';
import { applyVideoTestEnv } from '../../test/video-test-env';
import { MediaProbeService } from './media-probe.service';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** Reads the width from the first SOF0/SOF2 marker of a JPEG. */
function jpegWidth(jpeg: Buffer): number {
  for (let i = 2; i < jpeg.length - 9; i++) {
    if (jpeg[i] === 0xff && (jpeg[i + 1] === 0xc0 || jpeg[i + 1] === 0xc2)) {
      return jpeg.readUInt16BE(i + 7);
    }
  }
  throw new Error('No SOF marker found');
}

describe('MediaProbeService (integration — ffmpeg + MinIO)', () => {
  let moduleRef: TestingModule;
  let probe: MediaProbeService;
  let storage: StorageService;
  let videoUrl: string;
  const keys: string[] = [];

  beforeAll(async () => {
    applyVideoTestEnv();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaProbeService],
    }).compile();
    probe = moduleRef.get(MediaProbeService);
    storage = moduleRef.get(StorageService);

    const key = `test/${randomUUID()}/original`;
    keys.push(key);
    await storage.putObject(key, await generateTestVideo(2), 'video/mp4');
    videoUrl = (await storage.presignGetObject(key, { endpoint: 'internal' }))
      .url;
  }, 60000);

  afterAll(async () => {
    for (const key of keys) {
      await storage.deleteObject(key);
    }
    await moduleRef.close();
  });

  it('probes duration and metadata straight from a presigned URL', async () => {
    const result = await probe.probe(videoUrl);

    expect(result.hasVideoStream).toBe(true);
    expect(result.durationSeconds).toBeGreaterThanOrEqual(1.9);
    expect(result.durationSeconds).toBeLessThanOrEqual(2.1);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameRate: 25,
    });
  });

  it('extracts a 1280 px wide JPEG thumbnail', async () => {
    const jpeg = await probe.extractThumbnail(videoUrl, 0.2);

    expect(jpeg.subarray(0, 3).equals(JPEG_SIGNATURE)).toBe(true);
    expect(jpegWidth(jpeg)).toBe(1280);
  });

  it('fails with the ffprobe message for a file that is not a video', async () => {
    const key = `test/${randomUUID()}/original`;
    keys.push(key);
    await storage.putObject(key, randomBytes(4096), 'video/mp4');
    const { url } = await storage.presignGetObject(key, {
      endpoint: 'internal',
    });

    await expect(probe.probe(url)).rejects.toThrow(/ffprobe exited with code/);
  });
});
