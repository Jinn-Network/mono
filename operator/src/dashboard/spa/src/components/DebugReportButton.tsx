import { useState, type JSX } from 'react';
import { toPng } from 'html-to-image';
import { api } from '../api/client.js';
import type { DebugReportManifest } from '../../../../api/contract/index.js';

/**
 * One-click operator debug report (issue #420 §6).
 *
 * A header control that lets the operator download a redacted support bundle
 * in one step. The flow is:
 *
 *   1. Click -> fetch the bundle manifest and open a dialog listing exactly
 *      what the bundle contains and what is redacted. The operator sees this
 *      before anything is downloaded.
 *   2. Confirm -> capture a screenshot of the dashboard DOM client-side
 *      (`html-to-image`), POST it with the request, receive the `.tar.gz`,
 *      and trigger a browser download.
 *
 * Both daemon calls go through `api.debugReport` (the single source of truth
 * for the route URLs and auth) — see `api/client.ts`.
 *
 * Screenshot capture is best-effort: if it throws (content-security policy,
 * a very large DOM) the bundle is still requested without the screenshot.
 */

/** Capture the dashboard DOM to a base64 PNG (no data-URI prefix). */
async function captureScreenshot(): Promise<string | undefined> {
  try {
    const dataUrl = await toPng(document.body, {
      // Bound the payload so the POST stays small.
      canvasWidth: 1600,
      cacheBust: true,
    });
    return dataUrl.replace(/^data:image\/png;base64,/, '');
  } catch {
    // Capture failure must never block the bundle.
    return undefined;
  }
}

/** Trigger a browser download for a Blob via a synthetic anchor click. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type Phase = 'idle' | 'loading-manifest' | 'reviewing' | 'building' | 'error';

const SURFACE: React.CSSProperties = {
  background: 'var(--bg-raised, var(--bg))',
  border: '1px solid var(--border)',
  borderRadius: '10px',
  padding: '20px',
  maxWidth: '420px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg)',
};

export function DebugReportButton(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [manifest, setManifest] = useState<DebugReportManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openDialog(): Promise<void> {
    setPhase('loading-manifest');
    setError(null);
    try {
      const body = await api.debugReport.manifest();
      setManifest(body);
      setPhase('reviewing');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  function close(): void {
    setPhase('idle');
    setManifest(null);
    setError(null);
  }

  async function confirmDownload(): Promise<void> {
    setPhase('building');
    setError(null);
    try {
      const screenshotPngBase64 = await captureScreenshot();
      const blob = await api.debugReport.download(screenshotPngBase64);
      const date = new Date().toISOString().slice(0, 10);
      triggerDownload(blob, `jinn-debug-report-${date}.tar.gz`);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void openDialog()}
        disabled={phase === 'loading-manifest' || phase === 'building'}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '4px 10px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          cursor: phase === 'building' ? 'wait' : 'pointer',
        }}
      >
        {phase === 'building' ? 'building report…' : 'debug report'}
      </button>

      {(phase === 'reviewing' || phase === 'building' || phase === 'error') && (
        <div
          role="dialog"
          aria-label="Download debug report"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={close}
        >
          <div style={SURFACE} onClick={(e) => e.stopPropagation()}>
            <h2
              style={{
                fontFamily: "'Instrument Serif', 'Times New Roman', serif",
                fontSize: '22px',
                margin: '0 0 8px',
                color: 'var(--fg)',
              }}
            >
              Download debug report
            </h2>
            <p style={{ color: 'var(--fg-muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
              A support bundle for debugging this daemon. Secret values in the
              config, logs, and events are redacted — but the screenshot is not
              (see below). Review what it contains:
            </p>

            {manifest && (
              <>
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ color: 'var(--fg-dim)', marginBottom: '4px' }}>
                    Bundle contents
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--fg)' }}>
                    {manifest.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ color: 'var(--fg-dim)', marginBottom: '4px' }}>
                    Redacted
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--fg-muted)' }}>
                    {manifest.redaction.redacted.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
                {manifest.redaction.notRedacted &&
                  manifest.redaction.notRedacted.length > 0 && (
                    <div style={{ marginBottom: '14px' }}>
                      <div style={{ color: 'var(--break-red)', marginBottom: '4px' }}>
                        Not redacted — review before sharing
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--fg-muted)' }}>
                        {manifest.redaction.notRedacted.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
              </>
            )}

            {error && (
              <p style={{ color: 'var(--break-red)', margin: '0 0 12px' }}>{error}</p>
            )}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={close}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '11px',
                  color: 'var(--fg-muted)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDownload()}
                disabled={phase === 'building'}
                style={{
                  background: 'var(--fg)',
                  border: '1px solid var(--fg)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '11px',
                  color: 'var(--bg)',
                  cursor: phase === 'building' ? 'wait' : 'pointer',
                }}
              >
                {phase === 'building' ? 'Building…' : 'Download'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
