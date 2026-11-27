import { cleanupRun, runEnvFromProcess } from '../harness/run-env.js';

export default async function globalTeardown(): Promise<void> {
  await cleanupRun(runEnvFromProcess());
}
