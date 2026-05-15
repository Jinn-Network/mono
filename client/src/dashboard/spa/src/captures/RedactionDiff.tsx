import type { CaptureSpan } from '../api/types.js';

export function RedactionDiff({ spans }: { spans: CaptureSpan[] }): JSX.Element {
  const redacted = spans.flatMap((span) =>
    span.redactedKeys.map((key) => ({ span: span.name, key })),
  );

  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>Redactions</h2>
      {redacted.length === 0 ? (
        <div style={{ color: 'var(--fg-muted)' }}>No redacted attributes.</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {redacted.map((entry, idx) => (
            <div
              key={`${entry.span}-${entry.key}-${idx}`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 180px) 1fr',
                gap: 12,
                fontFamily: 'monospace',
                fontSize: 12,
              }}
            >
              <span>{entry.span}</span>
              <span>{entry.key}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
