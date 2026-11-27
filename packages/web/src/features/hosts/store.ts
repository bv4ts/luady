import type { HostDTO, HostJobDTO } from '@luady/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHostLog, useWsMessage } from '../../api/ws.js';
import { useHostsApi } from './context.js';
import { hostErrorText } from './messages.js';

/**
 * The hosts feature's own store: the list from `GET /api/hosts`, kept current by `hosts.changed`; and one
 * host's latest kit job from `GET /api/hosts/:id/job`, kept current by `host.job` and its `host.log` lines. Both catch
 * up after a reload or a reconnect, so every flow can be resumed.
 */
export interface HostList {
  readonly hosts: readonly HostDTO[] | null;
  readonly error: string | null;
  refresh(): Promise<readonly HostDTO[]>;
}

export function useHostList(): HostList {
  const api = useHostsApi();
  const [hosts, setHosts] = useState<readonly HostDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async (): Promise<readonly HostDTO[]> => {
    try {
      const list = await api.list();
      if (alive.current) {
        setHosts(list);
        setError(null);
      }
      return list;
    } catch (err) {
      if (alive.current) setError(hostErrorText(err));
      return [];
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  useWsMessage('hosts.changed', (message) => setHosts(message.hosts));
  return { hosts, error, refresh };
}

/** Lines kept on screen per job; the hub sends at most 2,000. */
const LINES_KEPT = 400;

export interface HostJobView {
  readonly job: HostJobDTO | null;
  readonly lines: readonly string[];
  /** A job just started here: shown at once, before the hub's own `host.job`. */
  started(job: HostJobDTO): void;
}

export function useHostJob(host: string | null): HostJobView {
  const api = useHostsApi();
  const [job, setJob] = useState<HostJobDTO | null>(null);
  const [lines, setLines] = useState<readonly string[]>([]);
  const current = useRef<string | null>(null);
  useHostLog(host);
  useEffect(() => {
    let live = true;
    setJob(null);
    setLines([]);
    current.current = null;
    if (host === null) return undefined;
    void api.job(host).then((latest) => {
      if (!live || latest === null || current.current !== null) return;
      current.current = latest.job;
      setJob(latest);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, host]);
  useWsMessage('host.job', (message) => {
    if (message.host !== host) return;
    if (current.current !== message.job) setLines([]);
    current.current = message.job;
    setJob({ job: message.job, state: message.state, summary: message.summary ?? null, error: message.error ?? null });
  });
  useWsMessage('host.log', (message) => {
    if (message.host !== host || (current.current !== null && message.job !== current.current)) return;
    setLines((before) => [...before, message.line].slice(-LINES_KEPT));
  });
  const started = useCallback((next: HostJobDTO) => {
    // The hub's own events for this job may have come first (a fast job can end before its 202 is handled): what they
    // said is newer than the 202's "running", and their lines are this job's.
    if (current.current === next.job) return;
    current.current = next.job;
    setLines([]);
    setJob(next);
  }, []);
  return { job, lines, started };
}
