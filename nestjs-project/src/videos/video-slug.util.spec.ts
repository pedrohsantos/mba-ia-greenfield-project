import { VIDEO_SLUG_PATTERN, generateVideoSlug } from './video-slug.util';

describe('generateVideoSlug', () => {
  it('should produce an 11-char base64url slug', () => {
    const slug = generateVideoSlug();

    expect(slug).toHaveLength(11);
    expect(slug).toMatch(VIDEO_SLUG_PATTERN);
  });

  it('should produce distinct slugs across calls', () => {
    const slugs = new Set(Array.from({ length: 1000 }, generateVideoSlug));

    expect(slugs.size).toBe(1000);
  });
});
