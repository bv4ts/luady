import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Badge, StateBadge } from '../../src/ui/Badge.js';
import { Button } from '../../src/ui/Button.js';
import { Switch, TextField } from '../../src/ui/Field.js';
import { Modal } from '../../src/ui/Modal.js';
import { Segmented } from '../../src/ui/Segmented.js';
import { serverTone } from '../../src/ui/tones.js';

// Not `new URL(`...${name}`, import.meta.url)`: Vite rewrites that pattern into an asset lookup and the
// test would read itself instead of the stylesheet.
const stylesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/styles');
const css = (name: string): string => readFileSync(resolve(stylesDir, name), 'utf8');

describe('design tokens', () => {
  it('define light and dark palettes with every session state color', () => {
    const tokens = css('tokens.css');
    expect(tokens).toMatch(/@media \(prefers-color-scheme: dark\)/);
    for (const state of ['working', 'waiting', 'idle', 'error', 'ended', 'starting']) {
      expect(tokens.match(new RegExp(`--state-${state}-fg:`, 'g'))?.length).toBe(2);
      expect(tokens.match(new RegExp(`--state-${state}-bg:`, 'g'))?.length).toBe(2);
    }
    expect(tokens).toMatch(/prefers-reduced-motion: reduce/);
  });

  it('never pull external fonts or assets', () => {
    for (const name of ['tokens.css', 'base.css', 'components.css']) {
      expect(css(name)).not.toMatch(/@import|url\(|https?:\/\//);
    }
  });
});

describe('badges', () => {
  it('label waiting sessions as needing the owner', () => {
    render(<StateBadge state="waiting_question" />);
    expect(screen.getByText('Needs you').closest('.badge')?.className).toContain('tone-waiting');
  });

  it('mark working sessions with the working tone', () => {
    render(<StateBadge state="working" />);
    expect(screen.getByText('Working').closest('.badge')?.className).toContain('tone-working');
  });

  it('take a tone for other statuses', () => {
    render(<Badge tone={serverTone('offline')}>offline</Badge>);
    expect(screen.getByText('offline').closest('.badge')?.className).toContain('tone-error');
  });
});

describe('Button', () => {
  it('disables itself and announces the busy state', () => {
    render(<Button busy>Save</Button>);
    const button = screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('fields', () => {
  it('link the label, hint and error to the input', () => {
    render(<TextField label="Folder" hint="Inside /home/dev/projects" error="Required" value="" onChange={() => undefined} />);
    const input = screen.getByLabelText('Folder');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['Inside /home/dev/projects', 'Required']);
  });

  it('switch reports the next value', async () => {
    const onChange = vi.fn();
    render(<Switch label="Away mode" description="Report every finished turn" checked={false} onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Away mode' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

function ModalHarness({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Modal open title="Confirm with PIN" onClose={onClose} initialFocusRef={inputRef} footer={<button type="button">Last</button>}>
      <input ref={inputRef} aria-label="PIN" />
    </Modal>
  );
}

describe('Modal', () => {
  it('is a labelled dialog that focuses the requested field and closes on Escape', async () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Confirm with PIN' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('PIN'));
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<ModalHarness onClose={() => undefined} />);
    screen.getByRole('button', { name: 'Last' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });
});

describe('Segmented', () => {
  it('works as a tab list', async () => {
    function Harness() {
      const [value, setValue] = useState<'chat' | 'memory'>('chat');
      return (
        <Segmented label="Luady views" value={value} onChange={setValue}
          options={[{ value: 'chat', label: 'Chat' }, { value: 'memory', label: 'Memory' }]} />
      );
    }
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Memory' }));
    expect(screen.getByRole('tab', { name: 'Memory' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('false');
  });
});
