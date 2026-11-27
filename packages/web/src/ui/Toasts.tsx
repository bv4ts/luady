import { useCallback, useEffect } from 'react';
import type { Toast } from '../state/reducer.js';
import { useStore } from '../state/store.js';
import { Icon } from './Icon.js';

const TOAST_MS = 6000;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);
  const icon = toast.kind === 'error' ? 'alert' : toast.kind === 'success' ? 'check' : 'message';
  return (
    <div className={`toast toast--${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <p className="toast__text" dir="auto">{toast.text}</p>
      <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
        <Icon name="x" />
      </button>
    </div>
  );
}

export function Toasts() {
  const { state, dispatch } = useStore();
  const dismiss = useCallback((id: number) => dispatch({ type: 'toast.dismiss', id }), [dispatch]);
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}
    </div>
  );
}
