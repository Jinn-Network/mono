import { useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { cn } from '../lib/utils.js';

interface SpawnError {
  message: string;
  remediation?: string;
}

interface AgentProps {
  /** When true, display a placeholder until external setup is complete (e.g.,
   *  harness setup). Doesn't affect Operating mode where it's always false. */
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

    let disposed = false;
    let fitFrame: number | null = null;
    let term: Terminal | null = null;
    let resizeObs: ResizeObserver | null = null;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/agent/ws`);

    const mountTerminal = (): Terminal | null => {
      if (term || !ref.current) return term;
      const nextTerm = new Terminal({
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
      nextTerm.loadAddon(fit);
      nextTerm.loadAddon(new WebLinksAddon());
      nextTerm.open(ref.current);

      const safeFit = (): void => {
        if (disposed || !ref.current) return;
        if (ref.current.offsetWidth === 0 || ref.current.offsetHeight === 0) return;
        try { fit.fit(); } catch { /* xterm can race layout during first paint */ }
      };
      fitFrame = window.requestAnimationFrame(safeFit);
      resizeObs = new ResizeObserver(() => {
        safeFit();
      });
      resizeObs.observe(ref.current);

      nextTerm.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ kind: 'input', data: d }));
        }
      });
      nextTerm.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ kind: 'resize', cols, rows }));
        }
      });
      term = nextTerm;
      return nextTerm;
    };

    ws.onopen = () => {
      setConnected(true);
      mountTerminal();
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
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
          term?.write(parsed.data);
        } else if (parsed.kind === 'meta') {
          setAutoMode({ active: !!parsed.autoMode, reason: parsed.reason ?? '' });
          if (typeof parsed.agentReady === 'boolean') {
            setAgentReady(parsed.agentReady);
          }
        } else if (parsed.kind === 'auth_url' && typeof parsed.url === 'string') {
          // Claude Code already prints and may open the OAuth URL from its PTY.
          // Keep auth_url as protocol data only so the app does not open a
          // duplicate browser window.
        } else if (parsed.kind === 'error') {
          if (parsed.recoverable && parsed.remediation) {
            // Surface the diagnostic out-of-band so the operator sees it
            // prominently instead of buried in a terminal scroll.
            setSpawnError({
              message: parsed.message ?? 'agent failed to start',
              remediation: parsed.remediation,
            });
          } else {
            term?.write(`\r\n\x1b[31m[error] ${parsed.message ?? 'unknown error'}\x1b[0m\r\n`);
          }
        } else if (parsed.kind === 'exit') {
          term?.write(`\r\n\x1b[33m[claude session exited]\x1b[0m\r\n`);
        }
      } catch {
        // ignore unparseable frame
      }
    };

    return () => {
      disposed = true;
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      ws.close();
      resizeObs?.disconnect();
      term?.dispose();
    };
  }, []);

  const xtermHidden = agentGated && !agentReady;

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg-sunken)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--bg-elevated)] px-4 py-2">
        <span
          className={cn(
            'font-mono text-[11px] tracking-[0.05em]',
            connected ? 'text-[var(--vow-green)]' : 'text-[var(--fg-dim)]',
          )}
        >
          {connected ? '● connected' : '○ disconnected'}
        </span>
        {autoMode && (
          <Badge
            variant={autoMode.active ? 'warning' : 'secondary'}
            title={autoMode.active ? 'Claude Code Auto Mode is active' : autoMode.reason}
          >
            {autoMode.active ? 'Auto Mode' : 'Default permissions'}
          </Badge>
        )}
      </div>
      {spawnError && (
        <Alert variant="blocking" className="m-3 flex flex-col gap-2">
          <AlertTitle className="text-[var(--break-red)]">Agent panel unavailable</AlertTitle>
          <AlertDescription className="font-mono text-xs text-[var(--fg-muted)]">
            {spawnError.message}
          </AlertDescription>
          {spawnError.remediation && (
            <p className="font-mono text-xs text-[var(--fg-dim)]">
              <span className="text-[var(--fg-muted)]">Fix · </span>
              {spawnError.remediation}
            </p>
          )}
        </Alert>
      )}
      <div
        ref={ref}
        className={cn(
          'w-full flex-1 bg-[var(--bg-sunken)] p-3',
          'min-h-[400px]',
          // Hide the xterm visually while gated. We keep it mounted (so the
          // WS / xterm setup persists across the gate flip) but cover it
          // with the placeholder.
          xtermHidden && 'invisible hidden',
        )}
      />
      {xtermHidden && !spawnError && <AgentGatedPlaceholder />}
    </div>
  );
}

function AgentGatedPlaceholder(): JSX.Element {
  return (
    <div className="flex w-full flex-1 items-center justify-center bg-[var(--bg-sunken)] px-6">
      <div className="flex max-w-[34ch] flex-col items-center gap-4 text-center">
        <span
          aria-hidden="true"
          className="jinn-anim-pulse h-2 w-2 rounded-full bg-[var(--seer-violet)]"
        />
        <p className="font-mono text-xs text-[var(--fg-muted)]">
          The agent will come online once harness setup is complete.
        </p>
      </div>
    </div>
  );
}
