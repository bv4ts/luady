import type { ProjectDTO } from '@luady/shared';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';

export interface ProjectsState {
  readonly projects: readonly ProjectDTO[];
  readonly loading: boolean;
  readonly error: string | null;
}

const IDLE: ProjectsState = { projects: [], loading: false, error: null };

/** A host's projects; '' (no host chosen) is idle. */
export function useProjects(server: string): ProjectsState {
  const api = useApi();
  const [state, setState] = useState<ProjectsState>(IDLE);

  useEffect(() => {
    if (server === '') {
      setState(IDLE);
      return undefined;
    }
    let cancelled = false;
    setState({ projects: [], loading: true, error: null });
    api.projects(server).then(
      (projects) => {
        if (!cancelled) setState({ projects: projects.toSorted((a, b) => a.name.localeCompare(b.name)), loading: false, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState({ projects: [], loading: false, error: userMessage(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, server]);

  return state;
}
