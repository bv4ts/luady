import { isSelfHost, type AccountDTO, type FleetHistoryDTO, type ServerDTO, managerName } from '@luady/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { useOfficeNav } from '../../give/GiveContext.js';
import { teamStyle } from '../../model/team-style.js';
import { compareOffices } from '../library/library-model.js';
import { useLoaded } from '../library/useLoaded.js';
import { clockText } from '../schedule/owner-time.js';
import {
  accountLimits, accountName, accountSeries, dayWindow, limitTone, loadMax, serverFacts, serverSeries,
} from './fleet-model.js';
import { Sparkline } from './Sparkline.js';
import '../../hud/kit.css';
import './fleet.css';

export interface FleetModalProps {
  readonly onClose: () => void;
}

const MINUTE_MS = 60_000;

/** A count that goes up once a minute while the pop-up is open (the graphs and "now" follow it). */
function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return tick;
}

/** The accounts from the store; fetched once here when the page has not loaded them yet. */
function useAccountList(): readonly AccountDTO[] | null {
  const api = useApi();
  const { state, dispatch } = useStore();
  const missing = state.accounts === null;
  useEffect(() => {
    if (!missing) return;
    api.accounts().then((accounts) => dispatch({ type: 'accounts.loaded', accounts }), () => undefined);
  }, [api, dispatch, missing]);
  return state.accounts?.accounts ?? null;
}

/** The fleet wall: every server and account now, each with its last 24 hours, on a control-room screen. */
export function FleetModal(_props: FleetModalProps) {
  const api = useApi();
  const { state } = useStore();
  const lookup = useRooms();
  const nav = useOfficeNav();
  const tick = useMinuteTick();
  const history = useLoaded(useCallback(() => api.fleetHistory(), [api]), 'fleet', tick);
  const accounts = useAccountList();
  const now = Date.now();
  const span = dayWindow(now);
  const data = history.state.kind === 'ready' ? history.state.value : null;
  const order = compareOffices(lookup);
  const servers = state.servers.filter((server) => !isSelfHost(server.name)).toSorted((a, b) => order(a.name, b.name));
  const alert = servers.some((s) => s.status === 'offline')
    || (accounts ?? []).some((a) => accountLimits(a, now).some((l) => limitTone(l.pct) === 'alert'));

  return (
    <div className="fleet" data-testid="fleet-modal">
      <header className="fleet__bar">
        <span className={alert ? 'fleet__lamp fleet__lamp--alert' : 'fleet__lamp'} aria-hidden="true" />
        <h3 className="agency-title fleet__title">Fleet</h3>
        <span className="fleet__meta">
          {servers.length} servers · {(accounts ?? []).length} accounts · {alert ? 'needs a look' : 'all well'} · {clockText(now)}
        </span>
      </header>
      {history.state.kind === 'failed' ? (
        <p className="fleet__note" role="status">
          {isApiError(history.state.error) && (history.state.error.status === 404 || history.state.error.status === 501)
            ? 'The graphs need the next hub update. The numbers below are live.'
            : 'The graphs could not load. The numbers below are live.'}
        </p>
      ) : null}
      <section className="fleet__group" aria-label="Servers">
        <h4 className="fleet__label">Servers <span>last 24 hours</span></h4>
        {servers.length === 0 ? <p className="fleet__note">No servers yet.</p> : (
          <ul className="fleet__rows">
            {servers.map((server) => (
              <li key={server.name}><ServerRow server={server} data={data} now={now} span={span} onOpen={nav === null ? null : () => nav.openRack(server.name)} /></li>
            ))}
          </ul>
        )}
      </section>
      <section className="fleet__group" aria-label="Accounts">
        <h4 className="fleet__label">Accounts <span>limits over the last 24 hours</span></h4>
        {accounts === null ? <p className="fleet__note" role="status">Reading the accounts…</p>
          : accounts.length === 0 ? <p className="fleet__note">No accounts signed in.</p> : (
            <ul className="fleet__rows">
              {accounts.map((account) => <li key={account.id}><AccountRow account={account} data={data} now={now} span={span} /></li>)}
            </ul>
          )}
      </section>
    </div>
  );
}

function ServerRow({ server, data, now, span, onOpen }: {
  server: ServerDTO; data: FleetHistoryDTO | null; now: number; span: { from: number; to: number }; onOpen: (() => void) | null;
}) {
  const { state } = useStore();
  const { room: roomOf, hostLabel, roomPalette } = useRooms();
  const facts = serverFacts(server, state.sessions, now);
  const series = serverSeries(data, server.name);
  const room = roomOf(server.name) ?? null;
  const name = hostLabel(server.name);
  const body = (
    <>
      <span className="fleet-row__name">
        <span className={facts.online ? 'fleet-row__link' : 'fleet-row__link fleet-row__link--down'} aria-hidden="true" />
        <span className="agency-pixel">{name}</span>
        <span className="fleet-row__host">{server.name}</span>
      </span>
      <span className="fleet-row__facts">
        <span className={facts.online ? '' : 'fleet-row__down'}>{facts.link}</span>
        <span>{facts.sessions}</span>
        <span className="fleet-row__versions">{facts.versions}</span>
      </span>
      <span className="fleet-row__graphs">
        <span className="fleet-graph"><span className="fleet-graph__label">{facts.load}</span>
          <Sparkline points={series.load} {...span} max={loadMax(series.load)} label={`${facts.load}, last 24 hours`} /></span>
        <span className="fleet-graph"><span className="fleet-graph__label">{facts.mem}</span>
          <Sparkline points={series.mem} {...span} max={100} label={`${facts.mem}, last 24 hours`} /></span>
        <span className="fleet-graph"><span className="fleet-graph__label">{facts.disk}</span>
          {series.disk === null ? <span className="fleet-graph__none">no disk history on this kit</span>
            : <Sparkline points={series.disk} {...span} max={100} label={`${facts.disk}, last 24 hours`} />}</span>
      </span>
    </>
  );
  const style = room === null ? undefined : teamStyle(roomPalette(server.name));
  // A host without a room has no rack on the map to open.
  return onOpen === null || room === null
    ? <div className="fleet-row" style={style}>{body}</div>
    : <button type="button" className="fleet-row" style={style} onClick={onOpen} aria-label={`${name}: open the rack`}>{body}</button>;
}

function AccountRow({ account, data, now, span }: { account: AccountDTO; data: FleetHistoryDTO | null; now: number; span: { from: number; to: number } }) {
  const { hostLabel } = useRooms();
  const limits = accountLimits(account, now);
  const series = accountSeries(data, account.id);
  const label = data?.accounts.find((a) => a.id === account.id)?.label ?? account.hosts.map((h) => hostLabel(h.host)).join(', ');
  return (
    <div className="fleet-row fleet-row--account">
      <span className="fleet-row__name">
        <span className="agency-pixel" dir="auto">{accountName(account, label)}</span>
        <span className="fleet-row__host">{account.plan ?? ''}{account.isManager ? ` · ${managerName()}` : ''}</span>
      </span>
      <span className="fleet-row__graphs fleet-row__graphs--two">
        {limits.map((limit, index) => (
          <span key={limit.label} className={`fleet-graph fleet-graph--${limitTone(limit.pct)}`}>
            <span className="fleet-graph__label">{limit.label}: {limit.text}</span>
            <span className="fleet-meter" aria-hidden="true"><span className="fleet-meter__fill" style={{ inlineSize: `${String(limit.pct ?? 0)}%` }} /></span>
            <Sparkline points={index === 0 ? series.fiveHour : series.sevenDay} {...span} max={100} mark={80} tone={limitTone(limit.pct)}
              label={`${limit.label} limit, last 24 hours`} />
          </span>
        ))}
      </span>
    </div>
  );
}
