import type { HostDTO } from '@luady/shared';
import { useState } from 'react';
import type { HostCheckResult } from '../../api/hosts.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { useHostsApi } from './context.js';
import { checkText, hostErrorText } from './messages.js';
import { CopyBlock, JobLog, Problem, StepFrame } from './parts.js';
import { pasteCommand } from './paste-line.js';
import { useHostJob } from './store.js';
import type { Grants } from './useGrants.js';

/** The owner's own words for where things are: this computer, or the server by name. */
const where = (host: HostDTO): string => (host.kind === 'local' ? 'this computer' : host.id);

/** Step 4: sign in with the key and see what is there; `denied` shows the line again and "Try again" resumes. */
export function CheckStep({ host, grants, onNext }: { host: HostDTO; grants: Grants; onNext: () => void }) {
  const api = useHostsApi();
  const [result, setResult] = useState<HostCheckResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function check(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const found = await grants.withGrant(host.id, (grant) => api.check(host.id, grant));
      if (found !== null) setResult(found);
    } catch (err) {
      setProblem(hostErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  const ready = result?.auth === 'ok' && result.preflight?.ready !== 'no';
  const line = result?.auth === 'denied' && result.line !== undefined ? pasteCommand(result.line) : null;
  const intro = host.kind === 'local'
    ? 'The hub checks that this computer has what the kit needs: Python 3.10 or later, tmux and Claude Code.'
    : `The hub now signs in to ${host.id} with its key and checks what the server has. It may take up to 20 seconds.`;
  return (
    <StepFrame testId="host-step-check" title="Check the connection" intro={intro}
      actions={<>
        {result === null || !ready
          ? <Button variant="primary" busy={busy} onClick={() => void check()}>{result === null ? 'Check now' : 'Try again'}</Button>
          : <Button variant="ghost" busy={busy} onClick={() => void check()}>Check again</Button>}
        {ready ? <Button variant="primary" onClick={onNext}>Go on</Button> : null}
        {result?.auth === 'ok' && !ready ? <Button variant="ghost" onClick={onNext}>Go on anyway</Button> : null}
      </>}>
      {result !== null ? (
        <div className="stack" data-testid="host-check-result">
          <Banner tone={result.auth === 'ok' ? (ready ? 'info' : 'warn') : 'error'}>{checkText(result, where(host))}</Banner>
          {result.missing.length > 0 ? (
            <ul className="host-missing" data-testid="host-missing">
              {result.missing.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}
          {line !== null ? <CopyBlock label="Paste on the server again" text={line} testId="host-paste-line" /> : null}
        </div>
      ) : null}
      <Problem text={problem} />
    </StepFrame>
  );
}

const CONSENT_SSH = (host: string): string =>
  `Installing the kit on ${host} copies a small program to ~/.luady, adds the kit's hooks to Claude Code's settings (a backup of them is kept) and wraps its status line. Nothing else changes, and you can remove it again later.`;
const CONSENT_LOCAL = 'Installing the kit on this computer copies a small program to ~/.luady in your home, adds the kit\'s hooks to Claude Code\'s settings (a backup of them is kept) and wraps its status line. You can remove it again later.';

const CONSENT_REMOVE = (host: string): string =>
  `Removing the kit from ${host} takes its hooks out of Claude Code's settings and puts the status line back. Its folder ~/.luady is kept, and so are the rooms and their history.`;

/** Step 5: consent, then the kit, with its progress lines as they come. `uninstall` removes it instead (Settings). */
export function KitStep({ host, grants, onNext, mode = 'install', fresh = false }: {
  host: HostDTO; grants: Grants; onNext: () => void; mode?: 'install' | 'uninstall';
  /** An action from Settings: an earlier finished job is not this one (a running one still shows). */
  fresh?: boolean;
}) {
  const api = useHostsApi();
  const view = useHostJob(host.id);
  const [startedHere, setStartedHere] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function install(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const kind = mode === 'uninstall' ? 'uninstall' : host.kitVersion === null ? 'install' : 'update';
      const job = await grants.withGrant(host.id, (grant) => api.kit(host.id, kind, grant));
      if (job !== null) {
        setStartedHere(true);
        view.started(job);
      }
    } catch (err) {
      setProblem(hostErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  const job = fresh && !startedHere && view.job?.state !== 'running' ? null : view.job;
  const state = job?.state ?? null;
  return (
    <StepFrame testId="host-step-kit" title={mode === 'uninstall' ? 'Remove the kit' : host.kitVersion === null ? 'Install the kit' : 'Update the kit'}
      intro={mode === 'uninstall' ? CONSENT_REMOVE(where(host)) : host.kind === 'local' ? CONSENT_LOCAL : CONSENT_SSH(host.id)}
      actions={<>
        {state === 'done'
          ? <Button variant="primary" onClick={onNext}>Go on</Button>
          : <Button variant="primary" busy={busy || state === 'running'} onClick={() => void install()}>
            {state === 'failed' ? 'Try again' : mode === 'uninstall' ? 'Remove the kit' : host.kitVersion === null ? 'Install the kit' : 'Update the kit'}
          </Button>}
      </>}>
      {state === 'running' ? <p role="status">{mode === 'uninstall' ? 'Removing' : 'Installing'} on {where(host)}…</p> : null}
      <JobLog lines={job === null ? [] : view.lines} label="What the install is doing" />
      {state === 'done' && job?.summary ? <Banner tone="info">{job.summary}</Banner> : null}
      {state === 'failed' ? <Problem text={job?.error ?? 'The install did not finish. Try again.'} /> : null}
      <Problem text={problem} />
    </StepFrame>
  );
}
