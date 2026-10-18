import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import queueConfig from '../config/queue.config';
import { TEST_QUEUE_PREFIX, applyVideoTestEnv } from '../test/video-test-env';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESS_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';
import type { VideoProcessJobData } from '../videos/videos.constants';
import { QueueModule } from './queue.module';

describe('QueueModule (integration — Redis)', () => {
  let moduleRef: TestingModule;
  let queue: Queue<VideoProcessJobData>;
  let redis: Redis;

  beforeAll(async () => {
    applyVideoTestEnv();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
    }).compile();
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    redis = new Redis({
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    redis.disconnect();
    await moduleRef.close();
  });

  it('stores video.process jobs under the configured prefix, retrievable by jobId', async () => {
    const videoId = randomUUID();

    await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId },
      { ...VIDEO_PROCESS_JOB_OPTIONS, jobId: videoId },
    );

    const job = await queue.getJob(videoId);
    expect(job?.name).toBe(VIDEO_PROCESS_JOB);
    expect(job?.data).toEqual({ videoId });
    expect(job?.opts.attempts).toBe(3);
    const keys = await redis.keys(
      `${TEST_QUEUE_PREFIX}:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
    );
    expect(keys).toHaveLength(1);
  });

  it('does not duplicate a job added twice with the same jobId', async () => {
    const videoId = randomUUID();
    const opts = { ...VIDEO_PROCESS_JOB_OPTIONS, jobId: videoId };

    await queue.add(VIDEO_PROCESS_JOB, { videoId }, opts);
    await queue.add(VIDEO_PROCESS_JOB, { videoId }, opts);

    await expect(queue.getJobCountByTypes('waiting')).resolves.toBe(1);
  });
});
