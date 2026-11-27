import { posix } from 'node:path';
import { bindHostOf } from '../config/defaults.js';
import type { HubConfig } from '../core/contracts.js';
import type { HubStatus } from '../wire/status.js';
import { fail, pass, warn, type CheckResult, type DoctorProbe } from './types.js';

const NODE_MIN: readonly [number, number] = [22, 12];
const PYTHON_MIN: readonly [number, number] = [3, 10];

/** The first `major.minor` in a version text, or null. */
export function majorMinor(text: string): [number, number] | null {
  const match = /(\d+)\.(\d+)/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

const atLeast = (found: readonly [number, number], min: readonly [number, number]): boolean =>
  found[0] > min[0] || (found[0] === min[0] && found[1] >= min[1]);

export function nodeCheck(probe: DoctorProbe): CheckResult {
  const version = probe.nodeVersion();
  const found = majorMinor(version);
  if (found !== null && atLeast(found, NODE_MIN)) return pass('node', 'system', `Node.js ${version}`);
  return fail('node', 'system', `Node.js ${version} is too old`, `Install Node.js ${NODE_MIN.join('.')} or later (the .nvmrc says 22).`);
}

export function platformCheck(probe: DoctorProbe): CheckResult {
  const platform = probe.platform();
  if (platform === 'linux') return pass('platform', 'system', 'Linux');
  if (platform === 'win32') {
    return warn('platform', 'system', 'Windows: the hub runs on Linux or in WSL2, not natively on Windows',
      'Run the hub inside WSL2 (Ubuntu). On Windows itself, `npm run demo` shows the office with everything faked.');
  }
  return warn('platform', 'system', `${platform}: the hub is tested on Linux only`, 'Run the hub on Linux or in WSL2.');
}

/** tmux, Python 3.10 or later, and Claude Code at the configured path. */
export async function toolChecks(probe: DoctorProbe, config: HubConfig | null): Promise<CheckResult[]> {
  const tmux = await probe.exec('tmux', ['-V']);
  const python = await probe.exec('python3', ['--version']);
  const pyVersion = majorMinor(`${python.stdout}${python.stderr}`);
  const results: CheckResult[] = [
    tmux.code === 0
      ? pass('tmux', 'system', `tmux ${tmux.stdout.trim().replace(/^tmux\s+/, '')}`)
      : warn('tmux', 'system', 'tmux was not found', 'Install tmux (for example `sudo apt install tmux`): this computer and the manager run sessions in it.'),
    pyVersion !== null && python.code === 0 && atLeast(pyVersion, PYTHON_MIN)
      ? pass('python', 'system', `Python ${pyVersion.join('.')}`)
      : warn('python', 'system', pyVersion === null ? 'python3 was not found' : `Python ${pyVersion.join('.')} is too old`,
        `Install Python ${PYTHON_MIN.join('.')} or later as python3: the kit needs it on this computer and for the manager.`),
  ];
  if (config === null) return results;
  const claude = probe.stat(config.claudePath);
  results.push(claude?.executable === true
    ? pass('claude', 'system', 'Claude Code is installed at the configured path', config.claudePath)
    : warn('claude', 'system', 'Claude Code was not found at the configured path',
      'Install Claude Code (it goes to ~/.local/bin/claude), or set "claudePath" in config.json. Only this computer and the manager need it here.',
      config.claudePath));
  return results;
}

export function webBuildCheck(probe: DoctorProbe, config: HubConfig | null): CheckResult | null {
  if (config === null) return null;
  const index = posix.join(config.webDir, 'index.html');
  return probe.stat(index)?.isFile === true
    ? pass('web-build', 'system', 'The website is built', index)
    : fail('web-build', 'system', 'The website is not built', 'Run `npm run build` in the checkout.', index);
}

/** The web port: the hub's own when it answers, else free, else held by another program. */
export async function portCheck(probe: DoctorProbe, config: HubConfig | null, status: HubStatus | null): Promise<CheckResult | null> {
  if (config === null) return null;
  const where = `${bindHostOf(config)}:${config.webPort}`;
  if (status !== null) return pass('port', 'system', 'The hub answers on its port', where);
  if (await probe.portFree(bindHostOf(config), config.webPort)) return pass('port', 'system', 'The web port is free for the hub', where);
  return fail('port', 'system', 'Another program holds the web port', 'Stop that program, or set another "webPort" in config.json.', where);
}
