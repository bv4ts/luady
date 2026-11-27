import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, RefusedError, ValidationError } from '../../src/core/errors.js';
import { classifyReference, materialiseReference, sniffImage, type RefDirs } from '../../src/media/image-refs.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0]);
const WEBP = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');

let root: string;
let dirs: RefDirs;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'luady-refs-')));
  dirs = { inboxDir: join(root, 'inbox'), imagesDir: join(root, 'inbox', 'images'), hasServer: (id) => ['cedar', 'birch', 'ash', 'local'].includes(id) };
  mkdirSync(join(dirs.imagesDir, 'img-1a2b3c4d'), { recursive: true });
  writeFileSync(join(dirs.imagesDir, 'img-1a2b3c4d', 'image-1.png'), PNG);
  writeFileSync(join(dirs.imagesDir, 'img-1a2b3c4d', 'image-2.png'), PNG);
  writeFileSync(join(dirs.inboxDir, 'photo.jpg'), JPG);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('classifyReference', () => {
  it('accepts inbox files, earlier image ids, server paths and links', () => {
    expect(classifyReference(join(dirs.inboxDir, 'photo.jpg'), dirs)).toEqual({ kind: 'file', path: join(dirs.inboxDir, 'photo.jpg') });
    expect(classifyReference('img-1a2b3c4d', dirs)).toEqual({ kind: 'file', path: join(dirs.imagesDir, 'img-1a2b3c4d', 'image-1.png') });
    expect(classifyReference('img-1a2b3c4d#2', dirs)).toEqual({ kind: 'file', path: join(dirs.imagesDir, 'img-1a2b3c4d', 'image-2.png') });
    expect(classifyReference('ash:/home/dev/p/logo.png', dirs)).toEqual({ kind: 'server', server: 'ash', path: '/home/dev/p/logo.png' });
    expect(classifyReference('local:/tmp/a.webp', dirs)).toEqual({ kind: 'server', server: 'local', path: '/tmp/a.webp' });
    expect(classifyReference('https://example.com/a b.png', dirs)).toEqual({ kind: 'url', url: 'https://example.com/a%20b.png' });
  });

  it('refuses inbox escapes, symlinks out of the inbox and missing files', () => {
    writeFileSync(join(root, 'secret.png'), PNG);
    expect(() => classifyReference(join(root, 'secret.png'), dirs)).toThrow(RefusedError);
    expect(() => classifyReference(join(dirs.inboxDir, '..', 'secret.png'), dirs)).toThrow(RefusedError);
    mkdirSync(join(root, 'out'));
    writeFileSync(join(root, 'out', 'x.png'), PNG);
    symlinkSync(join(root, 'out'), join(dirs.inboxDir, 'link'), 'junction');
    expect(() => classifyReference(join(dirs.inboxDir, 'link', 'x.png'), dirs)).toThrow(RefusedError);
    expect(() => classifyReference(join(dirs.inboxDir, 'nope.png'), dirs)).toThrow(NotFoundError);
  });

  it('refuses unknown ids and missing image numbers', () => {
    expect(() => classifyReference('img-deadbeef', dirs)).toThrow(NotFoundError);
    expect(() => classifyReference('img-1a2b3c4d#3', dirs)).toThrow(/has only 2 picture/);
  });

  it('refuses unknown servers, relative paths and protected paths', () => {
    expect(() => classifyReference('prod:/a.png', dirs)).toThrow(ValidationError);
    expect(() => classifyReference('cedar:home/a.png', dirs)).toThrow(ValidationError);
    expect(() => classifyReference('cedar:/root/.ssh/id_ed25519', dirs)).toThrow(RefusedError);
    expect(() => classifyReference('birch:/home/dev/.claude/.credentials.json', dirs)).toThrow(RefusedError);
  });

  it('refuses malformed and non-http links and unknown forms', () => {
    expect(() => classifyReference('https://', dirs)).toThrow(ValidationError);
    expect(() => classifyReference('ftp://example.com/a.png', dirs)).toThrow(ValidationError);
    expect(() => classifyReference('file:///etc/passwd', dirs)).toThrow(ValidationError);
    expect(() => classifyReference('https://user:pw@example.com/a.png', dirs)).toThrow(ValidationError);
    expect(() => classifyReference('photo.jpg', dirs)).toThrow(ValidationError);
  });
});

describe('sniffImage', () => {
  it('knows PNG, JPEG and WEBP by their first bytes', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPG)).toBe('jpg');
    expect(sniffImage(WEBP)).toBe('webp');
  });

  it('refuses GIF, SVG, HTML and anything else with a reason', () => {
    expect(() => sniffImage(Buffer.from('GIF89a'))).toThrow(/GIFs are not supported/);
    expect(() => sniffImage(Buffer.from('<?xml version="1.0"?><svg></svg>'))).toThrow(/SVGs are not supported/);
    expect(() => sniffImage(Buffer.from('  <svg xmlns="x"/>'))).toThrow(/SVGs/);
    expect(() => sniffImage(Buffer.from('<!doctype html><html>'))).toThrow(/web page/);
    expect(() => sniffImage(Buffer.from('%PDF-1.7'))).toThrow(/not a PNG, JPEG or WEBP/);
  });
});

describe('materialiseReference', () => {
  const fetchers = () => ({ fetchServerFile: vi.fn(async () => WEBP), fetchUrl: vi.fn(async () => PNG) });

  it('copies files and fetches server files and links into ref-<n>.<real ext>', async () => {
    const jobDir = join(root, 'job');
    mkdirSync(jobDir);
    const f = fetchers();
    expect(await materialiseReference({ kind: 'file', path: join(dirs.inboxDir, 'photo.jpg') }, 1, jobDir, f)).toBe(join(jobDir, 'ref-1.jpg'));
    expect(await materialiseReference({ kind: 'server', server: 'cedar', path: '/home/dev/a.png' }, 2, jobDir, f)).toBe(join(jobDir, 'ref-2.webp'));
    expect(f.fetchServerFile).toHaveBeenCalledWith('cedar', '/home/dev/a.png');
    expect(await materialiseReference({ kind: 'url', url: 'https://x.test/a' }, 3, jobDir, f)).toBe(join(jobDir, 'ref-3.png'));
    expect(readFileSync(join(jobDir, 'ref-2.webp'))).toEqual(WEBP);
  });

  it('refuses a fetched file over 20 MB', async () => {
    const f = { fetchServerFile: vi.fn(async () => Buffer.alloc(20 * 1024 * 1024 + 1)), fetchUrl: vi.fn() };
    await expect(materialiseReference({ kind: 'server', server: 'cedar', path: '/a.png' }, 1, root, f)).rejects.toThrow('bigger than 20 MB');
  });
});
