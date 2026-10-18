import { randomBytes } from 'crypto';

const SLUG_RANDOM_BYTES = 8;

/** 11-char base64url pattern of a video slug (8 random bytes = 64 bits of entropy). */
export const VIDEO_SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Short, non-enumerable unique URL identifier; uniqueness is enforced by the DB unique index. */
export function generateVideoSlug(): string {
  return randomBytes(SLUG_RANDOM_BYTES).toString('base64url');
}
