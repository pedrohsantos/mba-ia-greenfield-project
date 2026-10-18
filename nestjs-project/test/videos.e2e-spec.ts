import { randomBytes } from 'crypto';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
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

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('rejects an unsupported content type with VALIDATION_ERROR', async () => {
      const res = await request(server())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ fileName: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 10 })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
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

      expect(res.body.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([2, 3]);
    });

    it('POST /videos/:id/upload/parts rejects a part above partCount', async () => {
      const init = await initiate(owner);

      const res = await request(server())
        .post(`/videos/${init.video.id}/upload/parts`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ partNumbers: [4] })
        .expect(400);

      expect(res.body.error).toBe('UPLOAD_PARTS_INVALID');
    });

    it('returns 404 VIDEO_NOT_FOUND to another user', async () => {
      const init = await initiate(owner);

      const res = await request(server())
        .get(`/videos/${init.video.id}/upload`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('rejects a non-UUID id with VALIDATION_ERROR', async () => {
      const res = await request(server())
        .get('/videos/not-a-uuid/upload')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });
});
