import type { ServerDTO } from '@luady/shared';
import { Link } from 'react-router';
import { LOW_DISK_KB, formatKb } from '../../lib/format.js';
import { serverTone, type Tone } from '../../ui/tones.js';

function HealthChip({ server }: { server: ServerDTO }) {
  const info = server.sysinfo;
  const lowDisk = info !== null && info.disk_free_kb < LOW_DISK_KB;
  const tone: Tone = server.status !== 'online' ? serverTone(server.status) : lowDisk ? 'waiting' : 'idle';
  const meta = server.status === 'online' && info ? `load ${info.load1.toFixed(1)} · ${formatKb(info.disk_free_kb)} free` : server.status;
  return (
    <li className={`health__item tone-${tone}`}>
      <Link className="health__link" to={`/servers/${server.name}`}>
        <span className="health__dot" aria-hidden="true" />
        <span className="health__name">{server.name}</span>
        <span className="health__meta">{meta}</span>
        {lowDisk ? <span className="health__warn">low disk</span> : null}
      </Link>
    </li>
  );
}

export function HealthStrip({ servers }: { servers: readonly ServerDTO[] }) {
  if (servers.length === 0) return null;
  return (
    <ul className="health" aria-label="Server health">
      {servers.map((server) => <HealthChip key={server.name} server={server} />)}
    </ul>
  );
}
