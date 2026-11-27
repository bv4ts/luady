import type { HostKeyDTO } from '@luady/shared';
import { ValidationError } from '../core/errors.js';
import { compileFixed } from '../fleet/fixed-scripts.js';
import { keyLine, validateKeyBlob, type FleetKey } from '../fleet/fleet-key.js';
import { HostConflictError } from './errors.js';

/**
 * What the website shows of the fleet key: the public `.pub` line and the `authorized_keys`
 * line, never the private half. Also the fixed command that removes the line by hand, for a server that was
 * unreachable when it was removed.
 */
export function hostKeyDto(key: FleetKey, fleetFrom: readonly string[] | undefined): HostKeyDTO {
  try {
    return { publicKey: key.publicKey, line: keyLine(key, fleetFrom ?? []) };
  } catch (err) {
    if (err instanceof ValidationError) throw new HostConflictError('fleet_from_invalid', err.message);
    throw err;
  }
}

/**
 * The hand-run removal, for a server the hub could not reach: the very `key-remove` command the hub runs itself
 * (fixed text plus the validated blob, one line any login shell passes to sh). It removes only the hub's lines, keeps
 * the file as it was when anything goes wrong, leaves no stray file, and prints `removed` or `absent`.
 */
export function manualKeyRemoval(key: Pick<FleetKey, 'blob'>): string {
  return compileFixed('key-remove', [validateKeyBlob(key.blob)]);
}
