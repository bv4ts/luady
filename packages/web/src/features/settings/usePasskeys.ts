import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { isApiError, userMessage } from '../../api/errors.js';
import type { PasskeyEntry } from '../../api/schemas.js';
import { useAuth } from '../../auth/AuthContext.js';
import { defaultPasskeyLabel, passkeyErrorMessage, registerPasskey } from '../../auth/passkeys.js';
import { ownerDateTime } from '../../lib/format.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';

/** Deleting the last passkey → 409 refused. */
export const LAST_PASSKEY_MESSAGE = "You can't delete your only passkey. Add another passkey first.";

export type PasskeyBusy = { readonly kind: 'add' } | { readonly kind: 'delete'; readonly id: string } | null;

function usePasskeyList() {
  const api = useApi();
  const [items, setItems] = useState<readonly PasskeyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems((await api.passkeys()).items);
      setError(null);
    } catch (err) {
      setError(userMessage(err));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, error, reload };
}

export function usePasskeys() {
  const api = useApi();
  const { refreshMe } = useAuth();
  const { toast } = useStore();
  const { runPinned } = usePin();
  const { items, error, reload } = usePasskeyList();
  const [busy, setBusy] = useState<PasskeyBusy>(null);

  /** refreshMe first: deleting the passkey behind this session revokes it and the gate signs the owner out. */
  const settle = useCallback(async (message: string) => {
    toast('success', message);
    await refreshMe();
    await reload();
  }, [refreshMe, reload, toast]);

  const add = useCallback(async (label: string) => {
    setBusy({ kind: 'add' });
    try {
      const added = await runPinned(async (pin) => {
        await registerPasskey(api, { pin: mustPin(pin) }, label.trim() || defaultPasskeyLabel());
        return true;
      }, { require: true, title: 'Add a passkey', detail: 'Registers a passkey on this device for signing in to Luady.' });
      if (added) await settle('Passkey added');
    } catch (err) {
      toast('error', passkeyErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [api, runPinned, settle, toast]);

  const remove = useCallback(async (passkey: PasskeyEntry) => {
    setBusy({ kind: 'delete', id: passkey.id });
    try {
      const done = await runPinned((pin) => api.deletePasskey(passkey.id, { pin: mustPin(pin) }),
        { require: true, title: 'Delete passkey', detail: `${passkey.label} · added ${ownerDateTime(passkey.createdAt)}` });
      if (done) await settle(`Deleted the passkey "${passkey.label}"`);
    } catch (err) {
      toast('error', isApiError(err) && err.status === 409 ? LAST_PASSKEY_MESSAGE : userMessage(err));
    } finally {
      setBusy(null);
    }
  }, [api, runPinned, settle, toast]);

  return { items, error, busy, add, remove };
}
