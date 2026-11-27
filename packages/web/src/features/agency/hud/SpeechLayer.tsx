import type { AgencySnapshot } from '@luady/office';
import type { Feed } from '../model/feed.js';
import type { LuadyFlow } from '../model/luady-flow.js';
import type { NoticeAcks } from '../model/useNoticeAcks.js';
import type { OverlayPoint, StageInsets } from '../stage-types.js';
import { AgentSpeech } from './AgentSpeech.js';
import { LuadySpeech } from './LuadySpeech.js';
import type { PlateRegistry } from './plates.js';
import { useSpeechPlacer } from './useSpeechPlacer.js';
import './speech.css';

export interface SpeechLayerProps {
  readonly snapshot: AgencySnapshot;
  readonly registry: PlateRegistry;
  readonly points: Feed<readonly OverlayPoint[]>;
  readonly insets: StageInsets;
  readonly luady: LuadyFlow;
  readonly acks: NoticeAcks;
  readonly reducedMotion: boolean;
  readonly onCloseLuady: () => void;
  readonly onOpenAgent: (id: string) => void;
}

/**
 * Speech over the map, in the free band between the bars: the agents' bubbles and speech marks, and Luady's pop,
 * typing bubble and answer. Each node follows its character from the stage's frames without a React render.
 */
export function SpeechLayer({ snapshot, registry, points, insets, luady, acks, reducedMotion, onCloseLuady, onOpenAgent }: SpeechLayerProps) {
  const register = useSpeechPlacer(registry, points, insets);
  return (
    <div className="agency-speech" data-testid="speech-layer">
      <AgentSpeech snapshot={snapshot} register={register} onOpenAgent={onOpenAgent} />
      <LuadySpeech flow={luady} register={register} registry={registry} acks={acks} reducedMotion={reducedMotion} onClose={onCloseLuady} />
    </div>
  );
}
