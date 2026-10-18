import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import {
  bootstrapVideosApp,
  createAuthenticatedUser,
  putPart,
} from './helpers/videos-e2e.helpers';
import type {
  AuthenticatedUser,
  VideosE2eContext,
} from './helpers/videos-e2e.helpers';

const PART_SIZE = 64 * 1024 * 1024;
const TEN_GIB = 10 * 1024 * 1024 * 1024;

function errorOf(res: request.Response): string {
  return (res.body as { error: string }).error;
}

interface InitiateBody {
  video: { id: string; slug: string; status: string; title: string };
  uploadId: string;
  partSize: number;
  partCount: number;
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

describe('Videos (e2e)', () => {
  let ctx: VideosE2eContext;
  let owner: AuthenticatedUser;
  let stranger: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await bootstrapVideosApp();
  }, 30000);

  afterAll(async () => {
    await ctx.moduleRef
      .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .obliterate({ force: true });
    await ctx.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    owner = await createAuthenticatedUser(ctx);
    stranger = await createAuthenticatedUser(ctx);
  });

  function server() {
    return ctx.app.getHttpServer();
  }

  async function initiate(
    user: AuthenticatedUser,
    body: Record<string, unknown> = {
      fileName: 'aula.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    },
  ): Promise<InitiateBody> {
    const res = await request(server())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${user.token}`)
      .send(body)
      .expect(201);
    return res.body as InitiateBody;
  }

  describe('POST /videos/uploads', () => {
    it('pre-registers a draft and returns presigned URLs for every part', async () => {
      const res = await request(server())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          fileName: 'aula.mp4',
          contentType: 'video/mp4',
          sizeBytes: 2 * PART_SIZE + 1,
        })
        .expect(201);

      const body = res.body as InitiateBody;
      expect(body.video).toMatchObject({ status: 'draft', title: 'aula' });
      expect(body.video.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(body.partSize).toBe(PART_SIZE);
      expect(body.partCount).toBe(3);
      expect(body.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      const rows = await ctx.dataSource.query<
        { status: string; channel_id: string }[]
      >(`SELECT status, channel_id FROM videos WHERE id = $1`, [body.video.id]);
      expect(rows).toEqual([{ status: 'draft', channel_id: owner.channelId }]);
    });

    it('rejects a file above 10 GiB with VALIDATION_ERROR', async () => {
      const res = await request(server())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          fileName: 'huge.mp4',
          contentType: 'video/mp4',
          sizeBytes: TEN_GIB + 1,
        })
        .expect(400);

      expect(errorOf(res)).toBe('VALIDATION_ERROR');
    });

    it('rejects an unsupported content type with VALIDATION_ERROR', async () => {
      const res = await request(server())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          fileName: 'doc.pdf',
          contentType: 'application/pdf',
          sizeBytes: 10,
        })
        .expect(400);

      expect(errorOf(res)).toBe('VALIDATION_ERROR');
    });

    it('accepts exactly 10 GiB', async () => {
      const body = await initiate(owner, {
        fileName: 'max.mp4',
        contentType: 'video/mp4',
        sizeBytes: TEN_GIB,
      });

      expect(body.partCount).toBe(160);
    });

    it('returns 401 without a token', async () => {
      await request(server())
        .post('/videos/uploads')
        .send({ fileName: 'a.mp4', contentType: 'video/mp4', sizeBytes: 1 })
        .expect(401);
    });
  });

  describe('resume endpoints', () => {
    it('GET /videos/:id/upload lists a part PUT directly to storage', async () => {
      const init = await initiate(owner);
      const etag = await putPart(init.parts[0].url, randomBytes(1024));

      const res = await request(server())
        .get(`/videos/${init.video.id}/upload`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        uploadId: init.uploadId,
        partCount: 1,
        uploadedParts: [{ partNumber: 1, etag, size: 1024 }],
      });
    });

    it('POST /videos/:id/upload/parts re-signs requested parts', async () => {
      const init = await initiate(owner, {
        fileName: 'aula.mp4',
        contentType: 'video/mp4',
        sizeBytes: 3 * PART_SIZE,
      });

      const res = await request(server())
        .post(`/videos/${init.video.id}/upload/parts`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ partNumbers: [2, 3] })
        .expect(200);

      expect((res.body as InitiateBody).parts.map((p) => p.partNumber)).toEqual(
        [2, 3],
      );
    });

    it('POST /videos/:id/upload/parts rejects a part above partCount', async () => {
      const init = await initiate(owner);

      const res = await request(server())
        .post(`/videos/${init.video.id}/upload/parts`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ partNumbers: [4] })
        .expect(400);

      expect(errorOf(res)).toBe('UPLOAD_PARTS_INVALID');
    });

    it('returns 404 VIDEO_NOT_FOUND to another user', async () => {
      const init = await initiate(owner);

      const res = await request(server())
        .get(`/videos/${init.video.id}/upload`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);

      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
    });

    it('rejects a non-UUID id with VALIDATION_ERROR', async () => {
      const res = await request(server())
        .get('/videos/not-a-uuid/upload')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(400);

      expect(errorOf(res)).toBe('VALIDATION_ERROR');
    });
  });

  describe('complete and abort', () => {
    async function uploadSinglePart(user: AuthenticatedUser) {
      const init = await initiate(user);
      const etag = await putPart(init.parts[0].url, randomBytes(1024));
      return { init, etag };
    }

    it('POST /videos/:id/upload/complete returns 202 processing with JSON only (no file bytes)', async () => {
      const { init, etag } = await uploadSinglePart(owner);

      const res = await request(server())
        .post(`/videos/${init.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(202);

      expect(res.body).toMatchObject({
        id: init.video.id,
        status: 'processing',
      });
      const job = await ctx.moduleRef
        .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
        .getJob(init.video.id);
      expect(job?.data).toEqual({ videoId: init.video.id });
    });

    it('returns 409 INVALID_VIDEO_STATUS when completing twice', async () => {
      const { init, etag } = await uploadSinglePart(owner);
      const body = { parts: [{ partNumber: 1, etag }] };
      await request(server())
        .post(`/videos/${init.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send(body)
        .expect(202);

      const res = await request(server())
        .post(`/videos/${init.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send(body)
        .expect(409);

      expect(errorOf(res)).toBe('INVALID_VIDEO_STATUS');
    });

    it('returns 400 UPLOAD_PARTS_INVALID for a tampered ETag and keeps the draft', async () => {
      const { init } = await uploadSinglePart(owner);

      const res = await request(server())
        .post(`/videos/${init.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          parts: [
            { partNumber: 1, etag: '"deadbeefdeadbeefdeadbeefdeadbeef"' },
          ],
        })
        .expect(400);

      expect(errorOf(res)).toBe('UPLOAD_PARTS_INVALID');
      const [{ status }] = await ctx.dataSource.query<{ status: string }[]>(
        `SELECT status FROM videos WHERE id = $1`,
        [init.video.id],
      );
      expect(status).toBe('draft');
    });

    it('DELETE /videos/:id/upload aborts the draft and marks it failed', async () => {
      const { init } = await uploadSinglePart(owner);

      await request(server())
        .delete(`/videos/${init.video.id}/upload`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(204);

      const [row] = await ctx.dataSource.query<
        { status: string; failure_reason: string }[]
      >(`SELECT status, failure_reason FROM videos WHERE id = $1`, [
        init.video.id,
      ]);
      expect(row).toEqual({
        status: 'failed',
        failure_reason: 'UPLOAD_ABORTED',
      });
    });

    it('returns 409 when aborting a video that is already processing', async () => {
      const { init, etag } = await uploadSinglePart(owner);
      await request(server())
        .post(`/videos/${init.video.id}/upload/complete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(202);

      const res = await request(server())
        .delete(`/videos/${init.video.id}/upload`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(409);

      expect(errorOf(res)).toBe('INVALID_VIDEO_STATUS');
    });
  });

  describe('GET /videos/:slug, /stream, /download', () => {
    it('returns the video to its owner', async () => {
      const init = await initiate(owner);

      const res = await request(server())
        .get(`/videos/${init.video.slug}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        id: init.video.id,
        slug: init.video.slug,
        status: 'draft',
        thumbnailUrl: null,
      });
    });

    it('returns 409 VIDEO_NOT_READY when streaming or downloading a draft', async () => {
      const init = await initiate(owner);

      for (const path of ['stream', 'download']) {
        const res = await request(server())
          .get(`/videos/${init.video.slug}/${path}`)
          .set('Authorization', `Bearer ${owner.token}`)
          .expect(409);
        expect(errorOf(res)).toBe('VIDEO_NOT_READY');
      }
    });

    it('returns 404 VIDEO_NOT_FOUND to another user', async () => {
      const init = await initiate(owner);

      const res = await request(server())
        .get(`/videos/${init.video.slug}/stream`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);

      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 404 VIDEO_NOT_FOUND for a malformed slug', async () => {
      const res = await request(server())
        .get('/videos/abc')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(404);

      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 401 without a token', async () => {
      const init = await initiate(owner);

      await request(server()).get(`/videos/${init.video.slug}`).expect(401);
    });
  });
});
