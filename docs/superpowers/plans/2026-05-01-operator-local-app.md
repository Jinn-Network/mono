# Operator Local App — v1-Slim Implementation Plan

> **v1.x update (jinn-mono-zqm2).** After this plan landed, `jinn quickstart`
> was removed and `jinn run` now subsumes the zero-to-running flow (init,
> funding check, bootstrap, foreground daemon). The MCP tool was renamed
> `jinn_run`. Tasks below that reference `jinn quickstart` describe the
> surface as it existed when this plan was written; today the same flow is
> reached via `jinn run`. See `client/README.md` for the current operator
> path.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `client/src/dashboard/index.html` with a richer single-page app served by the daemon, hosting four regions (Status, Visibility, Setup, Agent) with an embedded Auto-Mode Claude Code session, and add the daemon endpoints/lifecycle that support it.

**Architecture:** Single-process. The daemon's existing Hono server gains `/v1/events` (SSE), `/v1/bootstrap`, `/auth/handshake`, and serves a Vite-built SPA bundle. Daemon starts in setup-mode (loops gated) when keystore/bootstrap incomplete, transitions to running-mode on completion. The operator MCP server (existing at `client/src/mcp/operator-server.ts`) gains a few live-state tools and is the bridge for the embedded `claude --enable-auto-mode` subprocess connected to the SPA via WebSocket.

**Tech Stack:**
- Daemon: TypeScript, Hono, Node 22, vitest, viem
- SPA: Vite + React + Tailwind + shadcn/ui (default — Task 1 audit may flip)
- Agent bridge: WebSocket (`ws`) + xterm.js or assistant-ui (Task 1 audit decides)
- MCP: `@modelcontextprotocol/sdk` (existing dep) — stdio transport via `jinn mcp`
- Tests: vitest (unit), Playwright (SPA e2e on Anvil fork)

**Spec:** `docs/superpowers/specs/2026-05-01-operator-local-app-design.md`

**Linked beads:** jinn-mono-3ois (parent), jinn-mono-95sj (intent enable/disable redesign), jinn-mono-dgi0 (jinn auth split). The plan does NOT depend on those landing — the relevant tools are stubs/no-ops here.

---

## File Structure

### New files

**Daemon-side:**
- `client/src/events/types.ts` — `StructuredEvent` Zod schema + types
- `client/src/events/ring-buffer.ts` — bounded ring-buffer of structured events
- `client/src/events/emitter.ts` — global emitter the daemon writes to + the SSE endpoint reads
- `client/src/api/events-endpoint.ts` — `/v1/events` SSE handler + `/v1/events/recent` JSON endpoint
- `client/src/api/bootstrap-endpoint.ts` — `/v1/bootstrap` handler
- `client/src/api/handshake.ts` — `/auth/handshake` + UI token validation middleware
- `client/src/api/ui-token.ts` — token file read/write helpers
- `client/src/setup-mode.ts` — setup-mode controller (gates daemon loops)
- `client/src/agent/operator-claude.ts` — operator Claude subprocess lifecycle
- `client/src/agent/agent-ws.ts` — WebSocket bridge between daemon and browser
- `client/src/cli/commands/ui.ts` — thin `jinn ui` shortcut (open browser, start daemon if needed)

**SPA-side (under `client/src/dashboard/spa/`):**
- `client/src/dashboard/spa/package.json`
- `client/src/dashboard/spa/vite.config.ts`
- `client/src/dashboard/spa/tsconfig.json`
- `client/src/dashboard/spa/tailwind.config.ts`
- `client/src/dashboard/spa/postcss.config.cjs`
- `client/src/dashboard/spa/index.html`
- `client/src/dashboard/spa/src/main.tsx`
- `client/src/dashboard/spa/src/App.tsx`
- `client/src/dashboard/spa/src/api/client.ts`
- `client/src/dashboard/spa/src/api/events.ts`
- `client/src/dashboard/spa/src/api/types.ts`
- `client/src/dashboard/spa/src/regions/Status.tsx`
- `client/src/dashboard/spa/src/regions/Visibility.tsx`
- `client/src/dashboard/spa/src/regions/Setup.tsx`
- `client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx`
- `client/src/dashboard/spa/src/regions/Agent.tsx`
- `client/src/dashboard/spa/src/styles/globals.css`

**Tests:**
- `client/test/events/ring-buffer.test.ts`
- `client/test/api/events-endpoint.test.ts`
- `client/test/api/bootstrap-endpoint.test.ts`
- `client/test/api/handshake.test.ts`
- `client/test/setup-mode.test.ts`
- `client/test/agent/operator-claude.test.ts`
- `client/test/cli/run-no-ui.test.ts`
- `client/test/dashboard/spa.e2e.test.ts` (Playwright, Anvil fork)

**Docs:**
- `docs/superpowers/audits/2026-05-01-operator-app-oss-reuse.md` (Task 1 output)
- Update `client/README.md`

### Modified files

- `client/src/api/server.ts` — bind 127.0.0.1; add new routes; serve SPA dist
- `client/src/main.ts` — orchestrate setup-mode → running-mode transition
- `client/src/cli/commands/run.ts` — `--no-ui` flag, default-open browser
- `client/src/cli/index.ts` — register `jinn ui` command
- `client/src/daemon/daemon.ts` — emit structured events at intent state transitions, errors
- `client/src/mcp/operator-server.ts` — add `loop_pause`, `loop_resume`, `daemon_restart`, `activity_list`, `bootstrap_state` tools
- `client/package.json` — add SPA build deps + scripts; add `ws` dep
- `client/scripts/write-dist-build-meta.mjs` and the `build` script — copy `dashboard/spa/dist` to `dist/dashboard`

---

## Phase 0 — OSS reuse audit (foundation)

### Task 1: OSS reuse audit

**Files:**
- Create: `docs/superpowers/audits/2026-05-01-operator-app-oss-reuse.md`

**Purpose:** Determine which existing open-source projects we should lift vs build. Spec requires this before any framework choice is committed. Output drives Tasks 10, 16, 17, and may flip parts of others.

- [ ] **Step 1: Survey "Claude Code web wrappers"**

Search npmjs.com, GitHub trending, and the Claude Code awesome list for projects that put a `claude` subprocess in a browser. Specifically check:
- `getAsterisk/claudia` (Tauri-based; we want web equivalents)
- `anthropic-ai/claude-code-vscode` (extension; check if there's a web counterpart)
- `wcrichton/claude-code-web` and similar community names
- Anything tagged with `claude-code` + `web` on npm

Document what each project does, license, last-commit recency, what they actually solve.

- [ ] **Step 2: Survey agent chat component libraries**

Check `assistant-ui` (npm: `@assistant-ui/react`), Vercel AI SDK chat components (`ai/react`), CopilotKit. For each, evaluate: does it render MCP tool calls cleanly? Does it stream from a custom backend (not just OpenAI/Anthropic API direct)? Does it work with a stdio-piped Claude Code subprocess via WebSocket?

- [ ] **Step 3: Survey terminal-in-browser**

Check `xterm.js`, `wetty`, `ttyd`. For our agent panel: if the audit concludes that wrapping Claude Code's TTY output verbatim is the best path, xterm.js + a node-pty bridge is the standard. Document.

- [ ] **Step 4: Survey SPA + dashboard primitives**

Default is Vite + React + Tailwind + shadcn/ui. Check whether anything compelling exists above that for "operator console" use cases (Tremor, Grafana plugins, etc.). Document trade-offs.

- [ ] **Step 5: Survey MCP tool-call visualization**

Check `assistant-ui`'s tool-call rendering, the official MCP inspector, and any `react-mcp-*` projects. Goal: avoid hand-rolling tool-call cards.

- [ ] **Step 6: Write audit report**

Create `docs/superpowers/audits/2026-05-01-operator-app-oss-reuse.md` with:
- One subsection per category
- For each finding: project name, link, license, last-commit recency, what it solves, what it doesn't, recommendation (lift / reference / skip)
- A "Conclusions" section at the end naming the final stack decision for each surface (SPA framework, agent panel rendering, terminal, MCP visualization)

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/audits/2026-05-01-operator-app-oss-reuse.md
git commit -m "audit(operator-app): OSS reuse survey for v1-Slim local app"
```

**Note:** Subsequent SPA tasks assume Vite + React + Tailwind + shadcn/ui as the default. If the audit concludes otherwise, adjust Tasks 10–17 accordingly before executing them.

---

## Phase 1 — Daemon-side foundation (events, endpoints, auth)

### Task 2: Structured event types + ring buffer

**Files:**
- Create: `client/src/events/types.ts`
- Create: `client/src/events/ring-buffer.ts`
- Create: `client/test/events/ring-buffer.test.ts`

- [ ] **Step 1: Write the types file**

```typescript
// client/src/events/types.ts
import { z } from 'zod';

export const StructuredEventKindSchema = z.enum([
  'intent',
  'reward',
  'fleet',
  'system',
  'error',
  'log',
]);
export type StructuredEventKind = z.infer<typeof StructuredEventKindSchema>;

export const StructuredEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  ts: z.string(),
  kind: StructuredEventKindSchema,
  message: z.string(),
  requestId: z.string().optional(),
  txHash: z.string().optional(),
  errorCode: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type StructuredEvent = z.infer<typeof StructuredEventSchema>;
```

- [ ] **Step 2: Write the failing ring-buffer test**

```typescript
// client/test/events/ring-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { EventRingBuffer } from '../../src/events/ring-buffer.js';
import type { StructuredEvent } from '../../src/events/types.js';

function evt(id: string, kind: 'intent' | 'system' = 'system'): StructuredEvent {
  return {
    schemaVersion: 1,
    id,
    ts: new Date().toISOString(),
    kind,
    message: `event ${id}`,
  };
}

describe('EventRingBuffer', () => {
  it('keeps the last N events', () => {
    const rb = new EventRingBuffer(3);
    rb.push(evt('a'));
    rb.push(evt('b'));
    rb.push(evt('c'));
    rb.push(evt('d'));
    expect(rb.snapshot().map((e) => e.id)).toEqual(['b', 'c', 'd']);
  });

  it('filters by kind', () => {
    const rb = new EventRingBuffer(10);
    rb.push(evt('a', 'intent'));
    rb.push(evt('b', 'system'));
    rb.push(evt('c', 'intent'));
    expect(rb.snapshot({ kinds: ['intent'] }).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('notifies subscribers and supports unsubscribe', () => {
    const rb = new EventRingBuffer(10);
    const seen: string[] = [];
    const unsub = rb.subscribe((e) => seen.push(e.id));
    rb.push(evt('a'));
    rb.push(evt('b'));
    unsub();
    rb.push(evt('c'));
    expect(seen).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 3: Run test to confirm it fails**

```bash
cd client && yarn test test/events/ring-buffer.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 4: Implement the ring buffer**

```typescript
// client/src/events/ring-buffer.ts
import type { StructuredEvent, StructuredEventKind } from './types.js';

export interface EventFilter {
  kinds?: StructuredEventKind[];
  sinceId?: string;
  limit?: number;
}

export type EventSubscriber = (event: StructuredEvent) => void;

export class EventRingBuffer {
  private buffer: StructuredEvent[] = [];
  private subscribers = new Set<EventSubscriber>();

  constructor(private capacity: number = 1000) {}

  push(event: StructuredEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(-this.capacity);
    }
    for (const sub of this.subscribers) {
      try { sub(event); } catch { /* never let subscriber errors propagate */ }
    }
  }

  snapshot(filter: EventFilter = {}): StructuredEvent[] {
    let out = this.buffer;
    if (filter.sinceId) {
      const idx = out.findIndex((e) => e.id === filter.sinceId);
      out = idx >= 0 ? out.slice(idx + 1) : out;
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const allowed = new Set(filter.kinds);
      out = out.filter((e) => allowed.has(e.kind));
    }
    if (filter.limit !== undefined) out = out.slice(-filter.limit);
    return [...out];
  }

  subscribe(sub: EventSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }
}
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
cd client && yarn test test/events/ring-buffer.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add client/src/events/ client/test/events/
git commit -m "feat(events): structured event types and ring buffer"
```

---

### Task 3: Global event emitter + emit at known daemon transition points

**Files:**
- Create: `client/src/events/emitter.ts`
- Modify: `client/src/daemon/daemon.ts`

- [ ] **Step 1: Write the emitter module**

```typescript
// client/src/events/emitter.ts
import { randomUUID } from 'node:crypto';
import { EventRingBuffer } from './ring-buffer.js';
import type { StructuredEvent, StructuredEventKind } from './types.js';

const RING = new EventRingBuffer(1000);

export function getEventBuffer(): EventRingBuffer {
  return RING;
}

export interface EmitInput {
  kind: StructuredEventKind;
  message: string;
  requestId?: string;
  txHash?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export function emitStructured(input: EmitInput): void {
  const event: StructuredEvent = {
    schemaVersion: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...input,
  };
  RING.push(event);
}
```

- [ ] **Step 2: Wire emit calls at known transition points in daemon.ts**

Add `import { emitStructured } from '../events/emitter.js';` near the top of `client/src/daemon/daemon.ts`. Replace the existing `console.error('[daemon] creator crashed:', err)` call (line 190) and similar with paired calls — keep the `console.error` for log-tail compatibility, ADD an `emitStructured` for the structured surface.

Example (replace each `console.error('[daemon] X crashed:', err)` block):

```typescript
// before
this.creatorLoop.run().catch(err => console.error('[daemon] creator crashed:', err)),

// after
this.creatorLoop.run().catch(err => {
  console.error('[daemon] creator crashed:', err);
  emitStructured({
    kind: 'error',
    message: 'creator loop crashed',
    errorCode: 'creator_crashed',
    details: { error: err instanceof Error ? err.message : String(err) },
  });
}),
```

Apply the same pattern at lines 165, 183, 190, 191, 192, 193, 198, 203, 208, 218 in `daemon.ts` (the existing `console.error` sites). Use semantic `errorCode` values per loop.

- [ ] **Step 3: Add lifecycle markers**

In `Daemon.start()` (after the loops launch), emit:
```typescript
emitStructured({ kind: 'system', message: 'daemon loops started' });
```

In `Daemon.stop()`, emit:
```typescript
emitStructured({ kind: 'system', message: 'daemon loops stopping' });
```

- [ ] **Step 4: Verify the existing test suite still passes**

```bash
cd client && yarn typecheck && yarn test
```
Expected: PASS (zero new failures).

- [ ] **Step 5: Commit**

```bash
git add client/src/events/emitter.ts client/src/daemon/daemon.ts
git commit -m "feat(events): emit structured events at daemon lifecycle/error transitions"
```

---

### Task 4: SSE endpoint `/v1/events` + JSON `/v1/events/recent`

**Files:**
- Create: `client/src/api/events-endpoint.ts`
- Create: `client/test/api/events-endpoint.test.ts`
- Modify: `client/src/api/server.ts`

- [ ] **Step 1: Write the failing endpoint test**

```typescript
// client/test/api/events-endpoint.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { addEventsRoutes } from '../../src/api/events-endpoint.js';
import { getEventBuffer } from '../../src/events/emitter.js';

describe('/v1/events/recent', () => {
  beforeEach(() => {
    // wipe the buffer
    const buf = getEventBuffer();
    while (buf.snapshot().length > 0) buf.snapshot().pop();
  });

  it('returns recent events in JSON', async () => {
    const buf = getEventBuffer();
    buf.push({ schemaVersion: 1, id: 'e1', ts: '2026-05-01T00:00:00Z', kind: 'system', message: 'a' });
    buf.push({ schemaVersion: 1, id: 'e2', ts: '2026-05-01T00:00:01Z', kind: 'intent', message: 'b' });

    const app = new Hono();
    addEventsRoutes(app);
    const res = await app.request('/v1/events/recent');
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<{ id: string }> };
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.events.map((e) => e.id)).toContain('e1');
  });

  it('filters by kind via query param', async () => {
    const buf = getEventBuffer();
    buf.push({ schemaVersion: 1, id: 'e1', ts: '2026-05-01T00:00:00Z', kind: 'system', message: 'a' });
    buf.push({ schemaVersion: 1, id: 'e2', ts: '2026-05-01T00:00:01Z', kind: 'intent', message: 'b' });

    const app = new Hono();
    addEventsRoutes(app);
    const res = await app.request('/v1/events/recent?kinds=intent');
    const body = await res.json() as { events: Array<{ id: string; kind: string }> };
    expect(body.events.every((e) => e.kind === 'intent')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd client && yarn test test/api/events-endpoint.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement the endpoint module**

```typescript
// client/src/api/events-endpoint.ts
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getEventBuffer } from '../events/emitter.js';
import type { StructuredEventKind } from '../events/types.js';

const ALLOWED_KINDS: StructuredEventKind[] = ['intent', 'reward', 'fleet', 'system', 'error', 'log'];

function parseKinds(s: string | undefined): StructuredEventKind[] | undefined {
  if (!s) return undefined;
  const parts = s.split(',').map((k) => k.trim()).filter(Boolean);
  const out = parts.filter((p): p is StructuredEventKind => ALLOWED_KINDS.includes(p as StructuredEventKind));
  return out.length > 0 ? out : undefined;
}

export function addEventsRoutes(app: Hono): void {
  app.get('/v1/events/recent', (c) => {
    const kinds = parseKinds(c.req.query('kinds'));
    const sinceId = c.req.query('sinceId') ?? undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(1000, parseInt(limitRaw, 10) || 100)) : 100;
    const events = getEventBuffer().snapshot({ kinds, sinceId, limit });
    return c.json({ events });
  });

  app.get('/v1/events', (c) => {
    const kinds = parseKinds(c.req.query('kinds'));
    return streamSSE(c, async (stream) => {
      const buf = getEventBuffer();
      // backfill last 50
      const backfill = buf.snapshot({ kinds, limit: 50 });
      for (const e of backfill) {
        await stream.writeSSE({ data: JSON.stringify(e), event: e.kind, id: e.id });
      }
      const unsub = buf.subscribe(async (e) => {
        if (kinds && !kinds.includes(e.kind)) return;
        try {
          await stream.writeSSE({ data: JSON.stringify(e), event: e.kind, id: e.id });
        } catch { /* client dropped */ }
      });
      // keep open until aborted
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => { unsub(); resolve(); });
      });
    });
  });
}
```

- [ ] **Step 4: Wire into the server**

In `client/src/api/server.ts`, add `import { addEventsRoutes } from './events-endpoint.js';` and call `addEventsRoutes(app);` after the existing `/v1/status` route registration.

- [ ] **Step 5: Run tests**

```bash
cd client && yarn test test/api/events-endpoint.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/events-endpoint.ts client/test/api/events-endpoint.test.ts client/src/api/server.ts
git commit -m "feat(api): /v1/events SSE stream and /v1/events/recent JSON"
```

---

### Task 5: `/v1/bootstrap` endpoint

**Files:**
- Create: `client/src/api/bootstrap-endpoint.ts`
- Create: `client/test/api/bootstrap-endpoint.test.ts`
- Modify: `client/src/api/server.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/api/bootstrap-endpoint.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { addBootstrapRoutes } from '../../src/api/bootstrap-endpoint.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeFixtureEarningDir(state: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'earning_state.json'), JSON.stringify(state));
  return dir;
}

describe('GET /v1/bootstrap', () => {
  it('returns the current bootstrap step + per-step status when state file exists', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'awaiting_funding', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; currentStep: string; services: unknown[] };
    expect(body.mode).toBe('setup');
    expect(body.currentStep).toBe('awaiting_funding');
    expect(body.services).toHaveLength(1);
  });

  it('returns mode=running when all services are complete', async () => {
    const earningDir = makeFixtureEarningDir({
      master_address: '0xabc',
      chain: 'base-sepolia',
      services: [{ index: 0, step: 'complete', safe_address: '0xsafe' }],
    });
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string };
    expect(body.mode).toBe('running');
  });

  it('returns mode=uninitialized when no state file exists', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-bootstrap-empty-'));
    const app = new Hono();
    addBootstrapRoutes(app, { earningDir });
    const res = await app.request('/v1/bootstrap');
    const body = await res.json() as { mode: string };
    expect(body.mode).toBe('uninitialized');
  });
});
```

- [ ] **Step 2: Implement the endpoint**

```typescript
// client/src/api/bootstrap-endpoint.ts
import type { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BootstrapEndpointConfig {
  earningDir: string;
}

const STEPS = [
  'wallet',
  'safe_predicted',
  'awaiting_funding',
  'safe_deployed',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'mech_deployed',
  'complete',
] as const;

type Step = typeof STEPS[number];
const STEP_INDEX = new Map<Step, number>(STEPS.map((s, i) => [s, i]));

interface ServiceState {
  index: number;
  step: Step;
  safe_address?: string;
  service_id?: number;
}

interface FleetStateOnDisk {
  master_address?: string;
  chain?: string;
  services?: ServiceState[];
}

export function addBootstrapRoutes(app: Hono, config: BootstrapEndpointConfig): void {
  app.get('/v1/bootstrap', (c) => {
    const path = join(config.earningDir, 'earning_state.json');
    if (!existsSync(path)) {
      return c.json({
        schemaVersion: 1,
        mode: 'uninitialized',
        steps: STEPS,
        currentStep: STEPS[0],
        services: [],
      });
    }

    let parsed: FleetStateOnDisk;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as FleetStateOnDisk;
    } catch {
      return c.json({ error: 'unreadable_state_file' }, 500);
    }

    const services = parsed.services ?? [];
    const currentStepIdx = services.length === 0
      ? 0
      : Math.min(...services.map((s) => STEP_INDEX.get(s.step) ?? 0));
    const currentStep = STEPS[currentStepIdx];
    const allComplete = services.length > 0 && services.every((s) => s.step === 'complete');

    return c.json({
      schemaVersion: 1,
      mode: allComplete ? 'running' : 'setup',
      steps: STEPS,
      currentStep,
      services,
      master_address: parsed.master_address,
      chain: parsed.chain,
    });
  });
}
```

- [ ] **Step 3: Wire into server**

In `client/src/api/server.ts`, accept an optional `bootstrap?: { earningDir: string }` field on `ApiServerConfig`, and call `addBootstrapRoutes(app, config.bootstrap)` if provided. Caller (in `main.ts` Task 9) supplies the `earningDir` from config.

- [ ] **Step 4: Run tests**

```bash
cd client && yarn test test/api/bootstrap-endpoint.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add client/src/api/bootstrap-endpoint.ts client/test/api/bootstrap-endpoint.test.ts client/src/api/server.ts
git commit -m "feat(api): /v1/bootstrap endpoint exposes fleet bootstrap state"
```

---

### Task 6: UI session token + `/auth/handshake`

**Files:**
- Create: `client/src/api/ui-token.ts`
- Create: `client/src/api/handshake.ts`
- Create: `client/test/api/handshake.test.ts`
- Modify: `client/src/api/server.ts`

- [ ] **Step 1: Implement the token utility**

```typescript
// client/src/api/ui-token.ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function defaultTokenPath(): string {
  return join(homedir(), '.jinn-client', 'ui-token');
}

export function ensureUiToken(path = defaultTokenPath()): string {
  if (existsSync(path)) {
    const v = readFileSync(path, 'utf-8').trim();
    if (v.length >= 32) return v;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}

export function rotateUiToken(path = defaultTokenPath()): string {
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}
```

- [ ] **Step 2: Write the handshake test**

```typescript
// client/test/api/handshake.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { addHandshakeRoutes, requireUiToken } from '../../src/api/handshake.js';

describe('/auth/handshake', () => {
  it('returns 200 + sets cookie when handshake key matches', async () => {
    const token = 'tok_test_1234567890abcdef1234567890abcdef';
    const handshakeKey = 'hs_test_key';
    const app = new Hono();
    addHandshakeRoutes(app, { token, handshakeKey });
    const res = await app.request(`/auth/handshake?k=${handshakeKey}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(res.headers.get('Set-Cookie')).toContain('jinn_ui_token=');
  });

  it('returns 401 when handshake key is missing or wrong', async () => {
    const app = new Hono();
    addHandshakeRoutes(app, { token: 't', handshakeKey: 'right' });
    const wrong = await app.request('/auth/handshake?k=wrong');
    expect(wrong.status).toBe(401);
  });

  it('requireUiToken accepts valid cookie', async () => {
    const app = new Hono();
    app.use('/protected', requireUiToken('correct-token'));
    app.get('/protected', (c) => c.json({ ok: true }));
    const ok = await app.request('/protected', {
      headers: { cookie: 'jinn_ui_token=correct-token' },
    });
    expect(ok.status).toBe(200);
    const fail = await app.request('/protected');
    expect(fail.status).toBe(401);
  });
});
```

- [ ] **Step 3: Implement handshake**

```typescript
// client/src/api/handshake.ts
import type { Hono, MiddlewareHandler } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';

export interface HandshakeConfig {
  token: string;
  handshakeKey: string;
}

export function addHandshakeRoutes(app: Hono, cfg: HandshakeConfig): void {
  app.get('/auth/handshake', (c) => {
    const k = c.req.query('k');
    if (!k || k !== cfg.handshakeKey) {
      return c.json({ error: 'invalid_handshake_key' }, 401);
    }
    setCookie(c, 'jinn_ui_token', cfg.token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ ok: true });
  });
}

export function requireUiToken(expected: string): MiddlewareHandler {
  return async (c, next) => {
    const cookie = getCookie(c, 'jinn_ui_token');
    const header = c.req.header('x-jinn-ui-token');
    const supplied = cookie ?? header;
    if (!supplied || supplied !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
```

- [ ] **Step 4: Wire handshake into server**

In `client/src/api/server.ts`, accept `ui?: { token: string; handshakeKey: string }` on `ApiServerConfig`. When provided:
- Call `addHandshakeRoutes(app, config.ui)`.
- Apply `requireUiToken(config.ui.token)` middleware to the SPA-only routes (`/v1/events`, `/v1/events/recent`, `/v1/bootstrap`, the future `/api/agent/*`). Do NOT apply it to `/v1/status` (existing) or `/artifacts/*` (existing — has its own auth).
- Print `[api] UI handshake URL: http://127.0.0.1:<port>/auth/handshake?k=<handshakeKey>` on startup so the launcher (Task 21) can open the browser at that URL.

- [ ] **Step 5: Run tests**

```bash
cd client && yarn test test/api/handshake.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add client/src/api/ui-token.ts client/src/api/handshake.ts client/test/api/handshake.test.ts client/src/api/server.ts
git commit -m "feat(api): UI session token and /auth/handshake gate"
```

---

### Task 7: Narrow Hono binding to 127.0.0.1

**Files:**
- Modify: `client/src/api/server.ts`

- [ ] **Step 1: Change the bind hostname**

In `client/src/api/server.ts`, change the existing `hostname: '0.0.0.0'` (line ~165) to `hostname: '127.0.0.1'`. Add a config flag to opt back in for users who want LAN access — but default is local-only:

```typescript
// in ApiServerConfig
  bindHost?: string;  // default 127.0.0.1; set to 0.0.0.0 for LAN access
```

```typescript
// in startApiServer
  const bindHost = config.bindHost ?? '127.0.0.1';
  // ...
  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: bindHost,
  }, ...);
```

- [ ] **Step 2: Plumb the flag through main.ts**

In `client/src/main.ts`, when constructing `ApiServerConfig`, read `JINN_API_BIND_HOST` env var (or `config.apiBindHost`); default to `127.0.0.1`. Document the flag in CLAUDE.md table at finish.

- [ ] **Step 3: Run typecheck and existing tests**

```bash
cd client && yarn typecheck && yarn test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/api/server.ts client/src/main.ts
git commit -m "fix(api): default Hono bind to 127.0.0.1 (override via JINN_API_BIND_HOST)"
```

---

## Phase 2 — Setup-mode daemon

### Task 8: Setup-mode controller

**Files:**
- Create: `client/src/setup-mode.ts`
- Create: `client/test/setup-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/setup-mode.test.ts
import { describe, it, expect, vi } from 'vitest';
import { computeDaemonMode } from '../src/setup-mode.js';

describe('computeDaemonMode', () => {
  it('returns setup when keystore missing', () => {
    expect(computeDaemonMode({ keystoreExists: false, allComplete: false })).toBe('setup');
  });

  it('returns setup when keystore present but bootstrap incomplete', () => {
    expect(computeDaemonMode({ keystoreExists: true, allComplete: false })).toBe('setup');
  });

  it('returns running when keystore present and all services complete', () => {
    expect(computeDaemonMode({ keystoreExists: true, allComplete: true })).toBe('running');
  });
});
```

- [ ] **Step 2: Implement the controller**

```typescript
// client/src/setup-mode.ts
export type DaemonMode = 'setup' | 'running';

export interface DaemonModeInputs {
  keystoreExists: boolean;
  allComplete: boolean;
}

export function computeDaemonMode(inputs: DaemonModeInputs): DaemonMode {
  if (!inputs.keystoreExists) return 'setup';
  if (!inputs.allComplete) return 'setup';
  return 'running';
}

export interface SetupModeController {
  mode(): DaemonMode;
  /** Resolves once mode transitions to running. Re-resolves if already running. */
  waitUntilRunning(): Promise<void>;
  /** Re-evaluate mode based on the input thunks. */
  refresh(inputs: DaemonModeInputs): void;
}

export function createSetupModeController(initial: DaemonModeInputs): SetupModeController {
  let current: DaemonMode = computeDaemonMode(initial);
  const waiters: Array<() => void> = [];

  return {
    mode: () => current,
    waitUntilRunning: () => {
      if (current === 'running') return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    refresh: (inputs) => {
      const next = computeDaemonMode(inputs);
      if (next !== current) {
        current = next;
        if (next === 'running') {
          while (waiters.length > 0) {
            const w = waiters.shift();
            w?.();
          }
        }
      }
    },
  };
}
```

- [ ] **Step 3: Run tests**

```bash
cd client && yarn test test/setup-mode.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 4: Commit**

```bash
git add client/src/setup-mode.ts client/test/setup-mode.test.ts
git commit -m "feat(setup-mode): controller for daemon setup/running mode transitions"
```

---

### Task 9: Wire setup-mode into main.ts so loops gate until bootstrap completes

**Files:**
- Modify: `client/src/main.ts`

- [ ] **Step 1: Restructure main() so the API server starts immediately**

Today `main()` runs the bootstrap to completion before starting the API server (and daemon loops). The new shape: start the API server early in setup mode (Hono only, no daemon loops), poll the fleet store for completion, then start the daemon loops.

In `client/src/main.ts` (around the existing structure that runs `FleetBootstrapper.advance()` and then `new Daemon(...).start()`):

```typescript
// After the password is loaded but before bootstrap is advanced:
import { createSetupModeController, type DaemonMode } from './setup-mode.js';
import { ensureUiToken } from './api/ui-token.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { startApiServer } from './api/server.js';

// determine current state
const keystorePath = join(earningDir, 'master_keystore.json');
const fleetState = await fleetStateStore.read();
const allComplete = (fleetState.services ?? []).length > 0
  && (fleetState.services ?? []).every((s) => s.step === 'complete');
const controller = createSetupModeController({
  keystoreExists: existsSync(keystorePath),
  allComplete,
});

// start the API server EARLY (in either mode)
const uiToken = ensureUiToken();
const handshakeKey = randomBytes(16).toString('hex');
const apiServer = await startApiServer({
  port: config.apiPort,
  store: sqliteStore,
  bindHost: process.env['JINN_API_BIND_HOST'] ?? '127.0.0.1',
  ui: { token: uiToken, handshakeKey },
  bootstrap: { earningDir },
  status: statusGatherConfig,
  // ...existing fields
});
console.error(`[api] UI handshake URL: http://127.0.0.1:${apiServer.port}/auth/handshake?k=${handshakeKey}`);

// Run bootstrap to completion (this is the existing FleetBootstrapper advancing loop)
// ...existing bootstrap orchestration; on each step transition, refresh controller:
// controller.refresh({ keystoreExists: existsSync(keystorePath), allComplete: ... });

// After bootstrap.complete, transition to running:
controller.refresh({ keystoreExists: true, allComplete: true });
// then construct and start Daemon as today
```

The key invariants:
1. `startApiServer` is called BEFORE any bootstrap step that may block on funding.
2. The daemon loops (`new Daemon(...).start()`) do NOT start until `controller.mode() === 'running'`.
3. On bootstrap step transitions, `controller.refresh(...)` is called.

- [ ] **Step 2: Run typecheck**

```bash
cd client && yarn typecheck
```
Expected: zero errors.

- [ ] **Step 3: Run existing test suite to confirm no regressions**

```bash
cd client && yarn test
```
Expected: zero new failures.

- [ ] **Step 4: Manual smoke test (if Anvil available)**

```bash
# Terminal 1
anvil --fork-url https://mainnet.base.org --port 8545
# Terminal 2 — empty ~/.jinn-client and run
rm -rf ~/.jinn-client
JINN_PASSWORD=test yarn start
# expect: API up at 127.0.0.1:7331 within ~1s; "UI handshake URL" printed; bootstrap pauses at awaiting_funding
# verify via curl:
curl -s http://127.0.0.1:7331/v1/bootstrap | jq .mode
# expect: "setup"
```

- [ ] **Step 5: Commit**

```bash
git add client/src/main.ts
git commit -m "feat(daemon): start API in setup-mode before bootstrap; gate loops until complete"
```

---

## Phase 3 — SPA scaffold

### Task 10: Vite + React + Tailwind + shadcn/ui scaffold

**Files:**
- Create: `client/src/dashboard/spa/package.json`
- Create: `client/src/dashboard/spa/vite.config.ts`
- Create: `client/src/dashboard/spa/tsconfig.json`
- Create: `client/src/dashboard/spa/tailwind.config.ts`
- Create: `client/src/dashboard/spa/postcss.config.cjs`
- Create: `client/src/dashboard/spa/index.html`
- Create: `client/src/dashboard/spa/src/main.tsx`
- Create: `client/src/dashboard/spa/src/App.tsx`
- Create: `client/src/dashboard/spa/src/styles/globals.css`
- Modify: `client/package.json` (workspaces / scripts)

**Note:** If Task 1 audit selected a different framework, swap accordingly. The directory layout and the "served from `dist/dashboard`" contract stay.

- [ ] **Step 1: Create the SPA package.json**

```json
{
  "name": "@jinn-network/operator-spa",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@tanstack/react-query": "^5.59.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.4"
  },
  "devDependencies": {
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.10"
  }
}
```

- [ ] **Step 2: Create Vite config**

```typescript
// client/src/dashboard/spa/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:7331',
      '/artifacts': 'http://127.0.0.1:7331',
      '/auth': 'http://127.0.0.1:7331',
      '/api': 'http://127.0.0.1:7331',
    },
  },
});
```

- [ ] **Step 3: Create tsconfig + tailwind config + postcss + index.html**

```json
// client/src/dashboard/spa/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src", "vite.config.ts"]
}
```

```typescript
// client/src/dashboard/spa/tailwind.config.ts
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

```javascript
// client/src/dashboard/spa/postcss.config.cjs
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

```html
<!-- client/src/dashboard/spa/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>jinn operator</title>
  </head>
  <body class="bg-slate-950 text-slate-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create main.tsx + App.tsx + globals.css (skeleton)**

```typescript
// client/src/dashboard/spa/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.js';
import './styles/globals.css';

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 1000 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
```

```typescript
// client/src/dashboard/spa/src/App.tsx
export default function App() {
  return (
    <div className="min-h-screen p-6 grid grid-cols-12 gap-4">
      <header className="col-span-12">
        <h1 className="text-2xl font-bold">jinn operator</h1>
      </header>
      <main className="col-span-12 lg:col-span-8 space-y-4">
        <section data-region="status" className="rounded-lg border border-slate-800 p-4">
          Status (Task 13)
        </section>
        <section data-region="setup" className="rounded-lg border border-slate-800 p-4">
          Setup (Task 15)
        </section>
        <section data-region="visibility" className="rounded-lg border border-slate-800 p-4">
          Visibility (Task 14)
        </section>
      </main>
      <aside className="col-span-12 lg:col-span-4 rounded-lg border border-slate-800 p-4">
        Agent (Task 17)
      </aside>
    </div>
  );
}
```

```css
/* client/src/dashboard/spa/src/styles/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 5: Add SPA package to client workspace**

In `client/package.json`, ensure the SPA is built when `yarn build` runs. Add:

```json
"workspaces": ["src/dashboard/spa"],
```

(If workspaces aren't already there. If they are, add the path.) And add new scripts:

```json
"build:spa": "yarn workspace @jinn-network/operator-spa build",
"dev:spa": "yarn workspace @jinn-network/operator-spa dev"
```

- [ ] **Step 6: Install + build the SPA standalone**

```bash
cd client && yarn install && yarn build:spa
ls src/dashboard/spa/dist  # expect: index.html + assets/
```

Expected: `dist/index.html` and `dist/assets/*.js` exist.

- [ ] **Step 7: Commit**

```bash
git add client/src/dashboard/spa/ client/package.json
git commit -m "feat(spa): scaffold operator SPA (Vite + React + Tailwind)"
```

---

### Task 11: Update build pipeline to ship the SPA dist

**Files:**
- Modify: `client/package.json` (the existing `build` script)
- Delete: `client/src/dashboard/index.html` (old 75-line file)
- Modify: `client/src/api/server.ts` (serve from new path; serve assets too)

- [ ] **Step 1: Update the build script**

Current:
```
"build": "tsc && chmod +x dist/bin/jinn.js && mkdir -p dist/dashboard && cp src/dashboard/index.html dist/dashboard/index.html && rm -rf dist/templates && cp -R templates dist/templates && node scripts/write-dist-build-meta.mjs"
```

New:
```json
"build": "yarn build:spa && tsc && chmod +x dist/bin/jinn.js && rm -rf dist/dashboard && mkdir -p dist/dashboard && cp -R src/dashboard/spa/dist/. dist/dashboard/ && rm -rf dist/templates && cp -R templates dist/templates && node scripts/write-dist-build-meta.mjs"
```

- [ ] **Step 2: Update server.ts to serve the SPA dist (with assets)**

Replace the current single-file `dashboardHtml` block in `client/src/api/server.ts` with directory-based static serving. Use Hono's `serveStatic` middleware (from `@hono/node-server/serve-static`):

```typescript
import { serveStatic } from '@hono/node-server/serve-static';
// ...
const dashboardDir = join(__dirname, '..', 'dashboard');
app.use('/assets/*', serveStatic({ root: dashboardDir }));
app.get('/', (c) => {
  const indexPath = join(dashboardDir, 'index.html');
  try {
    const html = readFileSync(indexPath, 'utf-8');
    return c.html(html);
  } catch {
    return c.html('<html><body><p>SPA not built. Run <code>yarn build</code>.</p></body></html>', 200);
  }
});
// SPA fallback so client-side routing works
app.get('*', (c, next) => {
  if (c.req.path.startsWith('/v1') || c.req.path.startsWith('/artifacts') || c.req.path.startsWith('/auth') || c.req.path.startsWith('/api')) {
    return next();
  }
  const indexPath = join(dashboardDir, 'index.html');
  try {
    return c.html(readFileSync(indexPath, 'utf-8'));
  } catch {
    return next();
  }
});
```

- [ ] **Step 3: Delete the old static dashboard**

```bash
rm client/src/dashboard/index.html
```

- [ ] **Step 4: Build and run smoke test**

```bash
cd client && yarn build
ls dist/dashboard  # expect: index.html, assets/
JINN_PASSWORD=test yarn start &
sleep 2
curl -s http://127.0.0.1:7331/ | head -c 200
kill %1
```
Expected: HTML containing `<div id="root"></div>` from the new SPA.

- [ ] **Step 5: Commit**

```bash
git add client/package.json client/src/api/server.ts client/src/dashboard/index.html
git commit -m "feat(spa): replace static dashboard with SPA dist; route /assets and SPA fallback"
```

---

### Task 12: SPA API client + token handshake bootstrap

**Files:**
- Create: `client/src/dashboard/spa/src/api/client.ts`
- Create: `client/src/dashboard/spa/src/api/types.ts`

- [ ] **Step 1: Implement the types file**

```typescript
// client/src/dashboard/spa/src/api/types.ts
export type StructuredEventKind = 'intent' | 'reward' | 'fleet' | 'system' | 'error' | 'log';

export interface StructuredEvent {
  schemaVersion: 1;
  id: string;
  ts: string;
  kind: StructuredEventKind;
  message: string;
  requestId?: string;
  txHash?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export type DaemonMode = 'setup' | 'running' | 'uninitialized';

export interface BootstrapState {
  schemaVersion: 1;
  mode: DaemonMode;
  steps: string[];
  currentStep: string;
  services: Array<{
    index: number;
    step: string;
    safe_address?: string;
    service_id?: number;
  }>;
  master_address?: string;
  chain?: string;
}
```

- [ ] **Step 2: Implement the API client**

```typescript
// client/src/dashboard/spa/src/api/client.ts
import type { BootstrapState, StructuredEvent } from './types.js';

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${path}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getStatus: () => jfetch<unknown>('/v1/status'),
  getBootstrap: () => jfetch<BootstrapState>('/v1/bootstrap'),
  getRecentEvents: (kinds?: string[], limit = 100) => {
    const q = new URLSearchParams();
    if (kinds && kinds.length > 0) q.set('kinds', kinds.join(','));
    q.set('limit', String(limit));
    return jfetch<{ events: StructuredEvent[] }>(`/v1/events/recent?${q.toString()}`);
  },
};

/**
 * Look at window.location for a `?k=` param (the daemon prints the handshake
 * URL on startup; the launcher opens the browser at that URL). If present,
 * call /auth/handshake?k=<key> to set the cookie, then strip the param.
 */
export async function ensureSessionToken(): Promise<void> {
  const url = new URL(window.location.href);
  const k = url.searchParams.get('k');
  if (k) {
    await fetch(`/auth/handshake?k=${encodeURIComponent(k)}`, { credentials: 'same-origin' });
    url.searchParams.delete('k');
    window.history.replaceState({}, '', url.toString());
  }
}
```

- [ ] **Step 3: Wire ensureSessionToken into main.tsx**

```typescript
// client/src/dashboard/spa/src/main.tsx — replace the render call
import { ensureSessionToken } from './api/client.js';

ensureSessionToken().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>
  );
});
```

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/api/ client/src/dashboard/spa/src/main.tsx
git commit -m "feat(spa): API client + token handshake on first load"
```

---

## Phase 4 — SPA regions

### Task 13: Status region

**Files:**
- Create: `client/src/dashboard/spa/src/regions/Status.tsx`
- Modify: `client/src/dashboard/spa/src/App.tsx`

- [ ] **Step 1: Implement Status.tsx**

```typescript
// client/src/dashboard/spa/src/regions/Status.tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface StatusV1 {
  daemon?: { version?: string; commit?: string; shutdownState?: string };
  rpc?: { ok?: boolean; chainId?: number; blockNumber?: number };
  fleet?: { chain?: string; services?: Array<{ index: number; step: string; serviceId?: number; safeAddress?: string }> };
  rewards?: { pendingStakingRewardsWei?: string; lastClaimTickAt?: string };
  masterGas?: { address?: string; balanceWei?: string; runwayDaysExcess?: string };
  portfolioV0?: {
    inFlight?: Array<{ requestId: string; state: string; implName?: string; windowStartTs: number; windowEndTs: number; stateUpdatedAt: number; lastError?: string }>;
    verdicts?: Array<{ outcome: string; deliveryTxHash?: string; manifestCid?: string }>;
  };
  activity?: { recent?: Array<{ ts?: string; kind: string; requestId?: string; txHash?: string }> };
}

const trunc = (s?: string) => !s ? '--' : (s.length < 12 ? s : `${s.slice(0, 6)}...${s.slice(-4)}`);

export function Status() {
  const { data, isLoading, isError, refetch } = useQuery<StatusV1>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<StatusV1>,
    refetchInterval: 5000,
  });

  if (isLoading) return <div className="text-slate-400">Loading status…</div>;
  if (isError || !data) return <div className="text-red-400">Status fetch failed</div>;

  const net = data.fleet?.chain === 'base' ? 'mainnet' : 'testnet';
  const healthy = data.rpc?.ok ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <span className="text-xs uppercase tracking-wide rounded border border-slate-700 px-2 py-0.5">{net}</span>
          <span className={healthy ? 'text-emerald-400' : 'text-red-400'}>
            {healthy ? 'healthy' : 'rpc error'}
          </span>
        </div>
        <button onClick={() => refetch()} className="text-xs rounded bg-blue-700 px-2 py-1">Refresh now</button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <Card title="In-flight intents">
          {data.portfolioV0?.inFlight?.length
            ? <ul>{data.portfolioV0.inFlight.map((i) => (
                <li key={i.requestId}>{trunc(i.requestId)} — {i.state} ({i.implName ?? '-'})</li>
              ))}</ul>
            : <span className="text-slate-500">none</span>}
        </Card>
        <Card title="Recent verdicts">
          {data.portfolioV0?.verdicts?.length
            ? <ul>{data.portfolioV0.verdicts.slice(0, 5).map((v, i) => (
                <li key={i}>{v.outcome} — {trunc(v.deliveryTxHash)}</li>
              ))}</ul>
            : <span className="text-slate-500">none</span>}
        </Card>
        <Card title="Earnings">
          pending: {data.rewards?.pendingStakingRewardsWei ?? '0'}<br/>
          last claim: {data.rewards?.lastClaimTickAt ?? '--'}
        </Card>
        <Card title="Master gas">
          {trunc(data.masterGas?.address)}<br/>
          balance: {data.masterGas?.balanceWei ?? '0'}<br/>
          runway: {data.masterGas?.runwayDaysExcess ?? '--'}d
        </Card>
        <Card title="Fleet">
          {data.fleet?.services?.length
            ? <ul>{data.fleet.services.map((s) => (
                <li key={s.index}>#{s.index} — {s.step} ({trunc(s.safeAddress)})</li>
              ))}</ul>
            : <span className="text-slate-500">no services</span>}
        </Card>
        <Card title="Daemon">
          version: {data.daemon?.version ?? 'unknown'}<br/>
          state: {data.daemon?.shutdownState ?? 'running'}
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-slate-800 p-3">
      <div className="text-xs uppercase text-slate-400 mb-1">{title}</div>
      <div>{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into App.tsx**

```typescript
// client/src/dashboard/spa/src/App.tsx — replace the status section placeholder
import { Status } from './regions/Status.js';
// ...
<section data-region="status" className="rounded-lg border border-slate-800 p-4">
  <Status />
</section>
```

- [ ] **Step 3: Build SPA + smoke**

```bash
cd client && yarn build:spa
```
Expected: build success.

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/regions/Status.tsx client/src/dashboard/spa/src/App.tsx
git commit -m "feat(spa): Status region with poll-based /v1/status rendering"
```

---

### Task 14: Visibility region (Now panel + activity timeline + log tail)

**Files:**
- Create: `client/src/dashboard/spa/src/regions/Visibility.tsx`
- Create: `client/src/dashboard/spa/src/api/events.ts`
- Modify: `client/src/dashboard/spa/src/App.tsx`

- [ ] **Step 1: Implement events hook (SSE)**

```typescript
// client/src/dashboard/spa/src/api/events.ts
import { useEffect, useState } from 'react';
import type { StructuredEvent } from './types.js';

export function useEventStream(filterKinds?: string[]) {
  const [events, setEvents] = useState<StructuredEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const q = filterKinds && filterKinds.length > 0 ? `?kinds=${filterKinds.join(',')}` : '';
    const es = new EventSource(`/v1/events${q}`, { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as StructuredEvent;
        setEvents((prev) => [...prev.slice(-499), parsed]);
      } catch { /* ignore parse error */ }
    };
    return () => es.close();
  }, [filterKinds?.join(',')]);

  return { events, connected };
}
```

- [ ] **Step 2: Implement Visibility.tsx**

```typescript
// client/src/dashboard/spa/src/regions/Visibility.tsx
import { useState } from 'react';
import { useEventStream } from '../api/events.js';

const ALL_KINDS = ['intent', 'reward', 'fleet', 'system', 'error', 'log'] as const;

export function Visibility() {
  const [selected, setSelected] = useState<string[]>([...ALL_KINDS]);
  const { events, connected } = useEventStream(selected);

  const toggle = (k: string) => {
    setSelected((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <div className="flex gap-2 text-xs">
          {ALL_KINDS.map((k) => (
            <label key={k} className="cursor-pointer">
              <input type="checkbox" checked={selected.includes(k)} onChange={() => toggle(k)} className="mr-1" />
              {k}
            </label>
          ))}
        </div>
        <span className={connected ? 'text-emerald-400 text-xs' : 'text-amber-400 text-xs'}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>
      <div className="font-mono text-xs max-h-96 overflow-y-auto space-y-0.5 border border-slate-800 rounded p-2">
        {events.length === 0 && <div className="text-slate-500">no events yet</div>}
        {events.slice().reverse().map((e) => (
          <div key={e.id} className="flex gap-2">
            <span className="text-slate-500">{e.ts.slice(11, 19)}</span>
            <span className={
              e.kind === 'error' ? 'text-red-400'
              : e.kind === 'intent' ? 'text-blue-400'
              : e.kind === 'reward' ? 'text-amber-400'
              : 'text-slate-400'
            }>
              [{e.kind}]
            </span>
            <span className="flex-1">{e.message}</span>
            {e.txHash && (
              <a
                href={`https://basescan.org/tx/${e.txHash}`}
                target="_blank"
                rel="noopener"
                className="text-blue-400 hover:underline"
              >
                tx
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire into App.tsx**

Replace the visibility placeholder section with `<Visibility />`.

- [ ] **Step 4: Build SPA**

```bash
cd client && yarn build:spa
```

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/api/events.ts client/src/dashboard/spa/src/regions/Visibility.tsx client/src/dashboard/spa/src/App.tsx
git commit -m "feat(spa): Visibility region with SSE event stream + kind filter"
```

---

### Task 15: Setup region (bootstrap state machine + funding card)

**Files:**
- Create: `client/src/dashboard/spa/src/regions/Setup.tsx`
- Create: `client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx`
- Modify: `client/src/dashboard/spa/src/App.tsx`

- [ ] **Step 1: Implement AwaitingFundingCard.tsx**

```typescript
// client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx
import { useEffect, useState } from 'react';

interface Props {
  address: string;
  minimumWei: string;
  chainExplorerBase: string;
}

export function AwaitingFundingCard({ address, minimumWei, chainExplorerBase }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Reset copy banner after 1.5s. The chain-watcher actually lives on the daemon
  // and pushes via SSE — UI doesn't need to poll the chain itself.
  useEffect(() => {}, []);

  return (
    <div className="border border-amber-700 bg-amber-950/20 rounded p-4 space-y-2">
      <div className="text-amber-400 text-sm font-semibold">Action needed: fund this address with ETH</div>
      <div className="font-mono text-xs break-all">{address}</div>
      <div className="text-xs text-slate-400">Minimum: {minimumWei} wei</div>
      <div className="flex gap-2">
        <button onClick={copy} className="text-xs rounded bg-blue-700 px-2 py-1">
          {copied ? 'Copied!' : 'Copy address'}
        </button>
        <a
          href={`${chainExplorerBase}/address/${address}`}
          target="_blank"
          rel="noopener"
          className="text-xs rounded border border-slate-700 px-2 py-1"
        >
          View on explorer
        </a>
        <a
          href="https://portal.cdp.coinbase.com/products/faucet"
          target="_blank"
          rel="noopener"
          className="text-xs rounded border border-slate-700 px-2 py-1"
        >
          Faucet
        </a>
      </div>
      <div className="text-xs text-slate-500">Auto-advances when funds land. Chain watcher polling…</div>
    </div>
  );
}
```

- [ ] **Step 2: Implement Setup.tsx**

```typescript
// client/src/dashboard/spa/src/regions/Setup.tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { BootstrapState } from '../api/types.js';
import { AwaitingFundingCard } from './AwaitingFundingCard.js';

const STEP_LABELS: Record<string, string> = {
  wallet: 'Create master wallet',
  safe_predicted: 'Predict Safe address',
  awaiting_funding: 'Fund the master EOA with ETH',
  safe_deployed: 'Deploy Safe',
  service_created: 'Register service on-chain',
  service_activated: 'Activate service',
  agents_registered: 'Register agent',
  service_deployed: 'Deploy service',
  service_staked: 'Stake service',
  mech_deployed: 'Deploy mech',
  complete: 'Complete',
};

export function Setup() {
  const { data, isLoading } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 3000,
  });

  if (isLoading || !data) return <div className="text-slate-400">Loading bootstrap state…</div>;
  if (data.mode === 'running') {
    return <div className="text-emerald-400 text-sm">All set up.</div>;
  }

  const explorer = data.chain === 'base' ? 'https://basescan.org' : 'https://sepolia.basescan.org';
  const masterAddress = data.master_address ?? '';

  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-300">Setting up your fleet. Steps below — most run automatically.</div>
      <ol className="space-y-1 text-sm">
        {data.steps.map((step) => {
          const idx = data.steps.indexOf(step);
          const currentIdx = data.steps.indexOf(data.currentStep);
          const status = idx < currentIdx ? 'done' : idx === currentIdx ? 'current' : 'pending';
          const icon = status === 'done' ? '✓' : status === 'current' ? '→' : '·';
          const className = status === 'done' ? 'text-emerald-400' : status === 'current' ? 'text-amber-400 font-semibold' : 'text-slate-500';
          return (
            <li key={step} className={className}>
              <span className="inline-block w-4">{icon}</span> {STEP_LABELS[step] ?? step}
            </li>
          );
        })}
      </ol>
      {data.currentStep === 'awaiting_funding' && masterAddress && (
        <AwaitingFundingCard
          address={masterAddress}
          minimumWei="10000000000000000"
          chainExplorerBase={explorer}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire into App.tsx**

Replace the setup placeholder with `<Setup />`.

- [ ] **Step 4: Build SPA**

```bash
cd client && yarn build:spa
```

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/regions/Setup.tsx client/src/dashboard/spa/src/regions/AwaitingFundingCard.tsx client/src/dashboard/spa/src/App.tsx
git commit -m "feat(spa): Setup region with bootstrap state machine + funding card"
```

---

### Task 16: Agent panel WebSocket bridge (server-side)

**Files:**
- Create: `client/src/agent/operator-claude.ts`
- Create: `client/src/agent/agent-ws.ts`
- Create: `client/test/agent/operator-claude.test.ts`
- Modify: `client/src/api/server.ts`
- Modify: `client/package.json` (add `ws` dep)

**Note:** This task assumes the audit (Task 1) chose a "spawn `claude` as a TTY child process and pipe to xterm.js" approach. If audit chose `assistant-ui` with structured messages, swap the bridge to a JSON message protocol instead.

- [ ] **Step 1: Add ws dependency**

```bash
cd client && yarn add ws @types/ws node-pty
```

- [ ] **Step 2: Implement operator-claude.ts**

```typescript
// client/src/agent/operator-claude.ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { IPty } from 'node-pty';

export interface OperatorClaudeConfig {
  claudePath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When true, spawn with --enable-auto-mode (Claude Code v2.1.83+, plan-gated). */
  autoMode: boolean;
  /** MCP config path so the embedded session reaches the operator MCP server. */
  mcpConfigPath?: string;
}

export interface OperatorClaude {
  proc: IPty | ChildProcess;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export async function spawnOperatorClaude(cfg: OperatorClaudeConfig): Promise<OperatorClaude> {
  const args: string[] = [];
  if (cfg.autoMode) args.push('--enable-auto-mode');
  if (cfg.mcpConfigPath) args.push('--mcp-config', cfg.mcpConfigPath);

  // Try node-pty for true TTY behaviour; fall back to plain spawn if unavailable.
  try {
    const ptyModule = await import('node-pty');
    const pty = ptyModule.spawn(cfg.claudePath, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: cfg.cwd,
      env: { ...process.env, ...cfg.env, TERM: 'xterm-256color' },
    });
    const dataHandlers: Array<(chunk: string) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    pty.onData((d) => dataHandlers.forEach((h) => h(d)));
    pty.onExit(({ exitCode }) => exitHandlers.forEach((h) => h(exitCode ?? null)));
    return {
      proc: pty,
      write: (d) => pty.write(d),
      resize: (c, r) => pty.resize(c, r),
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
      kill: () => pty.kill(),
    };
  } catch {
    const proc = spawn(cfg.claudePath, args, {
      cwd: cfg.cwd,
      env: { ...process.env, ...cfg.env },
    });
    const dataHandlers: Array<(chunk: string) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    proc.stdout?.on('data', (chunk: Buffer) => dataHandlers.forEach((h) => h(chunk.toString('utf-8'))));
    proc.stderr?.on('data', (chunk: Buffer) => dataHandlers.forEach((h) => h(chunk.toString('utf-8'))));
    proc.on('exit', (code) => exitHandlers.forEach((h) => h(code)));
    return {
      proc,
      write: (d) => { proc.stdin?.write(d); },
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
      kill: () => { proc.kill(); },
    };
  }
}
```

- [ ] **Step 3: Implement agent-ws.ts**

```typescript
// client/src/agent/agent-ws.ts
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { spawnOperatorClaude, type OperatorClaude } from './operator-claude.js';
import { detectAutoModeAvailable } from './auto-mode-detect.js';

export interface AgentWsConfig {
  httpServer: HttpServer;
  uiToken: string;
  claudePath: string;
  cwd: string;
  mcpConfigPath?: string;
}

export function attachAgentWs(cfg: AgentWsConfig) {
  const wss = new WebSocketServer({ server: cfg.httpServer, path: '/api/agent/ws' });

  wss.on('connection', async (ws: WebSocket, req) => {
    const cookie = req.headers.cookie ?? '';
    const cookieMatch = /jinn_ui_token=([^;]+)/.exec(cookie);
    const token = cookieMatch?.[1];
    if (!token || token !== cfg.uiToken) {
      ws.close(1008, 'unauthorized');
      return;
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
      ws.send(JSON.stringify({ kind: 'error', message: `failed to spawn claude: ${(err as Error).message}` }));
      ws.close();
      return;
    }

    // Inform the SPA whether Auto Mode is active.
    ws.send(JSON.stringify({ kind: 'meta', autoMode: auto.available, reason: auto.reason }));

    session.onData((chunk) => {
      try { ws.send(JSON.stringify({ kind: 'data', data: chunk })); } catch { /* socket gone */ }
    });
    session.onExit((code) => {
      try { ws.send(JSON.stringify({ kind: 'exit', code })); } catch {}
      ws.close();
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { kind: string; data?: string; cols?: number; rows?: number };
        if (msg.kind === 'input' && msg.data) session.write(msg.data);
        if (msg.kind === 'resize' && session.resize && msg.cols && msg.rows) session.resize(msg.cols, msg.rows);
      } catch { /* ignore */ }
    });
    ws.on('close', () => session.kill());
  });

  return wss;
}
```

- [ ] **Step 4: Implement Auto Mode detection**

```typescript
// client/src/agent/auto-mode-detect.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const MIN_VERSION = { major: 2, minor: 1, patch: 83 };

export interface AutoModeAvailability {
  available: boolean;
  reason: string;
  version?: string;
}

export async function detectAutoModeAvailable(claudePath: string): Promise<AutoModeAvailability> {
  try {
    const { stdout } = await execFileP(claudePath, ['--version'], { timeout: 4000 });
    const versionMatch = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    if (!versionMatch) {
      return { available: false, reason: 'could not parse claude --version output' };
    }
    const [, major, minor, patch] = versionMatch.map(Number);
    const versionStr = `${major}.${minor}.${patch}`;
    if (
      major < MIN_VERSION.major ||
      (major === MIN_VERSION.major && minor < MIN_VERSION.minor) ||
      (major === MIN_VERSION.major && minor === MIN_VERSION.minor && patch < MIN_VERSION.patch)
    ) {
      return {
        available: false,
        reason: `Claude Code ${versionStr} is older than required ${MIN_VERSION.major}.${MIN_VERSION.minor}.${MIN_VERSION.patch} for Auto Mode`,
        version: versionStr,
      };
    }
    return { available: true, reason: 'ok', version: versionStr };
  } catch (err) {
    return { available: false, reason: `claude --version failed: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 5: Wire WS server into the API HTTP server**

In `client/src/api/server.ts`, expose the underlying `http.Server` instance so `attachAgentWs` can mount the WebSocket on the same port. Modify `startApiServer` to return `{ port, close, server }` where `server` is the node `http.Server`. Then in `client/src/main.ts` after `startApiServer` returns, call:

```typescript
import { attachAgentWs } from './agent/agent-ws.js';
import { writeFileSync, mkdirSync } from 'node:fs';

// build an MCP config that the embedded claude session loads
const mcpConfigPath = join(homedir(), '.jinn-client', 'operator-mcp-config.json');
mkdirSync(dirname(mcpConfigPath), { recursive: true });
writeFileSync(mcpConfigPath, JSON.stringify({
  mcpServers: {
    'jinn-operator': {
      command: process.execPath,
      args: [join(__dirname, 'bin', 'jinn.js'), 'mcp'],
    },
  },
}, null, 2));

attachAgentWs({
  httpServer: apiServer.server,
  uiToken,
  claudePath: config.claudePath ?? 'claude',
  cwd: process.cwd(),
  mcpConfigPath,
});
```

- [ ] **Step 6: Write the operator-claude unit test**

```typescript
// client/test/agent/operator-claude.test.ts
import { describe, it, expect } from 'vitest';
import { detectAutoModeAvailable } from '../../src/agent/auto-mode-detect.js';

describe('detectAutoModeAvailable', () => {
  it('returns available=false when binary does not exist', async () => {
    const res = await detectAutoModeAvailable('/nonexistent/claude');
    expect(res.available).toBe(false);
    expect(res.reason).toContain('failed');
  });
});
```

- [ ] **Step 7: Run tests**

```bash
cd client && yarn test test/agent/operator-claude.test.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/agent/ client/test/agent/ client/src/api/server.ts client/src/main.ts client/package.json
git commit -m "feat(agent): WebSocket bridge to embedded claude --enable-auto-mode subprocess"
```

---

### Task 17: Agent panel UI (browser, xterm.js)

**Files:**
- Create: `client/src/dashboard/spa/src/regions/Agent.tsx`
- Modify: `client/src/dashboard/spa/package.json` (add `xterm` deps)
- Modify: `client/src/dashboard/spa/src/App.tsx`

**Note:** If audit (Task 1) chose `assistant-ui`, replace the xterm-based component with that library; the WebSocket protocol changes from raw bytes to structured messages.

- [ ] **Step 1: Add xterm deps**

```bash
cd client/src/dashboard/spa && yarn add xterm xterm-addon-fit xterm-addon-web-links
```

- [ ] **Step 2: Implement Agent.tsx**

```typescript
// client/src/dashboard/spa/src/regions/Agent.tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

export function Agent() {
  const ref = useRef<HTMLDivElement>(null);
  const [autoMode, setAutoMode] = useState<{ active: boolean; reason: string } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!ref.current) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 12,
      theme: { background: '#0b1020', foreground: '#d5def5' },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(ref.current);
    fit.fit();
    const resizeObs = new ResizeObserver(() => fit.fit());
    resizeObs.observe(ref.current);

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/agent/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as { kind: string; data?: string; autoMode?: boolean; reason?: string };
        if (parsed.kind === 'data' && parsed.data) {
          term.write(parsed.data);
        } else if (parsed.kind === 'meta') {
          setAutoMode({ active: !!parsed.autoMode, reason: parsed.reason ?? '' });
        }
      } catch { /* ignore */ }
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
    <div className="h-full flex flex-col">
      <div className="text-xs flex justify-between items-center mb-2">
        <span>{connected ? 'agent connected' : 'agent disconnected'}</span>
        {autoMode && (
          <span className={autoMode.active ? 'text-emerald-400' : 'text-amber-400'}>
            {autoMode.active ? 'Auto Mode' : `Default permissions (${autoMode.reason})`}
          </span>
        )}
      </div>
      <div ref={ref} className="flex-1 min-h-[400px] rounded border border-slate-800 bg-slate-950" />
    </div>
  );
}
```

- [ ] **Step 3: Wire into App.tsx**

Replace the agent placeholder aside with `<Agent />`.

- [ ] **Step 4: Build SPA**

```bash
cd client && yarn build:spa
```

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/regions/Agent.tsx client/src/dashboard/spa/src/App.tsx client/src/dashboard/spa/package.json client/src/dashboard/spa/yarn.lock
git commit -m "feat(spa): Agent panel with xterm.js + WebSocket to embedded claude"
```

---

## Phase 5 — Operator MCP extensions

### Task 18: Add live-state tools to operator MCP server

**Files:**
- Modify: `client/src/mcp/operator-server.ts`

**Note:** The existing operator MCP server wraps CLI commands. New tools below also need a way to talk to the *live* daemon. We use HTTP to the daemon's API rather than command-wrapping for these.

- [ ] **Step 1: Add `activity_list` tool**

In `client/src/mcp/operator-server.ts`, register a new tool that fetches `/v1/events/recent`:

```typescript
import { default as fetchModule } from 'node-fetch';
const fetchFn: typeof fetch = (typeof fetch !== 'undefined' ? fetch : (fetchModule as unknown as typeof fetch));

server.tool(
  'activity_list',
  'List recent structured daemon events. Filter by kinds: intent, reward, fleet, system, error, log.',
  {
    kinds: z.array(z.enum(['intent', 'reward', 'fleet', 'system', 'error', 'log'])).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async ({ kinds, limit }) => {
    const port = Number(process.env['JINN_API_PORT'] ?? 7331);
    const q = new URLSearchParams();
    if (kinds && kinds.length > 0) q.set('kinds', kinds.join(','));
    if (limit !== undefined) q.set('limit', String(limit));
    const url = `http://127.0.0.1:${port}/v1/events/recent?${q.toString()}`;
    try {
      const res = await fetchFn(url);
      const body = await res.json() as { events: unknown[] };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
    }
  },
);
```

- [ ] **Step 2: Add `bootstrap_state` tool**

Similar pattern — fetches `/v1/bootstrap`:

```typescript
server.tool(
  'bootstrap_state',
  'Get the current bootstrap state machine: mode (setup|running|uninitialized), current step, services, master address, chain.',
  {},
  async () => {
    const port = Number(process.env['JINN_API_PORT'] ?? 7331);
    try {
      const res = await fetchFn(`http://127.0.0.1:${port}/v1/bootstrap`);
      const body = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
    }
  },
);
```

- [ ] **Step 3: Add `daemon_restart`, `loop_pause`, `loop_resume`**

These need a daemon-side admin endpoint to act on. Add `/api/admin/loop/:loop/:action` to the daemon API server (in Task 4's `events-endpoint.ts` neighbour or a new `client/src/api/admin-endpoint.ts`), gated by `requireUiToken`. The endpoint posts a control message to a small in-memory bus the daemon's loops listen to.

For v1-Slim: implement `daemon_restart` as a process-level signal (the daemon's existing graceful-shutdown machinery handles SIGUSR2, then re-exec via `process.execvp`). `loop_pause/resume` are stubs that emit a structured event for now and surface the limitation in the tool description; full implementation is a follow-on bead. Track:

```typescript
server.tool(
  'daemon_restart',
  'Request a daemon restart. Requires confirm=true. The daemon will shut down loops gracefully and the process will exit; the supervising shell or systemd unit must restart it.',
  { confirm: z.boolean().optional() },
  async ({ confirm }) => {
    if (!confirm) {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: 'would request daemon shutdown', confirm_with: 'daemon_restart with confirm=true' }) }] };
    }
    const port = Number(process.env['JINN_API_PORT'] ?? 7331);
    try {
      await fetchFn(`http://127.0.0.1:${port}/api/admin/restart`, { method: 'POST' });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
    }
  },
);
```

For `loop_pause` / `loop_resume`, add similar tool calls that hit `/api/admin/loop/:name/:action` (POST). File a follow-on bead noting the daemon-side wiring is stubbed.

- [ ] **Step 4: Add the admin endpoint stub**

Create `client/src/api/admin-endpoint.ts`:

```typescript
// client/src/api/admin-endpoint.ts
import type { Hono } from 'hono';

export interface AdminEndpointConfig {
  onRestartRequested: () => void;
}

export function addAdminRoutes(app: Hono, cfg: AdminEndpointConfig): void {
  app.post('/api/admin/restart', (c) => {
    cfg.onRestartRequested();
    return c.json({ ok: true });
  });
  app.post('/api/admin/loop/:loop/:action', (c) => {
    const loop = c.req.param('loop');
    const action = c.req.param('action');
    return c.json({ schemaVersion: 1, ok: false, reason: 'not_implemented', loop, action });
  });
}
```

Wire it in `server.ts` and pass `onRestartRequested` from `main.ts` to a function that calls `process.exit(0)` after stop hooks.

- [ ] **Step 5: File follow-on bead for loop control**

```bash
bd create --title="Implement daemon loop pause/resume control plane" --type=task --priority=3 --description="Operator MCP exposes loop_pause/loop_resume tools (jinn-mono-3ois implementation), but the daemon-side wiring is currently stubbed. The Daemon class in client/src/daemon/daemon.ts launches loops via .run() and does not expose pause/resume hooks. Each loop needs a cancellation primitive that survives in-flight work. Out of scope for v1-Slim; this is the v1.x follow-on."
```

- [ ] **Step 6: Commit**

```bash
git add client/src/mcp/operator-server.ts client/src/api/admin-endpoint.ts client/src/api/server.ts client/src/main.ts
git commit -m "feat(operator-mcp): activity_list, bootstrap_state, daemon_restart tools (loop control stubbed)"
```

---

## Phase 6 — Launch story + Auto Mode detection

### Task 19: `jinn run --no-ui` flag + auto-open browser by default

**Files:**
- Modify: `client/src/cli/commands/run.ts`
- Create: `client/src/cli/open-browser.ts`
- Create: `client/test/cli/run-no-ui.test.ts`

- [ ] **Step 1: Implement open-browser helper**

```typescript
// client/src/cli/open-browser.ts
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
            : platform === 'win32'  ? 'start'
            : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best-effort */ }
}
```

- [ ] **Step 2: Add --no-ui flag to run command**

In `client/src/cli/commands/run.ts`, add a `'no-ui'` option to the parseArgs config:

```typescript
options: {
  ...COMMON_FLAGS,
  'no-ui': { type: 'boolean', default: false },
},
```

After successful daemon start, before the main daemon loop blocks, read the `JINN_UI_HANDSHAKE_URL` env var (set by main.ts when API server starts) and open it unless `--no-ui` is passed:

```typescript
if (!parsed.values['no-ui']) {
  const handshakeUrl = process.env['JINN_UI_HANDSHAKE_URL'];
  if (handshakeUrl) {
    openBrowser(handshakeUrl);
  }
}
```

The main.ts in Task 9 should set `process.env['JINN_UI_HANDSHAKE_URL']` immediately after constructing the handshake URL, so child code (including run.ts continuation) can read it.

- [ ] **Step 3: Write the failing test**

```typescript
// client/test/cli/run-no-ui.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createRunCommand } from '../../src/cli/commands/run.js';

describe('jinn run --no-ui', () => {
  it('parses --no-ui flag without error', async () => {
    const writer = { write: vi.fn().mockReturnValue(true) };
    let exited: number | null = null;
    const cmd = createRunCommand({
      // dependency injection for tests
      loadConfig: () => ({} as any),
      getConfigPathFromArgs: () => undefined,
      checkRpcNetwork: async () => ({ ok: true }) as any,
      rpcNetworkFailureHint: () => '',
      checkApiPortAvailable: async () => ({ ok: true }) as any,
      apiPortFailureMessage: () => '',
      resolveCliPassword: () => ({ ok: true, password: 'test' }) as any,
      mainFn: async () => ({ pid: 1, network: 't', apiPort: 7331, serviceIndex: 0, safeAddress: '0x' }),
    });
    await cmd.run({
      argv: ['--no-ui', '--json'],
      stdoutIsTty: false,
      writer,
      exit: (c) => { exited = c; },
      env: { JINN_PASSWORD: 'test' },
    });
    expect(exited).not.toBe(11);  // should not exit with invalid_invocation
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd client && yarn test test/cli/run-no-ui.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update help text**

In `run.ts` helpText, document `--no-ui`:
```
  --no-ui      Suppress automatic browser open (default: open the operator panel).
```

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/run.ts client/src/cli/open-browser.ts client/test/cli/run-no-ui.test.ts
git commit -m "feat(cli): jinn run --no-ui (default opens operator panel in browser)"
```

---

### Task 20: jinn ui shortcut command

**Files:**
- Create: `client/src/cli/commands/ui.ts`
- Modify: `client/src/cli/index.ts`

- [ ] **Step 1: Implement the ui command**

```typescript
// client/src/cli/commands/ui.ts
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { openBrowser } from '../open-browser.js';

const command: CommandModule = {
  name: 'ui',
  summary: 'Open the operator panel in your browser (assumes daemon is running)',
  helpText: `Usage: jinn ui [--port <n>]

Opens http://127.0.0.1:7331 (or the configured port) in the default browser.
This is a convenience wrapper — the panel is also auto-opened by \`jinn run\`.

If the daemon isn't running, the page will fail to load; start the daemon
with \`jinn run\` first.

Examples:
  jinn ui
  jinn ui --port 7332
`,
  async run(ctx: CommandContext): Promise<void> {
    let parsed;
    try {
      parsed = parseArgs({
        args: ctx.argv,
        options: { ...COMMON_FLAGS, port: { type: 'string' } },
        allowPositionals: false,
      });
    } catch (err) {
      emitEnvelope({
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn ui',
        details: { field: 'flags' },
      }, { writer: ctx.writer, exit: ctx.exit });
      return;
    }
    const port = (parsed.values.port as string | undefined) ?? ctx.env['JINN_API_PORT'] ?? '7331';
    const url = `http://127.0.0.1:${port}/`;
    openBrowser(url);
    ctx.writer.write(JSON.stringify({ schemaVersion: 1, opened: url }) + '\n');
  },
};

export default command;
```

- [ ] **Step 2: Register the command**

In `client/src/cli/index.ts`, add to the imports and command registry:

```typescript
import uiCommand from './commands/ui.js';
// ...
const COMMANDS: CommandModule[] = [
  // ...existing commands
  uiCommand,
];
```

- [ ] **Step 3: Run typecheck**

```bash
cd client && yarn typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/cli/commands/ui.ts client/src/cli/index.ts
git commit -m "feat(cli): jinn ui shortcut to open the operator panel"
```

---

## Phase 7 — End-to-end test

### Task 21: SPA Playwright e2e on Anvil fork

**Files:**
- Create: `client/test/dashboard/spa.e2e.test.ts`
- Modify: `client/package.json` (add `@playwright/test`)

- [ ] **Step 1: Add Playwright**

```bash
cd client && yarn add -D @playwright/test
yarn playwright install chromium
```

- [ ] **Step 2: Implement the test**

```typescript
// client/test/dashboard/spa.e2e.test.ts
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17331; // avoid collisions with a running dev daemon

let daemon: ChildProcess | null = null;
let homeDir = '';

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-spa-e2e-'));
  daemon = spawn('node', ['./dist/bin/jinn.js', 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test',
      JINN_API_PORT: String(PORT),
      BASE_RPC_URL: 'http://127.0.0.1:8545',
      JINN_NETWORK: 'mainnet',
    },
    stdio: 'pipe',
  });
  // wait for /v1/bootstrap to come up
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`);
      if (res.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('daemon did not come up in 30s');
});

test.afterAll(() => {
  daemon?.kill('SIGTERM');
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

test('SPA loads and shows Setup region in setup mode', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await expect(page.getByText('jinn operator')).toBeVisible();
  await expect(page.locator('[data-region="setup"]')).toBeVisible();
});

test('GET /v1/bootstrap reports mode setup before funding', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`);
  const body = await res.json();
  expect(['setup', 'uninitialized']).toContain(body.mode);
});

test('GET /v1/events/recent returns an array', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/events/recent`);
  const body = await res.json();
  expect(Array.isArray(body.events)).toBe(true);
});
```

- [ ] **Step 3: Add a script**

In `client/package.json`:

```json
"e2e:spa": "yarn build && playwright test test/dashboard/spa.e2e.test.ts"
```

- [ ] **Step 4: Run the e2e**

Requires Anvil running on `:8545`:

```bash
# terminal 1
anvil --fork-url https://mainnet.base.org --port 8545
# terminal 2
cd client && yarn e2e:spa
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/test/dashboard/spa.e2e.test.ts client/package.json client/yarn.lock
git commit -m "test(spa): Playwright e2e covering setup-mode SPA load + endpoints"
```

---

## Phase 8 — Documentation + finishing touches

### Task 22: Update README + add SPA dev README

**Files:**
- Modify: `client/README.md`
- Create: `client/src/dashboard/spa/README.md`

- [ ] **Step 1: Update client/README.md**

Add a section near the top:

```markdown
## Operator panel (local web UI)

Running `jinn run` (or `yarn start`) opens a browser to `http://127.0.0.1:7331`
with the operator panel — Status, Visibility, Setup, and an embedded
Claude Code session in Auto Mode.

To suppress auto-open: `jinn run --no-ui`.

For SPA development, see [`src/dashboard/spa/README.md`](src/dashboard/spa/README.md).
```

- [ ] **Step 2: Create the SPA dev README**

```markdown
# Operator SPA dev

Vite + React + Tailwind. Source under `src/`, built into `dist/` and copied
into the daemon's `dist/dashboard/` directory by `client/yarn build`.

## Develop

```bash
# from client/
yarn dev:spa
# Vite serves on :5173 with proxy to :7331 daemon
```

Run the daemon separately on `:7331` (e.g. `yarn start`).

## Build

`yarn build` (from `client/`) builds the SPA and copies to `dist/dashboard`.
```

- [ ] **Step 3: Commit**

```bash
git add client/README.md client/src/dashboard/spa/README.md
git commit -m "docs: operator panel quickstart in client README + SPA dev README"
```

---

### Task 23: Update bd issue jinn-mono-3ois with implementation status + close v1-Slim

**Files:** none (bd updates only)

- [ ] **Step 1: Update jinn-mono-3ois with the spec/plan paths and decisions**

```bash
bd update jinn-mono-3ois --notes "$(cat <<'EOF'
v1-Slim implementation landed.

Spec: docs/superpowers/specs/2026-05-01-operator-local-app-design.md
Plan: docs/superpowers/plans/2026-05-01-operator-local-app.md
OSS audit: docs/superpowers/audits/2026-05-01-operator-app-oss-reuse.md

Decisions:
- Form factor: localhost web SPA served by Hono (no Electron).
- Audience: every operator across lifecycle (not Captain-only, not evaluator).
- Agent role: GUI-first co-pilot; embedded Claude Code with --enable-auto-mode.
- Bootstrap: standard mode only; one funding touchpoint (ETH on EOA).
- v1-Slim shipped: Status, Visibility, Setup, Agent regions; setup-mode daemon.

Open follow-ons (filed):
- jinn-mono-95sj — intent enable/disable redesign (blocks panel intent toggles).
- jinn-mono-dgi0 — jinn auth split (independent of panel).
- (filed in Task 18) — daemon loop pause/resume control plane.

Treating this as a Task (not an Epic) — v1-Slim is one shippable unit.
EOF
)"
```

- [ ] **Step 2: Final commit + push**

```bash
git status
# verify clean tree
git pull --rebase
bd dolt push
git push
git status  # MUST show "up to date with origin"
```

---

## Self-Review

### 1. Spec coverage check

| Spec section | Implemented in |
|---|---|
| Single-process Hono daemon serving SPA | Tasks 7, 11 |
| `/v1/events` SSE | Task 4 |
| `/v1/bootstrap` | Task 5 |
| `/auth/handshake` + UI token | Task 6 |
| `/mcp/operator` (extended) | Task 18 |
| Setup-mode daemon, loops gated | Tasks 8, 9 |
| Status region | Task 13 |
| Visibility region (Now panel + activity timeline + log tail) | Task 14 |
| Setup region (touchpoint flows) + funding card | Task 15 |
| Agent panel (WS + xterm + Auto Mode) | Tasks 16, 17 |
| jinn run --no-ui + auto-open | Task 19 |
| jinn ui | Task 20 |
| Localhost-only binding | Task 7 |
| OSS audit before framework lock-in | Task 1 |
| Tests (unit + Playwright e2e) | Tasks 2, 4, 5, 6, 8, 16, 19, 21 |
| Docs | Task 22 |

No gaps.

### 2. Placeholder scan

No "TBD", "TODO", "implement later" placeholders. Each step has actual code or a concrete command. Two stubs are explicitly called out and their follow-on bead filed (Task 18 step 5: loop pause/resume daemon-side wiring).

### 3. Type consistency

`StructuredEvent` schema is defined in Task 2 and used consistently in Tasks 3, 4, 14, 18. `BootstrapState` is defined in Task 12 and used in Task 15. `DaemonMode` is defined in Task 8 and used in Tasks 9, 12, 15. The MCP tool names (`activity_list`, `bootstrap_state`, `daemon_restart`, `loop_pause`, `loop_resume`) use snake_case throughout (matching the existing `operator-server.ts` convention).

### 4. Notable risks

- **Task 1 may flip framework:** Tasks 10–17 assume Vite + React + xterm.js. If audit selects assistant-ui or another bundle, swap before executing.
- **Task 16 needs node-pty native build:** `yarn add node-pty` may require build tools. The fallback to plain `spawn` keeps the feature usable without TTY behaviour, but echo/colors will be diminished.
- **Task 18 stubs loop control:** documented; follow-on bead filed.
- **Task 19 `JINN_UI_HANDSHAKE_URL` env plumbing:** has to be set by main.ts (Task 9) BEFORE the run.ts continuation reads it. Confirm timing during execution.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-01-operator-local-app.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
