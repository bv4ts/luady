import type { ChannelInfoDTO, PanelBlock } from '@luady/shared';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ChannelsApi } from '../../api/channels.js';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { reportError } from '../../lib/report.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';
import { drawQr, qrMatrix } from './qr.js';

/** A QR code an add-on asked for: drawn on a canvas from its text; nothing of the add-on runs here. */
function QrBlock({ data, label }: { data: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    try {
      drawQr(canvas, qrMatrix(data));
      setFailed(false);
    } catch (err) {
      reportError('channel qr', err);
      setFailed(true);
    }
  }, [data]);
  return (
    <figure className="channel-qr">
      <canvas ref={ref} className="channel-qr__canvas" role="img" aria-label={label} />
      {failed ? <figcaption className="form-error">The code could not be drawn. Reload the page to try again.</figcaption> : null}
    </figure>
  );
}

function InputBlock({ block, onAction, busy }: {
  block: Extract<PanelBlock, { type: 'input' }>; onAction: (action: string, value: string, pin: boolean) => void; busy: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (value.trim() !== '') onAction(block.action, value, false);
  };
  return (
    <form className="channel-input" onSubmit={submit}>
      <label htmlFor={id}>{block.label}</label>
      <textarea id={id} rows={3} value={value} onChange={(event) => setValue(event.target.value)} />
      <Button size="sm" type="submit" busy={busy} disabled={value.trim() === ''}>Send</Button>
    </form>
  );
}

/**
 * An add-on's panel: data only. Every string is rendered as text by React (never as HTML), a QR
 * block is drawn from its text, and a button or input only sends its action name back to the add-on. A button
 * marked `pin` asks for the PIN first.
 */
export function ChannelPanel({ channel, api }: { channel: ChannelInfoDTO; api?: ChannelsApi }) {
  const client = useApi();
  const channels = api ?? client.channels;
  const { toast } = useStore();
  const { runPinned } = usePin();
  const [busy, setBusy] = useState<string | null>(null);
  const panel = channel.panel;
  if (panel === null || panel.blocks.length === 0) return null;

  async function act(action: string, value: string | null, label: string, pin: boolean): Promise<void> {
    setBusy(action);
    try {
      const done = await runPinned(async (code) => {
        await channels.action(channel.id, { action, value, ...(pin ? { pin: mustPin(code) } : {}) });
        return true;
      }, { require: pin, title: label, detail: `${channel.name}: ${label}` });
      if (done) toast('success', `${channel.name}: ${label}`);
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="channel-panel" aria-label={panel.title}>
      {panel.blocks.map((block, index) => {
        const key = block.id ?? `${block.type}-${index}`;
        switch (block.type) {
          case 'text':
            return <p key={key} className="channel-panel__text">{block.text}</p>;
          case 'qr':
            return <QrBlock key={key} data={block.data} label={`${channel.name} link code`} />;
          case 'code':
            return <pre key={key} className="channel-panel__code"><code>{block.text}</code></pre>;
          case 'input':
            return <InputBlock key={key} block={block} busy={busy === block.action} onAction={(action, value) => void act(action, value, block.label, false)} />;
          case 'button':
            return (
              <div key={key} className="row">
                <Button size="sm" variant={block.danger === true ? 'danger' : 'secondary'} busy={busy === block.action}
                  onClick={() => void act(block.action, null, block.label, block.pin === true)}>
                  {block.label}
                </Button>
              </div>
            );
        }
      })}
    </div>
  );
}
