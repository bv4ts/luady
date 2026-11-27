import { useState } from 'react';
import { useApi } from '../../../api/context.js';
import { userMessage } from '../../../api/errors.js';
import { useStore } from '../../../state/store.js';
import { Icon } from '../../../ui/Icon.js';
import { pillText } from '../model/energy.js';
import { chatChannelName } from '../model/notice-text.js';

/**
 * Where Luady's updates go right now. A press sends them to the chat channel for the next hour (for walking away from
 * an open tab), or ends that hour, and says so in a toast (on a phone the pill is only its icon). Nothing at all while
 * the hub has not said (an older hub).
 */
export function UpdatesPill() {
  const api = useApi();
  const { state, dispatch, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const presence = state.presence;
  if (presence === null) return null;
  const forced = presence.forcedUntil !== null;
  const chat = chatChannelName(state.channels);
  const text = pillText(presence, new Date(), chat);

  async function toggle() {
    setBusy(true);
    try {
      const next = await api.setPresence({ chat: !forced });
      dispatch({ type: 'presence.loaded', presence: next });
      toast('info', next.forcedUntil === null ? 'Updates show here again.' : `${pillText(next, new Date(), chat)}.`);
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={`agency-pill-updates agency-pill-updates--${presence.mode}`} data-testid="updates-pill"
      title={forced ? 'Back to showing updates here' : `Send updates to ${chat} for the next hour`}
      aria-pressed={forced} aria-busy={busy || undefined} disabled={busy} onClick={() => void toggle()}>
      <Icon name={presence.mode === 'here' ? 'screen' : 'message'} />
      <span className="agency-pill-updates__text">{text}</span>
    </button>
  );
}
