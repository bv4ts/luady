import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../harness/paths.js';
import { runProc } from '../harness/proc.js';

const TEMPLATE = join(REPO_ROOT, 'deploy', 'cloudflared', 'config.yml.template');
const TUNNEL_ID = '00000000-0000-4000-8000-0000000000f1';

async function rendered(): Promise<string> {
  return (await readFile(TEMPLATE, 'utf8')).replaceAll('${LUADY_TUNNEL_ID}', TUNNEL_ID);
}

describe('deploy/cloudflared/config.yml.template', () => {
  it('routes only luady.example.com to 127.0.0.1:7410, keeps voice commented out and ends with a 404 catch-all', async () => {
    const text = await rendered();
    const active = text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
    expect(active).toEqual([
      `tunnel: ${TUNNEL_ID}`,
      `credentials-file: /etc/cloudflared/${TUNNEL_ID}.json`,
      'ingress:',
      '  - hostname: luady.example.com',
      '    service: http://127.0.0.1:7410',
      '  - service: http_status:404',
    ]);
    expect(text).toMatch(/^\s*# - hostname: voice\.example\.com$/m);
    expect(text).toMatch(/^\s*#\s+service: http:\/\/127\.0\.0\.1:7411$/m);
    expect(text.includes('\r')).toBe(false);
  });

  it('passes `cloudflared tunnel ingress validate` with the official image', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luady-cf-'));
    try {
      await writeFile(join(dir, 'config.yml'), await rendered());
      // The image runs as its own user: a temp folder is owner-only by default, so that user could not read the file.
      // (The file holds only the template with a made-up tunnel id.)
      await chmod(dir, 0o755);
      await chmod(join(dir, 'config.yml'), 0o644);
      const result = await runProc('docker', [
        'run', '--rm', '--mount', `type=bind,source=${dir},target=/cfg,readonly`,
        'cloudflare/cloudflared:2026.9.3', 'tunnel', '--config', '/cfg/config.yml', 'ingress', 'validate',
      ], { timeoutMs: 180_000 });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/\bOK\b/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
