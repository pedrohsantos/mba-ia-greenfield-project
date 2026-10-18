import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { typeOrmOptionsFactory } from './database/typeorm-options.factory';
import { QueueModule } from './queue/queue.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/**
 * Root module of the video worker process (src/worker.ts): no HTTP server,
 * only the queue consumer and what it needs (DB, storage, FFmpeg).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: typeOrmOptionsFactory,
    }),
    QueueModule,
    // Registers the User/Channel entities that Video's relations point to.
    UsersModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
