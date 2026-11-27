import { describe, expect, it } from 'vitest';
import { diffActors } from '../../../../src/features/agency/scene/reconcile.js';
import { many, session, snap } from './office-fixtures.js';

const kinds = (changes: readonly { kind: string }[]): string[] => changes.map((c) => c.kind);

describe('diffActors', () => {
  it('enters everyone on first load', () => {
    const first = snap([...many('birch', 2), ...many('cedar', 1)]);
    const changes = diffActors(null, first);
    expect(kinds(changes)).toEqual(['enter', 'enter', 'enter']);
    expect(changes.map((c) => (c.kind === 'enter' ? c.actor.id : '')).sort()).toEqual(['birch:s00', 'birch:s01', 'cedar:s00']);
  });

  it('returns nothing when nothing changed', () => {
    const a = snap(many('birch', 3));
    expect(diffActors(a, snap(many('birch', 3), { previous: a }))).toEqual([]);
    expect(diffActors(a, a)).toEqual([]);
  });

  it('enters a new session and leaves an ended one', () => {
    const a = snap([session('birch:a'), session('birch:b')]);
    const b = snap([session('birch:a'), session('birch:c')], { previous: a });
    const changes = diffActors(a, b);
    expect(changes).toContainEqual({ kind: 'leave', id: 'birch:b' });
    expect(changes).toContainEqual({ kind: 'enter', actor: b.actors['birch:c'] });
    expect(changes).toHaveLength(2);
  });

  it('moves an actor whose seat changed, including a new desk arrangement at the same seat number', () => {
    const twelve = snap(many('cedar', 12));
    const thirteen = snap(many('cedar', 13), { previous: twelve });
    const changes = diffActors(twelve, thirteen);
    const moved = changes.filter((c) => c.kind === 'move').map((c) => (c.kind === 'move' ? c.actor.id : ''));
    expect(moved).toHaveLength(12);
    expect(changes).toContainEqual({ kind: 'enter', actor: thirteen.actors['cedar:s12'] });
    expect(twelve.actors['cedar:s00']?.seat).toBe(thirteen.actors['cedar:s00']?.seat);
  });

  it('restyles an actor whose state changed in place', () => {
    const a = snap([session('ash:a')]);
    const b = snap([session('ash:a', { state: 'waiting_permission' })], { previous: a });
    expect(diffActors(a, b)).toEqual([{ kind: 'restyle', actor: b.actors['ash:a'] }]);
  });

  it('carries the new look on a move, so one change covers a seat and a state change', () => {
    const a = snap(many('birch', 12));
    const b = snap([...many('birch', 12, { state: 'idle' }), session('birch:zz')], { previous: a });
    const move = diffActors(a, b).find((c) => c.kind === 'move' && c.actor.id === 'birch:s03');
    expect(move).toEqual({ kind: 'move', actor: b.actors['birch:s03'] });
  });
});

describe('diffActors: helpers and strain', () => {
  it('restyles when only the helpers changed, and nothing when the inputs are equal', () => {
    const a = snap([session('birch:a')]);
    const b = snap([session('birch:a')], { previous: a, helpers: { 'birch:a': 2 } });
    expect(diffActors(a, b)).toEqual([{ kind: 'restyle', actor: b.actors['birch:a'] }]);
    const c = snap([session('birch:a')], { previous: b, helpers: { 'birch:a': 2 } });
    expect(diffActors(b, c)).toEqual([]);
  });

  it('restyles when the strain mark comes or goes', () => {
    const a = snap([session('birch:a')], { contextPct: { 'birch:a': 50 } });
    const b = snap([session('birch:a')], { previous: a, contextPct: { 'birch:a': 95 } });
    expect(diffActors(a, b)).toEqual([{ kind: 'restyle', actor: b.actors['birch:a'] }]);
  });
});
