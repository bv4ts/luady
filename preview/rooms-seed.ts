import type { RoomImport } from '@luady/shared';

// Data only: config.ts (which main.ts loads before it has checked the build) reads this file.

/**
 * The classic four, imported once into the preview's empty rooms table through `config.rooms`, as an
 * owner's config file would: Orchard on birch (slot 0), Harbor on ash (1), Meadow on cedar (2) and Private Projects on
 * local (3), all of kind `server`, in the classic colours. A kept preview folder keeps whatever rooms it has.
 */
export const PREVIEW_ROOMS: readonly RoomImport[] = Object.freeze([
  {
    id: 'birch', name: 'Orchard', short: 'Orchard', kind: 'server', host: 'birch', position: 0, species: 'bun',
    colour: '#d6336c', accent: '#74b816', match: [{ by: 'name', glob: 'orchard*' }, { by: 'name', glob: 'dev_orchard*' }],
  },
  {
    id: 'ash', name: 'Harbor', short: 'Harbor', kind: 'server', host: 'ash', position: 1, species: 'bot',
    colour: '#f76707', accent: '#37b24d', match: [{ by: 'name', glob: 'harbor*' }],
  },
  {
    id: 'cedar', name: 'Meadow', short: 'Meadow', kind: 'server', host: 'cedar', position: 2, species: 'shield',
    colour: '#12b886', accent: '#c3fae8', match: [{ by: 'name', glob: 'meadow*' }],
  },
  {
    id: 'local', name: 'Private Projects', short: 'Private', kind: 'server', host: 'local', position: 3, species: 'ghost',
    colour: '#7c5cff', accent: '#ffd84d', match: [],
  },
]);
