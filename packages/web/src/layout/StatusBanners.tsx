import type { ChannelInfoDTO } from '@luady/shared';
import { Link } from 'react-router';
import type { WsStatus } from '../api/ws.js';
import { primaryChannel, useChannels } from '../features/channels/useChannels.js';
import { Banner } from '../ui/Banner.js';

/** What the banner says about the primary chat channel; null while it is up (or none is declared). */
export function channelWarning(channel: ChannelInfoDTO | null): string | null {
  if (channel === null || channel.state === 'up' || channel.state === 'starting') return null;
  if (channel.state === 'linking') return `${channel.name} needs linking again; updates reach only this website until then.`;
  if (channel.state === 'unlinked') return `${channel.name} is unlinked, so updates reach only this website.`;
  return `${channel.name} is not connected, so updates reach only this website.`;
}

/**
 * Connection and chat channel warnings, shared by the classic pages and the office. Only a declared primary channel
 * that is not up is a warning: with no channel at all, the website is where updates go, which needs no banner.
 * `channels` lets a test pass the list.
 */
export function StatusBanners({ connection, notice = null, className = 'status-banners', channels }: {
  connection: WsStatus; notice?: string | null; className?: string; channels?: readonly ChannelInfoDTO[] | null;
}) {
  const live = useChannels();
  const warning = channelWarning(primaryChannel(channels === undefined ? live.channels : channels));
  return (
    <div className={className}>
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      {connection === 'reconnecting' ? <Banner tone="info">Reconnecting to Luady… Live updates resume on their own.</Banner> : null}
      {warning !== null ? <Banner tone="warn" action={<Link to="/settings">Settings</Link>}>{warning}</Banner> : null}
    </div>
  );
}
