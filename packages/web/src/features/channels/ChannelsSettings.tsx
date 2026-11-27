import { Card } from '../../ui/Card.js';
import { ChannelsSection } from './ChannelsSection.js';
import { ConnectServices } from './ConnectServices.js';

/** Channels and add-ons, and the accounts the website connects. */
export function ChannelsSettings() {
  return (
    <>
      <Card title="Channels" subtitle="Chat channels and add-ons. Without one, everything reaches you here on the website.">
        <ChannelsSection />
      </Card>
      <Card title="Connected accounts" subtitle="Mail, calendar and meetings, connected from this browser.">
        <ConnectServices />
      </Card>
    </>
  );
}
