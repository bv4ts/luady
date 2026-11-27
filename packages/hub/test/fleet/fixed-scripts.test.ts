import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { shQuote } from '../../src/core/ids.js';
import {
  FIXED_SCRIPTS, FIXED_SCRIPT_IDS, KIT_ALIAS_LINE_RE, compileFixed, installArgs, scriptText, uninstallArgs, type FixedScriptId,
} from '../../src/fleet/fixed-scripts.js';

/** An ed25519 public-key blob, built from parts (the type string, then 32 key bytes) so no scanner sees a real key. */
const BLOB = Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7),
]).toString('base64');

const PREFIX = (id: FixedScriptId): string => `sh -c ${shQuote(scriptText(id))} luady`;

describe('fixed remote scripts', () => {
  it('has exactly the three scripts, in a frozen table', () => {
    expect([...FIXED_SCRIPT_IDS].sort()).toEqual(['key-remove', 'kit', 'preflight']);
    expect(Object.isFrozen(FIXED_SCRIPTS)).toBe(true);
    for (const id of FIXED_SCRIPT_IDS) expect(Object.isFrozen(FIXED_SCRIPTS[id])).toBe(true);
  });

  it('compiles to the exact `sh -c` string: the constant, $0 = luady, then each argument single-quoted', () => {
    expect(compileFixed('preflight', ['', ''])).toBe(`${PREFIX('preflight')} '' ''`);
    expect(compileFixed('preflight', ['/opt/claude/bin/claude', '/srv/work'])).toBe(
      `${PREFIX('preflight')} '/opt/claude/bin/claude' '/srv/work'`,
    );
    expect(compileFixed('key-remove', [BLOB])).toBe(`${PREFIX('key-remove')} '${BLOB}'`);
    expect(compileFixed('kit', installArgs({ alias: 'mars', projectsRoot: '/home/dev/projects', claudeBin: null }))).toBe(
      `${PREFIX('kit')} '--host-alias' 'mars' '--projects-root' '/home/dev/projects'`,
    );
    expect(compileFixed('kit', uninstallArgs())).toBe(`${PREFIX('kit')} '--uninstall'`);
  });

  it('quotes the script itself: its single quotes become the POSIX escape, so the login shell hands sh one argument', () => {
    const text = scriptText('preflight');
    expect(text).toContain("'");
    const compiled = compileFixed('preflight', ['', '']);
    expect(compiled.startsWith(`sh -c '${text.replaceAll("'", `'\\''`)}' luady `)).toBe(true);
  });

  it('keeps every script on one line, POSIX sh only, with no sequence a fish or csh login shell would read differently', () => {
    for (const id of FIXED_SCRIPT_IDS) {
      const text = scriptText(id);
      expect(text, id).not.toMatch(/[\n\r\0]/);
      expect(text, id).not.toContain('\\\\');
      expect(text, id).not.toContain("\\'");
      expect(text, id).not.toMatch(/\bbash\b|\[\[|\bfunction\b|\$'|<<</);
    }
  });

  it('never splices an argument into the script: hostile values stay single quoted arguments, or are refused', () => {
    const before = PREFIX('preflight');
    for (const hostile of ["/x'; rm -rf / #", '/a$(id)', '/a`id`', '/a\nb', '-oProxyCommand=x', '/a/../b']) {
      let compiled: string | null = null;
      try {
        compiled = compileFixed('preflight', [hostile, '']);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
      }
      if (compiled !== null) {
        expect(compiled.startsWith(before)).toBe(true);
        expect(compiled.slice(before.length)).toBe(` ${shQuote(hostile)} ''`);
      }
    }
  });

  it('refuses arguments outside each script\'s own grammar', () => {
    expect(() => compileFixed('preflight', ['relative/path', ''])).toThrow(ValidationError);
    expect(() => compileFixed('preflight', ['/a/../etc', ''])).toThrow(ValidationError);
    expect(() => compileFixed('preflight', [''])).toThrow(ValidationError);
    expect(() => compileFixed('key-remove', [''])).toThrow(ValidationError);
    expect(() => compileFixed('key-remove', ['AAAAB3NzaC1yc2E'])).toThrow(ValidationError);
    expect(() => compileFixed('key-remove', [`${BLOB}' ; id ; '`])).toThrow(ValidationError);
    expect(() => compileFixed('kit', ['--home', '/root'])).toThrow(ValidationError);
    expect(() => compileFixed('kit', ['--host-alias', 'Mars'])).toThrow(ValidationError);
    expect(() => compileFixed('kit', ['--host-alias', 'mars', '--uninstall'])).toThrow(ValidationError);
    expect(() => compileFixed('kit', ['--projects-root', '/srv'])).toThrow(ValidationError);
    expect(() => compileFixed('kit', [])).toThrow(ValidationError);
    expect(() => installArgs({ alias: 'mars', projectsRoot: '/srv/../etc', claudeBin: null })).toThrow(ValidationError);
  });

  it('an unknown id fails to compile, and is refused at run time too', () => {
    // @ts-expect-error: only the three ids of the table compile
    expect(() => compileFixed('rm-rf', [])).toThrow(ValidationError);
    // @ts-expect-error: a prototype key is not a script
    expect(() => compileFixed('constructor', [])).toThrow(ValidationError);
  });

  it('the kit script unpacks stdin into a fresh temp folder, runs the installer with "$@" and always cleans up', () => {
    const kit = scriptText('kit');
    expect(kit).toContain('mktemp -d');
    expect(kit).toContain('tar -xzf - -C "$d"');
    expect(kit).toContain('python3 "$d/install.py" "$@"');
    expect(kit).toMatch(/trap '[^']*rm -rf "\$d"[^']*' EXIT/);
  });

  it('key-remove touches only lines holding the hub\'s blob, and refuses an empty or foreign blob on the server too', () => {
    const remove = scriptText('key-remove');
    expect(remove).toContain('grep -vF -- "$1"');
    expect(remove).toContain('AAAAC3NzaC1lZDI1NTE5*');
    expect(remove).toContain('mv -f');
  });

  it('preflight prints key=value lines, kit_alias among them, and reads the alias line for the hub to parse', () => {
    const pre = scriptText('preflight');
    for (const key of ['os', 'home', 'user', 'python', 'tmux', 'tar', 'mktemp', 'claude', 'claude_version', 'projects', 'kit_alias', 'kit_version']) {
      expect(pre, key).toContain(`kv ${key} `);
    }
    expect(KIT_ALIAS_LINE_RE.exec('"host_alias": "mars"')?.[1]).toBe('mars');
  });
});
