import { z } from 'zod';
import { SPOOL_FILE_RE, type HostId } from '@luady/shared';
import type { Db } from '../core/contracts.js';

export interface TailPosition {
  file: string;
  offset: number;
}

const PositionSchema = z.object({ file: z.string().regex(SPOOL_FILE_RE), offset: z.number().int().nonnegative() });

export interface OffsetsRepo {
  get(host: HostId): TailPosition | undefined;
  saveAll(entries: ReadonlyArray<readonly [HostId, TailPosition]>): void;
}

export function createOffsetsRepo(db: Db): OffsetsRepo {
  const select = db.prepare('SELECT file, "offset" AS offset FROM offsets WHERE host = ?');
  const upsert = db.prepare(
    'INSERT INTO offsets (host, file, "offset") VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET file = excluded.file, "offset" = excluded."offset"',
  );
  const saveMany = db.transaction((entries: ReadonlyArray<readonly [HostId, TailPosition]>) => {
    for (const [host, position] of entries) upsert.run(host, position.file, position.offset);
  });
  return {
    get(host) {
      const parsed = PositionSchema.safeParse(select.get(host));
      return parsed.success ? { file: parsed.data.file, offset: parsed.data.offset } : undefined;
    },
    saveAll(entries) {
      if (entries.length > 0) saveMany(entries);
    },
  };
}

/** `tail-events --from` argument: `<file>:<offset>`, or `end` on the very first run. */
export function positionToFrom(position: TailPosition | undefined): string {
  return position === undefined ? 'end' : `${position.file}:${position.offset}`;
}
