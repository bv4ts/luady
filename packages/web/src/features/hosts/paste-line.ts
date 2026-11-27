/**
 * The one line to paste on a server: fixed text around the hub's key line. The key line is
 * checked against its exact shape first (the hub's options, an optional `from="…"` of addresses, an ed25519 key, the
 * fleet comment), so nothing else can ever end up in a command the owner pastes into a terminal. It works in bash,
 * zsh, dash, fish and csh, appends one line (after a newline, so a file without a last newline stays intact), and
 * creates `~/.ssh` and the file with owner-only modes.
 */
const OPTIONS = 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding';
const FROM = '(?:,from="[0-9A-Fa-f.:/,]{1,400}")?';
const KEY_LINE_RE = new RegExp(`^${OPTIONS}${FROM} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{40,120}={0,2} luady-fleet$`);

export function isKeyLine(line: string): boolean {
  return KEY_LINE_RE.test(line);
}

/** The paste command for one key line, or null when the line is not one the hub makes. */
export function pasteCommand(line: string): string | null {
  if (!isKeyLine(line)) return null;
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '\\n%s\\n' '${line}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}
