import { ActivitySpoolEventSchema, CtlAuthCodeSchema, CtlAuthLoginSchema, CtlAuthLogoutSchema, CtlAuthStatusSchema, CtlPauseSchema, CtlPendingSchema, CtlProjectsSchema, CtlResumeSchema, CtlSessionsSchema, PermissionPreviewSchema, SpoolEventSchema, TailLineSchema, isActivityEventName, type ActivitySpoolEvent, type HostId, type SpoolEvent } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { PREVIEW_OTHER_ACCOUNT_CODE, PREVIEW_SIGN_IN_CODE } from '../fake-auth.ts';
import { createFakeKit, RESUME_TEXT, transcriptWindow, type FakeKit } from '../fake-kit.ts';

const NOW = new Date('2026-11-14T08:00:00.000Z');
const SYSINFO = { load1: 0.1, load5: 0.2, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 9_000_000, uptime_s: 900_000 };
const QUESTION = [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }];

function kitFor(host: 'birch' | 'hq' = 'birch'): FakeKit {
  return createFakeKit(host, { clock: () => NOW, sysinfo: SYSINFO });
}

interface Parsed { file: string; offset: number; event: SpoolEvent | ActivitySpoolEvent }

/** Kit-2 lines: the six activity kinds parse with their own union, everything else with the spool union. */
function parse(line: string): Parsed {
  const tail = TailLineSchema.parse(JSON.parse(line));
  if ('heartbeat' in tail) throw new Error('unexpected heartbeat');
  const raw = tail.event as { event?: unknown };
  const event = isActivityEventName(raw.event) ? ActivitySpoolEventSchema.parse(raw) : SpoolEventSchema.parse(raw);
  return { file: tail.file, offset: tail.offset, event };
}

function collect(kit: FakeKit): Parsed[] {
  const lines: Parsed[] = [];
  kit.attach((line) => lines.push(parse(line)));
  return lines;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('spool lines', () => {
  it('delivers one valid tail line per emit, for every event kind the hub reduces', () => {
    const kit = kitFor();
    const lines = collect(kit);
    const pane = kit.addPane('app', '/home/dev/projects/app');
    kit.emit('session_start', pane.target, { source: 'startup', model: 'opus' });
    kit.emit('prompt', pane.target, { prompt_sha256: 'a'.repeat(64), prompt_preview: 'hi' });
    kit.emit('stop', pane.target, { last_assistant_message: 'done', truncated: false });
    kit.emit('stop_failure', pane.target, { error: 'boom' });
    kit.ask(pane.target, QUESTION);
    kit.permit(pane.target, 'Bash', 'ls');
    kit.emit('session_end', pane.target, { reason: 'prompt_input_exit' });
    expect(lines.map((line) => line.event.event)).toEqual([
      'session_start', 'prompt', 'stop', 'stop_failure', 'question', 'permission', 'session_end',
    ]);
    const first = lines[0]!;
    expect(first.file).toBe('events-20261114.jsonl');
    expect(first.event).toMatchObject({ host: 'birch', tmux: 'cc-app:0.0', session_id: pane.sid, cwd: '/home/dev/projects/app' });
    expect(first.event.transcript_path).toBe(`/home/dev/.claude/projects/preview/${pane.sid}.jsonl`);
  });

  it('grows the offset with every line', () => {
    const kit = kitFor();
    const lines = collect(kit);
    for (let i = 0; i < 3; i += 1) kit.emit('stop_failure', null, { error: `e${i}` });
    const offsets = lines.map((line) => line.offset);
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets[1]).toBeGreaterThan(offsets[0]!);
    expect(offsets[2]).toBeGreaterThan(offsets[1]!);
  });

  it('dates an event back by ageMs and leaves the pane fields null without a target', () => {
    const kit = kitFor();
    const lines = collect(kit);
    kit.emit('stop_failure', null, { error: 'x' }, { ageMs: 600_000 });
    expect(lines[0]!.event.ts).toBe('2026-11-14T07:50:00.000Z');
    expect(lines[0]!.event).toMatchObject({ session_id: null, cwd: null, transcript_path: null, tmux: null });
  });

  it('keeps lines emitted before attach and delivers them in order', () => {
    const kit = kitFor();
    kit.emit('stop_failure', null, { error: 'first' });
    kit.emit('stop_failure', null, { error: 'second' });
    const lines = collect(kit);
    expect(lines.map((line) => line.event.event === 'stop_failure' && line.event.data.error)).toEqual(['first', 'second']);
  });

  it('uses manager:0.0 for the self host', () => {
    expect(kitFor('hq').addPane('manager', '/brain').target).toBe('manager:0.0');
  });
});

describe('luady-ctl verbs', () => {
  it('lists the panes in the sessions format the hub expects', async () => {
    const kit = kitFor();
    kit.addPane('one', '/home/dev/projects/one');
    kit.addPane('two', '/home/dev/projects/two');
    const { sessions } = CtlSessionsSchema.parse(await kit.client.sessions());
    expect(sessions.map((pane) => pane.target)).toEqual(['cc-one:0.0', 'cc-two:0.0']);
    expect(sessions.every((pane) => pane.is_claude && pane.registered && pane.command === 'claude')).toBe(true);
  });

  it('answers a pending question and clears it from the pane', async () => {
    const kit = kitFor();
    const lines = collect(kit);
    const pane = kit.addPane('app', '/home/dev/projects/app');
    const qid = kit.ask(pane.target, QUESTION);
    expect(kit.pane(pane.target)?.pendingQid).toBe(qid);
    const { pending } = CtlPendingSchema.parse(await kit.client.pending());
    expect(pending).toEqual([expect.objectContaining({ qid, kind: 'question', tmux: pane.target, session_id: pane.sid })]);
    await kit.client.answer(qid, { answers: { 'Which?': 'A' } });
    expect(lines.at(-1)?.event).toMatchObject({ event: 'question_resolved', data: { qid, outcome: 'answered' } });
    expect(kit.pane(pane.target)?.pendingQid).toBeNull();
    expect((await kit.client.pending()).pending).toEqual([]);
  });

  it('resolves a permission with the outcome the hub asked for', async () => {
    const kit = kitFor();
    const lines = collect(kit);
    const pane = kit.addPane('app', '/home/dev/projects/app');
    const qid = kit.permit(pane.target, 'Bash', 'rm -rf build');
    expect(lines.at(-1)?.event).toMatchObject({ event: 'permission', data: { qid, tool_name: 'Bash', input_preview: 'rm -rf build' } });
    await kit.client.permission(qid, { behavior: 'deny' });
    expect(lines.at(-1)?.event).toMatchObject({ event: 'permission_resolved', data: { qid, outcome: 'denied' } });
  });

  it('rejects an unknown qid with not_found', async () => {
    await expect(kitFor().client.answer('ZZZZZZZZ', { answers: { 'Which?': 'A' } })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stops a session: session_end, then the pane is gone', async () => {
    const kit = kitFor();
    const lines = collect(kit);
    const pane = kit.addPane('app', '/home/dev/projects/app');
    expect(await kit.client.stop(pane.target, false)).toEqual({ ok: true, forced: false });
    expect(lines.at(-1)?.event).toMatchObject({ event: 'session_end', tmux: pane.target });
    expect(kit.panes()).toEqual([]);
  });

  it('types into the transcript and tells the send listener', async () => {
    const kit = kitFor();
    const pane = kit.addPane('app', '/home/dev/projects/app');
    const sent: string[] = [];
    kit.onSend((target, text) => sent.push(`${target} ${text}`));
    await kit.client.send(pane.target, 'please fix the tests');
    const chunk = await kit.client.transcript(pane.sid, { tail: 4096 });
    expect(chunk.data).toContain('please fix the tests');
    expect(chunk.size).toBe(chunk.to);
    expect(JSON.parse(chunk.data.trim())).toMatchObject({ type: 'user', sessionId: pane.sid, message: { role: 'user' } });
    await tick();
    expect(sent).toEqual(['cc-app:0.0 please fix the tests']);
  });

  it('pages a transcript in whole lines, as the hub reader expects', () => {
    const lines = ['{"n":1}', '{"n":2}', '{"n":3}'];
    const all = transcriptWindow('/t.jsonl', lines, {});
    expect(all).toMatchObject({ from: 0, to: 24, size: 24, data: '{"n":1}\n{"n":2}\n{"n":3}\n' });
    expect(transcriptWindow('/t.jsonl', lines, { tail: 17 })).toMatchObject({ from: 8, to: 24, data: '{"n":2}\n{"n":3}\n' });
    expect(transcriptWindow('/t.jsonl', lines, { before: 16, max: 8 })).toMatchObject({ from: 8, to: 16, data: '{"n":2}\n' });
    expect(transcriptWindow('/t.jsonl', lines, { from: 8, max: 100 })).toMatchObject({ from: 8, to: 24 });
  });

  it('starts a session in a new pane', async () => {
    const kit = kitFor();
    const lines = collect(kit);
    expect(await kit.client.start({ name: 'x', cwd: '/home/dev/projects/x' })).toEqual({ ok: true, target: 'cc-x:0.0' });
    expect(lines.at(-1)?.event).toMatchObject({ event: 'session_start', tmux: 'cc-x:0.0', data: { source: 'startup' } });
    expect(kit.pane('cc-x:0.0')?.cwd).toBe('/home/dev/projects/x');
  });

  it('lists one project per pane folder', async () => {
    const kit = kitFor();
    kit.addPane('b', '/home/dev/projects/b');
    kit.addPane('a', '/home/dev/projects/a');
    const { projects } = CtlProjectsSchema.parse(await kit.client.projects());
    expect(projects.map((p) => `${p.name} ${p.path}`)).toEqual(['a /home/dev/projects/a', 'b /home/dev/projects/b']);
  });

  it('reports a signed-in Claude and the fixed versions', async () => {
    const kit = kitFor();
    expect(await kit.client.authStatus()).toMatchObject({ logged_in: true, org_id: 'org_team_a' });
    expect(await kit.client.version()).toEqual({ kit: '2.1.0', claude: '2.1.323', tmux: '3.4', python: '3.12.3' });
    expect(await kit.client.sysinfo()).toEqual(SYSINFO);
  });
});

describe('pause and resume (kit 2)', () => {
  it('pause flags the pane in sessions(); a resume before any hit types nothing', async () => {
    const kit = kitFor();
    const a = kit.addPane('a', '/home/dev/projects/a');
    kit.addPane('b', '/home/dev/projects/b');
    expect(CtlPauseSchema.parse(await kit.client.pause(a.target))).toEqual({ ok: true, paused: true });
    const { sessions } = CtlSessionsSchema.parse(await kit.client.sessions());
    expect(sessions.map((pane) => [pane.target, pane.paused])).toEqual([['cc-a:0.0', true], ['cc-b:0.0', false]]);
    expect(kit.isPaused(a.target)).toBe(true);
    expect(CtlResumeSchema.parse(await kit.client.resume(a.target))).toEqual({ ok: true, was_hit: false, sent: false });
    expect(kit.isPaused(a.target)).toBe(false);
    expect(await kit.client.resume(a.target)).toEqual({ ok: true, was_hit: false, sent: false });
  });

  it('a resume after the pause hit types the resume text and tells the send listener', async () => {
    const kit = kitFor();
    const lines = collect(kit);
    const pane = kit.addPane('app', '/home/dev/projects/app');
    const sent: string[] = [];
    kit.onSend((target, text) => sent.push(`${target} ${text}`));
    await kit.client.pause(pane.target);
    kit.pauseHit(pane.target);
    expect(lines.at(-1)?.event).toMatchObject({ event: 'paused', tmux: pane.target, data: {} });
    expect(await kit.client.resume(pane.target)).toEqual({ ok: true, was_hit: true, sent: true });
    await tick();
    expect(sent).toEqual([`cc-app:0.0 ${RESUME_TEXT}`]);
    expect(RESUME_TEXT).toBe('The owner has lifted the pause. Continue from where you paused.');
    expect((await kit.client.transcript(pane.sid, { tail: 4096 })).data).toContain(RESUME_TEXT);
  });

  it('a resume while a question waits clears the flag but types nothing', async () => {
    const kit = kitFor();
    const pane = kit.addPane('app', '/home/dev/projects/app');
    await kit.client.pause(pane.target);
    kit.pauseHit(pane.target);
    kit.ask(pane.target, QUESTION);
    expect(await kit.client.resume(pane.target)).toEqual({ ok: true, was_hit: true, sent: false });
  });

  it('pausing an unknown pane is not_found', async () => {
    await expect(kitFor().client.pause('cc-nope:0.0')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a permission can carry a structured preview', () => {
    const kit = kitFor();
    const lines = collect(kit);
    const pane = kit.addPane('app', '/home/dev/projects/app');
    const preview = PermissionPreviewSchema.parse({
      tool: 'Edit', kind: 'edit', command: null, path: '/home/dev/projects/app/src/a.ts', cwd: pane.cwd,
      edits: [{ old: 'a', new: 'b' }], truncated: false, always: { label: 'Edit' },
    });
    const qid = kit.permit(pane.target, 'Edit', '{"file_path":"src/a.ts"}', { preview });
    expect(lines.at(-1)?.event).toMatchObject({ event: 'permission', data: { qid, tool_name: 'Edit', preview } });
  });
});


describe('sign-in per host', () => {
  const DAY_MS = 86_400_000;
  const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
  const status = async (host: HostId) => CtlAuthStatusSchema.parse(await createFakeKit(host, { clock: () => NOW, sysinfo: SYSINFO }).client.authStatus());

  it('each host reports its account, plan and expiry; local and the self host share one account', async () => {
    expect(await status('cedar')).toMatchObject({ logged_in: true, org_id: 'org_max', org_name: 'Personal', plan: 'max', expires_at: ahead(20 * DAY_MS) });
    expect(await status('birch')).toMatchObject({ org_id: 'org_team_a', org_name: 'Team A', plan: 'team', expires_at: ahead(40 * DAY_MS) });
    expect(await status('ash')).toMatchObject({ org_id: 'org_team_b', org_name: 'Team B', plan: 'team', expires_at: ahead(30 * 3_600_000) });
    for (const host of ['local', 'hq'] as const) {
      expect(await status(host)).toMatchObject({ org_id: 'org_luady', org_name: 'Luady', plan: 'max', expires_at: ahead(25 * DAY_MS) });
    }
  });

  it('a sign-in link on the reserved host; only the preview code signs in', async () => {
    const kit = kitFor();
    await expect(kit.client.authCode(PREVIEW_SIGN_IN_CODE)).rejects.toMatchObject({ code: 'not_found' });
    const { url } = CtlAuthLoginSchema.parse(await kit.client.authLogin());
    expect(new URL(url)).toMatchObject({ protocol: 'https:', hostname: 'luady-preview.claude.ai', pathname: '/oauth/authorize' });
    expect(CtlAuthCodeSchema.parse(await kit.client.authCode('wrong-code-99'))).toMatchObject({ ok: false, message: 'Invalid code' });
    expect(CtlAuthCodeSchema.parse(await kit.client.authCode(PREVIEW_SIGN_IN_CODE))).toMatchObject({ ok: true, logged_in: true, org_id: 'org_team_a' });
    await expect(kit.client.authCode(PREVIEW_SIGN_IN_CODE)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('auth-logout signs the host out, and a new sign-in brings its account back', async () => {
    const kit = kitFor();
    expect(CtlAuthLogoutSchema.parse(await kit.client.authLogout())).toMatchObject({ ok: true, logged_in: false, org_id: null });
    expect(await kit.client.authStatus()).toMatchObject({ logged_in: false, email: null, org_id: null });
    await kit.client.authLogin();
    await kit.client.authCode(PREVIEW_SIGN_IN_CODE);
    expect(await kit.client.authStatus()).toMatchObject({ logged_in: true, org_id: 'org_team_a' });
  });

  it('signOut is the same as signing out at the terminal', async () => {
    const kit = kitFor('hq');
    kit.signOut();
    expect(await kit.client.authStatus()).toMatchObject({ logged_in: false });
  });
});

describe('a sign-in on another account', () => {
  it('the second preview code signs the host in to another organisation', async () => {
    const kit = kitFor();
    await kit.client.authLogin();
    expect(await kit.client.authCode(PREVIEW_OTHER_ACCOUNT_CODE)).toMatchObject({ ok: true, org_id: 'org_other', org_name: 'Other Org', plan: 'pro' });
    expect(await kit.client.authStatus()).toMatchObject({ logged_in: true, org_id: 'org_other' });
  });
});
