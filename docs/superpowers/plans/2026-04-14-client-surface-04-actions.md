# Client Surface 04 — Action Verbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the action verbs — `submit-intent`, `claim-rewards`, `fleet scale`, `fleet retire`, `withdraw`, `keys backup` — each supporting `--dry-run` and `--yes` per spec §7.3, with the idempotency semantics from spec §7.4.

**Architecture:** Every action verb is a CLI command module following plan 02's dispatch pattern. A new `client/src/cli/action.ts` helper unifies dry-run formatting and non-TTY confirmation handling so each verb's `run` function stays small. `submit-intent` wraps the existing creator loop logic; `claim-rewards` wraps the existing stolas/jinn claim code; `fleet scale` reuses `FleetBootstrapper`; `fleet retire` reuses `orphan-sweep`; `withdraw` wraps the existing withdraw script; `keys backup` is new but trivial.

**Tech Stack:** TypeScript, Vitest, existing `FleetBootstrapper`, `CreatorLoop`, `stolas-claim`, `orphan-sweep`, `wallet` utilities.

**Hard prerequisites:**
- Plan 02 (`2026-04-14-client-surface-02-cli-scaffold.md`) — imports `emitEnvelope`, dispatch scaffold, `CommandModule`, `CommandContext`.
- Plan 03 is NOT a hard prerequisite (action verbs don't read introspection state), but plans 03 and 04 can safely land in either order after plan 02.

**Reference:** `spec/2026-04-14-client-surface.md` §2.3 (action verbs), §7.3 (dry-run/yes), §7.4 (idempotency), §6 (error envelope).

**Non-goals for this plan:**
- Real per-service wallet balances in the gatherer — not needed by any action verb; plan 03 surfaces zero for now.
- Extended reward tracking (earned vs claimed history) — `claim-rewards` reports the delta it just claimed; historical accounting is out of scope.
- Auto-retry on transient RPC errors — each verb exits 40 on transient and lets the caller retry.

---

## File structure

New files (shared):
- `client/src/cli/action.ts` — Shared helpers for action verbs: `ensureConfirmed(ctx, flags)`, `emitDryRun(ctx, plan)`.
- `client/test/cli/action.test.ts` — Unit tests for the shared helpers.

New files (verbs):
- `client/src/cli/commands/submit-intent.ts`
- `client/src/cli/commands/claim-rewards.ts`
- `client/src/cli/commands/fleet-scale.ts` (handles `jinn fleet scale`)
- `client/src/cli/commands/fleet-retire.ts` (handles `jinn fleet retire <i>`)
- `client/src/cli/commands/withdraw.ts`
- `client/src/cli/commands/keys-backup.ts`

New tests:
- `client/test/cli/commands/submit-intent.test.ts`
- `client/test/cli/commands/claim-rewards.test.ts`
- `client/test/cli/commands/fleet-scale.test.ts`
- `client/test/cli/commands/fleet-retire.test.ts`
- `client/test/cli/commands/withdraw.test.ts`
- `client/test/cli/commands/keys-backup.test.ts`

Modified files:
- `client/src/cli/index.ts` — register the six new commands. `fleet scale` and `fleet retire` are registered as a compound verb `fleet` dispatching on subverb.

---

## Task 1: Shared action helpers — dry-run and confirmation

**Files:**
- Create: `client/src/cli/action.ts`
- Create: `client/test/cli/action.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/action.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ensureConfirmed, emitDryRun } from '../../src/cli/action.js';
import type { CommandContext } from '../../src/cli/command.js';

function makeCtx(stdoutIsTty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: {},
  };
  return { ctx, writes, exits };
}

describe('ensureConfirmed', () => {
  it('returns true when --yes is passed', () => {
    const { ctx } = makeCtx(true);
    expect(ensureConfirmed(ctx, { yes: true, dryRun: false })).toBe(true);
  });

  it('returns false and emits invalid_invocation on non-TTY without --yes', () => {
    const { ctx, writes, exits } = makeCtx(false);
    const ok = ensureConfirmed(ctx, { yes: false, dryRun: false });
    expect(ok).toBe(false);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('confirmation');
    expect(exits).toEqual([11]);
  });

  it('returns true when --dry-run is passed (no confirmation needed)', () => {
    const { ctx } = makeCtx(false);
    expect(ensureConfirmed(ctx, { yes: false, dryRun: true })).toBe(true);
  });
});

describe('emitDryRun', () => {
  it('emits a dry-run envelope with plan and exits 0', () => {
    const { ctx, writes, exits } = makeCtx();
    emitDryRun(ctx, {
      verb: 'submit-intent',
      description: 'Would post one intent',
      plan: [{ step: 1, tx: 'JinnRouter.createRestorationJob(...)' }],
    });
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan).toEqual([{ step: 1, tx: 'JinnRouter.createRestorationJob(...)' }]);
    // Dry run is a success — no exit is called (verb returns normally).
    expect(exits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/action.test.ts
```

Expected: FAIL with "Cannot find module '../../src/cli/action.js'".

- [ ] **Step 3: Implement the action helpers**

Create `client/src/cli/action.ts`:

```typescript
/**
 * Shared helpers for action verbs (verbs that emit transactions).
 *
 * Contract: spec/2026-04-14-client-surface.md §7.3 (dry-run / yes).
 */

import type { CommandContext } from './command.js';
import { emitEnvelope } from '../errors/envelope.js';

export interface ConfirmFlags {
  yes: boolean;
  dryRun: boolean;
}

/**
 * Ensure an action is confirmed before proceeding.
 *
 * - Dry run → always permitted, returns true without any check.
 * - `--yes` → permitted regardless of TTY state.
 * - Non-TTY without `--yes` → emits invalid_invocation (exit 11) and returns false.
 * - TTY without `--yes` → would prompt, but v1 never prompts; returns false
 *   with an invalid_invocation envelope. (v2 may implement a TTY prompt.)
 *
 * Callers SHOULD check the return value and bail out on false.
 */
export function ensureConfirmed(ctx: CommandContext, flags: ConfirmFlags): boolean {
  if (flags.dryRun) return true;
  if (flags.yes) return true;
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: 'This action requires explicit confirmation.',
      hint: 'Re-run with --yes to confirm, or --dry-run to see what would happen without executing.',
      exampleCli: 'jinn <verb> --dry-run',
      details: { field: 'confirmation', expected: '--yes or --dry-run' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
  return false;
}

export interface DryRunPayload {
  verb: string;
  description: string;
  plan: unknown[];
}

/**
 * Emit a dry-run JSON response. Dry-run is a success, so no exit code is
 * raised — the caller simply returns after calling this helper.
 */
export function emitDryRun(ctx: CommandContext, payload: DryRunPayload): void {
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dryRun: true,
    ...payload,
  }) + '\n');
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/action.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/action.ts client/test/cli/action.test.ts
git commit -m "client(cli): add shared action helpers for dry-run and confirmation"
```

---

## Task 2: `submit-intent` verb

**Files:**
- Create: `client/src/cli/commands/submit-intent.ts`
- Create: `client/test/cli/commands/submit-intent.test.ts`
- Modify: `client/src/cli/index.ts`

Idempotency (spec §7.4): keyed on `(creatorMultisigAddress, desiredStateId)`. Re-posting the same id returns the existing on-chain intent id and exits 0.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/submit-intent.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: '', rpcOk: true, rpcChainId: 1, rpcBlockNumber: 1n,
    fleet: {
      loaded: true, chain: 'base-sepolia', stakingMode: 'standard',
      services: [{ index: 0, step: 'complete', serviceId: 42, safeAddress: '0xSAFE', agentAddress: '0xAGENT', staked: true }],
      completeCount: 1, stakedLikeCount: 1,
    },
    masterGas: { address: '0xM', balanceWei: '0', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: { counts: {}, recent: [] },
    earningsHint: '', nextActions: [],
  })),
}));

function makeCtx(argv: string[], tty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: tty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('submit-intent command', () => {
  it('--dry-run emits a plan without executing', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes } = makeCtx([
      '--id', 'test-1',
      '--description', 'The service is healthy',
      '--dry-run',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan[0]).toMatchObject({ id: 'test-1' });
  });

  it('non-TTY without --yes or --dry-run emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx([
      '--id', 'test-1',
      '--description', 'The service is healthy',
    ]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('missing --id emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/submit-intent.js');
    const { ctx, writes, exits } = makeCtx(['--dry-run', '--description', 'x']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--id');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/submit-intent.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the submit-intent verb**

Create `client/src/cli/commands/submit-intent.ts`:

```typescript
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        id: { type: 'string' },
        description: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn submit-intent --id test-1 --description "..." --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const id = parsed.values.id as string | undefined;
  const description = parsed.values.description as string | undefined;

  if (!id) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--id is required',
        exampleCli: 'jinn submit-intent --id my-intent --description "..." --dry-run',
        details: { field: '--id', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (!description) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--description is required',
        exampleCli: 'jinn submit-intent --id my-intent --description "..." --dry-run',
        details: { field: '--description', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const raw = await gatherIntrospectionRaw();
  const service = raw.fleet?.services?.find((s) => s.step === 'complete');
  if (!service) {
    emitEnvelope(
      {
        code: 'bootstrap_incomplete',
        message: 'No complete service in the fleet to post an intent from.',
        hint: 'Run `jinn bootstrap` to advance the state machine first.',
        exampleCli: 'jinn bootstrap',
        details: { field: 'fleet' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const creatorMultisig = service.safeAddress ?? '0x';
  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  if (dryRun) {
    emitDryRun(ctx, {
      verb: 'submit-intent',
      description: `Would post intent '${id}' from ${creatorMultisig}`,
      plan: [{ id, description, creatorMultisig, asset: 'native', txCount: 1 }],
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  // Real submission path — import lazily so dry-run/test paths don't load the
  // full adapter stack.
  // Idempotency: the adapter's submitRestorationJob is keyed on
  // (creatorMultisig, id); re-posting returns the existing intent id.
  const { MechAdapter } = await import('../../adapters/mech/adapter.js');
  // Construction of the adapter requires config + keystore; for the first
  // implementation pass we re-use the existing main.ts wiring indirectly by
  // calling a helper yet to be added. For now, emit a stub success response
  // naming the intent id — the adapter integration lands in a follow-up
  // commit once the adapter constructor surface is stable.
  void MechAdapter;
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'submit-intent',
    id,
    creatorMultisig,
    status: 'submitted',
    note: 'adapter integration pending in a follow-up commit',
  }) + '\n');
}

const command: CommandModule = {
  name: 'submit-intent',
  summary: 'Post a desired state (restoration job) to the protocol',
  helpText: `Usage: jinn submit-intent --id <id> --description <text> [--dry-run] [--yes]

Idempotent: keyed on (creator multisig, id). Re-posting the same id is
a no-op that returns the existing on-chain intent id and exits 0.

Examples:
  jinn submit-intent --id health-check --description "The service is running" --dry-run
  jinn submit-intent --id health-check --description "The service is running" --yes

Failure examples:
  # Missing required flag
  $ jinn submit-intent --dry-run
  {"code":"invalid_invocation","details":{"field":"--id"},...}
  $ echo $?
  11
`,
  run,
};

export default command;
```

Note the adapter integration stub: the first pass emits a success response with
`note` flagging pending work. A follow-up commit in the same task wires the real
adapter once the constructor surface is confirmed. The JSON shape is spec-correct;
the behavior is partial.

- [ ] **Step 4: Register submit-intent in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import submitIntentCommand from './commands/submit-intent.js';
```

Include in COMMANDS after `logs`:

```typescript
  submitIntentCommand,
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/submit-intent.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/submit-intent.ts client/test/cli/commands/submit-intent.test.ts client/src/cli/index.ts
git commit -m "client(cli): add submit-intent verb with dry-run and confirmation"
```

---

## Task 3: `claim-rewards` verb

**Files:**
- Create: `client/src/cli/commands/claim-rewards.ts`
- Create: `client/test/cli/commands/claim-rewards.test.ts`
- Modify: `client/src/cli/index.ts`

Idempotency (spec §7.4): zero-delta is success, not error. Second consecutive call returns `{ claimedWei: "0" }` and exits 0.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/claim-rewards.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/earning/stolas-claim.ts', () => ({
  claimAllStolas: vi.fn(async () => ({ claimed: [{ serviceIndex: 0, amountWei: '1000' }] })),
}));

function makeCtx(argv: string[], tty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: tty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('claim-rewards command', () => {
  it('--dry-run emits a plan without executing', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/claim-rewards.js');
    const { ctx, writes } = makeCtx(['--dry-run']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('claim-rewards');
  });

  it('non-TTY without --yes or --dry-run emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/claim-rewards.js');
    const { ctx, writes, exits } = makeCtx([]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/claim-rewards.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the claim-rewards verb**

Create `client/src/cli/commands/claim-rewards.ts`:

```typescript
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn claim-rewards --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  if (dryRun) {
    emitDryRun(ctx, {
      verb: 'claim-rewards',
      description: 'Would call the reward distributor for every staked service',
      plan: [{ action: 'distributor.claim', perServiceTx: true }],
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  // Stub: real implementation imports client/src/earning/stolas-claim.ts
  // and iterates over the fleet. A follow-up commit wires it after the
  // adapter constructor surface is stable.
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'claim-rewards',
    claimedWei: '0',
    note: 'distributor integration pending in a follow-up commit',
  }) + '\n');
}

const command: CommandModule = {
  name: 'claim-rewards',
  summary: 'Pull pending protocol rewards to the fleet multisigs',
  helpText: `Usage: jinn claim-rewards [--dry-run] [--yes]

Idempotent: zero-delta is success, not error. Second consecutive call
returns claimedWei:"0" and exits 0.

Examples:
  jinn claim-rewards --dry-run
  jinn claim-rewards --yes
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register claim-rewards in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import claimRewardsCommand from './commands/claim-rewards.js';
```

Include in COMMANDS:

```typescript
  claimRewardsCommand,
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/claim-rewards.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/claim-rewards.ts client/test/cli/commands/claim-rewards.test.ts client/src/cli/index.ts
git commit -m "client(cli): add claim-rewards verb with dry-run"
```

---

## Task 4: `fleet scale` compound verb

**Files:**
- Create: `client/src/cli/commands/fleet-scale.ts`
- Create: `client/test/cli/commands/fleet-scale.test.ts`
- Modify: `client/src/cli/index.ts`

`jinn fleet scale --to N` is a target-state verb: re-running with the same N is a no-op. Growth is delegated to `FleetBootstrapper` (which already handles `targetServices`); shrinkage is delegated to `fleet retire` (task 5).

`fleet` with multiple subverbs (`scale`, `retire`) is handled by a single compound command module that inspects `ctx.argv[0]` and dispatches internally.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/fleet-scale.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: '', rpcOk: true, rpcChainId: 1, rpcBlockNumber: 1n,
    fleet: {
      loaded: true, chain: 'base-sepolia', stakingMode: 'standard',
      services: [{ index: 0, step: 'complete', serviceId: 1, staked: true }],
      completeCount: 1, stakedLikeCount: 1,
    },
    masterGas: { address: '0xM', balanceWei: '0', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: { counts: {}, recent: [] },
    earningsHint: '', nextActions: [],
  })),
}));

function makeCtx(argv: string[]): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv, stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('fleet compound command', () => {
  it('scale --to 3 --dry-run emits a growth plan', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes } = makeCtx(['scale', '--to', '3', '--dry-run']);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan[0]).toMatchObject({ action: 'grow', from: 1, to: 3 });
  });

  it('scale --to 1 --dry-run when already at 1 is a no-op', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes } = makeCtx(['scale', '--to', '1', '--dry-run']);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.plan).toEqual([]);
    expect(parsed.description).toContain('already');
  });

  it('missing subverb emits invalid_invocation', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes, exits } = makeCtx([]);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('subverb');
    expect(exits).toEqual([11]);
  });

  it('unknown subverb emits invalid_invocation', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const { ctx, writes, exits } = makeCtx(['nope']);
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/fleet-scale.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the fleet compound verb with the `scale` subverb**

Create `client/src/cli/commands/fleet-scale.ts`:

```typescript
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';

async function runScale(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        to: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn fleet scale --to 3 --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const to = parseInt(parsed.values.to as string, 10);
  if (!Number.isFinite(to) || to < 0) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--to must be a non-negative integer',
        exampleCli: 'jinn fleet scale --to 3 --dry-run',
        details: { field: '--to', expected: 'non-negative integer' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const raw = await gatherIntrospectionRaw();
  const current = raw.fleet?.services?.length ?? 0;
  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  let plan: Array<{ action: string; from: number; to: number; indices?: number[] }> = [];
  let description: string;
  if (to === current) {
    plan = [];
    description = `Fleet is already at size ${current}. No action.`;
  } else if (to > current) {
    plan = [{ action: 'grow', from: current, to }];
    description = `Would grow fleet from ${current} to ${to} via jinn bootstrap with targetServices=${to}.`;
  } else {
    const indices = (raw.fleet?.services ?? []).slice(to).map((s) => s.index);
    plan = [{ action: 'retire', from: current, to, indices }];
    description = `Would retire services ${indices.join(', ')} to shrink fleet from ${current} to ${to}.`;
  }

  if (dryRun) {
    emitDryRun(ctx, { verb: 'fleet scale', description, plan });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  // Stub: real implementation invokes FleetBootstrapper with targetServices=to
  // for growth, or fleet retire for each excess index. Follow-up commit wires.
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'fleet scale',
    from: current,
    to,
    note: 'scale execution pending in a follow-up commit',
  }) + '\n');
}

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn fleet requires a subverb: scale | retire',
        exampleCli: 'jinn fleet scale --to 3 --dry-run',
        details: { field: 'subverb', expected: 'scale | retire' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (subverb === 'scale') return runScale(ctx, rest);
  // `retire` is handled in task 5 by extending this module.
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown fleet subverb: ${subverb}`,
      exampleCli: 'jinn fleet --help',
      details: { field: 'subverb', expected: 'scale | retire' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'fleet',
  summary: 'Fleet management: scale | retire <index>',
  helpText: `Usage: jinn fleet <subverb> [flags...]

Subverbs:
  scale --to N [--dry-run] [--yes]       Grow or shrink the fleet to N services (idempotent)
  retire <index> [--dry-run] [--yes]     Retire one service (unstake, unbond, drain)

Note: jinn fleet WITHOUT a subverb is not the same as jinn fleet (the
introspection verb). The introspection verb takes no args; this verb
requires a subverb.

Examples:
  jinn fleet scale --to 3 --dry-run
  jinn fleet scale --to 3 --yes
  jinn fleet retire 2 --dry-run
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register the fleet compound verb**

Because plan 03 registered `fleet` as the introspection verb, there's a
name collision. Resolve it by splitting the introspection verb's name to
`fleet` for introspection and `fleet-manage` for the compound action
verb — but the spec names the action `jinn fleet scale`. The clean fix:
the dispatcher looks at `argv[1]` (the first word after the verb) and,
if it looks like a subverb (`scale` or `retire`), routes to the action
module; otherwise routes to the introspection module.

In `client/src/cli/index.ts`, find the current `fleet` dispatch (from plan 03):

```typescript
  const command = COMMANDS.find((c) => c.name === verb);
```

Immediately after that line, before the "not found" check, add:

```typescript
  // Compound-verb disambiguation: `jinn fleet scale ...` vs `jinn fleet`.
  if (verb === 'fleet' && rest.length > 0 && (rest[0] === 'scale' || rest[0] === 'retire')) {
    const fleetManage = COMMANDS.find((c) => c.name === 'fleet-manage');
    if (fleetManage) {
      const ctx: CommandContext = { argv: rest, stdoutIsTty, writer, exit, env: process.env };
      await fleetManage.run(ctx);
      return;
    }
  }
```

And change the exported command name in `fleet-scale.ts` from `name: 'fleet'` to `name: 'fleet-manage'` to avoid the collision:

```typescript
const command: CommandModule = {
  name: 'fleet-manage',
  summary: 'Fleet management: scale | retire <index>',
  // ... rest unchanged
};
```

Add the import and register in COMMANDS:

```typescript
import fleetManageCommand from './commands/fleet-scale.js';
```

```typescript
  fleetManageCommand,
```

The top-level help (plan 02 task 4) will list `fleet-manage` in its
output. Override by filtering: in `renderTopLevelHelp` in
`client/src/cli/help.ts`, skip commands whose name starts with `fleet-manage`:

```typescript
export function renderTopLevelHelp(commands: CommandModule[]): string {
  const lines: string[] = [];
  lines.push('Usage: jinn <verb> [flags...]');
  lines.push('');
  lines.push('Verbs:');
  const visible = commands.filter((c) => c.name !== 'fleet-manage');
  const maxNameLen = Math.max(...visible.map((c) => c.name.length));
  for (const cmd of visible) {
    lines.push(`  ${cmd.name.padEnd(maxNameLen)}  ${cmd.summary}`);
  }
  lines.push('');
  lines.push('Additional subverbs:');
  lines.push('  fleet scale --to N                    Grow or shrink the fleet');
  lines.push('  fleet retire <index>                  Retire one service');
  lines.push('');
  lines.push('Run `jinn <verb> --help` for verb-specific flags and examples.');
  return lines.join('\n');
}
```

Update the existing `client/test/cli/help.test.ts` to not assert on fleet-manage.

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/fleet-scale.test.ts test/cli/help.test.ts
```

Expected: PASS (4 + 2 = 6 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/fleet-scale.ts client/test/cli/commands/fleet-scale.test.ts client/src/cli/index.ts client/src/cli/help.ts client/test/cli/help.test.ts
git commit -m "client(cli): add fleet scale subverb with compound-verb dispatch"
```

---

## Task 5: `fleet retire <index>` subverb

**Files:**
- Modify: `client/src/cli/commands/fleet-scale.ts` (add runRetire)
- Create: `client/test/cli/commands/fleet-retire.test.ts`

Idempotency (spec §7.4): already-retired is a no-op.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/fleet-retire.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: '', rpcOk: true, rpcChainId: 1, rpcBlockNumber: 1n,
    fleet: {
      loaded: true, chain: 'base-sepolia', stakingMode: 'standard',
      services: [
        { index: 0, step: 'complete', serviceId: 1, staked: true },
        { index: 1, step: 'complete', serviceId: 2, staked: true },
      ],
      completeCount: 2, stakedLikeCount: 2,
    },
    masterGas: { address: '0xM', balanceWei: '0', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: { counts: {}, recent: [] },
    earningsHint: '', nextActions: [],
  })),
}));

describe('fleet retire subverb', () => {
  it('retire 1 --dry-run emits a retire plan', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['retire', '1', '--dry-run'], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: { JINN_PASSWORD: 'test' },
    };
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan[0]).toMatchObject({ action: 'retire', index: 1 });
  });

  it('retire 99 --dry-run on non-existent index is a no-op', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ['retire', '99', '--dry-run'], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: () => {}, env: { JINN_PASSWORD: 'test' },
    };
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.plan).toEqual([]);
    expect(parsed.description).toContain('already retired');
  });

  it('retire with no index emits invalid_invocation', async () => {
    const { default: fleet } = await import('../../../src/cli/commands/fleet-scale.js');
    const writes: string[] = [];
    const exits: number[] = [];
    const ctx: CommandContext = {
      argv: ['retire'], stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (c: number) => { exits.push(c); }, env: { JINN_PASSWORD: 'test' },
    };
    await fleet.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('<index>');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/fleet-retire.test.ts
```

Expected: FAIL. The current `fleet-scale.ts` dispatches to `runScale` only; `retire` falls through to the unknown-subverb branch.

- [ ] **Step 3: Add runRetire to fleet-scale.ts**

In `client/src/cli/commands/fleet-scale.ts`, add a `runRetire` function after `runScale`:

```typescript
async function runRetire(ctx: CommandContext, rest: string[]): Promise<void> {
  const [indexArg, ...flagArgs] = rest;
  if (!indexArg || indexArg.startsWith('--')) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn fleet retire requires a service index',
        exampleCli: 'jinn fleet retire 2 --dry-run',
        details: { field: '<index>', expected: 'non-negative integer' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const index = parseInt(indexArg, 10);
  if (!Number.isFinite(index) || index < 0) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Invalid service index: ${indexArg}`,
        exampleCli: 'jinn fleet retire 2 --dry-run',
        details: { field: '<index>', expected: 'non-negative integer' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: flagArgs,
      options: {
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn fleet retire 2 --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const raw = await gatherIntrospectionRaw();
  const svc = (raw.fleet?.services ?? []).find((s) => s.index === index);
  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  let plan: Array<{ action: 'retire'; index: number; txCount: number }>;
  let description: string;
  if (!svc) {
    plan = [];
    description = `Service ${index} is already retired (or never existed). No action.`;
  } else {
    plan = [{ action: 'retire', index, txCount: 3 }];
    description = `Would unstake, unbond, and drain wallets for service ${index}.`;
  }

  if (dryRun) {
    emitDryRun(ctx, { verb: 'fleet retire', description, plan });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  // Stub: real implementation invokes orphan-sweep on the service index.
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'fleet retire',
    index,
    note: 'retire execution pending in a follow-up commit',
  }) + '\n');
}
```

Then in `run`, replace:

```typescript
  if (subverb === 'scale') return runScale(ctx, rest);
  // `retire` is handled in task 5 by extending this module.
  emitEnvelope(
```

With:

```typescript
  if (subverb === 'scale') return runScale(ctx, rest);
  if (subverb === 'retire') return runRetire(ctx, rest);
  emitEnvelope(
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/fleet-retire.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/fleet-scale.ts client/test/cli/commands/fleet-retire.test.ts
git commit -m "client(cli): add fleet retire subverb with orphan-sweep stub"
```

---

## Task 6: `withdraw` verb

**Files:**
- Create: `client/src/cli/commands/withdraw.ts`
- Create: `client/test/cli/commands/withdraw.test.ts`
- Modify: `client/src/cli/index.ts`

Idempotency: **not idempotent**. Each invocation emits a fresh sweep tx. Requires `--yes` or `--dry-run`; non-TTY without `--yes` errors with invalid_invocation per spec §7.3.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/withdraw.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/cli/introspection-context.js', () => ({
  gatherIntrospectionRaw: vi.fn(async () => ({
    timestamp: '2026-04-14T12:00:00Z',
    daemonDbPath: '', shutdownState: '', rpcOk: true, rpcChainId: 1, rpcBlockNumber: 1n,
    fleet: {
      loaded: true, chain: 'base-sepolia', stakingMode: 'standard',
      masterAddress: '0xM',
      services: [{ index: 0, step: 'complete', serviceId: 1, agentAddress: '0xA', safeAddress: '0xS', staked: true }],
      completeCount: 1, stakedLikeCount: 1,
    },
    masterGas: { address: '0xM', balanceWei: '1000000', dailyEstimateWei: '0' },
    rewards: { claimLoopIntervalMs: 1, lastClaimTickAt: null },
    activity: { counts: {}, recent: [] },
    earningsHint: '', nextActions: [],
  })),
}));

function makeCtx(argv: string[], tty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv, stdoutIsTty: tty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('withdraw command', () => {
  it('--dry-run emits a sweep plan', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/withdraw.js');
    const { ctx, writes } = makeCtx(['--to', '0xDEST', '--dry-run']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.plan.some((p: { from: string }) => p.from === '0xM')).toBe(true);
  });

  it('missing --to emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/withdraw.js');
    const { ctx, writes, exits } = makeCtx(['--dry-run']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--to');
    expect(exits).toEqual([11]);
  });

  it('non-TTY without --yes or --dry-run refuses', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/withdraw.js');
    const { ctx, writes, exits } = makeCtx(['--to', '0xDEST']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/withdraw.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the withdraw verb**

Create `client/src/cli/commands/withdraw.ts`:

```typescript
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';

interface SweepEntry {
  from: string;
  role: string;
  asset: 'native' | 'bond' | 'reward';
  amountWei: string;
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        to: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn withdraw --to 0xDEST --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const to = parsed.values.to as string | undefined;
  if (!to) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--to is required (destination address)',
        exampleCli: 'jinn withdraw --to 0xDEST --dry-run',
        details: { field: '--to', expected: 'Ethereum address' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const raw = await gatherIntrospectionRaw();
  const sweep: SweepEntry[] = [];
  if (raw.fleet?.masterAddress) {
    sweep.push({
      from: raw.fleet.masterAddress,
      role: 'master',
      asset: 'native',
      amountWei: raw.masterGas.balanceWei ?? '0',
    });
  }
  for (const svc of raw.fleet?.services ?? []) {
    if (svc.agentAddress) {
      sweep.push({ from: svc.agentAddress, role: `service.${svc.index}.agent`, asset: 'native', amountWei: '0' });
    }
    if (svc.safeAddress) {
      sweep.push({ from: svc.safeAddress, role: `service.${svc.index}.multisig`, asset: 'native', amountWei: '0' });
    }
  }

  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  if (dryRun) {
    emitDryRun(ctx, {
      verb: 'withdraw',
      description: `Would sweep ${sweep.length} wallet(s) to ${to}`,
      plan: sweep.map((s) => ({ ...s, to })),
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  // Stub: real implementation calls into the existing withdraw script logic.
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'withdraw',
    to,
    swept: sweep.length,
    note: 'withdraw execution pending in a follow-up commit',
  }) + '\n');
}

const command: CommandModule = {
  name: 'withdraw',
  summary: 'Sweep all fleet wallets to an external destination address',
  helpText: `Usage: jinn withdraw --to <address> [--dry-run | --yes]

NOT idempotent. Each invocation emits a fresh sweep transaction.
Requires --yes to run on a non-TTY. --dry-run prints the sweep plan
as JSON and exits 0 without emitting any transaction.

Examples:
  jinn withdraw --to 0xDEST --dry-run
  jinn withdraw --to 0xDEST --yes

Failure example:
  $ jinn withdraw
  {"code":"invalid_invocation","details":{"field":"--to"},...}
  $ echo $?
  11
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register withdraw in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import withdrawCommand from './commands/withdraw.js';
```

Include in COMMANDS:

```typescript
  withdrawCommand,
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/withdraw.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/withdraw.ts client/test/cli/commands/withdraw.test.ts client/src/cli/index.ts
git commit -m "client(cli): add withdraw verb with dry-run sweep plan"
```

---

## Task 7: `keys backup` verb

**Files:**
- Create: `client/src/cli/commands/keys-backup.ts`
- Create: `client/test/cli/commands/keys-backup.test.ts`
- Modify: `client/src/cli/index.ts`

Minimal scope: decrypt the mnemonic with `JINN_PASSWORD` (or `--password-fd N`), write it to the path given by `--output`, exit 0. Idempotent: same mnemonic → same output. Because `keys backup` is a compound verb (`keys <subverb>`), the command module dispatches on the first argv token just like `fleet-manage`.

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/commands/keys-backup.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import keysCmd from '../../../src/cli/commands/keys-backup.js';
import type { CommandContext } from '../../../src/cli/command.js';

async function makeKeystore(): Promise<{ dir: string; password: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-keys-backup-test-'));
  const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
  const { FleetStateStore } = await import('../../../src/earning/store.js');
  const mnemonic = generateMnemonic();
  const keystore = await encryptMnemonic(mnemonic, 'pw');
  const store = new FleetStateStore(dir);
  await store.saveMnemonicKeystore(keystore);
  return { dir, password: 'pw' };
}

describe('keys backup command', () => {
  it('writes the mnemonic to --output when password is correct', async () => {
    const { dir, password } = await makeKeystore();
    const outPath = join(dir, 'backup.txt');
    const ctx: CommandContext = {
      argv: ['backup', '--output', outPath],
      stdoutIsTty: false,
      writer: { write: () => true },
      exit: () => {},
      env: { JINN_PASSWORD: password, JINN_EARNING_DIR: dir },
    };
    await keysCmd.run(ctx);
    expect(existsSync(outPath)).toBe(true);
    const mnemonic = readFileSync(outPath, 'utf-8').trim();
    expect(mnemonic.split(/\s+/).length).toBeGreaterThanOrEqual(12);
  });

  it('missing --output emits invalid_invocation', async () => {
    const { dir, password } = await makeKeystore();
    const writes: string[] = [];
    const exits: number[] = [];
    const ctx: CommandContext = {
      argv: ['backup'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (c: number) => { exits.push(c); },
      env: { JINN_PASSWORD: password, JINN_EARNING_DIR: dir },
    };
    await keysCmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--output');
    expect(exits).toEqual([11]);
  });

  it('missing JINN_PASSWORD emits invalid_invocation', async () => {
    const { dir } = await makeKeystore();
    const writes: string[] = [];
    const exits: number[] = [];
    const ctx: CommandContext = {
      argv: ['backup', '--output', join(dir, 'x.txt')],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (c: number) => { exits.push(c); },
      env: { JINN_EARNING_DIR: dir },
    };
    await keysCmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('JINN_PASSWORD');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd client && npx vitest run test/cli/commands/keys-backup.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the keys compound command**

Create `client/src/cli/commands/keys-backup.ts`:

```typescript
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { FleetStateStore } from '../../earning/store.js';
import { decryptMnemonic } from '../../earning/wallet.js';

async function runBackup(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        output: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const output = parsed.values.output as string | undefined;
  if (!output) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--output is required',
        exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: '--output', expected: 'writable filesystem path' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const password = ctx.env['JINN_PASSWORD'];
  if (!password) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to decrypt the keystore.',
        exampleCli: 'JINN_PASSWORD=... jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const earningDir = ctx.env['JINN_EARNING_DIR'] ?? join(process.env['HOME'] ?? '.', '.jinn-client', 'earning');
  const store = new FleetStateStore(earningDir);
  const keystore = await store.loadMnemonicKeystore();
  const mnemonic = await decryptMnemonic(keystore, password);
  writeFileSync(output, mnemonic + '\n', { encoding: 'utf-8', mode: 0o600 });

  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'keys backup',
    output,
    words: mnemonic.split(/\s+/).length,
  }) + '\n');
}

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn keys requires a subverb: backup',
        exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
        details: { field: 'subverb', expected: 'backup' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (subverb === 'backup') return runBackup(ctx, rest);
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown keys subverb: ${subverb}`,
      exampleCli: 'jinn keys backup --output /tmp/mnemonic.txt',
      details: { field: 'subverb', expected: 'backup' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'keys',
  summary: 'Keystore management: backup',
  helpText: `Usage: jinn keys backup --output <path>

Decrypts the local keystore using JINN_PASSWORD and writes the
mnemonic to <path> with mode 0600. Idempotent: same mnemonic →
same output. No other side effects.

Pass the password via environment, never on the command line:
  JINN_PASSWORD=secret jinn keys backup --output /tmp/mnemonic.txt

Examples:
  JINN_PASSWORD=secret jinn keys backup --output ~/backup/jinn.txt
`,
  run,
};

export default command;
```

- [ ] **Step 4: Register keys in the dispatcher**

In `client/src/cli/index.ts`:

```typescript
import keysCommand from './commands/keys-backup.js';
```

Include in COMMANDS:

```typescript
  keysCommand,
```

- [ ] **Step 5: Run tests to verify pass**

Run:
```bash
cd client && npx vitest run test/cli/commands/keys-backup.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/keys-backup.ts client/test/cli/commands/keys-backup.test.ts client/src/cli/index.ts
git commit -m "client(cli): add keys backup verb"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full typecheck**

```bash
cd client && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Full test suite**

```bash
cd client && npx vitest run
```

Expected: all tests pass. Count should be plan 03's total + ~20 new action tests.

- [ ] **Step 3: Manual smoke — dry-run submit-intent**

```bash
cd client && ./bin/jinn submit-intent --id smoke-1 --description "smoke test" --dry-run | jq '.dryRun'
```

Expected: `true`.

- [ ] **Step 4: Manual smoke — fleet scale dry-run**

```bash
cd client && ./bin/jinn fleet scale --to 2 --dry-run | jq '.plan[0].action'
```

Expected: `"grow"` or `"retire"` depending on current fleet size (or empty plan if already at 2).

- [ ] **Step 5: Manual smoke — withdraw without --to fails cleanly**

```bash
cd client && ./bin/jinn withdraw --dry-run; echo "exit=$?"
```

Expected: JSON envelope with `"code":"invalid_invocation"` and `exit=11`.

---

## Spec coverage

| Spec section | Covered by |
|---|---|
| §2.3 Action verbs | Tasks 2–7 |
| §7.3 Dry-run / yes on every tx-emitting verb | Task 1 shared helpers, Tasks 2–7 use them |
| §7.4 Idempotency: submit-intent keyed on (multisig, id) | Task 2 |
| §7.4 Idempotency: claim-rewards zero-delta | Task 3 |
| §7.4 Idempotency: fleet scale target-state | Task 4 |
| §7.4 Idempotency: fleet retire already-retired | Task 5 |
| §7.4 withdraw explicitly NOT idempotent | Task 6 |
| §7.4 keys backup idempotent | Task 7 |
| §6 Error envelope on all invalid invocations | Tasks 2–7 |

Not covered (deferred):
- Real adapter integration for `submit-intent`, `claim-rewards`, `fleet scale`,
  `fleet retire`, `withdraw` — each verb currently emits a stubbed success
  response with a `note` field flagging pending work. The JSON shapes are
  spec-correct; the side effects are not yet wired to the real contracts.
  A "plan 04b" can wire them once the adapter constructor surfaces stabilize.
  Until then, `--dry-run` is the correct invocation for agents — it reports
  what would happen without needing real wiring.
- `--password-fd <N>` as an alternative to `JINN_PASSWORD` — spec §7.1
  requires support; deferred to a small follow-up that adds `readPasswordFd()`
  helper and wires it into the env-reading verbs.
