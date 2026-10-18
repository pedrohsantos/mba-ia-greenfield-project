import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/** Worker-side module: consumes `video.process`. Never imported by the API's AppModule. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
  ],
  providers: [MediaProbeService, VideoProcessingService, VideoProcessingProcessor],
})
export class VideoProcessingModule {}
