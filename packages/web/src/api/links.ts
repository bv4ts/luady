import { CreateLinkBodySchema, LinkDTOSchema, LinkListDTOSchema, UpdateLinkBodySchema } from '@luady/shared';
import type { z } from 'zod';
import { OkSchema } from './schemas.js';
import { EMPTY, checked, type Verbs } from './verbs.js';

export type CreateLinkInput = z.input<typeof CreateLinkBodySchema>;
export type UpdateLinkInput = z.input<typeof UpdateLinkBodySchema>;

/** The owner's quick links per office (`https://` only). */
export function linkRoutes({ get, post, put }: Verbs) {
  const link = (id: number): string => `/api/links/${String(id)}`;
  return {
    links: () => get('/api/links', LinkListDTOSchema),
    createLink: async (body: CreateLinkInput) => post('/api/links', LinkDTOSchema, checked(CreateLinkBodySchema, body)),
    updateLink: async (id: number, body: UpdateLinkInput) => put(link(id), LinkDTOSchema, checked(UpdateLinkBodySchema, body)),
    deleteLink: (id: number) => post(`${link(id)}/delete`, OkSchema, EMPTY),
  };
}
