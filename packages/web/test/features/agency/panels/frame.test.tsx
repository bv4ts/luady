import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelFrame } from '../../../../src/features/agency/panels/PanelFrame.js';
import { panelMode, stageInsets } from '../../../../src/features/agency/panels/insets.js';

const original = { width: window.innerWidth, height: window.innerHeight };

function resize(width: number, height: number) {
  act(() => {
    window.innerWidth = width;
    window.innerHeight = height;
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => {
  window.innerWidth = original.width;
  window.innerHeight = original.height;
});

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      {open ? (
        <PanelFrame label="Orchard room" onClose={() => { onClose(); setOpen(false); }}>
          <p>inside</p>
          <button type="button">inner action</button>
        </PanelFrame>
      ) : null}
    </>
  );
}

describe('stageInsets', () => {
  it('reserves the top bar and the chat line when no panel is open', () => {
    expect(stageInsets({ width: 1280, height: 800 }, false)).toEqual({ top: 56, right: 0, bottom: 64, left: 0 });
    expect(stageInsets({ width: 390, height: 844 }, false)).toEqual({ top: 100, right: 0, bottom: 64, left: 0 });
  });

  it('adds the 360 px dock on a PC and the 56% sheet on a phone', () => {
    expect(stageInsets({ width: 1280, height: 800 }, true)).toEqual({ top: 56, right: 360, bottom: 64, left: 0 });
    expect(stageInsets({ width: 390, height: 844 }, true)).toEqual({ top: 100, right: 0, bottom: 473, left: 0 });
  });

  it('switches at 760 px', () => {
    expect(panelMode(760)).toBe('dock');
    expect(panelMode(759)).toBe('sheet');
  });
});

describe('PanelFrame', () => {
  it('docks on the right on a wide screen and becomes a bottom sheet on a phone', async () => {
    resize(1280, 800);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'open' }));
    const panel = screen.getByRole('dialog', { name: 'Orchard room' });
    expect(panel.className).toContain('agency-panel--dock');
    resize(390, 844);
    expect(panel.className).toContain('agency-panel--sheet');
  });

  it('moves focus into the panel when it opens and back when it closes with Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'open' });
    await user.click(opener);
    const panel = screen.getByRole('dialog', { name: 'Orchard room' });
    expect(panel.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes with its close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps pointer and wheel events from reaching anything behind it', async () => {
    const behind = vi.fn();
    window.addEventListener('pointerdown', behind);
    window.addEventListener('pointerup', behind);
    window.addEventListener('wheel', behind);
    try {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'open' }));
      behind.mockClear();
      const inner = screen.getByText('inside');
      fireEvent.pointerDown(inner);
      fireEvent.pointerUp(inner);
      fireEvent.wheel(inner);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('pointerdown', behind);
      window.removeEventListener('pointerup', behind);
      window.removeEventListener('wheel', behind);
    }
  });
});
