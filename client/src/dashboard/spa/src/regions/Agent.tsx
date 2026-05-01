import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

interface SpawnError {
  message: string;
  remediation?: string;
}

interface AgentProps {
  /** When true, display a placeholder until claude is signed in (Phase 1 of
   *  the onboarding flow). Doesn't affect Operating mode where it's always
   *  false. */
  agentGated?: boolean;
}

export function Agent({ agentGated = false }: AgentProps = {}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [autoMode, setAutoMode] = useState<{ active: boolean; reason: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [spawnError, setSpawnError] = useState<SpawnError | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      theme: {
        background: '#070d18',
        foreground: '#f2f7fc',
        cursor: '#dcb866',
        selectionBackground: '#1f3a66',
        black: '#0c1628',
        red: '#a85a5a',
        green: '#6a9b8f',
        yellow: '#dcb866',
        blue: '#7aa7dc',
        magenta: '#7a6db0',
        cyan: '#a8c8ea',
        white: '#a4b0c2',
        brightBlack: '#33394a',
        brightRed: '#c87a7a',
        brightGreen: '#8abbaf',
        brightYellow: '#ead08e',
        brightBlue: '#a8c8ea',
        brightMagenta: '#9a8dd0',
        brightCyan: '#cbdef3',
        brightWhite: '#f2f7fc',
      },
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(ref.current);
    fit.fit();
    const resizeObs = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* container too small etc */ }
    });
    resizeObs.observe(ref.current);

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/agent/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    // De-dupe URLs we've already opened — the WS may replay them on reconnect
    // (see auth_url replay in agent-ws.ts).
    const openedAuthUrls = new Set<string>();

    ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as {
          kind: string;
          data?: string;
          url?: string;
          autoMode?: boolean;
          reason?: string;
          message?: string;
          remediation?: string;
          recoverable?: boolean;
          agentReady?: boolean;
        };
        if (parsed.kind === 'data' && typeof parsed.data === 'string') {
          term.write(parsed.data);
        } else if (parsed.kind === 'meta') {
          setAutoMode({ active: !!parsed.autoMode, reason: parsed.reason ?? '' });
          if (typeof parsed.agentReady === 'boolean') {
            setAgentReady(parsed.agentReady);
          }
        } else if (parsed.kind === 'auth_url' && typeof parsed.url === 'string') {
          if (!openedAuthUrls.has(parsed.url)) {
            openedAuthUrls.add(parsed.url);
            // Open in a new tab in the operator's current browser. Best-effort:
            // popup blockers may interfere; the URL is also visible in the
            // terminal so the operator can copy it manually.
            try {
              window.open(parsed.url, '_blank', 'noopener,noreferrer');
            } catch { /* fall through to terminal */ }
          }
        } else if (parsed.kind === 'error') {
          if (parsed.recoverable && parsed.remediation) {
            // Surface the diagnostic out-of-band so the operator sees it
            // prominently instead of buried in a terminal scroll.
            setSpawnError({
              message: parsed.message ?? 'agent failed to start',
              remediation: parsed.remediation,
            });
          } else {
            term.write(`\r\n\x1b[31m[error] ${parsed.message ?? 'unknown error'}\x1b[0m\r\n`);
          }
        } else if (parsed.kind === 'exit') {
          term.write(`\r\n\x1b[33m[claude session exited]\x1b[0m\r\n`);
        }
      } catch {
        // ignore unparseable frame
      }
    };

    term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ kind: 'input', data: d }));
      }
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ kind: 'resize', cols, rows }));
      }
    });

    return () => {
      ws.close();
      resizeObs.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <div className="h-full w-full flex flex-col" style={{ background: 'var(--bg-sunken)' }}>
      <div
        className="px-4 py-2 flex items-center justify-between"
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elevated)',
        }}
      >
        <span
          className="j-mono text-[11px]"
          style={{
            color: connected ? 'var(--vow-green)' : 'var(--fg-dim)',
            letterSpacing: '0.05em',
          }}
        >
          {connected ? '● connected' : '○ disconnected'}
        </span>
        {autoMode && (
          <span
            className="j-label"
            style={{
              color: autoMode.active ? 'var(--accent-gold)' : 'var(--fg-dim)',
              fontSize: '10px',
            }}
            title={autoMode.active ? 'Claude Code Auto Mode is active' : autoMode.reason}
          >
            {autoMode.active ? 'Auto Mode' : 'Default permissions'}
          </span>
        )}
      </div>
      {spawnError && (
        <div
          className="px-5 py-4 m-3 flex flex-col gap-2"
          style={{
            border: '1px solid var(--break-red)',
            background: 'rgba(168, 90, 90, 0.06)',
            borderRadius: 'var(--radius-2)',
          }}
        >
          <span className="j-label" style={{ color: 'var(--break-red)' }}>
            Agent panel unavailable
          </span>
          <p className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
            {spawnError.message}
          </p>
          {spawnError.remediation && (
            <p className="j-mono text-xs" style={{ color: 'var(--fg-dim)' }}>
              <span style={{ color: 'var(--fg-muted)' }}>Fix · </span>
              {spawnError.remediation}
            </p>
          )}
        </div>
      )}
      <div
        ref={ref}
        className="flex-1 w-full"
        style={{
          background: 'var(--bg-sunken)',
          padding: '12px',
          minHeight: '400px',
          // Hide the xterm visually while gated. We keep it mounted (so the
          // WS / xterm setup persists across the gate flip) but cover it
          // with the placeholder.
          visibility: agentGated && !agentReady ? 'hidden' : 'visible',
          display: agentGated && !agentReady ? 'none' : 'block',
        }}
      />
      {agentGated && !agentReady && !spawnError && <AgentGatedPlaceholder />}
    </div>
  );
}

function AgentGatedPlaceholder(): JSX.Element {
  return (
    <div
      className="flex-1 w-full flex items-center justify-center px-6"
      style={{ background: 'var(--bg-sunken)' }}
    >
      <div className="flex flex-col items-center gap-4 max-w-[34ch] text-center">
        <span
          aria-hidden="true"
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: 'var(--seer-violet)',
            boxShadow: '0 0 0 0 rgba(122, 109, 176, 0.6)',
            animation: 'jinnPulse 1.6s ease-out infinite',
          }}
        />
        <p className="j-mono text-xs" style={{ color: 'var(--fg-muted)' }}>
          The agent will come online once you sign in to Claude (Phase 1
          on the left).
        </p>
      </div>
    </div>
  );
}
