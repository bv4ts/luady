import type { NoticeDTO } from '@luady/shared';
import { useRef } from 'react';
import { useNavigate } from 'react-router';
import { Markdown } from '../../../markdown/Markdown.js';
import { useStore } from '../../../state/store.js';
import { Icon } from '../../../ui/Icon.js';
import { noticeTarget } from '../hud/NoticeToasts.js';
import { HQ_PALETTE } from '@luady/office';
import { chatChannelName, noticeBody, noticeIcon, noticeStatus } from '../model/notice-text.js';
import type { NoticeAcks } from '../model/useNoticeAcks.js';
import { useSeen } from '../model/useSeen.js';
import { clock } from '../panels/agent/step-text.js';
import { PanelHead } from '../panels/PanelHead.js';
import './drawers.css';
import { managerName } from '@luady/shared';

/** Seen-tracking applies to open notices the owner can only look at; questions and permissions settle when answered. */
const ackable = (notice: NoticeDTO): boolean => notice.settledAt === null && notice.kind !== 'question' && notice.kind !== 'permission';

function NoticeRow({ notice, acks, onOpen }: { notice: NoticeDTO; acks: NoticeAcks; onOpen: (notice: NoticeDTO) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const { channels } = useStore().state;
  useSeen(acks, notice.id, ackable(notice), ref);
  const status = noticeStatus(notice, new Date(), chatChannelName(channels, notice.settledVia));
  return (
    <li ref={ref} className={notice.settledAt === null ? 'notice-row notice-row--open' : 'notice-row'}>
      <Icon name={noticeIcon(notice.kind)} className="notice-row__icon" />
      <div className="notice-row__main">
        <Markdown source={noticeBody(notice.text)} className="notice-row__text" />
        <p className="notice-row__meta">
          <time dateTime={notice.createdAt}>{clock(notice.createdAt)}</time>
          {status === '' ? null : <span>{` · ${status}`}</span>}
        </p>
      </div>
      <button type="button" className="notice-row__open" aria-label="Show where it came from" onClick={() => onOpen(notice)}>
        <Icon name="chevron" />
      </button>
    </li>
  );
}

/** Every stored notice, newest first, with when it came and where it went. Rows on screen count as seen. */
export function NoticesDrawer({ acks, onSelect }: { acks: NoticeAcks; onSelect: (sessionId: string) => void }) {
  const { state } = useStore();
  const navigate = useNavigate();
  const onOpen = (notice: NoticeDTO) => {
    if (ackable(notice)) acks.clicked(notice.id);
    if (notice.ref?.kind === 'manager') {
      void navigate('/manager');
      return;
    }
    const target = noticeTarget(notice, state.sessions);
    if (target !== null) onSelect(target);
  };
  return (
    <>
      <PanelHead title="Notices" palette={HQ_PALETTE}>What {managerName()} told you, and where it went</PanelHead>
      <div className="agency-panel__body">
        {state.notices.length === 0 ? <p className="agency-panel__note">Nothing yet.</p> : null}
        <ol className="notice-list" data-testid="notices-list" aria-label="Notices">
          {state.notices.map((notice) => <NoticeRow key={notice.id} notice={notice} acks={acks} onOpen={onOpen} />)}
        </ol>
      </div>
    </>
  );
}
