import type { MeDTO } from '@luady/shared';
import { createContext, useContext, type ReactNode } from 'react';

export interface AuthValue {
  readonly me: MeDTO;
  refreshMe(): Promise<void>;
  logout(): Promise<void>;
  signalAuthLost(): void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ value, children }: { value: AuthValue; children: ReactNode }) {
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthGate>');
  return value;
}
