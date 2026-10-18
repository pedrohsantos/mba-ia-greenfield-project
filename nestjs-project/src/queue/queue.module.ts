import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';

/** Shared BullMQ (Redis) connection — imported by both the API (AppModule) and the worker (WorkerModule). */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.redisHost, port: config.redisPort },
        prefix: config.prefix,
      }),
    }),
  ],
})
export class QueueModule {}
