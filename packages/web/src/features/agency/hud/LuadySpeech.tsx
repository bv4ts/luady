import { useEffect, useMemo, useRef, type SyntheticEvent } from 'react';
import { Markdown } from '../../../markdown/Markdown.js';
import { chatNoticeIds } from '../../../state/selectors.js';
import { useStore } from '../../../state/store.js';
import { Icon } from '../../../ui/Icon.js';
import { flowWords, type LuadyFlow } from '../model/luady-flow.js';
import type { NoticeAcks } from '../model/useNoticeAcks.js';
import { useSeen } from '../model/useSeen.js';
import { LUADY_ACTOR_ID } from '../stage-types.js';
import { PixelIcon } from './PixelIcon.js';
import type { PlateRegistry } from './plates.js';
import type { SpeechRegister } from './useSpeechPlacer.js';
import { managerName } from '@luady/shared';

const keepInside = (event: SyntheticEvent) => event.stopPropagation();
const INSIDE = {
  onPointerDown: keepInside, onPointerUp: keepInside, onWheel: keepInside, onContextMenu: keepInside,
  onTouchStart: keepInside, onTouchEnd: keepInside,
};

/** The envelope's flight from the chat line to Luady. */
export const ENVELOPE_MS = 650;

/**
 * An envelope flies from the chat input to Luady once per message. Nothing with reduced motion,
 * without the Web Animations API, or before the stage has said where Luady is.
 */
function Envelope({ registry, reducedMotion }: { registry: PlateRegistry; reducedMotion: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    const from = document.querySelector('[data-chat-input]')?.getBoundingClientRect();
    const to = registry.last.find((point) => point.kind === 'actor' && point.id === LUADY_ACTOR_ID);
    if (node === null || reducedMotion || from === undefined || to === undefined || !to.visible || typeof node.animate !== 'function') return undefined;
    const start = `translate3d(${Math.round(from.left + 24)}px, ${Math.round(from.top)}px, 0) scale(1)`;
    const end = `translate3d(${Math.round(to.x - 9)}px, ${Math.round(to.y - 18)}px, 0) scale(0.6)`;
    const mid = `translate3d(${Math.round((from.left + to.x) / 2)}px, ${Math.round(Math.min(from.top, to.y) - 60)}px, 0) scale(1.1)`;
    node.hidden = false;
    const flight = node.animate(
      [{ transform: start, opacity: 1 }, { transform: mid, opacity: 1, offset: 0.55 }, { transform: end, opacity: 0 }],
      { duration: ENVELOPE_MS, easing: 'cubic-bezier(0.3, 0.6, 0.3, 1)', fill: 'forwards' },
    );
    flight.onfinish = () => {
      node.hidden = true;
    };
    return () => flight.cancel();
  }, [registry, reducedMotion]);
  return <span ref={ref} className="speech-envelope" hidden aria-hidden="true"><PixelIcon name="envelope" size={18} /></span>;
}

function LuadyAnswer({ messageId, register, acks, onClose }: { messageId: string; register: SpeechRegister; acks: NoticeAcks; onClose: () => void }) {
  const { state } = useStore();
  const message = state.luadyThread.items.find((item) => item.id === messageId);
  const place = useMemo(() => register(LUADY_ACTOR_ID), [register]);
  const box = useRef<HTMLDivElement>(null);
  const noticeId = useMemo(() => chatNoticeIds(state.notices).get(messageId) ?? null, [state.notices, messageId]);
  // His whole answer is on screen: an open chat notice for it counts as seen, as on the chat itself.
  useSeen(acks, noticeId ?? '', noticeId !== null, box);
  if (message === undefined) return null;
  return (
    <div ref={place} className="speech speech--luady" data-fixed="size" data-lift="none" data-testid="luady-answer" role="region" aria-label={`${managerName()}'s answer`} {...INSIDE}>
      <div ref={box} className="speech__box">
        <p className="speech__head">
          <span className="speech__name">{managerName()}</span>
          <button type="button" className="speech__close" aria-label={`Close ${managerName()}'s answer`} onClick={onClose}><Icon name="x" /></button>
        </p>
        <div className="speech__scroll" tabIndex={0} aria-label={`${managerName()}'s answer text`}>
          <Markdown source={message.text} className="speech__text" />
        </div>
      </div>
      <span className="speech__tail" aria-hidden="true" />
    </div>
  );
}

function LuadyPop({ flow, register }: { flow: Exclude<LuadyFlow, { kind: 'idle' } | { kind: 'answer' }>; register: SpeechRegister }) {
  const place = useMemo(() => register(LUADY_ACTOR_ID), [register]);
  const words = flowWords(flow) ?? '';
  const variant = flow.kind === 'typing' ? 'typing' : flow.kind === 'sent' ? 'pop' : 'note';
  return (
    <div ref={place} className={`speech speech--${variant}`} data-fixed="size" data-lift="none" data-testid="luady-pop" data-flow={flow.kind} role="status" {...INSIDE}>
      <div className="speech__box">
        {variant === 'typing' ? (
          <>
            <span className="speech__dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="visually-hidden">{words}</span>
          </>
        ) : (
          <>
            {variant === 'pop' ? <PixelIcon name="envelope" size={14} /> : null}
            <span dir="auto">{words}</span>
          </>
        )}
      </div>
      <span className="speech__tail" aria-hidden="true" />
    </div>
  );
}

/** What shows above Luady: the envelope and pop, the typing bubble, or his whole answer. */
export function LuadySpeech({ flow, register, registry, acks, reducedMotion, onClose }: {
  flow: LuadyFlow; register: SpeechRegister; registry: PlateRegistry; acks: NoticeAcks; reducedMotion: boolean; onClose: () => void;
}) {
  if (flow.kind === 'idle') return null;
  if (flow.kind === 'answer') return <LuadyAnswer key={flow.messageId} messageId={flow.messageId} register={register} acks={acks} onClose={onClose} />;
  return (
    <>
      {flow.kind === 'sent' ? <Envelope key={flow.at} registry={registry} reducedMotion={reducedMotion} /> : null}
      <LuadyPop flow={flow} register={register} />
    </>
  );
}
