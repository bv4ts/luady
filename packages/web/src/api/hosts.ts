import {
  HOST_GRANT_HEADER, HostCheckDTOSchema, HostCreateBodySchema, HostCreatedDTOSchema, HostDTOSchema, HostGrantDTOSchema, HostJobDTOSchema, HostKeyDTOSchema,
  HostLocalBodySchema, HostRemoveBodySchema, HostRemoveResultDTOSchema, HostScanDTOSchema, HostUpdateBodySchema, HostsDTOSchema,
  type HostCheckDTO, type HostCreatedDTO, type HostDTO, type HostRemoveResultDTO, type HostGrantDTO, type HostJobDTO, type HostKeyDTO, type HostScanDTO,
} from '@luady/shared';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { checked, seg, type RequestHeaders, type Verbs } from './verbs.js';

/** The hosts API: one function per route, on the main client; a host's grant goes in its own header. */

export type HostCreateInput = z.input<typeof HostCreateBodySchema>;
/** `projectsRoot` may be `~/…`: the hub reads `~` as its user's home. */
export type HostLocalInput = Omit<z.input<typeof HostLocalBodySchema>, 'projectsRoot'> & { projectsRoot: string };
export type HostUpdateInput = z.input<typeof HostUpdateBodySchema>;
export type HostRemoveInput = z.input<typeof HostRemoveBodySchema>;
export type HostKitMode = 'install' | 'update' | 'uninstall';

/** `check` (shared HostCheckDTO): after `denied` it carries the key line again. */
export type HostCheckResult = HostCheckDTO;
export type HostRemoveResult = HostRemoveResultDTO;

export interface HostsApi {
  list(): Promise<HostDTO[]>;
  key(): Promise<HostKeyDTO>;
  create(body: HostCreateInput): Promise<HostCreatedDTO>;
  createLocal(body: HostLocalInput): Promise<HostCreatedDTO>;
  grant(id: string, pin: string): Promise<HostGrantDTO>;
  scan(id: string, grant: string): Promise<HostScanDTO>;
  pin(id: string, fingerprint: string, grant: string): Promise<HostDTO>;
  check(id: string, grant: string): Promise<HostCheckResult>;
  kit(id: string, mode: HostKitMode, grant: string): Promise<HostJobDTO>;
  /** The latest kit job of a host, or null when it has none yet. */
  job(id: string): Promise<HostJobDTO | null>;
  update(id: string, body: HostUpdateInput): Promise<HostDTO>;
  remove(id: string, body: HostRemoveInput): Promise<HostRemoveResult>;
}

const withGrant = (grant: string): RequestHeaders => ({ [HOST_GRANT_HEADER]: grant });

/** The hosts routes of the main client (`api.hosts`). */
export function hostRoutes({ get, post, put }: Verbs): HostsApi {
  const host = (id: string): string => `/api/hosts/${seg(id)}`;
  return {
    list: () => get('/api/hosts', HostsDTOSchema),
    key: () => get('/api/hosts/key', HostKeyDTOSchema),
    create: async (body) => post('/api/hosts', HostCreatedDTOSchema, checked(HostCreateBodySchema, body)),
    createLocal: async (body) => post('/api/hosts/local', HostCreatedDTOSchema, body),
    grant: (id, pin) => post(`${host(id)}/grant`, HostGrantDTOSchema, { pin }),
    scan: (id, grant) => post(`${host(id)}/scan`, HostScanDTOSchema, {}, withGrant(grant)),
    pin: (id, fingerprint, grant) => post(`${host(id)}/pin`, HostDTOSchema, { fingerprint }, withGrant(grant)),
    check: (id, grant) => post(`${host(id)}/check`, HostCheckDTOSchema, {}, withGrant(grant)),
    kit: (id, mode, grant) => post(`${host(id)}/kit`, HostJobDTOSchema, { mode }, withGrant(grant)),
    async job(id) {
      try {
        return await get(`${host(id)}/job`, HostJobDTOSchema);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    update: async (id, body) => put(host(id), HostDTOSchema, checked(HostUpdateBodySchema, body)),
    remove: async (id, body) => post(`${host(id)}/remove`, HostRemoveResultDTOSchema, checked(HostRemoveBodySchema, body)),
  };
}
