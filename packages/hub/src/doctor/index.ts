import { addonsCheck, hostsCheck, hubCheck, managerChecks } from './checks-hub.js';
import { codexSignInCheck, configCheck, databaseCheck, fleetKeyCheck, modesCheck, ownerZoneCheck, refusalsCheck, setupCheck } from './checks-install.js';
import { nodeCheck, platformCheck, portCheck, toolChecks, webBuildCheck } from './checks-system.js';
import { reportOf, type DoctorReport } from './report.js';
import type { CheckResult, DoctorInput } from './types.js';

export { realProbe } from './probe.js';
export { renderJson, renderText, type DoctorReport } from './report.js';
export type { CheckResult, CheckState, DoctorInput, DoctorProbe } from './types.js';

const present = (check: CheckResult | null): CheckResult[] => (check === null ? [] : [check]);

/** Runs every check, in the order a person fixes things: the machine, the install, then the running hub. */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const { config, probe } = input;
  const status = config === null ? null : await probe.status(config);
  const checks: CheckResult[] = [
    nodeCheck(probe),
    platformCheck(probe),
    ...await toolChecks(probe, config),
    ...present(webBuildCheck(probe, config)),
    configCheck(input),
    ...present(modesCheck(input)),
    ...present(databaseCheck(input)),
    ...present(refusalsCheck(input)),
    ...present(ownerZoneCheck(input)),
    ...present(setupCheck(input)),
    ...present(fleetKeyCheck(input)),
    ...present(codexSignInCheck(input)),
    ...present(await portCheck(probe, config, status)),
    ...present(hubCheck(config, status)),
    ...hostsCheck(status),
    ...present(addonsCheck(status)),
    ...await managerChecks(probe, config, status),
  ];
  return reportOf(checks);
}
