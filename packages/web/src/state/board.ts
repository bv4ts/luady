import type { BoardItemDTO } from '@luady/shared';

/** The owner's board as the website holds it: cards by id (as a string key). `loaded`: GET /api/board answered. */
export interface BoardSlice {
  readonly cards: Readonly<Record<string, BoardItemDTO>>;
  readonly loaded: boolean;
}

export const EMPTY_BOARD: BoardSlice = Object.freeze({ cards: Object.freeze({}), loaded: false });

const keyOf = (id: number): string => String(id);

const sameCard = (a: BoardItemDTO, b: BoardItemDTO): boolean =>
  (Object.keys(a) as Array<keyof BoardItemDTO>).every((key) => a[key] === b[key]);

/** `GET /api/board`: the whole board; cards missing from it are gone, equal cards keep their object. */
export function loadBoard(prev: BoardSlice, items: readonly BoardItemDTO[]): BoardSlice {
  const cards = Object.fromEntries(items.map((item) => {
    const known = prev.cards[keyOf(item.id)];
    return [keyOf(item.id), known !== undefined && sameCard(known, item) ? known : item];
  }));
  return Object.freeze({ cards: Object.freeze(cards), loaded: true });
}

/** `board.updated`: the changed cards replace theirs or are added; every other card is kept by reference. */
export function upsertCards(prev: BoardSlice, items: readonly BoardItemDTO[]): BoardSlice {
  if (items.length === 0) return prev;
  const cards = { ...prev.cards, ...Object.fromEntries(items.map((item) => [keyOf(item.id), item])) };
  return Object.freeze({ ...prev, cards: Object.freeze(cards) });
}

/** `board.removed`. */
export function removeCards(prev: BoardSlice, ids: readonly number[]): BoardSlice {
  const gone = new Set(ids.map(keyOf));
  if (!Object.keys(prev.cards).some((key) => gone.has(key))) return prev;
  const cards = Object.fromEntries(Object.entries(prev.cards).filter(([key]) => !gone.has(key)));
  return Object.freeze({ ...prev, cards: Object.freeze(cards) });
}

/** Every card, by id; lanes and their order belong to the board view. */
export function cardList(slice: BoardSlice): readonly BoardItemDTO[] {
  return Object.values(slice.cards).sort((a, b) => a.id - b.id);
}
