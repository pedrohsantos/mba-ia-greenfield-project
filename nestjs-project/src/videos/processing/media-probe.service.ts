import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';
import { parseProbeOutput } from './ffprobe-output.parser';
import type { FfprobeOutput, ProbeResult } from './ffprobe-output.parser';

const THUMBNAIL_WIDTH = 1280;

interface ProcessOutput {
  stdout: Buffer;
  stderr: string;
}

function run(command: string, args: string[]): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const errText = Buffer.concat(stderr).toString('utf-8').trim();
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code}${errText ? `: ${errText}` : ''}`,
          ),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: errText });
    });
  });
}

/**
 * Thin typed wrapper over the FFmpeg binaries. Inputs are URLs (presigned GETs):
 * FFmpeg's HTTP demuxer issues range requests, so only the bytes it needs are read.
 */
@Injectable()
export class MediaProbeService {
  async probe(inputUrl: string): Promise<ProbeResult> {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputUrl,
    ]);
    return parseProbeOutput(
      JSON.parse(stdout.toString('utf-8')) as FfprobeOutput,
    );
  }

  /** Extracts one JPEG frame (1280 px wide, aspect ratio kept) at `atSeconds`. */
  async extractThumbnail(inputUrl: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      inputUrl,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMBNAIL_WIDTH}:-2`,
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (stdout.length === 0) {
      throw new Error(`ffmpeg produced no frame at ${atSeconds}s`);
    }
    return stdout;
  }
}
