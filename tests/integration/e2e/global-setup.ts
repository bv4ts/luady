import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildHubImage } from '../harness/hub-machine.js';
import { WEB_DIST } from '../harness/paths.js';
import { prepareRun, RUN_ENV_VAR } from '../harness/run-env.js';

export default async function globalSetup(): Promise<void> {
  if (!existsSync(join(WEB_DIST, 'index.html'))) throw new Error('packages/web/dist/index.html is missing: run `npm run build` first');
  const env = await prepareRun();
  // The hub machine of the specs that run the real `luady start` (manager, and the first-run specs).
  await buildHubImage(env);
  process.env[RUN_ENV_VAR] = JSON.stringify(env);
}
