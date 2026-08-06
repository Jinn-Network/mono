# Cutover Stage 3 — Posting Flow Implementation Plan

> **Addendum 2026-08-05** (per
> [DR-2026-08-05](../../../log/decisions/2026-08-05-cutover-one-swap-collapse.md)): this
> stage collapses into the **one-swap** with stages 2 and 4 (program §10). Dispositions:
> the preflights, adoption, lifecycle exits, work-client facade, posting loop, CLI verbs
> (Tasks 19–21), and retirements (17–18) ride the swap train; Task 12 is **re-scoped** —
> the evaluator-seals carve-out is dissolved (contract 5 note), so what requester-side
> sealing owes is sealing evaluation Submissions for the operator's **own posted** tasks
> carrying private test material under capability grants; Task 22 **widens** — the
> ruling-5 stage-3/4 split dissolves and every `jinn solver-nets` subverb retires in the
> one train; **Task 23 is killed** (the 2026-08-04 addendum's no-mutating-routes ruling —
> replaced by a read-plane posting-status projection through `client/src/api/contract/`);
> Task 24 is read-only; Task 25 is superseded by the combined drain and fused gate (the
> own-task-adoption gate fuses into G-loop). Bridge-era compatibility for legacy-posted
> tasks is bounded by DR decision 4: the combined drain is designed to leave zero
> non-terminal legacy-posted tasks.

> **Addendum 2026-08-04** (per the
> [headless operator re-derivation design](../specs/2026-08-04-headless-operator-rederivation-design.md)
> §4.2): the posting surface is re-ruled — posting **status** joins the read plane
> (receipts/status projection, versioned per §8); posting **mutations** are config +
> `jinn tasks` (no mutating posting routes are built); the SPA delta this plan names is
> limited to the read-only view, and the console inherits it at stage 6. This plan's
> "mutation stays in the config file and the SPA" ruling is superseded accordingly.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the operator runtime's requester side onto the marketplace stack — an extractable `client/src/requester/` work-client module (preflight core, posting, delivery await, requester-side adoption, requester-side evaluation sealing, lifecycle exits, evidence handles), the posting loop that drives it, the CLI and SPA surfaces it needs, and the retirement of the creator loop, launched-record generators, and lifecycle publishing.

**Architecture:** `client/src/requester/` is a host-free module composed strictly through the binding's public interfaces and injected ports — an architecture test forbids every import that resolves outside the directory, which is what makes "extractable" a checked property rather than a hope. Inside it, the **preflight core** (`src/requester/preflight/`) is its own sub-module with its own public surface, because the marketplace-surfaces design (§4.3) authors preflight-behavior golden fixtures against it and later converges the CLI onto it. The host (`src/daemon/posting-loop.ts`) injects `venue-base`'s facade into the module; the module never imports `venue-base`, the store, the config loader, or anything else under `client/src/`.

**Tech Stack:** TypeScript / Node 22 / Yarn workspaces with `portal:` resolution; viem; zod (`zod/v3` in `client/`, `zod` in packages); Hono; SQLite (`better-sqlite3` via `client/src/store`); vitest; wouter + shadcn/ui in the SPA.

## Global Constraints

- Branch target: `integration/evidence-v1`. Stacked PRs, one train; the stage ends in exactly one deploy PR carrying the drain-runbook checklist and the rollback statement. No agent self-merge; the deploy PR is operator-approved.
- Depends on cutover stage 2 being complete and its testnet gate green (verdict closed-loop). Stage 3 does not deploy before that.
- PRs #2306 / #2307 / #2308 are merged into the base before this train starts.
- **Fixtures before implementations.** The preflight-behavior golden fixtures (Task 2) land before any preflight implementation; legacy behavior enters as fixtures, never as ported code (program contract 12).
- **Single-broadcaster rule** (program contract 1): `venue-base`'s Safe broadcast is the only transaction path in the daemon process. Nothing in this stage opens a second nonce stack — the requester module takes `SafeBroadcastPort` injected and never constructs a wallet client.
- **Config migration is additive, atomic (temp file + rename), and idempotent** (program contract 4). `joinedSolverNets` and the launched-record files are *not* deleted here; they are deleted at stage 5.
- **Evaluator-seals carve-out closes here** (program contract 5): requester-side evaluation Submission sealing ships in this stage.
- **Evidence publication policy** (program contract 6): only records already sealed for delivery or announcement are published; capability-grant material and secret-forwards never enter the archive. The requester module never publishes; it returns evidence handles.
- **Drain rules** (program contract 10): the creator loop stops accepting new work and runs until its in-flight posts reach terminal states before the swap deploys; stragglers strand loudly through the §4 state message.
- Every task ends with `yarn typecheck` and the named test commands run locally, outputs shown in the commit or PR body.
- American English throughout. No product names in tier-3 code (the requester module names no product).
- Frontend rules: shadcn/ui primitives only, no emoji, no decorative gradients, no helper-text cruft, softened-brutalist radii. Every SPA delta lands with its `client/OPERATOR-APP-SPEC.md` update **in the same PR**.
- Naming fixed by the program (§5): module directory `client/src/requester/`; loop module `client/src/daemon/posting-loop.ts`; config keys `configShapeVersion: 2`, `claimPolicy`, `executionWiring[]`, `posting[]`; CLI verbs `jinn policy`, `jinn wiring`; venue facade `createBaseVenue(config)`.

## Inbound assumptions from stages 0–2

These symbols are produced by earlier plans in the program. If an actual name differs, adapt it **only** at the single wiring site (Task 16) and record the difference as a finding — never inside `src/requester/`, which depends on none of them.

- `@jinn-network/marketplace-venue-base` exports `createBaseVenue(config)` returning `{ claim, settlement, lifecycle, finality, deliveryWait, release, observe, safe, logSource, intents }` with `config = { chain, publicClient, walletClient, safeAddress, stateDbPath }` (program §5). This stage uses `safe`, `intents`, `lifecycle`, `settlement`, `observe`, and `logSource`.
- Stage 1 has landed the composition root, the projector loop, the engagement ledger, `configShapeVersion: 2`, `claimPolicy`, and `executionWiring[]`, and has re-pointed every surviving legacy transaction leg through `venue-base`'s Safe broadcast.
- Stage 2 has landed the evaluator loop and retired the delivery-watcher, the mech adapter's evaluation machinery, and the legacy TaskEngine.

## File structure

**New — the extractable module (`client/src/requester/`, zero imports outside itself):**

| File | Responsibility |
| --- | --- |
| `errors.ts` | The strict error taxonomy: `RequesterError` with `category` + `code`, `REQUESTER_ERROR_CATEGORIES`, `isRequesterError` |
| `ports.ts` | Every injected port the module consumes, typed from `@jinn-network/marketplace-binding` where the binding declares one |
| `preflight/funds.ts` | `assertPostingFunds` — Safe and agent-EOA funding rule |
| `preflight/freshness.ts` | `assertPostingFreshness` — deadline liveness with an execution reserve |
| `preflight/target.ts` | `selectLiveTarget` — live-target selection over posting-config candidates |
| `preflight/run.ts` | `runPostingPreflight` — the ordered, category-tagged check runner |
| `preflight/index.ts` | The preflight core's own public surface |
| `documents.ts` | `buildPostingDocuments` — seals the Task, binds and seals the Submission, enforces the digest join |
| `posting.ts` | `postSubmission` — the durable-intent posting leg over the binding's `postTask` |
| `recovery.ts` | `recoverPendingPostings` — `TaskCreated` recovery scan |
| `delivery.ts` | `awaitDeliveries` — requester-side delivery observation and parse |
| `adoption.ts` | `adoptDelivery` — correspondence check, adoption decision, receipt sink |
| `evaluation.ts` | `sealEvaluationSubmissionForOwnTask` — requester-side evaluation Submission sealing |
| `lifecycle.ts` | `closePosting`, `cancelAttempt`, `releaseAttempt` — the lifecycle exits |
| `evidence.ts` | `evidenceHandlesFor` — outputs plus evidence-record references from a Delivery |
| `work-client.ts` | `createWorkClient` — the composed facade |
| `index.ts` | The module's single public surface |

**New — host:** `client/src/daemon/posting-loop.ts`, `client/src/api/posting-endpoints.ts`, `client/src/dashboard/spa/src/pages/Posting.tsx` (+ `pages/posting/` parts), `docs/runbooks/cutover-stage-3-posting-drain.md`.

**Modified — host:** `client/src/config.ts` (`posting[]` + launched-record migration), `client/src/daemon/daemon.ts`, `client/src/daemon/loop-heartbeat.ts`, `client/src/main.ts`, `client/src/api/server.ts`, `client/src/cli/commands/tasks.ts`, `client/src/cli/commands/solver-nets.ts`, `client/src/cli/index.ts`, `client/src/dashboard/spa/src/App.tsx`, `client/src/dashboard/spa/src/routes.ts`, `client/OPERATOR-APP-SPEC.md`.

**Deleted:** `client/src/daemon/creator.ts`, `client/src/tasks/posting-service.ts`, `client/src/tasks/sources.ts`, `client/src/solvernets/launched-record-dispatcher.ts`, `client/src/solvernets/lifecycle-transitions.ts`, and their tests.

**New — CLI:** `client/src/cli/commands/policy.ts`, `client/src/cli/commands/wiring.ts`.

---

### Task 1: The requester module boundary test and error taxonomy

The boundary test comes first and is fail-by-omission: it fails when the directory does not exist, and it fails on the first import that resolves outside it. Every later task inherits it.

**Files:**
- Create: `client/src/requester/errors.ts`
- Create: `client/src/requester/index.ts`
- Test: `client/test/architecture/requester-module-boundary.test.ts`
- Test: `client/test/requester/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `REQUESTER_ERROR_CATEGORIES: readonly RequesterErrorCategory[]`; `class RequesterError extends Error` with `readonly category: RequesterErrorCategory` and `readonly code: string`, constructor `(category, code, message, options?: { cause?: unknown })`; `isRequesterError(value: unknown): value is RequesterError`.

- [ ] **Step 1: Write the failing boundary test**

```ts
// client/test/architecture/requester-module-boundary.test.ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `client/src/requester/` is the extractable work-client module (daemon composition design §8;
 * marketplace-surfaces design §5.1). It is composed strictly through the binding's public
 * interfaces and injected ports, so it must not import anything from the rest of the host.
 * This test is what makes "extractable" a checked property.
 */
const requesterDir = fileURLToPath(new URL('../../src/requester/', import.meta.url));

/** Bare specifiers the module may depend on. Anything else is a boundary violation. */
const ALLOWED_PACKAGES = [
  '@jinn-network/marketplace-binding',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-backend',
  'viem',
  'zod',
];

const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('src/requester/ import boundary', () => {
  it('the module exists and has source files', () => {
    expect(sourceFiles(requesterDir).length).toBeGreaterThan(0);
  });

  it('no module under src/requester/ imports outside the module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(requesterDir)) {
      const src = readFileSync(file, 'utf-8');
      for (const match of src.matchAll(IMPORT_RE)) {
        const specifier = match[1]!;
        if (specifier.startsWith('node:')) continue;
        if (!specifier.startsWith('.')) {
          const root = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0]!;
          if (!ALLOWED_PACKAGES.includes(root)) {
            offenders.push(`${relative(requesterDir, file)}: bare import ${specifier}`);
          }
          continue;
        }
        const resolved = resolve(dirname(file), specifier);
        if (relative(requesterDir, resolved).startsWith('..')) {
          offenders.push(`${relative(requesterDir, file)}: escapes the module via ${specifier}`);
        }
      }
    }
    expect(offenders, `requester boundary violations:\n${offenders.join('\n')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/architecture/requester-module-boundary.test.ts`
Expected: FAIL — `ENOENT: no such file or directory, scandir '.../src/requester/'`.

- [ ] **Step 3: Write the error taxonomy test**

```ts
// client/test/requester/errors.test.ts
import { describe, expect, it } from 'vitest';
import {
  REQUESTER_ERROR_CATEGORIES,
  RequesterError,
  isRequesterError,
} from '../../src/requester/errors.js';

describe('requester error taxonomy', () => {
  it('carries category, code and cause', () => {
    const cause = new Error('underlying');
    const err = new RequesterError('funds', 'safe-underfunded', 'Safe is short', { cause });
    expect(err.category).toBe('funds');
    expect(err.code).toBe('safe-underfunded');
    expect(err.name).toBe('RequesterError');
    expect(err.cause).toBe(cause);
  });

  it('is narrowable and rejects non-errors', () => {
    expect(isRequesterError(new RequesterError('venue', 'no-chain-config', 'x'))).toBe(true);
    expect(isRequesterError(new Error('plain'))).toBe(false);
    expect(isRequesterError('funds')).toBe(false);
  });

  it('declares the closed category set in preflight order', () => {
    expect(REQUESTER_ERROR_CATEGORIES).toEqual([
      'config',
      'funds',
      'venue',
      'target',
      'freshness',
      'documents',
      'broadcast',
      'delivery',
      'adoption',
      'settlement',
    ]);
  });
});
```

- [ ] **Step 4: Implement the taxonomy and the module surface**

```ts
// client/src/requester/errors.ts
/**
 * The requester module's strict error taxonomy. Category is the operator-facing bucket (it
 * drives the preflight report and the SPA state message); code is the stable machine
 * discriminator. Both are closed sets — a new failure mode adds a code, never a free string.
 */
export const REQUESTER_ERROR_CATEGORIES = [
  'config',
  'funds',
  'venue',
  'target',
  'freshness',
  'documents',
  'broadcast',
  'delivery',
  'adoption',
  'settlement',
] as const;

export type RequesterErrorCategory = (typeof REQUESTER_ERROR_CATEGORIES)[number];

export class RequesterError extends Error {
  override readonly name = 'RequesterError';

  constructor(
    readonly category: RequesterErrorCategory,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isRequesterError(value: unknown): value is RequesterError {
  return value instanceof RequesterError;
}
```

```ts
// client/src/requester/index.ts
// The extractable work-client module's single public surface (daemon composition design §8).
// Nothing here imports from the rest of the host; see
// client/test/architecture/requester-module-boundary.test.ts.
export {
  REQUESTER_ERROR_CATEGORIES,
  RequesterError,
  isRequesterError,
} from './errors.js';
export type { RequesterErrorCategory } from './errors.js';
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `cd client && yarn vitest run test/architecture/requester-module-boundary.test.ts test/requester/errors.test.ts && yarn typecheck`
Expected: PASS, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/requester client/test/architecture/requester-module-boundary.test.ts client/test/requester/errors.test.ts
git commit -m "feat(requester): add extractable module boundary test and error taxonomy"
```

---

### Task 2: Preflight-behavior golden fixtures

Kit-first, per the global constraint and marketplace-surfaces §4.3 step 1: the fixtures pin today's CLI behavior as the reference before any implementation exists. The behavior is read off `client/src/tasks/submit-preflight.ts` (funding rule at lines 63–87, freshness rule at lines 25–61, selection rule at lines 97–130) and entered as data, not code.

**Files:**
- Create: `client/test/requester/fixtures/preflight-behavior.golden.json`
- Test: `client/test/requester/preflight-golden.test.ts`

**Interfaces:**
- Consumes: `RequesterError` from Task 1.
- Produces: the golden fixture file and the fixture-driven test. Tasks 3–6 make it pass. Later plans (marketplace-surfaces follow-up 4) re-use this file as the drift alarm; its `schemaVersion` is `jinn-requester-preflight-golden.v1`.

- [ ] **Step 1: Write the fixture file**

```json
{
  "schemaVersion": "jinn-requester-preflight-golden.v1",
  "provenance": "client/src/tasks/submit-preflight.ts at integration/evidence-v1; legacy categories creator|funds|rpc|contracts|indexer|gateway|solverNet map to config|funds|venue|target|freshness|documents",
  "categoryOrder": ["config", "funds", "venue", "target", "freshness", "documents"],
  "freshnessReserveMs": 60000,
  "funds": [
    {
      "name": "both balances cover a single-claim budget",
      "input": {
        "safeBalanceWei": "2000",
        "agentBalanceWei": "3000",
        "solutionMaxDeliveryRateWei": "500",
        "verdictMaxDeliveryRateWei": "500",
        "maxClaims": 1,
        "agentGasReserveWei": "1000"
      },
      "expect": { "ok": true }
    },
    {
      "name": "budget scales with maxClaims",
      "input": {
        "safeBalanceWei": "2000",
        "agentBalanceWei": "9000",
        "solutionMaxDeliveryRateWei": "500",
        "verdictMaxDeliveryRateWei": "500",
        "maxClaims": 3,
        "agentGasReserveWei": "1000"
      },
      "expect": { "error": { "category": "funds", "code": "safe-underfunded" } }
    },
    {
      "name": "agent EOA must also cover the outer Safe exec value plus gas reserve",
      "input": {
        "safeBalanceWei": "2000",
        "agentBalanceWei": "1500",
        "solutionMaxDeliveryRateWei": "500",
        "verdictMaxDeliveryRateWei": "500",
        "maxClaims": 1,
        "agentGasReserveWei": "1000"
      },
      "expect": { "error": { "category": "funds", "code": "agent-underfunded" } }
    },
    {
      "name": "exact-equality balances pass",
      "input": {
        "safeBalanceWei": "1000",
        "agentBalanceWei": "2000",
        "solutionMaxDeliveryRateWei": "500",
        "verdictMaxDeliveryRateWei": "500",
        "maxClaims": 1,
        "agentGasReserveWei": "1000"
      },
      "expect": { "ok": true }
    }
  ],
  "freshness": [
    {
      "name": "all three deadlines live beyond the reserve",
      "input": {
        "nowMs": 1000000,
        "claimWindowEndMs": 1200000,
        "submissionDeadlineMs": 1300000,
        "sessionDeadlineMs": 1400000
      },
      "expect": { "ok": true }
    },
    {
      "name": "claim window inside the reserve is expired",
      "input": {
        "nowMs": 1000000,
        "claimWindowEndMs": 1030000,
        "submissionDeadlineMs": 1300000,
        "sessionDeadlineMs": 1400000
      },
      "expect": {
        "error": { "category": "freshness", "code": "request-expired", "expired": ["claim window end"] }
      }
    },
    {
      "name": "a deadline exactly at now plus reserve is expired",
      "input": {
        "nowMs": 1000000,
        "claimWindowEndMs": 1060000,
        "submissionDeadlineMs": 1300000,
        "sessionDeadlineMs": 1400000
      },
      "expect": {
        "error": { "category": "freshness", "code": "request-expired", "expired": ["claim window end"] }
      }
    },
    {
      "name": "a non-finite deadline is expired and every offender is named",
      "input": {
        "nowMs": 1000000,
        "claimWindowEndMs": null,
        "submissionDeadlineMs": 1010000,
        "sessionDeadlineMs": 1400000
      },
      "expect": {
        "error": {
          "category": "freshness",
          "code": "request-expired",
          "expired": ["claim window end", "submission deadline"]
        }
      }
    }
  ],
  "target": [
    {
      "name": "exactly one live candidate selects without a hint",
      "input": {
        "candidates": [
          { "postingKey": "a", "workKind": "repository-work", "profileUri": "urn:p:1", "live": true },
          { "postingKey": "b", "workKind": "repository-work", "profileUri": "urn:p:1", "live": false }
        ]
      },
      "expect": { "ok": true, "postingKey": "a" }
    },
    {
      "name": "explicit key must be live",
      "input": {
        "explicitPostingKey": "b",
        "candidates": [
          { "postingKey": "a", "workKind": "repository-work", "profileUri": "urn:p:1", "live": true },
          { "postingKey": "b", "workKind": "repository-work", "profileUri": "urn:p:1", "live": false }
        ]
      },
      "expect": { "error": { "category": "target", "code": "explicit-not-live" } }
    },
    {
      "name": "two live candidates without a hint are ambiguous",
      "input": {
        "candidates": [
          { "postingKey": "a", "workKind": "repository-work", "profileUri": "urn:p:1", "live": true },
          { "postingKey": "b", "workKind": "repository-work", "profileUri": "urn:p:1", "live": true }
        ]
      },
      "expect": { "error": { "category": "target", "code": "ambiguous-target" } }
    },
    {
      "name": "work-kind narrows an otherwise ambiguous set",
      "input": {
        "requestedWorkKind": "evaluation",
        "candidates": [
          { "postingKey": "a", "workKind": "repository-work", "profileUri": "urn:p:1", "live": true },
          { "postingKey": "b", "workKind": "evaluation", "profileUri": "urn:p:2", "live": true }
        ]
      },
      "expect": { "ok": true, "postingKey": "b" }
    },
    {
      "name": "no live candidate",
      "input": {
        "candidates": [
          { "postingKey": "a", "workKind": "repository-work", "profileUri": "urn:p:1", "live": false }
        ]
      },
      "expect": { "error": { "category": "target", "code": "no-live-target" } }
    }
  ]
}
```

- [ ] **Step 2: Write the fixture-driven test**

```ts
// client/test/requester/preflight-golden.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRequesterError } from '../../src/requester/errors.js';
import {
  POSTING_FRESHNESS_RESERVE_MS,
  POSTING_PREFLIGHT_CATEGORIES,
  assertPostingFreshness,
  assertPostingFunds,
  selectLiveTarget,
} from '../../src/requester/preflight/index.js';

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/preflight-behavior.golden.json', import.meta.url)),
    'utf-8',
  ),
);

function capture(run: () => void): { category?: string; code?: string; expired?: string[] } {
  try {
    run();
    return {};
  } catch (err) {
    if (!isRequesterError(err)) throw err;
    const expired = (err as unknown as { expired?: string[] }).expired;
    return { category: err.category, code: err.code, ...(expired ? { expired } : {}) };
  }
}

describe('preflight golden behavior', () => {
  it('pins the reserve and the category order', () => {
    expect(POSTING_FRESHNESS_RESERVE_MS).toBe(golden.freshnessReserveMs);
    expect(POSTING_PREFLIGHT_CATEGORIES).toEqual(golden.categoryOrder);
  });

  for (const testCase of golden.funds) {
    it(`funds: ${testCase.name}`, () => {
      const input = testCase.input;
      const actual = capture(() =>
        assertPostingFunds({
          safeBalanceWei: BigInt(input.safeBalanceWei),
          agentBalanceWei: BigInt(input.agentBalanceWei),
          solutionMaxDeliveryRateWei: BigInt(input.solutionMaxDeliveryRateWei),
          verdictMaxDeliveryRateWei: BigInt(input.verdictMaxDeliveryRateWei),
          maxClaims: input.maxClaims,
          agentGasReserveWei: BigInt(input.agentGasReserveWei),
        }),
      );
      expect(actual).toEqual(testCase.expect.ok ? {} : testCase.expect.error);
    });
  }

  for (const testCase of golden.freshness) {
    it(`freshness: ${testCase.name}`, () => {
      const input = testCase.input;
      const actual = capture(() =>
        assertPostingFreshness(
          {
            claimWindowEndMs: input.claimWindowEndMs ?? Number.NaN,
            submissionDeadlineMs: input.submissionDeadlineMs ?? Number.NaN,
            sessionDeadlineMs: input.sessionDeadlineMs ?? Number.NaN,
          },
          { nowMs: input.nowMs },
        ),
      );
      expect(actual).toEqual(testCase.expect.ok ? {} : testCase.expect.error);
    });
  }

  for (const testCase of golden.target) {
    it(`target: ${testCase.name}`, () => {
      const input = testCase.input;
      if (testCase.expect.ok) {
        expect(selectLiveTarget(input).postingKey).toBe(testCase.expect.postingKey);
        return;
      }
      expect(capture(() => selectLiveTarget(input))).toEqual(testCase.expect.error);
    });
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/preflight-golden.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/requester/preflight/index.js"`.

- [ ] **Step 4: Commit the failing kit**

```bash
git add client/test/requester/fixtures/preflight-behavior.golden.json client/test/requester/preflight-golden.test.ts
git commit -m "test(requester): pin legacy preflight behavior as golden fixtures"
```

---

### Task 3: Funds preflight

**Files:**
- Create: `client/src/requester/preflight/funds.ts`
- Test: `client/test/requester/preflight-funds.test.ts`

**Interfaces:**
- Consumes: `RequesterError` (Task 1).
- Produces: `interface PostingFundsInput { safeBalanceWei: bigint; agentBalanceWei: bigint; solutionMaxDeliveryRateWei: bigint; verdictMaxDeliveryRateWei: bigint; maxClaims: number; agentGasReserveWei: bigint }`; `assertPostingFunds(input: PostingFundsInput): void` throwing `RequesterError('funds', 'safe-underfunded' | 'agent-underfunded', …)`; `postingBudgetWei(input): bigint`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/preflight-funds.test.ts
import { describe, expect, it } from 'vitest';
import { assertPostingFunds, postingBudgetWei } from '../../src/requester/preflight/funds.js';
import { RequesterError } from '../../src/requester/errors.js';

const base = {
  safeBalanceWei: 10_000n,
  agentBalanceWei: 20_000n,
  solutionMaxDeliveryRateWei: 500n,
  verdictMaxDeliveryRateWei: 500n,
  maxClaims: 2,
  agentGasReserveWei: 1_000n,
};

describe('assertPostingFunds', () => {
  it('computes the two-rail budget across claim slots', () => {
    expect(postingBudgetWei(base)).toBe(2_000n);
  });

  it('passes when both balances cover their requirement', () => {
    expect(() => assertPostingFunds(base)).not.toThrow();
  });

  it('names the Safe shortfall in the message', () => {
    try {
      assertPostingFunds({ ...base, safeBalanceWei: 1_999n });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RequesterError);
      expect((err as RequesterError).code).toBe('safe-underfunded');
      expect((err as RequesterError).message).toContain('2000 wei');
      expect((err as RequesterError).message).toContain('1999 wei');
    }
  });

  it('requires the agent EOA to cover the budget plus the gas reserve', () => {
    try {
      assertPostingFunds({ ...base, agentBalanceWei: 2_999n });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).code).toBe('agent-underfunded');
      expect((err as RequesterError).category).toBe('funds');
    }
  });

  it('rejects a non-positive claim count as a config error', () => {
    try {
      assertPostingFunds({ ...base, maxClaims: 0 });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).category).toBe('config');
      expect((err as RequesterError).code).toBe('invalid-max-claims');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/preflight-funds.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/preflight/funds.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/preflight/funds.ts
import { RequesterError } from '../errors.js';

export interface PostingFundsInput {
  readonly safeBalanceWei: bigint;
  readonly agentBalanceWei: bigint;
  readonly solutionMaxDeliveryRateWei: bigint;
  readonly verdictMaxDeliveryRateWei: bigint;
  readonly maxClaims: number;
  readonly agentGasReserveWei: bigint;
}

/** The two-rail escrow the venue withholds: (solution + verdict) rates across every claim slot. */
export function postingBudgetWei(input: PostingFundsInput): bigint {
  return (
    (input.solutionMaxDeliveryRateWei + input.verdictMaxDeliveryRateWei)
    * BigInt(input.maxClaims)
  );
}

/**
 * The requester funding rule: the creator Safe holds the whole task budget, and the agent EOA
 * holds that same budget (it is the outer Safe exec value) plus a gas reserve.
 */
export function assertPostingFunds(input: PostingFundsInput): void {
  if (!Number.isInteger(input.maxClaims) || input.maxClaims < 1) {
    throw new RequesterError(
      'config',
      'invalid-max-claims',
      `maxClaims must be a positive integer, received ${input.maxClaims}`,
    );
  }
  const budget = postingBudgetWei(input);
  if (input.safeBalanceWei < budget) {
    throw new RequesterError(
      'funds',
      'safe-underfunded',
      `creator Safe requires ${budget} wei task budget but has ${input.safeBalanceWei} wei`,
    );
  }
  const requiredAgent = budget + input.agentGasReserveWei;
  if (input.agentBalanceWei < requiredAgent) {
    throw new RequesterError(
      'funds',
      'agent-underfunded',
      `creator agent EOA requires ${requiredAgent} wei: ${budget} wei outer Safe exec value plus `
      + `${input.agentGasReserveWei} wei gas reserve, but has ${input.agentBalanceWei} wei`,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/preflight-funds.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester/preflight/funds.ts client/test/requester/preflight-funds.test.ts
git commit -m "feat(requester): add funds preflight"
```

---

### Task 4: Freshness preflight

**Files:**
- Create: `client/src/requester/preflight/freshness.ts`
- Test: `client/test/requester/preflight-freshness.test.ts`

**Interfaces:**
- Consumes: `RequesterError` (Task 1).
- Produces: `POSTING_FRESHNESS_RESERVE_MS = 60_000`; `interface PostingFreshnessInput { claimWindowEndMs: number; submissionDeadlineMs: number; sessionDeadlineMs: number }`; `assertPostingFreshness(input: PostingFreshnessInput, options?: { nowMs?: number; reserveMs?: number }): void`; the thrown `RequesterError` carries `code: 'request-expired'` and an extra readonly `expired: readonly string[]` field naming every offending deadline.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/preflight-freshness.test.ts
import { describe, expect, it } from 'vitest';
import {
  POSTING_FRESHNESS_RESERVE_MS,
  RequestExpiredError,
  assertPostingFreshness,
} from '../../src/requester/preflight/freshness.js';

const live = {
  claimWindowEndMs: 1_200_000,
  submissionDeadlineMs: 1_300_000,
  sessionDeadlineMs: 1_400_000,
};

describe('assertPostingFreshness', () => {
  it('uses a 60s execution reserve by default', () => {
    expect(POSTING_FRESHNESS_RESERVE_MS).toBe(60_000);
  });

  it('passes when every deadline stays live beyond the reserve', () => {
    expect(() => assertPostingFreshness(live, { nowMs: 1_000_000 })).not.toThrow();
  });

  it('names every expired deadline, in declaration order', () => {
    try {
      assertPostingFreshness(
        { ...live, claimWindowEndMs: Number.NaN, submissionDeadlineMs: 1_010_000 },
        { nowMs: 1_000_000 },
      );
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RequestExpiredError);
      expect((err as RequestExpiredError).expired).toEqual([
        'claim window end',
        'submission deadline',
      ]);
      expect((err as RequestExpiredError).category).toBe('freshness');
      expect((err as RequestExpiredError).code).toBe('request-expired');
    }
  });

  it('treats a deadline exactly at now plus reserve as expired', () => {
    expect(() =>
      assertPostingFreshness({ ...live, claimWindowEndMs: 1_060_000 }, { nowMs: 1_000_000 }),
    ).toThrow(RequestExpiredError);
  });

  it('honors an overridden reserve', () => {
    expect(() =>
      assertPostingFreshness({ ...live, claimWindowEndMs: 1_100_000 }, {
        nowMs: 1_000_000,
        reserveMs: 150_000,
      }),
    ).toThrow(RequestExpiredError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/preflight-freshness.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/preflight/freshness.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/preflight/freshness.ts
import { RequesterError } from '../errors.js';

/** Execution reserve: a deadline that lands inside this window is treated as already gone. */
export const POSTING_FRESHNESS_RESERVE_MS = 60_000;

export interface PostingFreshnessInput {
  readonly claimWindowEndMs: number;
  readonly submissionDeadlineMs: number;
  readonly sessionDeadlineMs: number;
}

export class RequestExpiredError extends RequesterError {
  constructor(
    readonly expired: readonly string[],
    minimumLiveDeadlineMs: number,
    reserveMs: number,
  ) {
    super(
      'freshness',
      'request-expired',
      `posting freshness check failed: ${expired.join(', ')} must remain live beyond `
      + `${new Date(minimumLiveDeadlineMs).toISOString()} (${reserveMs} ms execution reserve)`,
    );
  }
}

export function assertPostingFreshness(
  input: PostingFreshnessInput,
  options: { nowMs?: number; reserveMs?: number } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const reserveMs = options.reserveMs ?? POSTING_FRESHNESS_RESERVE_MS;
  const minimumLiveDeadline = nowMs + reserveMs;
  const deadlines: readonly (readonly [string, number])[] = [
    ['claim window end', input.claimWindowEndMs],
    ['submission deadline', input.submissionDeadlineMs],
    ['session/adoption deadline', input.sessionDeadlineMs],
  ];
  const expired = deadlines
    .filter(([, deadline]) => !Number.isFinite(deadline) || deadline <= minimumLiveDeadline)
    .map(([label]) => label);
  if (expired.length > 0) {
    throw new RequestExpiredError(expired, minimumLiveDeadline, reserveMs);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/preflight-freshness.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester/preflight/freshness.ts client/test/requester/preflight-freshness.test.ts
git commit -m "feat(requester): add freshness preflight"
```

---

### Task 5: Live-target selection

Replaces `selectMarketplaceTaskSolverNet` (`client/src/tasks/submit-preflight.ts:97-130`). The selection axis is the posting-config entry, not a SolverNet manifest — liveness is supplied by the caller from venue facts, keeping this function pure.

**Files:**
- Create: `client/src/requester/preflight/target.ts`
- Test: `client/test/requester/preflight-target.test.ts`

**Interfaces:**
- Consumes: `RequesterError` (Task 1).
- Produces: `interface PostingTargetCandidate { postingKey: string; workKind: string; profileUri: string; live: boolean; legacyManifestDigest?: string }`; `interface SelectLiveTargetInput { candidates: readonly PostingTargetCandidate[]; explicitPostingKey?: string; requestedWorkKind?: string }`; `selectLiveTarget(input: SelectLiveTargetInput): PostingTargetCandidate` throwing codes `explicit-unknown`, `explicit-not-live`, `no-live-target`, `ambiguous-target`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/preflight-target.test.ts
import { describe, expect, it } from 'vitest';
import { RequesterError } from '../../src/requester/errors.js';
import { selectLiveTarget } from '../../src/requester/preflight/target.js';

const repo = { postingKey: 'repo', workKind: 'repository-work', profileUri: 'urn:p:1', live: true };
const evalNet = { postingKey: 'eval', workKind: 'evaluation', profileUri: 'urn:p:2', live: true };
const dark = { postingKey: 'dark', workKind: 'repository-work', profileUri: 'urn:p:1', live: false };

function codeOf(run: () => unknown): string {
  try {
    run();
    throw new Error('expected a throw');
  } catch (err) {
    expect(err).toBeInstanceOf(RequesterError);
    return (err as RequesterError).code;
  }
}

describe('selectLiveTarget', () => {
  it('selects the single live candidate', () => {
    expect(selectLiveTarget({ candidates: [repo, dark] }).postingKey).toBe('repo');
  });

  it('honors an explicit posting key', () => {
    expect(
      selectLiveTarget({ candidates: [repo, evalNet], explicitPostingKey: 'eval' }).postingKey,
    ).toBe('eval');
  });

  it('rejects an unknown explicit key', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [repo], explicitPostingKey: 'nope' })))
      .toBe('explicit-unknown');
  });

  it('rejects an explicit key that is not live', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [repo, dark], explicitPostingKey: 'dark' })))
      .toBe('explicit-not-live');
  });

  it('narrows by work kind', () => {
    expect(
      selectLiveTarget({ candidates: [repo, evalNet], requestedWorkKind: 'evaluation' }).postingKey,
    ).toBe('eval');
  });

  it('refuses to guess between two live candidates', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [repo, evalNet] }))).toBe('ambiguous-target');
  });

  it('reports an empty live set distinctly', () => {
    expect(codeOf(() => selectLiveTarget({ candidates: [dark] }))).toBe('no-live-target');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/preflight-target.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/preflight/target.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/preflight/target.ts
import { RequesterError } from '../errors.js';

export interface PostingTargetCandidate {
  readonly postingKey: string;
  readonly workKind: string;
  readonly profileUri: string;
  /** Supplied by the caller from venue facts; this module reads no chain and no network. */
  readonly live: boolean;
  /** Migration-honesty annotation carried from the launched-record migration (design §9). */
  readonly legacyManifestDigest?: string;
}

export interface SelectLiveTargetInput {
  readonly candidates: readonly PostingTargetCandidate[];
  readonly explicitPostingKey?: string;
  readonly requestedWorkKind?: string;
}

/**
 * Selection never guesses: an explicit key must exist and be live, and an implicit selection
 * must resolve to exactly one live candidate after the optional work-kind narrowing.
 */
export function selectLiveTarget(input: SelectLiveTargetInput): PostingTargetCandidate {
  if (input.explicitPostingKey !== undefined) {
    const exact = input.candidates.find(
      (candidate) => candidate.postingKey === input.explicitPostingKey,
    );
    if (exact === undefined) {
      throw new RequesterError(
        'target',
        'explicit-unknown',
        `posting entry ${input.explicitPostingKey} is not configured`,
      );
    }
    if (!exact.live) {
      throw new RequesterError(
        'target',
        'explicit-not-live',
        `posting entry ${input.explicitPostingKey} is configured but not live at the venue`,
      );
    }
    return exact;
  }

  const live = input.candidates.filter((candidate) => candidate.live);
  const narrowed = input.requestedWorkKind === undefined
    ? live
    : live.filter((candidate) => candidate.workKind === input.requestedWorkKind);

  if (narrowed.length === 0) {
    throw new RequesterError(
      'target',
      'no-live-target',
      input.requestedWorkKind === undefined
        ? 'no live posting entry is configured'
        : `no live posting entry serves work kind ${input.requestedWorkKind}`,
    );
  }
  if (narrowed.length > 1) {
    throw new RequesterError(
      'target',
      'ambiguous-target',
      `expected exactly one live posting entry but found ${narrowed.length} `
      + `(${narrowed.map((candidate) => candidate.postingKey).join(', ')}); pass an explicit entry`,
    );
  }
  return narrowed[0]!;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/preflight-target.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester/preflight/target.ts client/test/requester/preflight-target.test.ts
git commit -m "feat(requester): add live posting-target selection"
```

---

### Task 6: The preflight runner and the preflight core's public surface

This closes the golden kit from Task 2 and is the surface the marketplace-surfaces session packages and the CLI later converges onto.

**Files:**
- Create: `client/src/requester/preflight/run.ts`
- Create: `client/src/requester/preflight/index.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/preflight-run.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Produces: `POSTING_PREFLIGHT_CATEGORIES = ['config','funds','venue','target','freshness','documents'] as const`; `type PostingPreflightCategory`; `type PostingPreflightChecks = Record<PostingPreflightCategory, () => Promise<void>>`; `interface PostingPreflightEntry { category: PostingPreflightCategory; status: 'ok' | 'failed'; detail?: string; code?: string }`; `runPostingPreflight(checks: PostingPreflightChecks): Promise<readonly PostingPreflightEntry[]>` — runs categories in order, stops at the first failure, and re-throws it after recording the report on the error as `readonly report: readonly PostingPreflightEntry[]`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/preflight-run.test.ts
import { describe, expect, it } from 'vitest';
import { RequesterError } from '../../src/requester/errors.js';
import {
  POSTING_PREFLIGHT_CATEGORIES,
  PostingPreflightFailure,
  runPostingPreflight,
} from '../../src/requester/preflight/run.js';

function checks(overrides: Partial<Record<string, () => Promise<void>>> = {}) {
  const ok = async () => {};
  return Object.fromEntries(
    POSTING_PREFLIGHT_CATEGORIES.map((category) => [category, overrides[category] ?? ok]),
  ) as Parameters<typeof runPostingPreflight>[0];
}

describe('runPostingPreflight', () => {
  it('runs every category in declared order and reports ok', async () => {
    const seen: string[] = [];
    const report = await runPostingPreflight(
      checks(
        Object.fromEntries(
          POSTING_PREFLIGHT_CATEGORIES.map((category) => [
            category,
            async () => { seen.push(category); },
          ]),
        ),
      ),
    );
    expect(seen).toEqual([...POSTING_PREFLIGHT_CATEGORIES]);
    expect(report.every((entry) => entry.status === 'ok')).toBe(true);
  });

  it('stops at the first failure and carries the partial report', async () => {
    const ran: string[] = [];
    const failing = checks({
      venue: async () => {
        throw new RequesterError('venue', 'chain-unreachable', 'rpc down');
      },
      target: async () => { ran.push('target'); },
    });
    await expect(runPostingPreflight(failing)).rejects.toBeInstanceOf(PostingPreflightFailure);
    expect(ran).toEqual([]);
    try {
      await runPostingPreflight(failing);
    } catch (err) {
      const failure = err as PostingPreflightFailure;
      expect(failure.category).toBe('venue');
      expect(failure.code).toBe('chain-unreachable');
      expect(failure.report.map((entry) => entry.status)).toEqual(['ok', 'ok', 'failed']);
    }
  });

  it('wraps a non-requester throw under its category', async () => {
    try {
      await runPostingPreflight(checks({ funds: async () => { throw new Error('boom'); } }));
    } catch (err) {
      const failure = err as PostingPreflightFailure;
      expect(failure.category).toBe('funds');
      expect(failure.code).toBe('check-threw');
      expect(failure.message).toContain('boom');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/preflight-run.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/preflight/run.js`.

- [ ] **Step 3: Implement the runner**

```ts
// client/src/requester/preflight/run.ts
import { RequesterError, isRequesterError } from '../errors.js';

/**
 * Ordered preflight categories. The order is the fail-fast order: cheap local checks precede
 * network reads, and document sealing runs last because it is only meaningful once the target
 * and its terms are fixed.
 */
export const POSTING_PREFLIGHT_CATEGORIES = [
  'config',
  'funds',
  'venue',
  'target',
  'freshness',
  'documents',
] as const;

export type PostingPreflightCategory = (typeof POSTING_PREFLIGHT_CATEGORIES)[number];

export type PostingPreflightChecks = Record<PostingPreflightCategory, () => Promise<void>>;

export interface PostingPreflightEntry {
  readonly category: PostingPreflightCategory;
  readonly status: 'ok' | 'failed';
  readonly code?: string;
  readonly detail?: string;
}

export class PostingPreflightFailure extends RequesterError {
  constructor(
    category: PostingPreflightCategory,
    code: string,
    detail: string,
    readonly report: readonly PostingPreflightEntry[],
    options?: { cause?: unknown },
  ) {
    super(category, code, `posting preflight failed (${category}/${code}): ${detail}`, options);
  }
}

export async function runPostingPreflight(
  checks: PostingPreflightChecks,
): Promise<readonly PostingPreflightEntry[]> {
  const report: PostingPreflightEntry[] = [];
  for (const category of POSTING_PREFLIGHT_CATEGORIES) {
    try {
      // eslint-disable-next-line no-await-in-loop -- preflight is deliberately sequential.
      await checks[category]();
      report.push({ category, status: 'ok' });
    } catch (err) {
      const code = isRequesterError(err) ? err.code : 'check-threw';
      const detail = err instanceof Error ? err.message : String(err);
      report.push({ category, status: 'failed', code, detail });
      throw new PostingPreflightFailure(category, code, detail, report, { cause: err });
    }
  }
  return report;
}
```

- [ ] **Step 4: Write the preflight public surface and re-export it from the module**

```ts
// client/src/requester/preflight/index.ts
// The preflight core's own public surface. Marketplace-surfaces design §4.3 authors golden
// fixtures against exactly these exports and later converges the `jinn` CLI onto them.
export { assertPostingFunds, postingBudgetWei } from './funds.js';
export type { PostingFundsInput } from './funds.js';
export {
  POSTING_FRESHNESS_RESERVE_MS,
  RequestExpiredError,
  assertPostingFreshness,
} from './freshness.js';
export type { PostingFreshnessInput } from './freshness.js';
export { selectLiveTarget } from './target.js';
export type { PostingTargetCandidate, SelectLiveTargetInput } from './target.js';
export {
  POSTING_PREFLIGHT_CATEGORIES,
  PostingPreflightFailure,
  runPostingPreflight,
} from './run.js';
export type {
  PostingPreflightCategory,
  PostingPreflightChecks,
  PostingPreflightEntry,
} from './run.js';
```

Append to `client/src/requester/index.ts`:

```ts
export * from './preflight/index.js';
```

- [ ] **Step 5: Run the runner test, the golden kit, and the boundary test**

Run: `cd client && yarn vitest run test/requester test/architecture/requester-module-boundary.test.ts && yarn typecheck`
Expected: PASS — including `test/requester/preflight-golden.test.ts`, which was red since Task 2.

- [ ] **Step 6: Commit**

```bash
git add client/src/requester client/test/requester/preflight-run.test.ts
git commit -m "feat(requester): add preflight runner and preflight core public surface"
```

---

### Task 7: Posting document builders

The binding's `postTask` refuses a Task/Submission pair whose digests do not join (`packages/marketplace/binding/src/posting.ts:108-115`). This task makes that failure impossible by construction: the Submission's task reference is derived from the sealed Task bytes.

**Files:**
- Create: `client/src/requester/documents.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/documents.test.ts`

**Interfaces:**
- Consumes: `RequesterError` (Task 1); `sealTask`, `sealSubmission`, `sha256Hex`, `documentDigest`, `SubmissionRecordSchema`, `TASK_EXECUTION_PROTOCOL_URI` from `@jinn-network/task-execution-protocol`.
- Produces:
  - `interface SealedDocument { document: unknown; bytes: Uint8Array; digest: \`sha256:${string}\` }`
  - `interface PostingSubmissionFields { submission: \`urn:uuid:${string}\`; requester: string; idempotencyKey: string; nonce: string; deadline: string; closeAt?: string; attempts?: { maxTotal?: number; maxConcurrent?: number }; evaluationRequirements?: Record<string, unknown>; capabilityGrants?: Record<string, unknown>; requirements?: Record<string, unknown>; profileParameters?: Record<string, unknown>; annotations?: Record<string, unknown> }`
  - `interface PostingDocuments { task: SealedDocument; submission: SealedDocument }`
  - `buildPostingDocuments(input: { taskDocument: unknown; submissionFields: PostingSubmissionFields; taskReferenceName?: string }): PostingDocuments`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/documents.test.ts
import { describe, expect, it } from 'vitest';
import { SubmissionRecordSchema, sha256Hex } from '@jinn-network/task-execution-protocol';
import { RequesterError } from '../../src/requester/errors.js';
import { buildPostingDocuments } from '../../src/requester/documents.js';

const taskDocument = {
  protocol: 'https://jinn.network/protocols/task-execution/1.0',
  profile: 'urn:profile:repository-work/1.0#sha256:aa',
  instructions: 'Make the failing test pass.',
  payload: { repository: 'https://example.invalid/repo.git' },
  createdAt: '2026-07-30T00:00:00Z',
};

const submissionFields = {
  submission: 'urn:uuid:11111111-1111-4111-8111-111111111111' as const,
  requester: 'did:key:zRequester',
  idempotencyKey: 'posting:demo:1',
  nonce: '0x01',
  deadline: '2026-08-01T00:00:00Z',
  attempts: { maxTotal: 2 },
};

describe('buildPostingDocuments', () => {
  it('binds the Submission to the sealed Task digest', () => {
    const docs = buildPostingDocuments({ taskDocument, submissionFields });
    const parsed = SubmissionRecordSchema.parse(docs.submission.document);
    expect(parsed.task.digest?.sha256).toBe(sha256Hex(docs.task.bytes));
    expect(docs.task.digest).toBe(`sha256:${sha256Hex(docs.task.bytes)}`);
    expect(parsed.task.name).toBe('task');
  });

  it('is deterministic — identical inputs seal to identical bytes', () => {
    const first = buildPostingDocuments({ taskDocument, submissionFields });
    const second = buildPostingDocuments({ taskDocument, submissionFields });
    expect(second.submission.digest).toBe(first.submission.digest);
    expect(second.task.digest).toBe(first.task.digest);
  });

  it('carries optional fields through and omits absent ones', () => {
    const docs = buildPostingDocuments({
      taskDocument,
      submissionFields: {
        ...submissionFields,
        capabilityGrants: { 'urn:grant:repo': { token: 'redacted' } },
        annotations: { 'https://jinn.network/annotations/run/1.0': { runId: 'r1' } },
      },
    });
    const document = docs.submission.document as Record<string, unknown>;
    expect(document['capabilityGrants']).toEqual({ 'urn:grant:repo': { token: 'redacted' } });
    expect('closeAt' in document).toBe(false);
    expect('profileParameters' in document).toBe(false);
  });

  it('rejects a caller-supplied task reference as a documents error', () => {
    try {
      buildPostingDocuments({
        taskDocument,
        submissionFields: { ...submissionFields, task: { name: 'task' } } as never,
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RequesterError);
      expect((err as RequesterError).category).toBe('documents');
      expect((err as RequesterError).code).toBe('task-reference-not-caller-supplied');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/documents.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/documents.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/documents.ts
import {
  SubmissionRecordSchema,
  documentDigest,
  sealSubmission,
  sealTask,
  sha256Hex,
} from '@jinn-network/task-execution-protocol';
import { RequesterError } from './errors.js';

export interface SealedDocument {
  readonly document: unknown;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export interface PostingSubmissionFields {
  readonly submission: `urn:uuid:${string}`;
  readonly requester: string;
  readonly idempotencyKey: string;
  readonly nonce: string;
  readonly deadline: string;
  readonly closeAt?: string;
  readonly attempts?: { readonly maxTotal?: number; readonly maxConcurrent?: number };
  readonly evaluationRequirements?: Record<string, unknown>;
  readonly capabilityGrants?: Record<string, unknown>;
  readonly requirements?: Record<string, unknown>;
  readonly profileParameters?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export interface PostingDocuments {
  readonly task: SealedDocument;
  readonly submission: SealedDocument;
}

/**
 * Seals the Task, then seals a Submission whose `task` reference is derived from the sealed
 * Task bytes. The binding's digest-join check can therefore never be the thing that fails a
 * post — a mismatch would mean this function is wrong, not that the caller passed a bad pair.
 */
export function buildPostingDocuments(input: {
  readonly taskDocument: unknown;
  readonly submissionFields: PostingSubmissionFields;
  readonly taskReferenceName?: string;
}): PostingDocuments {
  if ('task' in (input.submissionFields as Record<string, unknown>)) {
    throw new RequesterError(
      'documents',
      'task-reference-not-caller-supplied',
      'the Submission task reference is derived from the sealed Task bytes; do not supply it',
    );
  }

  let taskBytes: Uint8Array;
  try {
    taskBytes = sealTask(input.taskDocument);
  } catch (err) {
    throw new RequesterError('documents', 'invalid-task-document', String(err), { cause: err });
  }

  const fields = input.submissionFields;
  const document = {
    protocol: 'https://jinn.network/protocols/task-execution/1.0',
    submission: fields.submission,
    task: {
      name: input.taskReferenceName ?? 'task',
      digest: { sha256: sha256Hex(taskBytes) },
    },
    requester: fields.requester,
    idempotencyKey: fields.idempotencyKey,
    nonce: fields.nonce,
    deadline: fields.deadline,
    ...(fields.closeAt === undefined ? {} : { closeAt: fields.closeAt }),
    ...(fields.attempts === undefined ? {} : { attempts: fields.attempts }),
    ...(fields.evaluationRequirements === undefined
      ? {}
      : { evaluationRequirements: fields.evaluationRequirements }),
    ...(fields.capabilityGrants === undefined
      ? {}
      : { capabilityGrants: fields.capabilityGrants }),
    ...(fields.requirements === undefined ? {} : { requirements: fields.requirements }),
    ...(fields.profileParameters === undefined
      ? {}
      : { profileParameters: fields.profileParameters }),
    ...(fields.annotations === undefined ? {} : { annotations: fields.annotations }),
  };

  const validation = SubmissionRecordSchema.safeParse(document);
  if (!validation.success) {
    throw new RequesterError(
      'documents',
      'invalid-submission-document',
      validation.error.message,
      { cause: validation.error },
    );
  }

  const submissionBytes = sealSubmission(document);
  return {
    task: { document: input.taskDocument, bytes: taskBytes, digest: documentDigest(taskBytes) },
    submission: {
      document,
      bytes: submissionBytes,
      digest: documentDigest(submissionBytes),
    },
  };
}
```

Append to `client/src/requester/index.ts`:

```ts
export { buildPostingDocuments } from './documents.js';
export type {
  PostingDocuments,
  PostingSubmissionFields,
  SealedDocument,
} from './documents.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/documents.test.ts test/architecture/requester-module-boundary.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester client/test/requester/documents.test.ts
git commit -m "feat(requester): seal posting documents with a derived task reference"
```

---

### Task 8: The injected port surface and the posting leg

`postSubmission` is the durable-intent posting call. It composes the binding's `postTask` and translates the binding's failures into the requester taxonomy so callers never have to catch two error families.

**Files:**
- Create: `client/src/requester/ports.ts`
- Create: `client/src/requester/posting.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/posting.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 7; `postTask`, `BroadcastUncertainError`, and the types `PostingPorts`, `PostingTerms`, `PostingIntentStore`, `SafeBroadcastPort`, `IpfsPinPort`, `MarketplaceChainConfig`, `MarketplaceLifecyclePorts`, `MarketplaceObservePort`, `SettlementPorts`, `RouterDeliveryFacts` from `@jinn-network/marketplace-binding`.
- Produces:
  - `interface RequesterVenuePorts { ipfs: IpfsPinPort; intents: PostingIntentStore; safe: SafeBroadcastPort; lifecycle: MarketplaceLifecyclePorts; observe: MarketplaceObservePort; listAttemptsForTask(input: { taskId: bigint }): Promise<readonly \`urn:uuid:${string}\`[]>; readDeliveryFacts(input: { requestId: \`0x${string}\`; config: MarketplaceChainConfig }): Promise<RouterDeliveryFacts>; readMechDeliveryFacts: SettlementPorts['readMechDeliveryFacts'] }`
  - `interface PostSubmissionInput { documents: PostingDocuments; terms: PostingTerms; chain: MarketplaceChainConfig; creatorSafe: \`0x${string}\` }`
  - `interface PostedSubmission { taskId: bigint; txHash: \`0x${string}\`; taskDigest: \`sha256:${string}\`; submissionDigest: \`sha256:${string}\`; submission: \`urn:uuid:${string}\` }`
  - `postSubmission(input: PostSubmissionInput, ports: Pick<RequesterVenuePorts, 'ipfs' | 'intents' | 'safe'>): Promise<PostedSubmission>`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/posting.test.ts
import { describe, expect, it } from 'vitest';
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryPostingIntentStore,
} from '@jinn-network/marketplace-binding';
import { RequesterError } from '../../src/requester/errors.js';
import { buildPostingDocuments } from '../../src/requester/documents.js';
import { postSubmission } from '../../src/requester/posting.js';

const documents = buildPostingDocuments({
  taskDocument: {
    protocol: 'https://jinn.network/protocols/task-execution/1.0',
    profile: 'urn:profile:repository-work/1.0#sha256:aa',
    instructions: 'Make the failing test pass.',
    payload: {},
    createdAt: '2026-07-30T00:00:00Z',
  },
  submissionFields: {
    submission: 'urn:uuid:22222222-2222-4222-8222-222222222222',
    requester: 'did:key:zRequester',
    idempotencyKey: 'posting:demo:2',
    nonce: '0x02',
    deadline: '2026-08-01T00:00:00Z',
    attempts: { maxTotal: 2 },
  },
});

const terms = {
  solutionMaxDeliveryRateWei: 100n,
  verdictMaxDeliveryRateWei: 50n,
  responseTimeoutSeconds: 3600n,
  allowSolverSelfEvaluation: false,
};

function ports(overrides: Partial<Parameters<typeof postSubmission>[1]> = {}) {
  const pinned: Uint8Array[] = [];
  const broadcasts: { value: bigint }[] = [];
  return {
    pinned,
    broadcasts,
    ports: {
      ipfs: { pin: async (bytes: Uint8Array) => { pinned.push(bytes); } },
      intents: createInMemoryPostingIntentStore(),
      safe: {
        broadcastCreateTask: async (input: { value: bigint }) => {
          broadcasts.push({ value: input.value });
          return { taskId: 42n, txHash: '0xabc' as `0x${string}` };
        },
      },
      ...overrides,
    } as Parameters<typeof postSubmission>[1],
  };
}

describe('postSubmission', () => {
  it('pins both documents and escrows both rails across every claim slot', async () => {
    const harness = ports();
    const posted = await postSubmission(
      { documents, terms, chain: BASE_SEPOLIA_TODAY, creatorSafe: '0x'.padEnd(42, '1') as `0x${string}` },
      harness.ports,
    );
    expect(posted.taskId).toBe(42n);
    expect(posted.submission).toBe('urn:uuid:22222222-2222-4222-8222-222222222222');
    expect(posted.taskDigest).toBe(documents.task.digest);
    expect(harness.pinned).toHaveLength(2);
    expect(harness.broadcasts[0]!.value).toBe(300n); // (100 + 50) * maxTotal 2
  });

  it('replays idempotently without a second broadcast', async () => {
    const harness = ports();
    const args = {
      documents,
      terms,
      chain: BASE_SEPOLIA_TODAY,
      creatorSafe: '0x'.padEnd(42, '1') as `0x${string}`,
    };
    await postSubmission(args, harness.ports);
    const again = await postSubmission(args, harness.ports);
    expect(again.taskId).toBe(42n);
    expect(harness.broadcasts).toHaveLength(1);
  });

  it('maps a pending intent to a broadcast-uncertain requester error', async () => {
    const intents = createInMemoryPostingIntentStore();
    await intents.claim({
      creatorSafe: '0x'.padEnd(42, '1') as `0x${string}`,
      taskCidDigest: documents.task.digest,
      submissionDigest: documents.submission.digest,
      idempotencyKey: 'posting:demo:2',
      createdAt: '2026-07-30T00:00:00Z',
    });
    const harness = ports({ intents } as never);
    try {
      await postSubmission(
        { documents, terms, chain: BASE_SEPOLIA_TODAY, creatorSafe: '0x'.padEnd(42, '1') as `0x${string}` },
        harness.ports,
      );
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RequesterError);
      expect((err as RequesterError).category).toBe('broadcast');
      expect((err as RequesterError).code).toBe('broadcast-uncertain');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/posting.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/posting.js`.

- [ ] **Step 3: Implement the port surface**

```ts
// client/src/requester/ports.ts
import type {
  IpfsPinPort,
  MarketplaceChainConfig,
  MarketplaceLifecyclePorts,
  MarketplaceObservePort,
  PostingIntentStore,
  RouterDeliveryFacts,
  SafeBroadcastPort,
  SettlementPorts,
} from '@jinn-network/marketplace-binding';

export type AttemptUri = `urn:uuid:${string}`;

/**
 * Every venue capability the requester module consumes, injected by the host. The types are the
 * binding's own port types wherever the binding declares one; the two extra readers exist
 * because the pipeline's `DeliveryWaitPort` is solver-side (it requires a TaskExecutionBackend)
 * and cannot serve requester-side delivery observation.
 */
export interface RequesterVenuePorts {
  readonly ipfs: IpfsPinPort;
  readonly intents: PostingIntentStore;
  readonly safe: SafeBroadcastPort;
  readonly lifecycle: MarketplaceLifecyclePorts;
  readonly observe: MarketplaceObservePort;
  listAttemptsForTask(input: { readonly taskId: bigint }): Promise<readonly AttemptUri[]>;
  readDeliveryFacts(input: {
    readonly requestId: `0x${string}`;
    readonly config: MarketplaceChainConfig;
  }): Promise<RouterDeliveryFacts>;
  readonly readMechDeliveryFacts: SettlementPorts['readMechDeliveryFacts'];
}

export type { MarketplaceChainConfig };
```

- [ ] **Step 4: Implement the posting leg**

```ts
// client/src/requester/posting.ts
import {
  BroadcastUncertainError,
  postTask,
  type MarketplaceChainConfig,
  type PostingTerms,
} from '@jinn-network/marketplace-binding';
import type { PostingDocuments } from './documents.js';
import { RequesterError } from './errors.js';
import type { RequesterVenuePorts } from './ports.js';

export interface PostSubmissionInput {
  readonly documents: PostingDocuments;
  readonly terms: PostingTerms;
  readonly chain: MarketplaceChainConfig;
  readonly creatorSafe: `0x${string}`;
}

export interface PostedSubmission {
  readonly taskId: bigint;
  readonly txHash: `0x${string}`;
  readonly taskDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly submission: `urn:uuid:${string}`;
}

export type PostingLegPorts = Pick<RequesterVenuePorts, 'ipfs' | 'intents' | 'safe'>;

/**
 * The posting leg. Crash-safety, idempotent replay, and the escrow calculation all live in the
 * binding; this wrapper exists to translate the binding's failures into the requester taxonomy
 * and to surface the Submission identity the caller posted under.
 */
export async function postSubmission(
  input: PostSubmissionInput,
  ports: PostingLegPorts,
): Promise<PostedSubmission> {
  const submissionUri = (input.documents.submission.document as { submission: `urn:uuid:${string}` })
    .submission;
  try {
    const outcome = await postTask(
      input.documents.task.bytes,
      input.documents.submission.bytes,
      input.terms,
      input.chain,
      input.creatorSafe,
      { ipfs: ports.ipfs, intents: ports.intents, safe: ports.safe },
    );
    return {
      taskId: outcome.taskId,
      txHash: outcome.txHash,
      taskDigest: input.documents.task.digest,
      submissionDigest: input.documents.submission.digest,
      submission: submissionUri,
    };
  } catch (err) {
    if (err instanceof BroadcastUncertainError) {
      throw new RequesterError('broadcast', 'broadcast-uncertain', err.message, { cause: err });
    }
    if (err instanceof Error && err.message.includes('does not match the provided Task bytes')) {
      throw new RequesterError('documents', 'digest-join-mismatch', err.message, { cause: err });
    }
    throw new RequesterError(
      'broadcast',
      'post-failed',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
}
```

Append to `client/src/requester/index.ts`:

```ts
export { postSubmission } from './posting.js';
export type { PostSubmissionInput, PostedSubmission, PostingLegPorts } from './posting.js';
export type { AttemptUri, RequesterVenuePorts } from './ports.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester && yarn typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/requester client/test/requester/posting.test.ts
git commit -m "feat(requester): add injected venue ports and the durable-intent posting leg"
```

---

### Task 9: `TaskCreated` recovery

A crash between "intent persisted" and "outcome recorded" leaves a pending intent. Recovery asks the chain whether it actually landed; anything still uncertain is returned so the host can raise the §4 state message rather than silently rebroadcasting.

**Files:**
- Create: `client/src/requester/recovery.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/recovery.test.ts`

**Interfaces:**
- Consumes: Task 8; `recoverPostingIntents`, types `PostingIntent`, `PostingIntentStore`, `ScanForOnChainMatch` from `@jinn-network/marketplace-binding`.
- Produces: `interface UncertainPosting { creatorSafe: \`0x${string}\`; taskCidDigest: \`sha256:${string}\`; submissionDigest: \`sha256:${string}\`; idempotencyKey: string; createdAt: string }`; `recoverPendingPostings(ports: { intents: PostingIntentStore; scanForOnChainMatch: ScanForOnChainMatch }): Promise<readonly UncertainPosting[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/recovery.test.ts
import { describe, expect, it } from 'vitest';
import { createInMemoryPostingIntentStore } from '@jinn-network/marketplace-binding';
import { recoverPendingPostings } from '../../src/requester/recovery.js';

const intent = {
  creatorSafe: '0x'.padEnd(42, '1') as `0x${string}`,
  taskCidDigest: `sha256:${'a'.repeat(64)}` as const,
  submissionDigest: `sha256:${'b'.repeat(64)}` as const,
  idempotencyKey: 'posting:recovery:1',
  createdAt: '2026-07-30T00:00:00Z',
};

describe('recoverPendingPostings', () => {
  it('adopts an intent that actually landed on chain', async () => {
    const intents = createInMemoryPostingIntentStore();
    await intents.claim(intent);
    const uncertain = await recoverPendingPostings({
      intents,
      scanForOnChainMatch: async () => ({ taskId: 7n, txHash: '0xdead' as `0x${string}` }),
    });
    expect(uncertain).toEqual([]);
    expect((await intents.lookup(intent))?.resolved).toEqual({ taskId: 7n, txHash: '0xdead' });
  });

  it('returns still-uncertain intents instead of rebroadcasting', async () => {
    const intents = createInMemoryPostingIntentStore();
    await intents.claim(intent);
    const uncertain = await recoverPendingPostings({
      intents,
      scanForOnChainMatch: async () => null,
    });
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]!.idempotencyKey).toBe('posting:recovery:1');
    expect((await intents.lookup(intent))?.resolved).toBeUndefined();
  });

  it('is a no-op when nothing is pending', async () => {
    expect(
      await recoverPendingPostings({
        intents: createInMemoryPostingIntentStore(),
        scanForOnChainMatch: async () => null,
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/recovery.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/recovery.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/recovery.ts
import {
  recoverPostingIntents,
  type PostingIntentStore,
  type ScanForOnChainMatch,
} from '@jinn-network/marketplace-binding';

export interface UncertainPosting {
  readonly creatorSafe: `0x${string}`;
  readonly taskCidDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/**
 * Boot-time posting recovery: every pending intent is checked against the chain. A match is
 * adopted idempotently; a miss is returned, never retried here — the host raises the
 * unreleased/uncertain state message so the operator sees it.
 */
export async function recoverPendingPostings(ports: {
  readonly intents: PostingIntentStore;
  readonly scanForOnChainMatch: ScanForOnChainMatch;
}): Promise<readonly UncertainPosting[]> {
  const uncertain = await recoverPostingIntents(ports.intents, ports.scanForOnChainMatch);
  return uncertain.map((intent) => ({
    creatorSafe: intent.creatorSafe,
    taskCidDigest: intent.taskCidDigest,
    submissionDigest: intent.submissionDigest,
    idempotencyKey: intent.idempotencyKey,
    createdAt: intent.createdAt,
  }));
}
```

Append to `client/src/requester/index.ts`:

```ts
export { recoverPendingPostings } from './recovery.js';
export type { UncertainPosting } from './recovery.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/recovery.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester client/test/requester/recovery.test.ts
git commit -m "feat(requester): recover pending posting intents against the chain"
```

---

### Task 10: Requester-side delivery observation

**Files:**
- Create: `client/src/requester/delivery.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/delivery.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 8; `inspectDelivery` is *not* exported by the binding, so parsing uses `DeliveryRecordSchema` from `@jinn-network/task-execution-protocol`.
- Produces:
  - `interface ObservedDelivery { attempt: AttemptUri; deliveryBytes: Uint8Array; delivery: DeliveryRecord; digest: \`sha256:${string}\` }`
  - `awaitDeliveries(input: { taskId: bigint; timeoutMs: number; pollIntervalMs?: number; signal?: AbortSignal }, ports: Pick<RequesterVenuePorts, 'observe' | 'listAttemptsForTask'>, clock?: { now(): number; sleep(ms: number): Promise<void> }): Promise<readonly ObservedDelivery[]>` — resolves as soon as at least one delivery exists; returns an empty array on timeout; throws `RequesterError('delivery','cancelled')` when the signal aborts and `RequesterError('delivery','invalid-delivery')` when the fetched bytes do not parse.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/delivery.test.ts
import { describe, expect, it } from 'vitest';
import { RequesterError } from '../../src/requester/errors.js';
import { awaitDeliveries } from '../../src/requester/delivery.js';

const attempt = 'urn:uuid:33333333-3333-4333-8333-333333333333' as const;
const deliveryDocument = {
  protocol: 'https://jinn.network/protocols/task-execution/1.0',
  attempt,
  task: `sha256:${'a'.repeat(64)}`,
  outputs: [{ name: 'patch', digest: { sha256: 'c'.repeat(64) } }],
  outcome: 'fulfilled',
  evidenceRecords: [{ family: 'execution-evidence', digest: `sha256:${'d'.repeat(64)}` }],
  createdAt: '2026-07-30T01:00:00Z',
};
const deliveryBytes = new TextEncoder().encode(JSON.stringify(deliveryDocument));

const clock = { now: () => 0, sleep: async () => {} };

describe('awaitDeliveries', () => {
  it('returns parsed deliveries for every attempt on the task', async () => {
    const observed = await awaitDeliveries(
      { taskId: 42n, timeoutMs: 1_000 },
      {
        listAttemptsForTask: async () => [attempt],
        observe: {
          deliveries: async () => [{ attempt, digest: `sha256:${'e'.repeat(64)}` as const }],
          fetchDelivery: async () => deliveryBytes,
        } as never,
      },
      clock,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]!.delivery.outcome).toBe('fulfilled');
    expect(observed[0]!.attempt).toBe(attempt);
  });

  it('returns an empty array when the deadline passes with no delivery', async () => {
    let tick = 0;
    const observed = await awaitDeliveries(
      { taskId: 42n, timeoutMs: 10, pollIntervalMs: 5 },
      {
        listAttemptsForTask: async () => [attempt],
        observe: { deliveries: async () => [], fetchDelivery: async () => deliveryBytes } as never,
      },
      { now: () => (tick += 6), sleep: async () => {} },
    );
    expect(observed).toEqual([]);
  });

  it('rejects unparseable delivery bytes', async () => {
    try {
      await awaitDeliveries(
        { taskId: 42n, timeoutMs: 1_000 },
        {
          listAttemptsForTask: async () => [attempt],
          observe: {
            deliveries: async () => [{ attempt, digest: `sha256:${'e'.repeat(64)}` as const }],
            fetchDelivery: async () => new TextEncoder().encode('not json'),
          } as never,
        },
        clock,
      );
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).category).toBe('delivery');
      expect((err as RequesterError).code).toBe('invalid-delivery');
    }
  });

  it('honors an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      awaitDeliveries(
        { taskId: 42n, timeoutMs: 1_000, signal: controller.signal },
        {
          listAttemptsForTask: async () => [attempt],
          observe: { deliveries: async () => [], fetchDelivery: async () => deliveryBytes } as never,
        },
        clock,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/delivery.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/delivery.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/delivery.ts
import { DeliveryRecordSchema, type DeliveryRecord } from '@jinn-network/task-execution-protocol';
import { RequesterError } from './errors.js';
import type { AttemptUri, RequesterVenuePorts } from './ports.js';

export interface ObservedDelivery {
  readonly attempt: AttemptUri;
  readonly deliveryBytes: Uint8Array;
  readonly delivery: DeliveryRecord;
  readonly digest: `sha256:${string}`;
}

export interface RequesterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const DEFAULT_CLOCK: RequesterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type DeliveryObservationPorts = Pick<
  RequesterVenuePorts,
  'observe' | 'listAttemptsForTask'
>;

/**
 * Requester-side delivery observation. The pipeline's `DeliveryWaitPort` is solver-side (it
 * takes a TaskExecutionBackend), so the requester polls the projector-backed observe port
 * instead. Returns as soon as at least one delivery is visible; an empty array means the
 * deadline passed with none.
 */
export async function awaitDeliveries(
  input: {
    readonly taskId: bigint;
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly signal?: AbortSignal;
  },
  ports: DeliveryObservationPorts,
  clock: RequesterClock = DEFAULT_CLOCK,
): Promise<readonly ObservedDelivery[]> {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  const deadline = clock.now() + input.timeoutMs;

  for (;;) {
    if (input.signal?.aborted) {
      throw new RequesterError(
        'delivery',
        'cancelled',
        `delivery wait for task ${input.taskId} was cancelled`,
      );
    }
    const attempts = await ports.listAttemptsForTask({ taskId: input.taskId });
    const observed: ObservedDelivery[] = [];
    for (const attempt of attempts) {
      // eslint-disable-next-line no-await-in-loop -- attempt counts are small and bounded by maxClaims.
      const refs = await ports.observe.deliveries(attempt);
      for (const ref of refs) {
        // eslint-disable-next-line no-await-in-loop -- sequential fetch keeps gateway pressure bounded.
        const deliveryBytes = await ports.observe.fetchDelivery(ref);
        observed.push({
          attempt,
          deliveryBytes,
          delivery: parseDelivery(deliveryBytes, attempt),
          digest: ref.digest,
        });
      }
    }
    if (observed.length > 0) return observed;
    if (clock.now() >= deadline) return [];
    await clock.sleep(pollIntervalMs);
  }
}

function parseDelivery(bytes: Uint8Array, attempt: AttemptUri): DeliveryRecord {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    throw new RequesterError(
      'delivery',
      'invalid-delivery',
      `delivery bytes for ${attempt} are not valid UTF-8 JSON`,
      { cause: err },
    );
  }
  const parsed = DeliveryRecordSchema.safeParse(document);
  if (!parsed.success) {
    throw new RequesterError(
      'delivery',
      'invalid-delivery',
      `delivery for ${attempt} is not a valid Delivery record: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
```

Append to `client/src/requester/index.ts`:

```ts
export { awaitDeliveries } from './delivery.js';
export type {
  DeliveryObservationPorts,
  ObservedDelivery,
  RequesterClock,
} from './delivery.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/delivery.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester client/test/requester/delivery.test.ts
git commit -m "feat(requester): observe deliveries for the operator's own tasks"
```

---

### Task 11: Requester-side adoption

The carve table gives `AWAITING_ADOPTION` and `CLAIMING_DELIVERY` to the `application` owner (`packages/marketplace/pipeline/src/carve.ts:21-22`); this host is that owner. Adoption is: verify the observed Delivery corresponds to what the chain anchored, then record an accept/reject decision and hand it to an injected receipt sink. The sink is a port because the only receipt machinery in the tree today is product-specific (Autopilot's GitHub receipt); a product-shaped receipt must never enter this module.

**Files:**
- Create: `client/src/requester/adoption.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/adoption.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 8, 10; `checkDeliveryCorrespondence`, `keccakEvidenceHash`, `rejectZeroEvidenceHash`, `ZeroEvidenceHashError` from `@jinn-network/marketplace-binding`.
- Produces:
  - `interface AdoptionDecision { attempt: AttemptUri; taskId: bigint; disposition: 'accepted' | 'rejected'; reason?: string; deliveryDigest: \`sha256:${string}\`; decidedAt: string }`
  - `interface AdoptionReceiptSink { publish(decision: AdoptionDecision): Promise<void> }`
  - `adoptDelivery(input: { taskId: bigint; requestId: \`0x${string}\`; observed: ObservedDelivery; chain: MarketplaceChainConfig; accept: (observed: ObservedDelivery) => Promise<{ accepted: boolean; reason?: string }>; now?: () => Date }, ports: Pick<RequesterVenuePorts, 'readDeliveryFacts' | 'readMechDeliveryFacts'> & { receipts: AdoptionReceiptSink }): Promise<AdoptionDecision>`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/adoption.test.ts
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_TODAY, keccakEvidenceHash } from '@jinn-network/marketplace-binding';
import { RequesterError } from '../../src/requester/errors.js';
import { adoptDelivery } from '../../src/requester/adoption.js';

const attempt = 'urn:uuid:44444444-4444-4444-8444-444444444444' as const;
const deliveryBytes = new TextEncoder().encode('{"delivery":"bytes"}');
const observed = {
  attempt,
  deliveryBytes,
  digest: `sha256:${'f'.repeat(64)}` as const,
  delivery: {
    protocol: 'https://jinn.network/protocols/task-execution/1.0',
    attempt,
    task: `sha256:${'a'.repeat(64)}`,
    outputs: [],
    outcome: 'fulfilled' as const,
    createdAt: '2026-07-30T01:00:00Z',
  },
};

function ports(overrides: Record<string, unknown> = {}) {
  const published: unknown[] = [];
  return {
    published,
    ports: {
      readMechDeliveryFacts: async () => ({
        requestId: '0xreq' as `0x${string}`,
        sha256CidDigest: observed.digest,
      }),
      readDeliveryFacts: async () => ({
        generation: 'today' as const,
        requestId: '0xreq' as `0x${string}`,
        keccakEvidenceHash: keccakEvidenceHash(deliveryBytes),
      }),
      receipts: { publish: async (decision: unknown) => { published.push(decision); } },
      ...overrides,
    } as Parameters<typeof adoptDelivery>[1],
  };
}

const base = {
  taskId: 9n,
  requestId: '0xreq' as `0x${string}`,
  observed,
  chain: BASE_SEPOLIA_TODAY,
  now: () => new Date('2026-07-30T02:00:00Z'),
};

describe('adoptDelivery', () => {
  it('accepts and publishes the receipt when correspondence holds', async () => {
    const harness = ports();
    const decision = await adoptDelivery(
      { ...base, accept: async () => ({ accepted: true }) },
      harness.ports,
    );
    expect(decision.disposition).toBe('accepted');
    expect(decision.decidedAt).toBe('2026-07-30T02:00:00.000Z');
    expect(harness.published).toEqual([decision]);
  });

  it('records the operator reason on a rejection', async () => {
    const harness = ports();
    const decision = await adoptDelivery(
      { ...base, accept: async () => ({ accepted: false, reason: 'tests still fail' }) },
      harness.ports,
    );
    expect(decision).toMatchObject({ disposition: 'rejected', reason: 'tests still fail' });
    expect(harness.published).toHaveLength(1);
  });

  it('refuses to decide when the chain anchors different bytes', async () => {
    const harness = ports({
      readDeliveryFacts: async () => ({
        generation: 'today' as const,
        requestId: '0xreq' as `0x${string}`,
        keccakEvidenceHash: `0x${'1'.repeat(64)}` as `0x${string}`,
      }),
    });
    try {
      await adoptDelivery({ ...base, accept: async () => ({ accepted: true }) }, harness.ports);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).category).toBe('adoption');
      expect((err as RequesterError).code).toBe('digest-divergence');
    }
    expect(harness.published).toEqual([]);
  });

  it('rejects an all-zero evidence hash before deciding', async () => {
    const harness = ports({
      readDeliveryFacts: async () => ({
        generation: 'today' as const,
        requestId: '0xreq' as `0x${string}`,
        keccakEvidenceHash: `0x${'0'.repeat(64)}` as `0x${string}`,
      }),
    });
    await expect(
      adoptDelivery({ ...base, accept: async () => ({ accepted: true }) }, harness.ports),
    ).rejects.toMatchObject({ code: 'zero-evidence-hash' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/adoption.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/adoption.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/adoption.ts
import {
  ZeroEvidenceHashError,
  checkDeliveryCorrespondence,
  keccakEvidenceHash,
  rejectZeroEvidenceHash,
  type MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import type { ObservedDelivery } from './delivery.js';
import { RequesterError } from './errors.js';
import type { AttemptUri, RequesterVenuePorts } from './ports.js';

export interface AdoptionDecision {
  readonly attempt: AttemptUri;
  readonly taskId: bigint;
  readonly disposition: 'accepted' | 'rejected';
  readonly reason?: string;
  readonly deliveryDigest: `sha256:${string}`;
  readonly decidedAt: string;
}

/**
 * Where an adoption decision is published. Deliberately a port: the only receipt machinery in
 * the tree today is product-specific (Autopilot's GitHub receipt), and a product-shaped receipt
 * must not enter this module.
 */
export interface AdoptionReceiptSink {
  publish(decision: AdoptionDecision): Promise<void>;
}

export type AdoptionPorts = Pick<
  RequesterVenuePorts,
  'readDeliveryFacts' | 'readMechDeliveryFacts'
> & { readonly receipts: AdoptionReceiptSink };

/**
 * Requester-side adoption: the correspondence join is checked against chain facts BEFORE the
 * operator's accept callback runs, so an operator never adopts bytes the venue did not anchor.
 */
export async function adoptDelivery(
  input: {
    readonly taskId: bigint;
    readonly requestId: `0x${string}`;
    readonly observed: ObservedDelivery;
    readonly chain: MarketplaceChainConfig;
    accept(observed: ObservedDelivery): Promise<{ accepted: boolean; reason?: string }>;
    now?: () => Date;
  },
  ports: AdoptionPorts,
): Promise<AdoptionDecision> {
  const mech = await ports.readMechDeliveryFacts({
    requestId: input.requestId,
    config: input.chain,
  });
  const router = await ports.readDeliveryFacts({
    requestId: input.requestId,
    config: input.chain,
  });
  if (router.generation !== 'today') {
    throw new RequesterError(
      'adoption',
      'unsupported-generation',
      `requester-side adoption supports the today generation only, got ${router.generation}`,
    );
  }
  try {
    rejectZeroEvidenceHash(router.keccakEvidenceHash);
  } catch (err) {
    if (err instanceof ZeroEvidenceHashError) {
      throw new RequesterError('adoption', 'zero-evidence-hash', err.message, { cause: err });
    }
    throw err;
  }

  const correspondence = checkDeliveryCorrespondence({
    sha256Digest: input.observed.digest,
    keccakEvidenceHash: keccakEvidenceHash(input.observed.deliveryBytes),
    onChainSha256CidDigest: mech.sha256CidDigest,
    onChainKeccak: router.keccakEvidenceHash,
  });
  if (!correspondence.ok) {
    throw new RequesterError(
      'adoption',
      'digest-divergence',
      `delivery for ${input.observed.attempt} does not correspond to the anchored facts: `
      + `asserted ${correspondence.asserted.sha256Digest}/${correspondence.asserted.keccakEvidenceHash}, `
      + `on chain ${correspondence.onChain.sha256CidDigest}/${correspondence.onChain.keccak}`,
    );
  }

  const verdict = await input.accept(input.observed);
  const decision: AdoptionDecision = {
    attempt: input.observed.attempt,
    taskId: input.taskId,
    disposition: verdict.accepted ? 'accepted' : 'rejected',
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    deliveryDigest: input.observed.digest,
    decidedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  await ports.receipts.publish(decision);
  return decision;
}
```

Append to `client/src/requester/index.ts`:

```ts
export { adoptDelivery } from './adoption.js';
export type { AdoptionDecision, AdoptionPorts, AdoptionReceiptSink } from './adoption.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/adoption.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester client/test/requester/adoption.test.ts
git commit -m "feat(requester): adopt deliveries for the operator's own tasks"
```

---

### Task 12: Requester-side evaluation Submission sealing

This closes program cross-plan contract 5. The binding refuses evaluator-side sealing for anything but a fully public, grant-free evaluation (`packages/marketplace/binding/src/evaluation-derive.ts:87-97`); requester-side sealing is what lifts that restriction, and it can only apply to Submissions this operator posted — the derivation requires the subject Submission to carry an admission-receipt descriptor (`evaluation-derive.ts:72-85`), which bridge-era legacy-posted tasks do not have.

**Files:**
- Create: `client/src/requester/evaluation.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/evaluation.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 7, 8; `ADMISSION_RECEIPT_ANNOTATION_URI`, `deriveAndSealEvaluationSubmission`, types `DeriveAndSealEvaluationSubmissionInput`, `DerivedEvaluationSubmission` from `@jinn-network/marketplace-binding`.
- Produces:
  - `interface SealEvaluationSubmissionInput { subject: { task: { name: string; digest: \`sha256:${string}\` }; delivery: { name: string; digest: \`sha256:${string}\` }; results: readonly { name: string; digest: \`sha256:${string}\` }[]; submission: SubmissionRecord }; evaluationSpecDigest: \`sha256:${string}\`; submissionFields: EvaluationSubmissionFields; capabilityGrants: Record<string, unknown>; publicSpec: boolean }`
  - `sealEvaluationSubmissionForOwnTask(input: SealEvaluationSubmissionInput): DerivedEvaluationSubmission` — always `sealerRole: 'requester'`; throws `RequesterError('documents', 'not-own-submission' | 'missing-admission-receipt' | 'evaluation-seal-failed')`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/evaluation.test.ts
import { describe, expect, it } from 'vitest';
import { ADMISSION_RECEIPT_ANNOTATION_URI } from '@jinn-network/marketplace-binding';
import { RequesterError } from '../../src/requester/errors.js';
import { sealEvaluationSubmissionForOwnTask } from '../../src/requester/evaluation.js';

const taskDigest = `sha256:${'a'.repeat(64)}` as const;
const subjectSubmission = {
  protocol: 'https://jinn.network/protocols/task-execution/1.0',
  submission: 'urn:uuid:55555555-5555-4555-8555-555555555555',
  task: { name: 'task', digest: { sha256: 'a'.repeat(64) } },
  requester: 'did:key:zRequester',
  idempotencyKey: 'posting:demo:5',
  nonce: '0x05',
  deadline: '2026-08-01T00:00:00Z',
  annotations: {
    [ADMISSION_RECEIPT_ANNOTATION_URI]: {
      name: 'admission-receipt',
      digest: { sha256: 'b'.repeat(64) },
    },
  },
};

const input = {
  subject: {
    task: { name: 'subject-task', digest: taskDigest },
    delivery: { name: 'subject-delivery', digest: `sha256:${'c'.repeat(64)}` as const },
    results: [{ name: 'result-0', digest: `sha256:${'d'.repeat(64)}` as const }],
    submission: subjectSubmission,
  },
  evaluationSpecDigest: `sha256:${'e'.repeat(64)}` as const,
  submissionFields: {
    submission: 'urn:uuid:66666666-6666-4666-8666-666666666666',
    requester: 'did:key:zRequester',
    idempotencyKey: 'evaluation:demo:1',
    nonce: '0x06',
    deadline: '2026-08-02T00:00:00Z',
  },
  capabilityGrants: { 'urn:grant:private-tests': { token: 'redacted' } },
  publicSpec: false,
};

describe('sealEvaluationSubmissionForOwnTask', () => {
  it('seals a private-spec evaluation Submission with capability grants', () => {
    const sealed = sealEvaluationSubmissionForOwnTask(input);
    expect(sealed.submission.digest.startsWith('sha256:')).toBe(true);
    expect((sealed.submission.document as Record<string, unknown>)['capabilityGrants']).toEqual(
      input.capabilityGrants,
    );
    expect(sealed.task.digest.startsWith('sha256:')).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    expect(sealEvaluationSubmissionForOwnTask(input).submission.digest).toBe(
      sealEvaluationSubmissionForOwnTask(input).submission.digest,
    );
  });

  it('refuses a subject Submission this operator did not request', () => {
    try {
      sealEvaluationSubmissionForOwnTask({
        ...input,
        submissionFields: { ...input.submissionFields, requester: 'did:key:zSomeoneElse' },
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).category).toBe('documents');
      expect((err as RequesterError).code).toBe('not-own-submission');
    }
  });

  it('names the bridge-era gap when the subject carries no admission receipt', () => {
    const { annotations: _dropped, ...bare } = subjectSubmission;
    try {
      sealEvaluationSubmissionForOwnTask({
        ...input,
        subject: { ...input.subject, submission: bare as never },
      });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as RequesterError).code).toBe('missing-admission-receipt');
      expect((err as RequesterError).message).toContain('legacy-posted');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/evaluation.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/evaluation.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/evaluation.ts
import {
  ADMISSION_RECEIPT_ANNOTATION_URI,
  deriveAndSealEvaluationSubmission,
  type DerivedEvaluationSubmission,
  type EvaluationSubmissionFields,
} from '@jinn-network/marketplace-binding';
import type { SubmissionRecord } from '@jinn-network/task-execution-protocol';
import { RequesterError } from './errors.js';

export interface EvaluationSubjectRef {
  readonly name: string;
  readonly digest: `sha256:${string}`;
}

export interface SealEvaluationSubmissionInput {
  readonly subject: {
    readonly task: EvaluationSubjectRef;
    readonly delivery: EvaluationSubjectRef;
    readonly results: readonly EvaluationSubjectRef[];
    readonly submission: SubmissionRecord;
  };
  readonly evaluationSpecDigest: `sha256:${string}`;
  readonly submissionFields: EvaluationSubmissionFields;
  readonly capabilityGrants: Record<string, unknown>;
  readonly publicSpec: boolean;
}

/**
 * Requester-side evaluation Submission sealing — the default for private test material under
 * capability grants, and the close of the binding's evaluator-seals carve-out. It is only
 * available for Submissions this operator posted: the derivation requires the subject
 * Submission's admission-receipt descriptor, which bridge-era legacy-posted tasks lack.
 */
export function sealEvaluationSubmissionForOwnTask(
  input: SealEvaluationSubmissionInput,
): DerivedEvaluationSubmission {
  if (input.submissionFields.requester !== input.subject.submission.requester) {
    throw new RequesterError(
      'documents',
      'not-own-submission',
      `requester-side evaluation sealing requires the subject Submission's requester `
      + `(${input.subject.submission.requester}), got ${input.submissionFields.requester}`,
    );
  }
  if (input.subject.submission.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI] === undefined) {
    throw new RequesterError(
      'documents',
      'missing-admission-receipt',
      'the subject Submission carries no admission-receipt descriptor; legacy-posted (bridge-era) '
      + 'tasks cannot use requester-side evaluation sealing — they stay on the evaluator-seals '
      + 'carve-out until they drain',
    );
  }
  try {
    return deriveAndSealEvaluationSubmission({
      subjectTask: input.subject.task,
      subjectDelivery: input.subject.delivery,
      subjectResults: [...input.subject.results],
      evaluationSpecDigest: input.evaluationSpecDigest,
      subjectSubmission: input.subject.submission,
      submissionFields: input.submissionFields,
      capabilityGrants: input.capabilityGrants,
      publicSpec: input.publicSpec,
      sealerRole: 'requester',
    });
  } catch (err) {
    throw new RequesterError(
      'documents',
      'evaluation-seal-failed',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
}
```

Append to `client/src/requester/index.ts`:

```ts
export { sealEvaluationSubmissionForOwnTask } from './evaluation.js';
export type {
  EvaluationSubjectRef,
  SealEvaluationSubmissionInput,
} from './evaluation.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/requester/evaluation.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester client/test/requester/evaluation.test.ts
git commit -m "feat(requester): seal evaluation Submissions requester-side"
```

---

### Task 13: Lifecycle exits and evidence handles

Today-mode has no on-venue release (`packages/marketplace/binding/src/lifecycle.ts:17`), so `releaseAttempt` returns `'unsupported'` rather than pretending. The host renders that as the §4 unreleased-attempt state message.

**Files:**
- Create: `client/src/requester/lifecycle.ts`
- Create: `client/src/requester/evidence.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/lifecycle.test.ts`
- Test: `client/test/requester/evidence.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 8, 10; `closeSubmission`, `releaseAttempt as bindingReleaseAttempt`, `signalCancel` from `@jinn-network/marketplace-binding`.
- Produces:
  - `closePosting(input: { taskId: bigint; chain: MarketplaceChainConfig }, ports: Pick<RequesterVenuePorts, 'lifecycle'>): Promise<void>`
  - `cancelAttempt(input: { attempt: AttemptUri; taskId: bigint; attemptIndex: number; reason: string }, ports: Pick<RequesterVenuePorts, 'lifecycle'>): Promise<'requested' | 'already-requested'>`
  - `releasePostedAttempt(input: { taskId: bigint; attemptIndex: number; chain: MarketplaceChainConfig }, ports: Pick<RequesterVenuePorts, 'lifecycle'>): Promise<'released' | 'unsupported'>`
  - `interface EvidenceHandles { outputs: readonly ResourceDescriptor[]; evidenceRecords: readonly EvidenceRecordReference[]; executionIds: readonly string[]; deliveryDigest: \`sha256:${string}\` }`; `evidenceHandlesFor(observed: ObservedDelivery): EvidenceHandles`

- [ ] **Step 1: Write the failing lifecycle test**

```ts
// client/test/requester/lifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  cancelAttempt,
  closePosting,
  releasePostedAttempt,
} from '../../src/requester/lifecycle.js';

function lifecycle(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      lifecycle: {
        resolveAttempt: async () => ({ taskId: 1n, attemptIndex: 0 }),
        requestCancel: async () => { calls.push('requestCancel'); return 'requested' as const; },
        withdrawAnnouncement: async () => { calls.push('withdrawAnnouncement'); },
        refundUnusedTaskBudget: async () => { calls.push('refundUnusedTaskBudget'); },
        ...overrides,
      },
    } as never,
  };
}

describe('requester lifecycle exits', () => {
  it('closes a today-generation posting by refunding then withdrawing', async () => {
    const harness = lifecycle();
    await closePosting({ taskId: 1n, chain: BASE_SEPOLIA_TODAY }, harness.ports);
    expect(harness.calls).toEqual(['refundUnusedTaskBudget', 'withdrawAnnouncement']);
  });

  it('signals cancellation idempotently', async () => {
    const harness = lifecycle({ requestCancel: async () => 'already-requested' as const });
    expect(
      await cancelAttempt(
        {
          attempt: 'urn:uuid:77777777-7777-4777-8777-777777777777',
          taskId: 1n,
          attemptIndex: 0,
          reason: 'superseded',
        },
        harness.ports,
      ),
    ).toBe('already-requested');
  });

  it('reports today-mode release as unsupported instead of pretending', async () => {
    const harness = lifecycle();
    expect(
      await releasePostedAttempt(
        { taskId: 1n, attemptIndex: 0, chain: BASE_SEPOLIA_TODAY },
        harness.ports,
      ),
    ).toBe('unsupported');
  });

  it('releases on the revised generation', async () => {
    const harness = lifecycle({ releaseAttempt: async () => {} });
    expect(
      await releasePostedAttempt(
        { taskId: 1n, attemptIndex: 0, chain: { ...BASE_SEPOLIA_TODAY, generation: 'revised' } },
        harness.ports,
      ),
    ).toBe('released');
  });
});
```

- [ ] **Step 2: Write the failing evidence test**

```ts
// client/test/requester/evidence.test.ts
import { describe, expect, it } from 'vitest';
import { evidenceHandlesFor } from '../../src/requester/evidence.js';

const attempt = 'urn:uuid:88888888-8888-4888-8888-888888888888' as const;

describe('evidenceHandlesFor', () => {
  it('lifts outputs, evidence references and execution ids off the Delivery', () => {
    const handles = evidenceHandlesFor({
      attempt,
      deliveryBytes: new Uint8Array(),
      digest: `sha256:${'9'.repeat(64)}`,
      delivery: {
        protocol: 'https://jinn.network/protocols/task-execution/1.0',
        attempt,
        task: `sha256:${'a'.repeat(64)}`,
        outputs: [{ name: 'patch', digest: { sha256: 'c'.repeat(64) } }],
        outcome: 'fulfilled',
        executionIds: [attempt],
        evidenceRecords: [{ family: 'execution-evidence', digest: `sha256:${'d'.repeat(64)}` }],
        createdAt: '2026-07-30T01:00:00Z',
      },
    });
    expect(handles.outputs).toHaveLength(1);
    expect(handles.evidenceRecords[0]!.family).toBe('execution-evidence');
    expect(handles.executionIds).toEqual([attempt]);
    expect(handles.deliveryDigest).toBe(`sha256:${'9'.repeat(64)}`);
  });

  it('returns empty collections when the Delivery declares none', () => {
    const handles = evidenceHandlesFor({
      attempt,
      deliveryBytes: new Uint8Array(),
      digest: `sha256:${'9'.repeat(64)}`,
      delivery: {
        protocol: 'https://jinn.network/protocols/task-execution/1.0',
        attempt,
        task: `sha256:${'a'.repeat(64)}`,
        outputs: [],
        outcome: 'fulfilled',
        createdAt: '2026-07-30T01:00:00Z',
      },
    });
    expect(handles.evidenceRecords).toEqual([]);
    expect(handles.executionIds).toEqual([]);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd client && yarn vitest run test/requester/lifecycle.test.ts test/requester/evidence.test.ts`
Expected: FAIL — cannot resolve either new module.

- [ ] **Step 4: Implement both**

```ts
// client/src/requester/lifecycle.ts
import {
  closeSubmission,
  releaseAttempt as bindingReleaseAttempt,
  signalCancel,
  type MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import { RequesterError } from './errors.js';
import type { AttemptUri, RequesterVenuePorts } from './ports.js';

export type LifecyclePorts = Pick<RequesterVenuePorts, 'lifecycle'>;

/** Refund (today) or close (revised), then withdraw the announcement. */
export async function closePosting(
  input: { readonly taskId: bigint; readonly chain: MarketplaceChainConfig },
  ports: LifecyclePorts,
): Promise<void> {
  try {
    await closeSubmission(input.taskId, input.chain, ports.lifecycle);
  } catch (err) {
    throw new RequesterError(
      'settlement',
      'close-failed',
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
}

/** A durable, idempotent requester signal; it never revokes a live attempt. */
export async function cancelAttempt(
  input: {
    readonly attempt: AttemptUri;
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly reason: string;
  },
  ports: LifecyclePorts,
): Promise<'requested' | 'already-requested'> {
  return signalCancel(
    input.attempt,
    input.taskId,
    input.attemptIndex,
    input.reason,
    ports.lifecycle,
  );
}

/**
 * Today-mode has no on-venue release: the attempt occupies its claim slot until the revised
 * generation's deadline reap. `'unsupported'` is the honest answer the host surfaces as the
 * unreleased-attempt state message (design §4).
 */
export async function releasePostedAttempt(
  input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly chain: MarketplaceChainConfig;
  },
  ports: LifecyclePorts,
): Promise<'released' | 'unsupported'> {
  const outcome = await bindingReleaseAttempt(
    input.taskId,
    input.attemptIndex,
    input.chain,
    ports.lifecycle,
  );
  return outcome !== undefined && outcome.ok === false ? 'unsupported' : 'released';
}
```

```ts
// client/src/requester/evidence.ts
import type {
  EvidenceRecordReference,
  ResourceDescriptor,
} from '@jinn-network/task-execution-protocol';
import type { ObservedDelivery } from './delivery.js';

export interface EvidenceHandles {
  readonly outputs: readonly ResourceDescriptor[];
  readonly evidenceRecords: readonly EvidenceRecordReference[];
  readonly executionIds: readonly string[];
  readonly deliveryDigest: `sha256:${string}`;
}

/**
 * Handles, not content: the requester hands back digest-addressed references so a consumer can
 * retrieve exact bytes through the evidence-retrieval primitives. This module never fetches,
 * publishes, or announces anything (evidence publication policy, program contract 6).
 */
export function evidenceHandlesFor(observed: ObservedDelivery): EvidenceHandles {
  return {
    outputs: observed.delivery.outputs as readonly ResourceDescriptor[],
    evidenceRecords: (observed.delivery.evidenceRecords ?? []) as readonly EvidenceRecordReference[],
    executionIds: observed.delivery.executionIds ?? [],
    deliveryDigest: observed.digest,
  };
}
```

Append to `client/src/requester/index.ts`:

```ts
export { cancelAttempt, closePosting, releasePostedAttempt } from './lifecycle.js';
export type { LifecyclePorts } from './lifecycle.js';
export { evidenceHandlesFor } from './evidence.js';
export type { EvidenceHandles } from './evidence.js';
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `cd client && yarn vitest run test/requester && yarn typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/requester client/test/requester/lifecycle.test.ts client/test/requester/evidence.test.ts
git commit -m "feat(requester): add lifecycle exits and evidence handles"
```

---

### Task 14: The work-client facade

The single composed surface: *post this Submission, await the delivery, adopt, settle, hand me the evidence*. This is what the marketplace-surfaces session packages as `packages/marketplace/work-client`, so its shape is the deliverable, not an internal convenience.

**Files:**
- Create: `client/src/requester/work-client.ts`
- Modify: `client/src/requester/index.ts`
- Test: `client/test/requester/work-client.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3–13.
- Produces:
  - `interface WorkClientConfig { chain: MarketplaceChainConfig; creatorSafe: \`0x${string}\`; requester: string }`
  - `interface WorkClientPorts extends RequesterVenuePorts { receipts: AdoptionReceiptSink }`
  - `interface PostWorkInput { taskDocument: unknown; submissionFields: PostingSubmissionFields; terms: PostingTerms; preflight: PostingPreflightChecks }`
  - `interface WorkClient { post(input: PostWorkInput): Promise<{ posted: PostedSubmission; preflight: readonly PostingPreflightEntry[] }>; recoverPending(scanForOnChainMatch: ScanForOnChainMatch): Promise<readonly UncertainPosting[]>; awaitDeliveries(input: { taskId: bigint; timeoutMs: number; pollIntervalMs?: number; signal?: AbortSignal }): Promise<readonly ObservedDelivery[]>; adopt(input: { taskId: bigint; requestId: \`0x${string}\`; observed: ObservedDelivery; accept: (observed: ObservedDelivery) => Promise<{ accepted: boolean; reason?: string }> }): Promise<AdoptionDecision>; sealEvaluationSubmission(input: SealEvaluationSubmissionInput): DerivedEvaluationSubmission; close(input: { taskId: bigint }): Promise<void>; cancel(input: { attempt: AttemptUri; taskId: bigint; attemptIndex: number; reason: string }): Promise<'requested' | 'already-requested'>; release(input: { taskId: bigint; attemptIndex: number }): Promise<'released' | 'unsupported'>; evidenceHandles(observed: ObservedDelivery): EvidenceHandles }`
  - `createWorkClient(config: WorkClientConfig, ports: WorkClientPorts, clock?: RequesterClock): WorkClient`

- [ ] **Step 1: Write the failing test**

```ts
// client/test/requester/work-client.test.ts
import { describe, expect, it } from 'vitest';
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryPostingIntentStore,
} from '@jinn-network/marketplace-binding';
import { POSTING_PREFLIGHT_CATEGORIES } from '../../src/requester/preflight/index.js';
import { createWorkClient } from '../../src/requester/work-client.js';

const creatorSafe = '0x'.padEnd(42, '1') as `0x${string}`;

function okChecks(seen: string[]) {
  return Object.fromEntries(
    POSTING_PREFLIGHT_CATEGORIES.map((category) => [
      category,
      async () => { seen.push(category); },
    ]),
  ) as never;
}

function client(seen: string[] = []) {
  return createWorkClient(
    { chain: BASE_SEPOLIA_TODAY, creatorSafe, requester: 'did:key:zRequester' },
    {
      ipfs: { pin: async () => {} },
      intents: createInMemoryPostingIntentStore(),
      safe: {
        broadcastCreateTask: async () => ({ taskId: 5n, txHash: '0xfeed' as `0x${string}` }),
      },
      lifecycle: {
        resolveAttempt: async () => ({ taskId: 5n, attemptIndex: 0 }),
        requestCancel: async () => 'requested' as const,
        withdrawAnnouncement: async () => { seen.push('withdrawAnnouncement'); },
        refundUnusedTaskBudget: async () => { seen.push('refundUnusedTaskBudget'); },
      },
      observe: { deliveries: async () => [], fetchDelivery: async () => new Uint8Array() },
      listAttemptsForTask: async () => [],
      readDeliveryFacts: async () => ({
        generation: 'today' as const,
        requestId: '0xreq' as `0x${string}`,
        keccakEvidenceHash: `0x${'1'.repeat(64)}` as `0x${string}`,
      }),
      readMechDeliveryFacts: async () => ({
        requestId: '0xreq' as `0x${string}`,
        sha256CidDigest: `sha256:${'a'.repeat(64)}` as const,
      }),
      receipts: { publish: async () => {} },
    } as never,
    { now: () => 0, sleep: async () => {} },
  );
}

const postInput = {
  taskDocument: {
    protocol: 'https://jinn.network/protocols/task-execution/1.0',
    profile: 'urn:profile:repository-work/1.0#sha256:aa',
    instructions: 'Make the failing test pass.',
    payload: {},
    createdAt: '2026-07-30T00:00:00Z',
  },
  submissionFields: {
    submission: 'urn:uuid:99999999-9999-4999-8999-999999999999' as const,
    requester: 'did:key:zRequester',
    idempotencyKey: 'posting:wc:1',
    nonce: '0x09',
    deadline: '2026-08-01T00:00:00Z',
    attempts: { maxTotal: 1 },
  },
  terms: {
    solutionMaxDeliveryRateWei: 10n,
    verdictMaxDeliveryRateWei: 10n,
    responseTimeoutSeconds: 60n,
    allowSolverSelfEvaluation: false,
  },
};

describe('createWorkClient', () => {
  it('runs preflight before posting and returns both results', async () => {
    const seen: string[] = [];
    const result = await client(seen).post({ ...postInput, preflight: okChecks(seen) });
    expect(seen.slice(0, POSTING_PREFLIGHT_CATEGORIES.length)).toEqual([
      ...POSTING_PREFLIGHT_CATEGORIES,
    ]);
    expect(result.posted.taskId).toBe(5n);
    expect(result.preflight).toHaveLength(POSTING_PREFLIGHT_CATEGORIES.length);
  });

  it('never broadcasts when preflight fails', async () => {
    const seen: string[] = [];
    const checks = { ...okChecks(seen) } as Record<string, () => Promise<void>>;
    checks['funds'] = async () => { throw new Error('short'); };
    await expect(
      client(seen).post({ ...postInput, preflight: checks as never }),
    ).rejects.toMatchObject({ category: 'funds' });
  });

  it('binds the configured chain and Safe into the lifecycle exits', async () => {
    const seen: string[] = [];
    await client(seen).close({ taskId: 5n });
    expect(seen).toEqual(['refundUnusedTaskBudget', 'withdrawAnnouncement']);
    expect(await client(seen).release({ taskId: 5n, attemptIndex: 0 })).toBe('unsupported');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/requester/work-client.test.ts`
Expected: FAIL — cannot resolve `../../src/requester/work-client.js`.

- [ ] **Step 3: Implement**

```ts
// client/src/requester/work-client.ts
import type {
  DerivedEvaluationSubmission,
  MarketplaceChainConfig,
  PostingTerms,
  ScanForOnChainMatch,
} from '@jinn-network/marketplace-binding';
import { adoptDelivery, type AdoptionDecision, type AdoptionReceiptSink } from './adoption.js';
import { awaitDeliveries, type ObservedDelivery, type RequesterClock } from './delivery.js';
import { buildPostingDocuments, type PostingSubmissionFields } from './documents.js';
import { evidenceHandlesFor, type EvidenceHandles } from './evidence.js';
import {
  sealEvaluationSubmissionForOwnTask,
  type SealEvaluationSubmissionInput,
} from './evaluation.js';
import { cancelAttempt, closePosting, releasePostedAttempt } from './lifecycle.js';
import type { AttemptUri, RequesterVenuePorts } from './ports.js';
import { postSubmission, type PostedSubmission } from './posting.js';
import {
  runPostingPreflight,
  type PostingPreflightChecks,
  type PostingPreflightEntry,
} from './preflight/run.js';
import { recoverPendingPostings, type UncertainPosting } from './recovery.js';

export interface WorkClientConfig {
  readonly chain: MarketplaceChainConfig;
  readonly creatorSafe: `0x${string}`;
  readonly requester: string;
}

export interface WorkClientPorts extends RequesterVenuePorts {
  readonly receipts: AdoptionReceiptSink;
}

export interface PostWorkInput {
  readonly taskDocument: unknown;
  readonly submissionFields: PostingSubmissionFields;
  readonly terms: PostingTerms;
  readonly preflight: PostingPreflightChecks;
}

export interface WorkClient {
  post(input: PostWorkInput): Promise<{
    readonly posted: PostedSubmission;
    readonly preflight: readonly PostingPreflightEntry[];
  }>;
  recoverPending(scanForOnChainMatch: ScanForOnChainMatch): Promise<readonly UncertainPosting[]>;
  awaitDeliveries(input: {
    readonly taskId: bigint;
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly ObservedDelivery[]>;
  adopt(input: {
    readonly taskId: bigint;
    readonly requestId: `0x${string}`;
    readonly observed: ObservedDelivery;
    accept(observed: ObservedDelivery): Promise<{ accepted: boolean; reason?: string }>;
  }): Promise<AdoptionDecision>;
  sealEvaluationSubmission(input: SealEvaluationSubmissionInput): DerivedEvaluationSubmission;
  close(input: { readonly taskId: bigint }): Promise<void>;
  cancel(input: {
    readonly attempt: AttemptUri;
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly reason: string;
  }): Promise<'requested' | 'already-requested'>;
  release(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }): Promise<'released' | 'unsupported'>;
  evidenceHandles(observed: ObservedDelivery): EvidenceHandles;
}

/**
 * The composed requester facade. Everything it touches is either the binding's public surface
 * or an injected port — nothing here reaches into the host, which is what makes this module
 * packageable as the public work client (daemon composition design §8).
 */
export function createWorkClient(
  config: WorkClientConfig,
  ports: WorkClientPorts,
  clock?: RequesterClock,
): WorkClient {
  return {
    async post(input) {
      const preflight = await runPostingPreflight(input.preflight);
      const documents = buildPostingDocuments({
        taskDocument: input.taskDocument,
        submissionFields: input.submissionFields,
      });
      const posted = await postSubmission(
        {
          documents,
          terms: input.terms,
          chain: config.chain,
          creatorSafe: config.creatorSafe,
        },
        ports,
      );
      return { posted, preflight };
    },
    recoverPending(scanForOnChainMatch) {
      return recoverPendingPostings({ intents: ports.intents, scanForOnChainMatch });
    },
    awaitDeliveries(input) {
      return awaitDeliveries(input, ports, clock);
    },
    adopt(input) {
      return adoptDelivery({ ...input, chain: config.chain }, ports);
    },
    sealEvaluationSubmission(input) {
      return sealEvaluationSubmissionForOwnTask(input);
    },
    close(input) {
      return closePosting({ taskId: input.taskId, chain: config.chain }, ports);
    },
    cancel(input) {
      return cancelAttempt(input, ports);
    },
    release(input) {
      return releasePostedAttempt({ ...input, chain: config.chain }, ports);
    },
    evidenceHandles(observed) {
      return evidenceHandlesFor(observed);
    },
  };
}
```

Append to `client/src/requester/index.ts`:

```ts
export { createWorkClient } from './work-client.js';
export type {
  PostWorkInput,
  WorkClient,
  WorkClientConfig,
  WorkClientPorts,
} from './work-client.js';
```

- [ ] **Step 4: Run the whole module suite and the boundary test**

Run: `cd client && yarn vitest run test/requester test/architecture/requester-module-boundary.test.ts && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/requester client/test/requester/work-client.test.ts
git commit -m "feat(requester): compose the extractable work-client facade"
```

---

### Task 15: `posting[]` config and the launched-record migration

Design §9: each launched record becomes an explicit posting-config entry. The migration is additive (launched records stay on disk until stage 5), atomic (the config loader's existing temp-file-plus-rename write), and idempotent (an existing entry under the same key is never overwritten).

**Files:**
- Modify: `client/src/config.ts` (add the `posting` block beside `joinedSolverNets` at line 417; add `migrateLaunchedRecordsToPosting` beside `migrateLegacySolverNets` at line ~840; call it from the load path at ~line 1451)
- Test: `client/test/config-posting-migration.test.ts`

**Interfaces:**
- Consumes: `selectLiveTarget`'s `PostingTargetCandidate` shape (Task 5) as the target of the mapping.
- Produces: config key `posting` — an array of `{ key: string; workKind: string; profileUri: string; enabled: boolean; terms: { solutionMaxDeliveryRateWei: string; verdictMaxDeliveryRateWei: string; responseTimeoutSeconds: string; allowSolverSelfEvaluation: boolean; maxClaims: number }; legacyManifestDigest?: string; legacySolverNetId?: string }`. Wei values are decimal strings because JSON has no bigint. Exported helper `migrateLaunchedRecordsToPosting(raw: Record<string, unknown>, launchedRecords: readonly LaunchedRecordSummary[]): number` returning the number of entries added, where `LaunchedRecordSummary = { solverNetId: string; manifestCid: string; manifestDigest?: string; workKind: string; profileUri: string; status: string; generatorEnabled: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/config-posting-migration.test.ts
import { describe, expect, it } from 'vitest';
import { migrateLaunchedRecordsToPosting } from '../src/config.js';

const launched = [
  {
    solverNetId: 'net-a',
    manifestCid: 'bafyA',
    manifestDigest: '0xaa',
    workKind: 'repository-work',
    profileUri: 'urn:profile:repository-work/1.0',
    status: 'launched',
    generatorEnabled: true,
  },
  {
    solverNetId: 'net-b',
    manifestCid: 'bafyB',
    workKind: 'repository-work',
    profileUri: 'urn:profile:repository-work/1.0',
    status: 'launched',
    generatorEnabled: false,
  },
  {
    solverNetId: 'net-c',
    manifestCid: 'bafyC',
    workKind: 'repository-work',
    profileUri: 'urn:profile:repository-work/1.0',
    status: 'retired',
    generatorEnabled: true,
  },
];

describe('migrateLaunchedRecordsToPosting', () => {
  it('writes one enabled posting entry per launched generator record', () => {
    const raw: Record<string, unknown> = {};
    expect(migrateLaunchedRecordsToPosting(raw, launched)).toBe(2);
    const posting = raw['posting'] as Array<Record<string, unknown>>;
    expect(posting.map((entry) => entry['key'])).toEqual(['legacy:net-a', 'legacy:net-b']);
    expect(posting[0]!['enabled']).toBe(true);
    expect(posting[1]!['enabled']).toBe(false);
    expect(posting[0]!['legacyManifestDigest']).toBe('0xaa');
  });

  it('is additive — it never touches joinedSolverNets or launched records', () => {
    const raw: Record<string, unknown> = { joinedSolverNets: { bafyA: { manifestCid: 'bafyA' } } };
    migrateLaunchedRecordsToPosting(raw, launched);
    expect(raw['joinedSolverNets']).toEqual({ bafyA: { manifestCid: 'bafyA' } });
  });

  it('is idempotent and never overwrites an operator-edited entry', () => {
    const raw: Record<string, unknown> = {
      posting: [{ key: 'legacy:net-a', workKind: 'custom', profileUri: 'urn:p', enabled: false }],
    };
    expect(migrateLaunchedRecordsToPosting(raw, launched)).toBe(1);
    const posting = raw['posting'] as Array<Record<string, unknown>>;
    expect(posting).toHaveLength(2);
    expect(posting[0]).toEqual({
      key: 'legacy:net-a',
      workKind: 'custom',
      profileUri: 'urn:p',
      enabled: false,
    });
    expect(migrateLaunchedRecordsToPosting(raw, launched)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/config-posting-migration.test.ts`
Expected: FAIL — `migrateLaunchedRecordsToPosting` is not exported from `../src/config.js`.

- [ ] **Step 3: Add the schema block to `JinnConfigSchema`, immediately after the `joinedSolverNets` block**

```ts
  /**
   * Launcher-side posting entries (daemon composition design §9). Each entry is one target the
   * posting loop may post Submission documents against. Written beside `joinedSolverNets` by
   * the launched-record migration; the legacy keys are deleted at cutover stage 5.
   */
  posting: z
    .array(
      z.object({
        key: z.string().min(1),
        workKind: z.string().min(1),
        profileUri: z.string().min(1),
        enabled: z.boolean().default(true),
        terms: z
          .object({
            // Wei values are decimal strings: JSON has no bigint.
            solutionMaxDeliveryRateWei: z.string().regex(/^\d+$/),
            verdictMaxDeliveryRateWei: z.string().regex(/^\d+$/),
            responseTimeoutSeconds: z.string().regex(/^\d+$/),
            allowSolverSelfEvaluation: z.boolean().default(false),
            maxClaims: z.number().int().positive().default(1),
          })
          .optional(),
        legacyManifestDigest: z.string().optional(),
        legacySolverNetId: z.string().optional(),
      }),
    )
    .optional(),
```

- [ ] **Step 4: Implement the migration beside `migrateLegacySolverNets`**

```ts
export interface LaunchedRecordSummary {
  readonly solverNetId: string;
  readonly manifestCid: string;
  readonly manifestDigest?: string;
  readonly workKind: string;
  readonly profileUri: string;
  readonly status: string;
  readonly generatorEnabled: boolean;
}

/**
 * Launched records → `posting[]` entries (design §9). Additive: `joinedSolverNets` and the
 * launched-record files survive until stage 5, so a rollback to the previous daemon generation
 * still boots. Idempotent: an entry already present under the migrated key is left exactly as
 * the operator left it. Returns the number of entries added.
 */
export function migrateLaunchedRecordsToPosting(
  raw: Record<string, unknown>,
  launchedRecords: readonly LaunchedRecordSummary[],
): number {
  const existing = Array.isArray(raw['posting'])
    ? (raw['posting'] as Record<string, unknown>[])
    : [];
  const byKey = new Set(existing.map((entry) => String(entry['key'])));
  let added = 0;
  for (const record of launchedRecords) {
    if (record.status !== 'launched') continue;
    const key = `legacy:${record.solverNetId}`;
    if (byKey.has(key)) continue;
    existing.push({
      key,
      workKind: record.workKind,
      profileUri: record.profileUri,
      enabled: record.generatorEnabled,
      legacySolverNetId: record.solverNetId,
      ...(record.manifestDigest === undefined
        ? {}
        : { legacyManifestDigest: record.manifestDigest }),
    });
    byKey.add(key);
    added += 1;
  }
  if (existing.length > 0) raw['posting'] = existing;
  return added;
}
```

- [ ] **Step 5: Call it from the load path and log once, mirroring the `migrateLegacySolverNets` call site**

```ts
  const postingAdded = migrateLaunchedRecordsToPosting(raw, readLaunchedRecordSummaries());
  if (postingAdded > 0) {
    console.log(
      `[config] Migrated ${postingAdded} launched ${postingAdded === 1 ? 'record' : 'records'} `
      + 'to posting entries. Legacy launched records are kept until cutover stage 5.',
    );
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/config-posting-migration.test.ts test/config.test.ts && yarn typecheck`
Expected: PASS, including the existing config suite.

- [ ] **Step 7: Commit**

```bash
git add client/src/config.ts client/test/config-posting-migration.test.ts
git commit -m "feat(config): add posting entries and the launched-record migration"
```

---

### Task 16: The posting loop — host wiring

The single site where `venue-base` meets the requester module. If any stage-0/1/2 symbol differs from the inbound assumptions, it is adapted here and nowhere else.

**Files:**
- Create: `client/src/daemon/posting-loop.ts`
- Modify: `client/src/daemon/loop-heartbeat.ts:33-47` (register the loop), `client/src/daemon/daemon.ts` (construct and start it), `client/src/main.ts` (build its ports from `createBaseVenue`)
- Test: `client/test/daemon/posting-loop.test.ts`

**Interfaces:**
- Consumes: `createWorkClient`, `WorkClient`, `PostingPreflightChecks` (Task 14); `assertPostingFunds`, `assertPostingFreshness`, `selectLiveTarget` (Tasks 3–5); `createBaseVenue` from `@jinn-network/marketplace-venue-base`; `runLoop`, `LOOP_REGISTRY` from `./loop-heartbeat.js`; `emitEvent` from `../observability/emit-event.js`.
- Produces: `class PostingLoop { constructor(deps: PostingLoopDeps); tick(): Promise<readonly bigint[]>; run(): Promise<void>; stop(): void }` with `interface PostingLoopDeps { workClient: WorkClient; store: Store; entries: readonly PostingEntry[]; buildWork(entry: PostingEntry): Promise<PostWorkInput | null>; liveTargets(): Promise<readonly PostingTargetCandidate[]>; drainOnly?: boolean }`. `tick` returns the task ids posted this tick.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/posting-loop.test.ts
import { describe, expect, it } from 'vitest';
import { PostingLoop } from '../../src/daemon/posting-loop.js';
import { LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';
import { makeTestStore } from '@test/store.js';

const entry = {
  key: 'legacy:net-a',
  workKind: 'repository-work',
  profileUri: 'urn:profile:repository-work/1.0',
  enabled: true,
};

function deps(overrides: Record<string, unknown> = {}) {
  const posted: unknown[] = [];
  return {
    posted,
    deps: {
      store: makeTestStore(),
      entries: [entry],
      liveTargets: async () => [{ ...entry, live: true }],
      buildWork: async () => ({ taskDocument: {}, submissionFields: {}, terms: {}, preflight: {} }),
      workClient: {
        post: async (input: unknown) => {
          posted.push(input);
          return { posted: { taskId: 11n }, preflight: [] };
        },
        recoverPending: async () => [],
      },
      ...overrides,
    } as never,
  };
}

describe('PostingLoop', () => {
  it('is registered with the watchdog', () => {
    expect(LOOP_REGISTRY.map((row) => row.name)).toContain('posting');
  });

  it('posts one task per enabled entry with a live target', async () => {
    const harness = deps();
    expect(await new PostingLoop(harness.deps).tick()).toEqual([11n]);
    expect(harness.posted).toHaveLength(1);
  });

  it('skips a disabled entry', async () => {
    const harness = deps({ entries: [{ ...entry, enabled: false }] });
    expect(await new PostingLoop(harness.deps).tick()).toEqual([]);
  });

  it('skips an entry whose target is not live and does not throw', async () => {
    const harness = deps({ liveTargets: async () => [{ ...entry, live: false }] });
    expect(await new PostingLoop(harness.deps).tick()).toEqual([]);
  });

  it('posts nothing in drain mode but still recovers pending intents', async () => {
    let recovered = 0;
    const harness = deps({
      drainOnly: true,
      workClient: {
        post: async () => { throw new Error('must not post while draining'); },
        recoverPending: async () => { recovered += 1; return []; },
      },
    });
    expect(await new PostingLoop(harness.deps).tick()).toEqual([]);
    expect(recovered).toBe(1);
  });

  it('records a task_posted event per posted task', async () => {
    const harness = deps();
    const loop = new PostingLoop(harness.deps);
    await loop.tick();
    const events = (harness.deps as unknown as { store: { listActivityEvents(): { kind: string }[] } })
      .store.listActivityEvents();
    expect(events.some((event) => event.kind === 'task_posted')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/daemon/posting-loop.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/posting-loop.js`, and `LOOP_REGISTRY` has no `posting` row.

- [ ] **Step 3: Register the loop**

In `client/src/daemon/loop-heartbeat.ts`, add to `LOOP_REGISTRY` (replacing the retired `creator` row in Task 17; both rows coexist for this task only):

```ts
  { name: 'posting', intervalMs: 5000 },
```

- [ ] **Step 4: Implement the loop**

```ts
// client/src/daemon/posting-loop.ts
import type { PostingTargetCandidate } from '../requester/preflight/index.js';
import type { PostWorkInput, WorkClient } from '../requester/index.js';
import { isRequesterError } from '../requester/index.js';
import { selectLiveTarget } from '../requester/preflight/index.js';
import { emitEvent } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';
import { runLoop } from './loop-heartbeat.js';

export interface PostingEntry {
  readonly key: string;
  readonly workKind: string;
  readonly profileUri: string;
  readonly enabled: boolean;
}

export interface PostingLoopDeps {
  readonly workClient: WorkClient;
  readonly store: Store;
  readonly entries: readonly PostingEntry[];
  /** Returns the work to post for an entry, or null when the entry has nothing to post now. */
  buildWork(entry: PostingEntry): Promise<PostWorkInput | null>;
  liveTargets(): Promise<readonly PostingTargetCandidate[]>;
  /** Drain mode (design §10): stop accepting new work, keep reconciling what is in flight. */
  readonly drainOnly?: boolean;
}

/**
 * The requester loop. It owns scheduling and operator policy only — every protocol decision is
 * the work client's, and the work client is the extractable module.
 */
export class PostingLoop {
  private stopped = false;
  private stopResolve: (() => void) | null = null;
  private readonly stopPromise: Promise<void>;

  constructor(private readonly deps: PostingLoopDeps) {
    this.stopPromise = new Promise((resolve) => { this.stopResolve = resolve; });
  }

  async tick(): Promise<readonly bigint[]> {
    const uncertain = await this.deps.workClient.recoverPending(async () => null);
    for (const intent of uncertain) {
      emitEvent(this.deps.store, {
        kind: 'tick_error',
        outcome: 'warn',
        detail: `posting intent ${intent.idempotencyKey} is uncertain: broadcast may have landed; `
          + 'reconcile before re-posting',
      }, 'posting');
    }
    if (this.deps.drainOnly === true) return [];

    const targets = await this.deps.liveTargets();
    const postedTaskIds: bigint[] = [];
    for (const entry of this.deps.entries) {
      if (!entry.enabled) continue;
      let target: PostingTargetCandidate;
      try {
        target = selectLiveTarget({ candidates: targets, explicitPostingKey: entry.key });
      } catch (err) {
        if (isRequesterError(err) && err.category === 'target') continue;
        throw err;
      }
      // eslint-disable-next-line no-await-in-loop -- posting is deliberately serialized per tick.
      const work = await this.deps.buildWork(entry);
      if (work === null) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- one Safe, one nonce stack, one post at a time.
        const result = await this.deps.workClient.post(work);
        postedTaskIds.push(result.posted.taskId);
        emitEvent(this.deps.store, {
          kind: 'task_posted',
          requestId: String(result.posted.taskId),
          outcome: 'ok',
          detail: `Posted Submission ${result.posted.submission} via posting entry ${target.postingKey}`,
        }, 'posting');
      } catch (err) {
        emitEvent(this.deps.store, {
          kind: 'task_posted',
          outcome: 'failed',
          detail: isRequesterError(err)
            ? `${err.category}/${err.code}: ${err.message}`
            : err instanceof Error ? err.message : String(err),
        }, 'posting');
      }
    }
    return postedTaskIds;
  }

  async run(): Promise<void> {
    await runLoop({
      name: 'posting',
      store: this.deps.store,
      tick: async () => { await this.tick(); },
      intervalMs: 5000,
      stopSignal: () => this.stopped,
      stopPromise: this.stopPromise,
      emitSource: 'posting',
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}
```

- [ ] **Step 5: Wire it into the daemon and `main.ts`**

In `client/src/daemon/daemon.ts`, add a `private postingLoop?: PostingLoop` field, construct it when `config.posting` is supplied, and start it in the same block that starts the other optional loops (mirroring the `rewardClaimLoop` pattern at lines 476-488), adding `'posting'` to the `started` set at line 556. In `client/src/main.ts`, build its deps from the venue facade:

```ts
  const venue = createBaseVenue({
    chain: chainConfig,
    publicClient,
    walletClient,
    safeAddress: creatorSafeAddress,
    stateDbPath: postingIntentsDbPath,
  });
  const workClient = createWorkClient(
    { chain: chainConfig, creatorSafe: creatorSafeAddress, requester: operatorDid },
    { ...venueRequesterPorts(venue), receipts: adoptionReceiptSink },
  );
```

where `venueRequesterPorts` is a local adapter in `main.ts` mapping the facade onto `RequesterVenuePorts` — the one place any inbound-assumption drift is absorbed.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd client && yarn vitest run test/daemon/posting-loop.test.ts test/daemon && yarn typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/daemon client/src/main.ts client/test/daemon/posting-loop.test.ts
git commit -m "feat(daemon): add the posting loop over the requester work client"
```

---

### Task 17: Retire the creator loop and the launched-record generators

Runs only after Task 16's loop is live and its drain has completed (design §10 drain rules).

**Files:**
- Delete: `client/src/daemon/creator.ts`, `client/src/tasks/posting-service.ts`, `client/src/tasks/sources.ts`, `client/src/solvernets/launched-record-dispatcher.ts`, `client/test/tasks/posting-service.test.ts`, `client/test/tasks/sources.test.ts`
- Modify: `client/src/daemon/daemon.ts` (drop `CreatorLoop` import, field, construction, start block, and the `'creator'` entry in the `started` set), `client/src/daemon/loop-heartbeat.ts` (drop the `creator` row), `client/src/main.ts` (drop the task-source and generator-spawn wiring)
- Test: `client/test/architecture/creator-loop-retired.test.ts`

**Interfaces:**
- Consumes: Task 16's `PostingLoop`.
- Produces: nothing new; the retirement is asserted by a guard test so a later revert cannot quietly resurrect a second posting stack.

- [ ] **Step 1: Write the failing guard test**

```ts
// client/test/architecture/creator-loop-retired.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';

const retired = [
  '../../src/daemon/creator.ts',
  '../../src/tasks/posting-service.ts',
  '../../src/tasks/sources.ts',
  '../../src/solvernets/launched-record-dispatcher.ts',
];

describe('creator loop retirement (cutover stage 3)', () => {
  for (const relative of retired) {
    it(`${relative} is deleted`, () => {
      expect(existsSync(fileURLToPath(new URL(relative, import.meta.url)))).toBe(false);
    });
  }

  it('the loop registry no longer declares a creator loop', () => {
    expect(LOOP_REGISTRY.map((row) => row.name)).not.toContain('creator');
    expect(LOOP_REGISTRY.map((row) => row.name)).toContain('posting');
  });

  it('the daemon no longer references CreatorLoop or TaskPostingService', () => {
    const daemon = readFileSync(
      fileURLToPath(new URL('../../src/daemon/daemon.ts', import.meta.url)),
      'utf-8',
    );
    expect(daemon).not.toContain('CreatorLoop');
    expect(daemon).not.toContain('TaskPostingService');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/architecture/creator-loop-retired.test.ts`
Expected: FAIL — all four files still exist and `LOOP_REGISTRY` still declares `creator`.

- [ ] **Step 3: Delete the retired modules and their tests**

```bash
cd client
git rm src/daemon/creator.ts src/tasks/posting-service.ts src/tasks/sources.ts \
  src/solvernets/launched-record-dispatcher.ts \
  test/tasks/posting-service.test.ts test/tasks/sources.test.ts
```

- [ ] **Step 4: Remove every reference**

Delete from `client/src/daemon/loop-heartbeat.ts:34` the row `{ name: 'creator', intervalMs: 5000 },`. In `client/src/daemon/daemon.ts` remove the `CreatorLoop` import (line 5), the `creatorLoop` field (line 258), its construction (lines 302-308), its start block (lines 438-446), the `taskSources`/`safeAddress` config fields that only fed it (lines 192-199), and `'creator'` from the `started` set (line 556). In `client/src/main.ts` remove the task-source construction and the launched-record generator spawn that fed `CreatorLoop`.

- [ ] **Step 5: Run the guard test and the full daemon and CLI suites**

Run: `cd client && yarn vitest run test/architecture test/daemon test/cli && yarn typecheck`
Expected: PASS. Any residual importer of the deleted modules surfaces as a type error here — fix by deleting the dead call site, never by re-adding a shim.

- [ ] **Step 6: Commit**

```bash
git add -A client
git commit -m "refactor(daemon): retire the creator loop and launched-record generators"
```

---

### Task 18: Retire lifecycle publishing

`posting[]` plus the binding's lifecycle exits replace the launched-record lifecycle publish path. The registry client itself survives to stage 4 and is not touched here.

**Files:**
- Delete: `client/src/solvernets/lifecycle-transitions.ts` and its test
- Modify: `client/src/solvernets/launch-state-machine.ts` (drop the generator-spawn and lifecycle-publish phases), `client/src/api/solvernets-endpoints.ts` (drop the lifecycle transition routes)
- Test: `client/test/architecture/lifecycle-publishing-retired.test.ts`

**Interfaces:**
- Consumes: Tasks 13 and 17.
- Produces: nothing new. The operator-facing replacement for pause/retire is `WorkClient.close` plus toggling `posting[].enabled` (Tasks 13, 15, 19, 24).

- [ ] **Step 1: Write the failing guard test**

```ts
// client/test/architecture/lifecycle-publishing-retired.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lifecycleModule = fileURLToPath(
  new URL('../../src/solvernets/lifecycle-transitions.ts', import.meta.url),
);
const endpoints = fileURLToPath(new URL('../../src/api/solvernets-endpoints.ts', import.meta.url));
const stateMachine = fileURLToPath(
  new URL('../../src/solvernets/launch-state-machine.ts', import.meta.url),
);

describe('lifecycle publishing retirement (cutover stage 3)', () => {
  it('the lifecycle-transitions module is deleted', () => {
    expect(existsSync(lifecycleModule)).toBe(false);
  });

  it('no surviving module imports it', () => {
    for (const file of [endpoints, stateMachine]) {
      expect(readFileSync(file, 'utf-8')).not.toContain('lifecycle-transitions');
    }
  });

  it('the launch state machine no longer spawns generators', () => {
    const source = readFileSync(stateMachine, 'utf-8');
    expect(source).not.toContain('launched-record-dispatcher');
    expect(source).not.toContain('generatorEnabled');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/architecture/lifecycle-publishing-retired.test.ts`
Expected: FAIL — the module exists and is still imported.

- [ ] **Step 3: Delete and unwire**

```bash
cd client
git rm src/solvernets/lifecycle-transitions.ts test/solvernets/lifecycle-transitions.test.ts
```

Then remove the generator-spawn and lifecycle-publish phases from `launch-state-machine.ts` and the lifecycle transition routes from `api/solvernets-endpoints.ts`, leaving the registry client and the manifest publish untouched (they retire at stage 4).

- [ ] **Step 4: Run the guard test and the API suite**

Run: `cd client && yarn vitest run test/architecture test/api test/solvernets && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A client
git commit -m "refactor(solvernets): retire lifecycle publishing in favour of posting config"
```

---

### Task 19: `jinn tasks submit` posts Submission documents

The CLI's private posting copy (`runSubmit`, `client/src/cli/commands/tasks.ts:184-938`, plus `machinePreflightChecks` at 82-182) is replaced by a thin skin over the work client. This is the first half of the mechanical convergence the marketplace-surfaces design (§4.3) completes after the package mint.

**Files:**
- Modify: `client/src/cli/commands/tasks.ts` (replace `runSubmit`'s posting stack and `machinePreflightChecks` bodies; keep flag parsing, dry-run, and the output envelope)
- Delete: `client/src/tasks/submit-preflight.ts`, `client/test/tasks/submit-preflight.test.ts`
- Test: `client/test/cli/commands/tasks-submit.test.ts`

**Interfaces:**
- Consumes: `createWorkClient`, `WorkClient` (Task 14); `POSTING_PREFLIGHT_CATEGORIES`, `assertPostingFunds`, `assertPostingFreshness`, `selectLiveTarget` (Tasks 3-6).
- Produces: `runSubmit` gains an injected `deps` seam for tests: `export interface TasksSubmitDeps { buildWorkClient(ctx: CommandContext): Promise<WorkClient>; loadPostingEntries(ctx: CommandContext): Promise<readonly PostingEntry[]> }` and `export function makeRunSubmit(deps: TasksSubmitDeps): (ctx: CommandContext) => Promise<void>`. The default export's `run` composes the production deps.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/cli/commands/tasks-submit.test.ts
import { describe, expect, it } from 'vitest';
import { makeCommandCtx } from '@test/cli.js';
import { makeRunSubmit } from '../../../src/cli/commands/tasks.js';

function deps(post: (input: unknown) => Promise<unknown>) {
  return {
    buildWorkClient: async () => ({ post } as never),
    loadPostingEntries: async () => [
      { key: 'legacy:net-a', workKind: 'repository-work', profileUri: 'urn:p', enabled: true },
    ],
  };
}

describe('jinn tasks submit', () => {
  it('emits the posted task id as a machine result', async () => {
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--posting-entry', 'legacy:net-a', '--task-file', 'fixtures/task.json', '--yes', '--json'],
      tty: false,
    });
    await makeRunSubmit(
      deps(async () => ({ posted: { taskId: 12n, submission: 'urn:uuid:x', txHash: '0xfeed' }, preflight: [] })),
    )(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.verb).toBe('tasks submit');
    expect(parsed.taskId).toBe('12');
    expect(exits).toEqual([]);
  });

  it('maps a preflight failure onto the error envelope with its category', async () => {
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--posting-entry', 'legacy:net-a', '--task-file', 'fixtures/task.json', '--yes', '--json'],
      tty: false,
    });
    await makeRunSubmit(
      deps(async () => {
        const { PostingPreflightFailure } = await import('../../../src/requester/preflight/run.js');
        throw new PostingPreflightFailure('funds', 'safe-underfunded', 'short by 10 wei', []);
      }),
    )(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('preflight_failed');
    expect(parsed.details.category).toBe('funds');
    expect(parsed.details.preflightCode).toBe('safe-underfunded');
    expect(exits).toEqual([11]);
  });

  it('never posts on --dry-run', async () => {
    let posted = false;
    const { ctx, writes } = makeCommandCtx({
      argv: ['--posting-entry', 'legacy:net-a', '--task-file', 'fixtures/task.json', '--dry-run', '--json'],
      tty: false,
    });
    await makeRunSubmit(deps(async () => { posted = true; return {}; }))(ctx);
    expect(posted).toBe(false);
    expect(JSON.parse(writes[writes.length - 1]!).dryRun).toBe(true);
  });

  it('rejects an unknown posting entry before touching the venue', async () => {
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--posting-entry', 'nope', '--task-file', 'fixtures/task.json', '--yes', '--json'],
      tty: false,
    });
    await makeRunSubmit(deps(async () => ({})))(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).details.field).toBe('posting-entry');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/cli/commands/tasks-submit.test.ts`
Expected: FAIL — `makeRunSubmit` is not exported.

- [ ] **Step 3: Re-platform `runSubmit`**

Replace the posting body with the work-client call, keeping the existing flag parsing, `ensureConfirmed`/`emitDryRun`, and `emitResult`/`emitEnvelope` shapes. New flags: `--posting-entry <key>` (replaces `--solver-net` / `--manifest-cid`) and `--task-file <path>` (a sealed-able TEP Task document; replaces `--spec-file` and `--request-file`). Error mapping:

```ts
export interface TasksSubmitDeps {
  buildWorkClient(ctx: CommandContext): Promise<WorkClient>;
  loadPostingEntries(ctx: CommandContext): Promise<readonly PostingEntry[]>;
}

export function makeRunSubmit(deps: TasksSubmitDeps) {
  return async function runSubmit(ctx: CommandContext): Promise<void> {
    // …flag parsing unchanged…
    const entries = await deps.loadPostingEntries(ctx);
    if (!entries.some((entry) => entry.key === postingEntryKey)) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown posting entry: ${postingEntryKey}`,
          exampleCli: 'jinn tasks submit --posting-entry legacy:net-a --task-file ./task.json --yes',
          details: { field: 'posting-entry', expected: entries.map((entry) => entry.key).join('|') },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    if (dryRun) { emitDryRun(/* …existing shape… */); return; }
    try {
      const result = await (await deps.buildWorkClient(ctx)).post(work);
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'tasks submit',
          taskId: String(result.posted.taskId),
          submission: result.posted.submission,
          txHash: result.posted.txHash,
          preflight: result.preflight,
        },
        (v) => JSON.stringify(v, null, 2),
        { json, human, writer: ctx.writer, stdoutIsTty: ctx.stdoutIsTty },
      );
    } catch (err) {
      if (isRequesterError(err)) {
        emitEnvelope(
          {
            code: err.category === 'broadcast' && err.code === 'broadcast-uncertain'
              ? 'broadcast_uncertain'
              : 'preflight_failed',
            message: err.message,
            details: { category: err.category, preflightCode: err.code },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      throw err;
    }
  };
}
```

Then delete `client/src/tasks/submit-preflight.ts` and its test, and update the command `helpText` to describe `--posting-entry` and `--task-file`.

- [ ] **Step 4: Run the CLI suite**

Run: `cd client && yarn vitest run test/cli test/tasks && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A client
git commit -m "feat(cli): post Submission documents through the requester work client"
```

---

### Task 20: `jinn tasks close | cancel | release`

**Files:**
- Modify: `client/src/cli/commands/tasks.ts` (three new subverbs in `run`, plus `helpText`)
- Test: `client/test/cli/commands/tasks-lifecycle.test.ts`

**Interfaces:**
- Consumes: `WorkClient.close`, `.cancel`, `.release` (Tasks 13-14); the `TasksSubmitDeps.buildWorkClient` seam from Task 19, widened to `TasksCommandDeps`.
- Produces: `export function makeTasksRun(deps: TasksCommandDeps): (ctx: CommandContext) => Promise<void>` where `TasksCommandDeps = TasksSubmitDeps`. Subverb argument shapes: `jinn tasks close --task-id <n> --yes`; `jinn tasks cancel --attempt <urn> --task-id <n> --attempt-index <i> --reason <text> --yes`; `jinn tasks release --task-id <n> --attempt-index <i> --yes`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/cli/commands/tasks-lifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { makeCommandCtx } from '@test/cli.js';
import { makeTasksRun } from '../../../src/cli/commands/tasks.js';

function run(workClient: Record<string, unknown>) {
  return makeTasksRun({
    buildWorkClient: async () => workClient as never,
    loadPostingEntries: async () => [],
  });
}

describe('jinn tasks lifecycle exits', () => {
  it('closes a posted task', async () => {
    let closed: unknown;
    const { ctx, writes } = makeCommandCtx({
      argv: ['close', '--task-id', '12', '--yes', '--json'],
      tty: false,
    });
    await run({ close: async (input: unknown) => { closed = input; } })(ctx);
    expect(closed).toEqual({ taskId: 12n });
    expect(JSON.parse(writes[writes.length - 1]!).verb).toBe('tasks close');
  });

  it('reports an idempotent cancel honestly', async () => {
    const { ctx, writes } = makeCommandCtx({
      argv: [
        'cancel', '--attempt', 'urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '--task-id', '12', '--attempt-index', '0', '--reason', 'superseded', '--yes', '--json',
      ],
      tty: false,
    });
    await run({ cancel: async () => 'already-requested' as const })(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).outcome).toBe('already-requested');
  });

  it('surfaces today-mode release as unsupported rather than success', async () => {
    const { ctx, writes } = makeCommandCtx({
      argv: ['release', '--task-id', '12', '--attempt-index', '0', '--yes', '--json'],
      tty: false,
    });
    await run({ release: async () => 'unsupported' as const })(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.outcome).toBe('unsupported');
    expect(parsed.detail).toContain('claim slot');
  });

  it('requires --task-id on close', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['close', '--yes', '--json'], tty: false });
    await run({ close: async () => {} })(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).details.field).toBe('task-id');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/cli/commands/tasks-lifecycle.test.ts`
Expected: FAIL — `makeTasksRun` is not exported.

- [ ] **Step 3: Implement the three subverbs**

Add to the `run` dispatcher (mirroring the `submit` branch at `tasks.ts:946-951`), each behind `ensureConfirmed`, each emitting through `emitResult`. The `release` branch renders the unsupported case explicitly:

```ts
      const outcome = await workClient.release({ taskId, attemptIndex });
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'tasks release',
          outcome,
          detail: outcome === 'unsupported'
            ? 'This contract generation has no on-venue release; the attempt keeps its claim slot '
              + 'until the revised generation deadline-reap.'
            : `Released attempt ${attemptIndex} of task ${taskId}.`,
        },
        (v) => JSON.stringify(v, null, 2),
        { json, human, writer: ctx.writer, stdoutIsTty: ctx.stdoutIsTty },
      );
```

Update `helpText` and the `invalid_invocation` `expected` string to `submit|close|cancel|release|observe-autopilot-delivery|list|show`.

- [ ] **Step 4: Run the CLI suite**

Run: `cd client && yarn vitest run test/cli && yarn typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/tasks.ts client/test/cli/commands/tasks-lifecycle.test.ts
git commit -m "feat(cli): add tasks close, cancel and release exits"
```

---

### Task 21: `jinn policy` and `jinn wiring`

Read-mostly verbs exposing the stage-1 claim predicate and execution-wiring entries (design §9), plus the posting entries this stage adds.

**Files:**
- Create: `client/src/cli/commands/policy.ts`, `client/src/cli/commands/wiring.ts`
- Modify: `client/src/cli/index.ts:43,82` (register both modules)
- Test: `client/test/cli/commands/policy.test.ts`, `client/test/cli/commands/wiring.test.ts`

**Interfaces:**
- Consumes: config keys `claimPolicy`, `executionWiring[]` (stage 1) and `posting[]` (Task 15).
- Produces: two `CommandModule` default exports. `jinn policy show [--json]` prints the resolved claim policy; `jinn wiring list [--json]` prints the execution-wiring entries; `jinn wiring show <workKind>` prints one entry; `jinn wiring posting` prints the posting entries. All read-only — mutation stays in the config file and the SPA.

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/cli/commands/policy.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCommandCtx } from '@test/cli.js';
import policy from '../../../src/cli/commands/policy.js';

function withConfig(config: unknown, run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-policy-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('jinn policy', () => {
  it('has name "policy" and a summary', () => {
    expect(policy.name).toBe('policy');
    expect(policy.summary.length).toBeGreaterThan(0);
  });

  it('shows the configured claim policy', async () => {
    await withConfig({ claimPolicy: { maxConcurrentClaims: 3 } }, async (path) => {
      const { ctx, writes } = makeCommandCtx({
        argv: ['show', '--config', path, '--json'],
        tty: false,
      });
      await policy.run(ctx);
      const parsed = JSON.parse(writes[writes.length - 1]!);
      expect(parsed.verb).toBe('policy show');
      expect(parsed.claimPolicy).toEqual({ maxConcurrentClaims: 3 });
    });
  });

  it('says so plainly when no policy is configured', async () => {
    await withConfig({}, async (path) => {
      const { ctx, writes } = makeCommandCtx({
        argv: ['show', '--config', path, '--json'],
        tty: false,
      });
      await policy.run(ctx);
      expect(JSON.parse(writes[writes.length - 1]!).claimPolicy).toBeNull();
    });
  });

  it('rejects an unknown subverb', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['bogus'], tty: false });
    await policy.run(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
```

```ts
// client/test/cli/commands/wiring.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCommandCtx } from '@test/cli.js';
import wiring from '../../../src/cli/commands/wiring.js';

const config = {
  executionWiring: [
    {
      workKind: 'repository-work',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: [],
      credentialRef: 'default',
      isolationPolicy: 'worktree',
      legacyManifestDigest: '0xaa',
    },
  ],
  posting: [
    { key: 'legacy:net-a', workKind: 'repository-work', profileUri: 'urn:p', enabled: true },
  ],
};

function withConfig(run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-wiring-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('jinn wiring', () => {
  it('lists execution wiring entries with their bridge annotation', async () => {
    await withConfig(async (path) => {
      const { ctx, writes } = makeCommandCtx({
        argv: ['list', '--config', path, '--json'],
        tty: false,
      });
      await wiring.run(ctx);
      const parsed = JSON.parse(writes[writes.length - 1]!);
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].legacyManifestDigest).toBe('0xaa');
    });
  });

  it('shows one entry by work kind', async () => {
    await withConfig(async (path) => {
      const { ctx, writes } = makeCommandCtx({
        argv: ['show', 'repository-work', '--config', path, '--json'],
        tty: false,
      });
      await wiring.run(ctx);
      expect(JSON.parse(writes[writes.length - 1]!).entry.harness).toBe('claude-code');
    });
  });

  it('lists posting entries', async () => {
    await withConfig(async (path) => {
      const { ctx, writes } = makeCommandCtx({
        argv: ['posting', '--config', path, '--json'],
        tty: false,
      });
      await wiring.run(ctx);
      expect(JSON.parse(writes[writes.length - 1]!).posting[0].key).toBe('legacy:net-a');
    });
  });

  it('reports an unknown work kind as invalid_invocation', async () => {
    await withConfig(async (path) => {
      const { ctx, writes, exits } = makeCommandCtx({
        argv: ['show', 'nope', '--config', path, '--json'],
        tty: false,
      });
      await wiring.run(ctx);
      expect(JSON.parse(writes[writes.length - 1]!).details.field).toBe('workKind');
      expect(exits).toEqual([11]);
    });
  });
});
```

- [ ] **Step 2: Run both to verify they fail**

Run: `cd client && yarn vitest run test/cli/commands/policy.test.ts test/cli/commands/wiring.test.ts`
Expected: FAIL — neither command module exists.

- [ ] **Step 3: Implement both command modules**

Each follows the `CommandModule` contract (`client/src/cli/command.ts:24-29`): parse the subverb off `ctx.argv`, load config via `loadConfig(getConfigPathFromArgs(rest))`, emit through `emitResult`, and emit `invalid_invocation` through `emitEnvelope` for an unknown subverb or a missing target. `policy.ts` reads `config.claimPolicy ?? null`; `wiring.ts` reads `config.executionWiring ?? []` and `config.posting ?? []`.

- [ ] **Step 4: Register both in the CLI dispatcher**

In `client/src/cli/index.ts`, add the imports beside the existing `tasksCommand` import (line 43) and both modules to the command array (line 82).

- [ ] **Step 5: Run the CLI suite**

Run: `cd client && yarn vitest run test/cli && yarn typecheck`
Expected: PASS, including `test/cli/help.test.ts` and `test/cli/index.test.ts`, which enumerate the registered verbs.

- [ ] **Step 6: Commit**

```bash
git add client/src/cli client/test/cli/commands/policy.test.ts client/test/cli/commands/wiring.test.ts
git commit -m "feat(cli): add policy and wiring verbs"
```

---

### Task 22: Retire the launcher-side `jinn solver-nets` subverbs

Design §9 retires `jinn solver-nets` "on the same schedule as their machinery". Its machinery splits across stages, so only the launcher-side subverbs — the ones whose machinery Tasks 17 and 18 deleted — retire here. Join/list/doctor stay until stage 4 with the registry client.

**Files:**
- Modify: `client/src/cli/commands/solver-nets.ts` (delete the create/launch/pause/retire subverbs and their help text)
- Modify: `client/test/cli/commands/solver-nets.test.ts`
- Test: `client/test/cli/commands/solver-nets-launcher-retired.test.ts`

**Interfaces:**
- Consumes: Tasks 18-20 (the replacement path is `jinn tasks close` plus `posting[].enabled`).
- Produces: nothing new. The command's `invalid_invocation` `expected` string is the checked contract.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/cli/commands/solver-nets-launcher-retired.test.ts
import { describe, expect, it } from 'vitest';
import { makeCommandCtx } from '@test/cli.js';
import solverNets from '../../../src/cli/commands/solver-nets.js';

describe('launcher-side solver-nets subverbs are retired (cutover stage 3)', () => {
  for (const subverb of ['create', 'launch', 'pause', 'retire']) {
    it(`rejects "${subverb}" and points at the replacement`, async () => {
      const { ctx, writes, exits } = makeCommandCtx({ argv: [subverb, '--json'], tty: false });
      await solverNets.run(ctx);
      const parsed = JSON.parse(writes[writes.length - 1]!);
      expect(parsed.code).toBe('invalid_invocation');
      expect(parsed.message).toContain('retired');
      expect(parsed.exampleCli).toContain('jinn tasks close');
      expect(exits).toEqual([11]);
    });
  }

  it('keeps the surviving subverbs in its help text', () => {
    expect(solverNets.helpText).toContain('jinn solver-nets join');
    expect(solverNets.helpText).not.toContain('jinn solver-nets launch');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/cli/commands/solver-nets-launcher-retired.test.ts`
Expected: FAIL — the launcher subverbs still run.

- [ ] **Step 3: Delete the four subverb branches and update the help text and the `expected` string**

The retired branches fall through to the existing unknown-subverb envelope; add the retirement message and `exampleCli: 'jinn tasks close --task-id <n> --yes'` so an operator hitting a muscle-memory command learns the replacement.

- [ ] **Step 4: Run the CLI suite**

Run: `cd client && yarn vitest run test/cli && yarn typecheck`
Expected: PASS — update the assertions in the existing `solver-nets.test.ts` that exercised the retired subverbs.

- [ ] **Step 5: Commit**

```bash
git add -A client
git commit -m "refactor(cli): retire launcher-side solver-nets subverbs"
```

---

### Task 23: Posting HTTP API

The SPA's data source. Modelled on `client/src/api/launcher-endpoints.ts`, mounted on the existing authenticated daemon API surface (not the public archive subtree, which is stage 4).

**Files:**
- Create: `client/src/api/posting-endpoints.ts`
- Modify: `client/src/api/server.ts` (mount the routes beside the launcher routes)
- Test: `client/test/api/posting-endpoints.test.ts`

**Interfaces:**
- Consumes: `WorkClient` (Task 14), `PostingEntry` (Task 16), config `posting[]` (Task 15).
- Produces: `export interface PostingApiDeps { listEntries(): Promise<readonly PostingEntry[]>; listPostings(): Promise<readonly PostingSummary[]>; workClient: WorkClient }` with `interface PostingSummary { taskId: string; postingKey: string; submission: string; state: 'posted' | 'delivered' | 'adopted' | 'rejected' | 'closed'; postedAt: string; attempts: number; uncertain?: boolean }`; `export function addPostingRoutes(app: Hono, deps: PostingApiDeps): void` mounting `GET /api/posting/entries`, `GET /api/posting/postings`, `POST /api/posting/:taskId/close`, `POST /api/posting/:taskId/attempts/:attemptIndex/release`, `POST /api/posting/:taskId/attempts/:attemptIndex/cancel`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/api/posting-endpoints.test.ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { addPostingRoutes } from '../../src/api/posting-endpoints.js';

function app(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const instance = new Hono();
  addPostingRoutes(instance, {
    listEntries: async () => [
      { key: 'legacy:net-a', workKind: 'repository-work', profileUri: 'urn:p', enabled: true },
    ],
    listPostings: async () => [
      {
        taskId: '12',
        postingKey: 'legacy:net-a',
        submission: 'urn:uuid:x',
        state: 'posted' as const,
        postedAt: '2026-07-30T00:00:00Z',
        attempts: 1,
      },
    ],
    workClient: {
      close: async () => { calls.push('close'); },
      release: async () => { calls.push('release'); return 'unsupported' as const; },
      cancel: async () => { calls.push('cancel'); return 'requested' as const; },
      ...overrides,
    },
  } as never);
  return { instance, calls };
}

describe('posting endpoints', () => {
  it('lists posting entries', async () => {
    const res = await app().instance.request('/api/posting/entries');
    expect(res.status).toBe(200);
    expect((await res.json()).entries[0].key).toBe('legacy:net-a');
  });

  it('lists postings', async () => {
    const res = await app().instance.request('/api/posting/postings');
    expect((await res.json()).postings[0].taskId).toBe('12');
  });

  it('closes a posting', async () => {
    const harness = app();
    const res = await harness.instance.request('/api/posting/12/close', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(harness.calls).toEqual(['close']);
  });

  it('returns the unsupported release outcome rather than an error', async () => {
    const res = await app().instance.request('/api/posting/12/attempts/0/release', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('unsupported');
  });

  it('rejects a non-numeric task id', async () => {
    const res = await app().instance.request('/api/posting/not-a-number/close', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run test/api/posting-endpoints.test.ts`
Expected: FAIL — cannot resolve `../../src/api/posting-endpoints.js`.

- [ ] **Step 3: Implement the routes**

```ts
// client/src/api/posting-endpoints.ts
import type { Hono } from 'hono';
import type { WorkClient } from '../requester/index.js';
import { isRequesterError } from '../requester/index.js';
import type { PostingEntry } from '../daemon/posting-loop.js';

export interface PostingSummary {
  readonly taskId: string;
  readonly postingKey: string;
  readonly submission: string;
  readonly state: 'posted' | 'delivered' | 'adopted' | 'rejected' | 'closed';
  readonly postedAt: string;
  readonly attempts: number;
  /** A pending posting intent with no matching on-chain post — the operator must reconcile. */
  readonly uncertain?: boolean;
}

export interface PostingApiDeps {
  listEntries(): Promise<readonly PostingEntry[]>;
  listPostings(): Promise<readonly PostingSummary[]>;
  readonly workClient: WorkClient;
}

function parseTaskId(raw: string): bigint | null {
  return /^\d+$/.test(raw) ? BigInt(raw) : null;
}

export function addPostingRoutes(app: Hono, deps: PostingApiDeps): void {
  app.get('/api/posting/entries', async (c) =>
    c.json({ entries: await deps.listEntries() }));

  app.get('/api/posting/postings', async (c) =>
    c.json({ postings: await deps.listPostings() }));

  app.post('/api/posting/:taskId/close', async (c) => {
    const taskId = parseTaskId(c.req.param('taskId'));
    if (taskId === null) return c.json({ error: 'taskId must be a decimal integer' }, 400);
    try {
      await deps.workClient.close({ taskId });
      return c.json({ outcome: 'closed' });
    } catch (err) {
      return c.json(
        { error: isRequesterError(err) ? `${err.category}/${err.code}` : String(err) },
        502,
      );
    }
  });

  app.post('/api/posting/:taskId/attempts/:attemptIndex/release', async (c) => {
    const taskId = parseTaskId(c.req.param('taskId'));
    const attemptIndex = Number(c.req.param('attemptIndex'));
    if (taskId === null || !Number.isInteger(attemptIndex)) {
      return c.json({ error: 'taskId and attemptIndex must be integers' }, 400);
    }
    return c.json({ outcome: await deps.workClient.release({ taskId, attemptIndex }) });
  });

  app.post('/api/posting/:taskId/attempts/:attemptIndex/cancel', async (c) => {
    const taskId = parseTaskId(c.req.param('taskId'));
    const attemptIndex = Number(c.req.param('attemptIndex'));
    if (taskId === null || !Number.isInteger(attemptIndex)) {
      return c.json({ error: 'taskId and attemptIndex must be integers' }, 400);
    }
    const body = await c.req.json<{ attempt: `urn:uuid:${string}`; reason: string }>();
    return c.json({
      outcome: await deps.workClient.cancel({
        attempt: body.attempt,
        taskId,
        attemptIndex,
        reason: body.reason,
      }),
    });
  });
}
```

- [ ] **Step 4: Mount in `server.ts`** beside the launcher route registration, passing the daemon-built `WorkClient` and the config-derived entry list.

- [ ] **Step 5: Run the API suite**

Run: `cd client && yarn vitest run test/api test/architecture/api-daemon-boundary.test.ts && yarn typecheck`
Expected: PASS — note the API→daemon boundary test: `posting-endpoints.ts` imports the `PostingEntry` *type* from `../daemon/posting-loop.js`, which that test's regex forbids. Move `PostingEntry` into `client/src/types/posting.ts` and import it from there in both modules.

- [ ] **Step 6: Commit**

```bash
git add client/src/api client/src/types/posting.ts client/test/api/posting-endpoints.test.ts
git commit -m "feat(api): expose posting entries, postings and lifecycle exits"
```

---

### Task 24: The posting SPA surface and its `OPERATOR-APP-SPEC` delta

Deltas only; no redesign (design §11). Both land in this one PR, per the frontend rules.

**Files:**
- Create: `client/src/dashboard/spa/src/pages/Posting.tsx`, `client/src/dashboard/spa/src/pages/posting/PostingEntriesCard.tsx`, `client/src/dashboard/spa/src/pages/posting/PostingsTable.tsx`
- Modify: `client/src/dashboard/spa/src/App.tsx:164-168` (replace the `/launcher*` routes with `/posting`), `client/src/dashboard/spa/src/routes.ts` (nav entry)
- Modify: `client/OPERATOR-APP-SPEC.md` (rewrite §2.14 "Generator panel" as §2.14 "Posting"; annotate §2.5 and §2.6)
- Test: `client/src/dashboard/spa/src/pages/Posting.test.tsx`

**Interfaces:**
- Consumes: Task 23's endpoints.
- Produces: route `/posting` titled **Posting**; component parts `PostingEntriesCard` (entries with their enabled state and bridge annotation) and `PostingsTable` (postings with state, attempt count, and the close/cancel/release actions).

- [ ] **Step 1: Write the failing page test**

```tsx
// client/src/dashboard/spa/src/pages/Posting.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PostingPage } from './Posting.js';

const entries = [
  { key: 'legacy:net-a', workKind: 'repository-work', profileUri: 'urn:p', enabled: true },
];
const postings = [
  {
    taskId: '12',
    postingKey: 'legacy:net-a',
    submission: 'urn:uuid:x',
    state: 'posted',
    postedAt: '2026-07-30T00:00:00Z',
    attempts: 1,
  },
];

function stubFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/entries')) return Response.json({ entries });
    if (url.endsWith('/postings')) return Response.json({ postings });
    if (init?.method === 'POST') return Response.json(overrides['post'] ?? { outcome: 'closed' });
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe('PostingPage', () => {
  it('renders posting entries and postings', async () => {
    render(<PostingPage fetcher={stubFetch()} />);
    expect(await screen.findByText('legacy:net-a')).toBeInTheDocument();
    expect(await screen.findByText('12')).toBeInTheDocument();
  });

  it('closes a posting through the action lifecycle', async () => {
    const fetcher = stubFetch();
    render(<PostingPage fetcher={fetcher} />);
    await userEvent.click(await screen.findByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.getByText(/closed/i)).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith(
      '/api/posting/12/close',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('states plainly when release is unsupported on this generation', async () => {
    render(<PostingPage fetcher={stubFetch({ post: { outcome: 'unsupported' } })} />);
    await userEvent.click(await screen.findByRole('button', { name: /release/i }));
    expect(await screen.findByText(/no on-venue release/i)).toBeInTheDocument();
  });

  it('flags an uncertain posting', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/entries')
        ? Response.json({ entries })
        : Response.json({ postings: [{ ...postings[0], uncertain: true }] }));
    render(<PostingPage fetcher={fetcher} />);
    expect(await screen.findByText(/reconcile/i)).toBeInTheDocument();
  });

  it('says what fills an empty postings table', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/entries') ? Response.json({ entries }) : Response.json({ postings: [] }));
    render(<PostingPage fetcher={fetcher} />);
    expect(await screen.findByText(/no tasks posted yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && yarn vitest run src/dashboard/spa/src/pages/Posting.test.tsx`
Expected: FAIL — cannot resolve `./Posting.js`.

- [ ] **Step 3: Build the page from shadcn primitives**

`PostingPage` takes an injected `fetcher` (defaulting to `window.fetch`) so the test drives it without a live daemon. Composition: `Card` + `Table` for entries; `Card` + `Table` + `Button` + `AlertDialog` for postings; `Badge` for state; `Alert` for the uncertain-posting and unsupported-release messages. Copy discipline — labels and values only:

- Empty postings table: `No tasks posted yet. Enabled posting entries post on the next daemon tick.`
- Uncertain posting: `Broadcast outcome unknown — reconcile against the chain before re-posting.`
- Unsupported release: `This contract generation has no on-venue release; the attempt keeps its claim slot until the deadline reap.`
- Migration message (rendered when any entry carries `legacyManifestDigest`): `Migrated from launched records. Legacy records are kept until the tree rename.`

No captions restating the table, no mood text.

- [ ] **Step 4: Route and nav**

Replace the `/launcher`, `/launcher/create`, and `/launcher/launched/:solverNetId` routes in `App.tsx:164-168` with `<Route path="/posting"><PostingPage /></Route>` plus `<Route path="/launcher"><Redirect to="/posting" /></Route>` so a bookmarked launcher URL lands somewhere real, and update the nav entry in `routes.ts` to **Posting**.

- [ ] **Step 5: Write the `OPERATOR-APP-SPEC` delta**

Replace §2.14 "Generator panel (added in #570)" with §2.14 **Posting**, following the four-axis format the spec uses throughout:

- **State** — posting entries (key, work kind, enabled); postings (task id, state, attempt count, posted-at); contract generation.
- **State messages** — *"Broadcast outcome unknown — reconcile against the chain before re-posting"* (action: none; operator reconciles); *"This contract generation has no on-venue release"* (informational, raised by the release action); *"Migrated from launched records"* (one-time, informational).
- **Collections** — posting entries (config order, no pagination); postings (newest first, paged at 50).
- **Actions** — `close` (`idle → closing → closed | failed`), `cancel` (`idle → cancelling → requested | already-requested | failed`), `release` (`idle → releasing → released | unsupported | failed`). All three move on-chain state or escrow, so each declares its confirmation dialog and its failure rendering.

Annotate §2.5 (SolverNet Registry) and §2.6 (Tasks) with a line naming §2.14 as the requester-side owner from cutover stage 3.

- [ ] **Step 6: Run the SPA suites**

Run: `cd client && yarn vitest run src/dashboard/spa && yarn typecheck`
Expected: PASS, including `App.routing.test.tsx` and `App.rail.test.tsx`, which assert the route table and nav rail.

- [ ] **Step 7: Commit**

```bash
git add client/src/dashboard/spa client/OPERATOR-APP-SPEC.md
git commit -m "feat(spa): add the posting surface with its operator-app spec delta"
```

---

### Task 25: Drain runbook and the stage-3 deploy PR

**Files:**
- Create: `docs/runbooks/cutover-stage-3-posting-drain.md`
- Test: none (a runbook plus the PR body); the gate is the testnet loop.

**Interfaces:**
- Consumes: every prior task.
- Produces: the runbook the deploy PR body links, and the stage gate evidence.

- [ ] **Step 1: Write the runbook**

Sections, following `docs/runbooks/hotfix.md`'s shape:

1. **Preconditions** — stage 2's testnet gate green; `yarn typecheck`, `yarn test`, and the venue kit green on the train head; the operator has approved the deploy PR.
2. **Drain (before the swap deploys)** — set every `posting[].enabled` to `false` (or start the daemon with the posting loop in `drainOnly` mode) and leave the creator loop running; watch until every in-flight post reaches a terminal state; record the remaining set. Bounded by the operator's patience — stragglers strand with the state message, never silently.
3. **Verify the drain** — `jinn tasks list`, the `/api/posting/postings` payload, and the pending-intent count all agree that nothing is mid-post.
4. **Deploy** — merge the train; the daemon boots into the posting loop; `posting[]` migration runs and shows its one-time panel message.
5. **Gate** — post one task from this operator, watch it claimed and delivered, adopt it end-to-end on testnet, and record the task id, the Submission URI, the delivery digest, and the adoption decision in the PR body.
6. **Rollback** — revert the deploy PR or pin the previous canary image. Chain state stays consistent (claims and posts are chain facts, and the intent store is durable), but the reverted daemon does not resume the new flow's in-flight engagements; the same state message names them. Legacy config keys and launched records are still present, so the previous generation boots unchanged.

- [ ] **Step 2: Run the full local gate**

Run: `cd client && yarn typecheck && yarn test && yarn e2e:daemon-harness`
Expected: PASS. Paste the outputs into the PR body.

- [ ] **Step 3: Open the deploy PR**

Target `integration/evidence-v1`, title `feat(cutover): stage 3 — posting flow`, body carrying the drain checklist from the runbook, the rollback statement, and the testnet gate evidence. Do not self-merge; the deploy PR is operator-approved.

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/runbooks/cutover-stage-3-posting-drain.md
git commit -m "docs(runbook): add the stage-3 posting drain runbook"
```

---

## Design findings and proposed dispositions

Recorded per the program's designs-are-law rule — findings with proposed dispositions, never silent patches.

1. **Requester-side adoption has no specified receipt mechanism.** Design §4 names requester-side adoption as a posting-loop deliverable and the carve table assigns `AWAITING_ADOPTION`/`CLAIMING_DELIVERY` to `application`, but the only adoption-receipt machinery in the tree is product-specific (`AutopilotAdoptionReceiptSchema`, `client/src/autopilot/github-adoption-receipt-observer.ts`, GitHub PR shaped). *Proposed disposition:* the module emits a generic `AdoptionDecision` and publishes it through an injected `AdoptionReceiptSink`; the Autopilot GitHub sink stays a host-side adapter outside `src/requester/`. No design change — this records the seam.

2. **The pipeline's `DeliveryWaitPort` cannot serve requester-side delivery await.** It requires a `TaskExecutionBackend` (`packages/marketplace/pipeline/src/pipeline.ts:55-61`), which the requester does not have; the program §5 facade nevertheless lists `deliveryWait` among what `venue-base` returns. *Proposed disposition:* the requester declares `listAttemptsForTask` and reuses `MarketplaceObservePort.deliveries` / `fetchDelivery`, both injected from `venue-base` by the host (Task 10). `deliveryWait` stays solver-side.

3. **Requester-side evaluation sealing cannot cover bridge-era tasks.** `deriveAndSealEvaluationSubmission` requires the subject Submission to carry an admission-receipt descriptor (`binding/src/evaluation-derive.ts:72-85`), and bridge-era legacy-posted tasks have no sealed Submission at all (design §10 bridge-era document rules). *Proposed disposition:* requester-side sealing covers only Submissions posted by this stage; the evaluator-seals carve-out (public specs only) stays live for legacy-posted tasks until they drain, and Task 12 fails loudly with `missing-admission-receipt` rather than degrading. Worth naming in the design as a bridge-era exception.

4. **`jinn solver-nets` retirement splits across stages.** Design §9 says it retires "on the same schedule as their machinery", but that machinery splits: claim gating at stage 1, launch/lifecycle at stage 3, registry client at stage 4. *Proposed disposition:* stage 3 retires only the launcher-side subverbs (create/launch/pause/retire, Task 22); join/list/doctor retire with the registry client at stage 4.

5. **The plugin-content CLI re-key has no stage.** Design §9 says the plugin content commands "only re-key from manifestCid to wiring entries here" without naming a stage. *Proposed disposition:* it belongs with stage 1, where `executionWiring[]` lands; stage 3 asserts only that the posting path carries no `manifestCid` coupling. Not implemented in this plan.

6. **`posting[]` needs a wei encoding the design does not specify.** JSON has no bigint. *Proposed disposition:* decimal strings validated by `/^\d+$/` (Task 15), converted at the module boundary. Consistent with how the CLI already carries rates.

## Self-review

**Spec coverage.** Design §4 posting-loop row → Tasks 8–16. §8 extractable module → Tasks 1 and 14 (boundary test is the checked property). §9 CLI → Tasks 19–22; config migration → Task 15; operator app → Task 24. §10 stage-3 row and drain rules → Tasks 17, 18, 25. Program contract 5 (evaluator-seals carve-out) → Task 12. Contract 6 (publication policy) → Task 13's evidence handles, which return references and never publish. Contract 10 (drain) → the loop's `drainOnly` mode plus Task 25. Marketplace-surfaces §4.3 (preflight core as one cohesive sub-module with its own surface, golden fixtures kit-first) → Tasks 2–6. §5.1 (facade shape, signer-injection only) → Tasks 8 and 14: `venue-base` is injected, never imported, and the module contains no key material.

**Placeholder scan.** No TBDs; every code step carries real content. Two steps intentionally describe edits to large existing files rather than restating them (Task 17's reference removal, Task 24's spec delta) — both name exact files and line ranges and the exact copy to write.

**Type consistency.** `PostingTargetCandidate` is produced in Task 5 and consumed in Tasks 14 and 16 under the same name. `RequesterVenuePorts` is declared in Task 8 and narrowed with `Pick<>` in Tasks 10, 11, and 13 — no divergent port shapes. `ObservedDelivery` is produced in Task 10 and consumed in Tasks 11, 13, and 14. `PostingEntry` is declared in Task 16 and moved to `client/src/types/posting.ts` in Task 23 to satisfy the existing API→daemon boundary test — Task 23 states that move explicitly rather than leaving it to discovery.

---

> **Reconciliation addendum (2026-07-30, coordinator):** the venue-base plan (D10) settled
> the requester await surface as `VenueObservePort extends MarketplaceObservePort` with
> `listAttemptsForTask(task: SubmissionUri | { taskId: bigint }): Promise<readonly VenueAttemptRef[]>`,
> `VenueAttemptRef = { attempt, taskId, attemptIndex, operator, requestId? }`, injected as
> `venue.observe`. Align this plan's `RequesterVenuePorts`: `observe` is typed
> `VenueObservePort`; the standalone `listAttemptsForTask` member is subsumed by it (map
> `VenueAttemptRef.attempt` where this plan's tasks use bare attempt URIs, e.g.
> `awaitDeliveries`); `readDeliveryFacts`/`readMechDeliveryFacts` stay as written. Type
> names in Tasks 7–14's Consumes blocks substitute accordingly; behavior unchanged.
