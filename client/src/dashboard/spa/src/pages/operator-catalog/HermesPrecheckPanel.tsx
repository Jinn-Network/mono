import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';

/**
 * Runs `GET /api/hermes/doctor` and presents three states:
 *
 * - `not-installed` — binary not found; shows curl-pipe-bash install command +
 *    retry button.
 * - `config-issue` — binary present but exits non-zero; shows stderr diagnostic
 *    and instructions to run `hermes model` / `hermes setup`.
 * - `ok` — binary present and exits 0; calls onSuccess() immediately.
 *
 * `onCancel` returns the user to the harness selector.
 */

export type HermesPrecheckState = 'checking' | 'not-installed' | 'config-issue' | 'network-error' | 'ok';

export interface HermesPrecheckPanelProps {
  onSuccess: () => void;
  onCancel: () => void;
}

const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash';

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const monoStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  color: 'var(--fg)',
};

const mutedStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg-muted)',
};

const codeBlockStyle: React.CSSProperties = {
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-1)',
  padding: '10px 12px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg)',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  margin: 0,
};

const ghostButtonStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  padding: '8px 16px',
  background: 'transparent',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

export function HermesPrecheckPanel({
  onSuccess,
  onCancel,
}: HermesPrecheckPanelProps): JSX.Element {
  const [state, setState] = useState<HermesPrecheckState>('checking');
  const [stderr, setStderr] = useState<string>('');
  const [networkError, setNetworkError] = useState<string>('');

  const runPrecheck = (): void => {
    setState('checking');
    api
      .hermesDoctor()
      .then((r) => {
        if (!r.installed) {
          setState('not-installed');
          return;
        }
        if (r.exitCode !== 0) {
          setState('config-issue');
          setStderr(r.stderr);
          return;
        }
        setState('ok');
        onSuccess();
      })
      .catch((err: unknown) => {
        // Distinguish network/transport errors from "Hermes not installed".
        // Falling through to not-installed would tell operators to reinstall
        // a Hermes that's already there when the daemon API is unreachable.
        setNetworkError(err instanceof Error ? err.message : String(err));
        setState('network-error');
      });
  };

  const copyInstallCommand = (): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(INSTALL_COMMAND).catch(() => {
        // Clipboard write rejected (insecure context, permission denied).
        // Silent — the operator can still manually select the text.
      });
    }
  };

  useEffect(() => {
    runPrecheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'checking') {
    return (
      <div data-testid="hermes-precheck-checking" style={cardStyle}>
        <span style={labelStyle}>Hermes install check</span>
        <p style={mutedStyle}>Checking hermes install…</p>
      </div>
    );
  }

  if (state === 'not-installed') {
    return (
      <div data-testid="hermes-precheck-not-installed" style={cardStyle}>
        <span style={labelStyle}>Hermes Agent not installed</span>
        <p style={monoStyle}>
          Hermes Agent is not installed on this machine.
          Run this command in your terminal, then click Retry:
        </p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <pre style={{ ...codeBlockStyle, flex: 1 }}>{INSTALL_COMMAND}</pre>
          <button
            type="button"
            data-testid="hermes-precheck-copy-install"
            aria-label="Copy install command"
            onClick={copyInstallCommand}
            style={{ ...ghostButtonStyle, padding: '6px 10px', fontSize: '11px' }}
          >
            Copy
          </button>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            data-testid="hermes-precheck-retry"
            onClick={runPrecheck}
            style={{ ...ghostButtonStyle, borderColor: 'var(--accent-sky)', color: 'var(--accent-sky)' }}
          >
            I&apos;ve installed Hermes — retry precheck
          </button>
          <button
            type="button"
            data-testid="hermes-precheck-cancel"
            onClick={onCancel}
            style={ghostButtonStyle}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state === 'network-error') {
    return (
      <div data-testid="hermes-precheck-network-error" style={cardStyle}>
        <span style={labelStyle}>Hermes precheck failed</span>
        <p style={monoStyle}>
          Could not reach the daemon API to run <code>hermes doctor</code>.
          Check that the daemon is running and the UI token is valid.
        </p>
        {networkError ? <pre style={codeBlockStyle}>{networkError}</pre> : null}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            data-testid="hermes-precheck-retry"
            onClick={runPrecheck}
            style={{ ...ghostButtonStyle, borderColor: 'var(--accent-sky)', color: 'var(--accent-sky)' }}
          >
            Retry precheck
          </button>
          <button
            type="button"
            data-testid="hermes-precheck-cancel"
            onClick={onCancel}
            style={ghostButtonStyle}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state === 'config-issue') {
    return (
      <div data-testid="hermes-precheck-config-issue" style={cardStyle}>
        <span style={labelStyle}>Hermes Agent configuration issue</span>
        <p style={monoStyle}>
          Hermes is installed but reports configuration issues:
        </p>
        <pre style={codeBlockStyle}>{stderr || '(no diagnostic output)'}</pre>
        <p style={mutedStyle}>
          Run <code>hermes model</code> or <code>hermes setup</code> to configure
          a provider, then retry.
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            data-testid="hermes-precheck-retry"
            onClick={runPrecheck}
            style={{ ...ghostButtonStyle, borderColor: 'var(--accent-sky)', color: 'var(--accent-sky)' }}
          >
            Retry precheck
          </button>
          <button
            type="button"
            data-testid="hermes-precheck-cancel"
            onClick={onCancel}
            style={ghostButtonStyle}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // state === 'ok' — onSuccess() already called in the effect; render nothing
  return <></>;
}
