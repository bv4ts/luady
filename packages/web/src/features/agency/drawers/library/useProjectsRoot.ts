import { useStore } from '../../../../state/store.js';

/** A host's projects folder as the hub reports it; null when it has not said (the folder is then shown whole). */
export function useProjectsRoot(server: string): string | null {
  return useStore().state.servers.find((candidate) => candidate.name === server)?.projectsRoot ?? null;
}
