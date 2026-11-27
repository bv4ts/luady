import type { ConnectionDTO } from '@luady/shared';

const STATE_WORDS: Readonly<Record<ConnectionDTO['state'], string>> = Object.freeze({
  connected: 'connected', not_connected: 'not connected', unavailable: 'not set up',
});

/** The chat channel, Google, the mailbox and Wispr Flow: their state, and a connect link where the hub has one. */
export function Connections({ connections }: { connections: readonly ConnectionDTO[] }) {
  if (connections.length === 0) return null;
  return (
    <section className="acct-section">
      <h3 className="agent-section__title">Connections</h3>
      <ul className="acct-conns">
        {connections.map((connection) => (
          <li key={connection.id} className={`acct-conn acct-conn--${connection.state}`}>
            <span className="acct-conn__name">{connection.label}</span>
            <span className="acct-conn__state">{STATE_WORDS[connection.state]}</span>
            {connection.detail === null ? null : <span className="acct-conn__detail" dir="auto">{connection.detail}</span>}
            {connection.connectUrl === null ? null : (
              <a className="acct-conn__link" href={connection.connectUrl} target="_blank" rel="noopener noreferrer">{`Connect ${connection.label}`}</a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
