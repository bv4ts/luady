import { memo } from 'react';
import type { AgencyStageProps } from '../../../src/features/agency/stage-types.js';

/**
 * Stand-in for the PixiJS stage (jsdom has no WebGL). Use it with
 * `vi.mock('<path to>/scene/AgencyStage.js', () => import('<path to>/stage-mock.js'))`.
 */
export const stageSpy: { props: AgencyStageProps | null; renders: number; crash: boolean } = { props: null, renders: 0, crash: false };

export function resetStageSpy(): void {
  stageSpy.props = null;
  stageSpy.renders = 0;
  stageSpy.crash = false;
}

/** The props of the latest render; throws when the stage has not rendered. */
export function stageProps(): AgencyStageProps {
  if (stageSpy.props === null) throw new Error('the stage has not rendered');
  return stageSpy.props;
}

function FakeStage(props: AgencyStageProps) {
  if (stageSpy.crash) throw new Error('stage blew up');
  stageSpy.props = props;
  stageSpy.renders += 1;
  // Like the canvas: a press on the stage itself is a tap on the map.
  return (
    <div data-testid="agency-stage" data-actors={Object.keys(props.snapshot.actors).length}
      onPointerDown={() => props.onEvent({ type: 'room', room: null })} />
  );
}

export default memo(FakeStage);
