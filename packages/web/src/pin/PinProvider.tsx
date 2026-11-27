import { PIN_RE } from '@luady/shared';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { pinDigits } from '../lib/digits.js';
import { Button } from '../ui/Button.js';
import { TextField } from '../ui/Field.js';
import { Modal } from '../ui/Modal.js';
import { pinNotice, type PinNotice } from './pin-notice.js';

export interface PinRequest {
  readonly title: string;
  readonly detail?: string;
  /** true = tier 1: ask before calling. false = call first, ask only on 428 pin_required. */
  readonly require: boolean;
}

export type PinOperation<T> = (pin: string | undefined) => Promise<T>;

export interface PinContextValue {
  runPinned<T>(op: PinOperation<T>, request: PinRequest): Promise<T | null>;
}

interface PinView {
  readonly title: string;
  readonly detail: string | null;
  readonly notice: PinNotice | null;
  readonly busy: boolean;
}

interface PendingPin {
  attempt(pin: string): Promise<void>;
  cancel(): void;
}

const PinContext = createContext<PinContextValue | null>(null);

export function mustPin(pin: string | undefined): string {
  if (pin === undefined) throw new Error('A PIN is required for this action.');
  return pin;
}

function PinDialog({ view, onSubmit, onCancel }: { view: PinView; onSubmit: (pin: string) => void; onCancel: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const blocked = view.notice?.kind === 'locked' || view.notice?.kind === 'not_set';

  useEffect(() => {
    if (view.notice?.kind !== 'invalid') return;
    setPin('');
    inputRef.current?.focus();
  }, [view.notice]);

  function submit() {
    if (!PIN_RE.test(pin)) {
      setError('Enter your 6–12 digit PIN.');
      return;
    }
    setError(null);
    onSubmit(pin);
  }

  const footer = blocked ? (
    <Button variant="secondary" onClick={onCancel}>Got it</Button>
  ) : (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={view.busy}>Cancel</Button>
      <Button type="submit" form={formId} variant="primary" icon="lock" busy={view.busy}>Confirm</Button>
    </>
  );

  return (
    <Modal open title={view.title} onClose={onCancel} initialFocusRef={inputRef} footer={footer}>
      <form id={formId} className="stack" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {view.detail ? <p className="text-muted mono" dir="auto">{view.detail}</p> : null}
        {view.notice ? (
          <p className={view.notice.kind === 'required' ? 'text-muted' : 'form-error'} role="alert">{view.notice.message}</p>
        ) : null}
        <TextField ref={inputRef} label="PIN" type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={12}
          value={pin} disabled={blocked || view.busy} error={error}
          onChange={(event) => setPin(pinDigits(event.target.value))} />
      </form>
    </Modal>
  );
}

/** One modal at a time: opening a new request cancels the previous one (it resolves null). */
function usePinModal() {
  const [view, setView] = useState<PinView | null>(null);
  const pending = useRef<PendingPin | null>(null);

  const openModal = useCallback(<T,>(op: PinOperation<T>, request: PinRequest, notice: PinNotice | null) =>
    new Promise<T | null>((resolve, reject) => {
      pending.current?.cancel();
      const finish = (): boolean => {
        if (pending.current !== entry) return false;
        pending.current = null;
        setView(null);
        return true;
      };
      const entry: PendingPin = {
        attempt: async (pin) => {
          setView((current) => (current ? { ...current, busy: true, notice: null } : current));
          try {
            const value = await op(pin);
            if (finish()) resolve(value);
          } catch (err) {
            const next = pinNotice(err);
            if (next && pending.current === entry) {
              setView((current) => (current ? { ...current, busy: false, notice: next } : current));
            } else if (finish()) {
              reject(err);
            }
          }
        },
        cancel: () => {
          finish();
          resolve(null);
        },
      };
      pending.current = entry;
      setView({ title: request.title, detail: request.detail ?? null, notice, busy: false });
    }), []);

  const submit = useCallback((pin: string) => {
    void pending.current?.attempt(pin);
  }, []);
  const cancel = useCallback(() => pending.current?.cancel(), []);
  return { view, openModal, submit, cancel };
}

export function PinProvider({ children }: { children: ReactNode }) {
  const { view, openModal, submit, cancel } = usePinModal();

  const runPinned = useCallback(async <T,>(op: PinOperation<T>, request: PinRequest): Promise<T | null> => {
    if (request.require) return openModal(op, request, null);
    try {
      return await op(undefined);
    } catch (err) {
      const notice = pinNotice(err);
      if (!notice) throw err;
      return openModal(op, request, notice.kind === 'required' ? null : notice);
    }
  }, [openModal]);
  const value = useMemo<PinContextValue>(() => ({ runPinned }), [runPinned]);

  return (
    <PinContext value={value}>
      {children}
      {view ? <PinDialog view={view} onSubmit={submit} onCancel={cancel} /> : null}
    </PinContext>
  );
}

export function usePin(): PinContextValue {
  const value = useContext(PinContext);
  if (!value) throw new Error('usePin must be used inside <PinProvider>');
  return value;
}
