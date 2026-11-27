import type { CtlSysinfo, ServerDTO } from '@luady/shared';
import { Link } from 'react-router';
import { LOW_DISK_KB, formatKb, formatUptime, percentUsed, timeAgo } from '../../lib/format.js';
import { Badge } from '../../ui/Badge.js';
import { Icon } from '../../ui/Icon.js';
import { serverTone } from '../../ui/tones.js';
import { useRooms } from '../rooms/useRooms.js';
import { useProjects, type ProjectsState } from './useProjects.js';

function Metrics({ info }: { info: CtlSysinfo }) {
  const memUsed = percentUsed(info.mem_total_kb, info.mem_avail_kb);
  const lowDisk = info.disk_free_kb < LOW_DISK_KB;
  const gauge = memUsed >= 90 ? 'gauge gauge--danger' : memUsed >= 75 ? 'gauge gauge--warn' : 'gauge';
  return (
    <div className="metrics">
      <div className="metric">
        <span className="metric__label">Load</span>
        <span className="metric__value">{info.load1.toFixed(2)}</span>
        <span className="metric__hint">5 min {info.load5.toFixed(2)}</span>
      </div>
      <div className="metric">
        <span className="metric__label">Memory</span>
        <span className="metric__value">{memUsed}%</span>
        <progress className={gauge} max={100} value={memUsed} aria-label="Memory used" />
      </div>
      <div className="metric">
        <span className="metric__label">Disk free</span>
        <span className={lowDisk ? 'metric__value metric__value--warn' : 'metric__value'}>{formatKb(info.disk_free_kb)}</span>
        {lowDisk ? <span className="metric__hint metric__hint--warn">Low disk space</span> : null}
      </div>
      <div className="metric">
        <span className="metric__label">Uptime</span>
        <span className="metric__value">{formatUptime(info.uptime_s)}</span>
      </div>
    </div>
  );
}

function ProjectsSummary({ projects, loading, error }: ProjectsState) {
  if (loading) return <p className="text-subtle">Loading projects…</p>;
  if (error) return <p className="form-error">Couldn't load projects: {error}</p>;
  if (projects.length === 0) return <p className="text-subtle">No git projects found.</p>;
  const shown = projects.slice(0, 6);
  return (
    <div className="stack">
      <h3 className="section-title">Projects ({projects.length})</h3>
      <ul className="project-list">
        {shown.map((project) => (
          <li key={project.path} className="project-list__item">
            <span className="project-list__name">{project.name}</span>
            {project.branch ? <span className="chip mono">{project.branch}</span> : null}
            {project.stack.slice(0, 3).map((tag) => <span key={tag} className="chip">{tag}</span>)}
            {project.commits[0] ? <span className="project-list__commit text-subtle" dir="auto">{project.commits[0].subject}</span> : null}
          </li>
        ))}
      </ul>
      {projects.length > shown.length ? <p className="text-subtle">+{projects.length - shown.length} more</p> : null}
    </div>
  );
}

export function ServerCard({ server, showLinks = true }: { server: ServerDTO; showLinks?: boolean }) {
  const projects = useProjects(server.name);
  const label = useRooms().hostLabel(server.name);
  return (
    <article className="card server-card" aria-label={`Server ${server.name}`}>
      <header className="card__header">
        <div className="card__heading">
          <h2 className="card__title mono">{server.name}</h2>
          <p className="card__subtitle mono">{label === server.name ? server.host : `${label} · ${server.host}`}</p>
        </div>
        <Badge tone={serverTone(server.status)}>{server.status}</Badge>
      </header>
      {server.sysinfo ? <Metrics info={server.sysinfo} /> : <p className="text-subtle">No health data yet.</p>}
      <dl className="kv">
        <dt>Claude Code</dt><dd className="mono">{server.claudeVersion ?? '—'}</dd>
        <dt>Luady kit</dt><dd className="mono">{server.kitVersion ?? '—'}</dd>
        <dt>Last seen</dt><dd>{timeAgo(server.lastSeenAt)}</dd>
      </dl>
      <ProjectsSummary {...projects} />
      {showLinks ? (
        <div className="row">
          <Link to={`/servers/${server.name}`} className="btn btn--secondary btn--sm">Manage</Link>
          {server.terminal ? (
            <Link to={`/terminal/${server.name}`} className="btn btn--ghost btn--sm"><Icon name="terminal" /><span className="btn__label">Terminal</span></Link>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
