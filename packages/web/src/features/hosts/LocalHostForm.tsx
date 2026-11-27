import { isLocalHost, type HostCreatedDTO, type HostDTO } from '@luady/shared';
import { useEffect, useId, useState } from 'react';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { Spinner } from '../../ui/Spinner.js';
import { RoomEditor } from '../rooms/RoomEditor.js';
import type { HostFlowResult } from './AddServerFlow.js';
import { useHostsApi } from './context.js';
import { hasHomeRoom } from './flow-state.js';
import { CheckStep, KitStep } from './kit-steps.js';
import { localErrorText } from './messages.js';
import { Problem, StepFrame, StepList } from './parts.js';
import { useHostList } from './store.js';
import { useGrants } from './useGrants.js';
import './hosts.css';

export interface LocalHostFormProps {
  onDone(result: HostFlowResult): void;
}

type LocalStep = 'folder' | 'check' | 'kit' | 'room' | 'done';

const LOCAL_STEPS: ReadonlyArray<{ id: Exclude<LocalStep, 'done'>; label: string }> = [
  { id: 'folder', label: 'Folder' },
  { id: 'check', label: 'Check' },
  { id: 'kit', label: 'Kit' },
  { id: 'room', label: 'Room' },
];

/** `~` or a full path, safe characters only (the hub reads `~` as your home and checks the rest itself). */
const FOLDER_RE = /^(?:~|~\/(?!.*\.\.)[A-Za-z0-9._/-]{1,250}|\/(?!.*\.\.)[A-Za-z0-9._/-]{1,255})$/;

function localStep(host: HostDTO, rooms: Parameters<typeof hasHomeRoom>[0]): LocalStep {
  if (host.kitVersion === null) return 'check';
  return hasHomeRoom(rooms, host.id) ? 'done' : 'room';
}

/** The folder step: the projects folder (made when missing, if asked), saved with the PIN. */
function FolderStep({ onCreated }: { onCreated: (made: HostCreatedDTO) => void }) {
  const api = useHostsApi();
  const { runPinned } = usePin();
  const formId = useId();
  const boxId = useId();
  const [folder, setFolder] = useState('~/projects');
  const [create, setCreate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(): Promise<void> {
    if (!FOLDER_RE.test(folder)) {
      setError('Enter a folder such as ~/projects or /home/you/work: letters, digits, dots, dashes and slashes only.');
      return;
    }
    setError(null);
    setBusy(true);
    setProblem(null);
    try {
      const made = await runPinned((pin) => api.createLocal({ projectsRoot: folder, createFolder: create, pin: mustPin(pin) }), {
        title: 'Confirm with your PIN', detail: `Set up this computer, with projects in ${folder}`, require: true,
      });
      if (made !== null) onCreated(made);
    } catch (err) {
      setProblem(localErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <StepFrame testId="host-step-folder" title="This computer"
      intro="Sessions on the computer the hub runs on can sit in the office too. Choose the folder your projects are in; ~ is your home folder."
      actions={<Button type="submit" form={formId} variant="primary" busy={busy}>Save and go on</Button>}>
      <form id={formId} className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <TextField label="Projects folder" value={folder} error={error} autoComplete="off" spellCheck={false}
          onChange={(event) => setFolder(event.target.value.trim())} />
        <label className="host-check" htmlFor={boxId}>
          <input id={boxId} type="checkbox" checked={create} onChange={(event) => setCreate(event.target.checked)} />
          <span>Create it if missing (only inside your home folder)</span>
        </label>
        <Problem text={problem} />
      </form>
    </StepFrame>
  );
}

/**
 * "Add this computer": the projects folder with the PIN, the check, the kit under your own home, then
 * this computer's room (name, colour, creature). Never a config edit; it goes on where it stood after a reload.
 */
export function LocalHostForm({ onDone }: LocalHostFormProps) {
  const { state } = useStore();
  const list = useHostList();
  const grants = useGrants();
  const [step, setStep] = useState<LocalStep | null>(null);
  const local = list.hosts?.find((host) => isLocalHost(host.id) && host.state === 'pinned') ?? null;
  useEffect(() => {
    if (step !== null || list.hosts === null) return;
    setStep(local === null ? 'folder' : localStep(local, state.rooms));
  }, [step, list.hosts, local, state.rooms]);

  const body = (() => {
    if (step === null) return <Spinner />;
    if (step === 'folder' || local === null) {
      return <FolderStep onCreated={(made) => {
        grants.remember(made.host.id, made.grant);
        void list.refresh().then(() => setStep('check'));
      }} />;
    }
    if (step === 'check') return <CheckStep host={local} grants={grants} onNext={() => setStep('kit')} />;
    if (step === 'kit') return <KitStep host={local} grants={grants} onNext={() => { void list.refresh(); setStep('room'); }} />;
    if (step === 'room') {
      return (
        <StepFrame testId="host-step-room" title="Its room in the office" intro="Give this computer a room: every session on it sits there.">
          <RoomEditor kind="local" host={local.id} onDone={(room) => onDone({ host: local.id, room: room.id })} onCancel={() => onDone({ host: local.id, room: null })} />
        </StepFrame>
      );
    }
    return (
      <StepFrame testId="host-step-done" title="This computer is set up" intro="It has its kit and its room."
        actions={<Button variant="primary" onClick={() => onDone({ host: local.id, room: null })}>Done</Button>} />
    );
  })();

  return (
    <div className="host-flow" data-testid="local-host-form">
      <StepList steps={LOCAL_STEPS} current={step === null || step === 'done' ? 'room' : step} />
      {list.error !== null ? <Banner tone="error">{list.error}</Banner> : null}
      {body}
    </div>
  );
}
