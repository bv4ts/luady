import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root without a trailing separator (Docker --mount rejects a trailing backslash). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]+$/, '');
export const IT_DIR = join(REPO_ROOT, 'tests', 'integration');
export const COMPOSE_FILE = join(IT_DIR, 'docker-compose.yml');
export const WEB_DIST = join(REPO_ROOT, 'packages', 'web', 'dist');
