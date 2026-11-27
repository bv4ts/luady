import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api/errors.js';
import { looksLikePin, normalizeDigits, pinDigits } from '../../src/lib/digits.js';
import { PinProvider, usePin, type PinOperation } from '../../src/pin/PinProvider.js';
import { pinNotice } from '../../src/pin/pin-notice.js';

function Harness({ op, require }: { op: PinOperation<string>; require: boolean }) {
  const { runPinned } = usePin();
  const [result, setResult] = useState('idle');
  async function go() {
    try {
      const value = await runPinned(op, { title: 'Run command on cedar', detail: 'systemctl restart nginx', require });
      setResult(value ?? 'cancelled');
    } catch (err) {
      setResult(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return (
    <div>
      <button type="button" onClick={() => void go()}>Run</button>
      <output data-testid="result">{result}</output>
    </div>
  );
}

function setup(op: PinOperation<string>, require = false) {
  const user = userEvent.setup();
  render(<PinProvider><Harness op={op} require={require} /></PinProvider>);
  return { user };
}

const result = () => screen.getByTestId('result').textContent;

async function enterPin(user: ReturnType<typeof userEvent.setup>, pin: string) {
  await user.type(await screen.findByLabelText('PIN'), pin);
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
}

describe('PinProvider', () => {
  it('428 pin_required opens the modal and retries with the PIN', async () => {
    const op = vi.fn<PinOperation<string>>(async (pin) => {
      if (pin === undefined) throw new ApiError(428, 'pin_required', 'PIN required');
      return `ran with ${pin}`;
    });
    const { user } = setup(op);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run command on cedar' });
    expect(dialog.textContent).toContain('systemctl restart nginx');
    const field = await screen.findByLabelText('PIN');
    // A browser offers to save a password field, not a one-time code; phones show the number pad.
    expect([field.getAttribute('type'), field.getAttribute('autocomplete'), field.getAttribute('inputmode')])
      .toEqual(['password', 'one-time-code', 'numeric']);
    await enterPin(user, '123456');
    await waitFor(() => expect(result()).toBe('ran with 123456'));
    expect(op.mock.calls.map((call) => call[0])).toEqual([undefined, '123456']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('403 pin_invalid shows the remaining tries and allows another try', async () => {
    const op = vi.fn<PinOperation<string>>(async (pin) => {
      if (pin === '111111') throw new ApiError(403, 'pin_invalid', 'Wrong PIN', { remaining: 2 });
      return 'approved';
    });
    const { user } = setup(op, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await enterPin(user, '111111');
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong PIN — 2 tries left.');
    expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('');
    await enterPin(user, '222222');
    await waitFor(() => expect(result()).toBe('approved'));
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('423 pin_locked shows the lock time and disables the input', async () => {
    const op = vi.fn<PinOperation<string>>(async () => {
      throw new ApiError(423, 'pin_locked', 'PIN locked until 2026-10-09T12:30:00.000Z', { until: '2026-10-09T12:30:00.000Z' });
    });
    const { user } = setup(op, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await enterPin(user, '123456');
    expect((await screen.findByRole('alert')).textContent).toBe('Too many wrong PINs. Locked until 16:30 (owner time).');
    expect((screen.getByLabelText('PIN') as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(result()).toBe('cancelled'));
  });

  it('asks for the PIN before calling a tier-1 action', async () => {
    const op = vi.fn<PinOperation<string>>(async (pin) => `ok ${pin}`);
    const { user } = setup(op, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(op).not.toHaveBeenCalled();
    await enterPin(user, '654321');
    await waitFor(() => expect(result()).toBe('ok 654321'));
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed PINs without calling the hub', async () => {
    const op = vi.fn<PinOperation<string>>(async () => 'never');
    const { user } = setup(op, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await enterPin(user, '12');
    expect((await screen.findByRole('alert')).textContent).toBe('Enter your 6–12 digit PIN.');
    expect(op).not.toHaveBeenCalled();
  });

  it('closes and rethrows errors that are not about the PIN', async () => {
    const op = vi.fn<PinOperation<string>>(async () => {
      throw new ApiError(502, 'failed', 'ssh timeout');
    });
    const { user } = setup(op, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await enterPin(user, '123456');
    await waitFor(() => expect(result()).toBe('error: ssh timeout'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains when no PIN is set yet', async () => {
    const op = vi.fn<PinOperation<string>>(async () => {
      throw new ApiError(428, 'pin_not_set', 'PIN is not set');
    });
    const { user } = setup(op);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No PIN is set yet. Reload Luady to finish setup.');
    expect(screen.queryByRole('link')).toBeNull();
    expect((screen.getByLabelText('PIN') as HTMLInputElement).disabled).toBe(true);
  });

  it('resolves null when cancelled', async () => {
    const op = vi.fn<PinOperation<string>>(async () => 'never');
    const { user } = setup(op, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(result()).toBe('cancelled'));
    expect(op).not.toHaveBeenCalled();
  });

  it('accepts Arabic-Indic digits in the PIN field', async () => {
    const op = vi.fn<PinOperation<string>>(async (pin) => `ok ${pin}`);
    const { user } = setup(op, true);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await enterPin(user, '١٢٣٤٥٦');
    await waitFor(() => expect(result()).toBe('ok 123456'));
  });
});

describe('digit normalization', () => {
  it('maps Arabic-Indic digits and the Arabic comma to ASCII', () => {
    expect(normalizeDigits('١،٣')).toBe('1,3');
    expect(normalizeDigits('۱۲۳')).toBe('123');
    expect(pinDigits('١٢ ٣٤-۵۶')).toBe('123456');
    expect(looksLikePin(' ٦٥٤٣٢١ ')).toBe(true);
    expect(looksLikePin('check cedar disk')).toBe(false);
  });
});

describe('pinNotice', () => {
  it('reads remaining tries and lock times from the error body fields', () => {
    expect(pinNotice(new ApiError(403, 'pin_invalid', 'Wrong PIN', { remaining: 1 }))?.message).toBe('Wrong PIN — 1 try left.');
    expect(pinNotice(new ApiError(403, 'pin_invalid', 'Wrong PIN', { remaining: 0 }))).toEqual({
      kind: 'locked', message: 'Wrong PIN. PIN entry is now locked. Try again later.',
    });
    expect(pinNotice(new ApiError(423, 'pin_locked', 'PIN locked until 2026-10-09T20:00:00.000Z', { until: '2026-10-09T20:00:00.000Z' }))?.message)
      .toBe('Too many wrong PINs. Locked until 00:00 (owner time).');
    expect(pinNotice(new ApiError(409, 'refused', 'nope'))).toBeNull();
    expect(pinNotice(new Error('plain'))).toBeNull();
  });

  it('never parses the message text', () => {
    expect(pinNotice(new ApiError(403, 'pin_invalid', 'Wrong PIN (1 try left)'))?.message).toBe('Wrong PIN. Try again.');
    expect(pinNotice(new ApiError(423, 'pin_locked', 'PIN locked until 2026-10-09T20:00:00.000Z'))?.message)
      .toBe('Too many wrong PINs. PIN entry is locked for now.');
  });
});
