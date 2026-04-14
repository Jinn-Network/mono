# Client Surface 01 — Error Envelope Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the foundation of the Jinn client CLI surface: a typed error envelope written to stdout on any non-zero exit, a normative exit-code map, a `claude` binary preflight, and `JINN_DEBUG=1` semantics promoted to default. Everything downstream (the `jinn` binary, status split, doctor, fleet verbs) will consume the envelope shape from this slice.

**Architecture:** Introduce a small pure module (`client/src/errors/envelope.ts`) that builds and emits error envelopes per the contract in `spec/2026-04-14-client-surface.md`. Refactor the funding / not-ok / catch branches of `client/src/main.ts` to use it. Add a tiny preflight module (`client/src/preflight/claude-binary.ts`) that resolves the `claude` executable before the daemon starts. Flip `operator-errors.ts` debug default so stack/cause chains are always appended.

**Tech Stack:** TypeScript, Vitest, Node `child_process`, existing `operator-errors.ts` helpers.

**Non-goals for this slice:**
- No `jinn` CLI binary — that's the next plan.
- No `status` split — that's the plan after.
- No `jinn doctor` verb — the preflight module is reusable but not yet wired to a verb.
- No JSON-by-default-on-non-TTY handling — that's a CLI binary concern.

**Before you start:** this slice modifies `client/src/main.ts`, which is the production entry point. Every task commits independently; if any commit breaks `npm start` for a funded fleet, stop and raise the issue before proceeding.

**Reference:** `spec/2026-04-14-client-surface.md` §5 (exit codes) and §6 (error envelope) are the source of truth. If anything in this plan conflicts with the spec, the spec wins.

---

## File structure

New files:
- `client/src/errors/envelope.ts` — Envelope types, builder, emitter. Pure + thin impure wrapper.
- `client/test/errors/envelope.test.ts` — Unit tests for envelope.
- `client/src/preflight/claude-binary.ts` — `checkClaudeBinary(claudePath)`. Pure-ish (reads filesystem / spawns `which`).
- `client/test/preflight/claude-binary.test.ts` — Unit tests for preflight.

Modified files:
- `client/src/main.ts` — Replace the three existing exit branches and the top-level catch with envelope calls; add claude preflight call before `Daemon.start()`.
- `client/src/operator-errors.ts` — Remove the "run with `JINN_DEBUG=1` for the full error" guidance; always append cause chain.
- `client/test/operator-errors.test.ts` — Update the truncation test to match the new behavior.

---

## Task 1: Error envelope module — types and pure builder

**Files:**
- Create: `client/src/errors/envelope.ts`
- Create: `client/test/errors/envelope.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `client/test/errors/envelope.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildEnvelope, EXIT_CODES, type ErrorCode } from '../../src/errors/envelope.js';

describe('buildEnvelope', () => {
  it('builds a funding_required envelope with required fields', () => {
    const env = buildEnvelope({
      code: 'funding_required',
      message: 'Master wallet needs more ETH',
      hint: 'Send ETH to 0xabc then re-run.',
      exampleCli: 'jinn fund-requirements --json',
      details: {
        role: 'master',
        address: '0xabc',
        asset: 'native',
        needWei: '45000000000000000',
        haveWei: '5000000000000000',
      },
    });
    expect(env.schemaVersion).toBe(1);
    expect(env.code).toBe('funding_required');
    expect(env.exitCode).toBe(10);
    expect(env.message).toBe('Master wallet needs more ETH');
    expect(env.hint).toBe('Send ETH to 0xabc then re-run.');
    expect(env.exampleCli).toBe('jinn fund-requirements --json');
    expect(env.details).toEqual({
      role: 'master',
      address: '0xabc',
      asset: 'native',
      needWei: '45000000000000000',
      haveWei: '5000000000000000',
    });
  });

  it('uses EXIT_CODES to resolve exitCode from code', () => {
    const codes: ErrorCode[] = [
      'funding_required',
      'invalid_invocation',
      'bootstrap_incomplete',
      'reconcile_needed',
      'transient_error',
      'fatal',
    ];
    const expected = [10, 11, 20, 30, 40, 50];
    codes.forEach((code, i) => {
      const env = buildEnvelope({ code, message: 'x' });
      expect(env.exitCode).toBe(expected[i]);
      expect(EXIT_CODES[code]).toBe(expected[i]);
    });
  });

  it('omits undefined optional fields', () => {
    const env = buildEnvelope({ code: 'fatal', message: 'boom' });
    expect(env).not.toHaveProperty('hint');
    expect(env).not.toHaveProperty('exampleCli');
    expect(env).not.toHaveProperty('details');
  });

  it('populates generatedAt as an ISO-8601 string', () => {
    const env = buildEnvelope({ code: 'fatal', message: 'boom' });
    expect(() => new Date(env.generatedAt).toISOString()).not.toThrow();
    expect(env.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/errors/envelope.test.ts
```

Expected: FAIL with "Cannot find module '../../src/errors/envelope.js'".

- [ ] **Step 3: Create the envelope module**

Create `client/src/errors/envelope.ts`:

```typescript
/**
 * Error envelope for the Jinn client CLI surface.
 *
 * Contract: spec/2026-04-14-client-surface.md §5 (exit codes) and §6 (envelope).
 * Every non-zero exit from a jinn verb writes one of these objects to stdout
 * (not stderr — stderr is reserved for logs) and then exits with `exitCode`.
 */

export type ErrorCode =
  | 'funding_required'
  | 'invalid_invocation'
  | 'bootstrap_incomplete'
  | 'reconcile_needed'
  | 'transient_error'
  | 'fatal';

export const EXIT_CODES: Record<ErrorCode, number> = {
  funding_required: 10,
  invalid_invocation: 11,
  bootstrap_incomplete: 20,
  reconcile_needed: 30,
  transient_error: 40,
  fatal: 50,
};

export interface ErrorEnvelope {
  schemaVersion: 1;
  generatedAt: string;
  code: ErrorCode;
  exitCode: number;
  message: string;
  hint?: string;
  exampleCli?: string;
  details?: Record<string, unknown>;
}

export interface BuildEnvelopeInput {
  code: ErrorCode;
  message: string;
  hint?: string;
  exampleCli?: string;
  details?: Record<string, unknown>;
}

export function buildEnvelope(input: BuildEnvelopeInput): ErrorEnvelope {
  const env: ErrorEnvelope = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    code: input.code,
    exitCode: EXIT_CODES[input.code],
    message: input.message,
  };
  if (input.hint !== undefined) env.hint = input.hint;
  if (input.exampleCli !== undefined) env.exampleCli = input.exampleCli;
  if (input.details !== undefined) env.details = input.details;
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd client && npx vitest run test/errors/envelope.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/errors/envelope.ts client/test/errors/envelope.test.ts
git commit -m "client: add error envelope builder and exit code map"
```

---

## Task 2: Error envelope emitter — stdout + exit

**Files:**
- Modify: `client/src/errors/envelope.ts`
- Modify: `client/test/errors/envelope.test.ts`

The emitter is impure — it writes to a stream and calls `process.exit`. Keep it thin and injectable so tests never touch real stdout or real `process.exit`.

- [ ] **Step 1: Add a failing test for the emitter**

Append to `client/test/errors/envelope.test.ts`:

```typescript
import { emitEnvelope } from '../../src/errors/envelope.js';

describe('emitEnvelope', () => {
  it('writes the envelope as a single JSON line and calls exit with exitCode', () => {
    const writes: string[] = [];
    const exits: number[] = [];
    const writer = { write: (s: string) => { writes.push(s); return true; } };
    const exit = (code: number) => { exits.push(code); };

    emitEnvelope(
      {
        code: 'funding_required',
        message: 'need eth',
        hint: 'send some',
        exampleCli: 'jinn fund-requirements --json',
        details: { role: 'master' },
      },
      { writer, exit },
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\n$/);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.code).toBe('funding_required');
    expect(parsed.exitCode).toBe(10);
    expect(parsed.details).toEqual({ role: 'master' });
    expect(exits).toEqual([10]);
  });

  it('defaults to process.stdout and process.exit when sinks are omitted', () => {
    // Smoke test: just make sure the signature is valid. We don't actually
    // call it without sinks because that would terminate the test process.
    expect(typeof emitEnvelope).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/errors/envelope.test.ts
```

Expected: FAIL with "emitEnvelope is not a function" or "has no exported member 'emitEnvelope'".

- [ ] **Step 3: Add the emitter to envelope.ts**

Append to `client/src/errors/envelope.ts`:

```typescript
export interface EnvelopeSinks {
  writer?: { write: (s: string) => boolean };
  exit?: (code: number) => void;
}

/**
 * Build the envelope, write it as a single JSON line to stdout, and exit
 * with its `exitCode`. Injectable sinks exist purely for tests; production
 * callers pass no second argument.
 *
 * This function does not return.
 */
export function emitEnvelope(input: BuildEnvelopeInput, sinks: EnvelopeSinks = {}): never {
  const envelope = buildEnvelope(input);
  const writer = sinks.writer ?? process.stdout;
  const exit = sinks.exit ?? ((c: number) => process.exit(c));
  writer.write(JSON.stringify(envelope) + '\n');
  exit(envelope.exitCode);
  // Unreachable in production; tests may inject a no-op exit.
  throw new Error('emitEnvelope: exit did not terminate the process');
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/errors/envelope.test.ts
```

Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add client/src/errors/envelope.ts client/test/errors/envelope.test.ts
git commit -m "client: add envelope emitter with injectable sinks for testing"
```

---

## Task 3: Wire envelope into main.ts bootstrap branches

**Files:**
- Modify: `client/src/main.ts:88-96` (funding branch + not-ok branch)
- Modify: `client/src/main.ts:100-104` (no-ready-service branch)
- Modify: `client/src/main.ts:222-230` (top-level catch)

This task has no unit test — `main.ts` is the production entrypoint and is covered by the existing e2e validator (`npm run e2e`). Verification is by code inspection + running the typecheck + running the full vitest suite to confirm no regression.

- [ ] **Step 1: Replace the funding branch**

In `client/src/main.ts`, find:

```typescript
  if (result.funding) {
    console.error(`\n${result.message}\n`);
    process.exit(0);
  }
```

Replace with:

```typescript
  if (result.funding) {
    emitEnvelope({
      code: 'funding_required',
      message: result.message,
      hint: 'Fund the listed address and re-run this command.',
      exampleCli: 'npm start',
      details: {
        masterAddress: result.funding.master_address,
        asset: 'native',
        needWei: result.funding.eth_required,
        haveWei: result.funding.eth_balance,
      },
    });
  }
```

Add to the imports at the top of `client/src/main.ts`:

```typescript
import { emitEnvelope } from './errors/envelope.js';
```

Note: `exampleCli` is `npm start` for now because the `jinn` binary does not yet exist. A follow-up plan will replace it with `jinn bootstrap` once the CLI ships.

- [ ] **Step 2: Replace the not-ok bootstrap branch**

In `client/src/main.ts`, find:

```typescript
  if (!result.ok) {
    console.error(`[main] ${result.message}`);
    process.exit(1);
  }
```

Replace with:

```typescript
  if (!result.ok) {
    emitEnvelope({
      code: 'fatal',
      message: result.message,
      hint: 'Bootstrap failed before the fleet reached a runnable state.',
      details: { stage: 'bootstrap' },
    });
  }
```

- [ ] **Step 3: Replace the no-ready-service branch**

In `client/src/main.ts`, find:

```typescript
  const firstComplete = state.services.find(s => s.step === 'complete');
  if (!firstComplete || !firstComplete.safe_address) {
    console.error('[main] Bootstrap completed but no service is ready.');
    process.exit(1);
  }
```

Replace the `if` body with:

```typescript
  if (!firstComplete || !firstComplete.safe_address) {
    emitEnvelope({
      code: 'bootstrap_incomplete',
      message: 'Bootstrap completed but no service is ready.',
      hint: 'Re-run to continue the state machine toward a running fleet.',
      exampleCli: 'npm start',
      details: { completeCount: state.services.filter(s => s.step === 'complete').length },
    });
  }
```

- [ ] **Step 4: Replace the top-level catch handler**

In `client/src/main.ts`, find:

```typescript
main().catch((err) => {
  if (config.debug) {
    console.error('[main] Fatal error:', err);
  } else {
    const { summary, hint } = formatBootstrapOperatorMessage(err);
    console.error(`[main] ${summary}`);
    if (hint !== undefined) console.error(`Hint: ${hint}`);
  }
  process.exit(1);
});
```

Replace with:

```typescript
main().catch((err) => {
  const { summary, hint } = formatBootstrapOperatorMessage(err);
  const cause = err instanceof Error ? (err.stack ?? err.message) : String(err);
  emitEnvelope({
    code: 'fatal',
    message: summary,
    ...(hint !== undefined ? { hint } : {}),
    details: { cause },
  });
});
```

Note: `config.debug` is no longer read here; the full cause chain is always
in `details.cause`. Humans who want pretty-printed stacks can pipe to `jq`.

- [ ] **Step 5: Typecheck + full vitest run**

Run:
```bash
cd client && npx tsc --noEmit
```

Expected: zero errors.

Run:
```bash
cd client && npx vitest run
```

Expected: all tests pass (146 existing + 6 new envelope tests = 152+).

- [ ] **Step 6: Commit**

```bash
git add client/src/main.ts
git commit -m "client: emit structured error envelope on bootstrap and fatal exits"
```

---

## Task 4: Claude binary preflight

**Files:**
- Create: `client/src/preflight/claude-binary.ts`
- Create: `client/test/preflight/claude-binary.test.ts`
- Modify: `client/src/main.ts` (call preflight before `daemon.start()`)

- [ ] **Step 1: Write the failing test**

Create `client/test/preflight/claude-binary.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkClaudeBinary } from '../../src/preflight/claude-binary.js';

describe('checkClaudeBinary', () => {
  it('returns ok=true when the path points at an executable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-preflight-'));
    const fakeClaude = join(dir, 'claude');
    writeFileSync(fakeClaude, '#!/bin/sh\necho fake\n');
    chmodSync(fakeClaude, 0o755);

    const result = await checkClaudeBinary(fakeClaude);
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(fakeClaude);
  });

  it('returns ok=false when the path does not exist', async () => {
    const result = await checkClaudeBinary('/nonexistent/path/to/claude');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });

  it('resolves a bare binary name via PATH when it exists', async () => {
    // `node` is guaranteed present in the test env
    const result = await checkClaudeBinary('node');
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBeDefined();
  });

  it('returns ok=false for a bare binary name not on PATH', async () => {
    const result = await checkClaudeBinary('definitely-not-a-real-binary-xyz');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/preflight/claude-binary.test.ts
```

Expected: FAIL with "Cannot find module '../../src/preflight/claude-binary.js'".

- [ ] **Step 3: Create the preflight module**

Create `client/src/preflight/claude-binary.ts`:

```typescript
/**
 * Preflight check: is the `claude` CLI resolvable and executable?
 *
 * The daemon spawns Claude Code as a subprocess via `ClaudeRunner`
 * (client/src/runner/claude.ts). If the binary isn't on PATH (or at
 * the configured claudePath), the failure surfaces only at the moment
 * a request is claimed — long after bootstrap. This check moves that
 * failure to startup with a clear envelope.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';

const execFileAsync = promisify(execFile);

export interface ClaudeBinaryCheckResult {
  ok: boolean;
  resolvedPath?: string;
  detail: string;
}

/**
 * Resolve and verify a `claude` binary. Accepts either an absolute path or a
 * bare name to look up on PATH (via `which`/`where`).
 */
export async function checkClaudeBinary(claudePath: string): Promise<ClaudeBinaryCheckResult> {
  // Absolute / relative path: fs.access is authoritative.
  if (isAbsolute(claudePath) || claudePath.includes('/')) {
    try {
      await fs.access(claudePath, fsConstants.X_OK);
      return { ok: true, resolvedPath: claudePath, detail: `${claudePath} is executable` };
    } catch {
      return { ok: false, detail: `claude binary not found at ${claudePath}` };
    }
  }

  // Bare name: shell out to `which` (POSIX) or `where` (Windows). We only
  // support POSIX here; the production target is macOS/Linux.
  try {
    const { stdout } = await execFileAsync('which', [claudePath]);
    const resolved = stdout.trim().split('\n')[0];
    if (!resolved) {
      return { ok: false, detail: `claude binary '${claudePath}' not found on PATH` };
    }
    return { ok: true, resolvedPath: resolved, detail: `${resolved} is on PATH` };
  } catch {
    return { ok: false, detail: `claude binary '${claudePath}' not found on PATH` };
  }
}
```

- [ ] **Step 4: Run preflight test to verify pass**

Run:
```bash
cd client && npx vitest run test/preflight/claude-binary.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Wire the preflight into main.ts**

In `client/src/main.ts`, find the block immediately before `const daemon = new Daemon({`:

```typescript
  const runner = new ClaudeRunner({
    claudePath: config.claudePath,
    model: config.claudeModel,
  });
```

Insert *before* the `const runner = ...` line:

```typescript
  const preflight = await checkClaudeBinary(config.claudePath);
  if (!preflight.ok) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: preflight.detail,
      hint: 'Install Claude Code CLI or set JINN_CLAUDE_PATH to the absolute path of the claude binary.',
      exampleCli: 'command -v claude',
      details: {
        field: 'claude_binary',
        expected: 'executable claude binary',
        attempted: config.claudePath,
      },
    });
  }
```

Add to the imports at the top of `client/src/main.ts`:

```typescript
import { checkClaudeBinary } from './preflight/claude-binary.js';
```

- [ ] **Step 6: Typecheck + full vitest run**

Run:
```bash
cd client && npx tsc --noEmit
```

Expected: zero errors.

Run:
```bash
cd client && npx vitest run
```

Expected: all tests pass (now 156+ including 4 preflight tests).

- [ ] **Step 7: Commit**

```bash
git add client/src/preflight/claude-binary.ts client/test/preflight/claude-binary.test.ts client/src/main.ts
git commit -m "client: preflight claude binary before starting daemon"
```

---

## Task 5: Debug default — always append cause chain

**Files:**
- Modify: `client/src/operator-errors.ts`
- Modify: `client/test/operator-errors.test.ts`

The catch handler in `main.ts` already puts `err.stack` into `details.cause`
(Task 3, Step 4). This task removes the last remaining piece of debug-gated
behavior: the "Run with JINN_DEBUG=1 for the full error" hint in the
truncation path. With the envelope carrying the full cause by default, that
hint is now lying to the user — the full error is already there.

- [ ] **Step 1: Update the truncation test to expect no JINN_DEBUG hint**

In `client/test/operator-errors.test.ts`, find:

```typescript
  it('truncates very long messages with hint', () => {
    const long = 'x'.repeat(300);
    const r = formatBootstrapOperatorMessage(new Error(long));
    expect(r.summary.length).toBeLessThanOrEqual(221);
    expect(r.hint).toContain('JINN_DEBUG');
  });
```

Replace with:

```typescript
  it('truncates very long messages without referencing JINN_DEBUG', () => {
    const long = 'x'.repeat(300);
    const r = formatBootstrapOperatorMessage(new Error(long));
    expect(r.summary.length).toBeLessThanOrEqual(221);
    // Hint (if any) must not reference JINN_DEBUG — the envelope's
    // details.cause already carries the full error.
    if (r.hint !== undefined) {
      expect(r.hint).not.toContain('JINN_DEBUG');
    }
  });
```

- [ ] **Step 2: Run the updated test to verify it fails**

Run:
```bash
cd client && npx vitest run test/operator-errors.test.ts
```

Expected: FAIL on "truncates very long messages without referencing JINN_DEBUG" because the current implementation still returns a hint containing "JINN_DEBUG".

- [ ] **Step 3: Remove the JINN_DEBUG hint from operator-errors.ts**

In `client/src/operator-errors.ts`, find:

```typescript
  const firstLine = msg.split('\n')[0]?.trim() ?? msg;
  if (firstLine.length > 220) {
    return {
      summary: `${firstLine.slice(0, 220)}…`,
      hint: 'Run with JINN_DEBUG=1 for the full error.',
    };
  }
```

Replace with:

```typescript
  const firstLine = msg.split('\n')[0]?.trim() ?? msg;
  if (firstLine.length > 220) {
    return { summary: `${firstLine.slice(0, 220)}…` };
  }
```

Also find the GS013 hint:

```typescript
      hint: 'Retry after a few blocks, switch RPC, or run with JINN_DEBUG=1 for the full error.',
```

Replace with:

```typescript
      hint: 'Retry after a few blocks or switch RPC. Full cause chain is in the error envelope details.',
```

- [ ] **Step 4: Run the full operator-errors test suite**

Run:
```bash
cd client && npx vitest run test/operator-errors.test.ts
```

Expected: PASS (7 tests). The `maps GS013` test still passes because it only asserts `hint` is defined.

- [ ] **Step 5: Run the full vitest suite to check for regressions**

Run:
```bash
cd client && npx tsc --noEmit && npx vitest run
```

Expected: zero type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/operator-errors.ts client/test/operator-errors.test.ts
git commit -m "client: stop referencing JINN_DEBUG in error hints; envelope carries cause"
```

---

## Task 6: Spec cross-reference in README

**Files:**
- Modify: `client/README.md`

One-line addition so anyone reading the README lands on the spec.

- [ ] **Step 1: Append a reference section to client/README.md**

Append to the bottom of `client/README.md`:

```markdown
## Spec

The stable command-line and JSON surface this client exposes is
defined in [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md).
Error envelopes emitted on non-zero exits conform to §6 of that spec.
```

- [ ] **Step 2: Commit**

```bash
git add client/README.md
git commit -m "docs(client): link README to client surface spec"
```

---

## Final verification

- [ ] **Step 1: Full typecheck**

```bash
cd client && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Full test run**

```bash
cd client && npx vitest run
```

Expected: all tests pass. Count should be the current 146 + 6 (envelope) + 4 (preflight) = 156.

- [ ] **Step 3: Manual smoke — funding envelope on stdout**

Run, from a clean state, against the Anvil fork or with no keystore:

```bash
rm -rf /tmp/jinn-smoke && \
JINN_EARNING_DIR=/tmp/jinn-smoke JINN_PASSWORD=smoke npm start 2>/dev/null
echo "exit=$?"
```

Expected: a single JSON line on stdout with `"code":"funding_required"` and `"exitCode":10`; process exits with code 10.

If the exit code is 0 (the old behavior), Task 3 Step 1 did not land correctly.

- [ ] **Step 4: Manual smoke — claude preflight envelope**

With `claude` not on PATH:

```bash
PATH=/usr/bin:/bin JINN_PASSWORD=smoke JINN_CLAUDE_PATH=claude npm start 2>/dev/null
echo "exit=$?"
```

(Only run this if your shell's `/usr/bin:/bin` truly lacks a `claude` binary.)

Expected: exit code 11, envelope on stdout with `"code":"invalid_invocation"` and `"details":{"field":"claude_binary",...}`.

- [ ] **Step 5: Final commit if any fixups needed**

If smoke tests revealed an issue, fix it with a new commit — do NOT amend.

---

## Spec coverage check

This slice covers:

| Spec section | Covered by |
|---|---|
| §5 Exit codes (0, 10, 11, 20, 50) | Task 1 EXIT_CODES map, Task 3 branches |
| §6 Error envelope shape | Task 1 types, Task 2 emitter |
| §6.1 Stdout not stderr | Task 2 emitter defaults to `process.stdout` |
| §6.1 `exampleCli` field | Task 1 builder, Task 3 funding branch, Task 4 preflight |
| §7.6 Private internals (don't leak `JINN_DEBUG`) | Task 5 hint cleanup |

Not covered in this slice (deferred to later plans):
- §2.1 `jinn` CLI binary and subcommand dispatch.
- §2.2 Introspection verbs (`status`, `fleet`, `history`, etc.).
- §2.3 Action verbs (`submit-intent`, `withdraw`, `keys backup`, etc.).
- §7.1 Headless-first flag parsing (requires the CLI binary).
- §7.2 JSON-by-default-on-non-TTY (requires the CLI binary).
- §7.3 Dry-run and confirmation (action verbs only).
- Exit codes 30 (`reconcile_needed`) and 40 (`transient_error`) — no
  existing branch in `main.ts` maps to these yet; they'll land when
  the classifier does.

These gaps are intentional. This slice is the envelope foundation; the
next plan wires it into a `jinn` binary.
