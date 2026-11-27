import type { SetupStateDTO } from '@luady/shared';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { useHostList } from '../hosts/store.js';
import { browserZone } from '../../lib/browser-zone.js';
import { skippedLabels, zoneLine } from './steps.js';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The last screen: what is set up, what was left for later, and the way into the office. */
export function SetupOpenBody({ state, busy, error, onFinish }: {
  state: SetupStateDTO; busy: boolean; error: string | null; onFinish: () => void;
}) {
  const api = useApi();
  const { state: store } = useStore();
  const list = useHostList();
  const [managerOn, setManagerOn] = useState<boolean | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.settings().then((read) => {
      if (!live) return;
      setManagerOn(read.manager_enabled);
      setZone(read.owner_tz);
    }, () => { if (live) setManagerOn(null); });
    return () => {
      live = false;
    };
  }, [api]);
  const hosts = (list.hosts ?? []).filter((host) => host.state === 'pinned');
  const withKit = hosts.filter((host) => host.kitVersion !== null).length;
  const skipped = skippedLabels(state);
  return (
    <div className="stack stack--lg">
      <ul className="setup-summary" data-testid="setup-summary">
        <li><strong>Rooms:</strong> {store.rooms.length === 0 ? 'none yet' : plural(store.rooms.length, 'room', 'rooms')}</li>
        <li><strong>Machines:</strong> {hosts.length === 0 ? 'none yet' : `${plural(hosts.length, 'machine', 'machines')}, ${withKit} with the kit`}</li>
        <li><strong>Manager:</strong> {managerOn === null ? 'see Settings' : managerOn ? 'on' : 'off'}</li>
        <li><strong>Left for later:</strong> {skipped.length === 0 ? 'nothing' : skipped.join(', ')}</li>
      </ul>
      <p data-testid="setup-zone">{zoneLine(zone, browserZone())}</p>
      <p className="text-muted">Everything here can be changed later in Settings, under Setup.</p>
      {error !== null ? <Banner tone="error">{error}</Banner> : null}
      <div className="setup-actions">
        <Button variant="primary" icon="play" busy={busy} data-testid="setup-finish" onClick={onFinish}>Open the office</Button>
      </div>
    </div>
  );
}
