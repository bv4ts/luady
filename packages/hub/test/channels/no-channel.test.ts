import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoticeDTOSchema, PAGE_KEY_HEADER } from '@luady/shared';
import type { App } from '../../src/app.js';
import { WIRING_TOKEN, hubHeaders, startWiring, switchManagerOn, wiringConfig, type WiringRun } from '../wire/wiring-harness.js';
import { rig } from './helpers.js';

/**
 * With no chat channel at all the product is still whole. Everything meant for the owner is
 * a website notice, and files wait in the outbox, downloadable from the website with the session and its page key.
 */
let running: App | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

async function hubWithoutChannel(): Promise<WiringRun & { workspace: string }> {
  const brainDir = join(mkdtempSync(join(tmpdir(), 'luady-nochannel-')), 'brain');
  const workspace = join(brainDir, 'workspace');
  mkdirSync(join(workspace, 'reports'), { recursive: true });
  const run = await startWiring({}, wiringConfig({ brainDir }), false);
  running = run.app;
  return { ...run, workspace };
}

const web = (run: WiringRun, url: string, withKey = true) => run.app.web.inject({
  method: 'GET', url,
  headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie, ...(withKey ? hubHeaders(run) : { host: new URL(run.config.publicOrigin).host }) },
});

describe('no chat channel: notices and the outbox', () => {
  it('each raw sender goes to the website; best-effort calls do nothing; the channel list is empty', async () => {
    // The owner channel as the hub builds it, with no add-on declared.
    const r = rig([]);
    expect(r.owner.isUp()).toBe(false);
    await expect(r.owner.send('A plain message', null)).resolves.toBeNull();
    await expect(r.owner.send('About a question', { kind: 'question', refId: 'QABCDEFG' })).resolves.toBeNull();
    r.owner.typing?.(true);
    r.owner.pin?.('m1', true);
    await expect(r.owner.edit?.('m1', 'x')).resolves.toBe(false);
    expect(r.website).toEqual([
      { text: 'A plain message', link: null, fileId: null },
      { text: 'About a question', link: { kind: 'question', refId: 'QABCDEFG' }, fileId: null },
    ]);
    const run = await hubWithoutChannel();
    const channels = await web(run, '/api/channels');
    expect(channels.json()).toEqual([]);
  });

  it('send_file becomes a notice that carries the file; GET /api/files/:id serves it as an attachment, only with the page key', async () => {
    const run = await hubWithoutChannel();
    const path = join(run.workspace, 'reports', 'summary.pdf');
    writeFileSync(path, '%PDF-1.7 report');
    // The manager's tools answer only while it is on.
    await switchManagerOn(run.app);
    const tool = await run.app.internal.inject({
      method: 'POST', url: '/internal/tools/send_file', headers: { authorization: `Bearer ${WIRING_TOKEN}` },
      payload: { server: 'hq', path, caption: 'The report' },
    });
    expect(tool.json()).toEqual({ ok: true, text: 'No chat channel is up, so summary.pdf (1 KB) waits on the website, where the owner can download it.' });
    const list = await web(run, '/api/notices');
    const notice = NoticeDTOSchema.parse((list.json() as { items: unknown[] }).items[0]);
    expect(notice).toMatchObject({ kind: 'system', text: 'The report\n📎 summary.pdf: download it on the website.' });
    expect(notice.file).toEqual({ id: expect.any(String), name: 'summary.pdf', mime: 'application/pdf', size: 15 });
    const file = await web(run, `/api/files/${notice.file?.id ?? ''}`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('%PDF-1.7 report');
    expect(file.headers['content-disposition']).toBe('attachment; filename="summary.pdf"; filename*=UTF-8\'\'summary.pdf');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    const noKey = await web(run, `/api/files/${notice.file?.id ?? ''}`, false);
    expect(noKey.statusCode).toBe(401);
    expect(noKey.body).not.toContain('%PDF');
    const wrongKey = await run.app.web.inject({
      method: 'GET', url: `/api/files/${notice.file?.id ?? ''}`,
      headers: { 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie, host: new URL(run.config.publicOrigin).host, [PAGE_KEY_HEADER]: 'x'.repeat(43) },
    });
    expect(wrongKey.statusCode).toBe(401);
    expect((await web(run, '/api/files/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await web(run, '/api/files/..%2F..%2Fhub.db')).statusCode).toBe(400);
  });

  it('notify_user waits on the website and says so, without promising a chat that is not there', async () => {
    const run = await hubWithoutChannel();
    await switchManagerOn(run.app);
    const tool = await run.app.internal.inject({
      method: 'POST', url: '/internal/tools/notify_user', headers: { authorization: `Bearer ${WIRING_TOKEN}` }, payload: { text: 'Build finished' },
    });
    expect(tool.json()).toMatchObject({ ok: true });
    expect(run.app.services.notices.list().map((n) => n.text)).toContain('Build finished');
  });
});
