import type { TmuxRunner } from '../packages/hub/dist/luady/service.js';

/**
 * The manager's tmux, faked (the preview, the demo and the integration harness): no tmux server is started and no real
 * Claude Code runs. A `new-session` makes the manager's session "exist" until it is killed.
 */
export interface FakeTmux extends TmuxRunner {
  readonly calls: ReadonlyArray<readonly string[]>;
  brainRunning(): boolean;
}

const TMUX_COMMANDS: ReadonlySet<string> = new Set([
  'new-session', 'has-session', 'kill-session', 'kill-server', 'display-message', 'display',
  'list-panes', 'list-sessions', 'send-keys', 'capture-pane', 'respawn-pane',
]);

const result = (code: number, stdout = '', stderr = '') => ({ code, stdout, stderr });

/** Pretends the manager's tmux session exists after new-session; never starts a process. */
export function createFakeTmux(): FakeTmux {
  let running = false;
  const calls: string[][] = [];
  return {
    calls,
    brainRunning: () => running,
    async run(args: string[]) {
      calls.push([...args]);
      const command = args.find((arg) => TMUX_COMMANDS.has(arg));
      if (command === 'new-session') {
        running = true;
        return result(0);
      }
      if (command === 'kill-session' || command === 'kill-server') {
        running = false;
        return result(0);
      }
      if (command === 'has-session') return running ? result(0) : result(1, '', "can't find session: manager");
      if (command === 'display-message' || command === 'display' || command === 'list-panes') {
        return running ? result(0, 'claude\n') : result(1, '', 'no server running');
      }
      return result(0);
    },
  };
}
