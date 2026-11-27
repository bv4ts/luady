import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { KIT_PAYLOAD_MAX_BYTES, buildKitPayload } from '../../src/hosts/kit-payload.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** The names and modes of a ustar archive, read back block by block. */
function listTar(gz: Buffer): Array<{ name: string; mode: number; type: string; size: number }> {
  const tar = gunzipSync(gz);
  const out: Array<{ name: string; mode: number; type: string; size: number }> = [];
  let at = 0;
  while (at + 512 <= tar.length) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12), 8);
    const prefix = field(345, 155);
    out.push({ name: prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`, mode: Number.parseInt(field(100, 8), 8), type: field(156, 1), size });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function fakeKit(): string {
  const root = mkdtempSync(join(tmpdir(), 'luady-kit-root-'));
  const kit = join(root, 'server-kit');
  for (const dir of ['luady_kit/__pycache__', 'bin', 'hooks', 'tests/fakes']) mkdirSync(join(kit, dir), { recursive: true });
  writeFileSync(join(kit, 'install.py'), '#!/usr/bin/env python3\nprint("hi")\n');
  writeFileSync(join(kit, 'luady_kit', '__init__.py'), "__version__ = '9.9.9'\n");
  writeFileSync(join(kit, 'luady_kit', '__pycache__', 'x.cpython-312.pyc'), 'compiled');
  writeFileSync(join(kit, 'bin', 'luady-ctl'), '#!/usr/bin/env python3\n');
  writeFileSync(join(kit, 'hooks', 'luady_pause.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(kit, 'tests', 'test_a.py'), 'assert True\n');
  writeFileSync(join(kit, 'Dockerfile.test'), 'FROM scratch\n');
  return root;
}

function hasTar(): boolean {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('the kit payload', () => {
  it('is deterministic: the same tree gives the same bytes and sha256', async () => {
    const root = fakeKit();
    const first = await buildKitPayload(root);
    const second = await buildKitPayload(root);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bytes[9]).toBe(3);
  });

  it('leaves out tests/, __pycache__ and Dockerfile*, and marks bin/ and hooks/ executable', async () => {
    const payload = await buildKitPayload(fakeKit());
    const entries = listTar(payload.bytes);
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual(['bin/', 'bin/luady-ctl', 'hooks/', 'hooks/luady_pause.sh', 'install.py', 'luady_kit/', 'luady_kit/__init__.py']);
    expect(entries.find((entry) => entry.name === 'bin/luady-ctl')?.mode).toBe(0o755);
    expect(entries.find((entry) => entry.name === 'install.py')?.mode).toBe(0o644);
    expect(entries.find((entry) => entry.name === 'luady_kit/')?.type).toBe('5');
    expect(payload.files).toBe(4);
  });

  it('refuses a tree with Windows line endings, without install.py, or over the size limit', async () => {
    const crlf = fakeKit();
    writeFileSync(join(crlf, 'server-kit', 'install.py'), '#!/usr/bin/env python3\r\n');
    await expect(buildKitPayload(crlf)).rejects.toThrow(/line endings/);
    const empty = mkdtempSync(join(tmpdir(), 'luady-kit-empty-'));
    mkdirSync(join(empty, 'server-kit'));
    await expect(buildKitPayload(empty)).rejects.toThrow(/install\.py/);
    await expect(buildKitPayload(fakeKit(), 64)).rejects.toThrow(/limit/);
  });

  it('the real server kit fits in 5 MB, without its tests', async () => {
    const payload = await buildKitPayload(REPO);
    expect(payload.bytes.length).toBeLessThanOrEqual(KIT_PAYLOAD_MAX_BYTES);
    const names = listTar(payload.bytes).map((entry) => entry.name);
    expect(names).toContain('install.py');
    expect(names).toContain('bin/luady-ctl');
    expect(names.some((name) => name.startsWith('tests/') || name.includes('__pycache__') || name.startsWith('Dockerfile'))).toBe(false);
  });

  it.runIf(hasTar())('a system tar reads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luady-kit-tar-'));
    const file = join(dir, 'kit.tar.gz');
    writeFileSync(file, (await buildKitPayload(fakeKit())).bytes);
    const listed = execFileSync('tar', ['-tzf', 'kit.tar.gz'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    expect(listed).toContain('install.py');
    expect(listed).toContain('bin/luady-ctl');
  });
});
