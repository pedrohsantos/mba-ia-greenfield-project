export const TEST_QUEUE_PREFIX = 'streamtube-test';

/**
 * Tests run inside the Compose network, where the host-facing public endpoint
 * (http://localhost:9000) is not reachable. Presigned URLs are signed for the
 * internal endpoint instead, and queue keys use an isolated prefix so the
 * always-on `video-worker` container never consumes test jobs.
 * Must run before the Nest testing module is compiled (config factories read process.env).
 */
export function applyVideoTestEnv(): void {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio:9000';
  process.env.QUEUE_PREFIX = TEST_QUEUE_PREFIX;
}
