import { describe, expect, it } from 'vitest';
import { canonicalUrl } from '../../src/pipeline/crawler.js';

describe('canonicalUrl', () => {
  it('canonicalizes the www and bare-domain forms of the same page identically', () => {
    const base = 'https://muscalaw.com/';
    expect(canonicalUrl('https://www.muscalaw.com/', base)).toBe('https://muscalaw.com/');
    expect(canonicalUrl('https://muscalaw.com/', base)).toBe('https://muscalaw.com/');
  });

  it('still rejects a link to a different domain', () => {
    expect(canonicalUrl('https://other.example/', 'https://muscalaw.com/')).toBeNull();
  });

  it('strips the hash and query string as before', () => {
    expect(canonicalUrl('https://muscalaw.com/about?x=1#team', 'https://muscalaw.com/')).toBe('https://muscalaw.com/about');
  });
});
