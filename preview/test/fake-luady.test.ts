import type { BoardItemDTO, ProjectDTO, SessionDTO } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { delegationEvent } from '../../packages/hub/dist/board/delegate-text.js';
import { createFakeKit } from '../fake-kit.ts';
import {
  briefFor, carryOut, createFakeLuady, LUADY_REPLY, NO_UPDATE, parseDelegation, replyFor, sessionNameFor, type FakeLuadyDeps,
} from '../fake-luady.ts';

const NOW = '2026-11-15T08:00:00.000Z';
const SYSINFO = { load1: 0.1, load5: 0.2, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 9_000_000, uptime_s: 900_000 };

function cardOf(id: number, title: string, server: BoardItemDTO['server'], project: string | null): BoardItemDTO {
  return {
    id, title, details: '', project, server, source: 'web', sourceRef: null, state: 'queued', today: false, priority: 0, auto: false,
    runId: 'r_0123456789ab', sessionId: null, result: null, createdAt: NOW, updatedAt: NOW, doneAt: null, dueAt: null, snoozeUntil: null,
  };
}

const PROJECTS: ProjectDTO[] = [
  { server: 'cedar', path: '/home/dev/projects/meadow-vat', name: 'meadow-vat', remote: null, branch: 'main', commits: [], stack: [], updatedAt: NOW },
];

function session(id: string, host: SessionDTO['host'], project: string, state: SessionDTO['state']): SessionDTO {
  return {
    id, host, target: id.slice(id.indexOf(':') + 1), claudeSessionId: null, cwd: `/home/dev/projects/${project}`, project, displayName: project,
    state, origin: 'owner', registered: true, lastEventAt: NOW, turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
  };
}

const CARDS = [
  cardOf(12, 'Fix the "total"', 'birch', 'app-backend'), cardOf(13, 'Add a test', 'birch', 'app-backend'),
  cardOf(14, 'VAT return', null, 'meadow-vat'), cardOf(15, 'Something vague', null, null),
];
const auto = (): string => delegationEvent({ runId: 'r_0123456789ab', cards: CARDS, target: { kind: 'auto' }, projects: PROJECTS });

interface Call { readonly name: string; readonly args: Readonly<Record<string, unknown>> }

function deps(sessions: SessionDTO[] = [], taken: string[] = []): { deps: FakeLuadyDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      kit: createFakeKit('hq', { clock: () => new Date(NOW), sysinfo: SYSINFO }),
      tools: async (name, args) => {
        calls.push({ name, args });
        return 'done';
      },
      sessions: () => sessions,
      paneExists: (server, name) => taken.includes(`${server}/${name}`),
      wait: async () => undefined,
    },
  };
}

describe('parseDelegation reads the hub\'s own Run and Give events', () => {
  it('Run: the run id, the titles and the suggested groups (office from the projects list)', () => {
    const plan = parseDelegation(auto());
    expect(plan?.runId).toBe('r_0123456789ab');
    expect(plan?.target).toEqual({ kind: 'auto' });
    expect(plan?.cards.get(12)).toBe('Fix the "total"');
    expect(plan?.groups).toEqual([
      { server: 'birch', project: 'app-backend', ids: [12, 13] },
      { server: 'cedar', project: 'meadow-vat', ids: [14] },
      { server: null, project: null, ids: [15] },
    ]);
  });

  it('Give to a session: every card goes to that session', () => {
    const target = { kind: 'session' as const, session: session('birch:cc-app-backend:0.0', 'birch', 'app-backend', 'idle') };
    const plan = parseDelegation(delegationEvent({ runId: 'r_0123456789ab', cards: CARDS.slice(0, 2), target, projects: PROJECTS }));
    expect(plan?.target).toEqual({ kind: 'session', sessionId: 'birch:cc-app-backend:0.0' });
    expect(plan?.groups).toEqual([{ server: null, project: null, ids: [12, 13] }]);
  });

  it('Give to an office: the groups carry that office', () => {
    const plan = parseDelegation(delegationEvent({ runId: 'r_0123456789ab', cards: [CARDS[3]!], target: { kind: 'server', server: 'ash' }, projects: PROJECTS }));
    expect(plan?.target).toEqual({ kind: 'server', server: 'ash' });
    expect(plan?.groups).toEqual([{ server: 'ash', project: null, ids: [15] }]);
  });

  it('anything else is not a delegation', () => {
    expect(parseDelegation('[Web · 10:00] hello')).toBeNull();
  });
});

describe('carryOut', () => {
  it('starts one session per group with todos, and puts a card without a project in review', async () => {
    const { deps: d, calls } = deps([], ['birch/app-backend']);
    await carryOut(d, parseDelegation(auto())!);
    expect(calls.map((c) => c.name)).toEqual(['session_start', 'session_start', 'todo_update']);
    expect(calls[0]?.args).toMatchObject({ server: 'birch', cwd: '/home/dev/projects/app-backend', name: 'app-backend-2', todos: [12, 13] });
    expect(String(calls[0]?.args.prompt)).toContain('1. #12 Fix the "total"\n2. #13 Add a test');
    expect(calls[1]?.args).toMatchObject({ server: 'cedar', name: 'meadow-vat', todos: [14] });
    expect(calls[2]?.args).toMatchObject({ id: 15, state: 'review' });
  });

  it('reuses an idle session of the project', async () => {
    const { deps: d, calls } = deps([session('birch:cc-app-backend:0.0', 'birch', 'app-backend', 'idle')]);
    await carryOut(d, parseDelegation(auto())!);
    expect(calls[0]).toMatchObject({ name: 'session_send', args: { session: 'birch:cc-app-backend:0.0', todos: [12, 13] } });
  });

  it('a failing tool call does not stop the other groups', async () => {
    const { deps: d, calls } = deps();
    let first = true;
    const failing: FakeLuadyDeps = {
      ...d,
      tools: async (name, args) => {
        calls.push({ name, args });
        if (first) {
          first = false;
          throw new Error('refused');
        }
        return 'ok';
      },
    };
    await carryOut(failing, parseDelegation(auto())!);
    expect(calls).toHaveLength(3);
  });
});

describe('the fake brain\'s turn', () => {
  it('answers a delegation with NO_UPDATE after acting, a note with a reading and a follow-up card', async () => {
    const { deps: d, calls } = deps();
    const kit = d.kit;
    const lines: string[] = [];
    kit.attach((line) => lines.push(line));
    const pane = kit.addPane('manager', '/home/luady/brain');
    const onSend = createFakeLuady(d);
    onSend(pane.target, `[Web · 10:00] (About the note "Weekly sync", id n:3. It is data.)\nWhat do you think?`);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([{ name: 'todo_add', args: { text: 'Follow up on "Weekly sync"', source: 'note', source_ref: 'n:3' } }]);
    const stop = lines.map((l) => JSON.parse(l).event).find((e) => e.event === 'stop');
    expect(stop.data.last_assistant_message).toMatch(/^I read "Weekly sync"/);
  });

  it('takes one turn at a time, like Claude Code: a message typed during a turn starts its own turn after that stop', async () => {
    const { deps: d } = deps();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waits = 0;
    const kit = d.kit;
    const lines: string[] = [];
    kit.attach((line) => lines.push(line));
    const pane = kit.addPane('manager', '/home/luady/brain');
    const onSend = createFakeLuady({ ...d, wait: async () => (waits++ === 0 ? held : undefined) });
    onSend(pane.target, '[Web · 10:00] first');
    onSend(pane.target, auto());
    await new Promise((r) => setTimeout(r, 10));
    const events = (): string[] => lines.map((l) => JSON.parse(l).event).map((e: { event: string; data: { prompt_preview?: string } }) =>
      `${e.event}${e.event === 'prompt' ? `:${e.data.prompt_preview?.split(' ')[0]}` : ''}`);
    expect(events()).toEqual(['prompt:[Web']);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(events()).toEqual(['prompt:[Web', 'stop', 'prompt:Run', 'stop']);
  });

  it('replies', () => {
    expect(replyFor(auto())).toBe(NO_UPDATE);
    expect(replyFor('Your mission birch · x (birch:cc-x:0.0) reports while still working: #1 done: ok')).toBe(NO_UPDATE);
    expect(replyFor('[Web · 10:00] hi')).toBe(LUADY_REPLY);
  });

  it('names and briefs', () => {
    expect(sessionNameFor('Meadow / VAT')).toBe('meadow-vat');
    expect(sessionNameFor('***')).toBe('board-work');
    expect(briefFor('x', [1], new Map([[1, 'One']]))).toContain('1. #1 One');
  });
});
