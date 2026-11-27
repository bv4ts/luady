import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty__icon"><Icon name={icon} /></span>
      <h2 className="empty__title">{title}</h2>
      {body ? <p className="empty__body">{body}</p> : null}
      {action ?? null}
    </div>
  );
}
