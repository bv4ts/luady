import type { HostDTO } from '@luady/shared';
import { useEffect, useState } from 'react';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Spinner } from '../../ui/Spinner.js';
import { RoomEditor } from '../rooms/RoomEditor.js';
import { SERVER_STEPS, resumeStep, unfinishedServer, type ServerStep } from './flow-state.js';
import { CheckStep, KitStep } from './kit-steps.js';
import { StepFrame, StepList } from './parts.js';
import { DetailsStep, KeyStep, VerifyStep } from './server-steps.js';
import { useHostList } from './store.js';
import { useGrants } from './useGrants.js';
import './hosts.css';

/** What the add-server flow ends with: the host, and the room made for it (if any). */
export interface HostFlowResult {
  host: string;
  room: string | null;
}

export interface AddServerFlowProps {
  mode: 'wizard' | 'settings';
  onDone(result: HostFlowResult): void;
  onCancel(): void;
  /** Go on with this host where it stands (Settings' "Continue"); absent: a new server, or the one left unfinished. */
  resume?: string;
}

/** The room step: the server's own room, made with the rooms editor (name, colour, creature); it can be skipped. */
function RoomStep({ host, onDone }: { host: HostDTO; onDone: (room: string | null) => void }) {
  return (
    <StepFrame testId="host-step-room" title="Its room in the office"
      intro={`Give ${host.id} a room: every session on it sits there. New sessions appear at once; sessions already running appear after the hub restarts.`}>
      <RoomEditor kind="server" host={host.id} onDone={(room) => onDone(room.id)} onCancel={() => onDone(null)} />
    </StepFrame>
  );
}

/** "You were adding mars": continue it, or start a new one. */
function ResumeOffer({ host, onResume, onNew }: { host: HostDTO; onResume: () => void; onNew: () => void }) {
  return (
    <Banner tone="info" action={<div className="row">
      <Button size="sm" variant="primary" onClick={onResume}>Continue with {host.id}</Button>
      <Button size="sm" variant="ghost" onClick={onNew}>Add another server</Button>
    </div>}>
      You started adding {host.id} ({host.user}@{host.host}) and did not finish.
    </Banner>
  );
}

/**
 * Adding an SSH server, in the wizard and in Settings: details with the PIN; the line to paste; the
 * fingerprint, compared on the server ("It matches" is required); the check; consent and the kit; the room. Each step
 * says what will happen before it does. The flow can be resumed: it works out the step from the host itself.
 */
export function AddServerFlow({ mode, onDone, onCancel, resume }: AddServerFlowProps) {
  const { state } = useStore();
  const list = useHostList();
  const grants = useGrants();
  const [hostId, setHostId] = useState<string | null>(resume ?? null);
  const [step, setStep] = useState<ServerStep | null>(null);
  const [declined, setDeclined] = useState(false);
  const host = hostId === null ? null : list.hosts?.find((one) => one.id === hostId) ?? null;
  const offer = hostId === null && !declined && list.hosts !== null ? unfinishedServer(list.hosts, state.rooms) : null;

  useEffect(() => {
    if (host !== null && step === null) setStep(resumeStep(host, state.rooms));
  }, [host, step, state.rooms]);
  useEffect(() => {
    if (hostId === null && step === null && list.hosts !== null && offer === null) setStep('details');
  }, [hostId, step, list.hosts, offer]);

  const shown = step ?? 'details';
  const body = (() => {
    if (offer !== null) return <ResumeOffer host={offer} onResume={() => setHostId(offer.id)} onNew={() => setDeclined(true)} />;
    if (list.hosts !== null && hostId !== null && host === null) {
      return (
        <Banner tone="warn" action={<Button size="sm" onClick={() => { setHostId(null); setStep('details'); }}>Add a server</Button>}>
          {hostId} is not in the list of servers any more. It may have been removed.
        </Banner>
      );
    }
    if (list.hosts === null || step === null) return <Spinner />;
    if (step === 'details' || host === null) {
      return <DetailsStep onCancel={onCancel} onCreated={(made) => {
        grants.remember(made.host.id, made.grant);
        void list.refresh().then(() => {
          setHostId(made.host.id);
          setStep('key');
        });
      }} />;
    }
    if (step === 'key') return <KeyStep host={host} onNext={() => setStep('verify')} />;
    if (step === 'verify') return <VerifyStep host={host} grants={grants} onPinned={() => { void list.refresh(); setStep('check'); }} />;
    if (step === 'check') return <CheckStep host={host} grants={grants} onNext={() => setStep('kit')} />;
    if (step === 'kit') return <KitStep host={host} grants={grants} onNext={() => { void list.refresh(); setStep('room'); }} />;
    if (step === 'room') return <RoomStep host={host} onDone={(room) => onDone({ host: host.id, room })} />;
    return (
      <StepFrame testId="host-step-done" title={`${host.id} is set up`} intro="It has its kit and its room. You can close this."
        actions={<Button variant="primary" onClick={() => onDone({ host: host.id, room: null })}>Done</Button>} />
    );
  })();

  return (
    <div className={`host-flow host-flow--${mode}`} data-testid="add-server-flow">
      {offer === null ? <StepList steps={SERVER_STEPS} current={shown === 'done' ? 'room' : shown} /> : null}
      {list.error !== null ? <Banner tone="error">{list.error}</Banner> : null}
      {body}
    </div>
  );
}
