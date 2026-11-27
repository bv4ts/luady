import { describe, expect, it } from 'vitest';
import { BoardItemDTOSchema, BoardItemDetailDTOSchema } from '@luady/shared';
import { NOT_PICKED_TEXT, QUEUED_TIMEOUT_MS, STOPPED_TEXT } from '../../src/board/index.js';
import { boardHarness, makeMission, makeSession } from './harness.js';

const SID = 'birch:cc-checkout:0.0';

describe('cards', () => {
  it('adds, edits, logs every change and broadcasts each one', async () => {
    const t = boardHarness();
    const card = await t.board.add({ title: '  Fix the   total ', details: 'Discount codes', project: 'orchard', server: 'birch', source: 'web' }, 'owner');
    expect(BoardItemDTOSchema.parse(card)).toMatchObject({ id: 1, title: 'Fix the total', state: 'open', source: 'web', auto: false });
    await t.board.update(1, { priority: 1, today: true }, 'owner');
    await t.board.update(1, { state: 'done' }, 'owner');
    await t.board.update(1, { state: 'open' }, 'owner');
    const detail = BoardItemDetailDTOSchema.parse(t.board.detail(1));
    expect(detail.events.map((event) => event.kind)).toEqual(['created', 'edited', 'done', 'reopened']);
    expect(detail.item).toMatchObject({ priority: 1, today: true, state: 'open', doneAt: null });
    expect(t.updated.map((items) => items.map((item) => item.state))).toEqual([['open'], ['open'], ['done'], ['open']]);
    await t.board.remove(1, 'owner');
    expect(t.removed).toEqual([[1]]);
    expect(t.board.get(1)).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM todo_events').get()).toEqual({ n: 0 });
  });

  it('refuses unknown cards and lane changes a card cannot make', async () => {
    const t = boardHarness();
    await expect(t.board.update(9, { title: 'x' }, 'owner')).rejects.toThrow(/No card #9/);
    await t.board.add({ title: 'Ship it', source: 'manager' }, 'manager');
    await t.board.update(1, { state: 'done' }, 'manager');
    await expect(t.board.update(1, { state: 'review' }, 'manager')).rejects.toThrow(/cannot go to review/);
  });

  it('lists everything not done plus done in the last 14 days, and lanes for todo_list', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Old done', source: 'web' }, 'owner');
    await t.board.update(1, { state: 'done' }, 'owner');
    t.clock.advance(15 * 24 * 60 * 60_000);
    await t.board.add({ title: 'Open one', source: 'web' }, 'owner');
    await t.board.add({ title: 'Running one', source: 'manager', sessionId: SID }, 'manager');
    await t.board.add({ title: 'Recent done', source: 'web' }, 'owner');
    await t.board.update(4, { state: 'done', result: 'Shipped' }, 'owner');
    expect(t.board.list().map((card) => card.id)).toEqual([3, 2, 4]);
    expect(t.board.find('open').map((card) => card.id)).toEqual([2]);
    expect(t.board.find('running').map((card) => card.id)).toEqual([3]);
    expect(t.board.find('done').map((card) => card.id)).toEqual([4]);
    expect(t.board.render('running')).toBe('Running (1):\n- #3 · Running one · running in birch/checkout');
    expect(t.board.render('done')).toContain('#4 · Recent done · done → Shipped');
    expect(t.board.render('review')).toBe('No card needs the owner.');
  });
});

describe('the chat to-do list follows the board', () => {
  it('a today card goes on the pinned list and ticks there; /todo leaves out snoozed and automatic cards', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Send the invoice', today: true, source: 'web' }, 'owner');
    expect(t.outbound.sent[0]?.text).toContain('☐ 1. Send the invoice');
    await t.board.add({ title: 'Call Sara', source: 'chat' }, 'owner');
    await t.board.update(2, { snoozeUntil: '2026-11-16T09:00:00.000Z' }, 'owner');
    t.missions.set(SID, makeMission());
    await t.emit('mission.updated', makeMission());
    expect(t.todos.render()).toBe('📝 *To-do*\n☐ 1. Send the invoice _(today)_');
    await t.board.update(1, { state: 'done' }, 'owner');
    expect(t.outbound.edits.at(-1)?.text).toContain('✅ ~Send the invoice~');
    expect(t.todos.render()).toBe('Your to-do list is empty.');
    t.clock.advance(25 * 60 * 60_000);
    expect(t.todos.render()).toBe('📝 *To-do*\n☐ 2. Call Sara');
  });

  it('the to-do service still ticks a to-do, and the board then shows it done', async () => {
    const t = boardHarness();
    const todo = await t.todos.add('Pay rent', false);
    await t.todos.done(todo.id);
    expect(t.board.get(todo.id)).toMatchObject({ state: 'done' });
  });
});

describe('rollback safety', () => {
  it('a card an older release ticked (done = 1 only) reads as done, and start() brings state in step', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Old release ticks this', source: 'web' }, 'owner');
    t.db.prepare('UPDATE todos SET done = 1, done_at = ? WHERE id = 1').run('2026-11-15T09:30:00.000Z');
    t.db.prepare("INSERT INTO todos (text, today, done, created_at) VALUES ('Old release adds this', 0, 0, ?)").run('2026-11-15T09:40:00.000Z');
    expect(t.board.get(1)).toMatchObject({ state: 'done', doneAt: '2026-11-15T09:30:00.000Z' });
    expect(t.board.get(2)).toMatchObject({ state: 'open', updatedAt: '2026-11-15T09:40:00.000Z', source: 'manager' });
    t.board.start();
    t.board.stop();
    t.board.start();
    expect(t.row(1)).toMatchObject({ state: 'done', done: 1 });
  });

  it('every lane change keeps done and done_at in step for the older release', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'Card', source: 'web' }, 'owner');
    await t.board.update(1, { state: 'done' }, 'owner');
    expect(t.row(1)).toMatchObject({ state: 'done', done: 1, done_at: '2026-11-15T09:00:00.000Z' });
    await t.board.update(1, { state: 'open' }, 'owner');
    expect(t.row(1)).toMatchObject({ state: 'open', done: 0, done_at: null });
  });
});

describe('automatic mission cards', () => {
  it('opens a card for a mission with no running card, renames it with the mission title, closes it at mission_done', async () => {
    const t = boardHarness();
    await t.emit('mission.updated', makeMission());
    expect(t.board.get(1)).toMatchObject({ title: 'Mission · birch · checkout', auto: true, state: 'running', sessionId: SID, server: 'birch', project: 'orchard' });
    await t.emit('mission.updated', makeMission({ phase: 'idle', turns: 1 }));
    expect(t.board.list()).toHaveLength(1);
    await t.emit('mission.updated', makeMission({ title: 'Fix checkout total' }));
    expect(t.board.get(1)?.title).toBe('Fix checkout total');
    await t.emit('mission.removed', { sessionId: SID, outcome: 'done', summary: `All fixed and tested. ${'y'.repeat(600)}` });
    expect(t.board.get(1)).toMatchObject({ state: 'done' });
    expect(t.board.get(1)?.result).toHaveLength(500);
  });

  it('an edited title stays; no card for missions Luady does not manage', async () => {
    const t = boardHarness();
    await t.emit('mission.updated', makeMission());
    await t.board.update(1, { title: 'My own name' }, 'owner');
    await t.emit('mission.updated', makeMission({ title: 'Mission title' }));
    expect(t.board.get(1)?.title).toBe('My own name');
    t.managed.clear();
    await t.emit('mission.updated', makeMission({ sessionId: 'cedar:cc-other:0.0' }));
    expect(t.board.list()).toHaveLength(1);
  });

  it('no automatic card when the session already runs a linked card; linking removes a stand-in card', async () => {
    const t = boardHarness();
    await t.emit('mission.updated', makeMission());
    await t.board.add({ title: 'ORC-1 Login', source: 'jira', sourceRef: 'birch:ORC-1' }, 'owner');
    await t.board.link(SID, [2]);
    expect(t.removed).toEqual([[1]]);
    await t.emit('mission.updated', makeMission({ title: 'Login' }));
    expect(t.board.list().map((card) => card.id)).toEqual([2]);
    expect(t.board.get(2)?.title).toBe('ORC-1 Login');
  });
  it('no automatic card when the linked cards of this mission were already reported done (the turn ends after its reports)', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'One', source: 'web' }, 'owner');
    await t.board.link(SID, [1]);
    await t.emit('mission.updated', makeMission());
    await t.emit('session.report', { session: makeSession(), text: '#1 done: shipped', replay: false });
    await t.emit('mission.updated', makeMission({ phase: 'idle', turns: 1 }));
    expect(t.board.list().map((card) => [card.id, card.state])).toEqual([[1, 'done']]);
  });
});

describe('cards still running when the work stops', () => {
  async function linked() {
    const t = boardHarness();
    await t.board.add({ title: 'One', source: 'web' }, 'owner');
    await t.board.add({ title: 'Two', source: 'web' }, 'owner');
    await t.board.link(SID, [1, 2]);
    return t;
  }

  it('mission_done marks them done with the start of Luady\'s summary (300 characters)', async () => {
    const t = await linked();
    await t.emit('session.report', { session: makeSession(), text: '#1 done: First one shipped', replay: false });
    await t.emit('mission.removed', { sessionId: SID, outcome: 'done', summary: `Both done and verified. ${'z'.repeat(400)}` });
    expect(t.board.get(1)).toMatchObject({ state: 'done', result: 'First one shipped' });
    expect(t.board.get(2)?.state).toBe('done');
    expect(t.board.get(2)?.result).toHaveLength(300);
  });

  it('the idle timer closing the mission leaves them running while the session is still there', async () => {
    const t = await linked();
    await t.emit('mission.removed', { sessionId: SID, outcome: 'done', summary: null });
    expect(t.board.find('running').map((card) => card.id).sort()).toEqual([1, 2]);
    expect(t.board.find('review')).toEqual([]);
  });

  it('the idle timer closing the mission of a session that is gone sends them to review', async () => {
    const t = await linked();
    t.sessions.set(SID, makeSession({ state: 'ended' }));
    await t.emit('mission.removed', { sessionId: SID, outcome: 'done', summary: null });
    expect(t.board.find('review').map((card) => card.id)).toEqual([2, 1]);
    expect(t.board.detail(1)?.events.at(-1)).toMatchObject({ kind: 'blocked', text: STOPPED_TEXT });
  });

  it('a session that ended sends them to review', async () => {
    const t = await linked();
    t.sessions.set(SID, makeSession({ state: 'ended' }));
    await t.emit('session.ended', { session: makeSession({ state: 'ended' }), unexpected: true, reason: 'pane_gone', replay: false });
    expect(t.board.find('review').map((card) => card.id)).toEqual([2, 1]);
    expect(t.board.get(1)?.result).toBeNull();
  });

  it('a failed turn, a replayed end, or an end the session survived leaves them running', async () => {
    const t = await linked();
    await t.emit('session.failed', { session: makeSession(), error: 'overloaded', replay: false });
    await t.emit('session.ended', { session: makeSession({ state: 'ended' }), unexpected: false, reason: 'other', replay: true });
    await t.emit('session.ended', { session: makeSession(), unexpected: false, reason: 'other', replay: false });
    expect(t.board.find('review')).toEqual([]);
    expect(t.board.find('running')).toHaveLength(2);
  });

  it('a card parked as stopped goes back to Running when its session reports progress', async () => {
    const t = await linked();
    t.sessions.set(SID, makeSession({ state: 'ended' }));
    await t.emit('session.ended', { session: makeSession({ state: 'ended' }), unexpected: true, reason: 'pane_gone', replay: false });
    t.sessions.set(SID, makeSession());
    await t.emit('session.report', { session: makeSession(), text: '#1 progress: designing the screens', replay: false });
    expect(t.board.get(1)?.state).toBe('running');
    expect(t.board.get(2)?.state).toBe('review');
  });

  it('at start, cards parked as stopped whose session is alive go back to Running', async () => {
    const t = await linked();
    t.sessions.set(SID, makeSession({ state: 'ended' }));
    await t.emit('session.ended', { session: makeSession({ state: 'ended' }), unexpected: true, reason: 'pane_gone', replay: false });
    t.sessions.set(SID, makeSession());
    t.board.stop();
    t.board.start();
    await t.settle();
    expect(t.board.find('running').map((card) => card.id).sort()).toEqual([1, 2]);
  });

  it('at start, a session keeps only its newest automatic mission card', async () => {
    const t = boardHarness();
    for (const title of ['Mission one', 'Mission two', 'Mission three']) await t.board.add({ title, source: 'manager', sessionId: SID }, 'hub');
    t.db.prepare("UPDATE todos SET auto = 1, state = 'running'").run();
    await t.board.add({ title: 'A real card', source: 'web' }, 'owner');
    t.board.stop();
    t.board.start();
    await t.settle();
    expect(t.board.list().map((card) => card.title).sort()).toEqual(['A real card', 'Mission three']);
  });

  it('a mission that ended with its session gone goes to review too', async () => {
    const t = await linked();
    t.sessions.set(SID, makeSession({ state: 'ended' }));
    await t.emit('mission.removed', { sessionId: SID, outcome: 'ended', summary: null });
    expect(t.board.find('review')).toHaveLength(2);
  });
});

describe('reports tick linked cards only', () => {
  it('done, blocked and progress, with any case and spacing, several lines; foreign and unknown ids change nothing', async () => {
    const t = boardHarness();
    for (const title of ['One', 'Two', 'Three', 'Other session']) await t.board.add({ title, source: 'web' }, 'owner');
    await t.board.link(SID, [1, 2, 3]);
    await t.board.link('cedar:cc-other:0.0', [4]);
    const text = ['Progress so far:', '#1 DONE : Login fixed', '  #2  blocked:needs the API key', '#3 progress: tests running', '#4 done: not yours', '#99 done: unknown'].join('\n');
    await t.emit('session.report', { session: makeSession(), text, replay: false });
    expect(t.board.get(1)).toMatchObject({ state: 'done', result: 'Login fixed' });
    expect(t.board.get(2)?.state).toBe('review');
    expect(t.board.detail(2)?.events.at(-1)).toMatchObject({ kind: 'blocked', text: 'needs the API key' });
    expect(t.board.get(3)?.state).toBe('running');
    expect(t.board.detail(3)?.events.at(-1)).toMatchObject({ kind: 'report', text: 'tests running' });
    expect(t.board.get(4)?.state).toBe('running');
    expect(t.board.get(99)).toBeNull();
  });

  it('a report never creates a card, and a done card stays done', async () => {
    const t = boardHarness();
    await t.emit('session.report', { session: makeSession(), text: '#1 done: ghost', replay: false });
    expect(t.board.list()).toEqual([]);
    await t.board.add({ title: 'One', source: 'web' }, 'owner');
    await t.board.link(SID, [1]);
    await t.emit('session.report', { session: makeSession(), text: '#1 done: first', replay: false });
    await t.emit('session.report', { session: makeSession(), text: '#1 blocked: late', replay: false });
    expect(t.board.get(1)).toMatchObject({ state: 'done', result: 'first' });
  });
});

describe('queued cards nobody took', () => {
  it(`go to review with "${NOT_PICKED_TEXT}" after 10 minutes of Luady being free`, async () => {
    const t = boardHarness();
    await t.board.add({ title: 'One', source: 'web' }, 'owner');
    await t.board.delegate({ what: [{ kind: 'todo', id: 1 }], to: { kind: 'auto' } });
    t.status.value = { ...t.status.value, state: 'busy' };
    t.clock.advance(QUEUED_TIMEOUT_MS + 1);
    await t.board.tick();
    expect(t.board.get(1)?.state).toBe('queued');
    t.status.value = { ...t.status.value, state: 'running' };
    await t.board.tick();
    t.clock.advance(QUEUED_TIMEOUT_MS - 1000);
    await t.board.tick();
    expect(t.board.get(1)?.state).toBe('queued');
    t.clock.advance(1000);
    await t.board.tick();
    expect(t.board.get(1)?.state).toBe('review');
    expect(t.board.detail(1)?.events.at(-1)).toMatchObject({ kind: 'blocked', text: NOT_PICKED_TEXT });
  });

  it('a card a session took in time stays running', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'One', source: 'web' }, 'owner');
    await t.board.delegate({ what: [{ kind: 'todo', id: 1 }], to: { kind: 'auto' } });
    await t.board.tick();
    await t.board.link(SID, [1]);
    t.clock.advance(QUEUED_TIMEOUT_MS * 2);
    await t.board.tick();
    expect(t.board.get(1)?.state).toBe('running');
  });
});

describe('briefFor', () => {
  it('names the cards and how to report them, and refuses an unknown card', async () => {
    const t = boardHarness();
    await t.board.add({ title: 'One', source: 'web' }, 'owner');
    await t.board.add({ title: 'Two', source: 'web' }, 'owner');
    expect(t.board.briefFor([1, 2, 1])).toBe(
      'Board items: #1, #2. Work through them in order. After each one, run `~/.luady/bin/luady-report "#1 done: <one line>"` '
      + '(with that item\'s number). If one is blocked, run `~/.luady/bin/luady-report "#1 blocked: <why>"` and carry on with the next.',
    );
    expect(() => t.board.briefFor([7])).toThrow(/No card #7/);
  });
});
