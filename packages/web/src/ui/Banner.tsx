import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export function Banner({ tone, children, action }: { tone: 'info' | 'warn' | 'error'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'info' ? 'message' : 'alert'} />
      <div className="banner__body">{children}</div>
      {action ? <div className="banner__action">{action}</div> : null}
    </div>
  );
}
