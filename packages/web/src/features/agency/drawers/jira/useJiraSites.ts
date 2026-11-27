import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError } from '../../../../api/errors.js';
import { reportError } from '../../../../lib/report.js';
import { useStore } from '../../../../state/store.js';
import { roomLookup } from '../../../rooms/room-lookup.js';

const NONE: readonly string[] = Object.freeze([]);

/**
 * The rooms with a Jira connection plus the first room (it always shows its board, connected or not: the pop-up then
 * offers to connect), sorted, without repeats. No first room (an empty office): the connected rooms only.
 */
export function jiraRoomsOf(servers: readonly string[], first: string | null): readonly string[] {
  return Object.freeze([...new Set([...(first === null ? [] : [first]), ...servers])].sort());
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((host, i) => host === b[i]);

/**
 * The rooms whose map shows a Jira board: those with a connection (GET /api/jira) and always the first room. Refetches
 * on every `jira.changed`. An older hub (404) keeps the first room quietly; the array is the same object while it is equal.
 */
export function useJiraSites(): readonly string[] {
  const api = useApi();
  const { jiraVersion: version, rooms } = useStore().state;
  const first = roomLookup(rooms).firstRoom();
  const [connected, setConnected] = useState<readonly string[]>(NONE);

  useEffect(() => {
    let alive = true;
    api.jiraSites().then(
      (list) => {
        if (!alive) return;
        const next = Object.freeze(list.sites.map((site) => site.server).toSorted());
        setConnected((prev) => (same(prev, next) ? prev : next));
      },
      (err: unknown) => {
        if (!(isApiError(err) && err.status === 404)) reportError('jira sites', err);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  // `connected` keeps its object while equal, so this is the same array until a room or a connection changes.
  return useMemo(() => jiraRoomsOf(connected, first), [connected, first]);
}
