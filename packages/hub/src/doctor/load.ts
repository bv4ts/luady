import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { databaseFiles } from '../config/defaults.js';
import { configPaths, loadConfig } from '../config/load.js';
import type { Db, HubConfig } from '../core/contracts.js';
import { realProbe } from './probe.js';
import type { DoctorInput } from './types.js';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * What `doctor` reads, without changing anything: no starter config, no new secret, no migration. The database is
 * opened read-only, and only when it exists.
 */
export function loadDoctorInput(env: NodeJS.ProcessEnv, home?: string): DoctorInput & { close(): void } {
  const paths = configPaths(env, home);
  let config: HubConfig | null = null;
  let configError: string | null = null;
  if (!existsSync(paths.configPath)) configError = 'there is no config.json yet (the first `npm start` writes one)';
  else if (!existsSync(paths.secretsPath)) configError = 'secrets.env is missing (the first `npm start` writes it)';
  else {
    try {
      config = loadConfig(env, home === undefined ? {} : { home });
    } catch (err) {
      configError = message(err);
    }
  }
  let db: Db | null = null;
  let dbError: string | null = null;
  const file = config === null ? undefined : databaseFiles(config)[0];
  if (file !== undefined) {
    if (!existsSync(file)) dbError = 'there is no database yet (the first `npm start` makes it)';
    else {
      try {
        db = new Database(file, { readonly: true, fileMustExist: true }) as unknown as Db;
      } catch (err) {
        dbError = message(err);
      }
    }
  }
  return {
    paths, config, configError, db, dbError, probe: realProbe,
    close: () => {
      if (db?.open === true) db.close();
    },
  };
}
