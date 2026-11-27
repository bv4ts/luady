import type { ChannelInfoDTO } from '@luady/shared';
import type { ChannelsApi } from '../../api/channels.js';
import { useApi } from '../../api/context.js';
import { ownerDateTime } from '../../lib/format.js';
import { Badge } from '../../ui/Badge.js';
import { Spinner } from '../../ui/Spinner.js';
import type { Tone } from '../../ui/tones.js';
import { ChannelPanel } from './ChannelPanel.js';
import { CHANNEL_STATE_LABEL, useChannels } from './useChannels.js';
import './channels.css';

export interface ChannelsSectionProps {
  /** The setup wizard's short form. */
  compact?: boolean;
  /** Tests pass their own; the website uses the client's (`api.channels`). */
  api?: ChannelsApi;
}

const STATE_TONE: Readonly<Record<ChannelInfoDTO['state'], Tone>> = {
  absent: 'ended', starting: 'starting', linking: 'waiting', up: 'idle', down: 'error', unlinked: 'ended',
};

/** Where the add-on guide lives in the repository. */
export const ADDON_GUIDE = 'packages/addon-sdk/README.md';

export function NoChannel({ compact = false }: { compact?: boolean }) {
  return (
    <div className="channels-none" data-testid="channels-none">
      <p>No chat channel is connected. Updates, questions and files reach you here on the website.</p>
      {compact ? null : (
        <p className="text-subtle">
          To get them in a chat app too, add a channel add-on: a small program you run next to the hub. The add-on guide
          is <code>{ADDON_GUIDE}</code>.
        </p>
      )}
    </div>
  );
}

function ChannelCard({ channel, compact, api }: { channel: ChannelInfoDTO; compact: boolean; api: ChannelsApi }) {
  return (
    <article className="channel-card" data-testid={`channel-${channel.id}`}>
      <header className="row">
        <strong>{channel.name}</strong>
        <Badge tone={STATE_TONE[channel.state]}>{CHANNEL_STATE_LABEL[channel.state]}</Badge>
        {channel.primary ? <span className="text-subtle">primary</span> : null}
        {channel.kind === 'tools' ? <span className="text-subtle">tools</span> : null}
      </header>
      {channel.detail !== null && channel.detail !== '' ? <p className="text-muted">{channel.detail}</p> : null}
      {!compact && channel.since !== null ? <p className="text-subtle">since {ownerDateTime(channel.since)}</p> : null}
      {channel.state === 'absent' ? <p className="text-subtle">The add-on is not running. Start it next to the hub.</p> : null}
      <ChannelPanel channel={channel} api={api} />
    </article>
  );
}

/** The declared channels and add-ons with their panels; a calm note when there is none. */
export function ChannelsSection({ compact = false, api }: ChannelsSectionProps) {
  const client = useApi();
  const source = api ?? client.channels;
  const { channels, error } = useChannels(source);
  if (error !== null && channels === null) return <p className="form-error" data-testid="channels-section">{error}</p>;
  if (channels === null) return <Spinner label="Loading channels" />;
  return (
    <div className="stack" data-testid="channels-section">
      {channels.some((c) => c.kind === 'channel') ? null : <NoChannel compact={compact} />}
      {channels.map((channel) => <ChannelCard key={channel.id} channel={channel} compact={compact} api={source} />)}
    </div>
  );
}
