import type { HostId } from '@luady/shared';
import type { Db, Logger, OutboundChannel, SettingsService } from '../core/contracts.js';
import { inQuietHours } from '../core/time.js';
import { expiringAlert, hostLabel, signedOutAlert } from './text.js';

export const WARN_AHEAD_MS = 48 * 60 * 60_000;
/** The alert value of a host that is signed out (else the expiry it warned about). */
export const ALERT_OUT = 'out';

export interface LoginAlertDeps {
  db: Db;
  log: Logger;
  outbound: Pick<OutboundChannel, 'send'>;
  settings: Pick<SettingsService, 'get'>;
}

export interface LoginAlerts {
  /** Warns the owner once per state: signed out, or a login that runs out within 48 h. */
  warnIfDue(host: HostId, status: { logged_in: boolean; expires_at: string | null }, now: Date): Promise<void>;
  /** Records an alert as already known to the owner (a sign-out they asked for) without sending anything. */
  known(host: HostId, alert: string, now: Date): void;
  clear(host: HostId): void;
}

/** The alert due for a login, or null when it is fine. */
function alertFor(status: { logged_in: boolean; expires_at: string | null }, now: Date): string | null {
  if (!status.logged_in) return ALERT_OUT;
  if (status.expires_at === null) return null;
  const left = Date.parse(status.expires_at) - now.getTime();
  return Number.isFinite(left) && left <= WARN_AHEAD_MS ? status.expires_at : null;
}

/** Sign-in alerts with their dedupe in `login_alerts`. */
export function createLoginAlerts(deps: LoginAlertDeps): LoginAlerts {
  const getAlert = deps.db.prepare<[string], { alert: string }>('SELECT alert FROM login_alerts WHERE host = ?');
  const putAlert = deps.db.prepare<[string, string, string]>(
    'INSERT INTO login_alerts (host, alert, sent_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET alert = excluded.alert, sent_at = excluded.sent_at',
  );
  const clearAlert = deps.db.prepare<[string]>('DELETE FROM login_alerts WHERE host = ?');

  return {
    async warnIfDue(host, status, now) {
      const alert = alertFor(status, now);
      if (alert === null) {
        clearAlert.run(host);
        return;
      }
      if (getAlert.get(host)?.alert === alert) return;
      // Running out soon can wait for the morning; signed out means it is broken now.
      if (alert !== ALERT_OUT && inQuietHours(now, deps.settings.get().quiet_hours)) return;
      const text = alert === ALERT_OUT ? signedOutAlert(host) : expiringAlert(host, new Date(alert), now);
      await deps.outbound.send(text, null);
      putAlert.run(host, alert, now.toISOString());
      deps.log.info({ host, alert }, `claude-login: warned the owner about ${hostLabel(host)}`);
    },
    known(host, alert, now) {
      putAlert.run(host, alert, now.toISOString());
    },
    clear(host) {
      clearAlert.run(host);
    },
  };
}
