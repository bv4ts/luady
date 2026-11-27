import {
  CreateKbPageBodySchema, KbListDTOSchema, KbPageFullDTOSchema, KbSyncBodySchema, LibraryDTOSchema, LibraryRefreshBodySchema,
  UpdateKbPageBodySchema, type KbScope, type HostId,
} from '@luady/shared';
import type { z } from 'zod';
import { OkSchema } from './schemas.js';
import { EMPTY, checked, query, type Verbs } from './verbs.js';

export type CreateKbPageInput = z.input<typeof CreateKbPageBodySchema>;
export type UpdateKbPageInput = z.input<typeof UpdateKbPageBodySchema>;
export interface KbFilter {
  readonly scope?: KbScope;
  readonly server?: HostId;
  readonly project?: string;
  readonly query?: string;
}

/** Knowledge pages, their copy to the servers, and the Library. */
export function kbRoutes({ get, post, put }: Verbs) {
  const page = (id: number): string => `/api/kb/${String(id)}`;
  return {
    kbPages: (filter: KbFilter = {}) =>
      get(`/api/kb${query({ scope: filter.scope, server: filter.server, project: filter.project, query: filter.query })}`, KbListDTOSchema),
    kbPage: (id: number) => get(page(id), KbPageFullDTOSchema),
    createKbPage: async (body: CreateKbPageInput) => post('/api/kb', KbPageFullDTOSchema, checked(CreateKbPageBodySchema, body)),
    updateKbPage: async (id: number, body: UpdateKbPageInput) => put(page(id), KbPageFullDTOSchema, checked(UpdateKbPageBodySchema, body)),
    deleteKbPage: (id: number) => post(`${page(id)}/delete`, OkSchema, EMPTY),
    syncKb: async (server?: HostId) =>
      post('/api/kb/sync', OkSchema, checked(KbSyncBodySchema, server === undefined ? EMPTY : { server })),
    library: () => get('/api/library', LibraryDTOSchema),
    refreshLibrary: async (server?: HostId) =>
      post('/api/library/refresh', OkSchema, checked(LibraryRefreshBodySchema, server === undefined ? EMPTY : { server })),
  };
}
