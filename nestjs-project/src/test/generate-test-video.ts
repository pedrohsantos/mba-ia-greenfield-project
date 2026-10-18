import { execFile } from 'child_process';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Generates a short H.264/AAC MP4 with FFmpeg's lavfi test sources, so tests
 * exercise real media without committing binary fixtures.
 */
export async function generateTestVideo(
  durationSeconds = 2,
  size = '320x240',
): Promise<Buffer> {
  const output = join(tmpdir(), `streamtube-test-${randomUUID()}.mp4`);
  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=${size}:rate=25`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ]);
    return await readFile(output);
  } finally {
    await rm(output, { force: true });
  }
}
