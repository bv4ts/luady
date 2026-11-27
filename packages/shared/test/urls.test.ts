import { describe, expect, it } from 'vitest';
import { HttpsUrlSchema } from '../src/urls.js';
import { NOT_HTTPS } from './helpers.js';

describe('HttpsUrlSchema', () => {
  it('accepts and keeps an https link', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';
    expect(HttpsUrlSchema.parse(url)).toBe(url);
  });

  it.each([...NOT_HTTPS, ['plain text', 'not a url'], ['a scheme only', 'https://']])('rejects %s', (_label, url) => {
    expect(HttpsUrlSchema.safeParse(url).success).toBe(false);
  });
});
