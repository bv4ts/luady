import { PREVIEW_PORT, previewOrigins } from './config.ts';
import { isEntryFile } from './entry.ts';

// Talks to a running preview over HTTP only, so it starts fast and never needs the build.

export const DRIVE_USAGE = `Usage: npm run preview:drive -- <scenario> [args...] [--port ${PREVIEW_PORT}]

Scenarios (a session is <host>/<name>, for example cedar/meadow-vat):
  work <session> [text]        the session starts a turn
  finish <session> [text]      the session finishes its turn
  ask <session>                the session asks a question
  permit <session> [command]   the session asks permission for a command
  fail <session>               the session stops with an API error
  end <session>                the session ends and its pane closes
  start <server> <name>        a new session starts on cedar, birch, ash or local
  offline <server>             a server goes offline
  online <server>              a server comes back
  demo [seconds]               sessions change every 4 seconds (a session set working runs tool steps)
  stop-demo                    stops the demo
  steps <session> [count]      the session runs tool steps, 700 ms each (default 6); a paused one stops after its next step
  helper <session>             a helper starts, runs three steps and stops
  meters <session> <context%> [5-hour%] [7-day%]   the status line reports context and plan limits
  permit-edit <session>        the session asks permission to edit three lines (offers Allow always)
  permit-command <session> [command]   a kit-2 command preview with its folder (Allow always unless risky)
  results [count]              Luady starts that many updates himself (result notices), 3 seconds apart
  limits <host> <5-hour%> <7-day%>   the host's Claude account reports its plan limits
  no-limits <host>             the host starts over, then five readings without limits: its plan does not report them
  signout <host>               the host's Claude sign-in ends (the hub sees it at its next check)
  say <session> <text>         the session finishes a turn with that message (a speech bubble opens)
  report <session> <text>      a mid-turn luady-report, for example "#12 done: fixed" (ticks a linked card)
  luady-say <text>              Luady takes a turn and answers with that text in the chat
  card <title>                 adds a card to the board
  jira-off / jira-on           disconnects / reconnects Orchard's Jira (the connect form shows while off)
  away [minutes]               the next page load shows Luady's welcome-back card, as if you were away (default 180)
  clock <HH:MM> | clock off    fixes the office clock in owner time for day and night (reload the office)
  light day|dusk|night|dawn|off   the same with a named light
  snooze <minutes> <title>     a new card snoozed for that long (fractions work: 0.5)
  due <minutes> <title>        a new card due in that many minutes
  remind                       the board checks snoozes and due times now (it also does every minute)`;

export interface DriveArgs { readonly scenario: string; readonly args: readonly string[]; readonly port: number }
export interface DriveOutput { log(text: string): void; error(text: string): void }

/** Parses `<scenario> [args...] [--port N]`; returns the text to print when the command line is wrong. */
export function parseDriveArgs(argv: readonly string[]): DriveArgs | string {
  const at = argv.indexOf('--port');
  const portText = at === -1 ? String(PREVIEW_PORT) : argv[at + 1];
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return `--port needs a port number, got "${portText ?? ''}"`;
  const rest = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  const [scenario, ...args] = rest;
  if (scenario === undefined || scenario === '' || scenario === '--help') return DRIVE_USAGE;
  return { scenario, args, port };
}

function errorText(body: unknown, status: number): string {
  const error = typeof body === 'object' && body !== null ? (body as Readonly<Record<string, unknown>>).error : undefined;
  return typeof error === 'string' ? error : `The preview answered HTTP ${status}.`;
}

/** Runs one scenario on the preview; returns the process exit code. */
export async function drive(argv: readonly string[], out: DriveOutput = console): Promise<number> {
  const parsed = parseDriveArgs(argv);
  if (typeof parsed === 'string') {
    out.error(parsed);
    return 1;
  }
  let response: Response;
  try {
    response = await fetch(`http://localhost:${parsed.port}/__preview/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: previewOrigins(parsed.port).https },
      body: JSON.stringify({ scenario: parsed.scenario, args: parsed.args }),
    });
  } catch {
    out.error(`Nothing answers on port ${parsed.port}. Is the preview running? Start it with: npm run preview`);
    return 1;
  }
  const body: unknown = await response.json().catch(() => null);
  const result = typeof body === 'object' && body !== null ? (body as Readonly<Record<string, unknown>>).result : undefined;
  if (response.ok && typeof result === 'string') {
    out.log(result);
    return 0;
  }
  out.error(errorText(body, response.status));
  return 1;
}

if (isEntryFile(import.meta.url)) process.exitCode = await drive(process.argv.slice(2));
