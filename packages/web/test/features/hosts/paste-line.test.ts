import { describe, expect, it } from 'vitest';
import { isKeyLine, pasteCommand } from '../../../src/features/hosts/paste-line.js';
import { BLOB, KEY_LINE } from './hosts-fixtures.js';

describe('the line to paste on a server', () => {
  it('is fixed text around the hub\'s key line, appending after a newline with owner-only modes', () => {
    expect(pasteCommand(KEY_LINE)).toBe(
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '\\n%s\\n' '${KEY_LINE}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
    );
  });

  it('carries a from= list of addresses when the hub has one', () => {
    const line = `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,from="192.0.2.10,198.51.100.0/24" ssh-ed25519 ${BLOB} luady-fleet`;
    expect(isKeyLine(line)).toBe(true);
    expect(pasteCommand(line)).toContain(`'${line}'`);
  });

  it('refuses anything that is not exactly a key line the hub makes, so nothing else reaches a terminal', () => {
    for (const odd of [
      `ssh-ed25519 ${BLOB} luady-fleet`,
      `${KEY_LINE}'; rm -rf ~; echo '`,
      `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,command="id" ssh-ed25519 ${BLOB} luady-fleet`,
      `no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-rsa AAAAB3NzaC1yc2E luady-fleet`,
      `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,from="$(id)" ssh-ed25519 ${BLOB} luady-fleet`,
      `${KEY_LINE}\nid`,
      '',
    ]) {
      expect(pasteCommand(odd), odd).toBeNull();
    }
  });
});
