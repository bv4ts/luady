import { createContext, useContext, type ReactNode } from 'react';
import type { LuadyApi } from './client.js';

const ApiContext = createContext<LuadyApi | null>(null);

export function ApiProvider({ api, children }: { api: LuadyApi; children: ReactNode }) {
  return <ApiContext value={api}>{children}</ApiContext>;
}

export function useApi(): LuadyApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiProvider>');
  return api;
}
