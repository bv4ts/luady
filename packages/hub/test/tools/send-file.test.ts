import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CtlFileGet } from '@luady/shared';
import { NotFoundError, RefusedError, ValidationError } from '../../src/core/errors.js';
import { mediaKind, OWNER_TOOLS } from '../../src/tools/owner-tools.js';
import { createFakeCtl } from '../helpers/fakes.js';
import { createFakeToolContext } from './fake-context.js';

describe('send_file', () => {
  it('fetches the file from the server and sends it as an inline image', async () => {
    const ctx = createFakeToolContext();
    const fileGet = vi.fn(async (): Promise<CtlFileGet> => ({ path: '/home/dev/luady-out/admin.png', size: 204800, b64: 'iVBORw==' }));
    vi.mocked(ctx.fleet.client).mockReturnValue(createFakeCtl({ fileGet }));
    const text = await OWNER_TOOLS.send_file({ server: 'ash', path: '/home/dev/luady-out/admin.png', caption: 'Superadmin' }, ctx);
    expect(text).toBe("Sent admin.png (200 KB) to the owner's chat.");
    expect(ctx.fleet.client).toHaveBeenCalledWith('ash');
    expect(fileGet).toHaveBeenCalledWith('/home/dev/luady-out/admin.png', 50 * 1024 * 1024);
    expect(ctx.outbound.sendMedia).toHaveBeenCalledWith({
      kind: 'image', mime: 'image/png', fileName: 'admin.png', caption: 'Superadmin', b64: 'iVBORw==',
    });
  });

  it('refuses protected and relative paths, and an offline chat (with no website side), before reaching the server', async () => {
    const ctx = createFakeToolContext();
    await expect(OWNER_TOOLS.send_file({ server: 'ash', path: '/home/dev/.ssh/id_ed25519' }, ctx)).rejects.toBeInstanceOf(RefusedError);
    await expect(OWNER_TOOLS.send_file({ server: 'ash', path: 'shot.png' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    vi.mocked(ctx.outbound.isUp).mockReturnValue(false);
    await expect(OWNER_TOOLS.send_file({ server: 'ash', path: '/home/dev/shot.png' }, ctx)).rejects.toBeInstanceOf(RefusedError);
    expect(ctx.fleet.client).not.toHaveBeenCalled();
  });

  it('sends files the manager made in its own workspace, and nothing else from the hub machine', async () => {
    const base = await mkdtemp(join(tmpdir(), 'luady-ws-'));
    const workspace = join(base, 'workspace');
    await mkdir(join(workspace, 'trip'), { recursive: true });
    await writeFile(join(workspace, 'trip', 'plan.md'), '# Plan\n');
    await writeFile(join(base, 'secrets.env'), 'X=1\n');
    const ctx = { ...createFakeToolContext(), workspaceDir: workspace };
    const sendMediaPath = vi.fn(async () => 'wa-1');
    ctx.outbound.sendMediaPath = sendMediaPath;
    const text = await OWNER_TOOLS.send_file({ server: 'hq', path: join(workspace, 'trip', 'plan.md'), caption: 'Trip plan' }, ctx);
    expect(text).toBe("Sent plan.md (1 KB) to the owner's chat.");
    expect(sendMediaPath).toHaveBeenCalledWith(expect.objectContaining({ kind: 'document', mime: 'text/markdown', fileName: 'plan.md', caption: 'Trip plan' }));
    await expect(OWNER_TOOLS.send_file({ server: 'hq', path: join(base, 'secrets.env') }, ctx)).rejects.toBeInstanceOf(RefusedError);
    await expect(OWNER_TOOLS.send_file({ server: 'hq', path: join(workspace, 'trip', '..', '..', 'secrets.env') }, ctx)).rejects.toBeInstanceOf(RefusedError);
    await expect(OWNER_TOOLS.send_file({ server: 'hq', path: join(workspace, 'trip') }, ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(OWNER_TOOLS.send_file({ server: 'hq', path: join(workspace, 'nope.md') }, ctx)).rejects.toBeInstanceOf(NotFoundError);
    try {
      await symlink(join(base, 'secrets.env'), join(workspace, 'trip', 'link.env'));
      await expect(OWNER_TOOLS.send_file({ server: 'hq', path: join(workspace, 'trip', 'link.env') }, ctx)).rejects.toBeInstanceOf(RefusedError);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err; // Windows without symlink rights
    }
    expect(sendMediaPath).toHaveBeenCalledTimes(1);
    expect(ctx.fleet.client).not.toHaveBeenCalled();
    await rm(base, { recursive: true, force: true });
  });

  it('maps extensions to inline images or documents', () => {
    expect(mediaKind('a.JPG')).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(mediaKind('report.pdf')).toEqual({ kind: 'document', mime: 'application/pdf' });
    expect(mediaKind('anim.gif')).toEqual({ kind: 'document', mime: 'image/gif' });
    expect(mediaKind('Q3.xlsx')).toEqual({ kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(mediaKind('demo.mp4')).toEqual({ kind: 'document', mime: 'video/mp4' });
    expect(mediaKind('blob')).toEqual({ kind: 'document', mime: 'application/octet-stream' });
  });
});
