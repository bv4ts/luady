/** Runs tmux with an argv array (never a shell). Injectable so tests never touch a real tmux. */
export interface TmuxRunner {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}
