import { isHostId, type ServerDTO } from '@luady/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { hostOrder } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { useRooms } from '../rooms/useRooms.js';
import { useProjects } from '../servers/useProjects.js';
import { suggestName, validateNewSession, type NewSessionErrors, type NewSessionForm } from './new-session.js';

function firstServer(servers: readonly ServerDTO[]): string {
  return (servers.find((server) => server.status === 'online') ?? servers[0])?.name ?? '';
}

/** The servers in the office's order (home room first, then by id). */
function useOrderedServers(): readonly ServerDTO[] {
  const { servers, rooms } = useStore().state;
  return useMemo(() => {
    const order = hostOrder(rooms);
    return servers.toSorted((a, b) => order(a.name, b.name));
  }, [servers, rooms]);
}

export function useNewSessionForm() {
  const api = useApi();
  const { toast } = useStore();
  const { hostLabel } = useRooms();
  const navigate = useNavigate();
  const servers = useOrderedServers();
  const [form, setForm] = useState<NewSessionForm>({ server: '', cwd: '', name: '', prompt: '' });
  const [errors, setErrors] = useState<NewSessionErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const projects = useProjects(form.server);
  const fallbackServer = firstServer(servers);
  /** The chosen host's projects folder; null when the hub did not report one (it checks the folder itself then). */
  const root = servers.find((server) => server.name === form.server)?.projectsRoot ?? null;

  useEffect(() => {
    if (form.server === '' && fallbackServer !== '') setForm((current) => ({ ...current, server: fallbackServer }));
  }, [fallbackServer, form.server]);

  const update = <K extends keyof NewSessionForm>(key: K, value: NewSessionForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const pickServer = (value: string) => {
    const known = isHostId(value) && servers.some((server) => server.name === value);
    setForm((current) => ({ ...current, server: known ? value : '', cwd: '' }));
  };

  async function submit() {
    const result = validateNewSession(form, root);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setFailure(null);
    try {
      const action = await api.createSession(result.body);
      if (action.status === 'failed') {
        setFailure(action.error ?? 'The session did not start.');
        return;
      }
      toast('success', `Starting ${result.body.name ?? suggestName(result.body.cwd)} on ${hostLabel(result.body.server)}`);
      void navigate('/sessions');
    } catch (err) {
      setFailure(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return { form, errors, busy, failure, projects, servers, root, hostLabel, update, pickServer, submit };
}
