import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import type { SocketLike } from '../../api/ws.js';
import { bridgeTerminal, terminalUrl, type BridgeHandlers, type TermBridge } from './term-bridge.js';

export const TERMINAL_THEME: ITheme = {
  background: '#0b0e10', foreground: '#d7dce0', cursor: '#3cc3b0', cursorAccent: '#0b0e10', selectionBackground: '#3cc3b04d',
  black: '#1b1f23', red: '#ff7b72', green: '#7ee2a8', yellow: '#f2cc60', blue: '#79b8ff', magenta: '#d2a8ff', cyan: '#56d4dd',
  white: '#d7dce0', brightBlack: '#6e7781', brightRed: '#ffa198', brightGreen: '#a6f0c6', brightYellow: '#f8e3a1',
  brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff', brightCyan: '#b3f0ff', brightWhite: '#ffffff',
};

export interface MountHandlers extends BridgeHandlers {
  onRenderer(kind: 'webgl' | 'dom'): void;
}

export interface MountedTerminal {
  readonly bridge: TermBridge;
  dispose(): void;
}

/** WebGL draws to a canvas; xterm's DOM renderer injects <style> elements that `style-src 'self'` blocks. */
function loadWebgl(term: Terminal, handlers: MountHandlers): 'webgl' | 'dom' {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      handlers.onRenderer('dom');
    });
    term.loadAddon(webgl);
    return 'webgl';
  } catch (err) {
    handlers.onWarning?.(`WebGL renderer unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return 'dom';
  }
}

function fitSafely(fit: FitAddon, handlers: BridgeHandlers): void {
  try {
    fit.fit();
  } catch (err) {
    handlers.onWarning?.(`Could not size the terminal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function mountTerminal(
  host: HTMLElement, ticket: string, handlers: MountHandlers,
  createSocket: (url: string) => SocketLike = (url) => new WebSocket(url),
): MountedTerminal {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, lineHeight: 1.15, scrollback: 5000, theme: TERMINAL_THEME,
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  handlers.onRenderer(loadWebgl(term, handlers));
  fitSafely(fit, handlers);
  const bridge = bridgeTerminal(createSocket(terminalUrl(ticket)), term, handlers);
  const refit = () => fitSafely(fit, handlers);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit);
  observer?.observe(host);
  window.addEventListener('resize', refit);
  term.focus();
  return {
    bridge,
    dispose() {
      observer?.disconnect();
      window.removeEventListener('resize', refit);
      bridge.dispose();
      term.dispose();
    },
  };
}
