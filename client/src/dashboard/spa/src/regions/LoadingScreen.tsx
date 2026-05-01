import { useState } from 'react';
import { useEventStream } from '../api/events.js';
import type { StructuredEvent } from '../api/types.js';

export function LoadingScreen({ headline }: { headline: string }): JSX.Element {
  const [showDetails, setShowDetails] = useState(false);
  const { events } = useEventStream();
  const latest = events.length > 0 ? events[events.length - 1] : null;

  return (
    <div
      className="min-h-screen flex items-center justify-center px-10 py-16"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <div className="max-w-xl w-full flex flex-col gap-6">
        <span className="j-label" style={{ color: 'var(--accent-gold)' }}>
          Jinn · starting up
        </span>
        <h1 className="j-display" style={{ fontSize: '64px', lineHeight: 1.05 }}>
          {headline}.
        </h1>
        <p
          className="j-mono text-sm"
          style={{ color: 'var(--fg-muted)', minHeight: '1.5em' }}
        >
          {latest ? statusLineFor(latest) : 'The daemon is booting. This usually takes a second.'}
        </p>
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="j-label hover:opacity-80 self-start"
          style={{ color: 'var(--fg-dim)' }}
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
        {showDetails && (
          <div
            className="j-mono text-xs max-h-64 overflow-y-auto px-3 py-2"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
            }}
          >
            {events.length === 0 && (
              <div style={{ color: 'var(--fg-dim)' }}>no events yet</div>
            )}
            {events
              .slice()
              .reverse()
              .map((e) => (
                <div key={e.id} className="grid grid-cols-[68px_84px_1fr] gap-3 py-0.5">
                  <span style={{ color: 'var(--fg-dim)' }}>
                    {e.ts.slice(11, 19)}
                  </span>
                  <span
                    style={{
                      color:
                        e.kind === 'error'
                          ? 'var(--break-red)'
                          : e.kind === 'system'
                            ? 'var(--accent-sky)'
                            : 'var(--fg-dim)',
                    }}
                  >
                    {e.kind}
                  </span>
                  <span style={{ color: 'var(--fg)' }}>{e.message}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function statusLineFor(e: StructuredEvent): string {
  if (e.kind === 'error') return `Error: ${e.message}`;
  return e.message;
}
