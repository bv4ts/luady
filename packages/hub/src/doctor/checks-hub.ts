import { posix } from 'node:path';
import { SELF_HOST_ID } from '@luady/shared';
import { managerHomeOf, managerTmuxDir, selfCtlPath } from '../config/defaults.js';
import type { HubConfig } from '../core/contracts.js';
import type { HostStatus, HubStatus } from '../wire/status.js';
import { fail, pass, warn, type CheckResult, type DoctorProbe } from './types.js';

export function hubCheck(config: HubConfig | null, status: HubStatus | null): CheckResult | null {
  if (config === null) return null;
  if (status === null) {
    return warn('hub', 'hub', 'The hub is not running: its hosts, add-ons and manager were not checked',
      'Start it with `npm start` (or your systemd unit), then run doctor again.');
  }
  return pass('hub', 'hub', `The hub is running (${status.authMode} sign-in${status.remote ? ', remote' : ', this machine only'})`);
}

const hostLine = (host: HostStatus): string =>
  `${host.id} (${host.kind}): link ${host.link ?? 'none'}, kit ${host.kitVersion ?? 'none'}${host.kitAlias === null ? '' : ` as ${host.kitAlias}`}, `
  + `claude ${host.claudeVersion ?? 'unknown'}${host.lastError === null ? '' : `, last error ${host.lastError}`}`;

/** Every host's link, kit and last error; counts only unless `--full`. */
export function hostsCheck(status: HubStatus | null): CheckResult[] {
  if (status === null) return [];
  const hosts = status.hosts;
  const results: CheckResult[] = [];
  const sync = status.configSync;
  if (sync !== null && sync.collisions.length > 0) {
    results.push(fail('hosts-config', 'hosts', `${sync.collisions.length} server(s) in config.json use the name of a server added on the website and were skipped`,
      'Rename or remove those entries in config.json: website servers keep their names.', sync.collisions.join(', ')));
  }
  if (hosts.length === 0) {
    results.push(pass('hosts', 'hosts', 'No servers yet (add this computer or a server in Settings → Servers)'));
    return results;
  }
  const detail = hosts.map(hostLine).join('\n');
  const refused = hosts.filter((host) => host.lastError === 'auth' || host.lastError === 'hostkey');
  const offline = hosts.filter((host) => host.link !== 'online');
  const noKit = hosts.filter((host) => host.kitVersion === null);
  const counts = `${hosts.length} host(s): ${hosts.length - offline.length} online, ${offline.length} not online, ${noKit.length} without the kit`;
  if (refused.length > 0) {
    results.push(fail('hosts', 'hosts', `${counts}; ${refused.length} refused the hub (key or host key)`,
      'Open Settings → Servers: "Check" shows the line to paste again, or the host key to compare again.', detail));
  } else if (offline.length > 0 || noKit.length > 0) {
    results.push(warn('hosts', 'hosts', counts, 'Open Settings → Servers to check the link or install the kit.', detail));
  } else {
    results.push(pass('hosts', 'hosts', counts, detail));
  }
  return results;
}

export function addonsCheck(status: HubStatus | null): CheckResult | null {
  if (status === null) return null;
  const addons = status.addons;
  if (addons.length === 0) return pass('add-ons', 'add-ons', 'No add-on declared (everything reaches you on the website)');
  const down = addons.filter((addon) => !addon.connected);
  const detail = addons.map((addon) => `${addon.id} (${addon.kind}): ${addon.state}`).join('\n');
  if (down.length === 0) return pass('add-ons', 'add-ons', `${addons.length} add-on(s), all connected`, detail);
  return warn('add-ons', 'add-ons', `${down.length} of ${addons.length} add-on(s) not connected`,
    'Start the add-on (it reads its token from the hub\'s data folder), or remove it from "addons" in config.json.', detail);
}

/** What the self host's kit says about itself: `host_alias` in its state file. */
function kitAlias(probe: DoctorProbe, managerHome: string): string | null {
  const text = probe.readText(posix.join(managerHome, '.luady', 'state', 'config.json'));
  if (text === null) return null;
  try {
    const alias: unknown = (JSON.parse(text) as { host_alias?: unknown }).host_alias;
    return typeof alias === 'string' ? alias : null;
  } catch {
    return null;
  }
}

async function selfKitChecks(probe: DoctorProbe, config: HubConfig, status: HubStatus): Promise<CheckResult[]> {
  const home = managerHomeOf(config);
  const ctl = selfCtlPath(home);
  const facts = probe.stat(ctl);
  if (facts?.executable !== true) {
    return [fail('manager-ctl', 'manager', 'The manager\'s own luady-ctl is missing or not executable',
      'Switch the manager off and on again in Settings: its setup installs the kit under its own home.', ctl)];
  }
  const env = { ...process.env, HOME: home, TMUX_TMPDIR: managerTmuxDir(home) };
  const answer = await probe.exec(ctl, ['version'], env);
  let version: string | null = null;
  try {
    const kit: unknown = (JSON.parse(answer.stdout) as { kit?: unknown }).kit;
    version = typeof kit === 'string' ? kit : null;
  } catch {
    version = null;
  }
  const expected = status.manager.bootstrap.kit.version;
  const results: CheckResult[] = [];
  if (answer.code !== 0 || version === null) {
    results.push(fail('manager-ctl', 'manager', 'The manager\'s own luady-ctl does not answer `version`',
      'Switch the manager off and on again in Settings to reinstall its kit.', `${ctl}: ${answer.stderr.trim().slice(0, 200)}`));
  } else if (expected !== null && version !== expected) {
    results.push(warn('manager-ctl', 'manager', `The manager's kit is ${version}, the hub expects ${expected}`,
      'Restart the hub: its manager setup updates the kit.', ctl));
  } else {
    results.push(pass('manager-ctl', 'manager', `The manager's own luady-ctl answers (kit ${version})`, ctl));
  }
  // "Signed in" is the manager's own Claude Code sign-in, under its home.
  const auth = await probe.exec(ctl, ['auth-status'], env);
  let signedIn: boolean | null = null;
  try {
    const value: unknown = (JSON.parse(auth.stdout) as { logged_in?: unknown }).logged_in;
    signedIn = typeof value === 'boolean' ? value : null;
  } catch {
    signedIn = null;
  }
  results.push(signedIn === true
    ? pass('manager-signin', 'manager', 'The manager is signed in to Claude')
    : warn('manager-signin', 'manager', signedIn === false ? 'The manager is not signed in to Claude' : 'The manager\'s Claude sign-in could not be read',
      'Settings → General → "Sign the manager in to Claude".'));
  const alias = kitAlias(probe, home);
  results.push(alias === SELF_HOST_ID
    ? pass('manager-alias', 'manager', `The manager's kit answers to its own name (${SELF_HOST_ID})`)
    : fail('manager-alias', 'manager', alias === null ? 'The manager\'s kit has no name' : 'The manager\'s kit answers to another name',
      'Switch the manager off and on again in Settings: its setup reinstalls the kit under its own name.', alias));
  return results;
}

/** With the switch off, every check of the manager says "manager off" and nothing fails. */
export async function managerChecks(probe: DoctorProbe, config: HubConfig | null, status: HubStatus | null): Promise<CheckResult[]> {
  if (config === null || status === null) return [];
  const manager = status.manager;
  if (manager.switch === 'off') return [pass('manager', 'manager', 'manager off (switch it on in Settings → General when you want it)')];
  const steps = manager.bootstrap.steps;
  const failed = steps.filter((step) => step.state === 'failed');
  const stepsText = steps.map((step) => `${step.id}: ${step.state}`).join(', ');
  const results: CheckResult[] = [];
  if (manager.switch === 'failed' || failed.length > 0) {
    results.push(fail('manager-setup', 'manager', `The manager's setup stopped at: ${failed.map((step) => step.id).join(', ') || 'a step'}`,
      'Read the step\'s line in Settings → General, fix it, then switch the manager off and on again.',
      steps.map((step) => `${step.id}: ${step.state}${step.detail === null ? '' : ` (${step.detail})`}`).join('\n')));
    return results;
  }
  if (manager.switch === 'starting') {
    results.push(warn('manager-setup', 'manager', `The manager is still setting itself up (${stepsText})`, 'Wait a minute, then run doctor again.'));
    return results;
  }
  results.push(pass('manager-setup', 'manager', `The manager is set up (${stepsText})`));
  results.push(manager.state === 'running' || manager.state === 'busy'
    ? pass('manager-run', 'manager', `The manager is ${manager.state}`)
    : warn('manager-run', 'manager', `The manager is ${manager.state}`, 'Open the office: the manager panel says what it is waiting for (often its Claude sign-in).'));
  results.push(...await selfKitChecks(probe, config, status));
  const socket = probe.stat(managerTmuxDir(managerHomeOf(config)));
  results.push(socket?.isDir === true
    ? pass('manager-tmux', 'manager', 'The manager has its own tmux server')
    : warn('manager-tmux', 'manager', 'The manager\'s tmux folder is missing', 'Restart the hub: the manager makes it when it starts.'));
  return results;
}
