import {
  HostAddressSchema, HostPathSchema, NewHostIdSchema, UnixUserSchema, type HostCreatedDTO, type HostDTO, type HostKeyDTO, type HostScanDTO,
} from '@luady/shared';
import { useEffect, useId, useState } from 'react';
import type { HostCreateInput } from '../../api/hosts.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { useHostsApi } from './context.js';
import { hostErrorText } from './messages.js';
import { CopyBlock, Problem, StepFrame } from './parts.js';
import { pasteCommand } from './paste-line.js';
import type { Grants } from './useGrants.js';

interface DetailsForm {
  id: string;
  host: string;
  user: string;
  port: string;
  projectsRoot: string;
  claudeBin: string;
}

type DetailsErrors = Partial<Record<keyof DetailsForm, string>>;

/** A name for the server from its address: the first label, in the id grammar. */
export function suggestId(host: string): string {
  const first = host.split('.')[0] ?? '';
  return first.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 24);
}

export function validateDetails(form: DetailsForm): DetailsErrors {
  const port = Number(form.port);
  const errors: DetailsErrors = {
    id: NewHostIdSchema.safeParse(form.id).success ? undefined : 'Use 2 to 24 lower-case letters, digits or dashes, starting with a letter. Some words (like "computer") are kept for the hub.',
    host: HostAddressSchema.safeParse(form.host).success && form.host !== '' ? undefined : 'Enter the server\'s host name or IP address.',
    user: UnixUserSchema.safeParse(form.user).success ? undefined : 'Enter the Unix user the hub signs in as, in lower case (for example dev).',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? undefined : 'Enter a port from 1 to 65535 (SSH is usually 22).',
    projectsRoot: form.projectsRoot === '' || HostPathSchema.safeParse(form.projectsRoot).success ? undefined : 'Enter a full path such as /home/dev/projects, or leave it empty.',
    claudeBin: form.claudeBin === '' || HostPathSchema.safeParse(form.claudeBin).success ? undefined : 'Enter a full path, or leave it empty for ~/.local/bin/claude.',
  };
  return Object.fromEntries(Object.entries(errors).filter(([, value]) => value !== undefined)) as DetailsErrors;
}

function toBody(form: DetailsForm, pin: string): HostCreateInput {
  return {
    id: form.id, host: form.host, user: form.user, port: Number(form.port), pin,
    ...(form.projectsRoot === '' ? {} : { projectsRoot: form.projectsRoot }), ...(form.claudeBin === '' ? {} : { claudeBin: form.claudeBin }),
  };
}

/** Step 1: name, address, user and port; saved as a draft with the PIN, which also gives this flow its grant. */
export function DetailsStep({ onCreated, onCancel }: { onCreated: (made: HostCreatedDTO) => void; onCancel: () => void }) {
  const api = useHostsApi();
  const { runPinned } = usePin();
  const formId = useId();
  const [form, setForm] = useState<DetailsForm>({ id: '', host: '', user: 'dev', port: '22', projectsRoot: '', claudeBin: '' });
  const [named, setNamed] = useState(false);
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof DetailsForm, value: string): void => setForm((before) => ({
    ...before, [key]: value, ...(key === 'host' && !named ? { id: suggestId(value) } : {}),
  }));

  async function save(): Promise<void> {
    const found = validateDetails(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setProblem(null);
    try {
      const made = await runPinned((pin) => api.create(toBody(form, mustPin(pin))), {
        title: 'Confirm with your PIN', detail: `Add ${form.id} (${form.user}@${form.host})`, require: true,
      });
      if (made !== null) onCreated(made);
    } catch (err) {
      setProblem(hostErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepFrame testId="host-step-details" title="The server"
      intro="Tell the hub where the server is. It is saved as a draft: nothing connects to it yet."
      actions={<>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" busy={busy}>Save and go on</Button>
      </>}>
      <form id={formId} className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <TextField label="Address" hint="Its host name or IP address." value={form.host} error={errors.host} autoComplete="off"
          spellCheck={false} onChange={(event) => set('host', event.target.value.trim())} />
        <TextField label="Name" hint="How the office calls it. It cannot be changed later." value={form.id} error={errors.id} autoComplete="off"
          spellCheck={false} onChange={(event) => { setNamed(true); set('id', event.target.value.trim().toLowerCase()); }} />
        <div className="host-form__pair">
          <TextField label="User" hint="The Unix user the hub signs in as." value={form.user} error={errors.user} autoComplete="off"
            spellCheck={false} onChange={(event) => set('user', event.target.value.trim())} />
          <TextField label="Port" inputMode="numeric" value={form.port} error={errors.port}
            onChange={(event) => set('port', event.target.value.replace(/[^0-9]/g, ''))} />
        </div>
        <details className="host-more">
          <summary>More options</summary>
          <div className="stack">
            <TextField label="Projects folder" hint="Where sessions may start. Empty: the user's ~/projects." value={form.projectsRoot}
              error={errors.projectsRoot} autoComplete="off" spellCheck={false} onChange={(event) => set('projectsRoot', event.target.value.trim())} />
            <TextField label="Claude Code path" hint="Empty: ~/.local/bin/claude." value={form.claudeBin} error={errors.claudeBin}
              autoComplete="off" spellCheck={false} onChange={(event) => set('claudeBin', event.target.value.trim())} />
          </div>
        </details>
        <Problem text={problem} />
      </form>
    </StepFrame>
  );
}

/** Step 2: the one line to paste on the server; it lets the hub sign in with its own key, and nothing more. */
export function KeyStep({ host, onNext }: { host: HostDTO; onNext: () => void }) {
  const api = useHostsApi();
  const [key, setKey] = useState<HostKeyDTO | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.key().then((found) => { if (live) setKey(found); }, (err: unknown) => { if (live) setProblem(hostErrorText(err)); });
    return () => {
      live = false;
    };
  }, [api]);
  const command = key === null ? null : pasteCommand(key.line);
  return (
    <StepFrame testId="host-step-key" title="Let the hub in"
      intro={`On ${host.id}, signed in as ${host.user}, paste this one line into a terminal. It adds the hub's key, which can run commands but never forward anything. No password is ever asked for.`}
      actions={<Button variant="primary" onClick={onNext} disabled={command === null}>I have pasted it</Button>}>
      {command !== null ? <CopyBlock label="Paste on the server" text={command} testId="host-paste-line" /> : null}
      {key !== null && command === null ? <Problem text="The hub sent a key line this page does not recognise. Reload the page; if it stays, check the hub's config." /> : null}
      {key !== null ? (
        <details className="host-more">
          <summary>Only the key line</summary>
          <CopyBlock label="For ~/.ssh/authorized_keys" text={key.line} testId="host-key-line" />
        </details>
      ) : null}
      <Problem text={problem} />
    </StepFrame>
  );
}

/** Step 3: read the server's fingerprint without signing in; the owner compares it on the server and says it matches. */
export function VerifyStep({ host, grants, onPinned }: { host: HostDTO; grants: Grants; onPinned: (host: HostDTO) => void }) {
  const api = useHostsApi();
  const [scan, setScan] = useState<HostScanDTO | null>(null);
  const [matches, setMatches] = useState(false);
  const [differs, setDiffers] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(hostErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  const test = (): Promise<void> => run(async () => {
    setMatches(false);
    setDiffers(false);
    const found = await grants.withGrant(host.id, (grant) => api.scan(host.id, grant));
    if (found !== null) setScan(found);
  });
  const trust = (): Promise<void> => run(async () => {
    if (scan === null) return;
    const pinned = await grants.withGrant(host.id, (grant) => api.pin(host.id, scan.fingerprint, grant));
    if (pinned !== null) onPinned(pinned);
  });
  return (
    <StepFrame testId="host-step-verify" title="Check it is really your server"
      intro={`The hub now connects to ${host.id} once to read its fingerprint. It does not sign in.`}
      actions={scan === null
        ? <Button variant="primary" busy={busy} onClick={() => void test()}>Test the connection</Button>
        : <>
          <Button variant="ghost" onClick={() => void test()} disabled={busy}>Test again</Button>
          <Button variant="primary" busy={busy} disabled={!matches} onClick={() => void trust()}>Trust this server</Button>
        </>}>
      {scan !== null ? <FingerprintCheck host={host.id} scan={scan} matches={matches} differs={differs}
        onMatches={setMatches} onDiffers={() => { setDiffers(true); setMatches(false); }} /> : null}
      <Problem text={problem} />
    </StepFrame>
  );
}

function FingerprintCheck({ host, scan, matches, differs, onMatches, onDiffers }: {
  host: string; scan: HostScanDTO; matches: boolean; differs: boolean; onMatches: (on: boolean) => void; onDiffers: () => void;
}) {
  const box = useId();
  return (
    <div className="stack">
      <div className="host-fp">
        <p className="field__label">The hub saw this fingerprint ({scan.keyType})</p>
        <p className="host-fp__value mono" data-testid="host-fingerprint">{scan.fingerprint}</p>
      </div>
      <CopyBlock label={`On ${host}, run this; it prints the fingerprint the server itself has`} text={scan.compare} testId="host-compare" />
      <p>Compare the two, character by character. If they are the same, tick the box.</p>
      <label className="host-check" htmlFor={box}>
        <input id={box} type="checkbox" checked={matches} disabled={differs} onChange={(event) => onMatches(event.target.checked)} />
        <span>It matches</span>
      </label>
      <Button variant="ghost" size="sm" onClick={onDiffers}>It does not match</Button>
      {differs ? <Problem text={`Stop here. ${host} may not be the server you think, or someone may be in between. Check the address with whoever runs the server, then test again.`} /> : null}
    </div>
  );
}
