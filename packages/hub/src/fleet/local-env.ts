import { managerTmuxDir } from '../config/defaults.js';

/**
 * Variables that would point a child at another tmux server or another Claude Code config than the one it is meant
 * for: a hub started inside a tmux pane carries TMUX, which makes every tmux client talk to that pane's server.
 */
const TMUX_POINTERS = ['TMUX', 'TMUX_PANE'] as const;
/** Variables that would move the manager's Claude Code config or data away from its own HOME. */
const CONFIG_POINTERS = ['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const;

function without(base: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name, value]) => value !== undefined && !names.includes(name)));
}

/**
 * The local host ("this computer"): the hub user's own HOME and the DEFAULT tmux server, so its panes
 * are the user's own; only the variables that would redirect tmux are dropped.
 */
export function userEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return without(base, TMUX_POINTERS);
}

/**
 * The manager (the self host): HOME is the manager's home and TMUX_TMPDIR its own folder, so its
 * kit, its Claude Code sign-in, its spool and its tmux server never mix with the user's.
 */
export function managerEnv(managerHome: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...without(base, [...TMUX_POINTERS, ...CONFIG_POINTERS]), HOME: managerHome, TMUX_TMPDIR: managerTmuxDir(managerHome) };
}
