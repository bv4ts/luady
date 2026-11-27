import { posix } from 'node:path';
import { DEFAULT_AUTH_MODE, DEFAULT_BIND_HOST, DEFAULT_MANAGER_FILES, DEFAULT_OWNER_LABEL, trustedProxyOf } from '../../src/config/defaults.js';
import type { HubConfig } from '../../src/core/contracts.js';

/** The fields loadConfig always sets (each at its default when the config file names none). */
export type LoadedFields =
  | 'managerHome' | 'managerFiles' | 'addons' | 'bindHost' | 'allowRemote' | 'allowedHosts' | 'trustedProxy' | 'authMode' | 'ownerLabel'
  | 'twilio' | 'google' | 'imap';

/**
 * Those fields at loadConfig's defaults, for a config a test builds by hand: local mode on loopback, no add-on, no
 * phone, Google or extra mailbox, the manager's home in `<dataDir>/manager-home`. Spread it first, so the test's own
 * fields win. `allowedHosts` is empty, which every reader takes as "the public origin's host only" (allowedHostsOf),
 * so it stays right when a test changes publicOrigin later.
 */
export function loadedDefaults(dataDir: string): Pick<HubConfig, LoadedFields> {
  return {
    managerHome: posix.join(dataDir, 'manager-home'),
    managerFiles: DEFAULT_MANAGER_FILES,
    addons: [],
    bindHost: DEFAULT_BIND_HOST,
    allowRemote: false,
    allowedHosts: [],
    trustedProxy: trustedProxyOf({ authMode: DEFAULT_AUTH_MODE }),
    authMode: DEFAULT_AUTH_MODE,
    ownerLabel: DEFAULT_OWNER_LABEL,
    twilio: null,
    google: null,
    imap: null,
  };
}
