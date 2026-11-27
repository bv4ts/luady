import { z } from 'zod';
import type { Clock, Db } from '../../core/contracts.js';
import { RefusedError } from '../../core/errors.js';
import { isoNow } from '../../core/time.js';

export interface PasskeyRecord {
  credId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface NewPasskey {
  credId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: readonly string[];
  label: string;
}

export interface PasskeyStore {
  count(): number;
  list(): PasskeyRecord[];
  get(credId: string): PasskeyRecord | undefined;
  /** Throws RefusedError when the credential id is already registered. */
  insert(input: NewPasskey): PasskeyRecord;
  recordUse(credId: string, counter: number): void;
  /** Deletes one passkey; false when the credential id is unknown. */
  remove(credId: string): boolean;
}

const RowSchema = z.object({
  cred_id: z.string(),
  public_key: z.instanceof(Uint8Array),
  counter: z.number().int(),
  transports_json: z.string(),
  label: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});
const CountSchema = z.object({ n: z.number().int() });
const TransportsSchema = z.array(z.string().max(32)).max(16);

function parseTransports(json: string): string[] {
  try {
    const parsed = TransportsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function toRecord(row: z.infer<typeof RowSchema>): PasskeyRecord {
  return {
    credId: row.cred_id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: parseTransports(row.transports_json),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function statements(db: Db) {
  return {
    count: db.prepare('SELECT COUNT(*) AS n FROM auth_passkeys'),
    list: db.prepare('SELECT * FROM auth_passkeys ORDER BY created_at, cred_id'),
    get: db.prepare('SELECT * FROM auth_passkeys WHERE cred_id = ?'),
    insert: db.prepare(
      'INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    ),
    use: db.prepare('UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE cred_id = ?'),
    remove: db.prepare('DELETE FROM auth_passkeys WHERE cred_id = ?'),
  };
}

export function createPasskeyStore(deps: { db: Db; clock: Clock }): PasskeyStore {
  const { clock } = deps;
  const sql = statements(deps.db);

  const get = (credId: string): PasskeyRecord | undefined => {
    const parsed = RowSchema.safeParse(sql.get.get(credId));
    return parsed.success ? toRecord(parsed.data) : undefined;
  };

  return {
    count: () => CountSchema.parse(sql.count.get()).n,
    list: () => z.array(RowSchema).parse(sql.list.all()).map(toRecord),
    get,
    insert(input) {
      if (get(input.credId) !== undefined) throw new RefusedError('This passkey is already registered');
      sql.insert.run(
        input.credId,
        Buffer.from(input.publicKey),
        input.counter,
        JSON.stringify(input.transports),
        input.label,
        isoNow(clock),
      );
      const stored = get(input.credId);
      if (stored === undefined) throw new Error(`Passkey ${input.credId} was not stored`);
      return stored;
    },
    recordUse(credId, counter) {
      sql.use.run(counter, isoNow(clock), credId);
    },
    remove(credId) {
      return sql.remove.run(credId).changes > 0;
    },
  };
}
