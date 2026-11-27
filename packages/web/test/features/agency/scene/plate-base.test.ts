import { describe, expect, it } from 'vitest';
import { plateBase } from '../../../../src/features/agency/scene/plate-base.js';
import { session, snap } from './office-fixtures.js';

const office = snap([session('birch:a')]);
const view = office.actors['birch:a']!;
const luadyDesk = office.props.find((p) => p.kind === 'luadydesk') ?? null;
const at = (x: number, y: number) => Object.freeze({ x, y });

describe('plateBase', () => {
  it('puts a seated agent’s plate under the front of its desk', () => {
    const a = { id: view.id, view, pos: view.sit, walk: null, index: 0, leaving: false, wait: 0 };
    expect(plateBase(a, { luadyDesk })).toBe(view.desk.y + 18);
  });

  it('puts a walker’s plate just under its feet', () => {
    const walk = { points: [view.sit], speed: 0.066 };
    expect(plateBase({ id: view.id, view, pos: at(100, 200), walk, index: 0, leaving: false, wait: 0 }, { luadyDesk })).toBe(202);
    expect(plateBase({ id: view.id, view, pos: view.sit, walk: null, index: 0, leaving: true, wait: 0 }, { luadyDesk })).toBe(view.sit.y + 2);
  });

  it('puts Luady’s plate under his desk', () => {
    const luady = { id: 'manager', view: null, pos: office.map.spots.luadySit, walk: null, index: 0, leaving: false, wait: 0 };
    expect(plateBase(luady, { luadyDesk })).toBe((luadyDesk?.y ?? 0) + 34);
    expect(plateBase(luady, { luadyDesk: null })).toBe(office.map.spots.luadySit.y + 2);
  });
});
