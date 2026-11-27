import { HostAddressSchema, HostPathSchema, UnixUserSchema, type HostDTO } from '@luady/shared';
import { useId, useState } from 'react';
import type { HostUpdateInput } from '../../api/hosts.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { Modal } from '../../ui/Modal.js';
import { useHostsApi } from './context.js';
import { hostErrorText } from './messages.js';
import { Problem } from './parts.js';

interface EditForm {
  host: string;
  user: string;
  port: string;
  projectsRoot: string;
  claudeBin: string;
}

/** Only what changed goes to the hub; an address, user or port change sends the host back to its fingerprint check. */
export function editChanges(host: HostDTO, form: EditForm): Omit<HostUpdateInput, 'pin'> | string {
  const port = Number(form.port);
  if (host.kind === 'ssh') {
    if (!HostAddressSchema.safeParse(form.host).success || form.host === '') return 'Enter the server\'s host name or IP address.';
    if (!UnixUserSchema.safeParse(form.user).success) return 'Enter the Unix user in lower case.';
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter a port from 1 to 65535.';
  }
  for (const path of [form.projectsRoot, form.claudeBin]) {
    if (path !== '' && !HostPathSchema.safeParse(path).success) return 'Folders must be full paths such as /home/dev/projects.';
  }
  return {
    ...(host.kind === 'ssh' && form.host !== host.host ? { host: form.host } : {}),
    ...(host.kind === 'ssh' && form.user !== host.user ? { user: form.user } : {}),
    ...(host.kind === 'ssh' && port !== host.port ? { port } : {}),
    ...(form.projectsRoot !== '' && form.projectsRoot !== host.projectsRoot ? { projectsRoot: form.projectsRoot } : {}),
    ...(form.claudeBin !== '' ? { claudeBin: form.claudeBin } : {}),
  };
}

/** Editing a website-made host with the PIN. Config rows are not editable here. */
export function EditHostDialog({ host, onClose }: { host: HostDTO; onClose: () => void }) {
  const api = useHostsApi();
  const { runPinned } = usePin();
  const formId = useId();
  const [form, setForm] = useState<EditForm>({ host: host.host, user: host.user, port: String(host.port), projectsRoot: host.projectsRoot ?? '', claudeBin: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const moved = host.kind === 'ssh' && (form.host !== host.host || form.user !== host.user || form.port !== String(host.port));
  async function save(): Promise<void> {
    const changes = editChanges(host, form);
    if (typeof changes === 'string') {
      setProblem(changes);
      return;
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const saved = await runPinned((pin) => api.update(host.id, { ...changes, pin: mustPin(pin) }), { title: 'Confirm with your PIN', detail: `Change ${host.id}`, require: true });
      if (saved !== null) onClose();
    } catch (err) {
      setProblem(hostErrorText(err));
    } finally {
      setBusy(false);
    }
  }
  const set = (key: keyof EditForm, value: string): void => setForm((before) => ({ ...before, [key]: value.trim() }));
  return (
    <Modal open title={`Change ${host.kind === 'local' ? 'this computer' : host.id}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form={formId} variant="primary" busy={busy}>Save</Button></>}>
      <form id={formId} className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {host.kind === 'ssh' ? (
          <>
            <TextField label="Address" value={form.host} spellCheck={false} autoComplete="off" onChange={(event) => set('host', event.target.value)} />
            <div className="host-form__pair">
              <TextField label="User" value={form.user} spellCheck={false} autoComplete="off" onChange={(event) => set('user', event.target.value)} />
              <TextField label="Port" inputMode="numeric" value={form.port} onChange={(event) => set('port', event.target.value.replace(/[^0-9]/g, ''))} />
            </div>
          </>
        ) : null}
        <TextField label="Projects folder" value={form.projectsRoot} spellCheck={false} autoComplete="off" onChange={(event) => set('projectsRoot', event.target.value)} />
        <TextField label="Claude Code path" hint="Empty: keep it as it is." value={form.claudeBin} spellCheck={false} autoComplete="off"
          onChange={(event) => set('claudeBin', event.target.value)} />
        {moved ? <Banner tone="warn">A new address, user or port means a new fingerprint check: the hub stops using {host.id} until you confirm it again.</Banner> : null}
        <Problem text={problem} />
      </form>
    </Modal>
  );
}
