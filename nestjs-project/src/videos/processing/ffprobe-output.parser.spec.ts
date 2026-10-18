import { parseFrameRate, parseProbeOutput } from './ffprobe-output.parser';

describe('parseProbeOutput', () => {
  it('should extract duration and metadata from a video with audio', () => {
    const result = parseProbeOutput({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30000/1001',
        },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '125.375000',
        bit_rate: '1500000',
      },
    });

    expect(result).toEqual({
      durationSeconds: 125.375,
      hasVideoStream: true,
      metadata: {
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitRate: 1500000,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        frameRate: 29.97,
      },
    });
  });

  it('should report a null audio codec for a video-only file', () => {
    const result = parseProbeOutput({
      streams: [{ codec_type: 'video', codec_name: 'vp9', r_frame_rate: '25/1' }],
      format: { format_name: 'webm', duration: '2.0' },
    });

    expect(result.metadata.audioCodec).toBeNull();
    expect(result.metadata.frameRate).toBe(25);
  });

  it('should flag files without a video stream', () => {
    const result = parseProbeOutput({
      streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
      format: { format_name: 'mp3', duration: '3.5' },
    });

    expect(result.hasVideoStream).toBe(false);
    expect(result.metadata.width).toBeNull();
  });

  it('should return null duration and bit rate when ffprobe omits them', () => {
    const result = parseProbeOutput({
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      format: { format_name: 'matroska,webm' },
    });

    expect(result.durationSeconds).toBeNull();
    expect(result.metadata.bitRate).toBeNull();
  });
});

describe('parseFrameRate', () => {
  it.each([
    ['30000/1001', 29.97],
    ['25/1', 25],
    ['0/0', null],
    [undefined, null],
  ])('should parse %s as %s', (input, expected) => {
    expect(parseFrameRate(input)).toBe(expected);
  });
});
