import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateTestVideo } from '../src/test/generate-test-video';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import { WorkerModule } from '../src/worker.module';
import {
  bootstrapVideosApp,
  createAuthenticatedUser,
  putPart,
} from './helpers/videos-e2e.helpers';
import type {
  AuthenticatedUser,
  VideosE2eContext,
} from './helpers/videos-e2e.helpers';

interface VideoBody {
  id: string;
  slug: string;
  status: 'draft' | 'processing' | 'ready' | 'failed';
  durationSeconds: number | null;
  metadata: { width: number | null; height: number | null } | null;
  thumbnailUrl: string | null;
  failureReason: string | null;
  originalFilename: string;
}

const FLOW_TIMEOUT = 120_000;

/**
 * Upload → queue → worker → streaming, against the real Compose services.
 * The worker runs in-process with the test queue prefix (applyVideoTestEnv),
 * so the always-on `video-worker` container never picks these jobs up.
 */
describe('Video upload → processing → streaming flow (e2e)', () => {
  let ctx: VideosE2eContext;
  let worker: INestApplicationContext;
  let user: AuthenticatedUser;
  let sampleVideo: Buffer;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    sampleVideo = await generateTestVideo(2);
  }, 60_000);

  afterAll(async () => {
    await ctx.moduleRef
      .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .obliterate({ force: true });
    await worker.close();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    user = await createAuthenticatedUser(ctx);
  });

  function server() {
    return ctx.app.getHttpServer();
  }

  async function uploadAndComplete(
    content: Buffer,
    fileName: string,
  ): Promise<VideoBody> {
    const init = await request(server())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ fileName, contentType: 'video/mp4', sizeBytes: content.length })
      .expect(201);
    const body = init.body as {
      video: VideoBody;
      partSize: number;
      parts: { partNumber: number; url: string }[];
    };
    const parts: { partNumber: number; etag: string }[] = [];
    for (const part of body.parts) {
      const start = (part.partNumber - 1) * body.partSize;
      const chunk = content.subarray(start, start + body.partSize);
      parts.push({
        partNumber: part.partNumber,
        etag: await putPart(part.url, chunk),
      });
    }
    await request(server())
      .post(`/videos/${body.video.id}/upload/complete`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ parts })
      .expect(202);
    return body.video;
  }

  async function waitForTerminalStatus(slug: string): Promise<VideoBody> {
    const deadline = Date.now() + FLOW_TIMEOUT - 10_000;
    while (Date.now() < deadline) {
      const res = await request(server())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);
      const body = res.body as VideoBody;
      if (body.status === 'ready' || body.status === 'failed') {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`video ${slug} did not reach a terminal status in time`);
  }

  it(
    'processes an uploaded video automatically and serves streaming (206) and download',
    async () => {
      const uploaded = await uploadAndComplete(
        sampleVideo,
        'aula de teste.mp4',
      );

      const video = await waitForTerminalStatus(uploaded.slug);

      expect(video.status).toBe('ready');
      expect(video.durationSeconds).toBeGreaterThan(1.9);
      expect(video.metadata).toMatchObject({ width: 320, height: 240 });
      expect(video.thumbnailUrl).not.toBeNull();

      const stream = await request(server())
        .get(`/videos/${video.slug}/stream`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);
      const partial = await fetch((stream.body as { url: string }).url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(
        `bytes 0-1023/${sampleVideo.length}`,
      );
      expect((await partial.arrayBuffer()).byteLength).toBe(1024);

      const download = await request(server())
        .get(`/videos/${video.slug}/download`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);
      const downloadBody = download.body as { url: string; fileName: string };
      expect(downloadBody.fileName).toBe('aula de teste.mp4');
      const file = await fetch(downloadBody.url);
      expect(file.headers.get('content-disposition')).toContain(
        'attachment; filename="aula de teste.mp4"',
      );
      expect((await file.arrayBuffer()).byteLength).toBe(sampleVideo.length);

      const thumb = await fetch(video.thumbnailUrl!);
      expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    },
    FLOW_TIMEOUT,
  );

  it(
    'gives each uploaded video a distinct unique slug',
    async () => {
      const first = await uploadAndComplete(sampleVideo, 'a.mp4');
      const second = await uploadAndComplete(sampleVideo, 'b.mp4');

      expect(first.slug).not.toBe(second.slug);
      await waitForTerminalStatus(first.slug);
      await waitForTerminalStatus(second.slug);
    },
    FLOW_TIMEOUT,
  );

  it(
    'marks a file that is not a video as failed with a reason',
    async () => {
      const uploaded = await uploadAndComplete(randomBytes(8192), 'fake.mp4');

      const video = await waitForTerminalStatus(uploaded.slug);

      expect(video.status).toBe('failed');
      expect(video.failureReason).toBeTruthy();
    },
    FLOW_TIMEOUT,
  );
});
