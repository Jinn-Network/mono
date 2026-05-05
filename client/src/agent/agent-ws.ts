/**
 * WebSocket bridge between the SPA and the embedded operator Claude session.
 *
 * Architecture (lifted from siteboon/claudecodeui's shell-websocket bridge):
 *
 *   - ONE persistent claude PTY per daemon, kept alive across browser tab
 *     refreshes / WebSocket reconnects.
 *   - The PTY's stdout is buffered (last N chunks) so a reconnecting browser
 *     can replay context.
 *   - The server scans stdout for OAuth URL patterns and emits a typed
 *     `auth_url` frame to the SPA. The SPA treats it as protocol data only;
 *     Claude Code's PTY output remains the operator-visible sign-in source.
 *
 * Spawn gating (mc24 follow-up):
 *   - claude is NOT spawned automatically on first WS connect for fresh
 *     operators. The SPA's onboarding flow gates spawn behind an explicit
 *     'Sign in' click in Phase 1 — operator gets a clean panel landing
 *     before any OAuth tab opens. The button calls POST /v1/auth/claude/spawn
 *     which calls triggerAgentSpawn() here.
 *   - If claude is already authenticated on this machine (returning operator),
 *     spawn is allowed eagerly — no button click needed. The daemon detects
 *     this at startup via probeAlreadyAuthedOnStartup().
 *
 * Wire protocol (JSON over WS):
 *   server → client: { kind: 'meta', autoMode, reason, agentReady? }
 *   server → client: { kind: 'data', data: string }
 *   server → client: { kind: 'auth_url', url: string }
 *   server → client: { kind: 'exit', code: number | null }
 *   server → client: { kind: 'error', message, remediation?, recoverable? }
 *   client → server: { kind: 'input', data: string }
 *   client → server: { kind: 'resize', cols: number, rows: number }
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { spawnOperatorClaude, OperatorClaudeSpawnError, type OperatorClaude } from './operator-claude.js';
import { detectAutoModeAvailable, type AutoModeAvailability } from './auto-mode-detect.js';
import { detectAuthContext, probeClaudeAuth } from '../preflight/claude-auth.js';
import { checkClaudeBinary } from '../preflight/claude-binary.js';

export interface AgentWsConfig {
  httpServer: HttpServer;
  uiToken: string;
  claudePath: string;
  cwd: string;
  mcpConfigPath?: string;
}

interface ManagedSession {
  session: OperatorClaude;
  auto: AutoModeAvailability;
  buffer: string[];
  client: WebSocket | null;
  announcedAuthUrls: Set<string>;
  urlScanBuffer: string;
  themePickerDismissed: boolean;
  loginPickerDismissed: boolean;
}

const MAX_OUTPUT_BUFFER_CHUNKS = 5_000;
const URL_SCAN_BUFFER_LIMIT = 32_768;

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const OAUTH_URL_PATTERN = /https:\/\/claude\.(?:com|ai)\/[A-Za-z0-9._~%/?#=&\-+:!*'(),]+/g;

let activeController: SessionController | null = null;
let storedConfig: AgentWsConfig | null = null;
let managedSession: ManagedSession | null = null;
let pendingClients: WebSocket[] = [];
/** Whether spawn is allowed. Set true when (a) claude is already authed on
 *  this machine at daemon startup, or (b) the operator clicks the Phase 1
 *  Sign-in button in the panel (POST /v1/auth/claude/spawn). */
let spawnAllowed = false;

export interface SessionController {
  write(data: string): void;
  isAlive(): boolean;
}

export function getActiveSessionController(): SessionController | null {
  return activeController;
}

export function updateAgentClaudePath(claudePath: string): void {
  if (storedConfig) {
    storedConfig = { ...storedConfig, claudePath };
  }
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

function trimBuffer(buf: string[]): void {
  if (buf.length > MAX_OUTPUT_BUFFER_CHUNKS) {
    buf.splice(0, buf.length - MAX_OUTPUT_BUFFER_CHUNKS);
  }
}

async function ensureSession(): Promise<
  ManagedSession | { error: OperatorClaudeSpawnError | Error } | null
> {
  if (!storedConfig) return null;
  if (managedSession) return managedSession;
  if (!spawnAllowed) return null;

  const cfg = storedConfig;
  const binary = await checkClaudeBinary(cfg.claudePath);
  if (!binary.ok) {
    return {
      error: new OperatorClaudeSpawnError(
        binary.detail,
        'Install Claude Code from the operator panel, then sign in with Claude.',
      ),
    };
  }
  const auto = await detectAutoModeAvailable(cfg.claudePath);

  let session: OperatorClaude;
  try {
    session = await spawnOperatorClaude({
      claudePath: cfg.claudePath,
      cwd: cfg.cwd,
      autoMode: auto.available,
      mcpConfigPath: cfg.mcpConfigPath,
    });
  } catch (err) {
    return { error: err as Error };
  }

  const m: ManagedSession = {
    session,
    auto,
    buffer: [],
    client: null,
    announcedAuthUrls: new Set(),
    urlScanBuffer: '',
    themePickerDismissed: false,
    loginPickerDismissed: false,
  };

  session.onData((chunk) => {
    m.buffer.push(chunk);
    trimBuffer(m.buffer);

    m.urlScanBuffer = (m.urlScanBuffer + stripAnsi(chunk)).slice(-URL_SCAN_BUFFER_LIMIT);
    const urlMatches = m.urlScanBuffer.match(OAUTH_URL_PATTERN);
    if (urlMatches) {
      for (const url of urlMatches) {
        if (!m.announcedAuthUrls.has(url)) {
          m.announcedAuthUrls.add(url);
          try {
            m.client?.send(JSON.stringify({ kind: 'auth_url', url }));
          } catch { /* socket gone */ }
        }
      }
    }

    // Auto-dismiss claude's first-run wizard. Words are split with cursor-
    // move ANSI so we match the alphanumeric-compacted buffer.
    const compact = m.urlScanBuffer.replace(/[^A-Za-z]/g, '');
    if (!m.themePickerDismissed && compact.includes('Choosethetextstyle')) {
      m.themePickerDismissed = true;
      setTimeout(() => {
        try { m.session.write('\r'); } catch { /* gone */ }
      }, 250);
    }
    if (!m.loginPickerDismissed && compact.includes('Selectloginmethod')) {
      m.loginPickerDismissed = true;
      setTimeout(() => {
        try { m.session.write('\r'); } catch { /* gone */ }
      }, 250);
    }

    if (m.client && m.client.readyState === m.client.OPEN) {
      try {
        m.client.send(JSON.stringify({ kind: 'data', data: chunk }));
      } catch { /* socket gone */ }
    }
  });

  session.onExit((code) => {
    try {
      m.client?.send(JSON.stringify({ kind: 'exit', code }));
    } catch { /* socket gone */ }
    managedSession = null;
    activeController = null;
  });

  managedSession = m;
  activeController = {
    write: (data: string) => m.session.write(data),
    isAlive: () => managedSession !== null,
  };
  return m;
}

function attachClientToSession(ws: WebSocket, m: ManagedSession): void {
  if (m.client && m.client !== ws && m.client.readyState === m.client.OPEN) {
    try { m.client.close(); } catch { /* ignore */ }
  }
  m.client = ws;

  try {
    ws.send(JSON.stringify({
      kind: 'meta',
      autoMode: m.auto.available,
      reason: m.auto.reason,
      agentReady: true,
    }));
  } catch { /* dropped */ }

  if (m.buffer.length > 0) {
    try {
      ws.send(JSON.stringify({ kind: 'data', data: m.buffer.join('') }));
    } catch { /* dropped */ }
  }

  for (const url of m.announcedAuthUrls) {
    try {
      ws.send(JSON.stringify({ kind: 'auth_url', url }));
    } catch { /* dropped */ }
  }
}

/** Probe claude auth at daemon startup. If already authed, allow spawn so
 *  returning operators don't have to click Sign-in again. */
function probeAlreadyAuthedOnStartup(cfg: AgentWsConfig): void {
  try {
    const cwd = cfg.cwd;
    const context = detectAuthContext({ cwd });
    const probe = probeClaudeAuth({ context, cwd, claudePath: cfg.claudePath });
    if (probe.authenticated) {
      spawnAllowed = true;
    }
  } catch {
    // probe failed; default to gated. operator can click Sign-in to spawn.
  }
}

/**
 * Called by POST /v1/auth/claude/spawn when the operator clicks Sign-in.
 * Sets spawnAllowed = true, spawns claude, and attaches any pending WS
 * clients waiting for the agent to come online.
 */
export async function triggerAgentSpawn(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  spawnAllowed = true;
  const result = await ensureSession();
  if (!result) {
    return { ok: false, reason: 'agent_ws_not_initialized' };
  }
  if ('error' in result) {
    const err = result.error;
    return { ok: false, reason: err.message };
  }
  // Attach any clients that were waiting in pending state.
  const waiting = pendingClients;
  pendingClients = [];
  for (const ws of waiting) {
    if (ws.readyState === ws.OPEN) attachClientToSession(ws, result);
  }
  return { ok: true };
}

export function attachAgentWs(cfg: AgentWsConfig): WebSocketServer {
  storedConfig = cfg;
  probeAlreadyAuthedOnStartup(cfg);

  const wss = new WebSocketServer({ server: cfg.httpServer, path: '/api/agent/ws' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const cookie = req.headers.cookie ?? '';
    const cookieMatch = /jinn_ui_token=([^;]+)/.exec(cookie);
    const token = cookieMatch?.[1];
    if (!token || token !== cfg.uiToken) {
      ws.close(1008, 'unauthorized');
      return;
    }

    // Always set up the input/close handlers so messages from the SPA work
    // whether we're pending or already attached.
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          kind: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        if (!managedSession) return;
        if (msg.kind === 'input' && typeof msg.data === 'string') {
          managedSession.session.write(msg.data);
        } else if (
          msg.kind === 'resize' &&
          typeof msg.cols === 'number' &&
          typeof msg.rows === 'number' &&
          managedSession.session.resize
        ) {
          managedSession.session.resize(msg.cols, msg.rows);
        }
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      if (managedSession?.client === ws) managedSession.client = null;
      pendingClients = pendingClients.filter((c) => c !== ws);
    });

    const result = await ensureSession();
    if (result === null) {
      // Spawn gated — tell SPA to show the loading state.
      try {
        ws.send(JSON.stringify({
          kind: 'meta',
          autoMode: false,
          reason: 'awaiting_sign_in',
          agentReady: false,
        }));
      } catch { /* dropped */ }
      pendingClients.push(ws);
      return;
    }
    if ('error' in result) {
      const err = result.error;
      const isSpawnError = err instanceof OperatorClaudeSpawnError;
      try {
        ws.send(JSON.stringify({
          kind: 'error',
          message: err.message,
          remediation: isSpawnError ? err.remediation : undefined,
          recoverable: isSpawnError,
        }));
      } catch { /* dropped */ }
      ws.close();
      return;
    }

    attachClientToSession(ws, result);
  });

  return wss;
}
