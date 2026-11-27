import { Link } from 'react-router';
import { timeAgo } from '../../lib/format.js';
import { Badge } from '../../ui/Badge.js';
import type { Tone } from '../../ui/tones.js';

export function CardHead({ kind, tone, label, sessionId, reference, createdAt }: {
  kind: string; tone: Tone; label: string; sessionId?: string; reference: string; createdAt: string;
}) {
  return (
    <header className="qcard__head">
      <Badge tone={tone}>{kind}</Badge>
      {sessionId
        ? <Link className="qcard__label" to={`/sessions/${encodeURIComponent(sessionId)}`}>{label}</Link>
        : <span className="qcard__label">{label}</span>}
      <span className="qcard__meta"><span className="mono">#{reference}</span> · {timeAgo(createdAt)}</span>
    </header>
  );
}
