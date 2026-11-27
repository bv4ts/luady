import '../../src/zod-csp.js';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/components.css';
import '../../src/styles/layout.css';
import type { WsServerMessage } from '@luady/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeDemo } from './app.js';
import { iso } from './data.js';
import { createFakeHub } from './fake-hub.js';
import { freshNotice, sentFrames } from './fake-socket.js';

/**
 * Development page: the real office page (AgencyPage, its store, the real API client and its schemas) against a pretend
 * hub with live activity data. `?old=1` plays an older hub that has none of the live-activity routes or messages.
 */

declare global {
  interface Window { __officeDemo?: { push(message: WsServerMessage): void; notice(kind?: string): void; sent: typeof sentFrames } }
}

const params = new URLSearchParams(window.location.search);
const hub = createFakeHub(params.get('old') === '1');
let noticeNo = 0;
const pushNotice = (kind = 'result'): void => {
  noticeNo += 1;
  const id = `n_demo_${noticeNo}`;
  if (kind === 'reply') {
    hub.push({ type: 'manager.message', message: { id: `m_demo_${noticeNo}`, thread: 'manager', role: 'manager', channel: 'web', text: 'Done: the CSV now uses ISO dates.', ts: iso(0) } });
    hub.push({ type: 'notice.created', notice: freshNotice(id, { kind: 'reply', text: 'Done: the CSV now uses ISO dates.', ref: { kind: 'manager', id: `m_demo_${noticeNo}` } }) });
    return;
  }
  const alert = kind === 'alert';
  hub.push({
    type: 'notice.created',
    notice: freshNotice(id, alert ? { kind: 'alert', text: 'The **cedar** account is at 96% of its 5-hour limit.', ref: null } : {}),
  });
};

window.__officeDemo = { push: hub.push, notice: pushNotice, sent: sentFrames };
if (params.get('script') !== '0') {
  setTimeout(() => pushNotice('result'), 2_500);
  setTimeout(() => pushNotice('alert'), 3_500);
}

const root = document.getElementById('root');
if (root === null) throw new Error('office demo: #root is missing');
createRoot(root).render(
  <StrictMode>
    <OfficeDemo hub={hub} params={params} />
  </StrictMode>,
);
