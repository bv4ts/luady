import { isLocalHost } from '@luady/shared';
import { useState } from 'react';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { AddServerFlow, type HostFlowResult } from '../hosts/AddServerFlow.js';
import { LocalHostForm } from '../hosts/LocalHostForm.js';
import { useHostList } from '../hosts/store.js';
import { RoomsStep } from '../rooms/RoomsStep.js';

type Panel = 'lots' | 'computer' | 'server';

/** What a server needs before it can be added, said once. */
export const SERVER_NEEDS = 'A server needs SSH as a normal user (not root), python3, tmux and Claude Code.';

/** An empty lot on the map, as the office draws it: a dashed outline with a glowing plus. */
function Lot({ title, line, testId, onOpen }: { title: string; line: string; testId: string; onOpen: () => void }) {
  return (
    <button type="button" className="setup-lot" data-testid={testId} onClick={onOpen}>
      <span className="setup-lot__plus" aria-hidden="true">+</span>
      <span className="setup-lot__title">{title}</span>
      <span className="setup-lot__line">{line}</span>
    </button>
  );
}

/**
 * The rooms step's body: "Add this computer" (always offered; it makes its projects folder if asked),
 * "Add a server" (end to end, from this page), then the rooms themselves, one per server or project. Each add opens on
 * its own, with a way back; nothing is lost by going back (both flows resume where they stood).
 */
export function SetupRoomsBody({ onNext }: { onNext: (action: 'done' | 'skip') => void }) {
  const { state } = useStore();
  const list = useHostList();
  const [panel, setPanel] = useState<Panel>('lots');
  const [notice, setNotice] = useState<string | null>(null);
  const computer = list.hosts?.find((host) => isLocalHost(host.id) && host.state === 'pinned') ?? null;

  function finished(text: string) {
    setPanel('lots');
    setNotice(text);
    void list.refresh();
  }

  if (panel !== 'lots') {
    return (
      <div className="stack" data-testid={panel === 'computer' ? 'setup-computer-panel' : 'setup-server-panel'}>
        <div>
          <Button variant="ghost" icon="back" onClick={() => setPanel('lots')}>Back to rooms</Button>
        </div>
        {panel === 'computer'
          ? <LocalHostForm onDone={() => finished('This computer is added.')} />
          : <AddServerFlow mode="wizard" onDone={(made: HostFlowResult) => finished(`${made.host} is added.`)} onCancel={() => setPanel('lots')} />}
      </div>
    );
  }

  return (
    <div className="stack stack--lg">
      {notice !== null ? <Banner tone="info">{notice}</Banner> : null}
      <div className="setup-lots">
        <Lot testId="setup-add-computer" title="Add this computer" onOpen={() => setPanel('computer')}
          line={computer === null
            ? 'Sessions on the computer Luady runs on. Luady can make your projects folder for you.'
            : 'Added. Open it to check its kit and its room.'} />
        <Lot testId="setup-add-server" title="Add a server" onOpen={() => setPanel('server')}
          line="Any Linux machine you reach over SSH. You paste one line on it; no password is ever asked for." />
      </div>
      <p className="text-muted" data-testid="setup-server-needs">{SERVER_NEEDS}</p>
      <section className="stack" aria-labelledby="setup-rooms-title">
        <h2 id="setup-rooms-title" className="setup-choice__title">Your rooms</h2>
        <RoomsStep onNext={() => onNext(state.rooms.length > 0 ? 'done' : 'skip')} />
      </section>
    </div>
  );
}
