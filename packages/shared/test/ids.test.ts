import { describe, expect, it } from 'vitest';
import {
  ACTION_ID_RE,
  BUILTIN_CHANNELS,
  HOST_ID_RE,
  NAME_RE,
  PIN_RE,
  QID_RE,
  RESERVED_IDS,
  RESERVED_PREFIXES,
  SELF_HOST_ID,
  TARGET_RE,
  isHostId,
  isNewHostId,
  isSelfHost,
  isUnderRoot,
  makeSessionId,
  parseSessionId,
} from '../src/ids.js';

describe('constants', () => {
  it('pins the built-in channels (hosts are open ids; each host has its own projects folder)', () => {
    expect(BUILTIN_CHANNELS).toEqual(['web', 'phone', 'event', 'scheduled', 'remote_control']);
  });
});

describe('the self host', () => {
  it('is the fixed id hq', () => {
    expect(SELF_HOST_ID).toBe('hq');
    expect(isSelfHost('hq')).toBe(true);
  });

  it.each(['cedar', 'local', 'computer', 'HQ', 'hq ', ''])('is not %j', (host) => {
    expect(isSelfHost(host)).toBe(false);
  });

  it('is reserved, as are the local host and the lot and vacant prefixes', () => {
    expect(RESERVED_IDS).toContain(SELF_HOST_ID);
    expect(RESERVED_IDS).toContain('computer');
    expect(RESERVED_PREFIXES).toEqual(['lot-', 'vacant-']);
  });
});

describe('HOST_ID_RE, isHostId and isNewHostId', () => {
  it.each(['ash', 'birch', 'cedar', 'local', 'mars-2', 'hq', 'computer', 'a'.repeat(24)])('the grammar accepts %s', (id) => {
    expect(HOST_ID_RE.test(id)).toBe(true);
    expect(isHostId(id)).toBe(true);
  });

  it.each(['', 'a', 'a'.repeat(25), 'Mars', '2mars', 'mars-', 'mars_2', 'ma:rs', 'mars 2', 'mars\n'])('the grammar rejects %j', (id) => {
    expect(isHostId(id)).toBe(false);
  });

  it.each(['hq', 'computer', 'lot-3', 'vacant-1', 'all', 'none', 'codex'])('a new host may not take %s', (id) => {
    expect(isNewHostId(id)).toBe(false);
  });

  it.each(['ash', 'mars-2', 'lots', 'hq2'])('a new host may take %s', (id) => {
    expect(isNewHostId(id)).toBe(true);
  });
});

describe('QID_RE', () => {
  it.each(['ABCDEFGH', 'Z2345677', 'QRSTUVWX'])('accepts %s', (qid) => {
    expect(QID_RE.test(qid)).toBe(true);
  });

  it.each(['ABCDEFG', 'ABCDEFGHI', 'abcdefgh', 'ABCDEFG1', 'ABCDEFG8', 'ABCD EFG'])('rejects %j', (qid) => {
    expect(QID_RE.test(qid)).toBe(false);
  });
});

describe('isUnderRoot with the classic projects folder', () => {
  it.each(['/home/dev/projects', '/home/dev/projects/meadow-hr', '/home/dev/projects/harbor/app', '/home/dev/projects/a/../b'])(
    'accepts %s',
    (path) => {
      expect(isUnderRoot(path, '/home/dev/projects')).toBe(true);
    },
  );

  it.each([
    '/home/dev/projectsX',
    '/home/dev/projects/../x',
    '/home/dev/projects/../../etc',
    'home/dev/projects/a',
    '/etc',
    '',
    '/home/dev/projects/a\0b',
    '/home/dev/projects/a\nb',
  ])('rejects %j', (path) => {
    expect(isUnderRoot(path, '/home/dev/projects')).toBe(false);
  });
});

describe('NAME_RE', () => {
  it.each(['meadow-hr', 'dev_orchard', 'cc-harbor.v2', 'a'.repeat(64)])('accepts %s', (name) => {
    expect(NAME_RE.test(name)).toBe(true);
  });

  it.each(['', 'a'.repeat(65), 'two words', 'semi;colon', 'has:colon', 'dir/name', 'name\n'])(
    'rejects %j',
    (name) => {
      expect(NAME_RE.test(name)).toBe(false);
    },
  );
});

describe('TARGET_RE', () => {
  it.each(['cc-meadow-hr:0.0', 'manager:0.0', 'cc-x:12.345'])('accepts %s', (target) => {
    expect(TARGET_RE.test(target)).toBe(true);
  });

  it.each(['cc-x', 'cc-x:0', 'cc-x:0.0.0', 'ash x:0.0', 'cc-x:1234.0', ':0.0', 'cc-x:0.0\n'])(
    'rejects %j',
    (target) => {
      expect(TARGET_RE.test(target)).toBe(false);
    },
  );
});

describe('ACTION_ID_RE', () => {
  it.each(['A1', 'A7', 'A10', 'A999999999'])('accepts %s', (id) => {
    expect(ACTION_ID_RE.test(id)).toBe(true);
  });

  it.each(['A0', 'A01', 'a1', 'A', 'A1234567890', 'B1'])('rejects %j', (id) => {
    expect(ACTION_ID_RE.test(id)).toBe(false);
  });
});

describe('PIN_RE', () => {
  it.each(['123456', '000000', '123456789012'])('accepts %s', (pin) => {
    expect(PIN_RE.test(pin)).toBe(true);
  });

  it.each(['12345', '1234567890123', '12345a', ' 123456', '\u0661\u0662\u0663\u0664\u0665\u0666'])(
    'rejects %j',
    (pin) => {
      expect(PIN_RE.test(pin)).toBe(false);
    },
  );
});

describe('makeSessionId and parseSessionId', () => {
  it('joins host and tmux target with a colon', () => {
    expect(makeSessionId('cedar', 'cc-meadow-hr:0.0')).toBe('cedar:cc-meadow-hr:0.0');
    expect(makeSessionId(SELF_HOST_ID, 'manager:0.0')).toBe('hq:manager:0.0');
  });

  it('splits at the first colon only', () => {
    expect(parseSessionId('cedar:cc-meadow-hr:0.0')).toEqual({ host: 'cedar', target: 'cc-meadow-hr:0.0' });
    expect(parseSessionId('hq:manager:0.0')).toEqual({ host: 'hq', target: 'manager:0.0' });
  });

  it('accepts any host that passes the grammar', () => {
    expect(parseSessionId('computer:cc-x:0.0')).toEqual({ host: 'computer', target: 'cc-x:0.0' });
    expect(parseSessionId('mars-2:cc-x:0.0')).toEqual({ host: 'mars-2', target: 'cc-x:0.0' });
  });

  it('round-trips any host id: the demo names, this computer, the self host and a new one', () => {
    for (const host of ['cedar', 'birch', 'ash', 'local', 'computer', SELF_HOST_ID, 'mars-2']) {
      expect(parseSessionId(makeSessionId(host, 'cc-demo:1.2'))).toEqual({ host, target: 'cc-demo:1.2' });
    }
  });

  it.each([
    '',
    'cedar',
    ':cc-x:0.0',
    'v:cc-x:0.0',
    'CEDAR:cc-x:0.0',
    'cedar:',
    'cedar:cc-x',
    'cedar:cc-x:0',
    'cedar:ash x:0.0',
    'cedar::0.0',
    'cedar:cc-x:0.0\n',
  ])('returns null for %j', (id) => {
    expect(parseSessionId(id)).toBeNull();
  });
});
