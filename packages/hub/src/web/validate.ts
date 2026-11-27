import { z } from 'zod';
import { isUnderRoot } from '@luady/shared';
import type { Fleet } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';

/** Parses untrusted input with a zod schema; a failure becomes ValidationError (HTTP 400). */
export function parseWith<T extends z.ZodType>(schema: T, input: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid ${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** A missing body is treated as {} so the strict empty-body schemas accept bodiless POSTs. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  return parseWith(schema, body ?? {}, 'body');
}

export function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  return parseWith(schema, query ?? {}, 'query');
}

export function parseParams<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  return parseWith(schema, params ?? {}, 'path parameters');
}

/**
 * A body field that names an existing server takes any host id on the wire; membership is checked here,
 * at run time. Absent (undefined or null) passes.
 */
export function knownServer<T extends string | null | undefined>(fleet: Pick<Fleet, 'hasServer'>, named: T): T {
  if (typeof named === 'string' && !fleet.hasServer(named)) throw new ValidationError(`Unknown server: ${named}`);
  return named;
}

/** The folder a session starts in must lie in its host's projects folder (the host's row). */
export function projectFolderOn(fleet: Pick<Fleet, 'hostInfo'>, server: string, cwd: string): string {
  const root = fleet.hostInfo(server)?.projectsRoot ?? null;
  if (root === null || !isUnderRoot(cwd, root)) throw new ValidationError(`cwd must be inside the projects folder of ${server}`);
  return cwd;
}
