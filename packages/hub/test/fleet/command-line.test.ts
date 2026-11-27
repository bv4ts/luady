import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { shQuote } from '../../src/core/ids.js';
import { buildCommandLine } from '../../src/fleet/command-line.js';

describe('buildCommandLine', () => {
  it('leaves the program path bare and quotes every argument', () => {
    expect(buildCommandLine('~/.luady/bin/luady-ctl', ['send', '--target', 'cc-x:0.0'])).toBe(
      `~/.luady/bin/luady-ctl ${shQuote('send')} ${shQuote('--target')} ${shQuote('cc-x:0.0')}`,
    );
  });

  it('passes shell metacharacters through shQuote', () => {
    const nasty = "$(rm -rf ~); echo 'x' `id`";
    expect(buildCommandLine('/home/luady/.luady/bin/luady-ctl', ['capture', nasty])).toBe(
      `/home/luady/.luady/bin/luady-ctl ${shQuote('capture')} ${shQuote(nasty)}`,
    );
  });

  it('rejects newlines in arguments', () => {
    expect(() => buildCommandLine('~/.luady/bin/luady-ctl', ['a\nb'])).toThrow(ValidationError);
  });

  it('rejects unsafe program paths', () => {
    for (const path of ['~/x; rm -rf /', 'luady-ctl', '/a/../b', '~/.luady/bin/luady ctl', '']) {
      expect(() => buildCommandLine(path, ['version'])).toThrow(ValidationError);
    }
  });
});
