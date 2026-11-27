import { describe, expect, it, vi } from 'vitest';
import { FetchRefused, PAGE_SCAN_MAX, fetchImageUrl, isBlockedAddress, pageImageUrl, type RawResponse } from '../../src/media/safe-fetch.js';
import { HOSTILE_INPUT_BUDGET_MS, elapsedMs } from '../helpers/timing.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function response(status: number, headers: Record<string, string>, body: Buffer | string = ''): RawResponse {
  const data = Buffer.from(body);
  return {
    status, headers,
    body: (async function* chunks() {
      yield data;
    })(),
    close: () => undefined,
  };
}

type Route = (url: URL) => RawResponse;

function fakeNet(dns: Record<string, string[]>, route: Route) {
  const resolve = vi.fn(async (host: string) => dns[host] ?? []);
  const request = vi.fn(async (url: URL, _address: string) => route(url));
  return { resolve, request };
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:c0a8:0101::1', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:93.184.216.34'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('pageImageUrl', () => {
  it('takes the first og:image / twitter:image / image_src, resolved against the page', () => {
    expect(pageImageUrl('<meta content="/img/a.png?x=1&amp;y=2" property="og:image">', 'https://site.test/p/q')).toBe('https://site.test/img/a.png?x=1&y=2');
    expect(pageImageUrl("<meta name='twitter:image' content='https://cdn.test/t.jpg'><meta property='og:image' content='b.png'>", 'https://s.test/')).toBe('https://cdn.test/t.jpg');
    expect(pageImageUrl('<link rel="image_src" href="//cdn.test/c.webp">', 'https://s.test/')).toBe('https://cdn.test/c.webp');
    expect(pageImageUrl('<meta property="og:title" content="x">', 'https://s.test/')).toBeNull();
  });

  it('reads only the start of a page and handles 2 MB of unclosed <meta tags well under a second', () => {
    const hostile = '<meta'.repeat(400_000);
    expect(elapsedMs(() => pageImageUrl(hostile, 'https://s.test/'))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
    expect(elapsedMs(() => pageImageUrl(`<meta property="og:image" content="${'x'.repeat(2_000_000)}`, 'https://s.test/'))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
    const late = `${' '.repeat(PAGE_SCAN_MAX)}<meta property="og:image" content="/late.png">`;
    expect(pageImageUrl(late, 'https://s.test/')).toBeNull();
  });
});

describe('fetchImageUrl', () => {
  it('downloads an image from a public host, connecting to the vetted address', async () => {
    const net = fakeNet({ 'cdn.test': ['93.184.216.34'] }, () => response(200, { 'content-type': 'image/png' }, PNG));
    expect(await fetchImageUrl('https://cdn.test/a.png', net)).toEqual(PNG);
    expect(net.request.mock.calls[0]?.[1]).toBe('93.184.216.34');
  });

  it('refuses hosts that resolve to a private address, and IP literals', async () => {
    const net = fakeNet({ 'evil.test': ['93.184.216.34', '10.0.0.5'] }, () => response(200, {}, PNG));
    await expect(fetchImageUrl('https://evil.test/a.png', net)).rejects.toBeInstanceOf(FetchRefused);
    await expect(fetchImageUrl('http://169.254.169.254/latest/meta-data', net)).rejects.toThrow(/private or local/);
    await expect(fetchImageUrl('http://[::ffff:127.0.0.1]/', net)).rejects.toThrow(/private or local/);
    expect(net.request).not.toHaveBeenCalled();
  });

  it('re-checks every redirect and refuses one to a private address', async () => {
    const net = fakeNet({ 'a.test': ['93.184.216.34'], 'inner.test': ['192.168.0.10'] }, (url) => (url.hostname === 'a.test'
      ? response(302, { location: 'http://inner.test/admin.png' })
      : response(200, { 'content-type': 'image/png' }, PNG)));
    await expect(fetchImageUrl('https://a.test/x', net)).rejects.toThrow(/inner.test is a private or local address/);
    expect(net.request).toHaveBeenCalledTimes(1);
  });

  it('follows at most 3 redirects', async () => {
    const net = fakeNet({ 'a.test': ['93.184.216.34'] }, (url) => response(301, { location: `/r${url.pathname.length}` }));
    await expect(fetchImageUrl('https://a.test/', net)).rejects.toThrow('too many redirects');
    expect(net.request).toHaveBeenCalledTimes(4);
  });

  it("uses a page's og:image, with the same checks", async () => {
    const html = '<html><head><meta property="og:image" content="https://img.test/big.png"></head></html>';
    const net = fakeNet({ 'page.test': ['93.184.216.34'], 'img.test': ['8.8.8.8'] }, (url) => (url.hostname === 'page.test'
      ? response(200, { 'content-type': 'text/html; charset=utf-8' }, html)
      : response(200, { 'content-type': 'image/png' }, PNG)));
    expect(await fetchImageUrl('https://page.test/post/1', net)).toEqual(PNG);
    const privatePage = fakeNet({ 'page.test': ['93.184.216.34'], 'img.test': ['127.0.0.1'] }, () => response(200, { 'content-type': 'text/html' }, html));
    await expect(fetchImageUrl('https://page.test/post/1', privatePage)).rejects.toBeInstanceOf(FetchRefused);
  });

  it('reads only the head of a page bigger than 2 MB instead of failing', async () => {
    const html = `<html><head><meta property="og:image" content="https://img.test/a.png"></head><body>${'x'.repeat(3 * 1024 * 1024)}</body></html>`;
    const net = fakeNet({ 'page.test': ['93.184.216.34'], 'img.test': ['8.8.8.8'] }, (url) => (url.hostname === 'page.test'
      ? response(200, { 'content-type': 'text/html', 'content-length': String(html.length) }, html)
      : response(200, { 'content-type': 'image/png' }, PNG)));
    expect(await fetchImageUrl('https://page.test/shop/item', net)).toEqual(PNG);
  });

  it('fails clearly for pages without a picture, HTTP errors, oversize bodies and other schemes', async () => {
    const page = fakeNet({ 'p.test': ['8.8.8.8'] }, () => response(200, { 'content-type': 'text/html' }, '<p>hi</p>'));
    await expect(fetchImageUrl('https://p.test/', page)).rejects.toThrow('the page has no og:image picture');
    const missing = fakeNet({ 'p.test': ['8.8.8.8'] }, () => response(404, {}));
    await expect(fetchImageUrl('https://p.test/', missing)).rejects.toThrow('HTTP 404');
    const huge = fakeNet({ 'p.test': ['8.8.8.8'] }, () => response(200, { 'content-length': String(21 * 1024 * 1024) }));
    await expect(fetchImageUrl('https://p.test/', huge)).rejects.toThrow('bigger than 20 MB');
    await expect(fetchImageUrl('ftp://p.test/a.png', page)).rejects.toThrow('only http and https');
  });

  it('gives up after the time limit', async () => {
    const net = {
      resolve: async () => ['8.8.8.8'],
      request: (_url: URL, _address: string, signal: AbortSignal) => new Promise<RawResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      timeoutMs: 20,
    };
    await expect(fetchImageUrl('https://slow.test/a.png', net)).rejects.toThrow('longer than 20 s');
  });
});
