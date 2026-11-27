import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { AgencyStageProps } from '../stage-types.js';
import { WEBGL_UNAVAILABLE } from './app.js';
import { SCENE_FAILED, createScene, type Scene, type SceneState } from './scene.js';
import { harnessFromLocation } from './stage-rooms.js';
import { watchVisibility } from './visibility.js';
import './stage.css';

const stateOf = (p: AgencyStageProps): SceneState => ({
  snapshot: p.snapshot, settleKey: p.settleKey, focus: p.focus, selectedId: p.selectedId, insets: p.insets, reducedMotion: p.reducedMotion,
  ...(p.ambience === undefined ? {} : { ambience: p.ambience }),
  ...(p.rooms === undefined ? {} : { rooms: p.rooms }),
});

const reasonOf = (error: unknown): string =>
  error instanceof Error && (error.message === WEBGL_UNAVAILABLE || error.message === SCENE_FAILED) ? error.message : SCENE_FAILED;

/**
 * The PixiJS office. Creates its app once (one live app even under StrictMode), pushes every prop change into the
 * scene from effects, pauses while the tab is hidden or the stage is off screen, and reports failures once. In dev and
 * demo builds an address with `?stage-rooms=<n>&stage-sessions=<k>` draws a still office of that size instead of the
 * page's snapshot (stage-rooms.ts), to measure the scene with `window.__luadyStageStats()`.
 */
function AgencyStage(props: AgencyStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const harness = useMemo(() => harnessFromLocation(), []);
  const latest = useRef(props);
  const failed = useRef(false);
  const shownProps = (p: AgencyStageProps): AgencyStageProps => (harness === null ? p : { ...p, snapshot: harness, rooms: undefined });

  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    let alive = true;
    let scene: Scene | null = null;
    let stopWatching: () => void = () => undefined;
    const fail = (reason: string): void => {
      if (failed.current) return;
      failed.current = true;
      latest.current.onFailed(reason);
    };
    const callbacks = {
      onEvent: (e: Parameters<AgencyStageProps['onEvent']>[0]) => latest.current.onEvent(e),
      onFrame: (p: Parameters<AgencyStageProps['onFrame']>[0]) => latest.current.onFrame(p),
      onView: (v: Parameters<NonNullable<AgencyStageProps['onView']>>[0]) => latest.current.onView?.(v),
      onFailed: fail,
    };
    // Starting one microtask late skips StrictMode's throw-away mount: no WebGL context is made for it.
    const ready = Promise.resolve()
      .then(() => (alive ? createScene(host, callbacks) : null))
      .then((made) => {
        if (made === null) return;
        if (!alive) {
          void made.destroy();
          return;
        }
        scene = made;
        sceneRef.current = made;
        made.set(stateOf(shownProps(latest.current)));
        stopWatching = watchVisibility(host, (visible) => made.setRunning(visible));
        latest.current.onReady?.(made.handle);
      })
      .catch((error: unknown) => {
        if (alive) fail(reasonOf(error));
      });
    return () => {
      alive = false;
      if (sceneRef.current !== null) latest.current.onReady?.(null);
      sceneRef.current = null;
      stopWatching();
      void ready.then(() => scene?.destroy());
    };
    // The harness is read once, at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { settleKey, focus, selectedId, insets, reducedMotion, ambience } = props;
  const snapshot = harness ?? props.snapshot;
  const rooms = harness === null ? props.rooms : undefined;
  const ambienceOn = ambience?.enabled ?? true;
  const quiet = ambience?.quiet ?? false;
  useEffect(() => {
    sceneRef.current?.set({
      snapshot, settleKey, focus, selectedId, insets, reducedMotion, ambience: { enabled: ambienceOn, quiet }, ...(rooms === undefined ? {} : { rooms }),
    });
  }, [snapshot, settleKey, focus, selectedId, insets, reducedMotion, ambienceOn, quiet, rooms]);

  return <div ref={hostRef} className="agency-stage" data-testid="agency-stage" />;
}

export default memo(AgencyStage);
