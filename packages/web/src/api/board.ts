import {
  BoardItemDTOSchema, BoardItemDetailDTOSchema, BoardListDTOSchema, CreateBoardItemBodySchema, DelegateBodySchema,
  DelegateResultDTOSchema, MissionListDTOSchema, UpdateBoardItemBodySchema,
} from '@luady/shared';
import type { z } from 'zod';
import { OkSchema } from './schemas.js';
import { EMPTY, checked, type Verbs } from './verbs.js';

export type CreateBoardItemInput = z.input<typeof CreateBoardItemBodySchema>;
export type UpdateBoardItemInput = z.input<typeof UpdateBoardItemBodySchema>;
export type DelegateInput = z.input<typeof DelegateBodySchema>;

/** The board, Run and Give to…, and the missions Luady runs. */
export function boardRoutes({ get, post, put }: Verbs) {
  const card = (id: number): string => `/api/board/${String(id)}`;
  return {
    board: () => get('/api/board', BoardListDTOSchema),
    createCard: async (body: CreateBoardItemInput) => post('/api/board', BoardItemDTOSchema, checked(CreateBoardItemBodySchema, body)),
    card: (id: number) => get(card(id), BoardItemDetailDTOSchema),
    updateCard: async (id: number, body: UpdateBoardItemInput) => put(card(id), BoardItemDTOSchema, checked(UpdateBoardItemBodySchema, body)),
    deleteCard: (id: number) => post(`${card(id)}/delete`, OkSchema, EMPTY),
    delegate: async (body: DelegateInput) => post('/api/delegate', DelegateResultDTOSchema, checked(DelegateBodySchema, body)),
    missions: () => get('/api/missions', MissionListDTOSchema),
  };
}
