import { useState } from 'react';
import type { ChannelsApi, ConnectService } from '../../api/channels.js';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';

interface Row {
  readonly service: ConnectService;
  readonly label: string | undefined;
  readonly title: string;
  readonly what: string;
}

const ROWS: readonly Row[] = [
  { service: 'google', label: 'personal', title: 'Google (personal)', what: 'Gmail and Calendar, read only' },
  { service: 'google', label: 'work', title: 'Google (work)', what: 'Gmail and Calendar, read only' },
  { service: 'wispr', label: undefined, title: 'Wispr Flow', what: 'your recorded meetings' },
];

/**
 * Connect Google and Wispr Flow from the website: with the PIN, the hub makes a one-time link bound to
 * this sign-in; this tab goes to the provider and comes back to the hub, which finishes the connect.
 */
export function ConnectServices({ api, go = (url: string) => window.location.assign(url) }: {
  api?: ChannelsApi; go?: (url: string) => void;
}) {
  const client = useApi();
  const channels = api ?? client.channels;
  const { toast } = useStore();
  const { runPinned } = usePin();
  const [busy, setBusy] = useState<string | null>(null);

  async function connect(row: Row): Promise<void> {
    setBusy(row.title);
    try {
      const link = await runPinned(
        (pin) => channels.connect(row.service, { pin: mustPin(pin), ...(row.label === undefined ? {} : { label: row.label }) }),
        { require: true, title: `Connect ${row.title}`, detail: `The hub reads ${row.what}. You approve it on the provider's page next.` },
      );
      if (link !== null) go(link.url);
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" data-testid="connect-services">
      <p className="text-subtle">Connect accounts here, in this browser. Each link works once, for 10 minutes.</p>
      {ROWS.map((row) => (
        <div key={row.title} className="row channel-connect">
          <span>{row.title}</span>
          <span className="text-subtle">{row.what}</span>
          <Button size="sm" busy={busy === row.title} onClick={() => void connect(row)}>Connect</Button>
        </div>
      ))}
    </div>
  );
}
