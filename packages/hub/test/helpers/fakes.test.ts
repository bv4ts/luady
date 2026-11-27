import { describe, expect, it } from 'vitest';
import {
  CtlAuthLogoutSchema,
  CtlAuthStatusSchema,
  CtlConfigSchema,
  CtlDeleteSchema,
  CtlExecSchema,
  CtlFileReadSchema,
  CtlFileWriteSchema,
  CtlPauseSchema,
  CtlPendingSchema,
  CtlProjectsSchema,
  CtlResumeSchema,
  CtlSessionsSchema,
  CtlStartSchema,
  CtlStopSchema,
  CtlSysinfoSchema,
  CtlTranscriptSchema,
  CtlUpdateSchema,
  CtlVersionSchema,
} from '@luady/shared';
import { createFakeClock, createFakeCtl, createFakeOutbound, createNullPhone, silentLogger } from './fakes.js';

const CTL_METHODS = [
  'version',
  'sysinfo',
  'sessions',
  'pending',
  'answer',
  'permission',
  'send',
  'keys',
  'start',
  'stop',
  'restart',
  'remove',
  'transcript',
  'capture',
  'updateClaude',
  'projects',
  'exec',
  'fileRead',
  'fileWrite',
  'getConfig',
  'setConfig',
  'pause',
  'resume',
  'authStatus',
  'authLogin',
  'authCode',
  'authLogout',
  'skills',
  'kbPut',
  'gitStatus',
] as const;

describe('createFakeCtl', () => {
  it('implements every CtlClient method', () => {
    const ctl = createFakeCtl();
    for (const method of CTL_METHODS) {
      expect(typeof ctl[method]).toBe('function');
    }
  });

  it('resolves defaults that satisfy the ctl schemas', async () => {
    const ctl = createFakeCtl();
    expect(CtlVersionSchema.safeParse(await ctl.version()).success).toBe(true);
    expect(CtlSysinfoSchema.safeParse(await ctl.sysinfo()).success).toBe(true);
    expect(CtlSessionsSchema.safeParse(await ctl.sessions()).success).toBe(true);
    expect(CtlPendingSchema.safeParse(await ctl.pending()).success).toBe(true);
    expect(CtlStartSchema.parse(await ctl.start({ name: 'demo', cwd: '/home/dev/projects/demo' }))).toEqual({
      ok: true,
      target: 'cc-demo:0.0',
    });
    expect(CtlStopSchema.safeParse(await ctl.stop('cc-demo:0.0', true)).success).toBe(true);
    expect(CtlDeleteSchema.safeParse(await ctl.remove('sid-1')).success).toBe(true);
    expect(CtlTranscriptSchema.safeParse(await ctl.transcript('sid-1', { tail: 10 })).success).toBe(true);
    expect(CtlUpdateSchema.safeParse(await ctl.updateClaude()).success).toBe(true);
    expect(CtlProjectsSchema.safeParse(await ctl.projects()).success).toBe(true);
    expect(CtlExecSchema.safeParse(await ctl.exec('ls', '/home/dev', 30)).success).toBe(true);
    expect(CtlFileReadSchema.safeParse(await ctl.fileRead('/home/dev/a.txt', 100)).success).toBe(true);
    expect(CtlFileWriteSchema.parse(await ctl.fileWrite('/home/dev/a.txt', '\u0645\u0631\u062d\u0628\u0627'))).toEqual({
      ok: true,
      bytes: 10,
    });
    expect(CtlConfigSchema.safeParse(await ctl.getConfig()).success).toBe(true);
    expect(await ctl.setConfig('hook_wait_seconds', '600')).toEqual({
      remote_answering: true,
      hook_wait_seconds: 600,
      host_alias: 'cedar',
    });
    expect((await ctl.setConfig('remote_answering', 'false')).remote_answering).toBe(false);
    expect(await ctl.capture('cc-demo:0.0', 50)).toBe('');
    await expect(ctl.send('cc-demo:0.0', 'hi')).resolves.toBeUndefined();
    expect(CtlPauseSchema.parse(await ctl.pause('cc-demo:0.0'))).toEqual({ ok: true, paused: true });
    expect(CtlResumeSchema.parse(await ctl.resume('cc-demo:0.0'))).toEqual({ ok: true, was_hit: true, sent: true });
  });

  it('signs out by default and reports an organisation and plan in its sign-in status', async () => {
    const ctl = createFakeCtl();
    expect(CtlAuthLogoutSchema.parse(await ctl.authLogout())).toEqual({ ok: true, message: 'Signed out', logged_in: false, email: null, expires_at: null });
    expect(CtlAuthStatusSchema.parse(await ctl.authStatus())).toMatchObject({ org_id: 'org_test', org_name: 'Test Org', plan: 'max' });
    expect(ctl.calls.map((c) => c.method)).toEqual(['authLogout', 'authStatus']);
  });

  it('records every call with its arguments, in order', async () => {
    const ctl = createFakeCtl();
    await ctl.send('cc-demo:0.0', 'line 1\nline 2');
    await ctl.keys('cc-demo:0.0', 'Escape');
    await ctl.answer('ABCDEFGH', { answers: { 'Which database?': 'Postgres' } });
    expect(ctl.calls).toEqual([
      { method: 'send', args: ['cc-demo:0.0', 'line 1\nline 2'] },
      { method: 'keys', args: ['cc-demo:0.0', 'Escape'] },
      { method: 'answer', args: ['ABCDEFGH', { answers: { 'Which database?': 'Postgres' } }] },
    ]);
  });

  it('uses overrides and still records the calls', async () => {
    const ctl = createFakeCtl({ capture: async () => 'pane text' });
    expect(await ctl.capture('cc-demo:0.0', 20)).toBe('pane text');
    expect(ctl.calls).toEqual([{ method: 'capture', args: ['cc-demo:0.0', 20] }]);
  });

  it('turns a throwing override into a rejected promise and records the call', async () => {
    const ctl = createFakeCtl({
      send: () => {
        throw new Error('pane is not claude');
      },
    });
    await expect(ctl.send('cc-demo:0.0', 'hi')).rejects.toThrow('pane is not claude');
    expect(ctl.calls).toEqual([{ method: 'send', args: ['cc-demo:0.0', 'hi'] }]);
  });
});

describe('createFakeOutbound', () => {
  it('records sends and returns sequential message ids while up', async () => {
    const out = createFakeOutbound();
    expect(out.isUp()).toBe(true);
    expect(await out.send('first', { kind: 'question', refId: 'ABCDEFGH' })).toBe('fake-wa-1');
    expect(await out.send('second', null, 'wa-quoted-1')).toBe('fake-wa-2');
    expect(out.sent).toEqual([
      { text: 'first', link: { kind: 'question', refId: 'ABCDEFGH' }, quotedId: null },
      { text: 'second', link: null, quotedId: 'wa-quoted-1' },
    ]);
  });

  it('returns null (queued) while down, and isUp follows the flag', async () => {
    const out = createFakeOutbound();
    out.up = false;
    expect(out.isUp()).toBe(false);
    expect(await out.send('queued', null)).toBeNull();
    expect(out.sent).toHaveLength(1);
    out.up = true;
    expect(await out.send('after', null)).toBe('fake-wa-1');
  });
});

describe('createFakeClock', () => {
  it('starts at 2026-10-09T12:00:00.000Z unless told otherwise', () => {
    expect(createFakeClock().now().toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(createFakeClock('2026-10-09T15:42:00Z').now().toISOString()).toBe('2026-10-09T15:42:00.000Z');
  });

  it('moves with advance and set, and hands out a fresh Date each time', () => {
    const clock = createFakeClock();
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-10-09T12:01:30.000Z');
    clock.set('2026-10-10T00:00:00.000Z');
    const handedOut = clock.now();
    handedOut.setFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('rejects invalid input', () => {
    expect(() => createFakeClock('yesterday')).toThrow(RangeError);
    const clock = createFakeClock();
    expect(() => clock.set('soon')).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
  });
});

describe('silentLogger', () => {
  it('is a pino logger that writes nothing', () => {
    const log = silentLogger();
    expect(log.level).toBe('silent');
    expect(() => log.info({ pin: '123456' }, 'never printed')).not.toThrow();
    expect(typeof log.child).toBe('function');
  });
});

describe('createNullPhone', () => {
  it('is disabled and records each call', async () => {
    const phone = createNullPhone();
    expect(phone.enabled()).toBe(false);
    await phone.callForQuestion('ABCDEFGH');
    await phone.callOwner('chat link is down');
    expect(phone.calls).toEqual(['question:ABCDEFGH', 'owner:chat link is down']);
  });
});
