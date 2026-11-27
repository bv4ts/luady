import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../../src/zod-csp.js';
import { createHash } from '../../src/stubs/node-crypto.js';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), 'utf8');

interface Manifest {
  name: string;
  display: string;
  start_url: string;
  icons: Array<{ src: string; type: string; purpose: string }>;
}

describe('CSP boot', () => {
  it('turns off zod JIT so no eval runs under the CSP', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('the node:crypto stub refuses to run in the browser', () => {
    expect(() => createHash('sha256')).toThrow('node:crypto is not available in the browser');
  });

  it('index.html loads only external same-origin scripts', () => {
    const html = read('../../index.html');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs = '', body = ''] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/[^"]+"/);
      expect(body.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//i);
  });

  it('the web manifest installs Luady with SVG icons', () => {
    const manifest = JSON.parse(read('../../public/manifest.webmanifest')) as Manifest;
    expect(manifest.name).toBe('Luady');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.map((icon) => icon.purpose).sort()).toEqual(['any', 'maskable']);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/svg+xml');
      expect(read(`../../public${icon.src}`)).toMatch(/^<svg\b/);
    }
  });
});
