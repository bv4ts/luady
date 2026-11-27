import { buildOffice, fixturesFor } from '@luady/office';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyPage } from '../../../../src/features/agency/AgencyPage.js';
import { HoverTip } from '../../../../src/features/agency/hud/HoverTip.js';
import { TOP_BAR_PX } from '../../../../src/features/agency/panels/insets.js';
import { BADGE_HALF_PX, BADGE_SLIDE_MAP_PX, PLAQUE_GAP_PX, PLAQUE_INSET_PX, PLAQUE_MIN_SCALE, WALL_GAP_PX, pinSpot } from '../../../../src/features/agency/hud/map-pins.js';
import { createFeed } from '../../../../src/features/agency/model/feed.js';
import { fixtureBadges, fixtureTip, plaqueWallRun, roomPlaques, roomWords, type FixtureBadgeInput } from '../../../../src/features/agency/model/map-labels.js';
import { newMeetings } from '../../../../src/features/agency/model/useNewNotes.js';
import type { OverlayPoint, StageEvent } from '../../../../src/features/agency/stage-types.js';
import { NOW } from '../../../fixtures.js';
import { fakeApi } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { agent, fleetOverview, snapshotOf } from '../agency-fixtures.js';
import { resetStageSpy, stageProps } from '../stage-mock.js';
import { classicRoomDtos } from '../../../room-fixtures.js';

vi.mock('../../../../src/features/agency/scene/AgencyStage.js', () => import('../stage-mock.js'));

const NONE: FixtureBadgeInput = { board: null, newNotes: 0, energy: null, jira: {} };
const snapshot = snapshotOf({ jiraRooms: ['birch', 'cedar'] });

describe('fixture badges', () => {
  it('the board shows to do + needs you, red while anything needs the owner', () => {
    const badges = fixtureBadges(snapshot, { ...NONE, board: { count: 6, tone: 'alert', words: '5 to do, 1 needs you' } });
    expect(badges['board-hq']).toEqual({ text: '6', tone: 'alert', words: '5 to do, 1 needs you' });
  });

  it('the notes desk counts new meeting notes', () => {
    expect(fixtureBadges(snapshot, { ...NONE, newNotes: 2 })['notes-hq']).toEqual({ text: '2', tone: 'info', words: '2 new meeting notes' });
    expect(fixtureBadges(snapshot, { ...NONE, newNotes: 1 })['notes-hq']?.words).toBe('1 new meeting note');
  });

  it("the fuse box takes its tone from the fullest account's 5-hour limit", () => {
    const energy = (usedPct: number, tone: 'ok' | 'amber' | 'red') => ({ accountId: 'a', label: 'cedar', usedPct, tone, resetsAt: NOW });
    expect(fixtureBadges(snapshot, { ...NONE, energy: energy(40, 'ok') })['fuse-hq']).toEqual({ text: '40%', tone: 'info', words: 'cedar 40% of its 5-hour limit' });
    expect(fixtureBadges(snapshot, { ...NONE, energy: energy(88, 'amber') })['fuse-hq']?.tone).toBe('warn');
    expect(fixtureBadges(snapshot, { ...NONE, energy: energy(97, 'red') })['fuse-hq']?.tone).toBe('alert');
  });

  it("a Jira board shows its office's tickets that need attention", () => {
    const badges = fixtureBadges(snapshot, { ...NONE, jira: { birch: 3, cedar: 0 } });
    expect(badges['jira-birch']).toEqual({ text: '3', tone: 'warn', words: '3 tickets need attention' });
    expect(badges['jira-cedar']).toBeUndefined();
  });

  it('nothing to say, no badge', () => {
    expect(fixtureBadges(snapshot, NONE)).toEqual({});
  });

  it('the tooltip says the fixture and its badge', () => {
    const badges = fixtureBadges(snapshot, { ...NONE, board: { count: 6, tone: 'alert', words: '5 to do, 1 needs you' } });
    expect(fixtureTip(snapshot, badges, 'board-hq')).toBe('Board · 5 to do, 1 needs you');
    expect(fixtureTip(snapshot, badges, 'library-hq')).toBe('Library');
    expect(fixtureTip(snapshot, badges, 'nothing-here')).toBeNull();
  });
});

describe('room plaques', () => {
  it('say the room and what its agents do, only what is not zero', () => {
    expect(roomWords(3, 1)).toBe('3 working · 1 needs you');
    expect(roomWords(0, 2)).toBe('2 need you');
    expect(roomWords(1, 0)).toBe('1 working');
    expect(roomWords(0, 0)).toBe('');
  });

  it('one per room that is not an empty slot', () => {
    const plaques = roomPlaques(snapshotOf({ sessions: [agent('birch', 'a'), agent('birch', 'b'), agent('birch', 'c', { state: 'idle' })] }));
    expect(plaques.map((plaque) => plaque.name)).toContain('Luady HQ');
    expect(plaques.find((plaque) => plaque.key === 'birch')).toEqual({ key: 'birch', name: 'Orchard', words: '2 working', needs: false });
    expect(plaques.some((plaque) => plaque.name === 'Vacant')).toBe(false);
  });
});

describe('pin placement', () => {
  const point = (over: Partial<OverlayPoint>): OverlayPoint => ({ kind: 'room', id: 'birch', x: 100, y: 80, footY: 80, maxWidth: 300, visible: true, scale: 1.4, ...over });

  it('a plaque sits inside its room corner and no wider than the room', () => {
    expect(pinSpot(point({}), 'plaque')).toEqual({ x: 100 + PLAQUE_INSET_PX, y: 80 + PLAQUE_INSET_PX, maxWidth: 300 - 2 * PLAQUE_INSET_PX });
    expect(pinSpot(point({ scale: PLAQUE_MIN_SCALE - 0.1 }), 'plaque')).toBeNull();
    // A server room's plaque hangs on the wall just above the floor corner.
    expect(pinSpot(point({}), 'wall')).toEqual({ x: 100 + PLAQUE_INSET_PX, y: 80 - WALL_GAP_PX, maxWidth: 300 - 2 * PLAQUE_INSET_PX });
    // An east room is mirrored: its plaque hangs at the far end of the wall.
    expect(pinSpot(point({}), 'wall-end')?.x).toBe(100 + 300 - PLAQUE_INSET_PX);
  });

  it("a badge sits on the top-right corner of its fixture's picture", () => {
    expect(pinSpot(point({ kind: 'fixture', x: 200, y: 40, maxWidth: 60 }), 'badge')).toEqual({ x: 230, y: 40, maxWidth: null });
    // A dot (the TV's alarm) sits on the top-centre, clear of the neighbours' badges.
    expect(pinSpot(point({ kind: 'fixture', x: 200, y: 40, maxWidth: 60 }), 'dot')).toEqual({ x: 200, y: 40, maxWidth: null });
  });

  it('a badge stays fully visible between the bars, sliding down along its fixture', () => {
    const band = { top: 56, bottom: 700 };
    const badge = (y: number, scale = 2) => pinSpot(point({ kind: 'fixture', x: 200, y, maxWidth: 60, scale }), 'badge', band);
    expect(badge(300)?.y).toBe(300);
    // Under the top bar: pushed down just below it.
    expect(badge(50)?.y).toBe(band.top + BADGE_HALF_PX + 2);
    // Above the chat bar: pulled up.
    expect(badge(698)?.y).toBe(band.bottom - BADGE_HALF_PX - 2);
    // A fixture entirely under the top bar has nothing to slide along: no badge.
    expect(badge(56 - BADGE_SLIDE_MAP_PX * 2 - 20)).toBeNull();
  });

  it('nothing for a hidden or broken point', () => {
    expect(pinSpot(point({ visible: false }), 'badge')).toBeNull();
    expect(pinSpot(point({ x: Number.NaN }), 'plaque')).toBeNull();
    expect(pinSpot(undefined, 'plaque')).toBeNull();
  });
});

describe('new meeting notes', () => {
  it('counts meeting notes after the last visit, not typed notes', () => {
    const at = (ms: number) => new Date(ms).toISOString();
    expect(newMeetings([{ kind: 'meeting', at: at(2_000) }, { kind: 'note', at: at(3_000) }, { kind: 'meeting', at: at(500) }], 1_000)).toBe(1);
  });
});

describe('the hover tip on a fixture', () => {
  it("shows the fixture's label and badge words", () => {
    const feed = createFeed<StageEvent>();
    const badges = fixtureBadges(snapshot, { ...NONE, newNotes: 2 });
    render(<HoverTip snapshot={snapshot} feed={feed} badges={badges} />);
    act(() => feed.emit({ type: 'hover', id: null, fixture: 'notes-hq', x: 300, y: 200 }));
    expect(screen.getByRole('tooltip').textContent).toBe('Notes · 2 new meeting notes');
    act(() => feed.emit({ type: 'hover', id: null, fixture: null, x: 0, y: 0 }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('plaques, badges and top-bar tools on the page', () => {
  beforeEach(() => {
    resetStageSpy();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function openOffice() {
    const item = {
      title: 't', details: '', project: null, server: null, source: 'web' as const, sourceRef: null, today: false, priority: 0 as const,
      auto: false, runId: null, sessionId: null, result: null, createdAt: NOW, updatedAt: NOW, doneAt: null, dueAt: null, snoozeUntil: null,
    };
    const api = fakeApi({
      luadyMessages: async () => ({ items: [], nextCursor: null }),
      board: async () => ({ items: [{ ...item, id: 1, state: 'open' }, { ...item, id: 2, state: 'review' }] }),
    });
    const harness = await renderPage(<AgencyPage />, { api, overview: fleetOverview() });
    await screen.findByTestId('agency-stage');
    return harness;
  }

  it('the Board button counts to do + needs you, and opens the Board', async () => {
    await openOffice();
    const board = await screen.findByRole('button', { name: 'Board, 1 to do, 1 needs you' });
    expect(board.querySelector('.agency-count--alert')?.textContent).toBe('2');
    fireEvent.click(board);
    expect(await screen.findByRole('dialog', { name: 'Board' })).toBeTruthy();
  });

  it('places plaques and the board badge from the frame points', async () => {
    await openOffice();
    act(() => stageProps().onFrame([
      { kind: 'room', id: 'birch', x: 30, y: 70, footY: 70, maxWidth: 380, visible: true, scale: 1.4 },
      { kind: 'fixture', id: 'board-hq', x: 700, y: 60, footY: 60, maxWidth: 200, visible: true, scale: 1.4 },
    ]));
    const plaque = screen.getAllByTestId('room-plaque').find((node) => node.getAttribute('data-room') === 'birch');
    expect(plaque?.textContent).toContain('Orchard');
    expect(plaque?.style.transform).toBe(`translate3d(${30 + PLAQUE_INSET_PX}px, ${70 - WALL_GAP_PX}px, 0px)`);
    const badge = await screen.findByTestId('fixture-badge');
    expect(badge.getAttribute('data-fixture')).toBe('board-hq');
    expect(badge.textContent).toBe('2');
    // At y 60 the chip would be half under the top bar: it slides down along its fixture to stay visible.
    expect(badge.style.transform).toBe(`translate3d(800px, ${TOP_BAR_PX + BADGE_HALF_PX + 2}px, 0px)`);
    // A room the frame does not show yet stays hidden.
    expect(screen.getAllByTestId('room-plaque').find((node) => node.getAttribute('data-room') === 'ash')?.hidden).toBe(true);
  });

  it('the activity pill opens the Activity pop-up, and a row opens the agent', async () => {
    const { user } = await openOffice();
    const pill = screen.getByTestId('activity-pill');
    expect(pill.getAttribute('aria-label')).toBe('1 working. Show activity');
    await user.click(pill);
    await user.click(await screen.findByRole('button', { name: /^app-backend in Orchard/ }));
    expect(screen.queryByRole('dialog', { name: 'Activity' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'app-backend' })).toBeTruthy();
  });
});

describe('a plaque leaves the wall fixtures of its room visible', () => {
  const office = { map: buildOffice(classicRoomDtos()), fixtures: fixturesFor(buildOffice(classicRoomDtos()), { jiraRooms: ['birch'] }) };

  it('a west room\'s plaque runs from the corner to its first wall fixture; an east room\'s back from the far end', () => {
    // cedar (south-west): the links board starts at map x 188, the room's inside at 32.
    expect(plaqueWallRun(office, 'cedar', 'wall')).toBe(188 - 32);
    // local (south-east): the plaque hangs at the far end; the links board ends at 1122, the inside at 1312.
    expect(plaqueWallRun(office, 'local', 'wall-end')).toBe(1312 - 1122);
    expect(plaqueWallRun(office, 'hq', 'plaque')).toBeUndefined();
  });

  it('pinSpot narrows the plaque to that run (inset and a small gap kept), never wider than the room', () => {
    const p: OverlayPoint = { kind: 'room', id: 'cedar', x: 20, y: 300, footY: 300, maxWidth: 300, visible: true, scale: 0.8 };
    expect(pinSpot(p, 'wall', undefined, 156)?.maxWidth).toBe(156 * 0.8 - PLAQUE_INSET_PX - PLAQUE_GAP_PX);
    expect(pinSpot(p, 'wall', undefined, 2000)?.maxWidth).toBe(300 - 2 * PLAQUE_INSET_PX);
  });
});
