import type { ActionDTO } from '@luady/shared';
import { Badge } from '../../ui/Badge.js';
import { actionTone } from '../../ui/tones.js';

const STATUS_LABEL: Readonly<Record<ActionDTO['status'], string>> = {
  pending_confirmation: 'Waiting for PIN', approved: 'Approved', denied: 'Denied', expired: 'Expired', done: 'Done', failed: 'Failed',
};

export function ActionResult({ action, label }: { action: ActionDTO; label: string }) {
  return (
    <section className="action-result" aria-label={label}>
      <div className="row">
        <Badge tone={actionTone(action.status)}>{STATUS_LABEL[action.status]}</Badge>
        <span className="mono text-subtle">#{action.id}</span>
      </div>
      {action.result ? <pre className="action-result__output">{action.result}</pre> : null}
      {action.error ? <pre className="action-result__output action-result__output--error">{action.error}</pre> : null}
    </section>
  );
}
