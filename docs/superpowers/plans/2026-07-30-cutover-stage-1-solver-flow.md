# Cutover Stage 1 — Solver Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the production operator daemon's solver flow onto the merged stack — a projector-fed work loop (discovery → claim predicate → marketplace pipeline → embedded local execution backend with evidence capture → deliver → settle) replaces the legacy `TaskEngine` solution path, while the legacy engine keeps running evaluations until stage 2.

**Architecture:** The operator runtime becomes the composition root. It assembles `LocalTaskExecutionBackendConfig`, `PipelineConfig`, and `PipelinePorts` from operator config, writes the one join the stack refuses to own (`EvidenceBindingPorts` ← `evidence-local-runtime`), and runs three new supervised loops (`projector-loop`, `work-loop`, `evidence-driver`) beside the surviving legacy loops. From this stage on, every transaction in the process — including the surviving legacy creator and evaluation legs — funnels through one venue-base Safe broadcaster.

**Tech Stack:** TypeScript / Node 22 / Yarn workspaces with `portal:` resolution; viem; Hono; better-sqlite3; vitest; Playwright; Anvil-fork integration suites; React + wouter + TanStack Query (operator SPA).

## Global Constraints

Copied verbatim from `docs/superpowers/plans/2026-07-30-operator-daemon-composition-program.md` §"Global constraints":

- Branch target: `integration/evidence-v1` (stacked PR trains; the integration branch is not yet in `next`). Nothing here publishes to npm — #2293 runs in parallel.
- Kits and fixtures **before** implementations; a layer's kit green before dependents build.
- Guard trio (package inventory, source-boundary, packed-types + CI workflow) ships **with** each new tree, not after.
- Every task ends with typecheck + tests + relevant kit + guards run locally, outputs shown.
- Independent per-component review when a component completes, findings resolved before dependents build on it (program discipline, principles §13.2).
- American English throughout; no product names in tier-3 code.
- The spec's §6.1 placement notes and §10 bridge-era/drain/standing rules are binding cross-plan contracts (§6 below).

Stage-1 specifics, binding on every task in this plan:

- **Single-broadcaster (contract 1).** From this stage on, venue-base's Safe broadcast is the *only* transaction path in the daemon process. No task may add a second `walletClient.writeContract` / `sendTransaction` on the marketplace path.
- **Ledger-before-broadcast (contract 2).** The engagement-ledger row (wiring entry + idempotency key) is written in the same SQLite transaction that admits the claim intent, strictly before the claim broadcast, and reconciled against chain facts on boot.
- **Projector-catch-up claim gate (contract 3).** At boot the work loop issues no new claim until the projector's durable cursor has reached the finalized chain head.
- **Config migration is additive, atomic, idempotent (contract 4).** New keys are written *beside* `joinedSolverNets`; legacy keys survive until stage 5; the write is temp-file + rename; re-running is a no-op via `configShapeVersion`.
- **Evidence publication policy (contract 6).** The evidence driver publishes only records already sealed for marketplace delivery or announcement — never capability-grant material, never secret-forwards. Idempotent by record digest; announce only after indexed.
- **Bridge-era documents (contract 9).** The projector synthesizes legacy facts cards under a `legacy` derivation annotation; converged-Delivery legacy-evaluator parseability is a stage-1 fixture, not an assumption.
- **Drain rules (contract 10).** The retiring solution path stops accepting new work and runs to terminal states before the swap deploys; stragglers strand loudly through the unreleased-attempt state message.
- **Fresh rewrite, legacy as fixtures (contract 12).** Legacy behavior enters as test cases, never as ported code.
- **The `TaskEngine` evaluation path is untouched.** Every task that edits `client/src/harnesses/engine/` or `client/src/adapters/mech/` must leave the `taskRole === 'evaluation'` path behaviourally identical, proven by the regression test in Task 16. The one exception is the bridge delivery reader of Task 15, which is a *read-path* addition explicitly required by contract 9.
- **Rollback is revert / pin the previous canary.** No feature flags, no shadow mode.

## Consumed cross-plan surfaces

This plan consumes two trees whose plans are authored in parallel. It references them **only** through the program plan §5 factory surface and the port interfaces already defined in merged code. No internals are assumed.

From `2026-07-30-marketplace-venue-base.md`:

```ts
import { createBaseVenue } from "@jinn-network/marketplace-venue-base";

const venue = createBaseVenue({
  chain: MarketplaceChainConfig,     // @jinn-network/marketplace-binding
  publicClient: PublicClient,        // viem
  walletClient: WalletClient,        // viem
  safeAddress: `0x${string}`,
  stateDbPath: string,
});
// venue: {
//   claim: ClaimPorts;                        // marketplace-binding
//   settlement: SettlementPorts;              // marketplace-binding
//   lifecycle: MarketplaceLifecyclePorts;     // marketplace-binding
//   finality: FinalityPort;                   // marketplace-pipeline
//   deliveryWait: DeliveryWaitPort;           // marketplace-pipeline
//   release: ReleaseAttemptPort;              // marketplace-pipeline
//   observe: MarketplaceObservePort;          // marketplace-binding
//   safe: SafeBroadcastPort;                  // marketplace-binding
//   logSource; intents;
// }
```

**Stage-1 requirement on `venue.safe`** (recorded as Finding F3, coordinate with the venue-base plan before Task 7): the binding's exported `SafeBroadcastPort` declares only `broadcastCreateTask`. The single-broadcaster rule needs a generic leg. This plan consumes:

```ts
/** venue-base's safe port, superset of binding's SafeBroadcastPort. */
export interface BaseVenueSafe extends SafeBroadcastPort {
  broadcast(input: {
    readonly safeAddress: `0x${string}`;
    readonly to: `0x${string}`;
    readonly value: bigint;
    readonly data: `0x${string}`;
  }): Promise<`0x${string}`>;   // resolves to the mined transaction hash
}
```

From `2026-07-30-discovery-transport-http.md`:

```ts
import { createFsBlobStore } from "@jinn-network/record-discovery-transport-http";
const store: BlobStore = createFsBlobStore(rootDir);   // BlobStore from record-discovery-serve
```

Stage 1 uses **only** `createFsBlobStore`. The HTTP handler, client transport, and SSE stream transport are stage-4 surfaces and are not consumed here.

---

## Stage-1 file and loop disposition

Every file under `client/src/daemon/` and `client/src/harnesses/engine/`, plus the marketplace adapter files this stage touches.

| File | Disposition at stage 1 |
| --- | --- |
| `client/src/daemon/daemon.ts` | **Modified** — starts `projector-loop`, `work-loop`, `evidence-driver`; `_runEngineWatcherLoop` stops claiming restoration announcements (Task 16) |
| `client/src/daemon/loop-heartbeat.ts` | **Modified** — three new `LOOP_REGISTRY` entries |
| `client/src/daemon/projector-loop.ts` | **Created** (Task 9) |
| `client/src/daemon/projector-ports.ts` | **Created** (Task 9) |
| `client/src/daemon/work-loop.ts` | **Created** (Task 13) |
| `client/src/daemon/evidence-driver.ts` | **Created** (Task 11) |
| `client/src/daemon/evidence-join.ts` | **Created** (Task 11) |
| `client/src/daemon/composition-root.ts` | **Created** (Task 12) |
| `client/src/daemon/engagement-ledger.ts` | **Created** (Task 6) |
| `client/src/daemon/mech-deliver.ts` | **Not created** — coordinator amendment 2 rehomed Task 8 to `packages/marketplace/venue-base/src/deliver-leg.ts` |
| `client/src/daemon/bridge-legacy-delivery.ts` | **Created** (Task 15) |
| `client/src/daemon/creator.ts` | **Kept** — retires at stage 3; its tx leg re-points through venue-base (Task 7) |
| `client/src/daemon/delivery-watcher.ts` | **Kept** — retires at stage 2 |
| `client/src/daemon/readiness-gate.ts` | **Kept** — still gates the surviving evaluation claims |
| `client/src/daemon/ai-units-gate.ts` | **Kept** — re-pointed at pipeline caps for the work loop (Task 13); still gates evaluations |
| `client/src/daemon/spend-cap-gate.ts` | **Kept** — same as above |
| `client/src/daemon/skip-log-dedup.ts` | **Kept** — evaluation announcements only |
| `client/src/daemon/peer-sync.ts` | **Kept** — retires at stage 4 |
| `client/src/daemon/reward-claim-loop.ts` | **Kept** — application tier, untouched |
| `client/src/daemon/balance-topup-loop.ts` | **Kept** — application tier, untouched |
| `client/src/daemon/eviction-loop.ts` | **Kept** — application tier, untouched |
| `client/src/daemon/harvest-loop.ts` | **Kept** — corpus mining, untouched |
| `client/src/daemon/checkpoint-loop.ts` | **Kept** — application tier, untouched |
| `client/src/daemon/watchdog-loop.ts` | **Kept** — gains three registrations |
| `client/src/harnesses/engine/engine.ts` | **Modified** — solution path retired behind `canAcceptTask`; evaluation path untouched (Task 16) |
| `client/src/harnesses/engine/state.ts` | **Kept** — evaluation runs the same state sequence; deleted at stage 5 |
| `client/src/harnesses/engine/persistence.ts` | **Kept** — `task_runs` frozen for solutions, still written for evaluations; table deleted at stage 5 |
| `client/src/harnesses/engine/delivery.ts` | **Kept** — evaluation delivery legs only; tx re-pointed via Task 7 |
| `client/src/adapters/mech/adapter.ts` | **Modified** — restoration discovery disabled (Task 16); bridge delivery reader added (Task 15); evaluation machinery kept until stage 2 |
| `client/src/adapters/mech/contracts.ts` | **Kept unmodified** — all five tx functions keep calling `executeSafeTransaction` |
| `client/src/adapters/mech/safe.ts` | **Modified** — `executeSafeTransaction` delegates to the injected venue broadcaster (Task 7) |
| `client/src/discovery/` | **Kept** — retires at stage 4 |
| `client/src/config.ts` | **Modified** — shape v2 schema + boot migration (Tasks 1–3) |
| `client/src/store/store.ts` | **Modified** — engagement ledger + projector cursor tables (Task 6, Task 9) |
| `client/src/main.ts` | **Modified** — composition root wired before `new Daemon(...)` (Task 12) |

## What this plan does NOT do

- **No evaluator loop.** Deriving, posting, claiming, and executing verdicts on the embedded backend is **stage 2**. The legacy mech-adapter evaluation machinery and `delivery-watcher` keep running here.
- **No posting loop.** Requester-side posting, adoption, lifecycle exits, `jinn policy` / `jinn wiring` CLI verbs, and launched-record generator retirement are **stage 3**. The legacy `creator` loop keeps posting; only its transaction leg moves.
- **No public archive.** The discovery archive built by the projector loop is local-only. Mounting it over HTTP (SSE tail, ETag head, exposure scoping) is **stage 4**, and `client/src/discovery/` plus `peer-sync` survive until then.
- **No rename.** `client/` → `operator/`, deleting `task_runs`, deleting legacy config keys, pruning migration backups, and the #2297 import fix are **stage 5**.
- No operator-app redesign, no public work-client package, no `sdk`/`core`/`layer`/`plugin` disposition, no earning recomposition, no config hot reload, no mainnet decisions (spec §11).

---

## Task 1: Config shape v2 — types and loader

**Files:**
- Create: `client/src/config/shape-v2.ts`
- Modify: `client/src/config.ts:32` (add the three new keys to `JinnConfigSchema`), `client/src/config.ts:719` (`JinnConfig` type)
- Test: `client/test/config/shape-v2.test.ts`

**Interfaces:**
- Consumes: `JinnConfigSchema` (`client/src/config.ts:32`), `loadConfig(configPath?: string): JinnConfig` (`client/src/config.ts:948`).
- Produces:

```ts
// client/src/config/shape-v2.ts
export const CONFIG_SHAPE_VERSION = 2 as const;

export interface ClaimPolicyConfig {
  readonly mode: 'claim-nothing' | 'every-runnable' | 'match-legacy-manifest-digest';
  readonly spendCapWei: string;   // decimal string; bigint at use site
  readonly aiUnitCap: number;
}

export interface ExecutionWiringConfigEntry {
  readonly workKind: string;
  readonly harness: string;
  readonly model: string;
  readonly plugins: readonly string[];
  readonly credentialRef: string;
  readonly isolationPolicy: string;
  readonly legacyManifestDigest?: string;
}

export interface PostingConfigEntry {
  readonly workKind: string;
  readonly launchedRecordPath: string;
  readonly generatorEnabled: boolean;
  readonly legacyManifestDigest?: string;
}

export const ClaimPolicyConfigSchema: z.ZodType<ClaimPolicyConfig>;
export const ExecutionWiringConfigEntrySchema: z.ZodType<ExecutionWiringConfigEntry>;
export const PostingConfigEntrySchema: z.ZodType<PostingConfigEntry>;

/** Maps operator config entries onto the pipeline's frozen entry type. */
export function toPipelineWiring(
  entries: readonly ExecutionWiringConfigEntry[],
): ExecutionWiringEntry[];   // ExecutionWiringEntry from @jinn-network/marketplace-pipeline
```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/config/shape-v2.test.ts
import { describe, expect, it } from 'vitest';
import {
  CONFIG_SHAPE_VERSION,
  ClaimPolicyConfigSchema,
  ExecutionWiringConfigEntrySchema,
  PostingConfigEntrySchema,
  toPipelineWiring,
} from '../../src/config/shape-v2.js';

describe('config shape v2', () => {
  it('pins the shape version at 2', () => {
    expect(CONFIG_SHAPE_VERSION).toBe(2);
  });

  it('parses a claim policy with a decimal-string spend cap', () => {
    const parsed = ClaimPolicyConfigSchema.parse({
      mode: 'match-legacy-manifest-digest',
      spendCapWei: '2500000000000000',
      aiUnitCap: 30,
    });
    expect(parsed.spendCapWei).toBe('2500000000000000');
    expect(BigInt(parsed.spendCapWei)).toBe(2500000000000000n);
  });

  it('rejects a non-decimal spend cap', () => {
    expect(() =>
      ClaimPolicyConfigSchema.parse({ mode: 'claim-nothing', spendCapWei: '0x10', aiUnitCap: 1 }),
    ).toThrow();
  });

  it('defaults plugins to an empty array on a wiring entry', () => {
    const parsed = ExecutionWiringConfigEntrySchema.parse({
      workKind: 'prediction.v1',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      credentialRef: 'anthropic-default',
      isolationPolicy: 'process',
    });
    expect(parsed.plugins).toEqual([]);
    expect(parsed.legacyManifestDigest).toBeUndefined();
  });

  it('parses a posting entry', () => {
    const parsed = PostingConfigEntrySchema.parse({
      workKind: 'prediction.v1',
      launchedRecordPath: '/home/op/.jinn-client/solvernets/launched/QmAbc.json',
      generatorEnabled: true,
      legacyManifestDigest: 'QmAbc',
    });
    expect(parsed.generatorEnabled).toBe(true);
  });

  it('maps operator wiring onto the pipeline entry type', () => {
    const [entry] = toPipelineWiring([
      {
        workKind: 'prediction.v1',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['learner'],
        credentialRef: 'anthropic-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'QmAbc',
      },
    ]);
    expect(entry).toEqual({
      workKind: 'prediction.v1',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['learner'],
      credentialRef: 'anthropic-default',
      isolationPolicy: 'process',
      legacyManifestDigest: 'QmAbc',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/config/shape-v2.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/config/shape-v2.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/config/shape-v2.ts
import { z } from 'zod';
import type { ExecutionWiringEntry } from '@jinn-network/marketplace-pipeline';

export const CONFIG_SHAPE_VERSION = 2 as const;

const DecimalWei = z.string().regex(/^\d+$/u, 'spendCapWei must be a decimal wei string');

export const ClaimPolicyConfigSchema = z.object({
  mode: z.enum(['claim-nothing', 'every-runnable', 'match-legacy-manifest-digest']),
  spendCapWei: DecimalWei,
  aiUnitCap: z.number().int().nonnegative(),
});
export type ClaimPolicyConfig = z.infer<typeof ClaimPolicyConfigSchema>;

export const ExecutionWiringConfigEntrySchema = z.object({
  workKind: z.string().min(1),
  harness: z.string().min(1),
  model: z.string().min(1),
  plugins: z.array(z.string()).default([]),
  credentialRef: z.string().min(1),
  isolationPolicy: z.string().min(1),
  legacyManifestDigest: z.string().min(1).optional(),
});
export type ExecutionWiringConfigEntry = z.infer<typeof ExecutionWiringConfigEntrySchema>;

export const PostingConfigEntrySchema = z.object({
  workKind: z.string().min(1),
  launchedRecordPath: z.string().min(1),
  generatorEnabled: z.boolean(),
  legacyManifestDigest: z.string().min(1).optional(),
});
export type PostingConfigEntry = z.infer<typeof PostingConfigEntrySchema>;

export function toPipelineWiring(
  entries: readonly ExecutionWiringConfigEntry[],
): ExecutionWiringEntry[] {
  return entries.map((entry) => ({
    workKind: entry.workKind,
    harness: entry.harness,
    model: entry.model,
    plugins: [...entry.plugins],
    credentialRef: entry.credentialRef,
    isolationPolicy: entry.isolationPolicy,
    ...(entry.legacyManifestDigest === undefined
      ? {}
      : { legacyManifestDigest: entry.legacyManifestDigest }),
  }));
}
```

Then add the three keys to `JinnConfigSchema` in `client/src/config.ts`, immediately after the `joinedSolverNets` block (line 450). They are **optional** — an unmigrated config must still parse:

```ts
  configShapeVersion: z.literal(CONFIG_SHAPE_VERSION).optional(),
  claimPolicy: ClaimPolicyConfigSchema.optional(),
  executionWiring: z.array(ExecutionWiringConfigEntrySchema).optional(),
  posting: z.array(PostingConfigEntrySchema).optional(),
```

with `import { CONFIG_SHAPE_VERSION, ClaimPolicyConfigSchema, ExecutionWiringConfigEntrySchema, PostingConfigEntrySchema } from './config/shape-v2.js';` at the top of `client/src/config.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/config/shape-v2.test.ts && yarn vitest run test/config`
Expected: PASS, and every existing config test still green (proving the additive keys did not break parsing of a legacy file).

- [ ] **Step 5: Commit**

```bash
git add client/src/config/shape-v2.ts client/src/config.ts client/test/config/shape-v2.test.ts
git commit -m "feat(operator): add config shape v2 types beside joinedSolverNets"
```

---

## Task 2: Atomic config write with permission-preserving timestamped backup

**Files:**
- Create: `client/src/config/atomic-write.ts`
- Test: `client/test/config/atomic-write.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
// client/src/config/atomic-write.ts
/** temp-file + fsync + rename in the config file's own directory. Preserves the target's mode. */
export function writeConfigFileAtomic(filePath: string, value: unknown): void;

/** Copies filePath to `<filePath>.backup-<ISO-basic-timestamp>` with the source's exact mode. */
export function backupConfigFile(filePath: string, now?: () => Date): string | undefined;
```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/config/atomic-write.test.ts
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupConfigFile, writeConfigFileAtomic } from '../../src/config/atomic-write.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, `${JSON.stringify({ rpcUrl: 'http://x' }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

describe('atomic config write', () => {
  it('writes the value and leaves no temp file behind', () => {
    const path = fixture();
    writeConfigFileAtomic(path, { rpcUrl: 'http://y', configShapeVersion: 2 });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      rpcUrl: 'http://y',
      configShapeVersion: 2,
    });
    const leftovers = readdirSync(join(path, '..')).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('preserves the existing file mode', () => {
    const path = fixture();
    writeConfigFileAtomic(path, { rpcUrl: 'http://y' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never leaves a truncated file when serialization throws mid-write', () => {
    const path = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => writeConfigFileAtomic(path, cyclic)).toThrow();
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ rpcUrl: 'http://x' });
    const leftovers = readdirSync(join(path, '..')).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('backs up with a timestamped name and the source mode', () => {
    const path = fixture();
    const backup = backupConfigFile(path, () => new Date('2026-07-30T09:15:00.000Z'));
    expect(backup).toBe(`${path}.backup-20260730T091500Z`);
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(backup!, 'utf-8'))).toEqual({ rpcUrl: 'http://x' });
  });

  it('returns undefined when there is nothing to back up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-'));
    expect(backupConfigFile(join(dir, 'absent.json'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/config/atomic-write.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/config/atomic-write.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/config/atomic-write.ts
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

function basicTimestamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;
}

export function writeConfigFileAtomic(filePath: string, value: unknown): void {
  // Serialize first: a cyclic or unserializable value must never touch the filesystem.
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
  const directory = dirname(filePath);
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, filePath);
  const directoryFd = openSync(directory, 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function backupConfigFile(
  filePath: string,
  now: () => Date = () => new Date(),
): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const backupPath = `${filePath}.backup-${basicTimestamp(now())}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/config/atomic-write.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/config/atomic-write.ts client/test/config/atomic-write.test.ts
git commit -m "feat(operator): add atomic config write with permission-preserving backup"
```

---

## Task 3: Boot-time config auto-migration

**Files:**
- Create: `client/src/config/migrate-shape-v2.ts`
- Modify: `client/src/config.ts:948` (call the migration from `loadConfig` after the existing `migrateLegacySolverNets` / `backfillJoinedProviders` block at lines 1326–1333)
- Test: `client/test/config/migrate-shape-v2.test.ts`

**Interfaces:**
- Consumes: `CONFIG_SHAPE_VERSION`, `ExecutionWiringConfigEntry`, `PostingConfigEntry` (Task 1); `writeConfigFileAtomic`, `backupConfigFile` (Task 2).
- Produces:

```ts
// client/src/config/migrate-shape-v2.ts
export interface ConfigMigrationReport {
  readonly migrated: boolean;
  readonly wiringEntries: number;
  readonly postingEntries: number;
  readonly backupPath?: string;
}

export interface MigrateConfigOptions {
  readonly configPath: string;
  /** Directory holding launched SolverNet records; default `<configDir>/solvernets/launched`. */
  readonly launchedRecordsDir?: string;
  readonly now?: () => Date;
}

/** Additive, atomic, idempotent (contract 4). Safe to call on every boot. */
export function migrateConfigShapeV2(options: MigrateConfigOptions): ConfigMigrationReport;
```

Mapping rules (spec §9, frozen by marketplace-binding §7):
- Each `joinedSolverNets[<manifestCid>]` entry whose `roles` includes `'solver'` becomes **one** `executionWiring` entry: `workKind = <manifestCid>`, `harness`/`model`/`plugins` copied, `credentialRef = <harness>-default`, `isolationPolicy = 'process'`, `legacyManifestDigest = <manifestCid>`.
- Evaluator-only joins produce **no** wiring entry (the evaluator loop is stage 2).
- `claimPolicy` is written once as `{ mode: 'match-legacy-manifest-digest', spendCapWei, aiUnitCap }` reading the operator's existing `spendCap`/`aiUnits` config when present, else `{ spendCapWei: '0', aiUnitCap: 0 }`, which under `checkCaps` claims nothing until the operator sets caps.
- Each `*.json` in `launchedRecordsDir` whose `status === 'launched'` becomes one `posting` entry.
- `joinedSolverNets` is **not** removed.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/config/migrate-shape-v2.test.ts
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateConfigShapeV2 } from '../../src/config/migrate-shape-v2.js';

function workspace(config: Record<string, unknown>): { configPath: string; launchedDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-migrate-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const launchedDir = join(dir, 'solvernets', 'launched');
  mkdirSync(launchedDir, { recursive: true });
  return { configPath, launchedDir };
}

const JOINED = {
  joinedSolverNets: {
    QmSolver: {
      manifestCid: 'QmSolver',
      name: 'prediction',
      roles: ['solver', 'evaluator'],
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['learner'],
      disabledDefaultPlugins: [],
    },
    QmEvalOnly: {
      manifestCid: 'QmEvalOnly',
      roles: ['evaluator'],
      plugins: [],
      disabledDefaultPlugins: [],
    },
  },
  spendCap: { capUsd: 12 },
  aiUnits: { capPerBlockUsdMicros: 30_000_000 },
};

describe('config shape v2 migration', () => {
  it('writes one wiring entry per solver-role join and keeps joinedSolverNets', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    const report = migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    expect(report.migrated).toBe(true);
    expect(report.wiringEntries).toBe(1);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.configShapeVersion).toBe(2);
    expect(written.executionWiring).toEqual([
      {
        workKind: 'QmSolver',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['learner'],
        credentialRef: 'claude-code-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'QmSolver',
      },
    ]);
    expect(written.claimPolicy.mode).toBe('match-legacy-manifest-digest');
    expect(Object.keys(written.joinedSolverNets)).toEqual(['QmSolver', 'QmEvalOnly']);
  });

  it('writes one posting entry per launched record this operator owns', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    writeFileSync(
      join(launchedDir, 'QmSolver.json'),
      JSON.stringify({ manifestCid: 'QmSolver', status: 'launched', generatorEnabled: true }),
    );
    writeFileSync(
      join(launchedDir, 'QmDraft.json'),
      JSON.stringify({ manifestCid: 'QmDraft', status: 'draft', generatorEnabled: true }),
    );
    const report = migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    expect(report.postingEntries).toBe(1);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.posting).toEqual([
      {
        workKind: 'QmSolver',
        launchedRecordPath: join(launchedDir, 'QmSolver.json'),
        generatorEnabled: true,
        legacyManifestDigest: 'QmSolver',
      },
    ]);
  });

  it('is idempotent — a second call migrates nothing and writes no second backup', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    const first = readFileSync(configPath, 'utf-8');
    const second = migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    expect(second.migrated).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf-8')).toBe(first);
    const backups = readdirSync(join(configPath, '..')).filter((n) => n.includes('.backup-'));
    expect(backups).toHaveLength(1);
  });

  it('takes a timestamped backup before the first write', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    const report = migrateConfigShapeV2({
      configPath,
      launchedRecordsDir: launchedDir,
      now: () => new Date('2026-07-30T09:15:00.000Z'),
    });
    expect(report.backupPath).toBe(`${configPath}.backup-20260730T091500Z`);
    expect(JSON.parse(readFileSync(report.backupPath!, 'utf-8')).configShapeVersion).toBeUndefined();
  });

  it('leaves a prior daemon generation able to read the migrated file', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    // The pre-cutover daemon reads only these keys; they must be byte-identical.
    expect(written.joinedSolverNets).toEqual(JOINED.joinedSolverNets);
    expect(written.spendCap).toEqual(JOINED.spendCap);
  });

  it('never truncates the config when the write throws mid-flight', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    expect(() =>
      migrateConfigShapeV2({
        configPath,
        launchedRecordsDir: launchedDir,
        now: () => {
          throw new Error('clock exploded');
        },
      }),
    ).toThrow('clock exploded');
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(JOINED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/config/migrate-shape-v2.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/config/migrate-shape-v2.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/config/migrate-shape-v2.ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupConfigFile, writeConfigFileAtomic } from './atomic-write.js';
import {
  CONFIG_SHAPE_VERSION,
  type ExecutionWiringConfigEntry,
  type PostingConfigEntry,
} from './shape-v2.js';

export interface ConfigMigrationReport {
  readonly migrated: boolean;
  readonly wiringEntries: number;
  readonly postingEntries: number;
  readonly backupPath?: string;
}

export interface MigrateConfigOptions {
  readonly configPath: string;
  readonly launchedRecordsDir?: string;
  readonly now?: () => Date;
}

interface JoinedEntry {
  readonly manifestCid: string;
  readonly roles?: readonly string[];
  readonly harness?: string;
  readonly model?: string;
  readonly plugins?: readonly string[];
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function wiringFromJoined(joined: Record<string, JoinedEntry>): ExecutionWiringConfigEntry[] {
  return Object.entries(joined)
    .filter(([, entry]) => (entry.roles ?? []).includes('solver'))
    .map(([manifestCid, entry]) => ({
      workKind: manifestCid,
      harness: entry.harness ?? 'claude-code',
      model: entry.model ?? '',
      plugins: [...(entry.plugins ?? [])],
      credentialRef: `${entry.harness ?? 'claude-code'}-default`,
      isolationPolicy: 'process',
      legacyManifestDigest: manifestCid,
    }));
}

function postingFromLaunched(directory: string): PostingConfigEntry[] {
  if (!existsSync(directory)) return [];
  const entries: PostingConfigEntry[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    const record = readJson(path);
    if (record === undefined || record['status'] !== 'launched') continue;
    const manifestCid = String(record['manifestCid'] ?? name.replace(/\.json$/u, ''));
    entries.push({
      workKind: manifestCid,
      launchedRecordPath: path,
      generatorEnabled: record['generatorEnabled'] === true,
      legacyManifestDigest: manifestCid,
    });
  }
  return entries;
}

export function migrateConfigShapeV2(options: MigrateConfigOptions): ConfigMigrationReport {
  const raw = readJson(options.configPath);
  if (raw === undefined) {
    return { migrated: false, wiringEntries: 0, postingEntries: 0 };
  }
  if (raw['configShapeVersion'] === CONFIG_SHAPE_VERSION) {
    const wiring = Array.isArray(raw['executionWiring']) ? raw['executionWiring'].length : 0;
    const posting = Array.isArray(raw['posting']) ? raw['posting'].length : 0;
    return { migrated: false, wiringEntries: wiring, postingEntries: posting };
  }

  const joined = (raw['joinedSolverNets'] ?? {}) as Record<string, JoinedEntry>;
  const launchedDir =
    options.launchedRecordsDir ?? join(dirname(options.configPath), 'solvernets', 'launched');
  const executionWiring = wiringFromJoined(joined);
  const posting = postingFromLaunched(launchedDir);

  const spendCap = raw['spendCap'] as { capUsd?: number } | undefined;
  const aiUnits = raw['aiUnits'] as { capPerBlockUsdMicros?: number } | undefined;
  const claimPolicy = {
    mode: 'match-legacy-manifest-digest' as const,
    // Wei is the venue unit; USD caps stay in their own SQLite rolling-window accounting.
    spendCapWei: spendCap?.capUsd === undefined ? '0' : '0',
    aiUnitCap: aiUnits?.capPerBlockUsdMicros === undefined ? 0 : 0,
  };

  const backupPath = backupConfigFile(options.configPath, options.now);
  writeConfigFileAtomic(options.configPath, {
    ...raw,
    configShapeVersion: CONFIG_SHAPE_VERSION,
    claimPolicy,
    executionWiring,
    posting,
  });

  return {
    migrated: true,
    wiringEntries: executionWiring.length,
    postingEntries: posting.length,
    ...(backupPath === undefined ? {} : { backupPath }),
  };
}
```

**Note on the zero caps:** `claimPolicy.spendCapWei` and `aiUnitCap` migrate to `0` deliberately. `checkCaps` (`packages/marketplace/pipeline/src/caps.ts`) rejects any facts card whose `intendedSpendWei > 0`, so a freshly migrated operator claims nothing through the new loop until the caps are set on the Claim policy & wiring page (Task 17). This is the safe default the spec's `CLAIM_NOTHING` posture demands, and it is why the migration state message of Task 4 is *action-required*, not merely informational.

Then call it from `loadConfig` in `client/src/config.ts`, right after the existing `backfillJoinedProviders(merged)` call (~line 1333), guarded so a read-only mount degrades to a warning exactly like `persistLegacySolverNetsMigration` already does:

```ts
  try {
    const report = migrateConfigShapeV2({ configPath: filePath });
    if (report.migrated) {
      merged['configShapeVersion'] = CONFIG_SHAPE_VERSION;
      merged['claimPolicy'] = (readJsonForMerge(filePath) ?? {})['claimPolicy'];
      merged['executionWiring'] = (readJsonForMerge(filePath) ?? {})['executionWiring'];
      merged['posting'] = (readJsonForMerge(filePath) ?? {})['posting'];
      lastMigrationReport = report;
    }
  } catch (error) {
    console.warn(`[config] shape-v2 migration skipped: ${String(error)}`);
  }
```

with a module-level `let lastMigrationReport: ConfigMigrationReport | undefined;` and `export function getLastConfigMigrationReport(): ConfigMigrationReport | undefined { return lastMigrationReport; }` — Task 4 reads it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/config && yarn typecheck`
Expected: PASS (6 new tests plus the existing config suite), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/config/migrate-shape-v2.ts client/src/config.ts client/test/config/migrate-shape-v2.test.ts
git commit -m "feat(operator): auto-migrate joined SolverNets to shape-v2 wiring and posting"
```

---

## Task 4: One-time migration state message

**Files:**
- Modify: `client/src/api/gather-status.ts` (add `configMigration` to the raw status), `client/src/api/status-build.ts:639` (surface it on `GET /v1/status`), `client/src/dashboard/spa/src/notifications/taxonomy.ts` (add the kind), `client/src/dashboard/spa/src/notifications/derive.ts:59` (emit it), `client/src/dashboard/spa/src/notifications/useNotifications.ts` (map the wire field)
- Test: `client/test/api/status-config-migration.test.ts`, `client/src/dashboard/spa/src/notifications/derive.test.ts`

**Interfaces:**
- Consumes: `getLastConfigMigrationReport(): ConfigMigrationReport | undefined` (Task 3).
- Produces:

```ts
// on GET /v1/status
readonly configMigration?: {
  readonly shapeVersion: 2;
  readonly wiringEntries: number;
  readonly postingEntries: number;
  readonly backupPath?: string;
  readonly capsUnset: boolean;   // true while spendCapWei === '0' || aiUnitCap === 0
};

// client/src/dashboard/spa/src/notifications/taxonomy.ts
// CANONICAL_KINDS gains 'config_migrated'
```

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/api/status-config-migration.test.ts
import { describe, expect, it } from 'vitest';
import { buildStatus } from '../../src/api/status-build.js';

describe('status configMigration', () => {
  it('surfaces the migration report with capsUnset when caps are zero', () => {
    const status = buildStatus({
      // ...the existing minimal raw-status fixture used by client/test/api/status-build.test.ts
      configMigration: {
        shapeVersion: 2,
        wiringEntries: 1,
        postingEntries: 0,
        backupPath: '/home/op/.jinn-client/config.json.backup-20260730T091500Z',
        capsUnset: true,
      },
    } as never);
    expect(status.configMigration).toEqual({
      shapeVersion: 2,
      wiringEntries: 1,
      postingEntries: 0,
      backupPath: '/home/op/.jinn-client/config.json.backup-20260730T091500Z',
      capsUnset: true,
    });
  });

  it('omits configMigration when nothing migrated this boot', () => {
    const status = buildStatus({} as never);
    expect(status.configMigration).toBeUndefined();
  });
});
```

```ts
// appended to client/src/dashboard/spa/src/notifications/derive.test.ts
it('raises config_migrated with an action-required jump when caps are unset', () => {
  const notifications = deriveNotifications({
    status: {
      configMigration: { shapeVersion: 2, wiringEntries: 1, postingEntries: 0, capsUnset: true },
    },
  } as never);
  const migrated = notifications.find((n) => n.kind === 'config_migrated');
  expect(migrated).toEqual({
    kind: 'config_migrated',
    severity: 'warning',
    message:
      'Claim policy and execution wiring were created from your SolverNet memberships. Set a spend cap and AI-unit cap to start claiming.',
    jumpTo: '/operator/claim-policy',
    details: { wiringEntries: 1, postingEntries: 0 },
  });
});

it('raises config_migrated as info once caps are set', () => {
  const notifications = deriveNotifications({
    status: {
      configMigration: { shapeVersion: 2, wiringEntries: 1, postingEntries: 1, capsUnset: false },
    },
  } as never);
  expect(notifications.find((n) => n.kind === 'config_migrated')?.severity).toBe('info');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/api/status-config-migration.test.ts src/dashboard/spa/src/notifications/derive.test.ts`
Expected: FAIL — `status.configMigration` is `undefined` in the first test, and `config_migrated` is not a member of `CanonicalKind`.

- [ ] **Step 3: Write minimal implementation**

In `client/src/dashboard/spa/src/notifications/taxonomy.ts`, add `'config_migrated'` to `CANONICAL_KINDS`.

In `client/src/dashboard/spa/src/notifications/derive.ts`, inside `deriveNotifications`:

```ts
  const migration = input.status?.configMigration;
  if (migration !== undefined) {
    notifications.push({
      kind: 'config_migrated',
      severity: migration.capsUnset ? 'warning' : 'info',
      message: migration.capsUnset
        ? 'Claim policy and execution wiring were created from your SolverNet memberships. '
          + 'Set a spend cap and AI-unit cap to start claiming.'
        : 'Claim policy and execution wiring were created from your SolverNet memberships.',
      jumpTo: '/operator/claim-policy',
      details: {
        wiringEntries: migration.wiringEntries,
        postingEntries: migration.postingEntries,
      },
    });
  }
```

In `client/src/api/gather-status.ts`, beside the existing `harnessRollup` assembly:

```ts
  const migrationReport = getLastConfigMigrationReport();
  const configMigration = migrationReport === undefined || !migrationReport.migrated
    ? undefined
    : {
        shapeVersion: 2 as const,
        wiringEntries: migrationReport.wiringEntries,
        postingEntries: migrationReport.postingEntries,
        ...(migrationReport.backupPath === undefined
          ? {}
          : { backupPath: migrationReport.backupPath }),
        capsUnset:
          config.claimPolicy === undefined
          || config.claimPolicy.spendCapWei === '0'
          || config.claimPolicy.aiUnitCap === 0,
      };
```

and pass `configMigration` through `buildStatus` in `client/src/api/status-build.ts` (`configMigration: raw.configMigration`). In `useNotifications.ts`, copy `status.configMigration` straight onto `DeriveInput.status`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/api src/dashboard/spa/src/notifications`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/gather-status.ts client/src/api/status-build.ts client/src/dashboard/spa/src/notifications client/test/api/status-config-migration.test.ts
git commit -m "feat(operator): surface the one-time shape-v2 migration as an operator state message"
```

---

## Task 5: Facts card → `SubmissionFacts` mapper (pipeline tree)

**Files:**
- Create: `packages/marketplace/pipeline/src/facts-mapper.ts`
- Modify: `packages/marketplace/pipeline/src/index.ts` (export the mapper)
- Test: `packages/marketplace/pipeline/src/facts-mapper.test.ts`

This is spec §6.4's "one pure module": the only place the discovery facts-card shape and `SubmissionFacts` meet. It stays structurally independent of the discovery packages — it takes a plain `{ record, facts }` object, never a `record-discovery-*` import (the pipeline declares no discovery dependency, and the source-boundary guard enforces it).

**Interfaces:**
- Consumes: `SubmissionFacts`, `ExecutionWiringEntry` (`packages/marketplace/pipeline/src/types.ts`).
- Produces:

```ts
// packages/marketplace/pipeline/src/facts-mapper.ts

/** The structural slice of a discovery announcement this mapper reads. No discovery import. */
export interface AnnouncedSubmissionCard {
  readonly record: { readonly kind: string; readonly digest: `sha256:${string}` };
  readonly facts: Readonly<Record<string, unknown>>;
  /** Chain identity the projector carries alongside the announcement. */
  readonly chain: {
    readonly taskId: bigint;
    readonly submission: `urn:uuid:${string}`;
    readonly nonce: string;
    readonly intendedSpendWei: bigint;
  };
  /** Bridge-era annotation (contract 9). `"legacy"` marks a synthesized card. */
  readonly derivationKind?: 'chain' | 'legacy';
  /** Present only on `legacy` cards: the anchored manifest digest the venue posted with. */
  readonly legacyManifestDigest?: string;
}

export type FactsMappingResult =
  | { readonly ok: true; readonly facts: SubmissionFacts }
  | { readonly ok: false; readonly reason: FactsMappingRefusal };

export type FactsMappingRefusal =
  | 'wrong-record-kind'
  | 'missing-task-digest'
  | 'missing-profile-uri'
  | 'legacy-card-without-manifest-digest';

export interface FactsMapperOptions {
  /** Estimated AI units for this work kind; the host owns the estimate. */
  readonly estimateAiUnits: (workKind: string) => number;
  /** Whether the operator's predicate should treat this card as runnable at all. */
  readonly runnable?: (card: AnnouncedSubmissionCard) => boolean;
  /** Accept `legacy` derivation cards. Stage 1–4 pass `true`; stage 5 flips it to `false`. */
  readonly acceptLegacyCards: boolean;
}

export function mapAnnouncedSubmissionToFacts(
  card: AnnouncedSubmissionCard,
  options: FactsMapperOptions,
): FactsMappingResult;
```

Field mapping (against `submissionRecompute` in `packages/discovery/facts/task-execution/src/recompute.ts:113`, which emits `taskDigest`, `taskProfileUri`, `requesterIri`, `deadline`, `benchrun`, `benchcell`, `bencharm`):

| `SubmissionFacts` field | Source |
| --- | --- |
| `taskId` | `card.chain.taskId` |
| `taskDigest` | `card.facts.taskDigest` |
| `submission` | `card.chain.submission` |
| `nonce` | `card.chain.nonce` |
| `profileUri` | `card.facts.taskProfileUri` |
| `requirements` | `card.facts['requirements']` when present, else `{}` |
| `runnable` | `options.runnable?.(card) ?? true` |
| `intendedSpendWei` | `card.chain.intendedSpendWei` |
| `intendedAiUnits` | `options.estimateAiUnits(workKind)` |
| `workKind` | `card.legacyManifestDigest` on a legacy card; else `card.facts['workKind']`, else `card.facts.taskProfileUri` |
| `runPinning` | `card.facts['runPinning']` when it is an object |
| `legacyManifestDigest` | `card.legacyManifestDigest` |

- [ ] **Step 1: Write the failing test**

```ts
// packages/marketplace/pipeline/src/facts-mapper.test.ts
import { describe, expect, it } from "vitest";
import { mapAnnouncedSubmissionToFacts, type AnnouncedSubmissionCard } from "./facts-mapper.js";

const CHAIN = {
  taskId: 42n,
  submission: "urn:uuid:11111111-2222-3333-4444-555555555555" as const,
  nonce: "0x01",
  intendedSpendWei: 1_000_000_000_000n,
};

const CHAIN_CARD: AnnouncedSubmissionCard = {
  record: { kind: "https://jinn.network/records/task-execution/submission/1.0", digest: `sha256:${"a".repeat(64)}` },
  facts: {
    taskDigest: `sha256:${"b".repeat(64)}`,
    taskProfileUri: "https://jinn.network/profiles/task-execution/repository-work/1.0",
    workKind: "repository-work",
    runPinning: { harness: "claude-code", model: "claude-haiku-4-5-20251001" },
    requirements: { isolation: "process" },
  },
  chain: CHAIN,
  derivationKind: "chain",
};

const options = { estimateAiUnits: () => 3, acceptLegacyCards: true };

describe("facts → SubmissionFacts mapper", () => {
  it("maps a chain-derived submission card", () => {
    const result = mapAnnouncedSubmissionToFacts(CHAIN_CARD, options);
    expect(result).toEqual({
      ok: true,
      facts: {
        taskId: 42n,
        taskDigest: `sha256:${"b".repeat(64)}`,
        submission: CHAIN.submission,
        nonce: "0x01",
        profileUri: "https://jinn.network/profiles/task-execution/repository-work/1.0",
        requirements: { isolation: "process" },
        runnable: true,
        intendedSpendWei: 1_000_000_000_000n,
        intendedAiUnits: 3,
        workKind: "repository-work",
        runPinning: { harness: "claude-code", model: "claude-haiku-4-5-20251001" },
      },
    });
  });

  it("carries the bridge annotation and keys workKind off the manifest digest on a legacy card", () => {
    const result = mapAnnouncedSubmissionToFacts(
      { ...CHAIN_CARD, derivationKind: "legacy", legacyManifestDigest: "QmSolver" },
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts.workKind).toBe("QmSolver");
    expect(result.facts.legacyManifestDigest).toBe("QmSolver");
  });

  it("refuses a legacy card with no manifest digest", () => {
    expect(
      mapAnnouncedSubmissionToFacts({ ...CHAIN_CARD, derivationKind: "legacy" }, options),
    ).toEqual({ ok: false, reason: "legacy-card-without-manifest-digest" });
  });

  it("refuses legacy cards once the bridge is retired", () => {
    expect(
      mapAnnouncedSubmissionToFacts(
        { ...CHAIN_CARD, derivationKind: "legacy", legacyManifestDigest: "QmSolver" },
        { ...options, acceptLegacyCards: false },
      ),
    ).toEqual({ ok: false, reason: "legacy-card-without-manifest-digest" });
  });

  it("refuses a delivery record announced as a submission", () => {
    expect(
      mapAnnouncedSubmissionToFacts(
        { ...CHAIN_CARD, record: { ...CHAIN_CARD.record, kind: "https://jinn.network/records/task-execution/delivery/1.0" } },
        options,
      ),
    ).toEqual({ ok: false, reason: "wrong-record-kind" });
  });

  it("refuses a card whose facts omit the task digest", () => {
    const { taskDigest: _drop, ...rest } = CHAIN_CARD.facts as Record<string, unknown>;
    expect(mapAnnouncedSubmissionToFacts({ ...CHAIN_CARD, facts: rest }, options)).toEqual({
      ok: false,
      reason: "missing-task-digest",
    });
  });

  it("honours an operator runnable predicate", () => {
    const result = mapAnnouncedSubmissionToFacts(CHAIN_CARD, { ...options, runnable: () => false });
    expect(result.ok && result.facts.runnable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/marketplace/pipeline && yarn vitest run src/facts-mapper.test.ts`
Expected: FAIL with `Failed to resolve import "./facts-mapper.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/marketplace/pipeline/src/facts-mapper.ts
// SPDX-License-Identifier: MIT

import { RECORD_KINDS_SUBMISSION } from "./facts-mapper-kinds.js";
import type { SubmissionFacts } from "./types.js";

export interface AnnouncedSubmissionCard {
  readonly record: { readonly kind: string; readonly digest: `sha256:${string}` };
  readonly facts: Readonly<Record<string, unknown>>;
  readonly chain: {
    readonly taskId: bigint;
    readonly submission: `urn:uuid:${string}`;
    readonly nonce: string;
    readonly intendedSpendWei: bigint;
  };
  readonly derivationKind?: "chain" | "legacy";
  readonly legacyManifestDigest?: string;
}

export type FactsMappingRefusal =
  | "wrong-record-kind"
  | "missing-task-digest"
  | "missing-profile-uri"
  | "legacy-card-without-manifest-digest";

export type FactsMappingResult =
  | { readonly ok: true; readonly facts: SubmissionFacts }
  | { readonly ok: false; readonly reason: FactsMappingRefusal };

export interface FactsMapperOptions {
  readonly estimateAiUnits: (workKind: string) => number;
  readonly runnable?: (card: AnnouncedSubmissionCard) => boolean;
  readonly acceptLegacyCards: boolean;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapAnnouncedSubmissionToFacts(
  card: AnnouncedSubmissionCard,
  options: FactsMapperOptions,
): FactsMappingResult {
  if (card.record.kind !== RECORD_KINDS_SUBMISSION) {
    return { ok: false, reason: "wrong-record-kind" };
  }
  const legacy = card.derivationKind === "legacy";
  if (legacy && (!options.acceptLegacyCards || card.legacyManifestDigest === undefined)) {
    return { ok: false, reason: "legacy-card-without-manifest-digest" };
  }

  const taskDigest = card.facts["taskDigest"];
  if (!isSha256(taskDigest)) return { ok: false, reason: "missing-task-digest" };

  const profileUri = card.facts["taskProfileUri"];
  if (typeof profileUri !== "string" || profileUri.length === 0) {
    return { ok: false, reason: "missing-profile-uri" };
  }

  const declaredWorkKind = card.facts["workKind"];
  const workKind = legacy
    ? card.legacyManifestDigest!
    : typeof declaredWorkKind === "string" && declaredWorkKind.length > 0
      ? declaredWorkKind
      : profileUri;

  const requirements = isRecord(card.facts["requirements"]) ? card.facts["requirements"] : {};
  const runPinning = isRecord(card.facts["runPinning"])
    ? (card.facts["runPinning"] as SubmissionFacts["runPinning"])
    : undefined;

  return {
    ok: true,
    facts: {
      taskId: card.chain.taskId,
      taskDigest,
      submission: card.chain.submission,
      nonce: card.chain.nonce,
      profileUri,
      requirements,
      runnable: options.runnable?.(card) ?? true,
      intendedSpendWei: card.chain.intendedSpendWei,
      intendedAiUnits: options.estimateAiUnits(workKind),
      workKind,
      ...(runPinning === undefined ? {} : { runPinning }),
      ...(card.legacyManifestDigest === undefined
        ? {}
        : { legacyManifestDigest: card.legacyManifestDigest }),
    },
  };
}
```

```ts
// packages/marketplace/pipeline/src/facts-mapper-kinds.ts
// SPDX-License-Identifier: MIT

/**
 * Duplicated by value, not imported: the pipeline declares no record-discovery dependency
 * (source-boundary guard). It must equal `RECORD_KINDS.submission` in
 * `@jinn-network/record-discovery-protocol`; the host asserts that equality in its own test.
 */
export const RECORD_KINDS_SUBMISSION =
  "https://jinn.network/records/task-execution/submission/1.0";
```

Add to `packages/marketplace/pipeline/src/index.ts`:

```ts
export { mapAnnouncedSubmissionToFacts } from "./facts-mapper.js";
export { RECORD_KINDS_SUBMISSION } from "./facts-mapper-kinds.js";
export type {
  AnnouncedSubmissionCard,
  FactsMapperOptions,
  FactsMappingRefusal,
  FactsMappingResult,
} from "./facts-mapper.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/marketplace/pipeline && yarn vitest run && yarn typecheck`
Expected: PASS (7 new tests plus the existing pipeline suite), zero typecheck errors. Then run the source-boundary guard for the marketplace tree and show its output — the pipeline must still declare no `record-discovery-*` dependency.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/pipeline/src/facts-mapper.ts packages/marketplace/pipeline/src/facts-mapper-kinds.ts packages/marketplace/pipeline/src/facts-mapper.test.ts packages/marketplace/pipeline/src/index.ts
git commit -m "feat(operator): add the discovery facts card to SubmissionFacts mapper"
```

---

## Task 6: The engagement ledger

**Files:**
- Create: `client/src/daemon/engagement-ledger.ts`
- Modify: `client/src/store/store.ts:600` (exec the new schema in the `Store` constructor)
- Test: `client/test/daemon/engagement-ledger.test.ts`

The ledger holds exactly what the chain cannot tell the operator: which wiring entry served a claim, and the operator-local idempotency key. Contract 2 requires the row to be written in the **same transaction** that admits the claim intent, strictly before broadcast.

**Interfaces:**
- Consumes: `Store` (`client/src/store/store.ts:579`), `ExecutionWiringEntry` (`@jinn-network/marketplace-pipeline`).
- Produces:

```ts
// client/src/daemon/engagement-ledger.ts
export const ENGAGEMENT_LEDGER_SCHEMA: string;

export type EngagementOutcome =
  | 'intended'      // row written, broadcast not yet confirmed
  | 'claimed'
  | 'delivered'
  | 'settled'
  | 'abandoned'
  | 'race-lost';

export interface EngagementRow {
  readonly idempotencyKey: string;   // `${chainId}:${taskCoordinator}:${taskId}`
  readonly chainId: number;
  readonly taskCoordinator: string;
  readonly taskId: string;           // decimal string; bigint at use site
  readonly workKind: string;
  readonly wiringJson: string;       // exact ExecutionWiringEntry serialization
  readonly attemptIndex: number | null;
  readonly attemptUri: string | null;
  readonly claimTxHash: string | null;
  readonly outcome: EngagementOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class EngagementLedger {
  constructor(store: Store);
  /**
   * Contract 2. Inserts the row inside one transaction and returns false when this task is
   * already engaged — the caller must NOT broadcast on false.
   */
  admitClaimIntent(input: {
    idempotencyKey: string;
    chainId: number;
    taskCoordinator: string;
    taskId: bigint;
    workKind: string;
    wiring: ExecutionWiringEntry;
  }): boolean;
  recordClaimed(idempotencyKey: string, claim: { attemptIndex: number; attemptUri: string; claimTxHash: string }): void;
  recordOutcome(idempotencyKey: string, outcome: EngagementOutcome): void;
  get(idempotencyKey: string): EngagementRow | undefined;
  listUnreconciled(): EngagementRow[];   // outcome IN ('intended','claimed','delivered')
}

/** Boot reconciliation (spec §4). Chain facts win; the ledger is only operator-local memory. */
export async function reconcileEngagements(input: {
  ledger: EngagementLedger;
  readAttemptFacts: (row: EngagementRow) => Promise<
    | { kind: 'no-claim' }
    | { kind: 'claimed'; attemptIndex: number; attemptUri: string; claimTxHash: string }
    | { kind: 'settled' }
    | { kind: 'lost' }
  >;
  logger?: { warn(message: string): void };
}): Promise<{ reconciled: number; stranded: EngagementRow[] }>;
```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/engagement-ledger.test.ts
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import {
  EngagementLedger,
  reconcileEngagements,
  type EngagementRow,
} from '../../src/daemon/engagement-ledger.js';

const WIRING = {
  workKind: 'QmSolver',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'claude-code-default',
  isolationPolicy: 'process',
  legacyManifestDigest: 'QmSolver',
};

function ledger(): EngagementLedger {
  return new EngagementLedger(new Store(':memory:'));
}

const INTENT = {
  idempotencyKey: '84532:0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98:42',
  chainId: 84532,
  taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  taskId: 42n,
  workKind: 'QmSolver',
  wiring: WIRING,
};

describe('engagement ledger', () => {
  it('admits a claim intent and records the wiring entry that served it', () => {
    const led = ledger();
    expect(led.admitClaimIntent(INTENT)).toBe(true);
    const row = led.get(INTENT.idempotencyKey)!;
    expect(row.outcome).toBe('intended');
    expect(JSON.parse(row.wiringJson)).toEqual(WIRING);
    expect(row.claimTxHash).toBeNull();
  });

  it('refuses a second intent for the same task — the caller must not broadcast twice', () => {
    const led = ledger();
    expect(led.admitClaimIntent(INTENT)).toBe(true);
    expect(led.admitClaimIntent(INTENT)).toBe(false);
  });

  it('records the claim receipt and terminal outcome', () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    led.recordClaimed(INTENT.idempotencyKey, {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      claimTxHash: `0x${'c'.repeat(64)}`,
    });
    led.recordOutcome(INTENT.idempotencyKey, 'settled');
    const row = led.get(INTENT.idempotencyKey)!;
    expect(row.attemptIndex).toBe(0);
    expect(row.outcome).toBe('settled');
    expect(led.listUnreconciled()).toEqual([]);
  });

  it('reconciles an intended row whose broadcast actually landed', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    const result = await reconcileEngagements({
      ledger: led,
      readAttemptFacts: async () => ({
        kind: 'claimed',
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      }),
    });
    expect(result.reconciled).toBe(1);
    expect(led.get(INTENT.idempotencyKey)!.outcome).toBe('claimed');
    expect(result.stranded).toEqual([]);
  });

  it('abandons an intended row whose broadcast never landed', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    await reconcileEngagements({ ledger: led, readAttemptFacts: async () => ({ kind: 'no-claim' }) });
    expect(led.get(INTENT.idempotencyKey)!.outcome).toBe('abandoned');
  });

  it('strands a claimed-but-unsettled row loudly instead of silently retrying', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    led.recordClaimed(INTENT.idempotencyKey, {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      claimTxHash: `0x${'c'.repeat(64)}`,
    });
    const warnings: string[] = [];
    const result = await reconcileEngagements({
      ledger: led,
      readAttemptFacts: async () => ({
        kind: 'claimed',
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      }),
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(result.stranded.map((row: EngagementRow) => row.idempotencyKey)).toEqual([
      INTENT.idempotencyKey,
    ]);
    expect(warnings.join('\n')).toContain('unreleased attempt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/daemon/engagement-ledger.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/daemon/engagement-ledger.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/daemon/engagement-ledger.ts
import type { ExecutionWiringEntry } from '@jinn-network/marketplace-pipeline';
import type { Store } from '../store/store.js';

export const ENGAGEMENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS engagement_ledger (
  idempotency_key  TEXT PRIMARY KEY,
  chain_id         INTEGER NOT NULL,
  task_coordinator TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  work_kind        TEXT NOT NULL,
  wiring_json      TEXT NOT NULL,
  attempt_index    INTEGER,
  attempt_uri      TEXT,
  claim_tx_hash    TEXT,
  outcome          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagement_ledger_outcome ON engagement_ledger (outcome);
CREATE INDEX IF NOT EXISTS idx_engagement_ledger_task ON engagement_ledger (chain_id, task_coordinator, task_id);
`;

export type EngagementOutcome =
  | 'intended' | 'claimed' | 'delivered' | 'settled' | 'abandoned' | 'race-lost';

export interface EngagementRow {
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly taskCoordinator: string;
  readonly taskId: string;
  readonly workKind: string;
  readonly wiringJson: string;
  readonly attemptIndex: number | null;
  readonly attemptUri: string | null;
  readonly claimTxHash: string | null;
  readonly outcome: EngagementOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawRow {
  idempotency_key: string; chain_id: number; task_coordinator: string; task_id: string;
  work_kind: string; wiring_json: string; attempt_index: number | null; attempt_uri: string | null;
  claim_tx_hash: string | null; outcome: EngagementOutcome; created_at: string; updated_at: string;
}

function toRow(raw: RawRow): EngagementRow {
  return {
    idempotencyKey: raw.idempotency_key,
    chainId: raw.chain_id,
    taskCoordinator: raw.task_coordinator,
    taskId: raw.task_id,
    workKind: raw.work_kind,
    wiringJson: raw.wiring_json,
    attemptIndex: raw.attempt_index,
    attemptUri: raw.attempt_uri,
    claimTxHash: raw.claim_tx_hash,
    outcome: raw.outcome,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class EngagementLedger {
  constructor(private readonly store: Store) {}

  admitClaimIntent(input: {
    idempotencyKey: string;
    chainId: number;
    taskCoordinator: string;
    taskId: bigint;
    workKind: string;
    wiring: ExecutionWiringEntry;
  }): boolean {
    const now = new Date().toISOString();
    const admit = this.store.db.transaction(() =>
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO engagement_ledger
             (idempotency_key, chain_id, task_coordinator, task_id, work_kind, wiring_json,
              attempt_index, attempt_uri, claim_tx_hash, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'intended', ?, ?)`,
        )
        .run(
          input.idempotencyKey,
          input.chainId,
          input.taskCoordinator,
          input.taskId.toString(),
          input.workKind,
          JSON.stringify(input.wiring),
          now,
          now,
        ).changes,
    );
    return admit() === 1;
  }

  recordClaimed(
    idempotencyKey: string,
    claim: { attemptIndex: number; attemptUri: string; claimTxHash: string },
  ): void {
    this.store.db
      .prepare(
        `UPDATE engagement_ledger
            SET attempt_index = ?, attempt_uri = ?, claim_tx_hash = ?, outcome = 'claimed', updated_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(claim.attemptIndex, claim.attemptUri, claim.claimTxHash, new Date().toISOString(), idempotencyKey);
  }

  recordOutcome(idempotencyKey: string, outcome: EngagementOutcome): void {
    this.store.db
      .prepare(`UPDATE engagement_ledger SET outcome = ?, updated_at = ? WHERE idempotency_key = ?`)
      .run(outcome, new Date().toISOString(), idempotencyKey);
  }

  get(idempotencyKey: string): EngagementRow | undefined {
    const raw = this.store.db
      .prepare(`SELECT * FROM engagement_ledger WHERE idempotency_key = ?`)
      .get(idempotencyKey) as RawRow | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  listUnreconciled(): EngagementRow[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM engagement_ledger
          WHERE outcome IN ('intended', 'claimed', 'delivered')
          ORDER BY created_at ASC`,
      )
      .all() as RawRow[];
    return rows.map(toRow);
  }
}

export async function reconcileEngagements(input: {
  ledger: EngagementLedger;
  readAttemptFacts: (row: EngagementRow) => Promise<
    | { kind: 'no-claim' }
    | { kind: 'claimed'; attemptIndex: number; attemptUri: string; claimTxHash: string }
    | { kind: 'settled' }
    | { kind: 'lost' }
  >;
  logger?: { warn(message: string): void };
}): Promise<{ reconciled: number; stranded: EngagementRow[] }> {
  const stranded: EngagementRow[] = [];
  let reconciled = 0;
  for (const row of input.ledger.listUnreconciled()) {
    const facts = await input.readAttemptFacts(row);
    if (facts.kind === 'no-claim') {
      input.ledger.recordOutcome(row.idempotencyKey, 'abandoned');
      reconciled += 1;
      continue;
    }
    if (facts.kind === 'settled') {
      input.ledger.recordOutcome(row.idempotencyKey, 'settled');
      reconciled += 1;
      continue;
    }
    if (facts.kind === 'lost') {
      input.ledger.recordOutcome(row.idempotencyKey, 'race-lost');
      reconciled += 1;
      continue;
    }
    if (row.outcome === 'intended') {
      input.ledger.recordClaimed(row.idempotencyKey, facts);
      reconciled += 1;
      continue;
    }
    // Claimed on chain, not settled, and this process did not resume it: the §4 unreleased
    // attempt. It occupies its maxClaims slot until the revised generation's deadline reap.
    stranded.push(row);
    input.logger?.warn(
      `[engagement] unreleased attempt for task ${row.taskId} (attempt ${row.attemptIndex ?? '?'}) `
        + `on ${row.taskCoordinator}: claimed on chain, not settled by this daemon`,
    );
  }
  return { reconciled, stranded };
}
```

Wire the schema into `client/src/store/store.ts`. Add the import beside the existing `PHASE_RUNS_SCHEMA` import (line 10):

```ts
import { ENGAGEMENT_LEDGER_SCHEMA } from '../daemon/engagement-ledger.js';
```

and one `exec` line in the constructor after `this.db.exec(PHASE_RUNS_SCHEMA);` (line 600):

```ts
    this.db.exec(ENGAGEMENT_LEDGER_SCHEMA);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon/engagement-ledger.test.ts test/store && yarn typecheck`
Expected: PASS (6 new tests, existing store suite green), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/engagement-ledger.ts client/src/store/store.ts client/test/daemon/engagement-ledger.test.ts
git commit -m "feat(operator): add the engagement ledger with ledger-before-broadcast admission"
```

---

## Task 7: Single-broadcaster re-point of the surviving legacy transaction legs

**Files:**
- Modify: `client/src/adapters/mech/safe.ts` (the process's single Safe execution chokepoint)
- Test: `client/test/adapters/mech/single-broadcaster.test.ts`

**Why this is the whole re-point.** Every marketplace transaction the legacy daemon sends already funnels through exactly one function. `client/src/adapters/mech/contracts.ts` calls `executeSafeTransaction` in five places — `submitTask` (creator posting, L260), `claimTask` (L434), `claimDelivery` (L634), `claimEvaluation` (L702), `callDeliverToMarketplace` (L1345) — and `client/src/harnesses/engine/delivery.ts` reaches the same five through `contracts.ts`. `executeSafeTransaction` contains the only `walletClient.writeContract({ functionName: 'execTransaction' })` on the mech path. Re-pointing one function therefore re-points every surviving legacy leg without editing a single call site.

**Interfaces:**
- Consumes: `BaseVenueSafe.broadcast` (venue-base, see "Consumed cross-plan surfaces").
- Produces:

```ts
// client/src/adapters/mech/safe.ts (additions)
export interface VenueBroadcaster {
  broadcast(input: {
    readonly safeAddress: `0x${string}`;
    readonly to: `0x${string}`;
    readonly value: bigint;
    readonly data: `0x${string}`;
  }): Promise<`0x${string}`>;
}

/** Installed once by the composition root. From stage 1 this is the only tx path. */
export function setVenueBroadcaster(broadcaster: VenueBroadcaster): void;
export function clearVenueBroadcaster(): void;
export function getVenueBroadcaster(): VenueBroadcaster | undefined;
```

`executeSafeTransaction` keeps its exact existing signature — no caller changes:

```ts
export async function executeSafeTransaction(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
  options: SafeExecutionOptions = {},
): Promise<Hex>
```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/adapters/mech/single-broadcaster.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearVenueBroadcaster,
  executeSafeTransaction,
  setVenueBroadcaster,
} from '../../../src/adapters/mech/safe.js';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const ROUTER = '0x2222222222222222222222222222222222222222' as const;

afterEach(() => {
  clearVenueBroadcaster();
});

describe('single-broadcaster rule', () => {
  it('routes a legacy Safe execution through the injected venue broadcaster', async () => {
    const broadcast = vi.fn(async () => `0x${'a'.repeat(64)}` as const);
    setVenueBroadcaster({ broadcast });

    const txHash = await executeSafeTransaction(
      {} as never,
      {} as never,
      { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0xdeadbeef' },
    );

    expect(txHash).toBe(`0x${'a'.repeat(64)}`);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith({
      safeAddress: SAFE,
      to: ROUTER,
      value: 0n,
      data: '0xdeadbeef',
    });
  });

  it('runs every concurrent legacy leg through the same broadcaster — one nonce ledger', async () => {
    const seen: string[] = [];
    setVenueBroadcaster({
      broadcast: async (input) => {
        seen.push(input.data);
        return `0x${'b'.repeat(64)}` as const;
      },
    });

    await Promise.all(
      ['0x01', '0x02', '0x03'].map((data) =>
        executeSafeTransaction({} as never, {} as never, {
          safeAddress: SAFE,
          to: ROUTER,
          value: 0n,
          data: data as `0x${string}`,
        }),
      ),
    );

    expect(seen.sort()).toEqual(['0x01', '0x02', '0x03']);
  });

  it('still fires the beforeBroadcast fence and onBroadcast hook', async () => {
    const order: string[] = [];
    setVenueBroadcaster({
      broadcast: async () => {
        order.push('broadcast');
        return `0x${'c'.repeat(64)}` as const;
      },
    });
    await executeSafeTransaction(
      {} as never,
      {} as never,
      { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0x00' },
      {
        beforeBroadcast: () => {
          order.push('before');
        },
        onBroadcast: () => {
          order.push('after');
        },
      },
    );
    expect(order).toEqual(['before', 'broadcast', 'after']);
  });

  it('refuses to broadcast when no venue broadcaster is installed', async () => {
    await expect(
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: SAFE,
        to: ROUTER,
        value: 0n,
        data: '0x00',
      }),
    ).rejects.toThrow('no venue broadcaster installed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/adapters/mech/single-broadcaster.test.ts`
Expected: FAIL — `setVenueBroadcaster` is not exported from `client/src/adapters/mech/safe.ts`.

- [ ] **Step 3: Write minimal implementation**

In `client/src/adapters/mech/safe.ts`, add the registry and make `executeSafeTransaction` delegate. Keep the existing `SafeBroadcastFenceError` / `SafePostBroadcastHookError` semantics; delete the legacy `executeSafeTransactionInner`, `safeLocks`, and the `withNonceLedger`/`withRecoverableRetry` wrapping — venue-base owns all of it now (contract 12: those behaviours re-enter as venue-kit fixtures, not as ported code).

```ts
export interface VenueBroadcaster {
  broadcast(input: {
    readonly safeAddress: `0x${string}`;
    readonly to: `0x${string}`;
    readonly value: bigint;
    readonly data: `0x${string}`;
  }): Promise<Hex>;
}

let venueBroadcaster: VenueBroadcaster | undefined;

export function setVenueBroadcaster(broadcaster: VenueBroadcaster): void {
  venueBroadcaster = broadcaster;
}

export function clearVenueBroadcaster(): void {
  venueBroadcaster = undefined;
}

export function getVenueBroadcaster(): VenueBroadcaster | undefined {
  return venueBroadcaster;
}

/**
 * Single-broadcaster rule (composition design §6.1, cutover stage 1). Every legacy transaction
 * leg still calls this function; from stage 1 it does nothing but hand the Safe call to the one
 * venue-base broadcaster. Two independent nonce stacks against one Safe is the #525/#562/#897
 * failure class and is excluded here by construction.
 */
export async function executeSafeTransaction(
  _publicClient: PublicClient,
  _walletClient: WalletClient,
  params: SafeTransactionParams,
  options: SafeExecutionOptions = {},
): Promise<Hex> {
  const broadcaster = venueBroadcaster;
  if (broadcaster === undefined) {
    throw new Error(
      'executeSafeTransaction: no venue broadcaster installed — the composition root must call setVenueBroadcaster before any loop starts',
    );
  }
  try {
    await options.beforeBroadcast?.();
  } catch (error) {
    throw new SafeBroadcastFenceError(
      error instanceof Error ? error.message : 'broadcast fence rejected',
    );
  }
  const txHash = await broadcaster.broadcast({
    safeAddress: params.safeAddress as `0x${string}`,
    to: params.to as `0x${string}`,
    value: params.value,
    data: params.data as `0x${string}`,
  });
  try {
    await options.onBroadcast?.(txHash);
  } catch (error) {
    throw new SafePostBroadcastHookError(
      txHash,
      error instanceof Error ? error.message : 'post-broadcast hook failed',
    );
  }
  return txHash;
}
```

The `ledger?: TxSubmissionLedger` option becomes inert (venue-base owns the submission ledger); leave the field on `SafeExecutionOptions` so callers keep compiling, and add a one-line comment saying stage 5 deletes it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/adapters && yarn typecheck`
Expected: PASS (4 new tests). Existing `safe.test.ts` cases that asserted the in-process nonce ledger will now fail — **delete them and move their scenarios into the venue-base kit** per contract 12, recording each moved case in the commit body.

- [ ] **Step 5: Commit**

```bash
git add client/src/adapters/mech/safe.ts client/test/adapters/mech
git commit -m "refactor(operator): route every legacy Safe transaction through the venue broadcaster"
```

---

## Task 8: The marketplace deliver leg

**Files:**
- Create: `client/src/daemon/mech-deliver.ts`
- Test: `client/test/daemon/mech-deliver.test.ts`

**Why this task exists (Finding F1).** In today-generation, `settleDelivery` (`packages/marketplace/binding/src/settlement.ts:465`) calls `ports.readMechDeliveryFacts` **before** `claimSolutionDelivery` and rejects with `digest-divergence` unless the Mech `Deliver` event already carries the Delivery's raw-CID sha256 digest. Nothing in the merged stack sends that transaction: `runPipeline` goes `convergeDelivery` → `settleDelivery` with no deliver leg, and a repo-wide search finds no `deliverToMarketplace` write outside `client/` and the marketplace test fixtures. The host owns it for stage 1, built on the venue broadcast port so contract 1 holds.

**Interfaces:**
- Consumes: `MECH_ABI` (`@jinn-network/marketplace-binding`), `VenueBroadcaster` (Task 7).
- Produces:

```ts
// client/src/daemon/mech-deliver.ts
export interface MechDeliverInput {
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  readonly requestId: `0x${string}`;
  /** The exact sealed Delivery bytes the backend produced. */
  readonly deliveryBytes: Uint8Array;
}

/** Encodes `deliverToMarketplace([requestId], [rawCidDigest])`. Pure; exported for tests. */
export function encodeMechDeliverCalldata(input: {
  readonly requestId: `0x${string}`;
  readonly deliveryBytes: Uint8Array;
}): `0x${string}`;

/**
 * Emits the Mech Deliver fact today-mode settlement requires. Idempotent by construction: a
 * second call for the same requestId reverts inside the mech and is surfaced as
 * `{ delivered: 'already' }` rather than thrown.
 */
export async function deliverToMarketplace(
  input: MechDeliverInput,
  broadcaster: VenueBroadcaster,
): Promise<{ readonly delivered: 'sent' | 'already'; readonly txHash?: `0x${string}` }>;
```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/mech-deliver.test.ts
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { MECH_ABI, computeRawCodecCid } from '@jinn-network/marketplace-binding';
import { deliverToMarketplace, encodeMechDeliverCalldata } from '../../src/daemon/mech-deliver.js';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const MECH = '0x3333333333333333333333333333333333333333' as const;
const REQUEST = `0x${'d'.repeat(64)}` as const;
const BYTES = new TextEncoder().encode('{"protocol":"https://jinn.network/profiles/task-execution/1.0"}');

describe('marketplace deliver leg', () => {
  it('encodes deliverToMarketplace with the Delivery raw-CID sha256 digest', () => {
    const data = encodeMechDeliverCalldata({ requestId: REQUEST, deliveryBytes: BYTES });
    const decoded = decodeFunctionData({ abi: MECH_ABI, data });
    expect(decoded.functionName).toBe('deliverToMarketplace');
    const [requestIds, datas] = decoded.args as [readonly string[], readonly string[]];
    expect(requestIds).toEqual([REQUEST]);
    expect(datas).toEqual([
      `0x${computeRawCodecCid(BYTES).sha256Digest.slice('sha256:'.length)}`,
    ]);
  });

  it('broadcasts once through the venue broadcaster', async () => {
    const broadcast = vi.fn(async () => `0x${'e'.repeat(64)}` as const);
    const result = await deliverToMarketplace(
      { safeAddress: SAFE, mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
      { broadcast },
    );
    expect(result).toEqual({ delivered: 'sent', txHash: `0x${'e'.repeat(64)}` });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith({
      safeAddress: SAFE,
      to: MECH,
      value: 0n,
      data: encodeMechDeliverCalldata({ requestId: REQUEST, deliveryBytes: BYTES }),
    });
  });

  it('reports an already-delivered request instead of throwing', async () => {
    const result = await deliverToMarketplace(
      { safeAddress: SAFE, mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
      {
        broadcast: async () => {
          throw new Error('execution reverted: AlreadyDelivered()');
        },
      },
    );
    expect(result).toEqual({ delivered: 'already' });
  });

  it('rethrows an unrelated revert', async () => {
    await expect(
      deliverToMarketplace(
        { safeAddress: SAFE, mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
        {
          broadcast: async () => {
            throw new Error('execution reverted: NotAuthorized()');
          },
        },
      ),
    ).rejects.toThrow('NotAuthorized');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/daemon/mech-deliver.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/daemon/mech-deliver.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/daemon/mech-deliver.ts
import { encodeFunctionData, type Hex } from 'viem';
import { MECH_ABI, computeRawCodecCid } from '@jinn-network/marketplace-binding';
import type { VenueBroadcaster } from '../adapters/mech/safe.js';

export interface MechDeliverInput {
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  readonly requestId: `0x${string}`;
  readonly deliveryBytes: Uint8Array;
}

export function encodeMechDeliverCalldata(input: {
  readonly requestId: `0x${string}`;
  readonly deliveryBytes: Uint8Array;
}): Hex {
  const { sha256Digest } = computeRawCodecCid(input.deliveryBytes);
  const digestHex = `0x${sha256Digest.slice('sha256:'.length)}` as Hex;
  return encodeFunctionData({
    abi: MECH_ABI,
    functionName: 'deliverToMarketplace',
    args: [[input.requestId], [digestHex]],
  });
}

const ALREADY_DELIVERED = /AlreadyDelivered|already\s+delivered|RequestIdNotFound/iu;

export async function deliverToMarketplace(
  input: MechDeliverInput,
  broadcaster: VenueBroadcaster,
): Promise<{ readonly delivered: 'sent' | 'already'; readonly txHash?: Hex }> {
  const data = encodeMechDeliverCalldata({
    requestId: input.requestId,
    deliveryBytes: input.deliveryBytes,
  });
  try {
    const txHash = await broadcaster.broadcast({
      safeAddress: input.safeAddress,
      to: input.mechAddress,
      value: 0n,
      data,
    });
    return { delivered: 'sent', txHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ALREADY_DELIVERED.test(message)) return { delivered: 'already' };
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon/mech-deliver.test.ts && yarn typecheck`
Expected: PASS (4 tests), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/mech-deliver.ts client/test/daemon/mech-deliver.test.ts
git commit -m "feat(operator): add the marketplace deliver leg today-mode settlement requires"
```

---

## Task 9: The projector loop

**Files:**
- Create: `client/src/daemon/projector-ports.ts`, `client/src/daemon/projector-loop.ts`, `client/src/daemon/projector-cursor.ts`
- Modify: `client/src/daemon/loop-heartbeat.ts:33` (`LOOP_REGISTRY` gains `projector`)
- Test: `client/test/daemon/projector-cursor.test.ts`, `client/test/daemon/projector-loop.test.ts`

The loop reads venue chain events through venue-base's log source, decodes them with `decodeMarketplaceLogs`, reduces them with `reduceMarketplaceProjection`, and publishes signed announcements into the local archive through `projectAnnouncements` over a filesystem `BlobStore`. The archive is local-only in stage 1; stage 4 mounts it.

**Interfaces:**
- Consumes: `decodeMarketplaceLogs`, `reduceMarketplaceProjection`, `projectAnnouncements`, `createMarketplaceProjectionState`, `cloneMarketplaceProjectionState`, `finalityPolicy`, `AnnouncementProjectionPorts`, `MarketplaceProjectionState`, `ObservationMarketplaceEvent` (`@jinn-network/marketplace-projector`); `BlobStore`, `SourceHead`, `SignedEntry`, `writeArchivePages` (`@jinn-network/record-discovery-serve`); `TASK_EXECUTION_FACTS_RECOMPUTE` (`@jinn-network/record-discovery-facts-task-execution`); `createFsBlobStore` (transport-http); `venue.logSource` (venue-base); `Store` (`client/src/store/store.ts`).
- Produces:

```ts
// client/src/daemon/projector-cursor.ts
export interface ProjectorCursor {
  readonly liveBlockNumber: bigint;
  readonly liveBlockHash: `0x${string}`;
  readonly finalizedBlockNumber: bigint;
  readonly finalizedBlockHash: `0x${string}`;
  readonly sequence: string;                    // last announcement entry sequence
  readonly entryDigest: `sha256:${string}` | null;
  readonly headJson: string | null;             // serialized SourceHead
  readonly stateJson: string;                   // serialized MarketplaceProjectionState
}

export class ProjectorCursorStore {
  constructor(store: Store, key: string);
  read(): ProjectorCursor | undefined;
  /** Single SQLite transaction: cursor + projection state advance together or not at all. */
  write(cursor: ProjectorCursor): void;
  /** Reorg handling: roll back to the durable finalized checkpoint. */
  rollbackToFinalized(): ProjectorCursor | undefined;
}

// client/src/daemon/projector-ports.ts
export interface ProjectorPortsInput {
  readonly source: SourceIdentity;              // { agent, name }
  readonly signer: ScopedDiscoverySigner;
  readonly archiveRoot: string;
  readonly resolveRecord: AnnouncementProjectionPorts['resolveRecord'];
  readonly verifyVerdictObservation: AnnouncementProjectionPorts['verifyVerdictObservation'];
  readonly referencedBytes: ReferencedBytes;
  readonly clock?: Clock;
}

export function buildAnnouncementProjectionPorts(
  input: ProjectorPortsInput,
  continuation: {
    readonly previousHead?: SourceHead;
    readonly previousEntryDigest?: `sha256:${string}` | null;
    readonly initialSequence?: bigint;
  },
): AnnouncementProjectionPorts;

/** The append-aware archive writer `projectAnnouncements` requires for incremental batches. */
export function createAppendArchiveWriter(
  store: BlobStore,
  readPageCount: () => number,
  writePageCount: (count: number) => void,
): NonNullable<AnnouncementProjectionPorts['appendArchiveEntries']>;

// client/src/daemon/projector-loop.ts
export interface ProjectorLoopConfig {
  readonly chain: MarketplaceChainConfig;
  readonly logSource: { fetchLogs(input: { fromBlock: bigint; toBlock: bigint }): Promise<MarketplaceRawLog[]>;
                        heads(): Promise<{ latest: { number: bigint; hash: `0x${string}` };
                                           finalized: { number: bigint; hash: `0x${string}` } }> };
  readonly cursorStore: ProjectorCursorStore;
  readonly ports: ProjectorPortsInput;
  readonly enrich: (event: MarketplaceEvent) => Promise<ObservationMarketplaceEvent | undefined>;
  readonly pollIntervalMs: number;
  readonly store: Store;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

export class ProjectorLoop {
  constructor(config: ProjectorLoopConfig);
  /** One pass; exported so the boot catch-up gate can drive it synchronously. */
  tick(): Promise<{ readonly announcements: number; readonly refusals: number;
                    readonly caughtUp: boolean }>;
  run(): Promise<void>;
  stop(): void;
  /** Contract 3: has the durable cursor reached the finalized chain head? */
  hasCaughtUp(): Promise<boolean>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/daemon/projector-cursor.test.ts
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { ProjectorCursorStore } from '../../src/daemon/projector-cursor.js';

const CURSOR = {
  liveBlockNumber: 120n,
  liveBlockHash: `0x${'1'.repeat(64)}` as const,
  finalizedBlockNumber: 100n,
  finalizedBlockHash: `0x${'2'.repeat(64)}` as const,
  sequence: '0000000000000005',
  entryDigest: `sha256:${'a'.repeat(64)}` as const,
  headJson: '{"sequence":"0000000000000005"}',
  stateJson: '{"tasks":{}}',
};

describe('projector cursor store', () => {
  it('round-trips a cursor', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    expect(cursors.read()).toBeUndefined();
    cursors.write(CURSOR);
    expect(cursors.read()).toEqual(CURSOR);
  });

  it('rolls back to the durable finalized checkpoint on a reorg', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    cursors.write(CURSOR);
    const rolled = cursors.rollbackToFinalized()!;
    expect(rolled.liveBlockNumber).toBe(100n);
    expect(rolled.liveBlockHash).toBe(`0x${'2'.repeat(64)}`);
    // The announcement chain is append-only: sequence and entry digest never rewind.
    expect(rolled.sequence).toBe('0000000000000005');
    expect(rolled.entryDigest).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('keeps two projectors on distinct keys independent', () => {
    const store = new Store(':memory:');
    new ProjectorCursorStore(store, 'marketplace').write(CURSOR);
    expect(new ProjectorCursorStore(store, 'other').read()).toBeUndefined();
  });
});
```

```ts
// client/test/daemon/projector-loop.test.ts
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { Store } from '../../src/store/store.js';
import { ProjectorCursorStore } from '../../src/daemon/projector-cursor.js';
import { ProjectorLoop } from '../../src/daemon/projector-loop.js';
import { fakeDiscoverySigner, taskCreatedLog } from './_projector-fixtures.js';

function loop(overrides: Partial<ConstructorParameters<typeof ProjectorLoop>[0]> = {}) {
  const store = new Store(':memory:');
  return new ProjectorLoop({
    chain: BASE_SEPOLIA_TODAY,
    logSource: {
      fetchLogs: async () => [taskCreatedLog()],
      heads: async () => ({
        latest: { number: 120n, hash: `0x${'1'.repeat(64)}` },
        finalized: { number: 120n, hash: `0x${'1'.repeat(64)}` },
      }),
    },
    cursorStore: new ProjectorCursorStore(store, 'marketplace'),
    ports: {
      source: { agent: 'urn:jinn:operator:test', name: 'test-operator' },
      signer: fakeDiscoverySigner(),
      archiveRoot: mkdtempSync(join(tmpdir(), 'jinn-archive-')),
      resolveRecord: async () => ({
        kind: 'https://jinn.network/records/task-execution/submission/1.0',
        bytes: new TextEncoder().encode('{}'),
      }),
      verifyVerdictObservation: async () => ({ gate: { decisionGrade: true, failures: [] } }),
      referencedBytes: { fetch: async () => undefined },
    },
    enrich: async (event) => ({ ...event, projection: { /* fixture context */ } } as never),
    pollIntervalMs: 5,
    store,
    ...overrides,
  });
}

describe('projector loop', () => {
  it('advances the durable cursor after a successful tick', async () => {
    const store = new Store(':memory:');
    const cursorStore = new ProjectorCursorStore(store, 'marketplace');
    const projector = loop({ store, cursorStore });
    const result = await projector.tick();
    expect(result.caughtUp).toBe(true);
    expect(cursorStore.read()!.finalizedBlockNumber).toBe(120n);
  });

  it('reports not-caught-up while the finalized head is ahead of the cursor', async () => {
    const projector = loop({
      logSource: {
        fetchLogs: async () => [],
        heads: async () => ({
          latest: { number: 5_000n, hash: `0x${'1'.repeat(64)}` },
          finalized: { number: 4_900n, hash: `0x${'2'.repeat(64)}` },
        }),
      },
    });
    expect(await projector.hasCaughtUp()).toBe(false);
  });

  it('rolls back to the finalized checkpoint when the live block hash diverges', async () => {
    const store = new Store(':memory:');
    const cursorStore = new ProjectorCursorStore(store, 'marketplace');
    cursorStore.write({
      liveBlockNumber: 120n,
      liveBlockHash: `0x${'9'.repeat(64)}`,
      finalizedBlockNumber: 100n,
      finalizedBlockHash: `0x${'2'.repeat(64)}`,
      sequence: '0000000000000001',
      entryDigest: `sha256:${'a'.repeat(64)}`,
      headJson: null,
      stateJson: JSON.stringify({}),
    });
    const warn = vi.fn();
    const projector = loop({ store, cursorStore, logger: { info: vi.fn(), warn } });
    await projector.tick();
    expect(warn.mock.calls.flat().join('\n')).toContain('reorg');
    expect(cursorStore.read()!.liveBlockNumber).toBeGreaterThanOrEqual(100n);
  });

  it('never emits an announcement for an event below the finality policy threshold', async () => {
    const projector = loop({
      logSource: {
        fetchLogs: async () => [taskCreatedLog({ finalityTier: 'safe' })],
        heads: async () => ({
          latest: { number: 120n, hash: `0x${'1'.repeat(64)}` },
          finalized: { number: 90n, hash: `0x${'2'.repeat(64)}` },
        }),
      },
      ports: { /* same as loop(), with announceAt: 'finalized' */ } as never,
    });
    const result = await projector.tick();
    expect(result.announcements).toBe(0);
  });
});
```

`client/test/daemon/_projector-fixtures.ts` supplies `taskCreatedLog()` (an encoded `TaskCreated` log against `BASE_SEPOLIA_TODAY.jinnRouter` built with viem's `encodeEventTopics`) and `fakeDiscoverySigner()` (a `ScopedDiscoverySigner` over a fixed ed25519 key with `scope: DISCOVERY_SIGNING_SCOPE`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/daemon/projector-cursor.test.ts test/daemon/projector-loop.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/daemon/projector-cursor.js"`.

- [ ] **Step 3: Write minimal implementation**

`client/src/daemon/projector-cursor.ts` — one table, added to the `Store` constructor beside `ENGAGEMENT_LEDGER_SCHEMA`:

```ts
export const PROJECTOR_CURSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS projector_cursor (
  key                     TEXT PRIMARY KEY,
  live_block_number       TEXT NOT NULL,
  live_block_hash         TEXT NOT NULL,
  finalized_block_number  TEXT NOT NULL,
  finalized_block_hash    TEXT NOT NULL,
  sequence                TEXT NOT NULL,
  entry_digest            TEXT,
  head_json               TEXT,
  state_json              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
`;

export class ProjectorCursorStore {
  constructor(private readonly store: Store, private readonly key: string) {}

  read(): ProjectorCursor | undefined { /* SELECT + bigint parse */ }

  write(cursor: ProjectorCursor): void {
    this.store.db.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO projector_cursor
             (key, live_block_number, live_block_hash, finalized_block_number,
              finalized_block_hash, sequence, entry_digest, head_json, state_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             live_block_number = excluded.live_block_number,
             live_block_hash = excluded.live_block_hash,
             finalized_block_number = excluded.finalized_block_number,
             finalized_block_hash = excluded.finalized_block_hash,
             sequence = excluded.sequence,
             entry_digest = excluded.entry_digest,
             head_json = excluded.head_json,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          this.key,
          cursor.liveBlockNumber.toString(),
          cursor.liveBlockHash,
          cursor.finalizedBlockNumber.toString(),
          cursor.finalizedBlockHash,
          cursor.sequence,
          cursor.entryDigest,
          cursor.headJson,
          cursor.stateJson,
          new Date().toISOString(),
        );
    })();
  }

  rollbackToFinalized(): ProjectorCursor | undefined {
    const current = this.read();
    if (current === undefined) return undefined;
    // Announcements already emitted are corrected append-only through signed retractions
    // (spec §7.2); only projector *state* rolls back.
    const rolled: ProjectorCursor = {
      ...current,
      liveBlockNumber: current.finalizedBlockNumber,
      liveBlockHash: current.finalizedBlockHash,
    };
    this.write(rolled);
    return rolled;
  }
}
```

`client/src/daemon/projector-ports.ts` — assembles `AnnouncementProjectionPorts`:

```ts
export function buildAnnouncementProjectionPorts(
  input: ProjectorPortsInput,
  continuation: {
    readonly previousHead?: SourceHead;
    readonly previousEntryDigest?: `sha256:${string}` | null;
    readonly initialSequence?: bigint;
  },
): AnnouncementProjectionPorts {
  const store = createFsBlobStore(input.archiveRoot);
  return {
    source: input.source,
    signer: input.signer,
    store,
    clock: input.clock ?? { now: () => new Date() },
    factsRecompute: TASK_EXECUTION_FACTS_RECOMPUTE,
    referencedBytes: input.referencedBytes,
    resolveRecord: input.resolveRecord,
    verifyVerdictObservation: input.verifyVerdictObservation,
    ...(continuation.previousHead === undefined
      ? {}
      : {
          previousHead: continuation.previousHead,
          previousEntryDigest: continuation.previousEntryDigest ?? null,
          initialSequence: continuation.initialSequence ?? 1n,
          appendArchiveEntries: createAppendArchiveWriter(store, readPageCount, writePageCount),
        }),
  };
}
```

`createAppendArchiveWriter` writes each new batch as the next page number (`writeArchivePages` is genesis-only per its own doc comment), persisting the page count in the store's `config` table so restarts never overwrite an immutable archive path.

`client/src/daemon/projector-loop.ts` — one `tick()`:

1. `const heads = await config.logSource.heads()`.
2. Read the cursor. If a cursor exists and the log source reports a different hash for `cursor.liveBlockNumber`, log `reorg detected …` and `rollbackToFinalized()`.
3. `fetchLogs({ fromBlock: cursor.liveBlockNumber + 1n, toBlock: heads.latest.number })`.
4. `decodeMarketplaceLogs(logs, { config: config.chain })`.
5. `await Promise.all(events.map(config.enrich))`, dropping `undefined` (an event whose signed record the host cannot resolve yet).
6. Filter with `finalityPolicy(event.derivation, { announceAt })` — keep only `decision.announce`.
7. `reduceMarketplaceProjection(enriched, previousState)`.
8. `await projectAnnouncements(transition, ports)`.
9. `cursorStore.write({ ...heads, sequence, entryDigest, headJson, stateJson: JSON.stringify(transition.state) })` — the cursor and the projection state advance in one SQLite transaction.
10. Return `{ announcements, refusals, caughtUp: cursor.finalizedBlockNumber >= heads.finalized.number }`.

`run()` wraps `tick()` in the existing `runLoop({ name: 'projector', intervalMs, store, body })` helper from `client/src/daemon/loop-heartbeat.ts:100`, and `LOOP_REGISTRY` gains `projector: { intervalMs: 5000, floorMs: 300_000 }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon/projector-cursor.test.ts test/daemon/projector-loop.test.ts && yarn typecheck`
Expected: PASS (7 tests), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/projector-cursor.ts client/src/daemon/projector-ports.ts client/src/daemon/projector-loop.ts client/src/daemon/loop-heartbeat.ts client/src/store/store.ts client/test/daemon
git commit -m "feat(operator): add the projector loop writing a local signed discovery archive"
```

---

## Task 10: The projector-catch-up claim gate

**Files:**
- Create: `client/src/daemon/claim-gate.ts`
- Test: `client/test/daemon/claim-gate.test.ts`

Contract 3 in one small, independently reviewable module: at boot the work loop issues no new claim until the projector's durable cursor has reached the finalized chain head, so it cannot re-claim a task it already holds or re-execute a delivered attempt.

**Interfaces:**
- Consumes: `ProjectorLoop.hasCaughtUp()` (Task 9).
- Produces:

```ts
// client/src/daemon/claim-gate.ts
export interface ClaimGate {
  /** Resolves once the projector cursor has reached the finalized head. Never rejects. */
  waitUntilOpen(signal?: AbortSignal): Promise<void>;
  isOpen(): boolean;
}

export function createProjectorCatchUpGate(input: {
  readonly hasCaughtUp: () => Promise<boolean>;
  readonly pollIntervalMs: number;
  readonly logger?: { info(m: string): void };
  readonly sleep?: (ms: number) => Promise<void>;
}): ClaimGate;
```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/claim-gate.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createProjectorCatchUpGate } from '../../src/daemon/claim-gate.js';

describe('projector catch-up claim gate', () => {
  it('stays closed until the projector reports catch-up', async () => {
    const answers = [false, false, true];
    const gate = createProjectorCatchUpGate({
      hasCaughtUp: async () => answers.shift() ?? true,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    expect(gate.isOpen()).toBe(false);
    await gate.waitUntilOpen();
    expect(gate.isOpen()).toBe(true);
    expect(answers).toEqual([]);
  });

  it('logs once when it opens', async () => {
    const info = vi.fn();
    const gate = createProjectorCatchUpGate({
      hasCaughtUp: async () => true,
      pollIntervalMs: 1,
      logger: { info },
      sleep: async () => {},
    });
    await gate.waitUntilOpen();
    await gate.waitUntilOpen();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toContain('claim gate open');
  });

  it('returns without opening when the signal aborts', async () => {
    const controller = new AbortController();
    const gate = createProjectorCatchUpGate({
      hasCaughtUp: async () => {
        controller.abort();
        return false;
      },
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    await gate.waitUntilOpen(controller.signal);
    expect(gate.isOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/daemon/claim-gate.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/daemon/claim-gate.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/daemon/claim-gate.ts
export interface ClaimGate {
  waitUntilOpen(signal?: AbortSignal): Promise<void>;
  isOpen(): boolean;
}

export function createProjectorCatchUpGate(input: {
  readonly hasCaughtUp: () => Promise<boolean>;
  readonly pollIntervalMs: number;
  readonly logger?: { info(m: string): void };
  readonly sleep?: (ms: number) => Promise<void>;
}): ClaimGate {
  let open = false;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    isOpen: () => open,
    async waitUntilOpen(signal?: AbortSignal): Promise<void> {
      if (open) return;
      while (signal?.aborted !== true) {
        if (await input.hasCaughtUp()) {
          open = true;
          input.logger?.info(
            '[work] claim gate open — the projector cursor reached the finalized chain head',
          );
          return;
        }
        if (signal?.aborted === true) return;
        await sleep(input.pollIntervalMs);
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon/claim-gate.test.ts && yarn typecheck`
Expected: PASS (3 tests), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/claim-gate.ts client/test/daemon/claim-gate.test.ts
git commit -m "feat(operator): gate boot-time claiming on projector catch-up"
```

---

## Task 11: The evidence join and the evidence driver loop

**Files:**
- Create: `client/src/daemon/evidence-join.ts`, `client/src/daemon/evidence-driver.ts`
- Modify: `client/src/daemon/loop-heartbeat.ts:33` (`LOOP_REGISTRY` gains `evidence-driver`), `client/src/api/gather-status.ts` (indexing-failure rollup)
- Test: `client/test/daemon/evidence-join.test.ts`, `client/test/daemon/evidence-driver.test.ts`

This is the join `packages/task-execution/backend-local/assembly` deliberately refuses to own — its architecture test asserts the package must never import `@jinn-network/evidence-local-runtime`. The host writes it. The driver then does what the backend will not: `sync`, publication under contract 6's policy, `awaitIndexed`, and surfacing indexing failures.

**Interfaces:**
- Consumes: `openLocalEvidenceRuntime(options): Promise<LocalEvidenceRuntime>` and `LocalEvidenceRuntime` (`@jinn-network/evidence-local-runtime`); `EvidenceBindingPorts`, `EvidenceIndexingOutcome` (`@jinn-network/task-execution-backend-local-assembly`).
- Produces:

```ts
// client/src/daemon/evidence-join.ts
export interface OperatorEvidence {
  readonly runtime: LocalEvidenceRuntime;
  readonly ports: EvidenceBindingPorts;
  close(): Promise<void>;
}

/** The host-owned join. `rootDir` defaults to `<earningDir>/../evidence`. */
export async function openOperatorEvidence(input: {
  readonly rootDir: string;
  readonly signal?: AbortSignal;
}): Promise<OperatorEvidence>;

// client/src/daemon/evidence-driver.ts
export type PublicationDecision =
  | { readonly publish: true }
  | { readonly publish: false; readonly reason: 'not-sealed-for-delivery' | 'capability-grant-material' | 'secret-forward' | 'already-published' };

/** Contract 6 as a pure function so the policy is testable without a runtime. */
export function decidePublication(record: {
  readonly digest: `sha256:${string}`;
  readonly sealedFor: 'delivery' | 'announcement' | 'none';
  readonly containsCapabilityGrantMaterial: boolean;
  readonly containsSecretForward: boolean;
}, alreadyPublished: ReadonlySet<string>): PublicationDecision;

export interface EvidenceDriverConfig {
  readonly evidence: OperatorEvidence;
  readonly intervalMs: number;
  readonly store: Store;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

export class EvidenceDriverLoop {
  constructor(config: EvidenceDriverConfig);
  tick(): Promise<{ readonly indexed: number; readonly failed: number; readonly pending: number }>;
  run(): Promise<void>;
  stop(): void;
  /** Feeds the `/v1/status` indexing-failure rollup. */
  failures(): Promise<readonly { reference: string; category: string; message: string }[]>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/daemon/evidence-join.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openOperatorEvidence } from '../../src/daemon/evidence-join.js';

describe('operator evidence join', () => {
  it('produces EvidenceBindingPorts backed by the local runtime', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-evidence-'));
    const evidence = await openOperatorEvidence({ rootDir });
    try {
      expect(evidence.ports.repository).toBe(evidence.runtime.repository);
      expect(evidence.ports.catalog).toBe(evidence.runtime.catalog);
      expect(typeof evidence.ports.awaitIndexed).toBe('function');
    } finally {
      await evidence.close();
    }
  });

  it('closes the runtime exactly once', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-evidence-'));
    const evidence = await openOperatorEvidence({ rootDir });
    await evidence.close();
    await expect(evidence.close()).resolves.toBeUndefined();
  });
});
```

```ts
// client/test/daemon/evidence-driver.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { EvidenceDriverLoop, decidePublication } from '../../src/daemon/evidence-driver.js';

const DIGEST = `sha256:${'f'.repeat(64)}` as const;

describe('evidence publication policy', () => {
  it('publishes a record sealed for delivery', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'delivery', containsCapabilityGrantMaterial: false, containsSecretForward: false },
        new Set(),
      ),
    ).toEqual({ publish: true });
  });

  it('refuses a record that is not sealed for delivery or announcement', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'none', containsCapabilityGrantMaterial: false, containsSecretForward: false },
        new Set(),
      ),
    ).toEqual({ publish: false, reason: 'not-sealed-for-delivery' });
  });

  it('never publishes capability-grant material', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'delivery', containsCapabilityGrantMaterial: true, containsSecretForward: false },
        new Set(),
      ),
    ).toEqual({ publish: false, reason: 'capability-grant-material' });
  });

  it('never publishes a secret forward', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'announcement', containsCapabilityGrantMaterial: false, containsSecretForward: true },
        new Set(),
      ),
    ).toEqual({ publish: false, reason: 'secret-forward' });
  });

  it('is idempotent by digest', () => {
    expect(
      decidePublication(
        { digest: DIGEST, sealedFor: 'delivery', containsCapabilityGrantMaterial: false, containsSecretForward: false },
        new Set([DIGEST]),
      ),
    ).toEqual({ publish: false, reason: 'already-published' });
  });
});

describe('evidence driver loop', () => {
  it('syncs and reports indexed and failed counts', async () => {
    const sync = vi.fn(async () => ({ status: 'synchronized' as const, indexed: 2, failed: 0 }));
    const driver = new EvidenceDriverLoop({
      evidence: {
        runtime: {
          sync,
          listIndexingFailures: async () => ({ items: [] }),
          getStatus: async () => ({ pendingAnnouncements: 0 }),
        },
        ports: {},
        close: async () => {},
      } as never,
      intervalMs: 5,
      store: new Store(':memory:'),
    });
    expect(await driver.tick()).toEqual({ indexed: 2, failed: 0, pending: 0 });
    expect(sync).toHaveBeenCalledOnce();
  });

  it('warns once per failed reference and exposes it for the status rollup', async () => {
    const warn = vi.fn();
    const driver = new EvidenceDriverLoop({
      evidence: {
        runtime: {
          sync: async () => ({ status: 'synchronized' as const, indexed: 0, failed: 1 }),
          listIndexingFailures: async () => ({
            items: [
              {
                reference: 'urn:jinn:evidence:record:abc',
                category: 'protocol-nonconformance',
                sourceCode: 'E_CONFORMANCE',
                message: 'record does not conform',
                observedAt: '2026-07-30T09:00:00.000Z',
              },
            ],
          }),
          getStatus: async () => ({ pendingAnnouncements: 3 }),
        },
        ports: {},
        close: async () => {},
      } as never,
      intervalMs: 5,
      store: new Store(':memory:'),
      logger: { info: vi.fn(), warn },
    });
    await driver.tick();
    await driver.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await driver.failures()).toEqual([
      {
        reference: 'urn:jinn:evidence:record:abc',
        category: 'protocol-nonconformance',
        message: 'record does not conform',
      },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/daemon/evidence-join.test.ts test/daemon/evidence-driver.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/daemon/evidence-join.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/daemon/evidence-join.ts
import {
  openLocalEvidenceRuntime,
  type LocalEvidenceRuntime,
} from '@jinn-network/evidence-local-runtime';
import type {
  EvidenceBindingPorts,
  EvidenceIndexingOutcome,
} from '@jinn-network/task-execution-backend-local-assembly';

export interface OperatorEvidence {
  readonly runtime: LocalEvidenceRuntime;
  readonly ports: EvidenceBindingPorts;
  close(): Promise<void>;
}

/**
 * The one join the stack deliberately refuses to own: `backend-local/assembly` declares
 * `EvidenceBindingPorts` and its architecture test forbids importing the local runtime that
 * satisfies it. The operator runtime is the composition root, so the join lives here.
 */
export async function openOperatorEvidence(input: {
  readonly rootDir: string;
  readonly signal?: AbortSignal;
}): Promise<OperatorEvidence> {
  const runtime = await openLocalEvidenceRuntime({
    rootDir: input.rootDir,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let closed = false;
  return {
    runtime,
    ports: {
      repository: runtime.repository,
      catalog: runtime.catalog,
      awaitIndexed: (reference): Promise<EvidenceIndexingOutcome> =>
        runtime.awaitIndexed(reference) as Promise<EvidenceIndexingOutcome>,
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await runtime.close();
    },
  };
}
```

```ts
// client/src/daemon/evidence-driver.ts (policy + loop; only the policy is shown in full)
export function decidePublication(
  record: {
    readonly digest: `sha256:${string}`;
    readonly sealedFor: 'delivery' | 'announcement' | 'none';
    readonly containsCapabilityGrantMaterial: boolean;
    readonly containsSecretForward: boolean;
  },
  alreadyPublished: ReadonlySet<string>,
): PublicationDecision {
  if (record.containsCapabilityGrantMaterial) {
    return { publish: false, reason: 'capability-grant-material' };
  }
  if (record.containsSecretForward) return { publish: false, reason: 'secret-forward' };
  if (record.sealedFor === 'none') return { publish: false, reason: 'not-sealed-for-delivery' };
  if (alreadyPublished.has(record.digest)) return { publish: false, reason: 'already-published' };
  return { publish: true };
}
```

`EvidenceDriverLoop.tick()`:
1. `const report = await this.config.evidence.runtime.sync();`
2. `const status = await this.config.evidence.runtime.getStatus();`
3. `const page = await this.config.evidence.runtime.listIndexingFailures({ limit: 25 });`
4. Cache `page.items` on the instance for `failures()`; warn once per unseen `reference` (a `Set<string>` on the instance).
5. Return `{ indexed: report.indexed, failed: report.failed, pending: status.pendingAnnouncements }`.

`run()` uses `runLoop({ name: 'evidence-driver', intervalMs, store, body })`; `LOOP_REGISTRY` gains `'evidence-driver': { intervalMs: 30_000, floorMs: 300_000 }`. `gather-status.ts` gains `evidenceIndexing: { failures: await driver.failures(), pending }`, which the SPA renders as an `evidence_indexing_failed` state message in Task 17.

**Announce-after-indexed.** The work loop (Task 13) calls `evidence.ports.awaitIndexed(receipt.record)` after `runPipeline` returns `delivered` and before the projector may announce the delivery. The driver's `sync()` is what makes that terminate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon/evidence-join.test.ts test/daemon/evidence-driver.test.ts && yarn typecheck`
Expected: PASS (7 tests), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/evidence-join.ts client/src/daemon/evidence-driver.ts client/src/daemon/loop-heartbeat.ts client/src/api/gather-status.ts client/test/daemon
git commit -m "feat(operator): write the evidence join and drive local-runtime sync and publication"
```

---

## Task 12: The composition root

**Files:**
- Create: `client/src/daemon/composition-root.ts`
- Modify: `client/src/main.ts:2164` (build the composition before `new Daemon({...})` and pass it through)
- Test: `client/test/daemon/composition-root.test.ts`

The composition root is the only place in the repository that assembles `LocalTaskExecutionBackendConfig`, `PipelineConfig`, and `PipelinePorts`. Every field of `LocalTaskExecutionBackendConfig` (`packages/task-execution/backend-local/assembly/src/backend.ts:494`) is mapped here from operator config.

**Interfaces:**
- Consumes: `createBaseVenue` (venue-base); `LocalTaskExecutionBackend`, `LocalTaskExecutionBackendConfig`, `LocalProvisionerInput`, `SelectedProvisioner` (`@jinn-network/task-execution-backend-local-assembly`); `claudeCodeLauncher`, `codexLauncher`, `hermesLauncher`, `cursorLauncher` (`@jinn-network/task-execution-launchers`); `makeDirProvisioner`, `makeWorktreeProvisioner`, `selectProvisioner` (`@jinn-network/task-execution-workspace`); `resolveProfile`, `ProfileStore` (`@jinn-network/task-execution-profiles`); `CLAIM_NOTHING`, `takeEveryRunnable`, `matchLegacyManifestDigest`, `PipelineConfig`, `PipelinePorts` (`@jinn-network/marketplace-pipeline`); `createChainFactResolver`, `createBindingResolver` (`@jinn-network/trust-resolve`); `createRegistryPinPort` (`@jinn-network/marketplace-binding`); `openOperatorEvidence` (Task 11); `setVenueBroadcaster` (Task 7); `toPipelineWiring` (Task 1).
- Produces:

```ts
// client/src/daemon/composition-root.ts
export interface OperatorComposition {
  readonly backend: TaskExecutionBackend;
  readonly pipelineConfig: PipelineConfig;
  readonly pipelinePorts: PipelinePorts;
  readonly venue: BaseVenue;                  // the createBaseVenue return value
  readonly evidence: OperatorEvidence;
  readonly chain: MarketplaceChainConfig;
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  close(): Promise<void>;
}

export interface CompositionRootInput {
  readonly config: JinnConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  readonly chain: MarketplaceChainConfig;
  readonly stateRoot: string;               // `<earningDir>/../engine/backend`
  readonly evidenceRoot: string;            // `<earningDir>/../evidence`
  readonly venueStateDbPath: string;        // `<earningDir>/../venue/venue.db`
  readonly profileStore: ProfileStore;
  readonly secretForwardResolver?: SecretForwardResolver;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

/** Installs the single broadcaster as its first side effect. */
export async function buildOperatorComposition(
  input: CompositionRootInput,
): Promise<OperatorComposition>;

/** Pure: operator claim policy config → the pipeline's ClaimPredicate. */
export function buildClaimPredicate(
  policy: ClaimPolicyConfig | undefined,
  wiring: readonly ExecutionWiringEntry[],
): ClaimPredicate;
```

`LocalTaskExecutionBackendConfig` field map — every required field, no gaps:

| Field | Value |
| --- | --- |
| `stateRoot` | `input.stateRoot` |
| `source` | `` `urn:jinn:operator:${safeAddress.toLowerCase()}` `` |
| `executor` | `` `urn:jinn:operator-runtime:${version}` `` from `dist/build-meta` |
| `profileStore` | `input.profileStore` |
| `launchers` | `[claudeCodeLauncher, codexLauncher, hermesLauncher, cursorLauncher]` filtered to the harnesses named by `config.executionWiring[].harness` |
| `launcherDeployments` | one entry per selected launcher: `{ executablePath, versionProbe }` resolved from `config.claudePath` / `JINN_CODEX_PATH` / `JINN_HERMES_PATH` |
| `provisioner` | `(input) => selectProvisioner(...)` returning `{ id, contract }` |
| `provisionerCapabilities` | `{ taskProfiles: [REPOSITORY_WORK_PROFILE, EVALUATION_TASK_PROFILE], workspaceKinds: ['plain-dir','git-worktree'], inputMediaTypes: ['application/json'], outputMediaTypes: ['application/json','application/octet-stream'], isolation: ['process'] }` |
| `maxConcurrentAttempts` | `config.maxConcurrentAttempts ?? 4` |
| `recorderAvailability` | `'always'` — stage 1 requires evidence capture on every solve |
| `trustKeys` | `{ observationSigningKeyConfigured: true, deliverySigningKeyConfigured: true }` |
| `evidence` | `evidence.ports` from `openOperatorEvidence` |
| `capabilityGrants` | `(grants) => resolveCapabilityGrants(grants, config)` |
| `secretForwardResolver` | `input.secretForwardResolver` |
| `cancellationGraceMs` | `30_000` |
| `heartbeatIntervalMs` | `10_000` |
| `now` | omitted (wall clock) |
| `faults` | omitted — production compositions leave it absent |

`PipelinePorts` map: `claim: venue.claim`, `finality: venue.finality`, `deliveryWait: venue.deliveryWait`, `settlement: { ...venue.settlement, pin: createRegistryPinPort({ addUrl: config.ipfsRegistryUrl }).pin, verifySettlementGrade }`, `ipfs: createRegistryPinPort({ addUrl: config.ipfsRegistryUrl })`, `release: venue.release`.

`verifySettlementGrade` composes `createBindingResolver` + `createChainFactResolver` from `@jinn-network/trust-resolve` and returns the three independent checks (`executorBinding`, `dispatchBinding`, `evaluationSpecification`) `settleDelivery` demands — never collapsed to a boolean.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/composition-root.test.ts
import { describe, expect, it } from 'vitest';
import { CLAIM_NOTHING } from '@jinn-network/marketplace-pipeline';
import { buildClaimPredicate } from '../../src/daemon/composition-root.js';

const WIRING = [
  {
    workKind: 'QmSolver',
    harness: 'claude-code',
    model: 'm',
    plugins: [],
    credentialRef: 'c',
    isolationPolicy: 'process',
    legacyManifestDigest: 'QmSolver',
  },
];

const FACTS = {
  taskId: 1n,
  taskDigest: `sha256:${'a'.repeat(64)}` as const,
  submission: 'urn:uuid:11111111-2222-3333-4444-555555555555' as const,
  nonce: '0x1',
  profileUri: 'p',
  requirements: {},
  runnable: true,
  intendedSpendWei: 0n,
  intendedAiUnits: 0,
  workKind: 'QmSolver',
  legacyManifestDigest: 'QmSolver',
};

const CAPS = { spendCapWei: 10n, aiUnitCap: 10 };

describe('claim predicate assembly', () => {
  it('claims nothing when no policy is configured', () => {
    expect(buildClaimPredicate(undefined, WIRING)).toBe(CLAIM_NOTHING);
  });

  it('claims nothing in claim-nothing mode', () => {
    const predicate = buildClaimPredicate(
      { mode: 'claim-nothing', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    expect(predicate).toBe(CLAIM_NOTHING);
  });

  it('claims every runnable card in every-runnable mode', () => {
    const predicate = buildClaimPredicate(
      { mode: 'every-runnable', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    expect(predicate!(FACTS, {} as never, CAPS)).toBe(true);
    expect(predicate!({ ...FACTS, runnable: false }, {} as never, CAPS)).toBe(false);
  });

  it('matches the legacy manifest digest in bridge mode', () => {
    const predicate = buildClaimPredicate(
      { mode: 'match-legacy-manifest-digest', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    expect(predicate!(FACTS, {} as never, CAPS)).toBe(true);
    expect(
      predicate!({ ...FACTS, legacyManifestDigest: 'QmOther' }, {} as never, CAPS),
    ).toBe(false);
  });

  it('declines a work kind with no wiring entry in bridge mode', () => {
    const predicate = buildClaimPredicate(
      { mode: 'match-legacy-manifest-digest', spendCapWei: '10', aiUnitCap: 10 },
      WIRING,
    );
    // No wiring entry means no legacy digest to match; runPipeline's `wiring-missing`
    // gate is the authority, so the predicate must not silently accept.
    expect(predicate!({ ...FACTS, workKind: 'QmUnknown' }, {} as never, CAPS)).toBe(false);
  });
});
```

Plus an integration test in the same file that calls `buildOperatorComposition` against a temp `stateRoot`/`evidenceRoot` with a stub `createBaseVenue`, asserting: (a) `setVenueBroadcaster` was installed before the function returned, (b) `pipelineConfig.wiring` equals `toPipelineWiring(config.executionWiring)`, (c) `pipelineConfig.caps` equals `{ spendCapWei: BigInt(policy.spendCapWei), aiUnitCap: policy.aiUnitCap }`, (d) `backend.capabilities()` resolves with the configured `taskProfiles`, (e) `close()` closes the evidence runtime.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/daemon/composition-root.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/daemon/composition-root.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/daemon/composition-root.ts (predicate assembly shown in full)
import {
  CLAIM_NOTHING,
  matchLegacyManifestDigest,
  takeEveryRunnable,
  type ClaimPredicate,
  type ExecutionWiringEntry,
} from '@jinn-network/marketplace-pipeline';
import type { ClaimPolicyConfig } from '../config/shape-v2.js';

export function buildClaimPredicate(
  policy: ClaimPolicyConfig | undefined,
  wiring: readonly ExecutionWiringEntry[],
): ClaimPredicate {
  if (policy === undefined || policy.mode === 'claim-nothing') return CLAIM_NOTHING;
  if (policy.mode === 'every-runnable') return takeEveryRunnable();
  const byWorkKind = new Map(wiring.map((entry) => [entry.workKind, entry]));
  const bridge = matchLegacyManifestDigest(byWorkKind);
  return (facts, capabilities, caps) => {
    if (!byWorkKind.has(facts.workKind)) return false;
    return facts.runnable && bridge!(facts, capabilities, caps);
  };
}
```

`buildOperatorComposition` in order:

1. `const venue = createBaseVenue({ chain, publicClient, walletClient, safeAddress, stateDbPath: venueStateDbPath });`
2. `setVenueBroadcaster(venue.safe);` — **first**, before any loop can send a transaction (contract 1).
3. `const evidence = await openOperatorEvidence({ rootDir: evidenceRoot });`
4. Build `launchers` + `launcherDeployments` from `config.executionWiring`.
5. `const backend = new LocalTaskExecutionBackend(backendConfig);` with the field map above.
6. `const wiring = toPipelineWiring(config.executionWiring ?? []);`
7. `const pipelineConfig: PipelineConfig = { chain, predicate: buildClaimPredicate(config.claimPolicy, wiring), caps: { spendCapWei: BigInt(config.claimPolicy?.spendCapWei ?? '0'), aiUnitCap: config.claimPolicy?.aiUnitCap ?? 0 }, wiring, priorityMech: mechAddress };`
8. `const pipelinePorts: PipelinePorts = { … }` as mapped above.
9. Return the composition with `close()` = `await evidence.close(); clearVenueBroadcaster();`.

In `client/src/main.ts`, insert the build immediately before `new Daemon({...})` (line 2164) and pass `composition` on `DaemonConfig`. `DaemonConfig` in `client/src/daemon/daemon.ts:85` gains `readonly composition?: OperatorComposition;` — optional so the many existing `new Daemon(...)` test call sites keep compiling; `daemon.start()` starts the three new loops only when it is present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon/composition-root.test.ts && yarn typecheck`
Expected: PASS (5 predicate tests + 5 integration assertions), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/composition-root.ts client/src/daemon/daemon.ts client/src/main.ts client/test/daemon/composition-root.test.ts
git commit -m "feat(operator): add the composition root assembling backend, pipeline, and venue ports"
```

---

## Task 13: The work loop

**Files:**
- Create: `client/src/daemon/work-loop.ts`
- Modify: `client/src/daemon/daemon.ts:354` (start it), `client/src/daemon/loop-heartbeat.ts:33` (`LOOP_REGISTRY` gains `work`)
- Test: `client/test/daemon/work-loop.test.ts`

**Interfaces:**
- Consumes: `mapAnnouncedSubmissionToFacts` (Task 5); `EngagementLedger` (Task 6); `deliverToMarketplace` (Task 8); `ClaimGate` (Task 10); `OperatorComposition` (Task 12); `runPipeline`, `PipelineRunOutcome` (`@jinn-network/marketplace-pipeline`); `gateClaimByAiUnits` (`client/src/daemon/ai-units-gate.ts`), `gateClaimBySpendCap` (`client/src/daemon/spend-cap-gate.ts`).
- Produces:

```ts
// client/src/daemon/work-loop.ts
export interface ArchiveSubscription {
  /** Local-archive announcements the projector wrote since `afterSequence`. */
  since(afterSequence: string): Promise<readonly AnnouncedSubmissionCard[]>;
}

export interface WorkLoopConfig {
  readonly composition: OperatorComposition;
  readonly archive: ArchiveSubscription;
  readonly ledger: EngagementLedger;
  readonly claimGate: ClaimGate;
  readonly store: Store;
  readonly estimateAiUnits: (workKind: string) => number;
  readonly aiUnits?: AiUnitsConfig;      // existing client/src/daemon/ai-units-gate.ts shape
  readonly spendCap?: SpendCapConfig;    // existing client/src/daemon/spend-cap-gate.ts shape
  readonly pollIntervalMs: number;
  readonly acceptLegacyCards: boolean;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

export class WorkLoop {
  constructor(config: WorkLoopConfig);
  /** One pass over new archive cards. Returns per-card outcomes for assertions. */
  tick(): Promise<readonly { card: string; outcome: WorkLoopOutcome }[]>;
  run(): Promise<void>;
  stop(): void;
}

export type WorkLoopOutcome =
  | { readonly kind: 'skipped'; readonly reason: 'gate-closed' | 'mapping-refused' | 'ai-units-capped' | 'spend-capped' | 'already-engaged' }
  | { readonly kind: 'pipeline'; readonly result: PipelineRunOutcome };
```

`tick()` sequence per card — the ordering is contract-bearing:

1. `await claimGate.waitUntilOpen()` (contract 3). If still closed, emit `skipped/gate-closed`.
2. `mapAnnouncedSubmissionToFacts(card, { estimateAiUnits, acceptLegacyCards })`. Refusal → `skipped/mapping-refused`.
3. `gateClaimByAiUnits({...})` and `gateClaimBySpendCap({...})` against the **existing SQLite rolling-window accounting** (`store.usdMicrosThisBlock` / `usdMicrosThisWeek`, `store.spentTodayUsd`). This is the "cap gates re-pointed at pipeline caps while keeping their SQLite rolling-window accounting" the spec §6.5 requires: `checkCaps` inside `runPipeline` enforces the per-task ceiling; these gates enforce the rolling window the pipeline has no state for.
4. `resolveWiringEntry(facts.workKind, composition.pipelineConfig.wiring)`. Undefined → let `runPipeline` return `not-claimed/wiring-missing`.
5. `ledger.admitClaimIntent({...})` — **contract 2**: the row lands in one transaction, strictly before any broadcast. `false` → `skipped/already-engaged`.
6. `await runPipeline({ facts, taskBytes, submissionBytes }, composition.pipelineConfig, composition.backend, ports)` where `ports` wraps `composition.pipelinePorts` with a `settlement.readMechDeliveryFacts` that first calls `deliverToMarketplace(...)` (Task 8) for the engagement's `requestId`, so the Mech Deliver fact exists before settlement reads it.
7. On `claim.ok` (observed through the wrapped `claim.claimTask` port), `ledger.recordClaimed(...)`.
8. On `delivered`, `await composition.evidence.ports.awaitIndexed(receipt.record)` (announce-after-indexed, contract 6) then `ledger.recordOutcome(key, 'settled')`.
9. On `race-lost` → `'race-lost'`; on every other non-delivered outcome → `'abandoned'`, and when `outcome.released === false` log the §4 unreleased-attempt line so the state message fires.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/work-loop.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { EngagementLedger } from '../../src/daemon/engagement-ledger.js';
import { WorkLoop } from '../../src/daemon/work-loop.js';
import { card, composition, openGate, closedGate } from './_work-loop-fixtures.js';

function build(overrides: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  return {
    store,
    ledger: new EngagementLedger(store),
    loop: new WorkLoop({
      composition: composition(),
      archive: { since: async () => [card()] },
      ledger: new EngagementLedger(store),
      claimGate: openGate(),
      store,
      estimateAiUnits: () => 1,
      pollIntervalMs: 5,
      acceptLegacyCards: true,
      ...overrides,
    } as never),
  };
}

describe('work loop', () => {
  it('refuses to claim before the projector catch-up gate opens', async () => {
    const { loop } = build({ claimGate: closedGate() });
    expect(await loop.tick()).toEqual([
      { card: expect.any(String), outcome: { kind: 'skipped', reason: 'gate-closed' } },
    ]);
  });

  it('writes the ledger row before the claim broadcast', async () => {
    const order: string[] = [];
    const store = new Store(':memory:');
    const ledger = new EngagementLedger(store);
    const admit = vi.spyOn(ledger, 'admitClaimIntent').mockImplementation((...args) => {
      order.push('ledger');
      return EngagementLedger.prototype.admitClaimIntent.apply(ledger, args as never);
    });
    const loop = new WorkLoop({
      composition: composition({ onClaimBroadcast: () => order.push('broadcast') }),
      archive: { since: async () => [card()] },
      ledger,
      claimGate: openGate(),
      store,
      estimateAiUnits: () => 1,
      pollIntervalMs: 5,
      acceptLegacyCards: true,
    } as never);
    await loop.tick();
    expect(order).toEqual(['ledger', 'broadcast']);
    expect(admit).toHaveBeenCalledOnce();
  });

  it('never claims the same task twice across ticks', async () => {
    const { loop, ledger } = build();
    await loop.tick();
    const second = await loop.tick();
    expect(second[0]!.outcome).toEqual({ kind: 'skipped', reason: 'already-engaged' });
    expect(ledger.listUnreconciled().length).toBeLessThanOrEqual(1);
  });

  it('sends the mech Deliver leg before settlement reads its facts', async () => {
    const order: string[] = [];
    const { loop } = build({
      composition: composition({
        onMechDeliver: () => order.push('deliver'),
        onReadMechFacts: () => order.push('read-facts'),
      }),
    });
    await loop.tick();
    expect(order).toEqual(['deliver', 'read-facts']);
  });

  it('awaits evidence indexing before recording settlement', async () => {
    const order: string[] = [];
    const { loop } = build({
      composition: composition({
        onAwaitIndexed: () => order.push('await-indexed'),
        onSettled: () => order.push('settled'),
      }),
    });
    await loop.tick();
    expect(order).toEqual(['settled', 'await-indexed']);
  });

  it('logs the unreleased-attempt state message when a post-claim failure did not release', async () => {
    const warn = vi.fn();
    const { loop } = build({
      composition: composition({
        pipelineOutcome: { kind: 'submit-rejected', detail: 'backend refused', released: false },
      }),
      logger: { info: vi.fn(), warn },
    });
    await loop.tick();
    expect(warn.mock.calls.flat().join('\n')).toContain('unreleased attempt');
  });

  it('respects the SQLite rolling-window AI-unit cap', async () => {
    const { loop } = build({
      aiUnits: { capPerBlockUsdMicros: 1, capPerWeekUsdMicros: 1, credentialId: 'c' },
      estimateAiUnits: () => 10_000,
    });
    expect((await loop.tick())[0]!.outcome).toEqual({
      kind: 'skipped',
      reason: 'ai-units-capped',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/daemon/work-loop.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/daemon/work-loop.js"`.

- [ ] **Step 3: Write minimal implementation**

Implement `WorkLoop` exactly as the nine-step sequence above. The one subtlety worth spelling out is the settlement-port wrapper that guarantees the deliver leg precedes the facts read:

```ts
  private settlementPortsFor(requestId: () => `0x${string}` | undefined): SettlementPorts {
    const base = this.config.composition.pipelinePorts.settlement;
    let delivered = false;
    return {
      ...base,
      readMechDeliveryFacts: async (input) => {
        if (!delivered) {
          await deliverToMarketplace(
            {
              safeAddress: this.config.composition.safeAddress,
              mechAddress: this.config.composition.mechAddress,
              requestId: input.requestId,
              deliveryBytes: this.currentDeliveryBytes!,
            },
            getVenueBroadcaster()!,
          );
          delivered = true;
        }
        return base.readMechDeliveryFacts(input);
      },
    };
  }
```

`run()` uses `runLoop({ name: 'work', intervalMs, store, body })`; `LOOP_REGISTRY` gains `work: { intervalMs: 5000, floorMs: 300_000 }`. `daemon.start()` starts `projector`, `work`, and `evidence-driver` when `config.composition` is present, and adds all three to the watchdog `started` set at `client/src/daemon/daemon.ts:551`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon && yarn typecheck`
Expected: PASS (7 new tests plus the existing daemon suite), zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/work-loop.ts client/src/daemon/daemon.ts client/src/daemon/loop-heartbeat.ts client/test/daemon/work-loop.test.ts
git commit -m "feat(operator): add the work loop closing claim to settle on the merged stack"
```

---

## Task 14: Bridge-era fixtures — RED first

**Files:**
- Create: `client/test/bridge/legacy-facts-card.test.ts`, `client/test/bridge/converged-delivery-legacy-evaluator.test.ts`
- Test: the two files above

Contract 9 says legacy-evaluator parseability is "verified by a stage-1 fixture, not assumed". This task writes the fixtures **before** the bridge exists so the gap is proven rather than argued. Both start red; Task 15 turns them green.

**Interfaces:**
- Consumes: `mapAnnouncedSubmissionToFacts` (Task 5); `SignedEnvelopeSchema` (`@jinn-network/core`, re-exported by `client/src/types/envelope.ts`); `sealDelivery`, `DeliveryRecordSchema` (`@jinn-network/task-execution-protocol`).
- Produces: no source; two fixtures other tasks must keep green.

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/bridge/legacy-facts-card.test.ts
import { describe, expect, it } from 'vitest';
import { mapAnnouncedSubmissionToFacts } from '@jinn-network/marketplace-pipeline';
import { synthesizeLegacyFactsCard } from '../../src/daemon/bridge-legacy-delivery.js';

const ANCHORED_TASK = {
  taskId: 77n,
  manifestDigest: 'QmSolver',
  taskCidDigest: `0x${'a'.repeat(64)}` as const,
  taskBytes: new TextEncoder().encode(
    JSON.stringify({ protocol: 'https://jinn.network/profiles/task-execution/1.0' }),
  ),
  solutionBudgetWei: 1_000_000_000_000n,
};

describe('bridge-era legacy facts card', () => {
  it('synthesizes a submission card under the legacy derivation annotation', () => {
    const card = synthesizeLegacyFactsCard(ANCHORED_TASK);
    expect(card.derivationKind).toBe('legacy');
    expect(card.legacyManifestDigest).toBe('QmSolver');
    expect(card.record.kind).toBe(
      'https://jinn.network/records/task-execution/submission/1.0',
    );
  });

  it('maps cleanly through the pipeline facts mapper with the bridge accepted', () => {
    const result = mapAnnouncedSubmissionToFacts(synthesizeLegacyFactsCard(ANCHORED_TASK), {
      estimateAiUnits: () => 1,
      acceptLegacyCards: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.facts.workKind).toBe('QmSolver');
    expect(result.facts.legacyManifestDigest).toBe('QmSolver');
    expect(result.facts.taskId).toBe(77n);
  });

  it('is refused once the bridge retires at stage 5', () => {
    expect(
      mapAnnouncedSubmissionToFacts(synthesizeLegacyFactsCard(ANCHORED_TASK), {
        estimateAiUnits: () => 1,
        acceptLegacyCards: false,
      }).ok,
    ).toBe(false);
  });
});
```

```ts
// client/test/bridge/converged-delivery-legacy-evaluator.test.ts
import { describe, expect, it } from 'vitest';
import { sealDelivery } from '@jinn-network/task-execution-protocol';
import { SignedEnvelopeSchema } from '../../src/types/envelope.js';
import { legacyRestorationResultFromDelivery } from '../../src/daemon/bridge-legacy-delivery.js';

/** Exactly the shape `LocalTaskExecutionBackend` seals (assembly/src/backend.ts:1585). */
function convergedDelivery(legacyEnvelope: unknown): Uint8Array {
  return sealDelivery({
    protocol: 'https://jinn.network/profiles/task-execution/1.0',
    attempt: 'urn:uuid:11111111-2222-3333-4444-555555555555',
    task: `sha256:${'b'.repeat(64)}`,
    outputs: [
      {
        name: 'prediction.json',
        mediaType: 'application/json',
        digest: { sha256: 'c'.repeat(64) },
      },
    ],
    outcome: 'fulfilled',
    executionIds: ['urn:uuid:22222222-3333-4444-5555-666666666666'],
    evidenceRecords: [
      { repository: 'urn:jinn:evidence:repository:local', record: `sha256:${'d'.repeat(64)}` },
    ],
    createdAt: '2026-07-30T09:00:00.000Z',
    // Bridge annotation — namespaced extension, permitted by DeliveryRecordSchema's `.loose()`
    // and TEP §21.3. Task 15 makes the backend emit it.
    'https://jinn.network/bridge/legacy-execution-envelope/1.0': JSON.stringify(legacyEnvelope),
  } as never);
}

const LEGACY_ENVELOPE = {
  schemaVersion: 'jinn.execution.v1',
  solverType: 'prediction.v1',
  role: 'solution',
  generatedAt: '2026-07-30T09:00:00.000Z',
  participant: '0x1111111111111111111111111111111111111111',
  window: { start: '2026-07-30T08:00:00.000Z', end: '2026-07-30T09:00:00.000Z' },
  executor: { kind: 'harness', name: 'claude-code', version: '1.0.0' },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: { prediction: 0.42 },
  signature: {
    algo: 'secp256k1',
    signer: '0x1111111111111111111111111111111111111111',
    hash: `0x${'e'.repeat(64)}`,
    sig: `0x${'f'.repeat(130)}`,
  },
};

describe('converged Delivery is parseable by the legacy evaluator path', () => {
  it('yields a restorationResult string the legacy evaluator schema accepts', () => {
    const restorationResult = legacyRestorationResultFromDelivery(
      convergedDelivery(LEGACY_ENVELOPE),
    );
    expect(typeof restorationResult).toBe('string');
    const parsed = SignedEnvelopeSchema.parse(JSON.parse(restorationResult!));
    expect(parsed.schemaVersion).toBe('jinn.execution.v1');
    expect(parsed.solverType).toBe('prediction.v1');
    expect(parsed.role).toBe('solution');
  });

  it('returns undefined for a Delivery carrying no bridge annotation', () => {
    const bare = sealDelivery({
      protocol: 'https://jinn.network/profiles/task-execution/1.0',
      attempt: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      task: `sha256:${'b'.repeat(64)}`,
      outputs: [],
      outcome: 'fulfilled',
      executionIds: ['urn:uuid:22222222-3333-4444-5555-666666666666'],
      evidenceRecords: [
        { repository: 'urn:jinn:evidence:repository:local', record: `sha256:${'d'.repeat(64)}` },
      ],
      createdAt: '2026-07-30T09:00:00.000Z',
    } as never);
    expect(legacyRestorationResultFromDelivery(bare)).toBeUndefined();
  });

  it('still passes the binding admission check with the bridge annotation present', async () => {
    const { inspectDelivery } = await import('@jinn-network/marketplace-binding');
    expect(() => inspectDelivery(convergedDelivery(LEGACY_ENVELOPE))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/bridge`
Expected: FAIL with `Failed to resolve import "../../src/daemon/bridge-legacy-delivery.js"`. **Do not implement anything in this task.** Commit the red fixtures so the gap is on record.

- [ ] **Step 3: Record the gap in the commit body**

No implementation. Write the commit message body to state exactly what the fixtures prove:

> The backend seals a fixed-shape TEP DeliveryRecord (assembly/src/backend.ts:1585) with no
> `jinn.execution.v1` content and no extension hook, while every legacy evaluator parses
> `task.context.restorationResult` through `SignedEnvelopeSchema`. These fixtures pin the bridge
> requirement; Task 15 satisfies it.

- [ ] **Step 4: Confirm the failure output is the expected one**

Run: `cd client && yarn vitest run test/bridge 2>&1 | tail -20`
Expected: only unresolved-import failures — no assertion failures, which would mean the fixtures encode the wrong shape.

- [ ] **Step 5: Commit**

```bash
git add client/test/bridge
git commit -m "test(operator): pin the bridge-era facts card and Delivery parseability fixtures"
```

---

## Task 15: The bridge — legacy facts cards and legacy-evaluator-parseable deliveries

**Files:**
- Create: `client/src/daemon/bridge-legacy-delivery.ts`
- Modify: `packages/task-execution/backend-local/assembly/src/backend.ts:494` (add `deliveryExtensions` to `LocalTaskExecutionBackendConfig`) and `:1585` (spread it into `sealDelivery`), `client/src/daemon/composition-root.ts` (supply the hook), `client/src/adapters/mech/adapter.ts:1124` and `:1154` (bridge read path)
- Test: `client/test/bridge/*` (Task 14, now green), `packages/task-execution/backend-local/assembly/src/backend.evidence.test.ts` (extension round-trip)

> **Operator ruling required before implementing this task.** See Finding F2. The planned path is
> D3 below; D1 and D2 are the recorded alternatives. Do not start until the ruling is recorded in
> the PR thread.

**Planned path (D3):** the backend gains one optional, namespaced extension hook. `DeliveryRecordSchema` is `.loose()` and TEP §21.3 explicitly admits namespaced extensions, so this adds no protocol semantics — it is a bridge annotation with a dated retirement (spec §9, "after stage 5"). The host builds the legacy `jinn.execution.v1` envelope from the attempt's harvested outputs, signs it with the agent key, and hands it to the backend through the hook. The legacy mech adapter's read path prefers the annotation.

**Interfaces:**
- Consumes: `SignedEnvelopeSchema` (`client/src/types/envelope.ts`); `HarvestResult` (`@jinn-network/task-execution-workspace`); the existing legacy envelope builder in `client/src/harnesses/engine/` (reuse, do not re-derive the payload shapes).
- Produces:

```ts
// client/src/daemon/bridge-legacy-delivery.ts
export const LEGACY_ENVELOPE_EXTENSION_KEY =
  'https://jinn.network/bridge/legacy-execution-envelope/1.0';

/** The projector's synthesized submission card for a legacy-posted task (contract 9). */
export function synthesizeLegacyFactsCard(anchored: {
  readonly taskId: bigint;
  readonly manifestDigest: string;
  readonly taskCidDigest: `0x${string}`;
  readonly taskBytes: Uint8Array;
  readonly solutionBudgetWei: bigint;
}): AnnouncedSubmissionCard;

/** Reads the bridge annotation off sealed Delivery bytes. `undefined` when absent. */
export function legacyRestorationResultFromDelivery(
  sealedDeliveryBytes: Uint8Array,
): string | undefined;

/** Builds and signs the `jinn.execution.v1` envelope the legacy evaluator expects. */
export function buildLegacyExecutionEnvelope(input: {
  readonly solverType: string;
  readonly participant: `0x${string}`;
  readonly harness: string;
  readonly harvest: HarvestResult;
  readonly outputsRoot: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly sign: (hash: `0x${string}`) => `0x${string}`;
}): { readonly json: string; readonly evidenceHash: `0x${string}` };
```

- [ ] **Step 1: Run the Task 14 fixtures to confirm they are still red**

Run: `cd client && yarn vitest run test/bridge`
Expected: FAIL with `Failed to resolve import "../../src/daemon/bridge-legacy-delivery.js"` — the same failure Task 14 recorded.

- [ ] **Step 2: Add the backend extension hook with its own round-trip test**

Append to `packages/task-execution/backend-local/assembly/src/backend.evidence.test.ts`:

```ts
it("carries a host-supplied namespaced Delivery extension into the sealed bytes", async () => {
  const backend = makeBackendFixture({
    deliveryExtensions: () => ({
      "https://jinn.network/bridge/legacy-execution-envelope/1.0": "{\"schemaVersion\":\"jinn.execution.v1\"}",
    }),
  });
  const { deliveryBytes } = await runToDelivery(backend);
  const parsed = JSON.parse(new TextDecoder().decode(deliveryBytes));
  expect(parsed["https://jinn.network/bridge/legacy-execution-envelope/1.0"])
    .toBe("{\"schemaVersion\":\"jinn.execution.v1\"}");
  // The extension must not break canonical sealing or binding admission.
  expect(() => inspectDelivery(deliveryBytes)).not.toThrow();
});

it("refuses a non-namespaced extension key", async () => {
  const backend = makeBackendFixture({ deliveryExtensions: () => ({ data: "x" }) });
  await expect(runToDelivery(backend)).rejects.toThrow(
    "Delivery extension keys must be absolute URIs",
  );
});
```

Then in `packages/task-execution/backend-local/assembly/src/backend.ts`, add to `LocalTaskExecutionBackendConfig`:

```ts
  /**
   * Host-supplied namespaced Delivery extensions (TEP §21.3). Keys must be absolute URIs; the
   * backend adds no semantics of its own. Used by the operator runtime's bridge era only.
   */
  readonly deliveryExtensions?: (input: {
    readonly attempt: AttemptUri;
    readonly harvest: HarvestResult;
    readonly task: TaskSpecification;
  }) => Readonly<Record<string, JsonValue>>;
```

and at the `sealDelivery` call (line 1585) compute and spread them:

```ts
    const extensions = this.config.deliveryExtensions?.({ attempt, harvest, task: input.task }) ?? {};
    for (const key of Object.keys(extensions)) {
      if (!/^[a-z][a-z0-9+.-]*:/iu.test(key)) {
        throw new Error("Delivery extension keys must be absolute URIs");
      }
    }
    const deliveryBytes = sealDelivery({ ...extensions, protocol: "https://jinn.network/profiles/task-execution/1.0", /* …unchanged fields… */ });
```

Reserved keys win: the spread puts `extensions` first so no extension can shadow `protocol`, `attempt`, `task`, `outputs`, `outcome`, `executionIds`, `evidenceRecords`, or `createdAt`.

- [ ] **Step 3: Write the host bridge module**

```ts
// client/src/daemon/bridge-legacy-delivery.ts
import { RECORD_KINDS_SUBMISSION, type AnnouncedSubmissionCard } from '@jinn-network/marketplace-pipeline';
import { documentDigest } from '@jinn-network/task-execution-protocol';

export const LEGACY_ENVELOPE_EXTENSION_KEY =
  'https://jinn.network/bridge/legacy-execution-envelope/1.0';

export function synthesizeLegacyFactsCard(anchored: {
  readonly taskId: bigint;
  readonly manifestDigest: string;
  readonly taskCidDigest: `0x${string}`;
  readonly taskBytes: Uint8Array;
  readonly solutionBudgetWei: bigint;
}): AnnouncedSubmissionCard {
  const taskDigest = documentDigest(anchored.taskBytes);
  return {
    record: { kind: RECORD_KINDS_SUBMISSION, digest: taskDigest },
    facts: {
      taskDigest,
      // A legacy-posted task carries no sealed Submission and therefore no profile URI; the
      // bridge names the repository-work profile the legacy harnesses always ran under.
      taskProfileUri: 'https://jinn.network/profiles/task-execution/repository-work/1.0',
      requirements: {},
    },
    chain: {
      taskId: anchored.taskId,
      // Legacy tasks have no Submission UUID; the bridge derives a stable one from the anchor.
      submission: `urn:uuid:${uuidFromDigest(anchored.taskCidDigest)}`,
      nonce: anchored.taskCidDigest,
      intendedSpendWei: anchored.solutionBudgetWei,
    },
    derivationKind: 'legacy',
    legacyManifestDigest: anchored.manifestDigest,
  };
}

export function legacyRestorationResultFromDelivery(
  sealedDeliveryBytes: Uint8Array,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sealedDeliveryBytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[LEGACY_ENVELOPE_EXTENSION_KEY];
  return typeof value === 'string' ? value : undefined;
}
```

`uuidFromDigest` is a local helper formatting the first 16 bytes of the digest as an RFC 4122 v4-shaped UUID — deterministic so a re-run of the projector synthesizes the identical card.

`buildLegacyExecutionEnvelope` reuses the existing legacy envelope construction in `client/src/harnesses/engine/` rather than re-deriving payload shapes; it reads the harvested artifact named by the solver type's declared output slot, sets `evidenceTier: 'self-signed'`, and signs the canonical hash with the agent key.

- [ ] **Step 4: Wire the bridge read path into the legacy adapter and the hook into the composition root**

In `client/src/adapters/mech/adapter.ts`, in `evaluationAnnouncementForSolution` (L1154), replace the single line that derives `resultData`:

```ts
    // Was: const resultData = (resultPayload.data as string) ?? JSON.stringify(resultPayload);
    const bridged = legacyRestorationResultFromDelivery(rawDeliveryBytes);
    const resultData =
      bridged ?? (resultPayload.data as string) ?? JSON.stringify(resultPayload);
```

with `rawDeliveryBytes` being the exact bytes `fetchFromIpfs` already retrieved. This is the *only* change to the legacy evaluation path in this stage: a read-path preference, no state-machine change, no schema change, no new transaction. The Task 16 regression test proves the untouched branch still works.

In `client/src/daemon/composition-root.ts`, supply the hook on `LocalTaskExecutionBackendConfig`:

```ts
    deliveryExtensions: ({ harvest, task }) => {
      const wiring = resolveWiringEntry(workKindFor(task), pipelineConfig.wiring);
      if (wiring === undefined) return {};
      const { json } = buildLegacyExecutionEnvelope({
        solverType: wiring.workKind,
        participant: input.safeAddress,
        harness: wiring.harness,
        harvest,
        outputsRoot: /* attempt out/ path */,
        startedAt, endedAt,
        sign: signWithAgentKey,
      });
      return { [LEGACY_ENVELOPE_EXTENSION_KEY]: json };
    },
```

- [ ] **Step 5: Run every affected suite to verify green**

Run:
```bash
cd packages/task-execution/backend-local/assembly && yarn vitest run && yarn typecheck
cd ../../../../client && yarn vitest run test/bridge test/adapters test/daemon && yarn typecheck
```
Expected: PASS — the two Task 14 fixture files go green, the two new backend tests pass, the marketplace binding admission check still accepts the extended Delivery, and no existing adapter test regresses.

- [ ] **Step 6: Commit**

```bash
git add packages/task-execution/backend-local/assembly/src/backend.ts packages/task-execution/backend-local/assembly/src/backend.evidence.test.ts client/src/daemon/bridge-legacy-delivery.ts client/src/daemon/composition-root.ts client/src/adapters/mech/adapter.ts
git commit -m "feat(operator): bridge legacy facts cards and legacy-evaluator-parseable deliveries"
```

---

## Task 16: Retire the TaskEngine solution path and `joinedSolverNets` claim gating

**Files:**
- Modify: `client/src/harnesses/engine/engine.ts:732` (`canAcceptTask`), `client/src/daemon/daemon.ts:668` (`_runEngineWatcherLoop`), `client/src/adapters/mech/adapter.ts:1019` (`discoverSubgraphRestorationTasks`) and `:1392` (`watchForTasks`)
- Test: `client/test/daemon/solution-path-retired.test.ts`, `client/test/daemon/evaluation-path-regression.test.ts`

The legacy engine keeps running evaluations. It stops running solutions, and `joinedSolverNets` stops gating claims — the predicate plus wiring (with the bridge annotation active) is the authority from here.

**Interfaces:**
- Consumes: `TaskEngine.canAcceptTask` (`client/src/harnesses/engine/engine.ts:732`), `MechAdapter.watchForTasks` (`client/src/adapters/mech/adapter.ts:1392`).
- Produces: no new exports. Behavioural contract:
  - `canAcceptTask({ taskRole: 'restoration', … })` resolves `{ ok: false, reason: 'solution path retired at cutover stage 1' }`.
  - `canAcceptTask({ taskRole: 'evaluation', … })` is unchanged in every branch.
  - `watchForTasks()` yields **only** evaluation announcements.
  - `task_runs` receives no new `task_role = 'restoration'` rows.

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/daemon/solution-path-retired.test.ts
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { engineFixture, restorationTask, adapterFixture } from './_engine-fixtures.js';

describe('solution path retired at stage 1', () => {
  it('refuses a restoration task with a named reason', async () => {
    const engine = engineFixture();
    await expect(
      engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'restoration', task: restorationTask() }),
    ).resolves.toEqual({ ok: false, reason: 'solution path retired at cutover stage 1' });
  });

  it('writes no new restoration row to task_runs', async () => {
    const store = new Store(':memory:');
    const engine = engineFixture({ store });
    await engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'restoration', task: restorationTask() });
    const rows = new TaskRunPersistence(store.db).getInFlight();
    expect(rows.filter((row) => row.taskRole === 'restoration')).toEqual([]);
  });

  it('yields no restoration announcements from watchForTasks', async () => {
    const adapter = adapterFixture({ routerLogs: ['TaskCreated', 'SolutionDeliveryClaimed'] });
    const yielded: string[] = [];
    for await (const announcement of adapter.watchForTasks()) {
      yielded.push(announcement.task.role);
      if (yielded.length >= 1) break;
    }
    expect(yielded).toEqual(['evaluation']);
  });

  it('claims regardless of joinedSolverNets — the predicate is the authority', async () => {
    const adapter = adapterFixture({ joinedSolverNets: {}, routerLogs: ['SolutionDeliveryClaimed'] });
    const yielded: unknown[] = [];
    for await (const announcement of adapter.watchForTasks()) {
      yielded.push(announcement);
      break;
    }
    expect(yielded).toHaveLength(1);
  });
});
```

```ts
// client/test/daemon/evaluation-path-regression.test.ts
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { engineFixture, evaluationTask } from './_engine-fixtures.js';

describe('evaluation path is untouched at stage 1', () => {
  it('still accepts an evaluation task', async () => {
    const engine = engineFixture();
    await expect(
      engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'evaluation', task: evaluationTask() }),
    ).resolves.toEqual({ ok: true });
  });

  it('still runs an evaluation DISCOVERED → COMPLETE and claims the verdict delivery', async () => {
    const store = new Store(':memory:');
    const engine = engineFixture({ store });
    const requestId = await engine.observe(evaluationTask());
    await engine.process(requestId);
    const row = new TaskRunPersistence(store.db).getOrThrow(requestId);
    expect(row.state).toBe('COMPLETE');
    expect(row.taskRole).toBe('evaluation');
    expect(row.deliveryTxHash).toMatch(/^0x[0-9a-f]{64}$/u);
  });

  it('still parses a bridged converged Delivery into restorationResult', async () => {
    const engine = engineFixture();
    const task = evaluationTask({ bridged: true });
    await expect(
      engine.canAcceptTask({ solverType: 'prediction.v1', taskRole: 'evaluation', task }),
    ).resolves.toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run test/daemon/solution-path-retired.test.ts test/daemon/evaluation-path-regression.test.ts`
Expected: the four `solution-path-retired` tests FAIL (restoration is still accepted and still yielded); the three `evaluation-path-regression` tests PASS already — they are the guard rail, and they must stay green through Step 3.

- [ ] **Step 3: Write minimal implementation**

In `client/src/harnesses/engine/engine.ts`, first statement of `canAcceptTask`:

```ts
    // Cutover stage 1: the solution path moved to the work loop on the merged stack. The
    // evaluation path below is untouched and retires at stage 2.
    if (input.taskRole === 'restoration') {
      return { ok: false, reason: 'solution path retired at cutover stage 1' };
    }
```

In `client/src/adapters/mech/adapter.ts` `watchForTasks` (L1392): delete the `decodeTaskCreatedLogs` → announce block and the `yield* this.discoverSubgraphRestorationTasks()` call. Keep `rememberCanonicalTaskCreated(event)` — the evaluation provenance cross-check reads it. Keep both `retryPendingEvaluationSolutions()` calls, the `decodeSolutionDeliveryClaimedLogs` ingestion, the cursor advance, and `recordLoopTick(this.store, 'engine-watcher')`.

In `client/src/daemon/daemon.ts` `_runEngineWatcherLoop` (L668): the loop body now only ever sees evaluation announcements, so the readiness / AI-units / spend-cap gates keep applying to them unchanged. Delete nothing; add one assertion at the top of the per-announcement body so a regression is loud:

```ts
      if (taskAnnouncement.task.role !== 'evaluation') {
        this.config.logger?.warn(
          `[engine-watcher] ignoring non-evaluation announcement ${taskAnnouncement.taskId} — the solution path retired at stage 1`,
        );
        continue;
      }
```

Also drop the joined-manifest-digest filter inside `watchForTasks` (the `joinedSolverNets` claim gate the retirement table names): evaluation opportunities are gated by `canClaimEvaluation` on chain, and solution claiming is now the predicate's job.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn vitest run test/daemon test/adapters test/harnesses/engine && yarn typecheck`
Expected: PASS — the four retirement tests go green and all three evaluation regression tests stay green. Any existing test asserting restoration discovery must be **deleted with its scenario moved into the venue kit or the work-loop suite**, listed individually in the commit body.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/engine/engine.ts client/src/adapters/mech/adapter.ts client/src/daemon/daemon.ts client/test/daemon client/test/adapters
git commit -m "refactor(operator): retire the TaskEngine solution path and joinedSolverNets claim gating"
```

---

## Task 17: Claim policy & wiring page, plus the `OPERATOR-APP-SPEC` delta

**Files:**
- Create: `client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.tsx`, `client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.test.tsx`, `client/src/api/claim-policy-endpoints.ts`
- Modify: `client/src/dashboard/spa/src/routes.ts`, `client/src/dashboard/spa/src/App.tsx:132-172`, `client/src/dashboard/spa/src/pages/operator/OperatorSubNav.tsx`, `client/src/dashboard/spa/src/api/client.ts`, `client/src/api/server.ts` (register the routes eagerly), `client/OPERATOR-APP-SPEC.md`
- Test: `client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.test.tsx`, `client/test/api/claim-policy-endpoints.test.ts`, `client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts` (picks up the new route automatically from `routes.ts`)

Spec §9: "the memberships page becomes **Claim policy & wiring** (predicate, wiring entries, caps, migration state message)". Memberships stays mounted at `/operator/memberships` until stage 5 — it still describes the legacy joins that the evaluator path reads — and the new page is added beside it as the surface that actually governs claiming. `OPERATOR-APP-SPEC.md` gains §2.15 in the same PR, per the frontend rules.

**Interfaces:**
- Consumes: `ClaimPolicyConfig`, `ExecutionWiringConfigEntry` (Task 1); `persistTopLevelConfigValue` (`client/src/config.ts:1467`) replaced by `writeConfigFileAtomic` (Task 2).
- Produces:

```ts
// client/src/api/claim-policy-endpoints.ts
export interface ClaimPolicyRoutesConfig {
  readonly configPath: string;
  readonly readConfig: () => JinnConfig;
  readonly writeConfig: (filePath: string, value: unknown) => void;
}
export function addClaimPolicyRoutes(app: Hono, config: ClaimPolicyRoutesConfig): void;
// GET    /v1/operator/claim-policy  -> { claimPolicy, executionWiring, restartRequired: boolean }
// PUT    /v1/operator/claim-policy  -> body { claimPolicy } ; 400 on schema failure
// PUT    /v1/operator/execution-wiring -> body { executionWiring: ExecutionWiringConfigEntry[] }

// client/src/dashboard/spa/src/api/client.ts additions
api.operator.getClaimPolicy(): Promise<ClaimPolicyResponse>;
api.operator.setClaimPolicy(body: { claimPolicy: ClaimPolicyConfig }): Promise<void>;
api.operator.setExecutionWiring(body: { executionWiring: ExecutionWiringConfigEntry[] }): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```tsx
// client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ClaimPolicyTab } from './ClaimPolicyTab.js';
import { renderWithProviders } from '../../test-utils.js';

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
      getClaimPolicy: vi.fn(async () => ({
        claimPolicy: { mode: 'match-legacy-manifest-digest', spendCapWei: '0', aiUnitCap: 0 },
        executionWiring: [
          {
            workKind: 'QmSolver',
            harness: 'claude-code',
            model: 'claude-haiku-4-5-20251001',
            plugins: [],
            credentialRef: 'claude-code-default',
            isolationPolicy: 'process',
            legacyManifestDigest: 'QmSolver',
          },
        ],
        restartRequired: false,
      })),
      setClaimPolicy: vi.fn(async () => {}),
      setExecutionWiring: vi.fn(async () => {}),
    },
  },
}));

describe('ClaimPolicyTab', () => {
  it('shows the predicate mode, the caps, and one row per wiring entry', async () => {
    renderWithProviders(<ClaimPolicyTab />);
    expect(await screen.findByTestId('claim-policy-tab')).toBeInTheDocument();
    expect(screen.getByTestId('claim-policy-mode')).toHaveTextContent(
      'match-legacy-manifest-digest',
    );
    expect(screen.getByTestId('claim-policy-spend-cap')).toHaveValue('0');
    expect(screen.getAllByTestId('execution-wiring-row')).toHaveLength(1);
    expect(screen.getByText('QmSolver')).toBeInTheDocument();
  });

  it('renders the claims-nothing notice while a cap is zero', async () => {
    renderWithProviders(<ClaimPolicyTab />);
    expect(await screen.findByTestId('claim-policy-caps-unset')).toHaveTextContent(
      'No tasks will be claimed until both caps are above zero.',
    );
  });

  it('saves an edited spend cap and flags the restart requirement', async () => {
    const { api } = await import('../../api/client.js');
    renderWithProviders(<ClaimPolicyTab />);
    const input = await screen.findByTestId('claim-policy-spend-cap');
    await userEvent.clear(input);
    await userEvent.type(input, '2500000000000000');
    await userEvent.click(screen.getByTestId('claim-policy-save'));
    await waitFor(() =>
      expect(api.operator.setClaimPolicy).toHaveBeenCalledWith({
        claimPolicy: {
          mode: 'match-legacy-manifest-digest',
          spendCapWei: '2500000000000000',
          aiUnitCap: 0,
        },
      }),
    );
    expect(screen.getByTestId('claim-policy-restart-required')).toBeInTheDocument();
  });

  it('renders an empty state naming what fills it', async () => {
    const { api } = await import('../../api/client.js');
    vi.mocked(api.operator.getClaimPolicy).mockResolvedValueOnce({
      claimPolicy: undefined,
      executionWiring: [],
      restartRequired: false,
    } as never);
    renderWithProviders(<ClaimPolicyTab />);
    expect(await screen.findByTestId('claim-policy-empty')).toHaveTextContent(
      'Join a SolverNet to create your first execution wiring entry.',
    );
  });
});
```

```ts
// client/test/api/claim-policy-endpoints.test.ts
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { addClaimPolicyRoutes } from '../../src/api/claim-policy-endpoints.js';

function app(config: Record<string, unknown> = {}) {
  const hono = new Hono();
  addClaimPolicyRoutes(hono, {
    configPath: '/tmp/config.json',
    readConfig: () =>
      ({
        claimPolicy: { mode: 'claim-nothing', spendCapWei: '0', aiUnitCap: 0 },
        executionWiring: [],
      }) as never,
    writeConfig: vi.fn(),
    ...config,
  } as never);
  return hono;
}

describe('claim policy endpoints', () => {
  it('returns the current policy and wiring', async () => {
    const response = await app().request('/v1/operator/claim-policy');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimPolicy: { mode: 'claim-nothing', spendCapWei: '0', aiUnitCap: 0 },
      executionWiring: [],
      restartRequired: false,
    });
  });

  it('writes an accepted policy atomically and reports restart-required', async () => {
    const writeConfig = vi.fn();
    const response = await app({ writeConfig }).request('/v1/operator/claim-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claimPolicy: { mode: 'every-runnable', spendCapWei: '10', aiUnitCap: 5 },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restartRequired: true });
    expect(writeConfig).toHaveBeenCalledOnce();
  });

  it('rejects a malformed policy with 400 and writes nothing', async () => {
    const writeConfig = vi.fn();
    const response = await app({ writeConfig }).request('/v1/operator/claim-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimPolicy: { mode: 'nope', spendCapWei: '0x1', aiUnitCap: -1 } }),
    });
    expect(response.status).toBe(400);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn vitest run src/dashboard/spa/src/pages/operator/ClaimPolicyTab.test.tsx test/api/claim-policy-endpoints.test.ts`
Expected: FAIL with unresolved imports for `./ClaimPolicyTab.js` and `../../src/api/claim-policy-endpoints.js`.

- [ ] **Step 3: Write minimal implementation**

`client/src/api/claim-policy-endpoints.ts` registers the three routes, validating bodies with `ClaimPolicyConfigSchema` / `z.array(ExecutionWiringConfigEntrySchema)` and writing through `writeConfigFileAtomic`. `client/src/api/server.ts` calls `addClaimPolicyRoutes(app, config.claimPolicy)` **eagerly** beside `addSetupRoutes` (line 629) — late mounting is banned by `yarn lint:no-late-mount`.

`ClaimPolicyTab.tsx` composes shadcn primitives only (`Card`, `Table`, `Input`, `Select`, `Button`, `Badge`, `Alert`) — no new custom components, so no snowflake approval is needed. Per the frontend "show, don't narrate" rule the page carries **no** caption text: the caps-unset alert and the empty state are the only prose, and both are load-bearing (an alert that names a blocked behaviour, and an empty state that says what fills it). Wiring rows render `workKind`, `harness`, `model`, `plugins`, `isolationPolicy`, and a `legacy` badge when `legacyManifestDigest` is set, with an `InfoTooltip` on that badge explaining the bridge — never a permanent caption.

Route registration: add `{ path: '/operator/claim-policy', label: 'operator-claim-policy' }` to `routes.ts`, a `<Route path="/operator/claim-policy">` inside `OperatorShell` in `App.tsx`, and `{ to: '/operator/claim-policy', label: 'Claim policy & wiring' }` as the **first** entry in `OperatorSubNav.tsx`'s `TABS`. Change the `/operator` redirect target from `/operator/memberships` to `/operator/claim-policy`.

- [ ] **Step 4: Update `client/OPERATOR-APP-SPEC.md` in the same PR**

Insert a new `### 2.15 Claim policy & wiring` between §2.14 and §3, following the existing four-axis discipline:

```markdown
### 2.15 Claim policy & wiring

How this operator decides what to claim and what runs it. Replaces `joinedSolverNets` as the
claim authority at cutover stage 1; memberships (§2.4) remain the legacy view until stage 5.

- **Static**
  - claim predicate mode — `claim-nothing` | `every-runnable` | `match-legacy-manifest-digest`
  - spend cap (wei) — per-task ceiling enforced before every claim
  - AI-unit cap — per-task ceiling enforced before every claim
  - shape version — `2` once the boot migration has run
  - **Actions**
    - edit claim predicate mode *(restart-required)*
    - edit spend cap *(restart-required)*
    - edit AI-unit cap *(restart-required)*
- **Collections**
  - execution wiring entries — one per work kind. Item shape: work kind, harness, model,
    plugins, credential reference, isolation policy, legacy manifest digest (bridge era only).
    Ordered by work kind. No pagination.
    - **Actions**
      - edit wiring entry *(restart-required)*
      - remove wiring entry *(restart-required)*
- **State messages**
  - claim policy migrated from SolverNet memberships — one-time, action-required while either
    cap is zero, informational afterwards. Action: set the caps.
  - caps unset — no tasks will be claimed. Action: set both caps above zero.
  - unreleased attempt — an attempt was claimed on chain but not settled by this daemon; it
    occupies its `maxClaims` slot until the venue reaps it. Informational in the today
    generation (there is no on-venue release); gains a release action with the revised
    generation.
  - evidence indexing failed — one or more evidence records failed to index. Action: none yet;
    the driver retries. Informational.
```

Also update §2.4's opening line to say memberships no longer gate claiming, and add `config_migrated`, `evidence_indexing_failed`, and `unreleased_attempt` to §2.10's kind list so the taxonomy and code agree.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd client && yarn vitest run src/dashboard/spa test/api && yarn build && yarn release:tier-1:T1.4
```
Expected: PASS — the four page tests, the three endpoint tests, and the route smoke walking the new `/operator/claim-policy` entry from `routes.ts`.

- [ ] **Step 6: Commit**

```bash
git add client/src/dashboard/spa client/src/api/claim-policy-endpoints.ts client/src/api/server.ts client/OPERATOR-APP-SPEC.md
git commit -m "feat(operator): add the Claim policy and wiring page with its OPERATOR-APP-SPEC entry"
```

---

## Task 18: Re-point `e2e:daemon-harness` at the new flow

**Files:**
- Modify: `client/test/e2e/daemon-harness-cycle.ts`, `client/test/e2e/_daemon-harness-helpers.ts`
- Test: the script itself is the gate

**What "re-pointed" changes**, precisely — the script keeps its five infrastructure phases (Anvil fork of Base, `startMockIpfsServer`, `bootstrapStakedOperator`, `deployMinimalV3Stack`, production `Daemon` + `MechAdapter`) and its clean-skip-on-missing-API-key behaviour. Four things move:

1. `startDaemon(...)` builds an `OperatorComposition` via `buildOperatorComposition` and passes it on `DaemonConfig`, so the daemon starts `projector`, `work`, and `evidence-driver` beside the legacy loops.
2. The fixture config is written in **shape v2** — `configShapeVersion: 2`, one `executionWiring` entry for the selected harness with `legacyManifestDigest` set to the fixture manifest CID, and a `claimPolicy` with non-zero caps. `joinedSolverNets` stays in the file so the migration idempotency path is exercised on the second boot.
3. `waitForDaemonClaim()` polls the **engagement ledger** (`SELECT outcome FROM engagement_ledger`) instead of `task_runs`, and `waitForDelivery()` asserts `outcome = 'settled'`.
4. Two assertions are added: the sealed Delivery carries the `LEGACY_ENVELOPE_EXTENSION_KEY` bridge annotation, and `legacyRestorationResultFromDelivery` on those exact bytes parses through `SignedEnvelopeSchema` — the Task 14 fixture, now proven against real bytes on a real fork.

Task 6's corpus-knowledge phase (#1393) keeps working: it reads `store.queryEnvelopeProjections` and `activity_events`, both untouched.

- [ ] **Step 1: Run the current gate to capture the pre-change baseline**

Run: `cd client && JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness`
Expected: PASS on the legacy flow. Save the output — the post-change run must reach the same terminal assertions.

- [ ] **Step 2: Re-point the script**

Apply the four changes above. In `_daemon-harness-helpers.ts`, `startDaemon` becomes:

```ts
  const composition = await buildOperatorComposition({
    config,
    publicClient: fixture.publicClient,
    walletClient: fixture.walletClient,
    safeAddress: operator.safeAddress,
    mechAddress: v3Env.mechAddress,
    chain: { ...BASE_SEPOLIA_TODAY, chainId: fixture.chainId,
             jinnRouter: v3Env.routerAddress, mechMarketplace: v3Env.marketplaceAddress },
    stateRoot: join(fixture.stateDir, 'backend'),
    evidenceRoot: join(fixture.stateDir, 'evidence'),
    venueStateDbPath: join(fixture.stateDir, 'venue.db'),
    profileStore: fixtureProfileStore(),
  });
  const daemon = new Daemon({ ...existingArgs, composition });
```

and `waitForDaemonClaim`:

```ts
export async function waitForDaemonClaim(store: Store, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = store.db
      .prepare(`SELECT idempotency_key, outcome FROM engagement_ledger ORDER BY created_at DESC LIMIT 1`)
      .get() as { idempotency_key: string; outcome: string } | undefined;
    if (row !== undefined && row.outcome !== 'intended') return row.idempotency_key;
    await sleep(2_000);
  }
  throw new Error('daemon did not claim through the work loop within the timeout');
}
```

- [ ] **Step 3: Run the re-pointed gate**

Run: `cd client && JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness`
Expected: PASS. Every phase reports green, the ledger reaches `settled`, the on-chain activity counter increments within 60s, and the two new bridge assertions pass. Show the full output in the task report.

- [ ] **Step 4: Run the gate for a second harness**

Run: `cd client && JINN_E2E_HARNESS=claude-code yarn e2e:daemon-harness`
Expected: PASS when `ANTHROPIC_API_KEY` is set; a clean skip (exit 0) otherwise. Both outcomes are acceptable; record which one happened.

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/daemon-harness-cycle.ts client/test/e2e/_daemon-harness-helpers.ts
git commit -m "test(operator): re-point the daemon-harness e2e at the stage-1 work loop"
```

---

## Task 19: Drain runbook, deploy PR, and final verification

**Files:**
- Create: `docs/runbooks/cutover-stage-1-drain.md`
- Test: the full suite plus the testnet gate

**Interfaces:**
- Consumes: every earlier task.
- Produces: the runbook, and the deploy PR description that carries it as a checklist.

- [ ] **Step 1: Write the drain runbook**

```markdown
# Cutover stage 1 — drain and deploy runbook

Contract 10. Run in order. Do not deploy with step 2 unfinished.

## 1. Stop claiming (previous canary, no new build)
- [ ] On every fleet operator, set `claimPolicy.mode` unreachable by setting
      `joinedSolverNets` roles to evaluator-only, or stop the daemon outright.
      Confirm with `sqlite3 ~/.jinn-client/jinn.db \
        "SELECT count(*) FROM task_runs WHERE task_role='restoration' AND state NOT IN ('COMPLETE','FAILED','RACE_LOST')"`.

## 2. Wait for terminal states
- [ ] Poll the same query every 5 minutes until it returns 0, or until the operator's
      patience bound (recommended: 2 hours) elapses.
- [ ] Record any remaining rows. Each one is a straggler: its attempt stays claimed on the
      venue and occupies a `maxClaims` slot until the revised generation's deadline reap.
      They strand loudly through the unreleased-attempt state message — they are never
      silently dropped.

## 3. Deploy
- [ ] Deploy the stage-1 build to one operator first. Confirm on that operator:
      - `[rpc] L2 transport` line present, exactly one broadcaster installed
        (`grep 'no venue broadcaster installed' logs` returns nothing)
      - `[work] claim gate open` appears within 10 minutes of boot
      - the Claim policy & wiring page shows the one-time migration message
      - `~/.jinn-client/config.json.backup-*` exists with mode 600
- [ ] Deploy to the rest of the fleet.

## 4. Gate
- [ ] One real task closed-loop on testnet through the new flow, including the verdict leg
      via the still-legacy evaluator on a *second* operator.
- [ ] Record the task id, both tx hashes, and the verdict code in the deploy PR.

## Rollback
Revert the stage-1 PR train or pin the previous canary image. Rollback is symmetric and
honest: chain state stays consistent (claims are chain facts; the backend journal persists),
but the reverted daemon does not resume the new flow's in-flight engagements. The engagement
ledger rows stay at `claimed`; the same unreleased-attempt state message names them. The
migrated config is forward- and backward-compatible: the pre-cutover daemon boots from it
because `joinedSolverNets` was never removed.
```

- [ ] **Step 2: Run the whole local gate**

Run:
```bash
cd packages/marketplace/pipeline && yarn vitest run && yarn typecheck
cd ../../task-execution/backend-local/assembly && yarn vitest run && yarn typecheck
cd ../../../../client && yarn typecheck && yarn test && yarn lint:no-late-mount
```
Expected: zero typecheck errors, all vitest suites green, no late-mounted routes. Paste each command's tail into the task report — evidence before assertions.

- [ ] **Step 3: Run the kits and guards**

Run the marketplace and discovery conformance kits, the venue-base Anvil-fork kit, and the guard trio for every touched tree; show the output of each. A red guard blocks the deploy PR.

- [ ] **Step 4: Run the stage gate**

Run: `cd client && yarn e2e:daemon-harness && yarn e2e`
Expected: both green. Then execute the testnet gate: one real task closed-loop through the new flow **including the verdict leg via the still-legacy evaluator**, driven from two distinct operators (self-evaluation is prevented on chain). Record the task id, the claim tx, the mech Deliver tx, the `claimSolutionDelivery` tx, and the verdict tx.

- [ ] **Step 5: Open the deploy PR**

One PR into `integration/evidence-v1` whose description carries the runbook above as a checklist plus the rollback statement verbatim. No agent self-merge; operator-approved.

```bash
git add docs/runbooks/cutover-stage-1-drain.md
git commit -m "docs(operator): add the cutover stage-1 drain runbook"
```

---

## Findings — surfaced, not silently resolved

Each finding names the contradiction, the evidence, and the proposed disposition. Nothing here was patched into the plan without being written down.

### F1 — Nothing in the merged stack sends the marketplace Deliver transaction (**blocking, planned around**)

`settleDelivery` (`packages/marketplace/binding/src/settlement.ts:465-470`) calls `ports.readMechDeliveryFacts` **before** `claimSolutionDelivery` and rejects with `digest-divergence` unless the Mech `Deliver` event already carries the Delivery's raw-CID sha256 digest. `runPipeline` (`packages/marketplace/pipeline/src/pipeline.ts:214-233`) goes `convergeDelivery` → `settleDelivery` with no deliver leg in between. A repo-wide search finds `deliverToMarketplace` written only in `client/src/adapters/mech/contracts.ts:1345` and in `packages/marketplace/testing/src/escrow-lifecycle.test.ts` fixtures — no production stack implementation. The spec §2 walk says "the anchoring tx is folded into settlement ports", but `SettlementPorts` declares only reads plus `claimSolutionDelivery` / `settleRevisedSolutionDelivery`.

**Disposition (planned):** the host owns it — Task 8 builds `deliverToMarketplace` on the venue broadcast port, and Task 13 wraps `readMechDeliveryFacts` so the leg always precedes the read. **Alternative for the coordinator:** move it into venue-base as `settlement.ensureMechDelivery(...)`, which is arguably its home (venue mechanics, not application policy) and would let benchmarking's marketplace mode reuse it. That is a venue-base plan change, so it needs a cross-plan ruling.

### F2 — The converged Delivery is **not** parseable by the legacy evaluator (**blocking, ruling required**)

Spec §10 asserts "the sealed marketplace-profile Delivery re-homes the `jinn.execution.v1` content the legacy evaluator already parses". The code contradicts it in three places:

1. `LocalTaskExecutionBackend` seals a **fixed-shape** TEP `DeliveryRecord` (`assembly/src/backend.ts:1585`) — `protocol`, `attempt`, `task`, `outputs`, `outcome`, `executionIds`, `evidenceRecords`, `createdAt`. There is no `jinn.execution.v1` content and **no extension hook**.
2. Every legacy evaluator does `SignedEnvelopeSchema.parse(JSON.parse(ctx.task.context['restorationResult']))` — `swe-rebench-v2-evaluator/harness.ts:1348`, `jinn-repo-evaluator/harness.ts:430`, and four more — which requires `schemaVersion: 'jinn.execution.v1'`, `signature`, `participant`, `window`, `executor`, `evidenceTier`.
3. The adapter derives that string as `const resultData = (resultPayload.data as string) ?? JSON.stringify(resultPayload)` (`client/src/adapters/mech/adapter.ts:1154` region). A TEP Delivery has no `data` key, so the fallback stringifies the Delivery and `SignedEnvelopeSchema.parse` throws.

The bytes an evaluator can reach are fixed by chain facts: `readMechDeliveryFacts` forces the Mech `Deliver` data to be the Delivery's CID, so there is no second pointer to hang a sidecar on. The evaluator therefore *must* find the legacy envelope inside the Delivery, and the operator's local archive is not public until stage 4.

**Disposition (planned, D3):** add one optional `deliveryExtensions` hook to `LocalTaskExecutionBackendConfig` and spread the result into `sealDelivery`, with absolute-URI key validation and reserved keys unshadowable. `DeliveryRecordSchema` is `.loose()` and TEP §21.3 explicitly admits namespaced extensions, so this is a bridge annotation, not new protocol semantics — and it retires on the same schedule as `legacyManifestDigest` (spec §9, "after stage 5"). Task 15 implements it plus a three-line read-path preference in the legacy adapter.

**Recorded alternatives, both needing an operator ruling:**
- **D1** — pin every `outputs[]` artifact's bytes alongside the Delivery and have the bridge reader synthesize the envelope from them. Rejected as planned path because the synthesized envelope's `signature` would have to be minted by the *evaluator*, which destroys the field's meaning.
- **D2** — merge stage 2 into stage 1 so no legacy evaluator ever reads a stage-1 Delivery. Cleanest technically, but it contradicts the spec's flow-by-flow stage ordering and doubles the stage's blast radius.

Note that D3 modifies a stack package after merge. The spec's "designs are law" posture means this must be ratified before Task 15 starts; the plan marks that task as blocked on the ruling.

### F3 — `SafeBroadcastPort` has no generic broadcast leg (**cross-plan, needs venue-base confirmation**)

The binding's exported `SafeBroadcastPort` (`packages/marketplace/binding/src/posting.ts:49`) declares exactly one method, `broadcastCreateTask`. The single-broadcaster rule needs a generic `broadcast(SafeTransactionParams)` so the surviving legacy legs (`claimTask`, `claimEvaluation`, `claimDelivery`, `callDeliverToMarketplace`) and the Task 8 mech deliver can route through it. **Disposition:** this plan consumes `venue.safe` as a superset (`BaseVenueSafe`, documented in "Consumed cross-plan surfaces"). Confirm with the venue-base plan author before Task 7; if venue-base declines, the fallback is a host-side adapter that composes `venue.safe` with the venue's own broadcast primitive, which is strictly worse because it re-splits the nonce ledger.

### F4 — `loadConfig` precedence is env > file > defaults, not file > env (**documentation drift**)

`CLAUDE.md` and the task brief both say "Config file first, env var override" / "file > env > defaults". The loader's own doc comment at `client/src/config.ts:940` says "env > config file > defaults", and the implementation matches it: `merged` starts from `fileValues`, then every `JINN_*` env var overwrites. **Disposition:** the plan is written against the *code*. The migration writes the file only, so an operator with `JINN_*` overrides keeps them — that is correct behaviour, not a bug. File a `docs` chore to fix the `CLAUDE.md` line; it is not stage-1 work.

### F5 — Existing config writes are non-atomic and last-writer-wins (**pre-existing, partially fixed here**)

`persistTopLevelConfigValue` (`client/src/config.ts:1467`) and `persistLegacySolverNetsMigration` (`:1446`) both do read → mutate → `writeFileSync` with no lock and no temp+rename. `POST /v1/operator/join/:cid` and `POST /v1/setup/network` can clobber each other, and a crash mid-write truncates `~/.jinn-client/config.json` — which can carry paid RPC keys. **Disposition:** Task 2 adds `writeConfigFileAtomic` and Task 17's new endpoints use it. The two legacy writers are **not** converted in this stage (out of scope, and converting them touches the join flow the evaluator path still depends on). File a follow-up `fix` issue to convert them; recommend doing it at stage 3 when the posting surface already reworks that code.

### F6 — The notification taxonomy in code and in `OPERATOR-APP-SPEC.md` have drifted (**minor, fixed here**)

`CANONICAL_KINDS` (`client/src/dashboard/spa/src/notifications/taxonomy.ts`) lacks `rpc_all_failed` and `rpc_primary_degraded`, which the spec lists; the spec names a severity `action_required` that `SEVERITIES` does not have. **Disposition:** Task 17 adds the three new stage-1 kinds to both sides and aligns §2.10's list. The pre-existing two-kind drift is recorded here and left for a `docs` chore — fixing it means either adding dead kinds or editing canonical spec text, neither of which belongs in a cutover PR.

### F7 — The migration cannot map USD caps onto wei caps (**deliberate, needs operator confirmation**)

`OperatorCaps.spendCapWei` is a per-task **wei** ceiling; the operator's existing `spendCap.capUsd` and `aiUnits.capPerBlockUsdMicros` are rolling-window **USD** budgets. There is no defensible automatic conversion (no oracle in the daemon, and the semantics differ — per-task ceiling vs rolling window). **Disposition:** Task 3 migrates both pipeline caps to `0`, which makes `checkCaps` decline everything, and Task 4 raises an action-required state message pointing at the Claim policy & wiring page. The operator sets real caps once, deliberately. This means **a freshly migrated daemon claims nothing until a human acts** — that is the safe reading of `CLAIM_NOTHING`, but it is a behaviour change on first boot and the operator should confirm they want it rather than a permissive default.

### F8 — The legacy state machine has no solution/evaluation split (**scoping clarification**)

`client/src/harnesses/engine/state.ts` runs **one** state sequence (`DISCOVERED → … → COMPLETE`) for both roles; the discriminator is the `task_role` column plus the harness selected by `ImplRegistry.findFor`. Only the delivery leg branches (`claimSolutionDelivery` vs `claimVerdictDelivery`), and `AWAITING_ADOPTION` / `CLAIMING_DELIVERY` are Autopilot-solution-only. **Disposition:** "retire the solution path" therefore cannot mean deleting states — it means refusing restoration at the entry point (`canAcceptTask`) and at discovery (`watchForTasks`), which is what Task 16 does. `state.ts`, `persistence.ts`, and `task_runs` all survive to stage 5 exactly as the spec's retirement table says. The Autopilot adoption states are the one place where a stage-1 restoration could still slip through: `engineOwnsAutopilotSettlement` (`adapter.ts:1738`) reads `task_runs` directly. Task 16's `watchForTasks` change starves it of new rows; existing rows drain under the Task 19 runbook.

---

## Self-review

**Spec coverage.** §3 host split → Tasks 11, 12. §4 loop map (projector, work, evidence driver) → Tasks 9, 11, 13; derivation-first recovery and the two ordering rules → Tasks 6, 10, 13; unreleased-attempt state message → Tasks 6, 13, 17. §5 usage disciplines → Task 12 (composition through public interfaces; seal-once; host-injected evidence join). §6.4 facts mapper → Task 5. §6.5 host deliverables → Tasks 6, 9, 11, 12, 13 (verdict-gate policy assembly is stage 2 and is named in "What this plan does NOT do"). §9 config migration → Tasks 1–4; stage-1 retirement rows → Task 16. §10 stage-1 row → Tasks 7, 8, 13, 16; bridge-era document rules → Tasks 14, 15; drain rules → Task 19; standing rules → Global Constraints. Contracts 1, 2, 3, 4, 6, 9, 10, 12 each have a named owning task. Gaps found and surfaced rather than papered over: F1 and F2.

**Placeholder scan.** No "TBD", no "similar to Task N", no "add error handling". Two places carry deliberate prose instead of code: Task 9's `tick()` sequence and Task 13's nine-step sequence are numbered algorithms with every call site named and every type defined above them — the surrounding code blocks give the exact signatures. Task 15 is explicitly gated on an operator ruling rather than guessing.

**Type consistency.** `ExecutionWiringConfigEntry` (operator config, Task 1) and `ExecutionWiringEntry` (pipeline, existing) are distinct on purpose and bridged by `toPipelineWiring`; both names are used consistently. `AnnouncedSubmissionCard` is defined once (Task 5) and consumed by Tasks 13 and 15. `VenueBroadcaster` is defined in Task 7 and consumed by Tasks 8, 12, 13. `OperatorEvidence` / `EvidenceBindingPorts` are defined in Task 11 and consumed by Task 12. `EngagementOutcome` values used in Task 13 (`settled`, `race-lost`, `abandoned`) all appear in the Task 6 union.

## Coordinator amendments (2026-07-30, binding on execution)

Rulings on this plan's findings, issued at planning consolidation. Where an amendment
contradicts a task's literal text or test literals, the amendment wins and the executor
adjusts the task's code accordingly.

1. **F7 reversed — no claim-nothing migration.** Spec §9's "behavior-identical on day one"
   is the binding sentence; `CLAIM_NOTHING` is the posture for an *unconfigured* predicate,
   not for the migration of a configured operator. Amend: `ClaimPolicyConfigSchema` makes
   `spendCapWei`/`aiUnitCap` **optional**; the migration (Task 3) writes no cap fields; the
   composition root (Task 12) passes permissive `OperatorCaps` (`2^256-1` wei,
   `Number.MAX_SAFE_INTEGER` units) to the pipeline when unset, because the host's USD
   rolling-window gates (kept per spec §6.5) remain the operative spend bound — exactly
   today's behavior. Task 4's `capsUnset` message becomes **informational** ("per-claim
   caps not set; USD gates active"), not action-required. Task 3's Step-1 test literals and
   the Task 1 schema/test literals follow this amendment.
2. **F1 placement — the deliver leg homes in venue-base.** Task 8's content stands, but its
   Files move: Create `packages/marketplace/venue-base/src/deliver-leg.ts`, Test
   `packages/marketplace/venue-base/src/deliver-leg.test.ts`. It is a product-agnostic
   venue chain-write (Autopilot's adoption pass needs the same leg); leaving it in
   `client/` would recreate the pattern this program retires. The venue-base plan carries
   the matching amendment.
3. **F3 confirmed — the broadcaster surface is generic, and venue-base owns its name.**
   Task 7's injected `VenueBroadcaster` is venue-base's generic broadcast export (the
   `execute({to, value, data, logicalTx})` shape its kit drives); Task 7's Consumes block
   binds to that export at execution time.
4. **D3 ratified.** The optional namespaced `deliveryExtensions` hook on
   `LocalTaskExecutionBackendConfig` (permitted by `DeliveryRecordSchema`'s `.loose()` and
   TEP §21.3; retires with `legacyManifestDigest` after stage 5) plus the three-line
   read-path preference in the mech adapter is the ratified bridge mechanism. The
   composition spec §10 carries the dated correction of its falsified parseability claim.
5. **F4/F5/F6 accepted as written** (docs chore for config precedence; legacy-writer
   atomicity follow-up recommended for stage 3; notification-taxonomy drift recorded in the
   program follow-ups). **F8 accepted** — retirement by refusal at `canAcceptTask` /
   `watchForTasks`, no state deletion.

## Execution findings (2026-07-31, partial execution — Tasks 0–3)

Recorded during execution against the merged phase-0 head (`4cfd4caab`, all three component
merges present). Execution reached **Task 3 of 19**; Tasks 4–19 are not started. Findings
are surfaced, never silently resolved.

### E1 — the plan never wires client onto the merged stack (blocking; resolved as Task 0)

`client/package.json` at the session head declared **no** dependency on any stack package,
yet Task 1's first line imports `@jinn-network/marketplace-pipeline`, and no task in the
plan adds them. Resolved as a preamble commit: 15 direct runtime dependencies plus a
24-entry `resolutions` block mapping the transitive closure to `portal:` paths, matching the
pattern the package trees already use among themselves.

### E2 — the assembly package name in the plan does not exist

The plan imports `@jinn-network/task-execution-backend-local-assembly`. The merged package at
`packages/task-execution/backend-local/assembly` is named
**`@jinn-network/task-execution-backend-local`**. Every remaining task that consumes the
assembly must use the real name.

### E3 — portal-within-portal version conflict (blocking; resolved as Task 0)

`yarn install` failed `YN0071`: the stack pins `better-sqlite3@13.0.1` (venue-base,
evidence-local-runtime, evidence-catalog-sqlite) and `ajv@8.17.1` (task-execution-profiles)
exactly, against client's `^12.10.0` / `^8.20.0`. Resolved by pinning both in client
`resolutions`. This is a **major bump of the daemon's SQLite driver**; the full client suite
is the gate and stays green on it.

### E4 — `BaseVenueConfig` is not the plan's five-member config

The plan's "Consumed cross-plan surfaces" block pins
`{chain, publicClient, walletClient, safeAddress, stateDbPath}`. The merged
`packages/marketplace/venue-base/src/config.ts` additionally **requires** `priorityMech`,
`pin`, `verifySettlementGrade`, `isAuthorizedMechOrigin`, and
`observations: () => Promise<readonly ProtocolObservation[]>`, plus optional `logSource` /
`broadcast` / `finality` / `deliveryWait` option bags. Task 12's composition root must supply
all ten. `observations` is a **sequencing constraint the plan does not mention**: venue-base's
observe port is fed by the host's projector state (Task 9), so Task 12 must construct the
projector before the venue.

### E5 — the venue broadcaster's real shape is `execute`, not `broadcast`

The plan's `BaseVenueSafe.broadcast({safeAddress,to,value,data}) => Hex` does not exist. The
merged export is `BaseVenueSafeBroadcaster`:

```ts
execute(request: { to; value; data; logicalTx: string; operation?: 0 | 1 })
  => Promise<SafeBroadcastReceipt>   // { txHash, blockNumber, blockHash, logs, alreadySettled }
classify(error: unknown) => VenueRevertClassification
```

Three differences bind Task 7: `safeAddress` is fixed at factory time, not passed per call;
`logicalTx` is **required** and load-bearing (the reconcile path adopts a pending tx only when
`existing.logicalTx === request.logicalTx`, so a coarse or colliding value is a correctness
bug, not a cosmetic one); and the return is a receipt, not a hash. Coordinator amendment 3
binds Task 7 to this real export, so Task 7's `VenueBroadcaster` must be restated in `execute`
terms and must carry the Safe address it is bound to, so `executeSafeTransaction` can still
reject a mismatched `params.safeAddress` rather than silently broadcasting from the wrong Safe.

### E6 — `executeSafeTransaction` has seven call sites, not five

The plan names five in `client/src/adapters/mech/contracts.ts`. Two more exist off the
marketplace path: `client/src/erc8004/plugin-registry.ts:242` and
`client/src/erc8004/reputation.ts:494`. Re-pointing the one chokepoint therefore also moves
the ERC-8004 legs onto the venue broadcaster. That is **consistent with** the
single-broadcaster rule (one Safe, one nonce stack) and should be kept, but the plan's
blast-radius rationale undercounted.

### E7 — the repo imports `zod/v3`, not `zod`

Every plan code block writes `import { z } from 'zod'`. `client/src/config.ts` and its
siblings import `from 'zod/v3'` (zod v4 installed, v3-compat subpath; `JinnConfigSchema` is a
`zod/v3` object). Mixing versions produces schemas that do not compose. Applied in Tasks 1 and
3; binding on every remaining task that touches config schemas.

### E8 — Task 3's `entry.model ?? ''` would brick the next boot (found and fixed)

The plan's Task 3 Step-3 code maps a solver join's model as `entry.model ?? ''`, but
`ExecutionWiringConfigEntrySchema.model` is `z.string().min(1)`. A real `joinedSolverNets`
entry without a per-net `model` — the common case, since the daemon falls back to the
operator's top-level `claudeModel` at solve time — migrates to `model: ''`, which fails
validation and **throws on the following boot**. This reproduced against a real operator
config. Fixed in Task 3 as `entry.model ?? raw.claudeModel ?? 'claude-haiku-4-5-20251001'`,
matching the daemon's existing runtime fallback, with a regression test.

### E9 — `loadConfig()` writes, and the suite calls it against the operator's live config

Task 3 puts the migration inside `loadConfig`, following the file's established
load-time-write pattern (`persistLegacySolverNetsMigration`, issue #445). Several existing
tests call `loadConfig()` with **no argument**, which defaults to the operator's real
`~/.jinn-client/config.json`. Running the client suite therefore migrated the live config on
the executing machine — additively, with timestamped backups written beside it. This
test-hygiene defect **pre-dates** this plan and already applied to the #445 migration; Task 3
only made it consequential and visible. Recorded rather than patched, because the available
in-scope patch (a `VITEST` guard) departs from the convention every other load-time migration
in that file follows. The real fix is to make those tests pass an explicit path.

### E10 — the Docker portal guard is unsatisfiable because of a stale `files` entry (blocking, out of scope)

`client/test/scripts/dockerfile-workspace-portals.test.ts` derives its expectations from
client's portal entries, so Task 0's dependency wiring put 24 new packages under it. Seven of
its eight assertions now pass against the updated `client/Dockerfile`. The eighth cannot be
satisfied from inside `client/`: **`packages/discovery/serve` and `packages/discovery/client`**
both declare `files: ["dist/", "fixtures/", "README.md"]`, but neither has **ever** had a
`fixtures/` directory (stale since the discovery scaffold commits; nothing in either build
generates one — the entry was evidently copied from `record-discovery-protocol`, which does
have one). The guard requires a `COPY` for every non-`dist` publish path, while a sibling
assertion in the same file requires every `COPY` source to exist — the pair is unsatisfiable
until the stale entries are removed. Neither package can be demoted to a devDependency
instead: Task 9 imports `writeArchivePages` from `record-discovery-serve` at runtime, and
`record-discovery-client` is a runtime dependency of `transport-http`.

**Fix (one line each, outside this plan's write scope):** delete `"fixtures/",` from
`packages/discovery/serve/package.json` and `packages/discovery/client/package.json`. Benign
for publishing — npm ignores missing `files` entries — so it only ever broke this inference.

### E11 — the bundled-workspace guard encoded two wrong assumptions (fixed in scope)

Task 0's wiring also put the new packages under
`client/test/scripts/bundled-workspaces.test.ts`, which failed for two independent reasons,
both fixed here because both are client-side:

1. It resolved a bundled workspace's path as `packages/<last npm-name segment>`. That holds
   only for the four flat legacy packages; the stack packages are nested
   (`@jinn-network/evidence-local-runtime` → `packages/evidence/local-runtime`). Now resolved
   from the package's own `portal:` resolution, which is the ground truth, with an assertion
   that the result stays inside the repository.
2. Its second assertion — every runtime dependency of a bundled package must itself be a
   client dependency — is a **real correctness rule** (a bundled tarball whose dependency is
   absent cannot resolve at runtime) and Task 0's initial 15-package set violated it. The
   bundled set is now closed under runtime dependencies: **26 packages**, with the
   third-party leaves `safe-regex` and `@noble/curves` promoted into `dependencies`.

That closure surfaced one more out-of-scope defect: `packages/marketplace/venue-base`
declares **`@types/better-sqlite3` in `dependencies`**, not `devDependencies`. A types-only
package has no business in a runtime dependency set; it forced `@types/better-sqlite3` into
client's runtime `dependencies` to satisfy the rule. Worth fixing in venue-base.

### Verification state at Task 3

- `client` typecheck: **0 errors**.
- `client` suite baseline at the session head, before any change: 787 files
  (777 passed / 1 failed / 9 skipped), 7083 tests (7053 passed / 1 failed / 29 skipped). The
  one failure is `test/_support/chain/anvil.test.ts > spawnAnvilFork > can set balance and mine
  blocks`, which forks Base over the network; it passed on a later run, so it is a
  network-dependent flake, not a standing red.
- After Task 0: the same, plus the single E10 Docker-guard assertion.
- Tasks 1–3 targeted suites: `test/config` **154 passed**, shape-v2 **7 passed**, atomic-write
  **5 passed**, migrate-shape-v2 **9 passed**.

## Execution findings (2026-07-31, continued — Tasks 4 onward)

Recorded by the adopting coordinator. The Tasks 0–3 findings above stand unchanged; the
E-numbering continues.

### E12 — a pinned inventory has to move with the surface it pins (fixed in scope)

Two tasks added a symbol to a list that a test pins verbatim, and the plan mentioned neither:
Task 4's `config_migrated` against `CANONICAL_KINDS` in
`client/src/dashboard/spa/src/notifications/taxonomy.test.ts`, and Task 5's two new exports
against the public-surface list in `packages/marketplace/pipeline/src/index.test.ts`. The plan
defers the first to Task 17 ("Task 17 adds the three new stage-1 kinds to both sides"), which
would have left a knowingly-red test standing across thirteen tasks — and a red suite you have
learned to ignore stops being a signal for anything else. **Disposition:** the registry moves in
the same commit as the symbol. Updating a pinned inventory to the new true inventory is not
weakening a test; relaxing an assertion to hide a behavioral failure is, and that never
happened here. `client/OPERATOR-APP-SPEC.md` §2.10 gained the matching `config_migrated` entry
so code and canonical doc stay in step at every commit. Task 17 adds its two remaining kinds
the same way.

### E13 — Task 4's test literals crash rather than fail

The plan's Task 4 Step-1 tests call `buildStatus(...)`, which does not exist — the real export
is `assembleStatusV1` — and pass `{ configMigration } as never`, which throws before reaching
any assertion (`assembleStatusV1` dereferences `raw.master.balanceWei` unconditionally, and
`deriveNotifications` dereferences `input.bootstrap.mode`). Replaced with full fixtures mirroring
each file's existing patterns, so the tests exercise real behavior. Assertions unchanged.

### E14 — the fence no longer runs per retry attempt (behavior change, accepted)

The deleted `executeSafeTransactionInner` re-evaluated `options.beforeBroadcast` on **every**
retry attempt of a Safe execution. Task 7's chokepoint runs it exactly once, before handing the
call to venue-base, because retries now live inside the venue broadcaster where the host's fence
is not reachable. For the surviving legacy legs the fence is a claim-window / readiness gate, so
firing it once at admission is the semantically defensible reading — but it **is** a behavior
change, not a refactor, and it is the kind that only shows up under a slow chain. It belongs in
venue-base's kit as a per-attempt fence hook if the per-attempt semantics are wanted back.

### E15 — three deleted Safe cases have no venue-base counterpart

Contract 12 says legacy behavior re-enters as venue-base kit fixtures. venue-base is outside this
plan's write scope, so Task 7 deleted the client-side cases and audited coverage instead of
moving them. Covered by venue-base today: nonce-too-low pinned-nonce refresh; reconcile on
nonce-too-low; refusal to reconcile a foreign tx at the same nonce; receipt-path stale-nonce
retryable while still owner. **Not covered — real coverage lost until venue-base's kit gains
them:**

1. estimate-path `GS026` retried while still owner,
2. receipt-path `GS026` terminal when not owner,
3. fence re-checked on every retry attempt (see E14 — the behavior itself is gone, so this one
   is a decision to ratify, not a test to port).

Partially covered: `SafePostBroadcastHookError` on an `onBroadcast` throw (client-only concept,
retained and tested client-side); `GS026` priority over an unrelated inner revert
(GS026-as-terminal is covered, the priority ordering is not); hook-fires-after-ledger-record
(the ledger-before-wait mechanic is covered, the client hook interleaving is not).

### E16 — the single broadcaster is a process-global, and three entry points never install one

`executeSafeTransaction` now hard-fails with `no venue broadcaster installed` unless a
composition root has called `setVenueBroadcaster`. Task 12 installs it before `new Daemon(...)`
in `main.ts`, which covers the daemon. It does **not** cover:

1. **Standalone CLI verbs** — `jinn tasks submit` (→ `contracts.ts submitTask`),
   `jinn solver-plugins publish` / `revoke` (→ `erc8004/plugin-registry.ts`),
   `jinn solver-plugins block` / `feedback` (→ `erc8004/reputation.ts`). Each is a real operator
   surface that breaks at runtime until it installs a broadcaster of its own.
   (`jinn solver-plugins read` is unaffected — no Safe write.)
2. **The hermetic and e2e harnesses** — `test/hermetic/adapter-claim-delivery.test.ts`,
   `test/hermetic/full-loop.test.ts`, and everything built by `startDaemon()` in
   `client/test/e2e/_daemon-harness-helpers.ts`. All are excluded from the default `yarn test`
   and run under separate gates, so the default suite stays green while these are broken.
   **This is the gap most likely to be mistaken for "done".**
3. A **design question the plan never asks**: the broadcaster is a module-level singleton, but
   release scenario T2.2 runs several daemons in one process. One global broadcaster cannot
   serve two Safes. The mismatched-Safe rejection added per finding E5 turns that into a loud
   failure rather than a wrong-Safe broadcast, which is the right failure mode — but a
   multi-daemon process still cannot work until the broadcaster is per-daemon state.

Items 1 and 2 are in this stage's blast radius and are resolved at Task 12 or recorded there as
carried gaps; item 3 needs a ruling.

### E17 — the mech does not revert on an already-delivered request (Task 8, design corrected)

Task 8's plan detects "already delivered" by regex-matching a thrown revert. The deployed
contract does not throw: `MechMarketplace.deliverMarketplace` sees `requestInfo.deliveryMech !=
address(0)`, **`continue`s**, emits `RevokeRequest` instead of `Deliver`, and the Safe
transaction **succeeds**. `SafeBroadcastReceipt.alreadySettled` is populated only from a decoded
inner revert, so it cannot observe this case either. The plan's design would therefore have
reported `delivered: 'sent'` for a delivery that never landed — and today-mode settlement then
fails downstream with `digest-divergence`, far from the cause. **Disposition:** the leg now
decides from evidence rather than from an error string — it decodes the `Deliver` event out of
the receipt logs and reports `already` when this request's event is absent, keeping
`broadcaster.classify(error)` (venue-base's real signal) plus the regex as the thrown-revert
fallback. Two tests were added beyond the plan's four to cover the no-throw path, because the
plan's four could not fail on the real behavior.

Secondary mismatch: `MECH_ABI` in `@jinn-network/marketplace-binding` exports only the `Deliver`
**event**, not a `deliverToMarketplace` function entry as the plan's test assumes. A local
function-ABI slice was defined, mirroring what `writers/settlement.ts` already does for the same
reason.

### E18 — `test/daemon` fails under parallel workers, and it is not this plan's doing

Several daemon tests construct a `Daemon` with the default `apiPort` and race to bind
`127.0.0.1:7331`; under vitest's parallel workers they fail with `EADDRINUSE`. Measured on this
branch: `yarn vitest run test/daemon` **without** any Task 9 change fails 9 tests across 3 files;
**with** Task 9 it fails 6 across 4 files; run with `--no-file-parallelism` the same set is
**42 files / 275 tests, all green**. It is a pre-existing port-contention flake whose visible
victims shift with file scheduling. Two consequences worth stating plainly: a full-suite run is
**not** a trustworthy gate for `test/daemon` on this machine, and any executor comparing against
a parallel full-suite baseline will chase ghosts — one did, and lost a session to it.
**Disposition:** every `test/daemon` run in this stage uses `--no-file-parallelism`. The real fix
(bind port 0, or give each test its own `apiPort`) is a follow-up `fix` issue, not cutover work.

### E19 — the projection state contains bigints and was persisted with `JSON.stringify` (found in review, fixed)

`MarketplaceProjectionState` carries `bigint` on every claim/delivery-derived record —
`requestIdBindings[].taskId` / `.nonce` / `.deliveryRate`, `attemptEngagements[].taskId`,
`evaluationEngagements`, `pendingMechDeliveries`. Task 9's cursor write used plain
`JSON.stringify`, which throws `TypeError: Do not know how to serialize a BigInt` on all of
them. An `AdmissibleTaskProjection` holds no bigints, so the loop and its tests ran clean over
`TaskCreated` traffic and would have crashed **the first time anyone claimed an attempt** — the
failure would have appeared in production, not in CI. Fixed with a tagged codec
(`{"$bigint":"<decimal>"}`) in `projector-cursor.ts`, plus round-trip tests. The tag is a
single-key object rather than a numeric-looking string on purpose: `sequenceBySourceSubject`
holds 16-digit sequence strings that a "looks like a number" reviver would corrupt into bigints.

### E20 — the projector has no production event source, and the venue's observe port is stubbed (**blocking for live traffic**)

This is the largest gap in the stage and it is not a wiring detail. Three required host-injected
dependencies have **no production implementation anywhere in the repository** — only the unit
tests' fakes:

1. **`ProjectorLoopConfig.enrich`** — resolves each decoded chain event's signed `submission`
   identity, `taskDigest`, `effectiveDeadline` and `dispatchContext`, and recomputes delivery
   correspondence for Mech-deliver facts. It needs IPFS-backed resolution plus digest
   verification. It is a subsystem, not a function.
2. **A production log source** for `ProjectorLoopConfig.logSource`'s `{fetchLogs, heads}` shape.
   Note this shape is also **not** venue-base's `ChainLogSource`
   (`poll` / `cursor` / `logsInRange` / `orphanedBlockHashes` / `close`), so the plan's Task 9
   Consumes line naming `venue.logSource` was wrong in kind, not just in name.
3. **`BaseVenueConfig.observations`** — venue-base's observe port wants every observation ever
   projected. `ProjectorLoop.tick()` computes `transition.observations` and discards it, and
   `state_json` persists only `MarketplaceProjectionState`, which has no observations field and
   cannot be replayed into one without re-reducing the full admitted-event history.

Consequence, stated without hedging: **`buildOperatorComposition` assembles a claim / settle /
release path that type-checks and unit-tests green, but whose `venue.observe` / `lifecycle` /
`finality` report "no Attempt" for every reference, because `observations` is stubbed to `async
() => []`.** The composition root is not safe for live settlement traffic as it stands. The
plan's own Task 12 test cannot catch this — it stubs `createBaseVenue` entirely.

A fourth dependency is gapped for a different and more defensible reason:
**`verifySettlementGrade`** composes `createBindingResolver` + `createChainFactResolver` as
directed, but their `BindingStore` / `AnchorReadClient` backing infrastructure does not exist —
that is Phase B.1 (verifiability tier activation), still forward-looking. It is wired
**fail-closed**: every check reports `missing`, never silently `verified`. That is the correct
posture and needs no fix, only a ruling that stage 1 ships with grade checks unavailable.

**Disposition:** items 1–3 are a scoped follow-up ("the projector's production event source and
enrichment") that must land before the testnet closed-loop gate in Task 19 can pass. They were
not in any of this plan's nineteen tasks. Recording rather than improvising: inventing an
IPFS-resolution subsystem inside a composition root is exactly the pattern this program retires.

### E21 — `client` and the portal packages resolve different viem patch versions

`client` pins `viem@^2.0.0` → `2.55.8`; every package under `packages/` is its own yarn project
and resolves `2.55.10`. Both satisfy the range and are runtime-identical, but TypeScript treats
the two `PublicClient` / `WalletClient` declarations as nominally distinct. Task 12 is the first
client code to pass a live viem client across the portal boundary into `createBaseVenue`, so it
is the first place this bites; it was worked around with a single `as never` cast at the call
site. A cast at a composition boundary is precisely where a real type error would hide, so this
should not stand. **Fix:** pin `viem` in client's `resolutions`, following the `better-sqlite3` /
`ajv` precedent from E3, and drop the cast.

### E22 — smaller Task 12 mismatches, all adapted

- `SelectedProvisioner` and `LocalLauncherDeployment` are defined in the assembly package but not
  re-exported from its `index.ts`; structurally-equivalent local types were used.
- `ProfileStore` comes from `@jinn-network/task-execution-profiles`, not `-workspace`.
- `venue.safe` carries no `safeAddress` field, so the composition root wraps it to satisfy the
  `VenueBroadcaster` port's E5-mandated bound-Safe check.
- `createRegistryPinPort` takes `{registryUrl, fetchImpl, timeoutMs?}` with `fetchImpl`
  **required**, not the plan's `{addUrl}`.
- `launcherDeployments` entries are `{executable: {path, digest}, probe()}`, not
  `{executablePath, versionProbe}`.
- `resolveCapabilityGrants(grants, config)` does not exist; implemented inline.
- `config.maxConcurrentAttempts` does not exist on `JinnConfig`; the default of 4 always applies.
- `WorkspaceKind` is `'dir' | 'worktree'`, not `'plain-dir' | 'git-worktree'`.
- The build-meta module is `client/src/build-info.ts` (`buildInfo.implVersion`), not
  `dist/build-meta`.
- `LocalTaskExecutionBackendConfig` has two optional fields the plan's "every required field, no
  gaps" table omits: `resolveTaskProfile?` and `cancellationKillPollCeilingMs?`. Both left unset.
- **No `MarketplaceChainConfig` exists for Base mainnet** — `BASE_SEPOLIA_TODAY` is the only real
  chain config in the repo, so `main.ts` gates composition construction on
  `config.network === 'testnet'` and leaves `composition` undefined on mainnet. Stage 1 is a
  testnet cutover, so this is consistent, but it is a constraint the plan never states.
- `selectProvisioner`'s git-worktree branch needs per-call `referenceRepository` / `oid` that no
  `JinnConfig` field carries; the composition root always builds the plain-directory provisioner.

### E23 — the evidence rollup crossed the api → daemon boundary (found in the end-of-plan battery, fixed)

Task 11 threaded the `/v1/status` indexing rollup by importing `EvidenceDriverLoop` and
`EvidenceIndexingStatus` from `src/daemon/` into `src/api/gather-status.ts` and
`src/api/status-build.ts`. `client/test/architecture/api-daemon-boundary.test.ts` (#1584) forbids
that, **type-only imports included** — which is why `yarn typecheck` stayed at zero errors and
every targeted suite the executor ran stayed green. Only the full suite caught it. **Disposition:**
the rollup shapes moved to `client/src/types/evidence-indexing.ts`, which both tiers may import,
and `gather-status.ts` now depends on a narrow `EvidenceIndexingSource` port (`failures()` +
`pending()`) that `EvidenceDriverLoop` satisfies structurally without the API tier naming the
class. The lesson generalizes: an architecture guard that lives in the test suite is invisible to
a per-task executor running targeted suites, so the coordinator's full-suite pass is the only
place it can surface.

### E24 — the bridge exists but production never populates it (**F2 is not actually closed**)

Task 15 built the ratified D3 mechanism correctly — the `deliveryExtensions` hook is additive,
namespaced, key-validated, reserved-key-safe, and it round-trips through `sealDelivery` — and
Task 14's fixtures now prove a legacy evaluator can parse the annotated Delivery. But the
composition root supplies `deliveryExtensions: () => ({})`. **No delivery this daemon produces
carries the annotation**, so finding F2's gap is closed in mechanism and open in fact.

Two concrete blockers, both recorded by the Task 15 executor rather than papered over:

1. The hook must be **synchronous** (it is called inside `backend.ts`'s synchronous `sealDelivery`
   path), but `CompositionRootInput` carries only an async `WalletClient` — there is no sync
   signer port, and the legacy envelope must be signed.
2. There is **no reachable mapping from a sealed `TaskSpecification` back to the
   `ExecutionWiringEntry` / `workKind` that produced it**. `workKind` is computed once at claim
   time by `mapAnnouncedSubmissionToFacts` and never threaded through `backend.submit`.

`buildLegacyExecutionEnvelope` is therefore **unexercised beyond typecheck**, and it fills
`task.onchainCreationTx` / `onchainCreationBlock` / `requestId` with bridge-era placeholders
because the hook has no access to the attempt's on-chain creation facts. **Disposition:** a
follow-up needs a sync signer port plus a workKind-carrying seam. Until then, stage 1 must not be
described as bridging deliveries to the legacy evaluator — it can, but it does not.

### E25 — single-broadcaster audit: the rule holds for the Safe, and every survivor is EOA-level

Contract 1 says venue-base's Safe broadcast is the only transaction path. Audited by grepping
every `writeContract` / `sendTransaction` / `sendRawTransaction` in `client/src`. Verdict: **no
surviving legacy path broadcasts from the Safe outside the venue broadcaster.** Every survivor is
a different nonce stack with its own lock, which is what the rule actually protects:

- `client/src/main.ts` (checkpoint) and `client/src/tx-retry.ts` — **master/operator EOA**, guarded
  by `withEoaBroadcastLock`. Not the Safe.
- `client/src/erc8004/reputation.ts:512` — the EOA fallback taken only when no `safeAddress` is
  configured; the Safe branch at `:494` goes through `executeSafeTransaction`. Correct.
- `client/src/erc8004/validation.ts:145,185` — `ValidationRegistry` writes are **EOA-only and were
  never Safe-mediated**, so they never passed through `executeSafeTransaction` even before this
  stage. This is a **third** ERC-8004 surface that finding E6's "seven call sites" count did not
  reach, because it was never a call site at all. Consistent with contract 1, worth naming so the
  next audit does not treat it as a regression.
- `client/src/earning/**` — the bootstrap, which runs before any composition root and whose job
  includes deploying the Safe. It cannot route through a Safe broadcaster by definition.

### Verification state at end of plan (2026-07-31)

- `client` typecheck: **0 errors**. `yarn lint:no-late-mount`: clean.
- Touched package suites: `marketplace/pipeline` **52 passed**, `marketplace/venue-base`
  **166 passed**, `task-execution/backend-local/assembly` **96 passed / 1 skipped**; all three
  typecheck at 0 errors.
- Guard trios, both trees: marketplace source-boundaries **13/13**, package-inventory **2/2**,
  packed-types **1/1**; task-execution source-boundaries **7/7**, package-inventory **3/3**,
  packed-types **1/1**.
- `client` full suite (`--no-file-parallelism`, before the E23 fix): 807 files
  (792 passed / 6 failed / 9 skipped), 7170 tests (7125 passed / 16 failed / 29 skipped).
  Of the six red files, **one was ours** (E23, fixed). The other five are network- or
  resource-dependent and pass in isolation: `_support/chain/anvil.test.ts` +
  `_support/chain/olas-funding.test.ts` (fork Base over the network — re-run alone: 3/3 green),
  `scripts/build-anvil-snapshot-entrypoint.test.ts` (subprocess timeout under load — alone: 1/1
  green), `venues/hyperliquid/client.test.ts` (9 tests against a live testnet API), and
  `cli/commands/create.test.ts` (runs `yarn install` in a scaffold). **No commit in this stage
  touches any of those five files.**
- `e2e:daemon-harness` with `JINN_E2E_HARNESS=prediction-v1-baseline`: **FAILED**, identically on
  3/3 runs, at `bootstrapStakedOperator` — `stOLAS stake() tx failed for service 1` on the live
  Base-mainnet Anvil fork, inside `client/src/earning/bootstrap.ts`, which no commit in this stage
  touches. The gate therefore never reached any stage-1 code. `anvil --version`: 1.6.0-nightly.
  `JINN_E2E_HARNESS=claude-code` skipped cleanly (no `ANTHROPIC_API_KEY`) as designed.
- The **testnet closed-loop gate (Task 19 step 4) was NOT run** — it is the human deploy gate, and
  E20 means it could not pass regardless.
