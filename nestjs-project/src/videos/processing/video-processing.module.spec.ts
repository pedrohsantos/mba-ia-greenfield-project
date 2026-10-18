import { Test } from '@nestjs/testing';
import { applyVideoTestEnv } from '../../test/video-test-env';
import { WorkerModule } from '../../worker.module';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingModule / WorkerModule', () => {
  it('should compile the worker root module with the processor wired', async () => {
    applyVideoTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(moduleRef.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await moduleRef.close();
  }, 30000);
});
