import { ApiError, userMessage } from '../../api/errors.js';
import type { HostCheckResult } from '../../api/hosts.js';

/**
 * Every refusal of the hosts API in the owner's words, each saying what to do next. The hub's own
 * message text is never shown; neither is anything a server printed, beyond the cleaned lines of a kit job.
 */
const CODE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  host_exists: 'That name is taken, or was used by a server you removed. Names are never reused: choose another.',
  local_exists: 'This computer is set up already. You find it in the list of servers.',
  host_from_config: 'This server comes from the config file, so it is changed there. Edit config.json, then restart the hub.',
  host_removed: 'This server was removed. Add it again under a new name.',
  host_not_pinned: 'Confirm the server\'s fingerprint first, then check the connection.',
  host_is_local: 'This computer needs no fingerprint or key line.',
  host_offline: 'The server is not connected right now. Check the connection first, then try again.',
  scan_needed: 'The connection test is too old. Test the connection again, then confirm the fingerprint.',
  fingerprint_changed: 'The fingerprint changed since the test. Test the connection again and compare once more.',
  job_running: 'A kit job is already running on this server. Wait for it to finish.',
  host_busy: 'This server is being changed right now. Wait a moment, then try again.',
  jobs_busy: 'Three kit jobs are running. Try again when one of them has finished.',
  fleet_from_invalid: 'The fleetFrom list in config.json has an entry that is not an IP address or a network. Fix it, then restart the hub.',
  address_refused: 'That address is one the hub never connects to (a link-local, multicast or empty address). Use the server\'s real address.',
  folder_missing: 'That folder does not exist. Tick "Create it if missing", or choose a folder that exists.',
  folder_outside_home: 'A new folder can only be made inside your home folder. Choose a folder there, or one that already exists.',
  folder_parent_missing: 'The folder above it does not exist. Choose a folder whose parent exists.',
  not_a_folder: 'That path is a file, not a folder. Choose a folder.',
  folder_invalid: 'The hub cannot use that folder. Give a full path such as ~/projects or /home/you/work, with letters, digits, dots, dashes and slashes only (no spaces).',
  local_unsupported: 'This computer can be added only when the hub runs on Linux or in WSL2. This hub runs on Windows: run it inside WSL2 to add this computer, or add your servers instead.',
  local_fields: 'This computer has no address, user or port to change.',
  unreachable: 'The server could not be reached. Check that it is on, that the address and port are right, and that no firewall blocks it.',
  no_ssh: 'Something answered on that port, but it is not an SSH server. Check the port (usually 22).',
  grant_required: 'This step needs your PIN again. Confirm it to go on.',
  pin_required: 'This change needs your PIN.',
  rate_limited: 'Too many tries in a short time. Wait a minute, then try again.',
  validation: 'Something in the form is not allowed. Check the name, the address, the user and the port.',
  invalid_request: 'Something in the form is not allowed. Check the fields and try again.',
});

/** The plain-words message for any error of the hosts flow. */
export function hostErrorText(err: unknown): string {
  if (err instanceof ApiError && Object.hasOwn(CODE_TEXT, err.code)) return CODE_TEXT[err.code] ?? userMessage(err);
  return userMessage(err);
}

/** This computer's form has one field, the folder: a refusal of the form is about it, never a name, address or port. */
export function localErrorText(err: unknown): string {
  if (err instanceof ApiError && (err.code === 'validation' || err.code === 'invalid_request')) return CODE_TEXT.folder_invalid ?? userMessage(err);
  return hostErrorText(err);
}

/** What a `check` found, in one sentence that says what comes next. */
export function checkText(result: HostCheckResult, host: string): string {
  switch (result.auth) {
    case 'ok':
      return result.missing.length === 0
        ? `The hub signed in to ${host}, and everything the kit needs is there.`
        : `The hub signed in to ${host}. Before the kit can go on, see to these:`;
    case 'denied':
      return `${host} refused the hub's key. Paste the line below on ${host} again, as the user you gave, then press Try again.`;
    case 'unreachable':
      return `${host} could not be reached. Check that it is on and that the address and port are right, then press Try again.`;
    case 'hostkey-mismatch':
      return `${host} showed a different fingerprint from the one you confirmed. Do not go on: if the server was reinstalled, test the connection again and compare the new fingerprint on the server itself.`;
  }
}

/** One removal step's outcome, as a short phrase. */
export function stepText(outcome: 'done' | 'skipped' | 'failed' | 'unreachable'): string {
  return { done: 'done', skipped: 'not asked', failed: 'did not work', unreachable: 'server not reachable' }[outcome];
}
