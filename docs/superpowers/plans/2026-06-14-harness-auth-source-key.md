# Harness Auth Source / Key Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Operator Dashboard "Harness auth status" panel (and the `GET /v1/harnesses/auth-status` endpoint behind it) that shows, per harness, where its credential lives, the key's last-4 suffix, the credential file's last-modified time, and a `loaded`/`missing`/`unknown` state badge — never the full key.

**Architecture:** A new optional `getAuthSource?()` method on the `Harness` interface lets each harness declare *where* its credential lives (file path + env key, or `session` for CLI-session auth). A shared helper (`auth-source.ts`) owns the unsafe part — `fs.stat` for mtime, read the credential, keep only `.slice(-4)`, discard the full value, and mask the suffix to `null` when the value is shorter than 8 chars. A read-only Hono endpoint iterates the existing `HarnessReadinessRegistry`'s harness instances and returns suffix + metadata only. The SPA adds a read-only `Card`+`Table` section to `SecurityTab`, polled via a new `api.harnessAuthStatus()` client method, each row deep-linking to a new `rotating-harness-keys` runbook.

**Tech Stack:** TypeScript, Node `node:fs`/`node:path`/`node:os`, Hono (daemon HTTP), Vitest (unit), React + shadcn/ui (`Card`, `Table`, `Badge`) for the SPA, React Testing Library + Vitest for SPA tests.

---

## Background facts (verified against the tree — do not re-discover)

- `Harness` interface: `client/src/harnesses/types.ts` (lines 224-307). Optional methods already use the `method?()` pattern (`attributionPlugins?`, `isReady?`, `onEnable?`). Add `getAuthSource?` here.
- Harness names: `client/src/harnesses/names.ts` — `CLAUDE_CODE_HARNESS='claude-code'`, `CODEX_HARNESS='codex'`, `HERMES_AGENT_HARNESS='hermes-agent'`. `canonicalHarnessName(name)` collapses aliases (`claude-code-learner`→`claude-code`, `codex-code-learner`→`codex`).
- `LearnerHarness` (`client/src/harnesses/impls/learner/harness.ts`) is **one class** whose `this.name` is either `claude-code` or `codex` — branch on `canonicalHarnessName(this.name)` (it already does so in `isReady`, line 128).
- Hermes credential: file `$HERMES_HOME/.env` (default `~/.hermes/.env`), env key `OPENROUTER_API_KEY`. Home resolution: `process.env['HERMES_HOME']?.trim() || join(homedir(), '.hermes')` (`client/src/harnesses/impls/hermes-agent/adapter.ts:127`).
- Codex credential: `OPENAI_API_KEY` env, else `auth.json` at `CODEX_HOME` or `~/.codex/auth.json` (`client/src/api/codex-doctor-endpoint.ts:199-202`).
- Claude-code credential: CLI session (`claude auth status`), no stat-able file — `client/src/preflight/claude-auth.ts`. → `sourceKind: 'session'`, state `unknown`.
- Prediction baselines (`prediction-v0-baseline`, `prediction-v1-baseline`, etc.): no credential → omit `getAuthSource` entirely → endpoint reports "no auth required".
- Registry: `client/src/harnesses/readiness-registry.ts` — `HarnessReadinessRegistry` holds `opts.harnessesByName` **private**. It seeds *every* registered harness in `_doRefresh` (line 139), so iterating its harness map covers every harness. We add a `getHarnesses()` accessor.
- Registry wiring in server: `client/src/api/server.ts:586-598` — supports a `{ registry }` form (tests/daemon) and a `{ holder: { current } }` lazy form (HTTP server, populated post-bootstrap by `main.ts:2065`). The new endpoint MUST mount with the **same holder/lazy pattern** under the existing `app.use('/v1/harnesses/*', requireUiToken(...))` gate at `server.ts:503`.
- Registry built by `buildHarnessReadinessRegistry` (`client/src/main.ts:2841`).
- Readiness endpoint to mirror: `client/src/api/harness-readiness-endpoint.ts`. Its test: `client/test/api/harness-readiness-endpoint.test.ts` (Hono `app.request(...)` pattern).
- SPA api client: `client/src/dashboard/spa/src/api/client.ts` — `harnessReadiness` at line 257; types in `client/src/dashboard/spa/src/api/types.ts` (`HarnessReadinessEntry` at line 967).
- SPA panel home: `client/src/dashboard/spa/src/pages/operator/SecurityTab.tsx` (rendered as the "Security" route, `App.tsx:156`). Test: `.../SecurityTab.test.tsx`. shadcn primitives present: `components/ui/card.tsx`, `table.tsx`, `badge.tsx`.
- Tests live under `client/test/<mirror-of-src>` for daemon code; SPA component tests are co-located (`*.test.tsx` next to the component). Run with `yarn test` (root: `cd client && yarn test`).
- Spec to update: `client/OPERATOR-APP-SPEC.md` §2.9 (add a "State (per harness)" auth sub-group after the "Static (per harness)" block near line 256) + §2.11 (one-line pointer near line 311).
- Runbook to create: `docs/runbooks/rotating-harness-keys.md` (does not exist yet) with anchors `#hermes-agent`, `#claude-code`, `#codex`.

## Shared types (define once, referenced by every task)

These go in **`client/src/harnesses/auth-source.ts`** (Task 2) and are imported elsewhere. Keep names exactly as written below.

```typescript
/** What a harness declares about WHERE its credential lives. */
export type HarnessAuthSource =
  | {
      sourceKind: 'file';
      /** Display path, may be tilde-abbreviated (e.g. '~/.hermes/.env'). */
      sourcePath: string;
      /** Absolute path used for fs.stat / read. */
      absolutePath: string;
      /** Env-var name of the credential inside the file (e.g. 'OPENROUTER_API_KEY'). */
      envKey: string;
      /** Stable runbook anchor for the deep-link (e.g. 'hermes-agent'). */
      docAnchor: string;
    }
  | {
      sourceKind: 'env';
      /** Env-var name read directly from process.env. */
      envKey: string;
      docAnchor: string;
    }
  | {
      sourceKind: 'session';
      docAnchor: string;
    };

/** Resolved, safe-to-serialize status for one harness. NEVER carries full key bytes. */
export interface HarnessAuthStatusEntry {
  harnessName: string;
  sourceKind: 'file' | 'env' | 'session' | 'none';
  /** Present for 'file'. */
  sourcePath?: string;
  /** Present for 'file' and 'env'. */
  envKey?: string;
  /** Last 4 chars of the credential, or null when masked/absent/short. */
  keySuffix: string | null;
  /** ISO-8601 mtime of the credential file, or null. */
  lastModified: string | null;
  state: 'loaded' | 'missing' | 'unknown';
  /** Runbook anchor; absent only for 'none'. */
  docAnchor?: string;
}

export interface HarnessAuthStatusResponse {
  harnesses: HarnessAuthStatusEntry[];
}
```

**Suffix/state rules (the load-bearing invariant):**
- `loaded` = credential resolved, non-empty, length ≥ 8 → `keySuffix = value.slice(-4)`, `lastModified` populated for file-kind.
- `loaded` but value length < 8 → `keySuffix = null` (mask), state still `loaded`.
- `missing` = file-kind with file absent, OR env/file-kind with env key absent/empty → `keySuffix = null`, `lastModified = null`.
- `unknown` = session-kind, OR `getAuthSource()` threw/timed out → `keySuffix = null`, `lastModified = null`.
- `none` (response only, never from a HarnessAuthSource) = harness omits `getAuthSource` → endpoint emits `{ sourceKind: 'none', keySuffix: null, lastModified: null, state: 'unknown' }` with no `docAnchor`.

---

## Task 1: Add `getAuthSource?` to the Harness interface

**Files:**
- Modify: `client/src/harnesses/types.ts` (interface `Harness`, after `attributionPlugins?` ~line 248)

- [ ] **Step 1: Add the method to the interface**

Add this method declaration inside `interface Harness`, immediately after the `attributionPlugins?(): RuntimePlugin[];` block:

```typescript
  /**
   * Optional self-declaration of WHERE this harness's credential lives, so the
   * operator dashboard can surface auth-source + a masked last-4 suffix + the
   * credential file's mtime + a loaded/missing/unknown badge — never the full
   * key (#564). Harnesses with no credential (e.g. prediction baselines) omit
   * this method; the endpoint reports them as "no auth required".
   *
   * The returned descriptor names the file/env/session; the daemon's shared
   * `resolveHarnessAuthStatus` helper owns the unsafe read (stat + slice(-4) +
   * discard). Implementers MUST NOT read or return the full credential here.
   */
  getAuthSource?(): Promise<import('./auth-source.js').HarnessAuthSource>;
```

- [ ] **Step 2: Typecheck**

Run: `cd client && yarn typecheck`
Expected: an error that `./auth-source.js` has no exported member `HarnessAuthSource` (file does not exist yet). This confirms the reference is wired; Task 2 creates the file. Do **not** commit yet — commit at the end of Task 2 so the tree never has a dangling import.

---

## Task 2: The `auth-source.ts` helper (suffix masking + stat + resolve)

**Files:**
- Create: `client/src/harnesses/auth-source.ts`
- Test: `client/test/harnesses/auth-source.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/harnesses/auth-source.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarnessAuthStatus } from '../../src/harnesses/auth-source.js';
import type { Harness } from '../../src/harnesses/types.js';

function harnessWith(getAuthSource: Harness['getAuthSource']): Harness {
  return {
    name: 'fixture',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    getAuthSource,
  };
}

describe('resolveHarnessAuthStatus', () => {
  it('file-kind with a present long credential → loaded, last-4 suffix, mtime set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'OPENROUTER_API_KEY=sk-or-v1-abc123XYZa3f9\nOTHER=ignored\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.state).toBe('loaded');
      expect(entry.keySuffix).toBe('a3f9');
      expect(entry.sourcePath).toBe('~/.hermes/.env');
      expect(entry.envKey).toBe('OPENROUTER_API_KEY');
      expect(entry.docAnchor).toBe('hermes-agent');
      expect(entry.lastModified).toMatch(/\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file-kind with a short (<8 char) credential → loaded but suffix masked to null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'OPENROUTER_API_KEY=short\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.state).toBe('loaded');
      expect(entry.keySuffix).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file-kind, env key absent in an existing file → missing, null suffix and mtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'SOMETHING_ELSE=value\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.state).toBe('missing');
      expect(entry.keySuffix).toBeNull();
      expect(entry.lastModified).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file-kind, file does not exist → missing', async () => {
    const h = harnessWith(async () => ({
      sourceKind: 'file', sourcePath: '~/.hermes/.env',
      absolutePath: '/nonexistent/path/.env',
      envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
    }));
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.state).toBe('missing');
    expect(entry.keySuffix).toBeNull();
    expect(entry.lastModified).toBeNull();
  });

  it('parses only the named env line, ignoring values that merely contain the key name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authsrc-'));
    const file = join(dir, '.env');
    // A red-herring line whose VALUE mentions the key name must not be picked up.
    writeFileSync(file, 'NOTE=OPENROUTER_API_KEY is set elsewhere\nOPENROUTER_API_KEY=realkey9999\n');
    try {
      const h = harnessWith(async () => ({
        sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: file,
        envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
      }));
      const entry = await resolveHarnessAuthStatus(h);
      expect(entry.keySuffix).toBe('9999');
      expect(entry.state).toBe('loaded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env-kind reads from a supplied env bag → loaded with suffix', async () => {
    const h = harnessWith(async () => ({
      sourceKind: 'env', envKey: 'OPENAI_API_KEY', docAnchor: 'codex',
    }));
    const entry = await resolveHarnessAuthStatus(h, { env: { OPENAI_API_KEY: 'sk-proj-LongEnough1234' } });
    expect(entry.state).toBe('loaded');
    expect(entry.keySuffix).toBe('1234');
    expect(entry.envKey).toBe('OPENAI_API_KEY');
    expect(entry.lastModified).toBeNull();
  });

  it('env-kind with the var absent → missing', async () => {
    const h = harnessWith(async () => ({
      sourceKind: 'env', envKey: 'OPENAI_API_KEY', docAnchor: 'codex',
    }));
    const entry = await resolveHarnessAuthStatus(h, { env: {} });
    expect(entry.state).toBe('missing');
    expect(entry.keySuffix).toBeNull();
  });

  it('session-kind → unknown, no key, no mtime', async () => {
    const h = harnessWith(async () => ({ sourceKind: 'session', docAnchor: 'claude-code' }));
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.state).toBe('unknown');
    expect(entry.sourceKind).toBe('session');
    expect(entry.keySuffix).toBeNull();
    expect(entry.lastModified).toBeNull();
    expect(entry.docAnchor).toBe('claude-code');
  });

  it('harness with no getAuthSource → sourceKind none, state unknown, no docAnchor', async () => {
    const h = harnessWith(undefined);
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.sourceKind).toBe('none');
    expect(entry.state).toBe('unknown');
    expect(entry.keySuffix).toBeNull();
    expect(entry.docAnchor).toBeUndefined();
  });

  it('getAuthSource throwing → unknown (never crashes the iteration)', async () => {
    const h = harnessWith(async () => { throw new Error('boom'); });
    const entry = await resolveHarnessAuthStatus(h);
    expect(entry.state).toBe('unknown');
    expect(entry.sourceKind).toBe('session'); // unknown source collapses to session-shaped
    expect(entry.keySuffix).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/harnesses/auth-source.test.ts`
Expected: FAIL — cannot resolve `../../src/harnesses/auth-source.js`.

- [ ] **Step 3: Write the implementation**

Create `client/src/harnesses/auth-source.ts`:

```typescript
/**
 * Shared resolver for the operator dashboard's "Harness auth status" panel (#564).
 *
 * A harness declares WHERE its credential lives via `getAuthSource()`. This
 * helper owns the unsafe part: stat the file for mtime, read the credential,
 * keep ONLY the last-4 suffix, discard the full value. It NEVER returns full
 * key bytes. See docs/runbooks/rotating-harness-keys.md.
 */
import { stat, readFile } from 'node:fs/promises';
import type { Harness } from './types.js';

export type HarnessAuthSource =
  | {
      sourceKind: 'file';
      sourcePath: string;
      absolutePath: string;
      envKey: string;
      docAnchor: string;
    }
  | {
      sourceKind: 'env';
      envKey: string;
      docAnchor: string;
    }
  | {
      sourceKind: 'session';
      docAnchor: string;
    };

export interface HarnessAuthStatusEntry {
  harnessName: string;
  sourceKind: 'file' | 'env' | 'session' | 'none';
  sourcePath?: string;
  envKey?: string;
  keySuffix: string | null;
  lastModified: string | null;
  state: 'loaded' | 'missing' | 'unknown';
  docAnchor?: string;
}

export interface HarnessAuthStatusResponse {
  harnesses: HarnessAuthStatusEntry[];
}

const MIN_SUFFIX_LEN = 8;

/** Last-4 suffix, or null when the value is too short / empty to safely show. */
function safeSuffix(value: string): string | null {
  if (value.length < MIN_SUFFIX_LEN) return null;
  return value.slice(-4);
}

/**
 * Extract the value of a single `KEY=value` line from a dotenv-style file body.
 * Matches the named key at the start of a line only — a value that merely
 * mentions the key name elsewhere is ignored. Strips surrounding quotes.
 */
function readEnvValueFromFile(body: string, envKey: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith(`${envKey}=`)) continue;
    let value = line.slice(envKey.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

export interface ResolveOptions {
  /** Env bag for env-kind sources. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve one harness's safe auth status. Iteration-safe: any error collapses
 * to a session-shaped `unknown` entry rather than throwing.
 */
export async function resolveHarnessAuthStatus(
  harness: Harness,
  opts: ResolveOptions = {},
): Promise<HarnessAuthStatusEntry> {
  if (!harness.getAuthSource) {
    return {
      harnessName: harness.name,
      sourceKind: 'none',
      keySuffix: null,
      lastModified: null,
      state: 'unknown',
    };
  }

  let source: HarnessAuthSource;
  try {
    source = await harness.getAuthSource();
  } catch {
    return {
      harnessName: harness.name,
      sourceKind: 'session',
      keySuffix: null,
      lastModified: null,
      state: 'unknown',
    };
  }

  if (source.sourceKind === 'session') {
    return {
      harnessName: harness.name,
      sourceKind: 'session',
      keySuffix: null,
      lastModified: null,
      state: 'unknown',
      docAnchor: source.docAnchor,
    };
  }

  if (source.sourceKind === 'env') {
    const env = opts.env ?? process.env;
    const value = env[source.envKey]?.trim() ?? '';
    return {
      harnessName: harness.name,
      sourceKind: 'env',
      envKey: source.envKey,
      keySuffix: value.length > 0 ? safeSuffix(value) : null,
      lastModified: null,
      state: value.length > 0 ? 'loaded' : 'missing',
      docAnchor: source.docAnchor,
    };
  }

  // file-kind
  let mtime: string | null = null;
  let body: string;
  try {
    const st = await stat(source.absolutePath);
    mtime = st.mtime.toISOString();
    body = await readFile(source.absolutePath, 'utf8');
  } catch {
    return {
      harnessName: harness.name,
      sourceKind: 'file',
      sourcePath: source.sourcePath,
      envKey: source.envKey,
      keySuffix: null,
      lastModified: null,
      state: 'missing',
      docAnchor: source.docAnchor,
    };
  }

  const value = readEnvValueFromFile(body, source.envKey)?.trim() ?? '';
  if (value.length === 0) {
    return {
      harnessName: harness.name,
      sourceKind: 'file',
      sourcePath: source.sourcePath,
      envKey: source.envKey,
      keySuffix: null,
      lastModified: null,
      state: 'missing',
      docAnchor: source.docAnchor,
    };
  }

  return {
    harnessName: harness.name,
    sourceKind: 'file',
    sourcePath: source.sourcePath,
    envKey: source.envKey,
    keySuffix: safeSuffix(value),
    lastModified: mtime,
    state: 'loaded',
    docAnchor: source.docAnchor,
  };
}
```

Note on the "missing → null mtime" rule: the tests require `lastModified: null` when the env key is absent even though the file exists (per the spec: `missing` means no usable credential). The implementation above sets `lastModified` only on the `loaded` path, which satisfies both the "file absent" and "key absent" cases.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/harnesses/auth-source.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck (Task 1 import now resolves)**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/types.ts client/src/harnesses/auth-source.ts client/test/harnesses/auth-source.test.ts
git commit -m "feat(harness): add getAuthSource + safe auth-source resolver (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Implement `getAuthSource` on the three credentialed harnesses

**Files:**
- Modify: `client/src/harnesses/impls/hermes-agent/harness.ts` (class `HermesHarness`)
- Modify: `client/src/harnesses/impls/learner/harness.ts` (class `LearnerHarness`)
- Test: `client/test/harnesses/get-auth-source.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/harnesses/get-auth-source.test.ts`. This tests the *descriptor* each harness returns (paths/kinds), not the file read (the file read is Task 2's helper):

```typescript
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('harness getAuthSource descriptors (#564)', () => {
  it('HermesHarness declares its ~/.hermes/.env OPENROUTER_API_KEY file source', async () => {
    const { HermesHarness } = await import('../../src/harnesses/impls/hermes-agent/harness.js');
    // Minimal adapter stub; HermesHarness only needs `adapter` to construct.
    const harness = new HermesHarness({
      adapter: { name: 'hermes-agent', runTask: async () => {} } as never,
    });
    const src = await harness.getAuthSource!();
    expect(src.sourceKind).toBe('file');
    if (src.sourceKind !== 'file') throw new Error('unreachable');
    expect(src.envKey).toBe('OPENROUTER_API_KEY');
    expect(src.docAnchor).toBe('hermes-agent');
    expect(src.absolutePath).toBe(join(homedir(), '.hermes', '.env'));
    expect(src.sourcePath).toMatch(/\.hermes\/\.env$/);
  });

  it('HermesHarness honours HERMES_HOME for the .env path', async () => {
    const prev = process.env['HERMES_HOME'];
    process.env['HERMES_HOME'] = '/tmp/custom-hermes';
    try {
      const { HermesHarness } = await import('../../src/harnesses/impls/hermes-agent/harness.js');
      const harness = new HermesHarness({
        adapter: { name: 'hermes-agent', runTask: async () => {} } as never,
      });
      const src = await harness.getAuthSource!();
      if (src.sourceKind !== 'file') throw new Error('unreachable');
      expect(src.absolutePath).toBe('/tmp/custom-hermes/.env');
    } finally {
      if (prev === undefined) delete process.env['HERMES_HOME'];
      else process.env['HERMES_HOME'] = prev;
    }
  });

  it('LearnerHarness(claude-code) declares a session source', async () => {
    const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
    const harness = new LearnerHarness({
      name: 'claude-code',
      adapter: { name: 'claude-code', runTask: async () => {} } as never,
    });
    const src = await harness.getAuthSource!();
    expect(src.sourceKind).toBe('session');
    expect(src.docAnchor).toBe('claude-code');
  });

  it('LearnerHarness(codex) declares the ~/.codex/auth.json file source', async () => {
    const prevHome = process.env['CODEX_HOME'];
    const prevKey = process.env['OPENAI_API_KEY'];
    delete process.env['CODEX_HOME'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
      const harness = new LearnerHarness({
        name: 'codex',
        adapter: { name: 'codex', runTask: async () => {} } as never,
      });
      const src = await harness.getAuthSource!();
      expect(src.sourceKind).toBe('file');
      if (src.sourceKind !== 'file') throw new Error('unreachable');
      expect(src.docAnchor).toBe('codex');
      expect(src.absolutePath).toBe(join(homedir(), '.codex', 'auth.json'));
    } finally {
      if (prevHome === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = prevHome;
      if (prevKey === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = prevKey;
    }
  });

  it('LearnerHarness(codex) prefers OPENAI_API_KEY env when set', async () => {
    const prevKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-proj-fixture';
    try {
      const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
      const harness = new LearnerHarness({
        name: 'codex',
        adapter: { name: 'codex', runTask: async () => {} } as never,
      });
      const src = await harness.getAuthSource!();
      expect(src.sourceKind).toBe('env');
      if (src.sourceKind !== 'env') throw new Error('unreachable');
      expect(src.envKey).toBe('OPENAI_API_KEY');
      expect(src.docAnchor).toBe('codex');
    } finally {
      if (prevKey === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = prevKey;
    }
  });
});
```

NOTE: if `HermesHarness`/`LearnerHarness` constructors require more than `adapter`/`name` (check the actual config type before running), pass the minimal additional required fields. The construction shape above mirrors how `client/test/api/harness-readiness-endpoint.test.ts` and existing harness tests build instances — verify against the real `HermesHarnessConfig` / learner config types and adjust the stub, not the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/harnesses/get-auth-source.test.ts`
Expected: FAIL — `harness.getAuthSource` is `undefined` (method not implemented).

- [ ] **Step 3a: Implement on HermesHarness**

In `client/src/harnesses/impls/hermes-agent/harness.ts`, add imports at the top if not present:

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAuthSource } from '../../auth-source.js';
```

Add this method to the `HermesHarness` class (e.g. right after `isReady`):

```typescript
  /**
   * #564 — declare the operator's Hermes credential location: the
   * `OPENROUTER_API_KEY` line in `$HERMES_HOME/.env` (default `~/.hermes/.env`).
   * The daemon's resolver reads only the last-4 suffix; this method never reads
   * the key itself.
   */
  async getAuthSource(): Promise<HarnessAuthSource> {
    const home = process.env['HERMES_HOME']?.trim() || join(homedir(), '.hermes');
    const absolutePath = join(home, '.env');
    // Tilde-abbreviate the display path when it's under the real home dir.
    const sourcePath = absolutePath.startsWith(homedir())
      ? absolutePath.replace(homedir(), '~')
      : absolutePath;
    return {
      sourceKind: 'file',
      sourcePath,
      absolutePath,
      envKey: 'OPENROUTER_API_KEY',
      docAnchor: 'hermes-agent',
    };
  }
```

- [ ] **Step 3b: Implement on LearnerHarness (claude-code → session, codex → env/file)**

In `client/src/harnesses/impls/learner/harness.ts`, add imports if not present:

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAuthSource } from '../../auth-source.js';
```

`canonicalHarnessName`, `CLAUDE_CODE_HARNESS`, `CODEX_HARNESS` are already imported (line 11). Add this method to the `LearnerHarness` class:

```typescript
  /**
   * #564 — auth source depends on the backing CLI:
   *   - claude-code → session auth (`claude auth status`), no stat-able file.
   *   - codex       → `OPENAI_API_KEY` env if set, else `auth.json` at
   *                   `CODEX_HOME` or `~/.codex/auth.json`.
   * The daemon's resolver reads only a masked suffix; codex `auth.json` is JSON
   * (no plain key field), so the resolver will report `loaded` from file
   * existence but mask the suffix to null — the operator still sees the path,
   * mtime, and state.
   */
  async getAuthSource(): Promise<HarnessAuthSource> {
    if (canonicalHarnessName(this.name) === CODEX_HARNESS) {
      if ((process.env['OPENAI_API_KEY']?.trim() ?? '').length > 0) {
        return { sourceKind: 'env', envKey: 'OPENAI_API_KEY', docAnchor: 'codex' };
      }
      const codexHome = process.env['CODEX_HOME']?.trim();
      const absolutePath = codexHome
        ? join(codexHome, 'auth.json')
        : join(homedir(), '.codex', 'auth.json');
      const sourcePath = absolutePath.startsWith(homedir())
        ? absolutePath.replace(homedir(), '~')
        : absolutePath;
      return {
        sourceKind: 'file',
        sourcePath,
        absolutePath,
        // auth.json has no flat KEY= line; resolver masks the suffix to null
        // but still reports path/mtime/state from file existence.
        envKey: 'OPENAI_API_KEY',
        docAnchor: 'codex',
      };
    }
    // claude-code (default)
    return { sourceKind: 'session', docAnchor: 'claude-code' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/harnesses/get-auth-source.test.ts`
Expected: PASS. If a constructor-shape mismatch surfaces, fix the test stub per the NOTE in Step 1, not the assertions.

- [ ] **Step 5: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/harness.ts client/src/harnesses/impls/learner/harness.ts client/test/harnesses/get-auth-source.test.ts
git commit -m "feat(harness): declare getAuthSource on hermes/codex/claude-code (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Registry accessor for harness instances

**Files:**
- Modify: `client/src/harnesses/readiness-registry.ts` (class `HarnessReadinessRegistry`)
- Test: `client/test/harnesses/readiness-registry.test.ts` (append one case)

- [ ] **Step 1: Write the failing test**

Append to `client/test/harnesses/readiness-registry.test.ts` (inside the existing top-level `describe`, or add a new `describe`):

```typescript
import { HarnessReadinessRegistry as _Reg } from '../../src/harnesses/readiness-registry.js';

describe('HarnessReadinessRegistry.getHarnesses (#564)', () => {
  it('returns the by-name harness instance map seeded at construction', () => {
    const h = {
      name: 'hermes-agent', version: '0.0.0',
      supports: () => true, run: async () => { throw new Error('x'); },
    };
    const reg = new _Reg({
      harnessesByName: { 'hermes-agent': h as never },
      joinedHarnessesByCid: {},
    });
    const map = reg.getHarnesses();
    expect(Object.keys(map)).toEqual(['hermes-agent']);
    expect(map['hermes-agent']).toBe(h);
  });
});
```

(If the file already imports `HarnessReadinessRegistry`, reuse that import instead of the aliased one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/harnesses/readiness-registry.test.ts`
Expected: FAIL — `reg.getHarnesses is not a function`.

- [ ] **Step 3: Implement the accessor**

In `client/src/harnesses/readiness-registry.ts`, add this method to the class (e.g. right after `getJoinedHarnessesByCid`):

```typescript
  /**
   * The by-name harness instance map seeded at construction. Exposed so the
   * `/v1/harnesses/auth-status` endpoint (#564) can call each harness's
   * `getAuthSource()` without re-deriving the harness set.
   */
  getHarnesses(): Record<string, Harness> {
    return this.opts.harnessesByName;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/harnesses/readiness-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/readiness-registry.ts client/test/harnesses/readiness-registry.test.ts
git commit -m "feat(harness): expose getHarnesses() accessor on readiness registry (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The `GET /v1/harnesses/auth-status` endpoint

**Files:**
- Create: `client/src/api/harness-auth-status-endpoint.ts`
- Test: `client/test/api/harness-auth-status-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/api/harness-auth-status-endpoint.test.ts`:

```typescript
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addHarnessAuthStatusRoutes } from '../../src/api/harness-auth-status-endpoint.js';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import type { Harness } from '../../src/harnesses/types.js';
import type { HarnessAuthSource } from '../../src/harnesses/auth-source.js';

function harness(name: string, getAuthSource?: () => Promise<HarnessAuthSource>): Harness {
  return {
    name, version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    ...(getAuthSource ? { getAuthSource } : {}),
  };
}

describe('harness-auth-status-endpoint (#564)', () => {
  it('GET /v1/harnesses/auth-status iterates every registered harness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authep-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'OPENROUTER_API_KEY=sk-or-v1-longenough-a3f9\n');
    try {
      const reg = new HarnessReadinessRegistry({
        harnessesByName: {
          'hermes-agent': harness('hermes-agent', async () => ({
            sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: envFile,
            envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
          })),
          'claude-code': harness('claude-code', async () => ({
            sourceKind: 'session', docAnchor: 'claude-code',
          })),
          'prediction-v1-baseline': harness('prediction-v1-baseline'), // no getAuthSource
        },
        joinedHarnessesByCid: {},
      });
      const app = new Hono();
      addHarnessAuthStatusRoutes(app, { registry: reg });

      const res = await app.request('/v1/harnesses/auth-status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.harnesses).toHaveLength(3);

      const hermes = body.harnesses.find((h: { harnessName: string }) => h.harnessName === 'hermes-agent');
      expect(hermes.state).toBe('loaded');
      expect(hermes.keySuffix).toBe('a3f9');
      expect(hermes.sourcePath).toBe('~/.hermes/.env');

      const claude = body.harnesses.find((h: { harnessName: string }) => h.harnessName === 'claude-code');
      expect(claude.state).toBe('unknown');
      expect(claude.sourceKind).toBe('session');

      const pred = body.harnesses.find((h: { harnessName: string }) => h.harnessName === 'prediction-v1-baseline');
      expect(pred.sourceKind).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEVER returns full key bytes — only the last-4 suffix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authep-'));
    const envFile = join(dir, '.env');
    const fullKey = 'sk-or-v1-SUPERSECRETFULLKEYVALUE-tail';
    writeFileSync(envFile, `OPENROUTER_API_KEY=${fullKey}\n`);
    try {
      const reg = new HarnessReadinessRegistry({
        harnessesByName: {
          'hermes-agent': harness('hermes-agent', async () => ({
            sourceKind: 'file', sourcePath: '~/.hermes/.env', absolutePath: envFile,
            envKey: 'OPENROUTER_API_KEY', docAnchor: 'hermes-agent',
          })),
        },
        joinedHarnessesByCid: {},
      });
      const app = new Hono();
      addHarnessAuthStatusRoutes(app, { registry: reg });
      const res = await app.request('/v1/harnesses/auth-status');
      const raw = await res.text();
      expect(raw).not.toContain(fullKey);
      expect(raw).not.toContain('SUPERSECRETFULLKEYVALUE');
      expect(raw).toContain('tail'); // the last-4 suffix is allowed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 503 when the registry holder is not yet populated', async () => {
    const app = new Hono();
    addHarnessAuthStatusRoutes(app, { getRegistry: () => null });
    const res = await app.request('/v1/harnesses/auth-status');
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/api/harness-auth-status-endpoint.test.ts`
Expected: FAIL — cannot resolve `../../src/api/harness-auth-status-endpoint.js`.

- [ ] **Step 3: Write the implementation**

Create `client/src/api/harness-auth-status-endpoint.ts` (mirror `harness-readiness-endpoint.ts` exactly, including the holder/lazy union):

```typescript
/**
 * GET /v1/harnesses/auth-status — per-harness credential source + masked
 * last-4 suffix + file mtime + loaded/missing/unknown state (#564).
 *
 * NEVER returns full key bytes — only the suffix and metadata. Reads from the
 * HarnessReadinessRegistry's harness instance map; each harness's
 * `getAuthSource()` declares WHERE its credential lives and the shared
 * `resolveHarnessAuthStatus` helper owns the safe read.
 *
 * Mounts with the same `{ registry }` / `{ getRegistry }` union as the
 * readiness endpoint so the HTTP server can register the route eagerly and
 * dereference the post-bootstrap holder per request.
 */
import type { Hono } from 'hono';
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';
import {
  resolveHarnessAuthStatus,
  type HarnessAuthStatusResponse,
} from '../harnesses/auth-source.js';

export type HarnessAuthStatusRoutesConfig =
  | { registry: HarnessReadinessRegistry }
  | { getRegistry: () => HarnessReadinessRegistry | null };

export function addHarnessAuthStatusRoutes(
  app: Hono,
  config: HarnessAuthStatusRoutesConfig,
): void {
  const getRegistry: () => HarnessReadinessRegistry | null =
    'getRegistry' in config ? config.getRegistry : () => config.registry;

  app.get('/v1/harnesses/auth-status', async (c) => {
    const reg = getRegistry();
    if (!reg) {
      return c.json(
        { error: 'subsystem_not_ready', message: 'Harness registry still initialising' },
        503,
      );
    }
    const harnesses = reg.getHarnesses();
    const entries = await Promise.all(
      Object.values(harnesses).map((h) => resolveHarnessAuthStatus(h)),
    );
    // Stable order by harness name for deterministic rendering.
    entries.sort((a, b) => a.harnessName.localeCompare(b.harnessName));
    const body: HarnessAuthStatusResponse = { harnesses: entries };
    return c.json(body);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/api/harness-auth-status-endpoint.test.ts`
Expected: PASS (all three cases, including the never-full-key invariant).

- [ ] **Step 5: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/harness-auth-status-endpoint.ts client/test/api/harness-auth-status-endpoint.test.ts
git commit -m "feat(api): GET /v1/harnesses/auth-status (masked suffix only) (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire the endpoint into the HTTP server

**Files:**
- Modify: `client/src/api/server.ts` (import + mount near the readiness block, lines 46-47 and 586-598)
- Test: `client/test/main/harness-readiness-wiring.test.ts` (extend, OR add `client/test/api/harness-auth-status-wiring.test.ts` if the former is integration-shaped)

- [ ] **Step 1: Inspect the wiring test to choose the right place**

Read `client/test/main/harness-readiness-wiring.test.ts`. If it constructs a server with `harnessReadinessRegistry` and asserts the readiness route responds, add a parallel assertion for `/v1/harnesses/auth-status`. If it's not amenable, create a small new test instead (Step 2b).

- [ ] **Step 2a: Add the import**

In `client/src/api/server.ts`, next to line 46 (`import { addHarnessReadinessRoutes } ...`):

```typescript
import { addHarnessAuthStatusRoutes } from './harness-auth-status-endpoint.js';
```

- [ ] **Step 2b: Mount alongside readiness (reusing the same registry value)**

In `client/src/api/server.ts`, in the `if (config.harnessReadinessRegistry) { ... }` block (lines 586-598), add the auth-status routes right after the readiness routes, reusing the same `reg`:

```typescript
  if (config.harnessReadinessRegistry) {
    const reg = config.harnessReadinessRegistry;
    if ('holder' in reg) {
      addHarnessReadinessRoutes(app, {
        getRegistry: () => reg.holder.current ?? null,
      });
      addHarnessAuthStatusRoutes(app, {
        getRegistry: () => reg.holder.current ?? null,
      });
    } else {
      addHarnessReadinessRoutes(app, { registry: reg });
      addHarnessAuthStatusRoutes(app, { registry: reg });
    }
  }
```

The route is already under the `app.use('/v1/harnesses/*', requireUiToken(config.ui.token))` gate at line 503 — no new gate needed.

- [ ] **Step 3: Write/extend the wiring test**

Add to the chosen test file a case that builds the server (or a Hono app via the same path) with a registry containing one credentialed harness and asserts `GET /v1/harnesses/auth-status` returns 200 with a `harnesses` array. Mirror the existing readiness-wiring assertions. Example shape (adapt to the file's existing harness factory):

```typescript
it('mounts /v1/harnesses/auth-status when a registry is provided', async () => {
  // ...build app/server with harnessReadinessRegistry exactly as the
  // readiness assertion in this file does, then:
  const res = await app.request('/v1/harnesses/auth-status');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.harnesses)).toBe(true);
});
```

- [ ] **Step 4: Run the wiring test + typecheck**

Run: `cd client && yarn vitest run test/main/harness-readiness-wiring.test.ts && yarn typecheck`
Expected: PASS, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/server.ts client/test/main/harness-readiness-wiring.test.ts
git commit -m "feat(api): mount /v1/harnesses/auth-status in the HTTP server (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: SPA — types + `api.harnessAuthStatus()` client method

**Files:**
- Modify: `client/src/dashboard/spa/src/api/types.ts` (add response types near `HarnessReadinessEntry`, ~line 967)
- Modify: `client/src/dashboard/spa/src/api/client.ts` (add method near `harnessReadiness`, ~line 257)

- [ ] **Step 1: Add the SPA-side types**

In `client/src/dashboard/spa/src/api/types.ts`, after the `HarnessReadinessEntry`/`HarnessReadinessNextStep` block:

```typescript
// ── Harness auth status (`/v1/harnesses/auth-status`) — #564 ─────────────────
export type HarnessAuthSourceKind = 'file' | 'env' | 'session' | 'none';
export type HarnessAuthState = 'loaded' | 'missing' | 'unknown';

export interface HarnessAuthStatusEntry {
  harnessName: string;
  sourceKind: HarnessAuthSourceKind;
  sourcePath?: string;
  envKey?: string;
  keySuffix: string | null;
  lastModified: string | null;
  state: HarnessAuthState;
  docAnchor?: string;
}

export interface HarnessAuthStatusResponse {
  harnesses: HarnessAuthStatusEntry[];
}
```

- [ ] **Step 2: Add the client method**

In `client/src/dashboard/spa/src/api/client.ts`, add `HarnessAuthStatusResponse` to the type import block (lines 1-37), then add this method right after `harnessReadiness` (line 257-260):

```typescript
  /**
   * Per-harness auth-source status (#564) — auth source path, masked last-4
   * key suffix, credential mtime, and a loaded/missing/unknown badge. The
   * endpoint NEVER returns full key bytes.
   */
  harnessAuthStatus: () =>
    jfetch<HarnessAuthStatusResponse>('/v1/harnesses/auth-status'),
```

- [ ] **Step 3: Typecheck the SPA**

Run: `cd client && yarn typecheck`
Expected: zero errors. (No standalone unit test for the one-line passthrough; it is covered by the component test in Task 8 which mocks `api.harnessAuthStatus`.)

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/api/types.ts client/src/dashboard/spa/src/api/client.ts
git commit -m "feat(spa): add harnessAuthStatus api client method + types (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: SPA — "Harness auth status" read-only panel

**Files:**
- Create: `client/src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.tsx`
- Test: `client/src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.test.tsx`
- Modify: `client/src/dashboard/spa/src/pages/operator/SecurityTab.tsx` (render the card)
- Modify: `client/src/dashboard/spa/src/pages/operator/SecurityTab.test.tsx` (mock the new api method so existing tests still mount)

- [ ] **Step 1: Write the failing component test**

Create `client/src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HarnessAuthStatusCard } from './HarnessAuthStatusCard.js';

const harnessAuthStatus = vi.fn();
vi.mock('../../api/client.js', () => ({
  api: { harnessAuthStatus: () => harnessAuthStatus() },
}));

beforeEach(() => {
  harnessAuthStatus.mockReset();
});

describe('HarnessAuthStatusCard (#564)', () => {
  it('renders one row per harness with name, source path, suffix, mtime and state badge', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [
        {
          harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
          envKey: 'OPENROUTER_API_KEY', keySuffix: 'a3f9',
          lastModified: '2026-06-14T09:12:00.000Z', state: 'loaded', docAnchor: 'hermes-agent',
        },
        {
          harnessName: 'claude-code', sourceKind: 'session',
          keySuffix: null, lastModified: null, state: 'unknown', docAnchor: 'claude-code',
        },
      ],
    });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText('hermes-agent')).toBeTruthy());
    expect(screen.getByText('~/.hermes/.env')).toBeTruthy();
    expect(screen.getByText(/a3f9/)).toBeTruthy();
    expect(screen.getByText('claude-code')).toBeTruthy();
    // state badges
    expect(screen.getByText(/loaded/i)).toBeTruthy();
    expect(screen.getByText(/unknown/i)).toBeTruthy();
  });

  it('each harness row links to the rotating-harness-keys doc anchor', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [{
        harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
        envKey: 'OPENROUTER_API_KEY', keySuffix: 'a3f9',
        lastModified: '2026-06-14T09:12:00.000Z', state: 'loaded', docAnchor: 'hermes-agent',
      }],
    });
    render(<HarnessAuthStatusCard />);
    const link = await screen.findByRole('link', { name: /hermes-agent/i });
    expect(link.getAttribute('href')).toContain('rotating-harness-keys');
    expect(link.getAttribute('href')).toContain('#hermes-agent');
  });

  it('renders a friendly empty state when the endpoint returns no harnesses', async () => {
    harnessAuthStatus.mockResolvedValue({ harnesses: [] });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText(/no harnesses/i)).toBeTruthy());
  });

  it('shows missing credentials as a "missing" badge with an em-dash suffix', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [{
        harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
        envKey: 'OPENROUTER_API_KEY', keySuffix: null, lastModified: null,
        state: 'missing', docAnchor: 'hermes-agent',
      }],
    });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText(/missing/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.test.tsx`
Expected: FAIL — cannot resolve `./HarnessAuthStatusCard.js`.

- [ ] **Step 3: Implement the card (compose shadcn Card + Table + Badge)**

Create `client/src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.tsx`. Verify the exact export names of `table.tsx`/`badge.tsx`/`card.tsx` before writing (they follow shadcn defaults: `Table, TableHeader, TableBody, TableRow, TableHead, TableCell`; `Badge`; `Card, CardHeader, CardTitle, CardDescription, CardContent`).

```tsx
import { useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client.js';
import type { HarnessAuthStatusEntry } from '../../api/types.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table.js';

const POLL_MS = 8000;
const DOC_BASE = 'https://github.com/Jinn-Network/mono/blob/main/docs/runbooks/rotating-harness-keys.md';

function stateBadgeVariant(state: HarnessAuthStatusEntry['state']): 'default' | 'secondary' | 'destructive' {
  if (state === 'loaded') return 'default';
  if (state === 'missing') return 'destructive';
  return 'secondary'; // unknown
}

function formatMtime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function sourceLabel(entry: HarnessAuthStatusEntry): string {
  if (entry.sourceKind === 'file') return entry.sourcePath ?? '—';
  if (entry.sourceKind === 'env') return `env: ${entry.envKey ?? ''}`;
  if (entry.sourceKind === 'session') return 'CLI session';
  return 'no auth required';
}

export function HarnessAuthStatusCard(): JSX.Element {
  const [harnesses, setHarnesses] = useState<HarnessAuthStatusEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await api.harnessAuthStatus();
        if (!cancelled) { setHarnesses(res.harnesses); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <Card data-testid="harness-auth-status-card">
      <CardHeader>
        <CardTitle>Harness auth status</CardTitle>
        <CardDescription>
          Where each harness reads its credential, the masked key suffix, and when it last changed.
          Read-only — rotate keys via the linked runbook. Full keys are never shown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-[var(--break-red)]">Auth status unavailable: {error}</p>
        ) : harnesses === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : harnesses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No harnesses registered.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Harness</TableHead>
                <TableHead>Auth source</TableHead>
                <TableHead>Key suffix</TableHead>
                <TableHead>Last modified</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {harnesses.map((h) => (
                <TableRow key={h.harnessName}>
                  <TableCell>
                    {h.docAnchor ? (
                      <a
                        href={`${DOC_BASE}#${h.docAnchor}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        {h.harnessName}
                      </a>
                    ) : (
                      <span>{h.harnessName}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{sourceLabel(h)}</TableCell>
                  <TableCell className="font-mono text-xs">{h.keySuffix ? `…${h.keySuffix}` : '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{formatMtime(h.lastModified)}</TableCell>
                  <TableCell>
                    <Badge variant={stateBadgeVariant(h.state)}>{h.state}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run the component test**

Run: `cd client && yarn vitest run src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.test.tsx`
Expected: PASS. If a shadcn export name differs, fix the import (verify the actual exports in `components/ui/table.tsx` / `badge.tsx`), not the test.

- [ ] **Step 5: Render the card in SecurityTab + keep its test green**

In `client/src/dashboard/spa/src/pages/operator/SecurityTab.tsx`, import the card and render it below the existing Security `Card`:

```tsx
import { HarnessAuthStatusCard } from './HarnessAuthStatusCard.js';
```

Inside the `return`, change the wrapper to stack both cards:

```tsx
  return (
    <div data-testid="security-tab" className="flex flex-col gap-6">
      <Card className="border-[var(--severity-blocking-border)]">
        {/* ...existing password-rotation card unchanged... */}
      </Card>
      <HarnessAuthStatusCard />
    </div>
  );
```

(Keep the existing password card body exactly as-is; only the outer `<div>` className changes and the new card is appended.)

In `client/src/dashboard/spa/src/pages/operator/SecurityTab.test.tsx`, extend the `api` mock so the new card's `useEffect` call resolves (otherwise the existing tests log an unhandled rejection):

```typescript
vi.mock('../../api/client.js', () => ({
  api: {
    changeKeystorePassword: vi.fn(),
    harnessAuthStatus: vi.fn().mockResolvedValue({ harnesses: [] }),
  },
}));
```

- [ ] **Step 6: Run the SecurityTab + card tests + typecheck**

Run: `cd client && yarn vitest run src/dashboard/spa/src/pages/operator/SecurityTab.test.tsx src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.test.tsx && yarn typecheck`
Expected: PASS, zero type errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.tsx \
        client/src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.test.tsx \
        client/src/dashboard/spa/src/pages/operator/SecurityTab.tsx \
        client/src/dashboard/spa/src/pages/operator/SecurityTab.test.tsx
git commit -m "feat(spa): read-only Harness auth status panel in Settings/Security (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: The `rotating-harness-keys` runbook (prerequisite for the deep-links)

**Files:**
- Create: `docs/runbooks/rotating-harness-keys.md`

- [ ] **Step 1: Write the runbook with stable per-harness anchors**

Create `docs/runbooks/rotating-harness-keys.md`. The H2 headings MUST produce the anchors `#hermes-agent`, `#claude-code`, `#codex` (GitHub slugifies `## hermes-agent` → `#hermes-agent`). No emoji (BRAND.md non-negotiable). Use plain speech on credentials/safety.

```markdown
# Rotating harness keys

How to rotate the credential each harness uses. The operator dashboard's
**Settings → Security → Harness auth status** panel shows, per harness, where
the credential lives, the masked last-4 suffix, when the file last changed, and
a `loaded` / `missing` / `unknown` state. It never shows the full key. After
rotating, the daemon picks up file-based credentials on its next read; restart
`jinn run` if a harness still shows the old suffix.

## hermes-agent

- **Source:** the `OPENROUTER_API_KEY` line in `$HERMES_HOME/.env`
  (default `~/.hermes/.env`).
- **Rotate:**
  1. Create a new key at https://openrouter.ai/keys and revoke the old one.
  2. Edit `~/.hermes/.env` and set `OPENROUTER_API_KEY=<new-key>`.
  3. Confirm the panel shows the new last-4 suffix and an updated "last
     modified" time.
- **State meaning:** `loaded` = the file exists and the key line is present and
  non-empty. `missing` = the file or the key line is absent.

## claude-code

- **Source:** a CLI session, not a file. Auth is managed by the Claude CLI
  (`claude auth status` / `claude login`); there is no key file to read, so the
  panel shows state `unknown` and no suffix by design.
- **Rotate / re-auth:**
  1. Run `claude logout` then `claude login`, or re-run `claude setup-token`.
  2. Verify with `claude auth status`.
- **State meaning:** always `unknown` — session auth is not file-inspectable.
  Use the Claude precheck in onboarding to confirm the session is live.

## codex

- **Source:** `OPENAI_API_KEY` if set in the environment; otherwise the
  `auth.json` written by `codex login`, at `$CODEX_HOME/auth.json`
  (default `~/.codex/auth.json`).
- **Rotate:**
  - **API key:** set a new `OPENAI_API_KEY` in the daemon's environment and
    restart `jinn run`. The panel shows the new last-4 suffix.
  - **OAuth session:** run `codex login` to refresh `auth.json`. The panel
    reports the file's path and last-modified time; because `auth.json` is JSON
    (no flat key line), the suffix is shown as `—` while state is `loaded` from
    file existence.
- **State meaning:** `loaded` = the env key is set, or `auth.json` exists.
  `missing` = neither is present.
```

- [ ] **Step 2: Verify the anchors match the SPA's `docAnchor` values**

Confirm the H2 slugs (`hermes-agent`, `claude-code`, `codex`) exactly match the `docAnchor` strings returned by `getAuthSource` in Task 3.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/rotating-harness-keys.md
git commit -m "docs(runbook): rotating-harness-keys with per-harness anchors (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: OPERATOR-APP-SPEC domain-model update (required, same PR)

**Files:**
- Modify: `client/OPERATOR-APP-SPEC.md` (§2.9 add a "State (per harness)" auth sub-group after the "Static (per harness)" block ~line 256-265; §2.11 add a one-line pointer ~line 311)

- [ ] **Step 1: Add the auth State sub-group to §2.9**

In `client/OPERATOR-APP-SPEC.md`, immediately after the `- **Static (per harness)**` bullet block (which ends with the `role` line ~line 263, before `- **Actions (per harness)**`), insert:

```markdown
- **State (per harness, auth source — read-only) (#564)**
  - auth source — the credential location: a file path (e.g. `~/.hermes/.env`), an env var, a CLI session, or "no auth required"
  - key suffix — last 4 chars of the credential, masked to `—` when absent or shorter than 8 chars; the full key is never shown
  - last modified — mtime of the credential file (`—` for session/env sources)
  - auth state — `loaded` (credential present & non-empty), `missing` (file/key absent), or `unknown` (CLI-session auth, e.g. claude-code, or probe error)
  - Rendered in §2.11 Settings → Security as a read-only table; each row deep-links to `docs/runbooks/rotating-harness-keys.md`. Data source: `GET /v1/harnesses/auth-status` (suffix + metadata only).
```

- [ ] **Step 2: Add the §2.11 Settings pointer**

In §2.11 Settings, near the "Harness Selection home" paragraph (~line 311), add one line:

```markdown
**Harness auth status (#564).** Settings → Security also hosts a read-only **Harness auth status** table — per-harness auth source, masked key suffix, credential mtime, and a `loaded`/`missing`/`unknown` state — sourced from `GET /v1/harnesses/auth-status` (suffix + metadata only, never full keys). See §2.9's "State (per harness, auth source)" sub-group and `docs/runbooks/rotating-harness-keys.md`.
```

- [ ] **Step 3: Commit**

```bash
git add client/OPERATOR-APP-SPEC.md
git commit -m "docs(spec): operator-app §2.9/§2.11 harness auth-status model (#564)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Full verification + build

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole client**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Run the focused new tests together**

Run:
```bash
cd client && yarn vitest run \
  test/harnesses/auth-source.test.ts \
  test/harnesses/get-auth-source.test.ts \
  test/harnesses/readiness-registry.test.ts \
  test/api/harness-auth-status-endpoint.test.ts \
  test/main/harness-readiness-wiring.test.ts \
  src/dashboard/spa/src/pages/operator/HarnessAuthStatusCard.test.tsx \
  src/dashboard/spa/src/pages/operator/SecurityTab.test.tsx
```
Expected: all PASS.

- [ ] **Step 3: Run the full suite**

Run: `cd client && yarn test`
Expected: all PASS (no regressions in adjacent harness/api/SPA tests).

- [ ] **Step 4: Build (bundles the SPA into dist)**

Run: `cd client && yarn build`
Expected: tsc compile + SPA bundle succeed with no errors. This is the step that proves the SPA card compiles into the shipped dashboard.

- [ ] **Step 5: Final sanity — confirm no full-key leak path**

Run: `cd client && grep -rn "readFile\|getAuthSource\|keySuffix" src/harnesses/auth-source.ts src/api/harness-auth-status-endpoint.ts`
Expected: the only full-credential read is inside `auth-source.ts`'s `readEnvValueFromFile` / `readFile`, and the value is only ever passed through `safeSuffix` before serialization. The endpoint never touches the raw value.

---

## Acceptance-criteria → task map

| Acceptance criterion | Task(s) |
|---|---|
| Settings has a "Harness auth status" section listing every harness in the registry | Task 8 (panel renders all rows) + Task 5 (endpoint iterates `getHarnesses()` which is seeded with every registered harness) |
| Each row: name, auth source path, key suffix (last 4, never full), last-modified, state badge (`loaded`/`missing`/`unknown`) | Task 2 (suffix/state/mtime logic) + Task 8 (row rendering) |
| Panel is read-only; each row links to the `rotating-harness-keys` doc entry | Task 8 (no edit affordances; per-row deep-link) + Task 9 (the runbook + anchors) |
| `GET /v1/harnesses/auth-status` returns the data; never full key bytes — only suffix + metadata | Task 5 (endpoint + never-full-key test) + Task 6 (wiring) |
| (CLAUDE.md §Frontends) spec update in the same PR | Task 10 |
| (Stage-1 prerequisite) runbook must exist for the deep-links | Task 9 |

## Self-review notes

- **Spec coverage:** all 4 ACs + both prerequisites map to tasks (table above). No gaps.
- **Type consistency:** `HarnessAuthSource`, `HarnessAuthStatusEntry`, `HarnessAuthStatusResponse`, `resolveHarnessAuthStatus`, `addHarnessAuthStatusRoutes`, `getHarnesses`, `api.harnessAuthStatus`, `HarnessAuthStatusCard` are used with identical names across daemon and SPA tasks. SPA mirrors the daemon entry type structurally (separate declaration, same field names — the SPA can't import server types across the bundle boundary, matching how `HarnessReadinessEntry` is duplicated).
- **No placeholders:** every code step shows complete code; every command states expected output.
- **Surgical scope (Rule 2/3):** only the 3 credentialed harnesses implement `getAuthSource`; baselines/evaluators are untouched and report `none`/"no auth required". One registry accessor added, no refactor of existing readiness wiring. No edit/rotate actions added to the panel.
- **Verify-before-trust flags for the implementer:** (1) confirm `HermesHarnessConfig`/learner config constructor shapes before finalizing the Task 3 test stubs; (2) confirm shadcn `table.tsx`/`badge.tsx` export names before the Task 8 import; (3) inspect `harness-readiness-wiring.test.ts` to decide extend-vs-new-file in Task 6.
```
