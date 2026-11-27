import type { ChannelInfoDTO } from '@luady/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ChannelsApi } from '../../api/channels.js';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { useWsMessage } from '../../api/ws.js';

export interface ChannelsView {
  /** null while loading (or when the list could not be read). */
  readonly channels: readonly ChannelInfoDTO[] | null;
  readonly error: string | null;
  reload(): void;
}

/** One add-on's new state replaces its entry (or joins the list). */
export function withChannel(list: readonly ChannelInfoDTO[] | null, channel: ChannelInfoDTO): ChannelInfoDTO[] {
  const current = list ?? [];
  return current.some((c) => c.id === channel.id) ? current.map((c) => (c.id === channel.id ? channel : c)) : [...current, channel];
}

/** The declared add-ons (`GET /api/channels`, the client's unless a test passes its own), kept live by `channel.status`. */
export function useChannels(api?: ChannelsApi): ChannelsView {
  const client = useApi();
  const source = api ?? client.channels;
  const [channels, setChannels] = useState<readonly ChannelInfoDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    source.list().then(
      (list) => {
        if (!alive) return;
        setChannels(list);
        setError(null);
      },
      (err: unknown) => {
        if (alive) setError(userMessage(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [source, round]);

  useWsMessage('channel.status', (message) => setChannels((list) => withChannel(list, message.channel)));
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { channels, error, reload };
}

export const CHANNEL_STATE_LABEL: Readonly<Record<ChannelInfoDTO['state'], string>> = {
  absent: 'Not connected', starting: 'Starting', linking: 'Needs linking', up: 'Connected', down: 'Down', unlinked: 'Unlinked',
};

/** The primary channel, when one is declared. */
export function primaryChannel(list: readonly ChannelInfoDTO[] | null): ChannelInfoDTO | null {
  return list?.find((c) => c.kind === 'channel' && c.primary) ?? null;
}
