import { createContext, useContext, type ReactNode } from 'react';
import { useApi } from '../../api/context.js';
import type { HostsApi } from '../../api/hosts.js';

/** The hosts API for the components of this feature: the main client's (`api.hosts`), unless a test or the demo gives one. */
const HostsApiContext = createContext<HostsApi | null>(null);

export function HostsApiProvider({ api, children }: { api: HostsApi; children: ReactNode }) {
  return <HostsApiContext value={api}>{children}</HostsApiContext>;
}

export function useHostsApi(): HostsApi {
  const given = useContext(HostsApiContext);
  const main = useApi();
  return given ?? main.hosts;
}
