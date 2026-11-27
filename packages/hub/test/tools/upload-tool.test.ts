import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtlFilePut } from '@luady/shared';
import { NotFoundError, RefusedError } from '../../src/core/errors.js';
import { UPLOAD_TOOLS, uploadName } from '../../src/tools/upload-tool.js';
import { createFakeCtl } from '../helpers/fakes.js';
import { createFakeToolContext } from './fake-context.js';

let root: string;
let inbox: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'luady-upload-'));
  inbox = join(root, 'inbox');
  mkdirSync(inbox);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('file_upload', () => {
  it('sends an inbox file to the server inbox under its original name', async () => {
    const file = join(inbox, '20261010-031500-3A11C202-Q3 report.xlsx');
    writeFileSync(file, 'xlsx-bytes');
    const ctx = { ...createFakeToolContext(), inboxDir: inbox };
    const filePut = vi.fn(async (name: string): Promise<CtlFilePut> => ({ path: `/home/dev/luady-inbox/${name}`, size: 10 }));
    vi.mocked(ctx.fleet.client).mockReturnValue(createFakeCtl({ filePut }));
    const text = await UPLOAD_TOOLS.file_upload({ server: 'ash', file }, ctx);
    expect(text).toBe('Uploaded to ash:/home/dev/luady-inbox/Q3_report.xlsx (1 KB). Give this exact path to the session.');
    expect(filePut).toHaveBeenCalledWith('Q3_report.xlsx', Buffer.from('xlsx-bytes').toString('base64'));
  });

  it('refuses files outside the inbox, including through a symlink, and missing files', async () => {
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(inbox, 'link.txt'));
    const ctx = { ...createFakeToolContext(), inboxDir: inbox };
    await expect(UPLOAD_TOOLS.file_upload({ server: 'ash', file: outside }, ctx)).rejects.toBeInstanceOf(RefusedError);
    await expect(UPLOAD_TOOLS.file_upload({ server: 'ash', file: join(inbox, 'link.txt') }, ctx)).rejects.toBeInstanceOf(RefusedError);
    await expect(UPLOAD_TOOLS.file_upload({ server: 'ash', file: join(inbox, 'nope.png') }, ctx)).rejects.toBeInstanceOf(NotFoundError);
    expect(ctx.fleet.client).not.toHaveBeenCalled();
  });

  it('makes server-safe names', () => {
    expect(uploadName('صورة الموقع.png')).toBe('_.png'.replace(/^_/, 'file'));
    expect(uploadName('..hidden..tar.gz')).toBe('hidden.tar.gz');
    expect(uploadName('logo (final).PNG')).toBe('logo_final_.PNG');
  });
});
