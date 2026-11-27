import { describe, expect, it } from 'vitest';
import { bundleMessages } from '../../src/luady/bundle.js';

describe('bundleMessages', () => {
  it('numbers messages sent together so Luady handles every one; one message passes as is', () => {
    expect(bundleMessages(['only one'])).toBe('only one');
    expect(bundleMessages(['fix those:', '[Attached image "a.jpg"]\n(Reply to your message)', 'and deploy'])).toBe([
      '3 messages, handle every one:', '1) fix those:', '2) [Attached image "a.jpg"]', '   (Reply to your message)', '3) and deploy',
    ].join('\n'));
  });
});
