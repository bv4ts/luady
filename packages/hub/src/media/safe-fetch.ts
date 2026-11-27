import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_MAX_BYTES = 20 * 1024 * 1024;
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** One response, no redirects followed. Header names are lower case. */
export interface RawResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Stops reading the body (the connection is dropped). */
  close(): void;
}

export interface SafeFetchDeps {
  /** Every address a host name resolves to. */
  resolve?: (host: string) => Promise<string[]>;
  /** One GET of `url` connected to `address` (already vetted), never re-resolving the name. */
  request?: (url: URL, address: string, signal: AbortSignal) => Promise<RawResponse>;
  timeoutMs?: number;
}

export class FetchRefused extends Error {}

const V4_BLOCKED: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function v4Blocked(value: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** 8 groups of 16 bits; an embedded dotted IPv4 tail becomes the last two. */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase().split('%')[0] ?? '';
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const v4 = v4ToInt(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const middle = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...middle, ...right].map((group) => parseInt(group, 16));
}

/** Loopback, private, link-local (cloud metadata), CGNAT, multicast, unspecified and their IPv6/IPv4-mapped forms. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Blocked(v4ToInt(ip));
  if (family !== 6) return true;
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((part) => Number.isNaN(part))) return true;
  const embedded = (g[6]! << 16 >>> 0) + g[7]!;
  const zeroPrefix = g.slice(0, 5).every((part) => part === 0);
  if (zeroPrefix && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && embedded <= 1 ? true : v4Blocked(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Blocked(embedded);
  if (g[0] === 0x2002) return v4Blocked((g[1]! << 16 >>> 0) + g[2]!);
  const first = g[0]!;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** Connects to the vetted address only: the socket's name lookup always answers with it. */
const defaultRequest = (url: URL, address: string, signal: AbortSignal): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const family = isIP(address);
    const pinned = ((_host, opts, callback) => {
      if ((opts as { all?: boolean }).all === true) (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
      else callback(null, address, family);
    }) as LookupFunction;
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, {
      method: 'GET', lookup: pinned, signal,
      headers: { 'user-agent': BROWSER_UA, accept: 'image/avif,image/webp,image/png,image/jpeg,text/html;q=0.9,*/*;q=0.5' },
    }, (res: IncomingMessage) => {
      const headers = Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
      resolve({ status: res.statusCode ?? 0, headers, body: res, close: () => res.destroy() });
    });
    req.on('error', reject);
    req.end();
  });

async function vettedAddress(url: URL, resolve: (host: string) => Promise<string[]>): Promise<string> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchRefused('only http and https links work');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) !== 0 ? [host] : await resolve(host).catch(() => {
    throw new Error(`${host} could not be found`);
  });
  if (addresses.length === 0) throw new Error(`${host} could not be found`);
  if (addresses.some(isBlockedAddress)) throw new FetchRefused(`${host} is a private or local address`);
  return addresses[0]!;
}

/** Reads at most `max` bytes; past that it fails with `tooBig`, or (tooBig null) keeps only the first `max` bytes. */
async function readCapped(res: RawResponse, max: number, tooBig: string | null): Promise<Buffer> {
  const declared = Number(res.headers['content-length'] ?? '0');
  if (tooBig !== null && declared > max) {
    res.close();
    throw new Error(tooBig);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    const piece = Buffer.from(chunk);
    if (size + piece.length > max) {
      res.close();
      if (tooBig !== null) throw new Error(tooBig);
      chunks.push(piece.subarray(0, max - size));
      break;
    }
    size += piece.length;
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#x2F;': '/', '&#47;': '/' };
const IMAGE_KEYS = new Set(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : value.replace(/&[#\w]+;/g, (entity) => ENTITIES[entity] ?? entity).trim();
}

/** The image tags sit in the page's head: nothing past this many characters is searched. */
export const PAGE_SCAN_MAX = 256 * 1024;
/** `[^<>]*` stops at the next `<`, so a page full of unclosed tags costs one short run per tag, never a rescan. */
const HEAD_TAG_RE = /<(?:meta|link)\b[^<>]*>/gi;

/** The first og:image / twitter:image / link rel=image_src of a page, resolved against the page URL. */
export function pageImageUrl(html: string, pageUrl: string): string | null {
  for (const [tag] of html.slice(0, PAGE_SCAN_MAX).matchAll(HEAD_TAG_RE)) {
    const isLink = /^<link/i.test(tag);
    const key = (isLink ? attr(tag, 'rel') : attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase() ?? '';
    const value = isLink ? (key === 'image_src' ? attr(tag, 'href') : null) : (IMAGE_KEYS.has(key) ? attr(tag, 'content') : null);
    if (value === null || value === '') continue;
    try {
      return new URL(value, pageUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

interface Hop { res: RawResponse; url: URL; }

/** GET with manual redirects (max 3), every hop's address checked before connecting. */
async function getChecked(start: URL, deps: Required<Pick<SafeFetchDeps, 'resolve' | 'request'>>, signal: AbortSignal): Promise<Hop> {
  let url = start;
  for (let hop = 0; ; hop += 1) {
    const address = await vettedAddress(url, deps.resolve);
    const res = await deps.request(url, address, signal);
    const location = res.headers.location;
    if (res.status < 300 || res.status >= 400 || location === undefined) return { res, url };
    res.close();
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    url = new URL(location, url);
  }
}

const isHtml = (type: string | undefined): boolean => /^\s*(text\/html|application\/xhtml\+xml)/i.test(type ?? '');

/** Downloads an image link, or the og:image of a page link, refusing anything that reaches a private/local address. */
export async function fetchImageUrl(link: string, deps: SafeFetchDeps = {}): Promise<Buffer> {
  const used = { resolve: deps.resolve ?? defaultResolve, request: deps.request ?? defaultRequest };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    let url = new URL(link);
    for (let page = 0; ; page += 1) {
      const { res, url: finalUrl } = await getChecked(url, used, controller.signal);
      if (res.status < 200 || res.status >= 300) {
        res.close();
        throw new Error(`the link answered HTTP ${res.status}`);
      }
      if (!isHtml(res.headers['content-type'])) return await readCapped(res, FETCH_MAX_BYTES, 'the image is bigger than 20 MB');
      if (page > 0) throw new Error('the page image link is another page');
      // og:image lives in <head>: the first 2 MB of a big page is enough.
      const html = (await readCapped(res, PAGE_MAX_BYTES, null)).toString('utf8');
      const image = pageImageUrl(html, finalUrl.toString());
      if (image === null) throw new Error('the page has no og:image picture');
      url = new URL(image);
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error('the download took longer than 20 s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
