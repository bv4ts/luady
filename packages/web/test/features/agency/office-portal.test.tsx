import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OFFICE_TOKENS_CLASS } from '../../../src/features/agency/OfficePortal.js';
import { DragChip } from '../../../src/features/agency/give/DragChip.js';
import { GivePicker } from '../../../src/features/agency/give/GivePicker.js';
import { giveTargets } from '../../../src/features/agency/give/targets.js';
import { RoomChips } from '../../../src/features/agency/hud/RoomChips.js';
import { Modal } from '../../../src/ui/Modal.js';
import { server } from '../../fixtures.js';
import { classicRoomDtos } from '../../room-fixtures.js';
import { snapshotOf } from './agency-fixtures.js';

/**
 * The office tokens (--agency-*) are custom properties defined in agency.css; a pop-up portalled to <body> leaves
 * `.agency` and sees none of them unless it lands in an element that defines them too. jsdom computes no custom
 * properties from a stylesheet, so this checks the structure: where the tokens are defined, and where every office
 * pop-up is rendered.
 */
// Not `new URL(..., import.meta.url)`: Vite rewrites that pattern into an asset lookup (see test/ui/primitives.test.tsx).
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

/** The selectors of the agency.css rule that defines the office tokens. */
function tokenSelectors(): string[] {
  const css = read('features/agency/agency.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]+)\{[^}]*--agency-panel:/.exec(css);
  return (rule?.[1] ?? '').split(',').map((selector) => selector.trim()).filter(Boolean);
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(join(SRC, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(SRC, path)).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Rendered inside the office page's themed element, as the office renders it. */
const inOffice = (ui: ReactElement) => render(<main className="agency">{ui}</main>);

/** Portalled out of `.agency`, into the element that carries the tokens. */
function expectTokens(node: HTMLElement): void {
  expect(node.closest('.agency')).toBeNull();
  expect(node.closest(`.${OFFICE_TOKENS_CLASS}`)?.parentElement).toBe(document.body);
}

describe('office pop-ups outside .agency keep the office tokens', () => {
  it('agency.css defines the tokens on the portal element as on .agency, and on the shared toasts and modal backdrop', () => {
    expect(tokenSelectors()).toEqual(expect.arrayContaining([
      '.agency', `.${OFFICE_TOKENS_CLASS}`, 'body:has(.agency) .toasts', 'body:has(.agency) .modal-backdrop',
    ]));
  });

  it('the Rooms menu renders its panel into the token element', () => {
    inOffice(<RoomChips snapshot={snapshotOf()} focus={{ kind: 'all' }} dispatch={() => undefined} />);
    fireEvent.click(screen.getByTestId('rooms-menu-button'));
    expectTokens(screen.getByTestId('rooms-menu'));
  });

  it('Give to… renders its sheet into the token element', () => {
    const rooms = classicRoomDtos();
    const targets = giveTargets(rooms, rooms.map((room) => server({ name: room.host ?? room.id })), []);
    inOffice(<GivePicker label="card #4" targets={targets} busy={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expectTokens(screen.getByTestId('give-picker'));
  });

  it('the drag chip renders into the token element', () => {
    const state = { phase: 'dragging', load: { what: [], label: 'card #4' }, pointerId: 1, x: 400, y: 300, target: null } as const;
    inOffice(<DragChip state={state} sessions={[]} rooms={classicRoomDtos()} />);
    expectTokens(screen.getByTestId('give-chip'));
  });

  it('a shared dialog opened from the office lands in the modal backdrop, which carries the tokens', () => {
    inOffice(<Modal open title="Remove mars" onClose={vi.fn()}><p>Sure?</p></Modal>);
    const backdrop = screen.getByRole('dialog', { name: 'Remove mars' }).closest('.modal-backdrop');
    expect(backdrop?.parentElement).toBe(document.body);
  });

  it('no office, rooms or hosts component portals on its own: every createPortal there is OfficePortal', () => {
    const portalling = ['features/agency', 'features/rooms', 'features/hosts']
      .flatMap(sourcesUnder)
      .filter((path) => /\bcreatePortal\s*\(/.test(read(path)))
      .map((path) => relative(SRC, join(SRC, path)).replaceAll('\\', '/'));
    expect(portalling).toEqual(['features/agency/OfficePortal.tsx']);
  });
});
