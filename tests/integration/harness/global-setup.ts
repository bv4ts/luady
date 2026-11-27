import type { TestProject } from 'vitest/node';
import { cleanupRun, prepareRun, type RunEnv } from './run-env.js';

declare module 'vitest' {
  export interface ProvidedContext {
    luadyIt: RunEnv;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const env = await prepareRun();
  project.provide('luadyIt', env);
  return async () => {
    await cleanupRun(env);
  };
}
