import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NamePlates } from '../../../../src/features/agency/hud/NamePlates.js';
import { LUADY_PLATE_PX, PLATE_MIN_PX, applyPoints, createPlateRegistry } from '../../../../src/features/agency/hud/plates.js';
import { LUADY_ACTOR_ID, type OverlayPoint, type StageFocus } from '../../../../src/features/agency/stage-types.js';
import { agent, askOf, snapshotOf } from '../agency-fixtures.js';

const point = (id: string, x: number, footY: number, visible = true, maxWidth = 120): OverlayPoint =>
  ({ kind: 'actor', id, x, y: footY - 40, footY, maxWidth, visible, scale: 2 });
const ALL: StageFocus = { kind: 'all' };

function nodes(...ids: string[]): Map<string, HTMLElement> {
  return new Map(ids.map((id) => [id, document.createElement('button')]));
}

describe('applyPoints', () => {
  it('hangs each plate from its foot point with a translate3d transform, no wider than the gap to the next desk', () => {
    const map = nodes('a', 'b');
    applyPoints(map, [point('a', 10.4, 20.6, true, 90.7), point('b', -3, 7)]);
    expect(map.get('a')?.style.transform).toMatch(/^translate3d\(10px, 21px, 0(px)?\)$/);
    expect(map.get('a')?.style.maxWidth).toBe('90px');
    expect(map.get('b')?.style.transform).toMatch(/^translate3d\(-3px, 7px, 0(px)?\)$/);
    expect(map.get('a')?.hidden).toBe(false);
  });

  it('hides agent plates where the desks are too close for a readable name; Luady, who has no neighbours, keeps his', () => {
    const map = nodes('agent', 'manager');
    map.get('agent')!.dataset.plate = 'agent';
    map.get('manager')!.dataset.plate = 'manager';
    applyPoints(map, [point('agent', 5, 5, true, PLATE_MIN_PX - 1), point('manager', 9, 9, true, 17)]);
    expect(map.get('agent')?.hidden).toBe(true);
    expect(map.get('manager')?.hidden).toBe(false);
    expect(map.get('manager')?.style.maxWidth).toBe(`${LUADY_PLATE_PX}px`);
    applyPoints(map, [point('agent', 5, 5, true, PLATE_MIN_PX)]);
    expect(map.get('agent')?.hidden).toBe(false);
  });

  it('hides plates whose point is missing or invisible, and shows them again', () => {
    const map = nodes('a', 'b');
    applyPoints(map, [point('a', 1, 1, false)]);
    expect(map.get('a')?.hidden).toBe(true);
    expect(map.get('b')?.hidden).toBe(true);
    applyPoints(map, [point('a', 5, 5), point('b', 6, 6)]);
    expect(map.get('a')?.hidden).toBe(false);
    expect(map.get('b')?.hidden).toBe(false);
  });

  it('ignores points for unknown ids and points that are not numbers', () => {
    const map = nodes('a');
    expect(() => applyPoints(map, [point('ghost', 1, 1), point('a', Number.NaN, 4)])).not.toThrow();
    expect(map.size).toBe(1);
    expect(map.get('a')?.hidden).toBe(true);
  });
});

describe('NamePlates', () => {
  const show = (snapshot = snapshotOf(), focus: StageFocus = ALL, selectedId: string | null = null) => {
    const registry = createPlateRegistry();
    const view = render(<NamePlates snapshot={snapshot} focus={focus} selectedId={selectedId} registry={registry} onSelect={vi.fn()} />);
    return { registry, view };
  };
  const ids = (registry: ReturnType<typeof createPlateRegistry>): string[] => [...registry.nodes.keys()].sort();

  it('at the whole office shows plates only for agents waiting for the owner and for Luady, hidden until placed', () => {
    const { registry } = show();
    expect(ids(registry)).toEqual(['ash:harbor-web', LUADY_ACTOR_ID]);
    expect([...registry.nodes.values()].every((plate) => plate.hidden)).toBe(true);
    expect(registry.nodes.get('ash:harbor-web')?.dataset.plate).toBe('agent');
    expect(registry.nodes.get(LUADY_ACTOR_ID)?.dataset.plate).toBe('manager');
  });

  it('adds everyone in the focused room, and the selected agent', () => {
    const room = show(snapshotOf(), { kind: 'room', room: 'birch' });
    expect(ids(room.registry)).toEqual(['ash:harbor-web', 'birch:app-backend', 'birch:jira-1105', LUADY_ACTOR_ID]);
    room.view.unmount();
    const picked = show(snapshotOf(), { kind: 'actor', id: 'cedar:meadow-vat' }, 'cedar:meadow-vat');
    expect(ids(picked.registry)).toEqual(['ash:harbor-web', 'cedar:meadow-vat', LUADY_ACTOR_ID]);
  });

  it('uses the small plate in a 20-desk room', () => {
    const crowd = Array.from({ length: 13 }, (_, i) => agent('cedar', `g${String(i).padStart(2, '0')}`));
    const { registry } = show(snapshotOf({ sessions: crowd, questions: [] }), { kind: 'room', room: 'cedar' });
    expect(registry.nodes.get('cedar:g00')?.classList.contains('agency-plate--tight')).toBe(true);
    expect(registry.nodes.get(LUADY_ACTOR_ID)?.classList.contains('agency-plate--tight')).toBe(false);
  });

  it('marks guests in italics and agents that need the owner', () => {
    const sessions = [
      agent('birch', 'meadow-vat-guest', { project: 'meadow-vat' }),
      agent('birch', 'asker', { state: 'waiting_permission', pendingQid: 'QPERM001' }),
    ];
    const { registry } = show(snapshotOf({ sessions, questions: [askOf('birch:asker', 'QPERM001')] }), { kind: 'room', room: 'birch' });
    expect(registry.nodes.get('birch:meadow-vat-guest')?.classList.contains('agency-plate--guest')).toBe(true);
    expect(registry.nodes.get('birch:asker')?.classList.contains('agency-plate--needs')).toBe(true);
    expect(registry.nodes.get('birch:asker')?.getAttribute('aria-label')).toBe('asker, waiting for you');
  });

  it('places a plate that mounts after the last frame and forgets plates that unmount', () => {
    const registry = createPlateRegistry();
    registry.last = [point('birch:late', 40, 50)];
    const focus: StageFocus = { kind: 'room', room: 'birch' };
    const plates = (sessions: Parameters<typeof snapshotOf>[0]) =>
      <NamePlates snapshot={snapshotOf(sessions)} focus={focus} selectedId={null} registry={registry} onSelect={vi.fn()} />;
    const { rerender } = render(plates({ sessions: [] }));
    rerender(plates({ sessions: [agent('birch', 'late')] }));
    const late = registry.nodes.get('birch:late');
    expect(late?.hidden).toBe(false);
    expect(late?.style.transform).toMatch(/^translate3d\(40px, 50px/);
    rerender(plates({ sessions: [] }));
    expect(registry.nodes.has('birch:late')).toBe(false);
  });

  it('selects the agent when its plate is clicked', async () => {
    const registry = createPlateRegistry();
    const onSelect = vi.fn();
    render(<NamePlates snapshot={snapshotOf()} focus={{ kind: 'room', room: 'cedar' }} selectedId={null} registry={registry} onSelect={onSelect} />);
    applyPoints(registry.nodes, [point('cedar:meadow-vat', 100, 100)]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'meadow-vat, failed' }));
    expect(onSelect).toHaveBeenCalledWith('cedar:meadow-vat');
  });
});
