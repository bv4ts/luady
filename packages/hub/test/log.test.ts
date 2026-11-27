import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.js';
import { REDACT_CENSOR, createLogger, loggerOptions } from '../src/log.js';

function capture(): { lines: string[]; stream: { write(msg: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (msg: string) => { lines.push(msg); } } };
}

describe('log', () => {
  it('redacts pins, tokens, cookies, authorization headers and secrets', () => {
    const { lines, stream } = capture();
    pino(loggerOptions('info'), stream).info(
      {
        pin: '123456',
        body: { pin: '654321', newPin: '111111', currentPin: '222222', setupCode: 'setup-code-7' },
        token: 'tok-one',
        ws: { token: 'tok-two', ticket: 'ticket-three' },
        req: {
          headers: { authorization: 'Bearer abc', cookie: 'hub_sid=1', 'cf-access-jwt-assertion': 'jwt-four', host: 'hq' },
        },
        config: { sessionSecret: 'ss-five', hubSocketToken: 'ht-six', cfAccessAud: 'aud-seven' },
        secrets: { HUB_SOCKET_TOKEN: 'raw-secret-eight' },
      },
      'auth attempt',
    );
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.pin).toBe(REDACT_CENSOR);
    expect(entry.body).toEqual({ pin: REDACT_CENSOR, newPin: REDACT_CENSOR, currentPin: REDACT_CENSOR, setupCode: REDACT_CENSOR });
    expect(entry.token).toBe(REDACT_CENSOR);
    expect(entry.ws).toEqual({ token: REDACT_CENSOR, ticket: REDACT_CENSOR });
    expect(entry.req.headers).toEqual({
      authorization: REDACT_CENSOR,
      cookie: REDACT_CENSOR,
      'cf-access-jwt-assertion': REDACT_CENSOR,
      host: 'hq',
    });
    expect(entry.config).toEqual({ sessionSecret: REDACT_CENSOR, hubSocketToken: REDACT_CENSOR, cfAccessAud: REDACT_CENSOR });
    expect(entry.secrets).toBe(REDACT_CENSOR);
    expect(lines[0]).not.toMatch(/123456|654321|tok-one|tok-two|Bearer abc|hub_sid=1|jwt-four|ss-five|raw-secret-eight/);
  });

  it('keeps ordinary fields, the message and an ISO timestamp', () => {
    const { lines, stream } = capture();
    pino(loggerOptions('info'), stream).info({ server: 'cedar', body: { text: 'keep me' } }, 'connected');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry).toMatchObject({ svc: 'luady-hub', server: 'cedar', body: { text: 'keep me' }, msg: 'connected' });
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('createLogger applies the requested level', () => {
    expect(createLogger({ level: 'warn' }).level).toBe('warn');
    expect(createLogger({ level: 'silent' }).isLevelEnabled('error')).toBe(false);
  });

  it('rejects unknown levels', () => {
    expect(() => createLogger({ level: 'loud' })).toThrow(ValidationError);
  });
});

describe('log: the hosts flow', () => {
  it('redacts a grant in a body or a field, and the grant and page-key headers of a request', () => {
    const { lines, stream } = capture();
    pino(loggerOptions('info'), stream).info({
      grant: 'grant-one',
      created: { grant: 'grant-two', host: 'mars' },
      req: { headers: { 'x-hub-grant': 'grant-three', 'x-hub-key': 'page-key-four', host: 'localhost' } },
    }, 'hosts step');
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.grant).toBe(REDACT_CENSOR);
    expect(entry.created).toEqual({ grant: REDACT_CENSOR, host: 'mars' });
    expect(entry.req.headers).toEqual({ 'x-hub-grant': REDACT_CENSOR, 'x-hub-key': REDACT_CENSOR, host: 'localhost' });
    expect(lines.join('\n')).not.toMatch(/grant-one|grant-two|grant-three|page-key-four/);
  });
});
