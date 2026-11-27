import { describe, expect, it } from 'vitest';
import { INITIAL_UI, reduceAgencyUi, type AgencyUi, type ModalState } from '../../../../src/features/agency/model/ui-state.js';
import { LUADY_ACTOR_ID, type StageEvent } from '../../../../src/features/agency/stage-types.js';

const stage = (state: AgencyUi, event: StageEvent): AgencyUi => reduceAgencyUi(state, { type: 'stage', event });
const agentOpen: AgencyUi = { focus: { kind: 'actor', id: 'birch:a' }, selectedId: 'birch:a', panel: 'agent', menu: null, modal: null };

describe('reduceAgencyUi: stage events', () => {
  it('starts on the whole office with nothing open', () => {
    expect(INITIAL_UI).toEqual({ focus: { kind: 'all' }, selectedId: null, panel: null, menu: null, modal: null });
  });

  it('a room tap focuses the room, opens its panel and clears the selection', () => {
    expect(stage(agentOpen, { type: 'room', room: 'cedar' }))
      .toEqual({ focus: { kind: 'room', room: 'cedar' }, selectedId: null, panel: 'room', menu: null, modal: null });
  });

  it('a tap outside returns to the whole office and closes panels', () => {
    expect(stage(agentOpen, { type: 'room', room: null })).toEqual(INITIAL_UI);
  });

  it('an actor tap selects, focuses and opens the agent panel', () => {
    expect(stage(INITIAL_UI, { type: 'actor', id: 'cedar:b' }))
      .toEqual({ focus: { kind: 'actor', id: 'cedar:b' }, selectedId: 'cedar:b', panel: 'agent', menu: null, modal: null });
  });

  it('a tap on Luady opens the Luady panel', () => {
    expect(stage(INITIAL_UI, { type: 'actor', id: LUADY_ACTOR_ID }).panel).toBe('manager');
  });

  it('a menu event opens the menu at that point and selects the actor, keeping the rest', () => {
    const roomOpen = stage(INITIAL_UI, { type: 'room', room: 'birch' });
    const next = stage(roomOpen, { type: 'menu', id: 'birch:a', x: 120, y: 80 });
    expect(next).toEqual({ ...roomOpen, selectedId: 'birch:a', menu: { id: 'birch:a', x: 120, y: 80 } });
    expect(next.focus).toBe(roomOpen.focus);
  });

  it('a rack tap focuses the room and opens the rack panel', () => {
    expect(stage(agentOpen, { type: 'fixture', fixture: 'rack', id: 'rack-ash', room: 'ash' }))
      .toEqual({ focus: { kind: 'room', room: 'ash' }, selectedId: null, panel: 'rack', menu: null, modal: null });
  });

  it('hover changes nothing', () => {
    expect(stage(agentOpen, { type: 'hover', id: 'birch:a', fixture: null, x: 1, y: 2 })).toBe(agentOpen);
  });

  it('keeps the same focus object when the focus did not change', () => {
    const roomOpen = stage(INITIAL_UI, { type: 'room', room: 'birch' });
    const rack = stage(roomOpen, { type: 'fixture', fixture: 'rack', id: 'rack-birch', room: 'birch' });
    expect(rack.focus).toBe(roomOpen.focus);
  });
});

describe('reduceAgencyUi: owner actions', () => {
  it('focus on a room opens that room, focus on all closes everything', () => {
    expect(reduceAgencyUi(INITIAL_UI, { type: 'focus', focus: { kind: 'room', room: 'cedar' } }))
      .toEqual({ focus: { kind: 'room', room: 'cedar' }, selectedId: null, panel: 'room', menu: null, modal: null });
    expect(reduceAgencyUi(agentOpen, { type: 'focus', focus: { kind: 'all' } })).toEqual(INITIAL_UI);
  });

  it('select opens the agent; select(null) drops the selection and its panel', () => {
    expect(reduceAgencyUi(INITIAL_UI, { type: 'select', id: 'birch:a' })).toEqual(agentOpen);
    expect(reduceAgencyUi(agentOpen, { type: 'select', id: null }))
      .toEqual({ focus: { kind: 'actor', id: 'birch:a' }, selectedId: null, panel: null, menu: null, modal: null });
  });

  it('close shuts the menu first, then the panel, then returns to the whole office', () => {
    const withMenu: AgencyUi = { ...agentOpen, menu: { id: 'birch:a', x: 1, y: 1 } };
    const first = reduceAgencyUi(withMenu, { type: 'close' });
    expect(first).toEqual(agentOpen);
    const second = reduceAgencyUi(first, { type: 'close' });
    expect(second).toEqual({ focus: { kind: 'actor', id: 'birch:a' }, selectedId: null, panel: null, menu: null, modal: null });
    expect(reduceAgencyUi(second, { type: 'close' })).toEqual(INITIAL_UI);
    expect(reduceAgencyUi(INITIAL_UI, { type: 'close' })).toBe(INITIAL_UI);
  });

  it('next-need selects the need after the current one and wraps', () => {
    const needs = ['a', 'b', 'c'];
    const first = reduceAgencyUi(INITIAL_UI, { type: 'next-need', needs });
    expect(first.selectedId).toBe('a');
    expect(first.panel).toBe('agent');
    const second = reduceAgencyUi(first, { type: 'next-need', needs });
    expect(second.selectedId).toBe('b');
    expect(second.focus).toEqual({ kind: 'actor', id: 'b' });
    const third = reduceAgencyUi(second, { type: 'next-need', needs });
    expect(reduceAgencyUi(third, { type: 'next-need', needs }).selectedId).toBe('a');
    expect(reduceAgencyUi(agentOpen, { type: 'next-need', needs: [] })).toBe(agentOpen);
  });

  it('gone drops a selection, menu or focus that points at a removed actor', () => {
    const withMenu: AgencyUi = { ...agentOpen, menu: { id: 'birch:a', x: 1, y: 1 } };
    expect(reduceAgencyUi(withMenu, { type: 'gone', ids: ['birch:a'] })).toEqual(INITIAL_UI);
    const roomMenu: AgencyUi = { focus: { kind: 'room', room: 'birch' }, selectedId: 'birch:b', panel: 'room', menu: { id: 'birch:b', x: 0, y: 0 }, modal: null };
    expect(reduceAgencyUi(roomMenu, { type: 'gone', ids: ['birch:b'] }))
      .toEqual({ focus: { kind: 'room', room: 'birch' }, selectedId: null, panel: 'room', menu: null, modal: null });
    expect(reduceAgencyUi(agentOpen, { type: 'gone', ids: ['other'] })).toBe(agentOpen);
  });
});

describe('reduceAgencyUi: the note popover', () => {
  const withMenu: AgencyUi = { ...agentOpen, menu: { id: 'birch:a', x: 30, y: 40 } };

  it('opens at the menu point, closing the menu and keeping the agent', () => {
    const next = reduceAgencyUi(withMenu, { type: 'note', id: 'birch:a', x: 30, y: 40 });
    expect(next).toEqual({ ...agentOpen, note: { id: 'birch:a', x: 30, y: 40 } });
  });

  it('Esc closes the note first, then the panel', () => {
    const noted = reduceAgencyUi(withMenu, { type: 'note', id: 'birch:a', x: 30, y: 40 });
    const first = reduceAgencyUi(noted, { type: 'close' });
    expect(first.note).toBeUndefined();
    expect(first.panel).toBe('agent');
    expect(reduceAgencyUi(first, { type: 'close' }).panel).toBeNull();
  });

  it('gone closes a note whose agent left, and keeps one whose agent is still here', () => {
    const noted = reduceAgencyUi(withMenu, { type: 'note', id: 'birch:a', x: 30, y: 40 });
    expect(reduceAgencyUi(noted, { type: 'gone', ids: ['birch:a'] }).note).toBeUndefined();
    const roomNote = reduceAgencyUi(reduceAgencyUi(INITIAL_UI, { type: 'focus', focus: { kind: 'room', room: 'birch' } }),
      { type: 'note', id: 'birch:b', x: 1, y: 1 });
    expect(reduceAgencyUi(roomNote, { type: 'gone', ids: ['birch:c'] })).toBe(roomNote);
    expect(reduceAgencyUi(roomNote, { type: 'gone', ids: ['birch:b'] }).note).toBeUndefined();
  });
});

describe('reduceAgencyUi: drawers', () => {
  it('open shows a drawer over what was open, and close goes back to it', () => {
    const drawer = reduceAgencyUi(agentOpen, { type: 'open', panel: 'accounts' });
    expect(drawer.panel).toBe('accounts');
    expect(drawer.selectedId).toBe('birch:a');
    const back = reduceAgencyUi(drawer, { type: 'close' });
    expect(back.panel).toBe('agent');
    expect(back.selectedId).toBe('birch:a');
    expect(reduceAgencyUi(back, { type: 'close' }).panel).toBeNull();
  });

  it('a drawer opened over nothing closes to nothing', () => {
    const drawer = reduceAgencyUi(INITIAL_UI, { type: 'open', panel: 'notices' });
    expect(drawer.panel).toBe('notices');
    expect(reduceAgencyUi(drawer, { type: 'close' })).toEqual(INITIAL_UI);
  });

  it('one drawer replaces another and still goes back to the panel under both', () => {
    const accountsOpen = reduceAgencyUi(agentOpen, { type: 'open', panel: 'accounts' });
    const notices = reduceAgencyUi(accountsOpen, { type: 'open', panel: 'notices' });
    expect(notices.panel).toBe('notices');
    expect(reduceAgencyUi(notices, { type: 'close' }).panel).toBe('agent');
    expect(reduceAgencyUi(accountsOpen, { type: 'open', panel: 'accounts' })).toBe(accountsOpen);
  });
});

describe('reduceAgencyUi: pop-ups', () => {
  const fixture = (kind: 'board' | 'library' | 'notes' | 'jira' | 'fuse' | 'tv', room = 'hq'): StageEvent =>
    ({ type: 'fixture', fixture: kind, id: `${kind}-${room}`, room });

  it('board, library and notes fixtures open their pop-up over the open panel', () => {
    for (const kind of ['board', 'library', 'notes'] as const) {
      const next = stage(agentOpen, fixture(kind));
      expect(next.modal).toEqual({ kind });
      expect(next.panel).toBe('agent');
      expect(next.selectedId).toBe('birch:a');
    }
  });

  it('the Jira fixture opens the Jira pop-up of its room', () => {
    expect(stage(INITIAL_UI, fixture('jira', 'birch')).modal).toEqual({ kind: 'jira', room: 'birch' });
  });

  it('the fuse box opens the accounts drawer', () => {
    const fuse = stage(agentOpen, fixture('fuse'));
    expect(fuse.panel).toBe('accounts');
    expect(fuse.under).toBe('agent');
    expect(fuse.modal).toBeNull();
  });

  it('modal opens with its details and the same one twice keeps the state', () => {
    const modal: ModalState = { kind: 'board', itemId: 12 };
    const open = reduceAgencyUi(INITIAL_UI, { type: 'modal', modal });
    expect(open.modal).toEqual(modal);
    expect(reduceAgencyUi(open, { type: 'modal', modal: { kind: 'board', itemId: 12 } })).toBe(open);
    expect(reduceAgencyUi(open, { type: 'modal', modal: { kind: 'notes', noteId: 'n:4' } }).modal).toEqual({ kind: 'notes', noteId: 'n:4' });
  });

  it('opening a pop-up closes the menu and keeps a drawer and the panel under it', () => {
    const withMenu: AgencyUi = { ...agentOpen, menu: { id: 'birch:a', x: 1, y: 1 } };
    expect(reduceAgencyUi(withMenu, { type: 'modal', modal: { kind: 'activity' } }).menu).toBeNull();
    const drawer = reduceAgencyUi(agentOpen, { type: 'open', panel: 'accounts' });
    const over = reduceAgencyUi(drawer, { type: 'modal', modal: { kind: 'library' } });
    expect(over.panel).toBe('accounts');
    expect(over.under).toBe('agent');
  });

  it('Esc order: note box, menu, pop-up, drawer, panel, office', () => {
    const drawer = reduceAgencyUi(agentOpen, { type: 'open', panel: 'notices' });
    const popped = reduceAgencyUi(drawer, { type: 'modal', modal: { kind: 'board' } });
    const noted = reduceAgencyUi(reduceAgencyUi(popped, { type: 'stage', event: { type: 'menu', id: 'birch:a', x: 5, y: 5 } }),
      { type: 'note', id: 'birch:a', x: 5, y: 5 });
    const withMenu = reduceAgencyUi(popped, { type: 'stage', event: { type: 'menu', id: 'birch:a', x: 5, y: 5 } });

    const afterNote = reduceAgencyUi(noted, { type: 'close' });
    expect(afterNote.note).toBeUndefined();
    expect(afterNote.modal).toEqual({ kind: 'board' });
    const afterMenu = reduceAgencyUi(withMenu, { type: 'close' });
    expect(afterMenu.menu).toBeNull();
    expect(afterMenu.modal).toEqual({ kind: 'board' });
    const afterModal = reduceAgencyUi(afterMenu, { type: 'close' });
    expect(afterModal.modal).toBeNull();
    expect(afterModal.panel).toBe('notices');
    const afterDrawer = reduceAgencyUi(afterModal, { type: 'close' });
    expect(afterDrawer.panel).toBe('agent');
    const afterPanel = reduceAgencyUi(afterDrawer, { type: 'close' });
    expect(afterPanel.panel).toBeNull();
    expect(reduceAgencyUi(afterPanel, { type: 'close' })).toEqual(INITIAL_UI);
  });

  it('modal.close closes only the pop-up', () => {
    const open = reduceAgencyUi(agentOpen, { type: 'modal', modal: { kind: 'notes' } });
    expect(reduceAgencyUi(open, { type: 'modal.close' })).toEqual(agentOpen);
    expect(reduceAgencyUi(agentOpen, { type: 'modal.close' })).toBe(agentOpen);
  });

  it('map taps and lost agents leave an open pop-up alone', () => {
    const open = reduceAgencyUi(agentOpen, { type: 'modal', modal: { kind: 'board' } });
    expect(stage(open, { type: 'room', room: 'cedar' }).modal).toEqual({ kind: 'board' });
    expect(reduceAgencyUi(open, { type: 'gone', ids: ['birch:a'] }).modal).toEqual({ kind: 'board' });
  });
});

describe('reduceAgencyUi: fleet, today, schedule, wins, help and links pop-ups', () => {
  const press = (fixture: 'tv' | 'clock' | 'schedule' | 'wins' | 'robot' | 'links', room = 'hq'): AgencyUi =>
    stage(agentOpen, { type: 'fixture', fixture, id: `${fixture}-${room}`, room });

  it.each([
    ['tv', 'fleet'],
    ['clock', 'timeline'],
    ['schedule', 'schedule'],
    ['wins', 'wins'],
    ['robot', 'help'],
  ] as const)('the %s fixture opens the %s pop-up over the open panel', (fixture, kind) => {
    const next = press(fixture);
    expect(next.modal).toEqual({ kind });
    expect(next.panel).toBe('agent');
  });

  it('a links board opens the links shelf of its own room', () => {
    expect(press('links', 'cedar').modal).toEqual({ kind: 'links', room: 'cedar' });
    expect(press('links', 'ash').modal).toEqual({ kind: 'links', room: 'ash' });
  });

  it('the new pop-ups open from an action too, and Esc closes them like the others', () => {
    const open = reduceAgencyUi(INITIAL_UI, { type: 'modal', modal: { kind: 'schedule' } });
    expect(open.modal).toEqual({ kind: 'schedule' });
    expect(reduceAgencyUi(open, { type: 'close' })).toEqual(INITIAL_UI);
  });
});
