import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { createTestDataSource } from '../test/create-test-data-source';
import { applyVideoTestEnv } from '../test/video-test-env';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with TypeORM and the video-processing queue registered', async () => {
    applyVideoTestEnv();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        QueueModule,
        VideosModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
    await module.close();
  }, 30000);
});
