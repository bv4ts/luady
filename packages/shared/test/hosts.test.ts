import { describe, expect, it } from 'vitest';
import { HOST_GRANT_HEADER, HostCheckDTOSchema, HostRemoveResultDTOSchema } from '../src/index.js';

describe('hosts DTOs', () => {
  it('a check may carry the key line again after denied', () => {
    expect(HostCheckDTOSchema.parse({ auth: 'denied', preflight: null, missing: [], line: 'no-port-forwarding ssh-ed25519 AAAA luady-fleet' }).line)
      .toContain('luady-fleet');
    expect(HostCheckDTOSchema.parse({ auth: 'ok', preflight: { ready: 'yes' }, missing: [] }).line).toBeUndefined();
    expect(HostCheckDTOSchema.safeParse({ auth: 'denied', preflight: null, missing: [], line: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('a removal answers step by step, with a note and a hand-run command when the server was not reached', () => {
    const result = {
      host: 'mars', steps: { kit: 'unreachable', key: 'unreachable', link: 'closed', record: 'removed', rooms: 'kept' },
      note: 'The hub could not reach mars.', keyCommand: 'grep …',
    };
    expect(HostRemoveResultDTOSchema.parse(result)).toEqual(result);
    expect(HostRemoveResultDTOSchema.safeParse({ ...result, steps: { ...result.steps, kit: 'maybe' } }).success).toBe(false);
    expect(HostRemoveResultDTOSchema.safeParse({ ...result, host: 'Mars!' }).success).toBe(false);
  });

  it('names the grant header once for both sides', () => {
    expect(HOST_GRANT_HEADER).toBe('x-hub-grant');
  });
});
