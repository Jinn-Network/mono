# Marketplace Venue-Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** build `packages/marketplace/venue-base/` — the production implementations of every venue-facing port the merged stack leaves as an empty socket (chain log source, Safe broadcast, claim writer, settlement reads/writes, lifecycle writes, finality waiter, delivery waiter, durable posting-intent store, projector-backed observe) — behind one `createBaseVenue(config)` facade, with an Anvil-fork conformance kit whose fixtures encode the legacy adapter's hard-won behavior.

**Architecture:** A tier-3, venue-specific, product-agnostic adapter tree. Every port takes an injected viem `WalletClient` — the package holds no key material and no keystore code (cross-plan contract 11). All durable venue state (log cursor, tx-submission/nonce ledger, cross-process broadcast lock, posting intents, cancel/withdraw signals, observe records) lives in one SQLite file at a caller-supplied `stateDbPath`, opened through the driver only — never `node:fs`, never `process.env` (custody guard, decision D1). The conformance kit and every fixture live in the existing `@jinn-network/marketplace-testing` package as new subpaths, so `venue-base` never devDepends its own kit (the portal cycle the tree's inventory guard already documents).

**Tech Stack:** TypeScript 5.9 / Node 22 / Yarn 4.13.0 standalone projects with `portal:` resolutions; viem 2.x; `better-sqlite3` 13.0.1; vitest 4.1.8; `node --test` for `.github/scripts/*.test.mjs` guards; Foundry `anvil` forking Base Sepolia.

## Global Constraints

- Branch target: `integration/evidence-v1`. Baseline head `8c7179f2c`. PRs #2306 / #2307 / #2308 are assumed merged, so `.github/scripts/custody-boundaries.test.mjs` exists and already lists `packages/marketplace/venue-base` in its auto-discovered `CUSTODY_SET`.
- Stacked PR train into `integration/evidence-v1`, one train for this component. No agent self-merge.
- **Kits and fixtures before implementations.** Task 6 lands the entire legacy-behavior fixture corpus before any port is written. Within every implementation task the kit case or unit test is written and run red before the implementation.
- **Fresh rewrite; legacy enters as fixtures, never as ported code** (cross-plan contract 12). Do not copy `client/src/adapters/mech/*` or `client/src/tx-retry.ts` into `venue-base`.
- **Signer-injection only** (cross-plan contract 11): every port receives an injected viem `WalletClient`. No keystore, no key-loading, no `privateKey`/`mnemonic`/`seedPhrase` identifier anywhere in `src/`.
- **Custody guard** (`.github/scripts/custody-boundaries.test.mjs`): `venue-base/src/**` may contain no `process.env`, no `from "node:fs"` / `"fs"`, no `child_process`, no key-construction helper, no key-material parameter name. Decision D1 below is how the SQLite stores stay inside that line.
- **Marketplace source boundaries** (`.github/scripts/marketplace-source-boundaries.test.mjs`): production source may not use ambient `fetch` / `WebSocket` / `EventSource` / `XMLHttpRequest`, and may not use locale-sensitive APIs (`localeCompare`, `toLocale*`, `Intl`).
- Guard trio (package inventory, source boundary, packed types) plus `marketplace-ci.yml` wiring ships **with** the tree (Task 3), not after.
- Every task ends with `yarn typecheck && yarn test` in the touched package, the guard run from repo root, and the outputs shown. Anvil-fork kit tasks additionally run the kit.
- npm name: `@jinn-network/marketplace-venue-base`. Version `0.1.0`. Exports root-only (`.`).
- American English throughout; no emoji; no product names in tier-3 code.
- SPDX header `// SPDX-License-Identifier: MIT` on every new `.ts` file, matching the tree.

## Design decisions taken in this plan

These are decisions the design and program plan left open or under-specified. Each is a finding with a proposed disposition, surfaced here rather than patched silently.

- **D1 — SQLite versus the custody guard.** The guard's C2 rule bans `node:fs`, `child_process`, and `process.env` in the custody set. `venue-base` needs durable state. Disposition: keep the pinned `stateDbPath` config key; open the database through `better-sqlite3` only, via a dynamic `await import("better-sqlite3")` inside `openVenueStateDb`. `venue-base/src` therefore never imports `node:fs`, never creates directories (the host guarantees the parent directory exists — documented in the README and enforced by a clear error message), and never reads an environment variable. **No custody-guard allowlist edit is required.** Recommended follow-up for the coordinator: amend the guard's C2 comment to state that driver-mediated database access at a caller-supplied path is the named, reviewed exception, so a future reader does not mistake the pass for an oversight.
- **D2 — Facade config is wider than the pinned shape.** The program plan §5 pins `config = { chain, publicClient, walletClient, safeAddress, stateDbPath }`. That shape cannot produce a complete `SettlementPorts` (its `pin` and `verifySettlementGrade` are host-owned — the verifier owns injected trust/evidence resolvers, which a tier-3 venue adapter must not depend on) nor a complete `MarketplaceObservePort` (`fetchDelivery` needs an HTTP transport the source-boundary guard forbids the package from reaching ambiently). Disposition: the **return shape stays exactly as pinned**; `config` gains five additive host-injected keys — `priorityMech`, `isAuthorizedMechOrigin`, `pin`, `verifySettlementGrade`, `fetchBytes` — plus three optional tuning blocks. Flagged to the coordinator as an additive amendment to §5.
- **D3 — `claim` is the writer, not the whole `ClaimPorts`.** `ClaimPorts` carries per-engagement values (`taskDigest`, `submission`, `nonce`, `capabilityMatch`). A venue-level singleton cannot supply them. Disposition: `BaseVenue.claim` is typed `Pick<ClaimPorts, "claimTask">`; the host composes the full `ClaimPorts` per engagement. Key name unchanged.
- **D4 — Port-type home is a move, not a re-export.** The design (§6.1) says `FinalityPort` / `DeliveryWaitPort` / `ReleaseAttemptPort` "are re-exported from the binding's port surface". `binding` may not import `marketplace-pipeline` (the source-boundary guard lists it as forbidden), so a literal re-export is impossible. Disposition: the declarations **move** into `binding/src/venue-ports.ts` and `pipeline` re-exports them from `binding`, preserving pipeline's public surface byte-for-byte. Same effect, correct direction.
- **D5 — The kit lives in `marketplace-testing`.** `testing` gains `@jinn-network/marketplace-venue-base` as a dependency and three subpaths (`./venue-anvil`, `./venue-fixtures`, `./venue-conformance`). `venue-base` never devDepends `testing` — the inventory guard's existing comment documents why that direction breaks Yarn's node-modules linker for standalone portal projects.
- **D6 — `withdrawAnnouncement` is a durable local marker.** Today-generation has no on-chain announcement withdrawal. `venue-base` records an idempotent withdrawal row in the venue state database; the host's projector loop reads it and emits the signed retraction. Named in the README so it is not mistaken for a chain write.
- **D7 — `VenueRawLog` is structural, not imported.** The log source emits `VenueRawLog`, declared locally and structurally identical to the projector's `MarketplaceRawLog`, so `venue-base` does not depend on `marketplace-projector`. The conformance kit (in `testing`, which depends on both) pins bidirectional assignability with a compile-time check.
- **D8 — `createBaseVenue` is async.** It opens the state database, which requires the dynamic driver import of D1. The program plan does not pin sync/async; recorded here so the stage-1 plan composes `await createBaseVenue(...)`.
- **D9 — §6.1 enumeration gap: the verdict leg carries no chain writes anywhere.** Audit of the evaluation leg against the port inventory (coordinator-raised, confirmed here):

  | Evaluation-leg chain need | Covered by | Verdict |
  | --- | --- | --- |
  | Post the evaluation Submission | `postTask` + `SafeBroadcastPort` (posting leg) | covered |
  | Upload / pin the verdict Delivery | `IpfsPinPort` (host-injected) | covered |
  | **Claim the verdict attempt** | nothing — `ClaimPorts.claimTask({taskId, priorityMech})` does **not** cover it. The venue verb is `claimEvaluation(taskId, attemptIndex, evaluatorMech, evaluationTaskCidDigest)` (V3) / `claimEvaluation(taskId, attemptIndex, evaluatorMech) → verdictIndex` (V4) | **missing** |
  | **Verdict-claim preflight** | nothing — legacy `canClaimEvaluation` has no port | **missing** |
  | **Settle the verdict delivery** | nothing — `SettlementPorts.claimSolutionDelivery` is solution-only; the venue verb is `claimVerdictDelivery(verdictRequestId, verdictDigest, verdictCode)` (V3) / the V4 `prepareVerdictDelivery` → signed Deliver → `claimVerdictDelivery` batch | **missing** |
  | **Verdict-side facts readers** | nothing — `readRouterDeliveryFacts` resolves through `getRequestRef`/`getAttempt`, which are solution-scoped | **missing** |
  | **Release an unfulfilled verdict claim** | nothing — `ReleaseAttemptPort` covers `releaseAttempt` and `forfeitDeliveredReservation`, not V4 `releaseVerdict` | **missing** |

- **D11 — `SafeBroadcastPort` is too narrow for the single-broadcaster rule.** The binding declares only `broadcastCreateTask`. Cross-plan contract 1 requires *every* surviving legacy transaction leg to re-point through this package at stage 1 — and those legs include general Safe `execTransaction` calls **and bare EOA transactions** (the earning and bootstrap family signs with the Safe's owner key directly; stage 1's finding 7 confirms today's `executeSafeTxBatch` bypasses the ledger entirely). Disposition: **no binding amendment.** `venue-base` widens the port locally — `interface VenueSafeBroadcast extends SafeBroadcastPort { broadcastSafeTransaction(input: VenueSafeExecuteInput): Promise<Hex>; sendEoaTransaction(input: VenueEoaTransactionInput): Promise<Hex> }` — and both run through the *same* per-sender lock, submission ledger, fee-bump machine, and reconcile-first recovery, because the Safe's owner EOA and the bare-EOA sender are the same key. That identity is precisely the #525/#562/#897 two-stacks failure, so one machine is the requirement, not a convenience. `broadcastCreateTask` becomes a caller of `broadcastSafeTransaction`. Stage 1's Tasks 19 and 21 substitute these signatures verbatim. Task 11 builds it.
- **D10 — the requester's delivery-await reads.** Stage 3's requester module cannot use `DeliveryWaitPort` (it is solver-side; it requires a `TaskExecutionBackend`). It needs `MarketplaceObservePort.deliveries` / `fetchDelivery` **for tasks the operator posted, not only tasks it claimed**, plus a `listAttemptsForTask` read the binding's `MarketplaceObservePort` does not declare. Disposition: **no binding amendment.** `venue-base` declares `interface VenueObservePort extends MarketplaceObservePort { listAttemptsForTask(task: VenueTaskRef): Promise<readonly VenueAttemptRef[]> }` and `BaseVenue.observe` is typed `VenueObservePort` — assignable to `MarketplaceObservePort` wherever the binding wants one, and wider where stage 3 needs the extra read. Posted-task coverage is structural: the projector-backed observe is fed by the log source, which scans the router and coordinator addresses for *all* engagements, not a claim-filtered subset. Task 20 pins both properties with tests. Stage 3 injects `venue.observe` and reads `listAttemptsForTask` off it.
- **D9 disposition — a `verdict` group on the facade, not an extension of `SettlementPorts`.** `SettlementPorts` is a binding-declared type consumed by `settleDelivery()`, whose `SettlementAttempt`, `RouterDeliveryFacts`, and `routerFactsFailure` shapes are all solution-scoped (they compare `solutionCidDigest` and a solution keccak evidence hash). Bolting verdict methods onto it would widen a frozen binding type and hand verdict authority to every solution-settlement caller. Instead `venue-base` declares its own `VerdictPorts` interface locally and `createBaseVenue` returns it under a new key, `verdict`. This **confirms the stage-2 plan's assumed `verdict` group naming** — no reconciliation needed on that side. Recorded as an additive amendment to design §6.1's deliverable table and to program §5's facade return shape; Task 15 builds it.

## File structure

**New tree `packages/marketplace/venue-base/`**

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.yarnrc.yml`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`, `README.md` | standalone-project scaffolding matching `projector/` |
| `src/index.ts` | the public surface — `createBaseVenue` and every exported type |
| `src/facade.ts` | `createBaseVenue` assembly |
| `src/state/db.ts` | the single SQLite handle, schema migrations, `withTransaction` |
| `src/state/lock.ts` | cross-process advisory lock over the state database |
| `src/chain/chunking.ts` | pure block-range chunk arithmetic |
| `src/chain/cursor.ts` | dual live/durable `(blockNumber, blockHash)` cursor persistence + reorg detection |
| `src/chain/log-source.ts` | `createChainLogSource` — chunked `getLogs`, finality tags, rollback-and-rescan |
| `src/broadcast/classify.ts` | pure recoverable/terminal transaction-error classification |
| `src/broadcast/fees.ts` | pure fee-bump and replacement-bump arithmetic |
| `src/broadcast/ledger.ts` | SQLite `(chainId, from, nonce)` tx-submission ledger |
| `src/broadcast/safe.ts` | `createSafeBroadcast` — `execTransaction`, reconcile guard, stuck-nonce recovery, inner-revert decode |
| `src/abi/venue-extras.ts` | the ABI entries binding does not export (`getRequestRef`, `getVerdictRequestRef`, `getVerdict`, V3 `claimEvaluation`, V4 `releaseVerdict`) |
| `src/claim.ts` | `createClaimWriter` — `ClaimPorts.claimTask` |
| `src/settlement/reads.ts` | `readMechDeliveryFacts`, `readRouterDeliveryFacts` |
| `src/settlement/writes.ts` | `claimSolutionDelivery`, `settleRevisedSolutionDelivery`, `createSettlementPorts` |
| `src/verdict.ts` | the evaluation leg's chain surface — `claimVerdictAttempt`, `canClaimVerdictAttempt`, `readVerdictRouterFacts`, `settleVerdictDelivery`, `releaseVerdict` (decision D9) |
| `src/lifecycle.ts` | resolve / cancel / withdraw / refund / close / release |
| `src/finality.ts` | `createFinalityWaiter` — `FinalityPort` |
| `src/delivery-wait.ts` | `createDeliveryWaiter` — `DeliveryWaitPort` |
| `src/intents.ts` | `createSqlitePostingIntentStore` — the durable outbox |
| `src/observe.ts` | `createVenueObservePort` — `MarketplaceObservePort` |

**Modified**

| File | Change |
| --- | --- |
| `packages/marketplace/binding/src/venue-ports.ts` (create) | the three moved port declarations |
| `packages/marketplace/binding/src/index.ts` | export them |
| `packages/marketplace/binding/src/venue/safe.ts:3-11` | supersession comment |
| `packages/marketplace/pipeline/src/pipeline.ts:33-74` | re-export from binding instead of declaring |
| `packages/marketplace/testing/src/venue-anvil.ts`, `venue-fixtures.ts`, `venue-conformance.ts`, `venue-conformance.test.ts` (create) | the kit |
| `packages/marketplace/testing/package.json` | venue-base dependency + three subpaths |
| `.github/scripts/marketplace-package-inventory.test.mjs`, `marketplace-source-boundaries.test.mjs`, `marketplace-packed-types.test.mjs` | register venue-base |
| `.github/workflows/marketplace-ci.yml` | `venue-base` job, `venue-anvil` job, `verify` gate |

---

### Task 1: Stage-0 mechanical notes on the binding

**Files:**
- Create: `packages/marketplace/binding/src/venue-ports.ts`
- Modify: `packages/marketplace/binding/src/index.ts` (append an export block)
- Modify: `packages/marketplace/binding/src/venue/safe.ts:3-11` (comment only)
- Modify: `packages/marketplace/pipeline/src/pipeline.ts:33-74` (replace declarations with a re-export)
- Test: `packages/marketplace/binding/src/venue-ports.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `@jinn-network/marketplace-binding` exports the types `FinalityAwaitResult`, `FinalityPort`, `DeliveryWaitResult`, `DeliveryWaitPort`, `ReleaseAttemptPort`. `@jinn-network/marketplace-pipeline` continues to export the same five names, now re-exported. Every later task imports these from **binding**.

- [ ] **Step 1: Write the failing binding test**

Create `packages/marketplace/binding/src/venue-ports.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type {
  DeliveryWaitPort,
  DeliveryWaitResult,
  FinalityAwaitResult,
  FinalityPort,
  ReleaseAttemptPort,
} from "./venue-ports.js";

describe("binding venue port surface (design §6.1 port-type home)", () => {
  it("types a finality waiter that reports reorged and failed claims", async () => {
    const port: FinalityPort = {
      async awaitFinalized(input) {
        expect(input.claimTxHash).toBe("0xfeed" as Hex);
        const reorged: FinalityAwaitResult = { ok: false, kind: "reorged" };
        return reorged;
      },
    };
    await expect(
      port.awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: "0xfeed" as Hex }),
    ).resolves.toEqual({ ok: false, kind: "reorged" });
  });

  it("types a delivery waiter that returns exact bytes or a typed wait failure", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const ok: DeliveryWaitResult = { ok: true, deliveryBytes: bytes };
    const port: DeliveryWaitPort = { async waitForDelivery() { return ok; } };
    const result = await port.waitForDelivery({
      attemptUri: "urn:uuid:00000000-0000-5000-8000-000000000000",
      backend: {} as never,
    });
    expect(result).toEqual({ ok: true, deliveryBytes: bytes });
  });

  it("types a release port whose today-generation answer is unsupported", async () => {
    const port: ReleaseAttemptPort = {
      async releaseAttempt() { return { ok: false, kind: "unsupported" }; },
    };
    await expect(port.releaseAttempt({ taskId: 7n, attemptIndex: 2 }))
      .resolves.toEqual({ ok: false, kind: "unsupported" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/binding && yarn vitest run src/venue-ports.test.ts`
Expected: FAIL — `Cannot find module './venue-ports.js'`.

- [ ] **Step 3: Create the moved declarations**

Create `packages/marketplace/binding/src/venue-ports.ts` with the exact text currently at `packages/marketplace/pipeline/src/pipeline.ts:33-74`, plus the SPDX header and imports:

```ts
// SPDX-License-Identifier: MIT

// Home of the three venue-facing ports the pipeline used to declare. Moved here by the
// operator-daemon composition design §6.1 "port-type home" so tier-3 venue adapters
// (`@jinn-network/marketplace-venue-base`) depend on binding types only, never on the
// application-shaped pipeline package. `pipeline` re-exports these names unchanged, so its
// public surface is byte-identical to before the move.
import type { AttemptUri, TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import type { AttemptState } from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";

export type FinalityAwaitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "reorged" | "failed" };

/** Required injected port: gate expensive execution on finalized claim facts (design §8, N2). */
export interface FinalityPort {
  awaitFinalized(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly claimTxHash: Hex;
  }): Promise<FinalityAwaitResult>;
}

export type DeliveryWaitResult =
  | { readonly ok: true; readonly deliveryBytes: Uint8Array }
  | {
      readonly ok: false;
      readonly kind: "timeout" | "cancelled" | "backend-terminal";
      readonly state?: AttemptState;
    };

/** Cancel/timeout-aware delivery wait — the library owns no poll timer policy. */
export interface DeliveryWaitPort {
  waitForDelivery(input: {
    readonly attemptUri: AttemptUri;
    readonly backend: TaskExecutionBackend;
    readonly signal?: AbortSignal;
  }): Promise<DeliveryWaitResult>;
}

export interface ReleaseAttemptPort {
  releaseAttempt(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }): Promise<void | { readonly ok: false; readonly kind: "unsupported" }>;
  forfeitDeliveredReservation?(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly verdictIndex: number;
    readonly legKind: 1 | 2;
  }): Promise<void>;
}
```

- [ ] **Step 4: Export them from the binding index**

Append to `packages/marketplace/binding/src/index.ts` (after the `lifecycle.js` export block):

```ts
// --- venue-facing ports re-homed from the pipeline (composition design §6.1 "port-type home") ---
export type {
  DeliveryWaitPort,
  DeliveryWaitResult,
  FinalityAwaitResult,
  FinalityPort,
  ReleaseAttemptPort,
} from "./venue-ports.js";
```

- [ ] **Step 5: Run the binding suite**

Run: `cd packages/marketplace/binding && yarn typecheck && yarn test`
Expected: PASS, including the three new cases.

- [ ] **Step 6: Update the superseded comment in `venue/safe.ts`**

Replace lines 3–11 of `packages/marketplace/binding/src/venue/safe.ts` with:

```ts
// A minimal, standalone Safe `execTransaction` helper, adapted from
// `client/src/adapters/mech/safe.ts` (design §14 "declared impact"; design §3 "all
// state-changing calls Safe-routed"). Deliberately simpler than a daemon-grade version: no
// shared nonce-ledger, no cross-process lock, no eviction-recovery retry loop. SUPERSEDED
// PLACEMENT: those daemon-concurrency concerns are re-homed by the 2026-07-30
// operator-daemon composition design §6.1 to `@jinn-network/marketplace-venue-base`
// (`src/broadcast/safe.ts`) — venue mechanics, not application policy; the earlier
// "belong to the pipeline (Milestone M6)" note is withdrawn. For a single-shot binding call
// (posting one Task, per M2 scope) a straight read-sign-broadcast-wait sequence is the
// minimum code that solves the problem (Rule 2); it still classifies inner reverts via
// `safe-revert.ts` so a caller gets a decoded reason, not just "reverted".
```

- [ ] **Step 7: Re-point the pipeline declarations**

In `packages/marketplace/pipeline/src/pipeline.ts`, delete lines 33–74 (the five declarations) and put in their place:

```ts
// The three venue-facing ports now live in the binding (composition design §6.1 "port-type
// home"); re-exported here so this package's public surface is unchanged.
export type {
  DeliveryWaitPort,
  DeliveryWaitResult,
  FinalityAwaitResult,
  FinalityPort,
  ReleaseAttemptPort,
} from "@jinn-network/marketplace-binding";
import type {
  ClaimPorts as _ClaimPortsUnused,
  DeliveryWaitPort,
  DeliveryWaitResult,
  FinalityAwaitResult,
  FinalityPort,
  ReleaseAttemptPort,
} from "@jinn-network/marketplace-binding";
```

Then delete the now-duplicated `_ClaimPortsUnused` line and merge `DeliveryWaitPort`, `DeliveryWaitResult`, `FinalityAwaitResult`, `FinalityPort`, `ReleaseAttemptPort` into the file's existing `import type { ... } from "@jinn-network/marketplace-binding";` block at lines 11–20. Leave `PipelinePorts`, `PipelineConfig`, and everything below untouched.

- [ ] **Step 8: Rebuild the binding and run the pipeline suite**

Run:
```bash
cd packages/marketplace/binding && yarn build
cd ../pipeline && yarn install && yarn typecheck && yarn test
```
Expected: PASS. `pipeline/src/index.ts` needs no edit — it already re-exports these five names from `./pipeline.js`.

- [ ] **Step 9: Run the guards**

Run from repo root:
```bash
node --test .github/scripts/marketplace-source-boundaries.test.mjs .github/scripts/marketplace-package-inventory.test.mjs
```
Expected: PASS (no dependency-graph change: pipeline already declares binding).

- [ ] **Step 10: Commit**

```bash
git add packages/marketplace/binding/src/venue-ports.ts \
        packages/marketplace/binding/src/venue-ports.test.ts \
        packages/marketplace/binding/src/index.ts \
        packages/marketplace/binding/src/venue/safe.ts \
        packages/marketplace/pipeline/src/pipeline.ts
git commit -m "refactor(marketplace): re-home the three venue ports to the binding

Composition design §6.1 port-type home: FinalityPort, DeliveryWaitPort and
ReleaseAttemptPort move to binding/src/venue-ports.ts so tier-3 venue
adapters depend on binding types only; pipeline re-exports them unchanged.
Also withdraws venue/safe.ts's superseded Milestone-M6 placement note.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `venue-base` package scaffolding

**Files:**
- Create: `packages/marketplace/venue-base/package.json`, `.yarnrc.yml`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`, `README.md`, `src/index.ts`
- Test: `packages/marketplace/venue-base/src/index.test.ts`

**Interfaces:**
- Consumes: `@jinn-network/marketplace-binding` (Task 1's `venue-ports.js` exports included).
- Produces: an installable, buildable, packable `@jinn-network/marketplace-venue-base@0.1.0` whose only export entry is `.`. Later tasks add modules under `src/` and re-export from `src/index.ts`.

- [ ] **Step 1: Create the manifest**

`packages/marketplace/venue-base/package.json`:

```json
{
  "name": "@jinn-network/marketplace-venue-base",
  "version": "0.1.0",
  "description": "Production venue adapters for the canonical Base marketplace: chunked chain log source, Safe broadcast with a durable nonce ledger, claim/settlement/lifecycle writes, finality and delivery waiters, a durable posting-intent outbox, and a projector-backed observe port.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">=22" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/marketplace/venue-base"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist/", "README.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/marketplace-binding": "0.1.0",
    "@jinn-network/task-execution-backend": "0.1.0",
    "@jinn-network/task-execution-protocol": "0.1.0",
    "better-sqlite3": "13.0.1",
    "viem": "^2.0.0"
  },
  "devDependencies": {
    "@jinn-network/task-execution-profiles": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "@jinn-network/trust-resolve": "0.1.0",
    "@types/better-sqlite3": "7.6.13",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/marketplace-binding": "portal:../binding",
    "@jinn-network/task-execution-backend": "portal:../../task-execution/backend",
    "@jinn-network/task-execution-profiles": "portal:../../task-execution/profiles",
    "@jinn-network/task-execution-protocol": "portal:../../task-execution/protocol",
    "@jinn-network/trust-core": "portal:../../trust/core",
    "@jinn-network/trust-resolve": "portal:../../trust/resolve"
  }
}
```

The four devDependency Jinn packages are the shadow closure: `marketplace-binding` itself depends on `task-execution-{backend,profiles,protocol}` and `trust-{core,resolve}`, and a standalone Yarn project needs a top-level portal resolution for every transitively reachable `@jinn-network/*` package.

- [ ] **Step 2: Create the toolchain files**

`.yarnrc.yml`:
```yaml
nodeLinker: node-modules
```

`tsconfig.json` — copy `packages/marketplace/projector/tsconfig.json` verbatim.

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

`scripts/build.mjs` — copy `packages/marketplace/projector/scripts/build.mjs` verbatim (it is package-relative).

- [ ] **Step 3: Create the pack smoke**

`packages/marketplace/venue-base/scripts/pack-smoke.mjs` — copy `packages/marketplace/projector/scripts/pack-smoke.mjs` and make exactly four edits:

1. `dependencyChain` becomes:
```js
const dependencyChain = [
  ["@jinn-network/task-execution-protocol", join(packageRoot, "..", "..", "task-execution", "protocol")],
  ["@jinn-network/task-execution-backend", join(packageRoot, "..", "..", "task-execution", "backend")],
  ["@jinn-network/task-execution-profiles", join(packageRoot, "..", "..", "task-execution", "profiles")],
  ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core")],
  ["@jinn-network/trust-resolve", join(packageRoot, "..", "..", "trust", "resolve")],
  ["@jinn-network/marketplace-binding", join(packageRoot, "..", "binding")],
];
```
2. Replace every `marketplace-projector` string with `marketplace-venue-base`, and `jinn-marketplace-projector-` with `jinn-marketplace-venue-base-`.
3. The consumer `dependencies` block gains `"better-sqlite3": "13.0.1"`.
4. The smoke script's `expected` array becomes:
```js
const expected = ["@jinn-network/marketplace-binding", "@jinn-network/task-execution-backend", "@jinn-network/task-execution-protocol"];
```

The smoke's `import "@jinn-network/marketplace-venue-base";` runs under `npm install --ignore-scripts`, so `better-sqlite3`'s native binary is absent. This is why D1 requires the driver to be loaded by a dynamic import inside `openVenueStateDb`, never at module scope.

- [ ] **Step 4: Write the failing surface test**

`packages/marketplace/venue-base/src/index.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import * as venueBase from "./index.js";
import { VENUE_BASE_NAME } from "./index.js";

describe("venue-base public surface", () => {
  it("names itself for log lines and error messages", () => {
    expect(VENUE_BASE_NAME).toBe("marketplace-venue-base");
  });

  it("loads without touching the SQLite driver at module scope", () => {
    expect(Object.keys(venueBase)).toContain("VENUE_BASE_NAME");
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn install && yarn vitest run`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 6: Create the seed index**

`packages/marketplace/venue-base/src/index.ts`:

```ts
// SPDX-License-Identifier: MIT

// @jinn-network/marketplace-venue-base — the production venue adapters for the canonical Base
// marketplace (operator-daemon composition design §6.1). Signer-injection only: every port
// takes an injected viem WalletClient; this package contains no keystore, no key-loading code,
// and no key material (cross-plan contract 11).

/** Stable identifier used in this package's log lines and error messages. */
export const VENUE_BASE_NAME = "marketplace-venue-base";
```

- [ ] **Step 7: Write the README**

`packages/marketplace/venue-base/README.md`:

```markdown
# @jinn-network/marketplace-venue-base

Production implementations of every venue-facing port the marketplace stack leaves as an
empty socket, for the canonical Base venue (`TaskCoordinator` + `JinnRouterV3`/`V4` + the OLAS
Mech Marketplace). Venue-specific and product-agnostic: it never names a product.

## Custody posture

Signer-injection only. Every port takes an injected viem `WalletClient`. This package contains
no keystore, no key-loading code, and no key material. It reads no environment variable and
imports no filesystem module; its only durable state is one SQLite database opened through the
`better-sqlite3` driver at the caller-supplied `stateDbPath`. **The caller must create the
parent directory before calling `createBaseVenue`** — this package will not create it.

## Single broadcaster

From cutover stage 1 onward this package's Safe broadcast is the only transaction path in the
operator process. Two independent nonce stacks against one Safe and one EOA is the
#525/#562/#897 failure class; it is excluded by construction.

## `withdrawAnnouncement` is local

Today-generation has no on-chain announcement withdrawal. `lifecycle.withdrawAnnouncement`
records an idempotent local marker in the venue state database; the host's projector loop
reads it and emits the signed discovery retraction.
```

- [ ] **Step 8: Verify the package end to end**

Run:
```bash
cd packages/marketplace/binding && yarn build
cd ../venue-base && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke
```
Expected: zero type errors; both tests pass; `dist/index.js` + `dist/index.d.ts` emitted; pack smoke prints the installed-root verification line.

- [ ] **Step 9: Commit**

```bash
git add packages/marketplace/venue-base
git commit -m "feat(marketplace): scaffold the venue-base adapter package

Standalone Yarn project matching the projector's shape: portal resolutions,
build + pack-smoke scripts, root-only export. Seed surface only; ports land
in the tasks that follow.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Guard trio registration and CI wiring

**Files:**
- Modify: `.github/scripts/marketplace-package-inventory.test.mjs`
- Modify: `.github/scripts/marketplace-source-boundaries.test.mjs`
- Modify: `.github/scripts/marketplace-packed-types.test.mjs`
- Modify: `.github/workflows/marketplace-ci.yml`

**Interfaces:**
- Consumes: Task 2's manifest (`@jinn-network/marketplace-venue-base`, five Jinn dependencies, one Jinn devDependency group, root-only export).
- Produces: guard coverage that fails if `venue-base` acquires an unapproved Jinn dependency, imports a forbidden package, uses an ambient network API, uses a locale-sensitive API, adds a non-root export, or breaks the packed-consumer type check. A CI job that installs, typechecks, tests, builds, and pack-smokes the tree.

- [ ] **Step 1: Register the package in the inventory guard**

In `.github/scripts/marketplace-package-inventory.test.mjs`:

(a) `MARKETPLACE_PACKAGES` gains `['venue-base', '@jinn-network/marketplace-venue-base'],` (keep the array's existing order; the test sorts before comparing).

(b) The count assertion `assert.equal(MARKETPLACE_PACKAGES.length, 4);` becomes `assert.equal(MARKETPLACE_PACKAGES.length, 5);` and its test title becomes `'the marketplace package inventory is explicit and has five manifests'`.

(c) `JINN_DEPENDENCY_GRAPH` gains:

```js
  ['venue-base', {
    dependencies: [
      '@jinn-network/marketplace-binding',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-protocol',
    ],
    // Shadow devDependencies: marketplace-binding's own dependency closure needs top-level
    // portal resolutions in a standalone Yarn project.
    devDependencies: [
      '@jinn-network/task-execution-profiles',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    optionalDependencies: [],
    peerDependencies: [],
  }],
```

- [ ] **Step 2: Register the package in the source-boundary guard**

In `.github/scripts/marketplace-source-boundaries.test.mjs`:

(a) `marketplaceDirectories` becomes `['binding', 'projector', 'pipeline', 'testing', 'venue-base']`.

(b) Add the forbidden list beside the others:

```js
// venue-base is a tier-3 venue adapter: it implements ports DECLARED in the binding (including
// the three re-homed at composition-design §6.1) and depends on binding types only. It may
// never import the pipeline (application-shaped composition), the projector (its raw-log output
// type is matched structurally, decision D7, so no dependency edge exists), the conformance kit,
// any record-discovery package, any trust package (settlement-grade verification is host-owned
// and injected), or the embedder-only backend-local internals.
const VENUE_BASE_FORBIDDEN_PACKAGES = [
  '@jinn-network/marketplace-pipeline', '@jinn-network/marketplace-projector',
  '@jinn-network/marketplace-testing',
  '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-testing', '@jinn-network/task-execution-profiles',
  '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
  '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
];
```

(c) Add the boundary test after the `marketplace-testing` one:

```js
test('marketplace-venue-base production source stays within its architecture boundary', () => {
  assertBoundary(join(packages, 'venue-base', 'src'), VENUE_BASE_FORBIDDEN_PACKAGES, APPLICATION_AND_LEGACY_ROOTS);
});
```

(d) In the `'marketplace exports stay root-only…'` test's array, add:

```js
    ['venue-base', '@jinn-network/marketplace-venue-base', ['.']],
```

- [ ] **Step 3: Register the package in the packed-types guard**

In `.github/scripts/marketplace-packed-types.test.mjs`, add `['venue-base', '@jinn-network/marketplace-venue-base'],` to `packages` and `'@jinn-network/marketplace-venue-base',` to `codeEntrypoints`.

- [ ] **Step 4: Run all three guards plus the custody guard**

Run from repo root:
```bash
node --test .github/scripts/marketplace-package-inventory.test.mjs \
            .github/scripts/marketplace-source-boundaries.test.mjs \
            .github/scripts/custody-boundaries.test.mjs
```
Expected: PASS. The custody guard now picks up `packages/marketplace/venue-base` by existence and finds nothing to flag in the seed `index.ts`.

Then:
```bash
node .github/scripts/marketplace-packed-types.test.mjs
```
Expected: `Compiled a packed TypeScript consumer against 8 public code entrypoints across all 5 marketplace packages.`

- [ ] **Step 5: Add the `venue-base` job to `marketplace-ci.yml`**

Insert after the `pipeline:` job, before `testing:`:

```yaml
  venue-base:
    needs: [binding]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Enable Yarn 4.13.0
        run: |
          corepack enable
          corepack prepare yarn@4.13.0 --activate
      - name: Build cross-tree portal dependencies from source (§7.8)
        run: |
          (cd packages/task-execution/protocol && yarn install --immutable && yarn build)
          (cd packages/task-execution/backend && yarn install --immutable && yarn build)
          (cd packages/task-execution/profiles && yarn install --immutable && yarn build)
          (cd packages/trust/core && yarn install --immutable && yarn build)
          (cd packages/trust/resolve && yarn install --immutable && yarn build)
      - name: Restore Marketplace Binding distribution
        uses: actions/download-artifact@v4
        with:
          name: marketplace-binding-dist
          path: packages/marketplace/binding/dist
      - name: Install Marketplace Binding toolchain (packed-smoke dependency)
        working-directory: packages/marketplace/binding
        run: yarn install --immutable
      - name: Verify Marketplace Venue-Base
        working-directory: packages/marketplace/venue-base
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
      - name: Upload Marketplace Venue-Base distribution
        uses: actions/upload-artifact@v4
        with:
          name: marketplace-venue-base-dist
          path: packages/marketplace/venue-base/dist
          if-no-files-found: error
          retention-days: 1
```

- [ ] **Step 6: Extend the `verify` job**

In the `verify:` job: add `venue-base` to `needs`, add `VENUE_BASE_RESULT: ${{ needs.venue-base.result }}` to `env`, add `"$VENUE_BASE_RESULT" \` to the `for result in` list, and change the distribution-placement loop to `for package in binding projector pipeline venue-base testing; do`.

- [ ] **Step 7: Add the custody guard to the architecture job**

In the `architecture:` job, after the source-boundaries step:

```yaml
      - name: Verify custody boundaries
        run: node --test .github/scripts/custody-boundaries.test.mjs
```

and add `- ".github/scripts/custody-boundaries.test.mjs"` to the workflow's `on.push.paths` list.

- [ ] **Step 8: Verify the workflow parses**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/marketplace-ci.yml','utf8'); if(!/venue-base:/.test(y)||!/VENUE_BASE_RESULT/.test(y)) throw new Error('venue-base job or verify wiring missing'); console.log('marketplace-ci.yml carries the venue-base job and verify gate')"`
Expected: `marketplace-ci.yml carries the venue-base job and verify gate`

- [ ] **Step 9: Commit**

```bash
git add .github/scripts/marketplace-package-inventory.test.mjs \
        .github/scripts/marketplace-source-boundaries.test.mjs \
        .github/scripts/marketplace-packed-types.test.mjs \
        .github/workflows/marketplace-ci.yml
git commit -m "chore(guards): register marketplace-venue-base in the guard trio and CI

Ships with the tree, not after (composition design §6). Inventory graph,
source boundary, root-only export, packed-consumer entrypoint, plus a
venue-base CI job and the custody guard wired into the architecture job.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Venue state database and the cross-process broadcast lock

**Files:**
- Create: `packages/marketplace/venue-base/src/state/db.ts`, `src/state/db.test.ts`, `src/state/lock.ts`, `src/state/lock.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `openVenueStateDb(path: string): Promise<VenueStateDb>`
  - `interface VenueStateDb { readonly raw: VenueSqlite; run(sql: string, params?: readonly VenueSqlValue[]): void; get<T>(sql: string, params?: readonly VenueSqlValue[]): T | undefined; all<T>(sql: string, params?: readonly VenueSqlValue[]): T[]; transaction<T>(fn: () => T): T; close(): void }`
  - `type VenueSqlValue = string | number | bigint | Uint8Array | null`
  - `acquireVenueLock(db: VenueStateDb, key: string, options?: { ttlMs?: number; nowMs?: number }): VenueLockHandle | undefined`
  - `interface VenueLockHandle { readonly key: string; readonly ownerToken: string; release(): void; refresh(nowMs?: number): boolean }`
  - `withVenueLock<T>(db: VenueStateDb, key: string, fn: () => Promise<T>, options?: { ttlMs?: number; waitMs?: number; pollMs?: number }): Promise<T>`
  - `class VenueLockTimeoutError extends Error`

Every later store uses `VenueStateDb`; the Safe broadcast (Task 11) serializes on `withVenueLock(db, \`eoa:${chainId}:${from}\`, …)`.

- [ ] **Step 1: Write the failing database test**

`packages/marketplace/venue-base/src/state/db.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "./db.js";

// `node:fs` is used HERE, in a test file, only to make a scratch directory. The custody guard
// skips `*.test.ts`; production source never imports it (decision D1).
let dir: string;
let db: VenueStateDb;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-state-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("venue state database", () => {
  it("creates every table the venue stores need and records its schema version", () => {
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map((row) => row.name);
    expect(tables).toEqual([
      "venue_cursor",
      "venue_delivery_bytes",
      "venue_lifecycle_signals",
      "venue_locks",
      "venue_observations",
      "venue_posting_intents",
      "venue_schema",
      "venue_submission_scopes",
      "venue_tx_submissions",
    ]);
    expect(db.get<{ version: number }>("SELECT version FROM venue_schema")).toEqual({ version: 1 });
  });

  it("is idempotent across reopen", async () => {
    db.close();
    db = await openVenueStateDb(join(dir, "venue.db"));
    expect(db.get<{ version: number }>("SELECT version FROM venue_schema")).toEqual({ version: 1 });
  });

  it("runs in WAL mode so a second process can read while this one writes", () => {
    expect(String(db.raw.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
  });

  it("rolls a transaction back as one unit", () => {
    expect(() => db.transaction(() => {
      db.run("INSERT INTO venue_locks (key, owner_token, expires_at_ms) VALUES (?, ?, ?)", ["a", "t", 1]);
      throw new Error("boom");
    })).toThrow("boom");
    expect(db.all("SELECT key FROM venue_locks")).toEqual([]);
  });

  it("names the missing parent directory instead of creating it", async () => {
    await expect(openVenueStateDb(join(dir, "absent", "venue.db"))).rejects.toThrow(
      /parent directory .* does not exist/,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/state/db.test.ts`
Expected: FAIL — `Cannot find module './db.js'`.

- [ ] **Step 3: Implement the database module**

`packages/marketplace/venue-base/src/state/db.ts`:

```ts
// SPDX-License-Identifier: MIT

// The single durable store every venue adapter shares. Custody posture (decision D1): this
// module never imports a filesystem module, never reads an environment variable, and never
// creates a directory. The SQLite driver is loaded by a DYNAMIC import so that a consumer that
// merely imports this package's surface (the pack smoke runs under `npm install
// --ignore-scripts`, so the native binary is absent) never pays for -- or fails on -- the
// driver.

export type VenueSqlValue = string | number | bigint | Uint8Array | null;

/** The narrow slice of the driver handle this package uses. */
export interface VenueSqlite {
  prepare(sql: string): {
    run(...params: VenueSqlValue[]): { changes: number };
    get(...params: VenueSqlValue[]): unknown;
    all(...params: VenueSqlValue[]): unknown[];
  };
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export interface VenueStateDb {
  readonly raw: VenueSqlite;
  run(sql: string, params?: readonly VenueSqlValue[]): void;
  get<T>(sql: string, params?: readonly VenueSqlValue[]): T | undefined;
  all<T>(sql: string, params?: readonly VenueSqlValue[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS venue_schema (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS venue_cursor (
  stream TEXT NOT NULL, tier TEXT NOT NULL,
  block_number TEXT NOT NULL, block_hash TEXT NOT NULL,
  PRIMARY KEY (stream, tier)
);
CREATE TABLE IF NOT EXISTS venue_locks (
  key TEXT PRIMARY KEY, owner_token TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS venue_tx_submissions (
  chain_id INTEGER NOT NULL, from_address TEXT NOT NULL, nonce INTEGER NOT NULL,
  tx_hash TEXT NOT NULL, logical_tx TEXT NOT NULL, to_address TEXT NOT NULL,
  value TEXT NOT NULL, data TEXT NOT NULL, fees_json TEXT NOT NULL,
  submitted_at_ms INTEGER NOT NULL, resolved_at_ms INTEGER,
  PRIMARY KEY (chain_id, from_address, nonce)
);
CREATE TABLE IF NOT EXISTS venue_posting_intents (
  creator_safe TEXT NOT NULL, task_cid_digest TEXT NOT NULL, submission_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, owner_token TEXT NOT NULL,
  resolved_task_id TEXT, resolved_tx_hash TEXT,
  PRIMARY KEY (creator_safe, task_cid_digest, submission_digest)
);
CREATE TABLE IF NOT EXISTS venue_lifecycle_signals (
  kind TEXT NOT NULL, subject TEXT NOT NULL, payload_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL, PRIMARY KEY (kind, subject)
);
CREATE TABLE IF NOT EXISTS venue_submission_scopes (
  requester TEXT NOT NULL, idempotency_key TEXT NOT NULL, submission_uri TEXT NOT NULL,
  digest TEXT NOT NULL, submission_bytes BLOB NOT NULL, owner_token TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0, outcome_json TEXT,
  PRIMARY KEY (requester, idempotency_key)
);
CREATE TABLE IF NOT EXISTS venue_observations (
  ref TEXT NOT NULL, sequence INTEGER NOT NULL, observation_json TEXT NOT NULL,
  PRIMARY KEY (ref, sequence)
);
CREATE TABLE IF NOT EXISTS venue_delivery_bytes (
  attempt TEXT NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL,
  PRIMARY KEY (attempt, digest)
);
`;

/**
 * Opens (creating the file if absent) the venue state database at `path`. The parent directory
 * must already exist -- this package refuses to create one so its custody surface stays at
 * "driver handle at a caller-supplied path" (decision D1).
 */
export async function openVenueStateDb(path: string): Promise<VenueStateDb> {
  const { default: Database } = await import("better-sqlite3");
  let raw: VenueSqlite;
  try {
    raw = new Database(path) as unknown as VenueSqlite;
  } catch (cause) {
    const separator = path.lastIndexOf("/");
    const parent = separator > 0 ? path.slice(0, separator) : ".";
    throw new Error(
      `venue state database parent directory ${parent} does not exist or is not writable -- `
        + "the host creates it before calling createBaseVenue",
      { cause },
    );
  }
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);
  const existing = raw.prepare("SELECT version FROM venue_schema").get() as
    | { version: number }
    | undefined;
  if (existing === undefined) {
    raw.prepare("INSERT INTO venue_schema (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (existing.version !== SCHEMA_VERSION) {
    raw.close();
    throw new Error(
      `venue state database schema version ${existing.version} is not ${SCHEMA_VERSION}`,
    );
  }

  return {
    raw,
    run(sql, params = []) { raw.prepare(sql).run(...params); },
    get<T>(sql: string, params: readonly VenueSqlValue[] = []) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, params: readonly VenueSqlValue[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    transaction<T>(fn: () => T) { return raw.transaction(fn)(); },
    close() { raw.close(); },
  };
}
```

- [ ] **Step 4: Run the database test**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/state/db.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing lock test**

`packages/marketplace/venue-base/src/state/lock.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "./db.js";
import { VenueLockTimeoutError, acquireVenueLock, withVenueLock } from "./lock.js";

let dir: string;
let db: VenueStateDb;
let other: VenueStateDb;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-lock-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
  other = await openVenueStateDb(join(dir, "venue.db"));
});
afterEach(() => {
  db.close();
  other.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("cross-process venue lock", () => {
  it("refuses a second holder across two independent handles on the same file", () => {
    const held = acquireVenueLock(db, "eoa:84532:0xabc", { ttlMs: 60_000, nowMs: 1_000 });
    expect(held).toBeDefined();
    expect(acquireVenueLock(other, "eoa:84532:0xabc", { ttlMs: 60_000, nowMs: 1_000 })).toBeUndefined();
    held!.release();
    expect(acquireVenueLock(other, "eoa:84532:0xabc", { ttlMs: 60_000, nowMs: 1_000 })).toBeDefined();
  });

  it("steals an expired lock so a crashed holder cannot wedge the broadcaster forever", () => {
    acquireVenueLock(db, "eoa:84532:0xabc", { ttlMs: 1_000, nowMs: 1_000 });
    expect(acquireVenueLock(other, "eoa:84532:0xabc", { ttlMs: 1_000, nowMs: 1_500 })).toBeUndefined();
    expect(acquireVenueLock(other, "eoa:84532:0xabc", { ttlMs: 1_000, nowMs: 2_001 })).toBeDefined();
  });

  it("refresh extends only the current owner's lease", () => {
    const held = acquireVenueLock(db, "k", { ttlMs: 1_000, nowMs: 1_000 })!;
    expect(held.refresh(1_500)).toBe(true);
    expect(acquireVenueLock(other, "k", { ttlMs: 1_000, nowMs: 2_001 })).toBeUndefined();
    held.release();
    expect(held.refresh(2_500)).toBe(false);
  });

  it("releases the lock even when the guarded body throws", async () => {
    await expect(withVenueLock(db, "k", async () => { throw new Error("inner"); })).rejects.toThrow("inner");
    expect(acquireVenueLock(other, "k", { ttlMs: 1_000, nowMs: 1_000 })).toBeDefined();
  });

  it("times out rather than blocking forever on a live holder", async () => {
    acquireVenueLock(db, "k", { ttlMs: 60_000 });
    await expect(withVenueLock(other, "k", async () => "never", { waitMs: 30, pollMs: 10 }))
      .rejects.toBeInstanceOf(VenueLockTimeoutError);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/state/lock.test.ts`
Expected: FAIL — `Cannot find module './lock.js'`.

- [ ] **Step 7: Implement the lock**

`packages/marketplace/venue-base/src/state/lock.ts`:

```ts
// SPDX-License-Identifier: MIT

// The cross-process serializer the single-broadcaster rule needs (composition design §6.1).
// An advisory lease row in the shared state database rather than a file lock: the legacy
// daemon's per-EOA serialization was in-process Promise chaining only, so two daemon processes
// sharing one EOA were unprotected -- the #525/#562/#897 failure class. A lease has a TTL so a
// crashed holder cannot wedge the broadcaster forever.
import type { VenueStateDb } from "./db.js";

export const DEFAULT_VENUE_LOCK_TTL_MS = 120_000;
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 50;

export class VenueLockTimeoutError extends Error {
  constructor(readonly key: string, readonly waitMs: number) {
    super(`timed out after ${waitMs}ms waiting for venue lock "${key}"`);
    this.name = "VenueLockTimeoutError";
  }
}

export interface VenueLockHandle {
  readonly key: string;
  readonly ownerToken: string;
  release(): void;
  /** Extends this owner's lease; returns false once the lease is lost or released. */
  refresh(nowMs?: number): boolean;
}

/** Atomically takes the lease, or returns undefined when a live one is held elsewhere. */
export function acquireVenueLock(
  db: VenueStateDb,
  key: string,
  options: { ttlMs?: number; nowMs?: number } = {},
): VenueLockHandle | undefined {
  const ttlMs = options.ttlMs ?? DEFAULT_VENUE_LOCK_TTL_MS;
  const nowMs = options.nowMs ?? Date.now();
  const ownerToken = `venue-lock:${crypto.randomUUID()}`;
  const taken = db.transaction(() => {
    db.run("DELETE FROM venue_locks WHERE key = ? AND expires_at_ms <= ?", [key, nowMs]);
    const existing = db.get<{ key: string }>("SELECT key FROM venue_locks WHERE key = ?", [key]);
    if (existing !== undefined) return false;
    db.run(
      "INSERT INTO venue_locks (key, owner_token, expires_at_ms) VALUES (?, ?, ?)",
      [key, ownerToken, nowMs + ttlMs],
    );
    return true;
  });
  if (!taken) return undefined;
  return {
    key,
    ownerToken,
    release() {
      db.run("DELETE FROM venue_locks WHERE key = ? AND owner_token = ?", [key, ownerToken]);
    },
    refresh(at = Date.now()) {
      return db.transaction(() => {
        const owned = db.get<{ key: string }>(
          "SELECT key FROM venue_locks WHERE key = ? AND owner_token = ?",
          [key, ownerToken],
        );
        if (owned === undefined) return false;
        db.run(
          "UPDATE venue_locks SET expires_at_ms = ? WHERE key = ? AND owner_token = ?",
          [at + ttlMs, key, ownerToken],
        );
        return true;
      });
    },
  };
}

/** Runs `fn` under the lease, releasing it on every exit path. */
export async function withVenueLock<T>(
  db: VenueStateDb,
  key: string,
  fn: () => Promise<T>,
  options: { ttlMs?: number; waitMs?: number; pollMs?: number } = {},
): Promise<T> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const handle = acquireVenueLock(db, key, { ttlMs: options.ttlMs });
    if (handle !== undefined) {
      try {
        return await fn();
      } finally {
        handle.release();
      }
    }
    if (Date.now() >= deadline) throw new VenueLockTimeoutError(key, waitMs);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
```

- [ ] **Step 8: Run the lock test and export the surface**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/state/lock.test.ts`
Expected: PASS (5 tests).

Append to `src/index.ts`:

```ts
export { openVenueStateDb } from "./state/db.js";
export type { VenueSqlValue, VenueSqlite, VenueStateDb } from "./state/db.js";
export {
  DEFAULT_VENUE_LOCK_TTL_MS,
  VenueLockTimeoutError,
  acquireVenueLock,
  withVenueLock,
} from "./state/lock.js";
export type { VenueLockHandle } from "./state/lock.js";
```

- [ ] **Step 9: Verify the package and the custody guard**

Run:
```bash
cd packages/marketplace/venue-base && yarn typecheck && yarn test
cd ../../.. && node --test .github/scripts/custody-boundaries.test.mjs .github/scripts/marketplace-source-boundaries.test.mjs
```
Expected: all PASS. The custody guard must stay green — production source imports no `node:fs` and reads no `process.env`.

- [ ] **Step 10: Commit**

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): the venue state database and cross-process broadcast lock

One SQLite file behind a dynamic driver import (no node:fs, no process.env
in production source) plus a TTL lease that serializes the Safe broadcaster
across processes -- the gap the legacy in-process promise chain left open.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Anvil-fork venue harness in the conformance kit

**Files:**
- Create: `packages/marketplace/testing/src/venue-anvil.ts`, `packages/marketplace/testing/src/venue-anvil.test.ts`
- Modify: `packages/marketplace/testing/package.json` (`./venue-anvil` export)
- Modify: `.github/scripts/marketplace-source-boundaries.test.mjs` (testing's export list)
- Modify: `.github/scripts/marketplace-packed-types.test.mjs` (`./venue-anvil` entrypoint)

**Interfaces:**
- Consumes: `BASE_SEPOLIA_TODAY` from `@jinn-network/marketplace-binding`.
- Produces:
  - `startVenueFork(options?: { rpcUrl?: string; port?: number }): Promise<VenueFork | undefined>` — `undefined` when `anvil` is not on PATH or no candidate RPC answers, so every kit suite skips cleanly.
  - `interface VenueFork { readonly rpcUrl: string; readonly chain: MarketplaceChainConfig; readonly publicClient: PublicClient; readonly walletClient: WalletClient; readonly signer: Address; readonly safeAddress: Address; readonly stateDir: string; mine(blocks: number): Promise<void>; setBalance(address: Address, wei: bigint): Promise<void>; impersonate(address: Address): Promise<void>; stop(): void }`
  - `const VENUE_FORK_SIGNER_KEY` — Anvil dev account #0's well-known burned key, used only inside the kit.

- [ ] **Step 1: Write the failing harness test**

`packages/marketplace/testing/src/venue-anvil.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { startVenueFork, type VenueFork } from "./venue-anvil.js";

const fork: VenueFork | undefined = await startVenueFork();

describe.runIf(fork !== undefined)("venue Anvil fork harness", () => {
  it("exposes a live fork of the today-generation chain with a 1-of-1 Safe", async () => {
    const live = fork!;
    expect(live.chain.chainId).toBe(84532);
    expect(await live.publicClient.getChainId()).toBe(84532);
    const safeCode = await live.publicClient.getCode({ address: live.safeAddress });
    expect(safeCode).toBeDefined();
    expect(safeCode).not.toBe("0x");
  });

  it("mines on demand so block-tag assertions are deterministic", async () => {
    const live = fork!;
    const before = await live.publicClient.getBlockNumber();
    await live.mine(3);
    expect(await live.publicClient.getBlockNumber()).toBe(before + 3n);
  });

  it("funds an arbitrary address", async () => {
    const live = fork!;
    const target = "0x00000000000000000000000000000000000000aa" as const;
    await live.setBalance(target, 5n * 10n ** 18n);
    expect(await live.publicClient.getBalance({ address: target })).toBe(5n * 10n ** 18n);
  });
});

describe.runIf(fork === undefined)("venue Anvil fork harness (unavailable)", () => {
  it("skips cleanly when anvil or the fork endpoint is absent", () => {
    expect(fork).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/testing && yarn vitest run src/venue-anvil.test.ts`
Expected: FAIL — `Cannot find module './venue-anvil.js'`.

- [ ] **Step 3: Implement the harness**

`packages/marketplace/testing/src/venue-anvil.ts`:

```ts
// SPDX-License-Identifier: MIT

// The Anvil-fork backbone for the venue conformance kit (composition design §6.6:
// "integration-over-mocks is the ratified rule for migration surfaces"). Forks Base Sepolia at
// head so every suite runs against the REAL deployed today-generation contracts named by
// BASE_SEPOLIA_TODAY, then deploys a fresh 1-of-1 Safe owned by Anvil dev account #0. Returns
// undefined -- never throws -- when anvil or the endpoint is unavailable, so suites skip.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_SEPOLIA_TODAY,
  SAFE_ABI,
  type MarketplaceChainConfig,
} from "@jinn-network/marketplace-binding";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/** Anvil's default dev account #0 -- a publicly burned key, valid only against a local fork. */
export const VENUE_FORK_SIGNER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const SAFE_SINGLETON = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552" as const;
const SAFE_PROXY_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const DEFAULT_PORT = 8599;

const SAFE_SETUP_ABI = [{
  type: "function", name: "setup", stateMutability: "nonpayable",
  inputs: [
    { name: "_owners", type: "address[]" }, { name: "_threshold", type: "uint256" },
    { name: "to", type: "address" }, { name: "data", type: "bytes" },
    { name: "fallbackHandler", type: "address" }, { name: "paymentToken", type: "address" },
    { name: "payment", type: "uint256" }, { name: "paymentReceiver", type: "address" },
  ],
  outputs: [],
}] as const;

const SAFE_FACTORY_ABI = [{
  type: "function", name: "createProxyWithNonce", stateMutability: "nonpayable",
  inputs: [
    { name: "_singleton", type: "address" }, { name: "initializer", type: "bytes" },
    { name: "saltNonce", type: "uint256" },
  ],
  outputs: [{ name: "proxy", type: "address" }],
}] as const;

export interface VenueFork {
  readonly rpcUrl: string;
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly signer: Address;
  readonly safeAddress: Address;
  /** A scratch directory the caller may put a venue state database in. */
  readonly stateDir: string;
  mine(blocks: number): Promise<void>;
  setBalance(address: Address, wei: bigint): Promise<void>;
  impersonate(address: Address): Promise<void>;
  stop(): void;
}

const FORK_RPC_CANDIDATES = [
  "https://base-sepolia.publicnode.com",
  "https://sepolia.base.org",
];

async function anvilOnPath(): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = spawn("anvil", ["--version"]);
    probe.once("error", () => resolve(false));
    probe.once("exit", (code) => resolve(code === 0));
  });
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
}

async function ready(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpcCall(url, "eth_chainId", []);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return false;
}

/** Starts the fork, or returns undefined so the caller's suite skips cleanly. */
export async function startVenueFork(
  options: { rpcUrl?: string; port?: number } = {},
): Promise<VenueFork | undefined> {
  if (!await anvilOnPath()) return undefined;
  const port = options.port ?? DEFAULT_PORT;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const candidates = options.rpcUrl === undefined
    ? FORK_RPC_CANDIDATES
    : [options.rpcUrl, ...FORK_RPC_CANDIDATES];

  let child: ChildProcess | undefined;
  for (const candidate of candidates) {
    child = spawn("anvil", ["--fork-url", candidate, "--port", String(port), "--silent"]);
    if (await ready(rpcUrl, 30_000)) break;
    child.kill("SIGKILL");
    child = undefined;
  }
  if (child === undefined) return undefined;

  const account = privateKeyToAccount(VENUE_FORK_SIGNER_KEY);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: baseSepolia, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  const stop = (): void => { child?.kill("SIGKILL"); };

  const factoryCode = await publicClient.getCode({ address: SAFE_PROXY_FACTORY });
  const singletonCode = await publicClient.getCode({ address: SAFE_SINGLETON });
  if (factoryCode === undefined || factoryCode === "0x" || singletonCode === undefined || singletonCode === "0x") {
    stop();
    return undefined;
  }

  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: "setup",
    args: [[account.address], 1n, ZERO, "0x", ZERO, ZERO, 0n, ZERO],
  });
  const { result: safeAddress } = await publicClient.simulateContract({
    address: SAFE_PROXY_FACTORY, abi: SAFE_FACTORY_ABI, functionName: "createProxyWithNonce",
    args: [SAFE_SINGLETON, initializer, BigInt(Date.now())], account,
  });
  const deployHash = await walletClient.writeContract({
    address: SAFE_PROXY_FACTORY, abi: SAFE_FACTORY_ABI, functionName: "createProxyWithNonce",
    args: [SAFE_SINGLETON, initializer, BigInt(Date.now())], account, chain: baseSepolia,
  });
  await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const owns = await publicClient.readContract({
    address: safeAddress as Address, abi: SAFE_ABI, functionName: "isOwner", args: [account.address],
  });
  if (owns !== true) { stop(); return undefined; }

  return {
    rpcUrl,
    chain: BASE_SEPOLIA_TODAY,
    publicClient,
    walletClient,
    signer: account.address,
    safeAddress: safeAddress as Address,
    stateDir: mkdtempSync(join(tmpdir(), "venue-fork-state-")),
    async mine(blocks) { await rpcCall(rpcUrl, "anvil_mine", [`0x${blocks.toString(16)}`]); },
    async setBalance(address, wei) {
      await rpcCall(rpcUrl, "anvil_setBalance", [address, `0x${wei.toString(16)}`]);
    },
    async impersonate(address) { await rpcCall(rpcUrl, "anvil_impersonateAccount", [address]); },
    stop,
  };
}

export type { Hex };
```

- [ ] **Step 4: Wire the export subpath**

In `packages/marketplace/testing/package.json`, add to `exports` (keeping alphabetical order among the conformance subpaths):

```json
    "./venue-anvil": {
      "import": "./dist/venue-anvil.js",
      "types": "./dist/venue-anvil.d.ts"
    },
```

and add to `dependencies`: `"@jinn-network/marketplace-venue-base": "0.1.0",` with the matching `"resolutions"` entry `"@jinn-network/marketplace-venue-base": "portal:../venue-base"`. (The dependency is unused until Task 7's kit case; declaring it now keeps the manifest and the guard in one commit.)

Update `.github/scripts/marketplace-source-boundaries.test.mjs`'s testing export list to
`['.', './backend-conformance', './named-check-fixtures', './projector-conformance', './revised-contract-conformance', './venue-anvil']`,
and `.github/scripts/marketplace-package-inventory.test.mjs`'s `testing` graph entry `dependencies` array to include `'@jinn-network/marketplace-venue-base'` (sorted).

- [ ] **Step 5: Run the harness test**

Run:
```bash
cd packages/marketplace/venue-base && yarn build
cd ../testing && yarn install && yarn typecheck && yarn vitest run src/venue-anvil.test.ts
```
Expected: with Foundry installed, 3 tests PASS. Without `anvil`, the single "skips cleanly" test PASSes.

- [ ] **Step 6: Run the guards**

Run from repo root:
```bash
node --test .github/scripts/marketplace-package-inventory.test.mjs .github/scripts/marketplace-source-boundaries.test.mjs
```
Expected: PASS. `venue-anvil.ts` uses `spawn`, `node:fs`, and ambient `fetch`, all of which the source-boundary guard permits in `testing` (it is a kit, not production venue source; the ambient-network check exempts nothing in `testing`, so verify: if the guard flags `fetch` in `testing/src`, move the JSON-RPC calls behind a `fetchImpl` parameter defaulted at the **call site in the `.test.ts` file** rather than in `venue-anvil.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/testing .github/scripts/marketplace-package-inventory.test.mjs \
        .github/scripts/marketplace-source-boundaries.test.mjs
git commit -m "test(marketplace): Anvil-fork backbone for the venue conformance kit

Forks Base Sepolia against the real deployed today-generation contracts and
deploys a fresh 1-of-1 Safe. Returns undefined rather than throwing when
Foundry or the endpoint is absent, so every venue suite skips cleanly.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The legacy-behavior fixture corpus

**Files:**
- Create: `packages/marketplace/testing/src/venue-fixtures.ts`, `packages/marketplace/testing/src/venue-fixtures.test.ts`
- Modify: `packages/marketplace/testing/package.json` (`./venue-fixtures` export)
- Modify: `.github/scripts/marketplace-source-boundaries.test.mjs`, `.github/scripts/marketplace-packed-types.test.mjs`

**Interfaces:**
- Consumes: `KNOWN_INNER_ERRORS` from `@jinn-network/marketplace-binding`.
- Produces:
  - `REVERT_CLASSIFICATION_FIXTURES: readonly RevertClassificationCase[]` where `interface RevertClassificationCase { readonly name: string; readonly message: string; readonly decodedName: string | null; readonly innerSelector: string | null; readonly expected: "retryable" | "terminal" }`
  - `TERMINAL_INNER_REVERT_NAMES: readonly string[]` and `RETRYABLE_INNER_REVERT_NAMES: readonly string[]`
  - `NONCE_RECOVERY_FIXTURES: readonly NonceRecoveryCase[]` where `interface NonceRecoveryCase { readonly name: string; readonly errorMessage: string; readonly ledgerEntry?: { readonly to: string; readonly data: string; readonly mined: boolean }; readonly request: { readonly to: string; readonly data: string }; readonly expected: "reconciled" | "refresh-nonce-and-resign" | "terminal" }`
  - `CHUNK_ARITHMETIC_FIXTURES: readonly ChunkCase[]` where `interface ChunkCase { readonly name: string; readonly from: bigint; readonly to: bigint; readonly chunkBlocks: bigint; readonly expected: readonly (readonly [bigint, bigint])[] }`
  - `PROVIDER_CHUNK_CAPS: Readonly<Record<string, bigint>>`

These fixture tables are the whole point of the fresh rewrite staying safe (design §6.6). They are data only — no venue-base import.

- [ ] **Step 1: Write the fixture module**

`packages/marketplace/testing/src/venue-fixtures.ts`:

```ts
// SPDX-License-Identifier: MIT

// Legacy behavior as fixtures, never as ported code (composition design §6.6, cross-plan
// contract 12). Every table below is a transcription of behavior proven in the legacy
// adapter -- `client/src/adapters/mech/{safe,safe-revert,contracts}.ts`, `client/src/tx-retry.ts`,
// `client/src/discovery/onchain.ts` -- which the fresh venue-base implementation must satisfy.

export interface RevertClassificationCase {
  readonly name: string;
  readonly message: string;
  readonly decodedName: string | null;
  readonly innerSelector: string | null;
  readonly expected: "retryable" | "terminal";
}

/**
 * `RouterNotDelivered` is the ONE inner revert the legacy classifier retried: the Mech's
 * delivery had simply not landed yet. Every other decoded router/coordinator error is a
 * deterministic refusal, and so is an UNDECODED selector -- an inner revert we cannot name is
 * still an inner revert, and retrying it burns gas forever (legacy tx-retry.ts step 3).
 */
export const RETRYABLE_INNER_REVERT_NAMES: readonly string[] = ["RouterNotDelivered"];

/** The legacy permanent set: the mech-era names plus every Router*/TC* error but RouterNotDelivered. */
export const TERMINAL_INNER_REVERT_NAMES: readonly string[] = [
  "JobAlreadyClaimed", "IneligibleToClaim", "NoClaimExists", "NotClaimOwner",
  "DeliveryAlreadyClaimed", "AlreadyClaimed", "RequestNotFound",
  "RouterZeroAddress", "RouterZeroValue", "RouterAlreadyInitialized", "RouterNotInitialized",
  "RouterOwnerOnly", "RouterTaskNotFound", "RouterTaskNotRefundable", "RouterRefundFailed",
  "RouterInvalidPaymentType", "RouterInvalidOperatorMech", "RouterInsufficientTaskBudget",
  "RouterRequestNotFound", "RouterAlreadyClaimed", "RouterWrongRequester",
  "RouterWrongDeliveryOperator", "RouterWrongRequestKind",
  "TCZeroAddress", "TCZeroValue", "TCAlreadyInitialized", "TCNotInitialized", "TCOwnerOnly",
  "TCRouterOnly", "TCTaskNotFound", "TCInvalidWindow", "TCInvalidPolicy", "TCTaskNotOpen",
  "TCClaimWindowClosed", "TCSubmissionDeadlinePassed", "TCEvaluationDeadlinePassed",
  "TCMaxClaimsReached", "TCOperatorClaimLimitReached", "TCPolicyHookRejected",
  "TCAttemptNotFound", "TCAttemptNotSubmitted", "TCAttemptNotClaimed", "TCAttemptNotRegistered",
  "TCAttemptAlreadyRegistered", "TCAttemptAlreadySubmitted", "TCAttemptAlreadyFinalized",
  "TCRequestAlreadyRegistered", "TCRequestNotFound", "TCNotAttemptOperator",
  "TCClaimNotExpired", "TCAttemptClaimExpired", "TCSolverSelfEvaluation",
  "TCEvaluatorClaimLimitReached", "TCMaxVerdictsReached", "TCVerdictNotFound",
  "TCVerdictAlreadyRegistered", "TCVerdictAlreadyDelivered", "TCVerdictNotRegistered",
  "TCNotVerdictEvaluator", "TCInvalidVerdictCode", "TCVerdictClaimExpired",
];

export const REVERT_CLASSIFICATION_FIXTURES: readonly RevertClassificationCase[] = [
  { name: "insufficient funds is terminal", message: "insufficient funds for gas * price + value", decodedName: null, innerSelector: null, expected: "terminal" },
  { name: "user rejection is terminal", message: "User rejected the request", decodedName: null, innerSelector: null, expected: "terminal" },
  { name: "GS013 (execution failed) is terminal", message: "execution reverted: GS013", decodedName: null, innerSelector: null, expected: "terminal" },
  { name: "GS026 (invalid owner signature) is terminal", message: "execution reverted: GS026", decodedName: null, innerSelector: null, expected: "terminal" },
  { name: "a decoded permanent inner revert is terminal", message: "Safe execTransaction inner revert: TCMaxClaimsReached(7)", decodedName: "TCMaxClaimsReached", innerSelector: "0x90386e7c", expected: "terminal" },
  { name: "RouterNotDelivered is the sole retryable inner revert", message: "Safe execTransaction inner revert: RouterNotDelivered(0xabc)", decodedName: "RouterNotDelivered", innerSelector: "0xe5a88624", expected: "retryable" },
  { name: "an undecoded inner selector is terminal, not a guess", message: "Safe execTransaction inner revert (estimate, undecoded selector 0xdeadbeef)", decodedName: null, innerSelector: "0xdeadbeef", expected: "terminal" },
  { name: "stale Safe nonce or signature race is retryable", message: "Safe execTransaction reverted (possible stale Safe nonce or signature race)", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "replacement transaction underpriced is retryable", message: "replacement transaction underpriced", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "fee cap below base fee is retryable", message: "max fee per gas less than block base fee", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "nonce too low is retryable", message: "nonce too low", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "already known is retryable", message: "already known", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "socket hang up is retryable", message: "socket hang up", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "fetch failed is retryable", message: "fetch failed", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "empty return data is retryable", message: 'returned no data ("0x")', decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "rate limiting is retryable", message: "429 Too Many Requests", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "internal JSON-RPC error is retryable", message: "Internal JSON-RPC error (-32603)", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "service unavailable is retryable", message: "503 Service Unavailable", decodedName: null, innerSelector: null, expected: "retryable" },
  { name: "an unrecognized message is terminal by default", message: "something nobody has classified", decodedName: null, innerSelector: null, expected: "terminal" },
];

export interface NonceRecoveryCase {
  readonly name: string;
  readonly errorMessage: string;
  readonly ledgerEntry?: { readonly to: string; readonly data: string; readonly mined: boolean };
  readonly request: { readonly to: string; readonly data: string };
  readonly expected: "reconciled" | "refresh-nonce-and-resign" | "terminal";
}

const SAFE_A = "0x00000000000000000000000000000000000000a1";
const SAFE_B = "0x00000000000000000000000000000000000000b2";

/**
 * The subtlest legacy behavior, and the one a rewrite most easily loses: on nonce-too-low or
 * replacement-underpriced, read the ledger at the ORIGINAL pinned nonce BEFORE refreshing it,
 * and adopt the recorded hash only when BOTH `to` and `data` match this request -- the ledger
 * is shared across every logical transaction and keyed on the EOA nonce alone.
 */
export const NONCE_RECOVERY_FIXTURES: readonly NonceRecoveryCase[] = [
  {
    name: "nonce-too-low with a matching mined ledger entry reconciles to that hash",
    errorMessage: "nonce too low",
    ledgerEntry: { to: SAFE_A, data: "0xdeadbeef", mined: true },
    request: { to: SAFE_A, data: "0xdeadbeef" },
    expected: "reconciled",
  },
  {
    name: "nonce-too-low with a FOREIGN ledger entry never adopts it",
    errorMessage: "nonce too low",
    ledgerEntry: { to: SAFE_B, data: "0xdeadbeef", mined: true },
    request: { to: SAFE_A, data: "0xdeadbeef" },
    expected: "refresh-nonce-and-resign",
  },
  {
    name: "nonce-too-low whose ledger entry has the same target but different calldata never adopts it",
    errorMessage: "nonce too low",
    ledgerEntry: { to: SAFE_A, data: "0xcafebabe", mined: true },
    request: { to: SAFE_A, data: "0xdeadbeef" },
    expected: "refresh-nonce-and-resign",
  },
  {
    name: "nonce-too-low with a matching but unmined entry refreshes and re-signs",
    errorMessage: "nonce too low",
    ledgerEntry: { to: SAFE_A, data: "0xdeadbeef", mined: false },
    request: { to: SAFE_A, data: "0xdeadbeef" },
    expected: "refresh-nonce-and-resign",
  },
  {
    name: "nonce-too-low with no ledger entry refreshes and re-signs",
    errorMessage: "nonce too low",
    request: { to: SAFE_A, data: "0xdeadbeef" },
    expected: "refresh-nonce-and-resign",
  },
  {
    name: "replacement-underpriced follows the same reconcile-first path",
    errorMessage: "replacement transaction underpriced",
    ledgerEntry: { to: SAFE_A, data: "0xdeadbeef", mined: true },
    request: { to: SAFE_A, data: "0xdeadbeef" },
    expected: "reconciled",
  },
  {
    name: "GS026 with a non-owner signer is terminal, never a nonce problem",
    errorMessage: "execution reverted: GS026",
    request: { to: SAFE_A, data: "0xdeadbeef" },
    expected: "terminal",
  },
];

export interface ChunkCase {
  readonly name: string;
  readonly from: bigint;
  readonly to: bigint;
  readonly chunkBlocks: bigint;
  readonly expected: readonly (readonly [bigint, bigint])[];
}

/**
 * Provider `eth_getLogs` block-range caps the legacy adapter learned the hard way (#807).
 * `sepolia.base.org` caps at 2000, so the legacy scan chose 1000 -- small enough that EVERY
 * provider in the fallback chain accepts it and the cursor always advances.
 */
export const PROVIDER_CHUNK_CAPS: Readonly<Record<string, bigint>> = {
  "sepolia.base.org": 2_000n,
  "base-sepolia.publicnode.com": 50_000n,
};

/**
 * Chunk ranges are inclusive on both ends and exactly `chunkBlocks` wide, so a chunk width never
 * exceeds a provider's cap. (The legacy oldest-first loop emitted `chunk + 1` blocks per range;
 * the rewrite fixes the off-by-one deliberately and this table is the pin.)
 */
export const CHUNK_ARITHMETIC_FIXTURES: readonly ChunkCase[] = [
  { name: "a single block", from: 100n, to: 100n, chunkBlocks: 1_000n, expected: [[100n, 100n]] },
  { name: "a range shorter than one chunk", from: 100n, to: 500n, chunkBlocks: 1_000n, expected: [[100n, 500n]] },
  { name: "a range exactly one chunk wide", from: 0n, to: 999n, chunkBlocks: 1_000n, expected: [[0n, 999n]] },
  { name: "a range one block past one chunk", from: 0n, to: 1_000n, chunkBlocks: 1_000n, expected: [[0n, 999n], [1_000n, 1_000n]] },
  { name: "three whole chunks", from: 0n, to: 2_999n, chunkBlocks: 1_000n, expected: [[0n, 999n], [1_000n, 1_999n], [2_000n, 2_999n]] },
  { name: "an inverted range yields nothing", from: 500n, to: 400n, chunkBlocks: 1_000n, expected: [] },
  { name: "a cap-sized chunk never exceeds the provider cap", from: 1n, to: 4_000n, chunkBlocks: 2_000n, expected: [[1n, 2_000n], [2_001n, 4_000n]] },
];
```

- [ ] **Step 2: Write the fixture self-consistency test**

`packages/marketplace/testing/src/venue-fixtures.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { KNOWN_INNER_ERRORS } from "@jinn-network/marketplace-binding";
import { describe, expect, it } from "vitest";
import {
  CHUNK_ARITHMETIC_FIXTURES,
  NONCE_RECOVERY_FIXTURES,
  PROVIDER_CHUNK_CAPS,
  RETRYABLE_INNER_REVERT_NAMES,
  REVERT_CLASSIFICATION_FIXTURES,
  TERMINAL_INNER_REVERT_NAMES,
} from "./venue-fixtures.js";

describe("venue fixture corpus", () => {
  it("partitions every name the binding can decode into retryable or terminal", () => {
    const decodable = new Set(Object.values(KNOWN_INNER_ERRORS).map((entry) => entry.name));
    const classified = new Set([...RETRYABLE_INNER_REVERT_NAMES, ...TERMINAL_INNER_REVERT_NAMES]);
    const unclassified = [...decodable].filter((name) => !classified.has(name)).sort();
    expect(unclassified).toEqual([]);
  });

  it("never lists a name as both retryable and terminal", () => {
    const terminal = new Set(TERMINAL_INNER_REVERT_NAMES);
    expect(RETRYABLE_INNER_REVERT_NAMES.filter((name) => terminal.has(name))).toEqual([]);
  });

  it("keeps RouterNotDelivered the only retryable inner revert", () => {
    expect(RETRYABLE_INNER_REVERT_NAMES).toEqual(["RouterNotDelivered"]);
  });

  it("covers both classification outcomes and every documented trigger family", () => {
    const outcomes = new Set(REVERT_CLASSIFICATION_FIXTURES.map((c) => c.expected));
    expect([...outcomes].sort()).toEqual(["retryable", "terminal"]);
    expect(REVERT_CLASSIFICATION_FIXTURES.length).toBeGreaterThanOrEqual(19);
  });

  it("covers every nonce-recovery outcome including the foreign-ledger refusal", () => {
    const outcomes = new Set(NONCE_RECOVERY_FIXTURES.map((c) => c.expected));
    expect([...outcomes].sort()).toEqual(["reconciled", "refresh-nonce-and-resign", "terminal"]);
    const foreign = NONCE_RECOVERY_FIXTURES.filter(
      (c) => c.ledgerEntry !== undefined && c.ledgerEntry.mined
        && (c.ledgerEntry.to !== c.request.to || c.ledgerEntry.data !== c.request.data),
    );
    expect(foreign.length).toBe(2);
    expect(foreign.every((c) => c.expected === "refresh-nonce-and-resign")).toBe(true);
  });

  it("keeps every expected chunk within its declared width and contiguous", () => {
    for (const fixture of CHUNK_ARITHMETIC_FIXTURES) {
      let previousEnd: bigint | undefined;
      for (const [start, end] of fixture.expected) {
        expect(end - start + 1n).toBeLessThanOrEqual(fixture.chunkBlocks);
        expect(start).toBeLessThanOrEqual(end);
        if (previousEnd !== undefined) expect(start).toBe(previousEnd + 1n);
        previousEnd = end;
      }
      if (fixture.expected.length > 0) {
        expect(fixture.expected[0]![0]).toBe(fixture.from);
        expect(previousEnd).toBe(fixture.to);
      }
    }
  });

  it("keeps the default chunk width inside the tightest provider cap", () => {
    const tightest = Object.values(PROVIDER_CHUNK_CAPS).reduce((a, b) => (a < b ? a : b));
    expect(tightest).toBe(2_000n);
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd packages/marketplace/testing && yarn vitest run src/venue-fixtures.test.ts`
Expected: FAIL first (module missing), then PASS after Step 1's file exists. Run once before creating the file to see the red, then again.

- [ ] **Step 4: Wire the export subpath and guards**

In `packages/marketplace/testing/package.json` add:
```json
    "./venue-fixtures": {
      "import": "./dist/venue-fixtures.js",
      "types": "./dist/venue-fixtures.d.ts"
    },
```

Add `'./venue-fixtures'` to the testing export list in `.github/scripts/marketplace-source-boundaries.test.mjs`, and `'@jinn-network/marketplace-testing/venue-fixtures',` to `codeEntrypoints` in `.github/scripts/marketplace-packed-types.test.mjs`.

- [ ] **Step 5: Verify**

Run:
```bash
cd packages/marketplace/testing && yarn typecheck && yarn vitest run src/venue-fixtures.test.ts
cd ../../.. && node --test .github/scripts/marketplace-source-boundaries.test.mjs
```
Expected: 7 tests PASS; guard PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/testing .github/scripts/marketplace-source-boundaries.test.mjs \
        .github/scripts/marketplace-packed-types.test.mjs
git commit -m "test(marketplace): the legacy-behavior fixture corpus for the venue rewrite

Revert classification (RouterNotDelivered the sole retryable; undecoded
selectors terminal), nonce/eviction recovery including the foreign-ledger
refusal, and the RPC chunk-arithmetic table with provider caps. Data only --
no legacy code is ported (design §6.6).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Chunk arithmetic and the dual reorg-aware cursor

**Files:**
- Create: `packages/marketplace/venue-base/src/chain/chunking.ts`, `src/chain/chunking.test.ts`, `src/chain/cursor.ts`, `src/chain/cursor.test.ts`
- Create: `packages/marketplace/testing/src/venue-conformance.ts`, `packages/marketplace/testing/src/venue-conformance.test.ts`
- Modify: `packages/marketplace/testing/package.json`, `packages/marketplace/venue-base/src/index.ts`, the two guard scripts

**Interfaces:**
- Consumes: `CHUNK_ARITHMETIC_FIXTURES`, `PROVIDER_CHUNK_CAPS` from `@jinn-network/marketplace-testing/venue-fixtures`.
- Produces:
  - `DEFAULT_CHUNK_BLOCKS = 1_000n`
  - `blockChunks(from: bigint, to: bigint, chunkBlocks: bigint): readonly (readonly [bigint, bigint])[]`
  - `interface ChainCursor { readonly blockNumber: bigint; readonly blockHash: Hex }`
  - `type CursorTier = "live" | "durable"`
  - `readCursor(db: VenueStateDb, stream: string, tier: CursorTier): ChainCursor | undefined`
  - `writeCursor(db: VenueStateDb, stream: string, tier: CursorTier, cursor: ChainCursor): void`
  - `rollbackToDurable(db: VenueStateDb, stream: string): ChainCursor | undefined`
  - `describeVenueChunking(harness: { blockChunks: typeof blockChunks }): void` — the kit suite runner exported from `@jinn-network/marketplace-testing/venue-conformance`.

- [ ] **Step 1: Write the failing chunking test**

`packages/marketplace/venue-base/src/chain/chunking.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNK_BLOCKS, blockChunks } from "./chunking.js";

describe("block-range chunking", () => {
  it("defaults to the width every provider in the fallback chain accepts (#807)", () => {
    expect(DEFAULT_CHUNK_BLOCKS).toBe(1_000n);
  });

  it("emits inclusive, contiguous ranges no wider than the chunk", () => {
    expect(blockChunks(0n, 2_999n, 1_000n)).toEqual([[0n, 999n], [1_000n, 1_999n], [2_000n, 2_999n]]);
  });

  it("returns nothing for an inverted range", () => {
    expect(blockChunks(500n, 400n, 1_000n)).toEqual([]);
  });

  it("refuses a non-positive chunk width instead of looping forever", () => {
    expect(() => blockChunks(0n, 10n, 0n)).toThrow(/chunkBlocks must be positive/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/chain/chunking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement chunking**

`packages/marketplace/venue-base/src/chain/chunking.ts`:

```ts
// SPDX-License-Identifier: MIT

/**
 * The chunk width every provider in the operator's fallback chain accepts. `sepolia.base.org`
 * caps `eth_getLogs` at 2000 blocks; 1000 leaves headroom so a scan never stalls on the
 * narrowest provider and the cursor always advances (legacy #807, kept as a fixture rule).
 */
export const DEFAULT_CHUNK_BLOCKS = 1_000n;

/**
 * Splits `[from, to]` into inclusive, contiguous ranges of at most `chunkBlocks` blocks each.
 * Unlike the legacy loop -- which stepped by `chunk + 1` and so emitted ranges one block wider
 * than the name suggested -- a range here is never wider than `chunkBlocks`, so a provider cap
 * expressed in blocks can be used as the width directly.
 */
export function blockChunks(
  from: bigint,
  to: bigint,
  chunkBlocks: bigint = DEFAULT_CHUNK_BLOCKS,
): readonly (readonly [bigint, bigint])[] {
  if (chunkBlocks <= 0n) throw new RangeError(`chunkBlocks must be positive: ${chunkBlocks}`);
  if (to < from) return [];
  const ranges: (readonly [bigint, bigint])[] = [];
  for (let start = from; start <= to; start += chunkBlocks) {
    const end = start + chunkBlocks - 1n;
    ranges.push([start, end > to ? to : end]);
  }
  return ranges;
}
```

- [ ] **Step 4: Write the failing cursor test**

`packages/marketplace/venue-base/src/chain/cursor.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "../state/db.js";
import { readCursor, rollbackToDurable, writeCursor } from "./cursor.js";

let dir: string;
let db: VenueStateDb;
const hashA = `0x${"a".repeat(64)}` as const;
const hashB = `0x${"b".repeat(64)}` as const;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-cursor-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("dual chain cursor", () => {
  it("returns undefined before any scan", () => {
    expect(readCursor(db, "marketplace", "live")).toBeUndefined();
    expect(readCursor(db, "marketplace", "durable")).toBeUndefined();
  });

  it("round-trips block numbers past Number.MAX_SAFE_INTEGER", () => {
    const cursor = { blockNumber: 2n ** 64n - 1n, blockHash: hashA };
    writeCursor(db, "marketplace", "live", cursor);
    expect(readCursor(db, "marketplace", "live")).toEqual(cursor);
  });

  it("keeps the live and durable marks independent", () => {
    writeCursor(db, "marketplace", "live", { blockNumber: 200n, blockHash: hashB });
    writeCursor(db, "marketplace", "durable", { blockNumber: 100n, blockHash: hashA });
    expect(readCursor(db, "marketplace", "live")?.blockNumber).toBe(200n);
    expect(readCursor(db, "marketplace", "durable")?.blockNumber).toBe(100n);
  });

  it("rolls the live mark back to the durable checkpoint on a reorg", () => {
    writeCursor(db, "marketplace", "durable", { blockNumber: 100n, blockHash: hashA });
    writeCursor(db, "marketplace", "live", { blockNumber: 200n, blockHash: hashB });
    expect(rollbackToDurable(db, "marketplace")).toEqual({ blockNumber: 100n, blockHash: hashA });
    expect(readCursor(db, "marketplace", "live")).toEqual({ blockNumber: 100n, blockHash: hashA });
  });

  it("clears the live mark when there is no durable checkpoint to fall back to", () => {
    writeCursor(db, "marketplace", "live", { blockNumber: 200n, blockHash: hashB });
    expect(rollbackToDurable(db, "marketplace")).toBeUndefined();
    expect(readCursor(db, "marketplace", "live")).toBeUndefined();
  });
});
```

- [ ] **Step 5: Implement the cursor**

`packages/marketplace/venue-base/src/chain/cursor.ts`:

```ts
// SPDX-License-Identifier: MIT

// The projector's durable read position (standards audit ruling 2): the cursor is a
// hash-verified `(blockNumber, blockHash)` high-water mark, kept as TWO marks -- a live one
// tracking `latest`, and a durable checkpoint that only advances on Base's `finalized` tag. A
// cursor-hash mismatch is a reorg: roll the live mark back to the finalized checkpoint and
// re-scan. Block numbers are stored as decimal TEXT so a value beyond Number.MAX_SAFE_INTEGER
// survives the round trip exactly.
import type { Hex } from "viem";
import type { VenueStateDb } from "../state/db.js";

export interface ChainCursor {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export type CursorTier = "live" | "durable";

interface CursorRow { readonly block_number: string; readonly block_hash: string }

export function readCursor(
  db: VenueStateDb,
  stream: string,
  tier: CursorTier,
): ChainCursor | undefined {
  const row = db.get<CursorRow>(
    "SELECT block_number, block_hash FROM venue_cursor WHERE stream = ? AND tier = ?",
    [stream, tier],
  );
  if (row === undefined) return undefined;
  return { blockNumber: BigInt(row.block_number), blockHash: row.block_hash as Hex };
}

export function writeCursor(
  db: VenueStateDb,
  stream: string,
  tier: CursorTier,
  cursor: ChainCursor,
): void {
  db.run(
    "INSERT INTO venue_cursor (stream, tier, block_number, block_hash) VALUES (?, ?, ?, ?) "
      + "ON CONFLICT(stream, tier) DO UPDATE SET block_number = excluded.block_number, "
      + "block_hash = excluded.block_hash",
    [stream, tier, cursor.blockNumber.toString(), cursor.blockHash],
  );
}

/**
 * The reorg response: the live mark is reset to the finalized checkpoint (or removed when none
 * exists yet) so the next scan re-reads the contested span. Projector STATE is what rolls back;
 * announcements already emitted from pre-finality blocks are corrected append-only through
 * signed retractions, never rewritten (design §7 ruling 2).
 */
export function rollbackToDurable(db: VenueStateDb, stream: string): ChainCursor | undefined {
  return db.transaction(() => {
    const durable = readCursor(db, stream, "durable");
    if (durable === undefined) {
      db.run("DELETE FROM venue_cursor WHERE stream = ? AND tier = 'live'", [stream]);
      return undefined;
    }
    writeCursor(db, stream, "live", durable);
    return durable;
  });
}
```

- [ ] **Step 6: Run both unit suites**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/chain`
Expected: PASS (4 chunking + 5 cursor).

- [ ] **Step 7: Create the conformance-kit module and its first suite**

`packages/marketplace/testing/src/venue-conformance.ts`:

```ts
// SPDX-License-Identifier: MIT

// The venue conformance kit. It is parameterized over the surfaces `venue-base` exports so the
// legacy fixture corpus (venue-fixtures.ts) gates the fresh implementation rather than the
// implementation's own restatement of itself (composition design §6.6). This module lives in
// the kit package, never the adapter package: `venue-base` must not devDepend its own kit
// (the two-way portal cycle documented in the tree's package-inventory guard).
import { describe, expect, it } from "vitest";
import { CHUNK_ARITHMETIC_FIXTURES, PROVIDER_CHUNK_CAPS } from "./venue-fixtures.js";

export interface VenueChunkingSurface {
  blockChunks(from: bigint, to: bigint, chunkBlocks: bigint): readonly (readonly [bigint, bigint])[];
  readonly defaultChunkBlocks: bigint;
}

/** Every chunk-arithmetic fixture, applied to the implementation under test. */
export function describeVenueChunking(surface: VenueChunkingSurface): void {
  describe("venue conformance: RPC chunking rules", () => {
    for (const fixture of CHUNK_ARITHMETIC_FIXTURES) {
      it(fixture.name, () => {
        expect(surface.blockChunks(fixture.from, fixture.to, fixture.chunkBlocks))
          .toEqual(fixture.expected);
      });
    }

    it("defaults below the tightest provider cap so no scan stalls", () => {
      const tightest = Object.values(PROVIDER_CHUNK_CAPS).reduce((a, b) => (a < b ? a : b));
      expect(surface.defaultChunkBlocks).toBeLessThan(tightest);
    });
  });
}
```

`packages/marketplace/testing/src/venue-conformance.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { DEFAULT_CHUNK_BLOCKS, blockChunks } from "@jinn-network/marketplace-venue-base";
import { describeVenueChunking } from "./venue-conformance.js";

describeVenueChunking({ blockChunks, defaultChunkBlocks: DEFAULT_CHUNK_BLOCKS });
```

- [ ] **Step 8: Export from venue-base and wire the subpath**

Append to `packages/marketplace/venue-base/src/index.ts`:

```ts
export { DEFAULT_CHUNK_BLOCKS, blockChunks } from "./chain/chunking.js";
export { readCursor, rollbackToDurable, writeCursor } from "./chain/cursor.js";
export type { ChainCursor, CursorTier } from "./chain/cursor.js";
```

In `packages/marketplace/testing/package.json` add:
```json
    "./venue-conformance": {
      "import": "./dist/venue-conformance.js",
      "types": "./dist/venue-conformance.d.ts"
    },
```
Add `'./venue-conformance'` to the testing export list in `.github/scripts/marketplace-source-boundaries.test.mjs` and `'@jinn-network/marketplace-testing/venue-conformance',` to `codeEntrypoints` in `.github/scripts/marketplace-packed-types.test.mjs`.

- [ ] **Step 9: Run the kit against the implementation**

Run:
```bash
cd packages/marketplace/venue-base && yarn typecheck && yarn test && yarn build
cd ../testing && yarn install && yarn typecheck && yarn vitest run src/venue-conformance.test.ts
cd ../../.. && node --test .github/scripts/marketplace-source-boundaries.test.mjs .github/scripts/custody-boundaries.test.mjs
```
Expected: 8 kit cases PASS; guards PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/marketplace/venue-base/src packages/marketplace/testing \
        .github/scripts/marketplace-source-boundaries.test.mjs \
        .github/scripts/marketplace-packed-types.test.mjs
git commit -m "feat(venue-base): chunk arithmetic and the dual reorg-aware chain cursor

Inclusive chunks no wider than the declared width (the legacy loop's off-by-one
is fixed deliberately and pinned by fixture), plus live/durable cursor marks
with rollback-to-finalized on a hash mismatch. Opens the venue conformance kit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: The chain log source

**Files:**
- Create: `packages/marketplace/venue-base/src/chain/log-source.ts`, `src/chain/log-source.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`
- Modify: `packages/marketplace/testing/src/venue-conformance.ts`, `venue-conformance.test.ts`

**Interfaces:**
- Consumes: `blockChunks`, `DEFAULT_CHUNK_BLOCKS`, `readCursor`, `writeCursor`, `rollbackToDurable`, `ChainCursor`, `VenueStateDb`.
- Produces:
  - `interface VenueRawLog { readonly chainId: number; readonly address: Address; readonly blockNumber: bigint; readonly blockHash: Hex; readonly transactionHash: Hex; readonly logIndex: number; readonly finalityTier: VenueFinalityTier; readonly topics: readonly Hex[]; readonly data: Hex }`
  - `type VenueFinalityTier = "safe" | "finalized"`
  - `type LogSourceScan = { kind: "idle" } | { kind: "advanced"; logs: readonly VenueRawLog[]; live: ChainCursor; durable?: ChainCursor } | { kind: "reorged"; rolledBackTo?: ChainCursor; orphanedBlockHashes: readonly Hex[] }`
  - `interface ChainLogSource { scan(): Promise<LogSourceScan>; cursors(): { live?: ChainCursor; durable?: ChainCursor }; }`
  - `createChainLogSource(input: { db: VenueStateDb; publicClient: PublicClient; chain: MarketplaceChainConfig; addresses: readonly Address[]; startBlock: bigint; chunkBlocks?: bigint; stream?: string }): ChainLogSource`
  - `describeVenueLogSource(surface: VenueLogSourceSurface): void` added to the kit.

- [ ] **Step 1: Write the failing unit test**

`packages/marketplace/venue-base/src/chain/log-source.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import type { Address, Hex, PublicClient } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "../state/db.js";
import { readCursor } from "./cursor.js";
import { createChainLogSource } from "./log-source.js";

const ROUTER = BASE_SEPOLIA_TODAY.jinnRouter as Address;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A scriptable stand-in for the two viem reads the log source makes. */
function fakeClient(head: bigint, safe: bigint, finalized: bigint, opts: {
  reorgAt?: bigint;
  logs?: readonly { blockNumber: bigint; logIndex: number }[];
} = {}): { client: PublicClient; ranges: [bigint, bigint][] } {
  const ranges: [bigint, bigint][] = [];
  const client = {
    async getBlockNumber() { return head; },
    async getBlock({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) {
      if (blockTag === "safe") return { number: safe, hash: hashOf(safe) };
      if (blockTag === "finalized") return { number: finalized, hash: hashOf(finalized) };
      const n = blockNumber!;
      return { number: n, hash: n === opts.reorgAt ? hashOf(n + 10_000n) : hashOf(n) };
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      ranges.push([fromBlock, toBlock]);
      return (opts.logs ?? [])
        .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        .map((l) => ({
          address: ROUTER, blockNumber: l.blockNumber, blockHash: hashOf(l.blockNumber),
          transactionHash: hashOf(l.blockNumber), logIndex: l.logIndex,
          topics: [hashOf(1n)], data: "0x" as Hex,
        }));
    },
  } as unknown as PublicClient;
  return { client, ranges };
}

let dir: string;
let db: VenueStateDb;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-logsource-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("chain log source", () => {
  it("scans in chunks sized to the provider cap and stamps each log's finality tier", async () => {
    const { client, ranges } = fakeClient(2_500n, 2_400n, 1_500n, {
      logs: [{ blockNumber: 1_200n, logIndex: 0 }, { blockNumber: 2_100n, logIndex: 3 }],
    });
    const source = createChainLogSource({
      db, publicClient: client, chain: BASE_SEPOLIA_TODAY, addresses: [ROUTER],
      startBlock: 1_000n, chunkBlocks: 1_000n,
    });
    const result = await source.scan();
    expect(ranges).toEqual([[1_000n, 1_999n], [2_000n, 2_500n]]);
    expect(result.kind).toBe("advanced");
    if (result.kind !== "advanced") throw new Error("unreachable");
    expect(result.logs.map((l) => [l.blockNumber, l.finalityTier])).toEqual([
      [1_200n, "finalized"], [2_100n, "safe"],
    ]);
    expect(result.live).toEqual({ blockNumber: 2_500n, blockHash: hashOf(2_500n) });
    expect(result.durable).toEqual({ blockNumber: 1_500n, blockHash: hashOf(1_500n) });
  });

  it("persists both marks so a restart resumes without re-reading finalized history", async () => {
    const { client } = fakeClient(2_500n, 2_400n, 1_500n);
    const source = createChainLogSource({
      db, publicClient: client, chain: BASE_SEPOLIA_TODAY, addresses: [ROUTER], startBlock: 1_000n,
    });
    await source.scan();
    expect(readCursor(db, "marketplace", "live")?.blockNumber).toBe(2_500n);
    expect(readCursor(db, "marketplace", "durable")?.blockNumber).toBe(1_500n);
  });

  it("reports idle when the head has not moved past the live mark", async () => {
    const { client, ranges } = fakeClient(2_500n, 2_400n, 1_500n);
    const source = createChainLogSource({
      db, publicClient: client, chain: BASE_SEPOLIA_TODAY, addresses: [ROUTER], startBlock: 1_000n,
    });
    await source.scan();
    ranges.length = 0;
    expect(await source.scan()).toEqual({ kind: "idle" });
    expect(ranges).toEqual([]);
  });

  it("detects a cursor-hash mismatch as a reorg and rolls back to the finalized checkpoint", async () => {
    const first = fakeClient(2_500n, 2_400n, 1_500n);
    const source = createChainLogSource({
      db, publicClient: first.client, chain: BASE_SEPOLIA_TODAY, addresses: [ROUTER], startBlock: 1_000n,
    });
    await source.scan();

    const second = fakeClient(2_600n, 2_500n, 1_500n, { reorgAt: 2_500n });
    const reorging = createChainLogSource({
      db, publicClient: second.client, chain: BASE_SEPOLIA_TODAY, addresses: [ROUTER], startBlock: 1_000n,
    });
    const result = await reorging.scan();
    expect(result).toEqual({
      kind: "reorged",
      rolledBackTo: { blockNumber: 1_500n, blockHash: hashOf(1_500n) },
      orphanedBlockHashes: [hashOf(2_500n)],
    });
    expect(readCursor(db, "marketplace", "live")?.blockNumber).toBe(1_500n);
  });

  it("never advances the durable mark past the finalized tag", async () => {
    const { client } = fakeClient(9_000n, 8_900n, 8_000n);
    const source = createChainLogSource({
      db, publicClient: client, chain: BASE_SEPOLIA_TODAY, addresses: [ROUTER],
      startBlock: 7_999n, chunkBlocks: 1_000n,
    });
    const result = await source.scan();
    if (result.kind !== "advanced") throw new Error("unreachable");
    expect(result.durable!.blockNumber).toBe(8_000n);
    expect(result.durable!.blockNumber).toBeLessThan(result.live.blockNumber);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/chain/log-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the log source**

`packages/marketplace/venue-base/src/chain/log-source.ts`:

```ts
// SPDX-License-Identifier: MIT

// The projector's event feed (composition design §6.1; standards audit ruling 2: a thin reader
// profile over viem `getLogs`, not an embedded framework). Chunked `getLogs` sized to provider
// caps; a hash-verified `(blockNumber, blockHash)` high-water mark persisted in the venue state
// database; dual marks -- a live cursor tracking `latest` and a durable checkpoint advancing
// only on Base's `finalized` tag; a cursor-hash mismatch is a reorg, which rolls projector STATE
// back to the finalized checkpoint and re-scans.
import type { MarketplaceChainConfig } from "@jinn-network/marketplace-binding";
import type { Address, Hex, PublicClient } from "viem";
import type { VenueStateDb } from "../state/db.js";
import { DEFAULT_CHUNK_BLOCKS, blockChunks } from "./chunking.js";
import { readCursor, rollbackToDurable, writeCursor, type ChainCursor } from "./cursor.js";

export type VenueFinalityTier = "safe" | "finalized";

/**
 * Structurally identical to the projector's `MarketplaceRawLog` (decision D7): matching the
 * shape rather than importing it keeps this adapter off the projector's dependency edge, and
 * the conformance kit pins the assignability in both directions.
 */
export interface VenueRawLog {
  readonly chainId: number;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly finalityTier: VenueFinalityTier;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export type LogSourceScan =
  | { readonly kind: "idle" }
  | {
      readonly kind: "advanced";
      readonly logs: readonly VenueRawLog[];
      readonly live: ChainCursor;
      readonly durable?: ChainCursor;
    }
  | {
      readonly kind: "reorged";
      readonly rolledBackTo?: ChainCursor;
      readonly orphanedBlockHashes: readonly Hex[];
    };

export interface ChainLogSource {
  scan(): Promise<LogSourceScan>;
  cursors(): { live?: ChainCursor; durable?: ChainCursor };
}

export interface ChainLogSourceInput {
  readonly db: VenueStateDb;
  readonly publicClient: PublicClient;
  readonly chain: MarketplaceChainConfig;
  readonly addresses: readonly Address[];
  readonly startBlock: bigint;
  readonly chunkBlocks?: bigint;
  readonly stream?: string;
}

export function createChainLogSource(input: ChainLogSourceInput): ChainLogSource {
  const stream = input.stream ?? "marketplace";
  const chunkBlocks = input.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS;
  const { db, publicClient, chain, addresses } = input;

  async function blockCursor(tag: "safe" | "finalized"): Promise<ChainCursor | undefined> {
    try {
      const block = await publicClient.getBlock({ blockTag: tag });
      if (block.number === null) return undefined;
      return { blockNumber: block.number, blockHash: block.hash as Hex };
    } catch {
      // A provider that does not serve OP-stack finality tags leaves the tier undetermined;
      // the caller keeps its previous durable checkpoint rather than inventing one.
      return undefined;
    }
  }

  return {
    cursors() {
      return {
        live: readCursor(db, stream, "live"),
        durable: readCursor(db, stream, "durable"),
      };
    },

    async scan(): Promise<LogSourceScan> {
      const live = readCursor(db, stream, "live");
      if (live !== undefined) {
        const current = await publicClient.getBlock({ blockNumber: live.blockNumber });
        if ((current.hash as Hex) !== live.blockHash) {
          const rolledBackTo = rollbackToDurable(db, stream);
          return { kind: "reorged", rolledBackTo, orphanedBlockHashes: [live.blockHash] };
        }
      }

      const head = await publicClient.getBlockNumber();
      const from = live === undefined ? input.startBlock : live.blockNumber + 1n;
      if (head < from) return { kind: "idle" };

      const finalized = await blockCursor("finalized");
      const safeTierFloor = finalized?.blockNumber ?? -1n;

      const logs: VenueRawLog[] = [];
      for (const [start, end] of blockChunks(from, head, chunkBlocks)) {
        // eslint-disable-next-line no-await-in-loop -- chunks are ordered; a provider cap makes
        // them sequential by construction and the cursor advances only after the whole pass.
        const raw = await publicClient.getLogs({ address: [...addresses], fromBlock: start, toBlock: end });
        for (const log of raw) {
          if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
            continue; // a pending log has no position; it is not a fact yet
          }
          logs.push({
            chainId: chain.chainId,
            address: log.address as Address,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash as Hex,
            transactionHash: log.transactionHash as Hex,
            logIndex: log.logIndex,
            finalityTier: log.blockNumber <= safeTierFloor ? "finalized" : "safe",
            topics: log.topics as readonly Hex[],
            data: log.data as Hex,
          });
        }
      }

      const headBlock = await publicClient.getBlock({ blockNumber: head });
      const liveCursor: ChainCursor = { blockNumber: head, blockHash: headBlock.hash as Hex };
      db.transaction(() => {
        writeCursor(db, stream, "live", liveCursor);
        if (finalized !== undefined) writeCursor(db, stream, "durable", finalized);
      });
      return finalized === undefined
        ? { kind: "advanced", logs, live: liveCursor }
        : { kind: "advanced", logs, live: liveCursor, durable: finalized };
    },
  };
}
```

- [ ] **Step 4: Run the unit suite**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/chain/log-source.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the Anvil-fork kit suite**

Append to `packages/marketplace/testing/src/venue-conformance.ts`:

```ts
import type { MarketplaceRawLog } from "@jinn-network/marketplace-projector";

export interface VenueLogSourceSurface {
  createChainLogSource(input: {
    db: unknown; publicClient: unknown; chain: unknown;
    addresses: readonly `0x${string}`[]; startBlock: bigint; chunkBlocks?: bigint;
  }): { scan(): Promise<{ kind: string; logs?: readonly unknown[] }> };
}

export interface VenueLogSourceForkContext {
  readonly makeSource: (startBlock: bigint) => { scan(): Promise<{ kind: string }> };
  readonly mine: (blocks: number) => Promise<void>;
  readonly headBlock: () => Promise<bigint>;
}

/** Pins decision D7: a `VenueRawLog` is exactly what `decodeMarketplaceLogs` accepts. */
export function assertVenueRawLogMatchesProjector(sample: MarketplaceRawLog): MarketplaceRawLog {
  return sample;
}

/** Fork-backed: a real chunked scan advances, then goes idle, over the live chain. */
export function describeVenueLogSourceOverFork(
  context: VenueLogSourceForkContext | undefined,
): void {
  describe.runIf(context !== undefined)("venue conformance: chain log source over a fork", () => {
    it("advances on the first scan and reports idle on the second", async () => {
      const live = context!;
      const head = await live.headBlock();
      const source = live.makeSource(head - 200n);
      expect((await source.scan()).kind).toBe("advanced");
      expect((await source.scan()).kind).toBe("idle");
    });

    it("advances again after new blocks are mined", async () => {
      const live = context!;
      const head = await live.headBlock();
      const source = live.makeSource(head - 10n);
      await source.scan();
      await live.mine(2);
      expect((await source.scan()).kind).toBe("advanced");
    });
  });
}
```

Replace `packages/marketplace/testing/src/venue-conformance.test.ts` with:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CHUNK_BLOCKS,
  blockChunks,
  createChainLogSource,
  openVenueStateDb,
  type VenueRawLog,
} from "@jinn-network/marketplace-venue-base";
import { expect, it } from "vitest";
import { startVenueFork } from "./venue-anvil.js";
import {
  assertVenueRawLogMatchesProjector,
  describeVenueChunking,
  describeVenueLogSourceOverFork,
} from "./venue-conformance.js";

describeVenueChunking({ blockChunks, defaultChunkBlocks: DEFAULT_CHUNK_BLOCKS });

it("a VenueRawLog is assignable to the projector's MarketplaceRawLog (decision D7)", () => {
  const sample: VenueRawLog = {
    chainId: 84532,
    address: "0x0000000000000000000000000000000000000001",
    blockNumber: 1n,
    blockHash: `0x${"1".repeat(64)}`,
    transactionHash: `0x${"2".repeat(64)}`,
    logIndex: 0,
    finalityTier: "safe",
    topics: [`0x${"3".repeat(64)}`],
    data: "0x",
  };
  expect(assertVenueRawLogMatchesProjector(sample)).toBe(sample);
});

const fork = await startVenueFork();
describeVenueLogSourceOverFork(fork === undefined ? undefined : {
  makeSource: (startBlock) => {
    const dbPromise = openVenueStateDb(join(mkdtempSync(join(tmpdir(), "venue-kit-")), "venue.db"));
    let source: ReturnType<typeof createChainLogSource> | undefined;
    return {
      async scan() {
        source ??= createChainLogSource({
          db: await dbPromise, publicClient: fork.publicClient, chain: fork.chain,
          addresses: [fork.chain.jinnRouter], startBlock,
        });
        return source.scan();
      },
    };
  },
  mine: (blocks) => fork.mine(blocks),
  headBlock: () => fork.publicClient.getBlockNumber(),
});
```

- [ ] **Step 6: Export and verify**

Append to `packages/marketplace/venue-base/src/index.ts`:

```ts
export { createChainLogSource } from "./chain/log-source.js";
export type {
  ChainLogSource,
  ChainLogSourceInput,
  LogSourceScan,
  VenueFinalityTier,
  VenueRawLog,
} from "./chain/log-source.js";
```

Add `'@jinn-network/marketplace-projector'` to the `testing` inventory-graph `dependencies` if it is not already there (it is), and leave the boundary lists unchanged.

Run:
```bash
cd packages/marketplace/venue-base && yarn typecheck && yarn test && yarn build
cd ../testing && yarn install && yarn typecheck && yarn vitest run src/venue-conformance.test.ts
cd ../../.. && node --test .github/scripts/custody-boundaries.test.mjs .github/scripts/marketplace-source-boundaries.test.mjs .github/scripts/marketplace-package-inventory.test.mjs
```
Expected: venue-base PASS; the D7 assignability case PASS; the two fork cases PASS with Foundry installed and skip otherwise; guards PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/venue-base/src packages/marketplace/testing/src \
        packages/marketplace/testing/package.json
git commit -m "feat(venue-base): the chunked chain log source with reorg rollback

Standards-audit ruling 2 implemented: chunked getLogs, dual live/durable
(blockNumber, blockHash) marks persisted in the venue state database, and a
cursor-hash mismatch rolling projector state back to the finalized checkpoint.
Kit gains the fork-backed advance/idle suite and the D7 assignability pin.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Transaction-error classification and fee-bump arithmetic

**Files:**
- Create: `packages/marketplace/venue-base/src/broadcast/classify.ts`, `src/broadcast/classify.test.ts`, `src/broadcast/fees.ts`, `src/broadcast/fees.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`, `packages/marketplace/testing/src/venue-conformance.ts`, `venue-conformance.test.ts`

**Interfaces:**
- Consumes: `REVERT_CLASSIFICATION_FIXTURES`, `RETRYABLE_INNER_REVERT_NAMES`, `TERMINAL_INNER_REVERT_NAMES` from `@jinn-network/marketplace-testing/venue-fixtures`; `SafeInnerRevertError` from binding.
- Produces:
  - `flattenErrorMessage(error: unknown): string`
  - `classifyTransactionError(error: unknown): "retryable" | "terminal"`
  - `isNonceTooLow(error: unknown): boolean`, `isReplacementUnderpriced(error: unknown): boolean`
  - `STALE_SAFE_NONCE_TOKEN = "possible stale Safe nonce or signature race"`
  - `interface FeeSnapshot { readonly maxFeePerGas?: bigint; readonly maxPriorityFeePerGas?: bigint; readonly gasPrice?: bigint }`
  - `DEFAULT_BROADCAST_TUNING = { maxAttempts: 6, baseDelayMs: 400, maxDelayMs: 12_000, feeBumpBpsPerAttempt: 1_500, replacementBumpBps: 1_500, stuckNonceAfterMs: 120_000 }`
  - `bumpFees(current: FeeSnapshot, previous: FeeSnapshot | undefined, attemptIndex: number, tuning?: Partial<typeof DEFAULT_BROADCAST_TUNING>): FeeSnapshot`
  - `backoffDelayMs(attemptIndex: number, baseMs: number, maxMs: number, random?: () => number): number`
  - `describeVenueRevertClassification(surface: { classifyTransactionError(error: unknown): "retryable" | "terminal" }): void`

- [ ] **Step 1: Write the failing classification test**

`packages/marketplace/venue-base/src/broadcast/classify.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { SafeInnerRevertError } from "@jinn-network/marketplace-binding";
import { describe, expect, it } from "vitest";
import {
  STALE_SAFE_NONCE_TOKEN,
  classifyTransactionError,
  flattenErrorMessage,
  isNonceTooLow,
  isReplacementUnderpriced,
} from "./classify.js";

describe("transaction error classification", () => {
  it("flattens a nested cause chain so a buried reason is still visible", () => {
    const error = new Error("outer", { cause: new Error("inner: nonce too low") });
    expect(flattenErrorMessage(error).toLowerCase()).toContain("nonce too low");
  });

  it("treats a decoded permanent inner revert as terminal", () => {
    const error = new SafeInnerRevertError(
      "inner revert", "0x90386e7c", "0x90386e7c", "TCMaxClaimsReached", [7n], null,
    );
    expect(classifyTransactionError(error)).toBe("terminal");
  });

  it("treats RouterNotDelivered as the one retryable inner revert", () => {
    const error = new SafeInnerRevertError(
      "inner revert", "0xe5a88624", "0xe5a88624", "RouterNotDelivered", [], null,
    );
    expect(classifyTransactionError(error)).toBe("retryable");
  });

  it("treats an undecoded inner selector as terminal rather than guessing", () => {
    const error = new SafeInnerRevertError(
      "inner revert", "0xdeadbeef", "0xdeadbeef", null, null, null,
    );
    expect(classifyTransactionError(error)).toBe("terminal");
  });

  it("recognises the stale-Safe-nonce token as retryable", () => {
    expect(STALE_SAFE_NONCE_TOKEN).toBe("possible stale Safe nonce or signature race");
    expect(classifyTransactionError(new Error(`reverted (${STALE_SAFE_NONCE_TOKEN})`))).toBe("retryable");
  });

  it("keeps insufficient funds and user rejection terminal even though they are transport-shaped", () => {
    expect(classifyTransactionError(new Error("insufficient funds for gas"))).toBe("terminal");
    expect(classifyTransactionError(new Error("User rejected the request"))).toBe("terminal");
  });

  it("classifies GS013 and GS026 as terminal", () => {
    expect(classifyTransactionError(new Error("execution reverted: GS013"))).toBe("terminal");
    expect(classifyTransactionError(new Error("execution reverted: GS026"))).toBe("terminal");
  });

  it("defaults an unrecognised message to terminal", () => {
    expect(classifyTransactionError(new Error("something nobody classified"))).toBe("terminal");
  });

  it("detects the two nonce-shaped errors by name", () => {
    expect(isNonceTooLow(new Error("nonce too low"))).toBe(true);
    expect(isNonceTooLow(new Error("replacement transaction underpriced"))).toBe(false);
    expect(isReplacementUnderpriced(new Error("replacement transaction underpriced"))).toBe(true);
    expect(isReplacementUnderpriced(new Error("transaction underpriced"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement classification**

`packages/marketplace/venue-base/src/broadcast/classify.ts`:

```ts
// SPDX-License-Identifier: MIT

// The recoverable/terminal decision the retry loop turns on. Written fresh; the legacy
// classifier's decision ORDER is preserved as fixture behavior, not as ported code
// (design §6.6). The single most valuable rule: an inner revert we could not decode is still an
// inner revert -- deterministic and terminal. Retrying it burns gas until the attempt budget is
// gone, which is exactly what the legacy adapter learned.
import { SafeInnerRevertError } from "@jinn-network/marketplace-binding";

export const STALE_SAFE_NONCE_TOKEN = "possible stale Safe nonce or signature race";

/** The one inner-revert name a retry can clear: the Mech's delivery has not landed yet. */
const RETRYABLE_INNER_NAMES = new Set(["RouterNotDelivered"]);

const TERMINAL_SUBSTRINGS = [
  "insufficient funds", "user rejected", "user denied", "rejected the request",
  "gs013", "gs026",
];

const RETRYABLE_SUBSTRINGS = [
  STALE_SAFE_NONCE_TOKEN.toLowerCase(),
  "replacement transaction underpriced", "replacement fee too low", "transaction underpriced",
  "fee cap less than block base fee", "max fee per gas less than block base fee",
  "nonce too low", "already known", "could not coalesce",
  "econnreset", "etimedout", "socket hang up", "fetch failed", "network error",
  "connection refused", "connect timeout", "all rpc providers in the fallback chain failed",
  'returned no data ("0x")', "cannot decode zero data", "the address is not a contract",
  "429", "rate limit", "too many requests", "-32603", "internal json-rpc error", "-32005",
  "request timed out", "timeout", "bad gateway", "service unavailable", "502", "503",
];

/** Walks `cause` chains so a reason buried three wrappers deep is still classifiable. */
export function flattenErrorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "string") { parts.push(current); break; }
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && "message" in current) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string") parts.push(message);
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return parts.join(" | ");
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Decision order (each step is final when it matches):
 * 1. terminal transport/authority refusals (funds, user rejection, GS013/GS026)
 * 2. a decoded inner revert -- retryable only when named RouterNotDelivered
 * 3. an UNDECODED inner selector -- terminal
 * 4. the retryable nonce/fee/transport/rate-limit families
 * 5. default terminal, so an unclassified failure surfaces instead of spinning
 */
export function classifyTransactionError(error: unknown): "retryable" | "terminal" {
  const message = flattenErrorMessage(error).toLowerCase();
  if (includesAny(message, TERMINAL_SUBSTRINGS)) return "terminal";
  if (error instanceof SafeInnerRevertError) {
    if (error.decodedName !== null) {
      return RETRYABLE_INNER_NAMES.has(error.decodedName) ? "retryable" : "terminal";
    }
    if (error.innerSelector !== null) return "terminal";
  }
  if (includesAny(message, RETRYABLE_SUBSTRINGS)) return "retryable";
  return "terminal";
}

export function isNonceTooLow(error: unknown): boolean {
  return flattenErrorMessage(error).toLowerCase().includes("nonce too low");
}

export function isReplacementUnderpriced(error: unknown): boolean {
  const message = flattenErrorMessage(error).toLowerCase();
  return message.includes("replacement transaction underpriced")
    || message.includes("replacement fee too low")
    || message.includes("transaction underpriced");
}
```

- [ ] **Step 4: Write the failing fee test**

`packages/marketplace/venue-base/src/broadcast/fees.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { DEFAULT_BROADCAST_TUNING, backoffDelayMs, bumpFees } from "./fees.js";

describe("fee-bump arithmetic", () => {
  it("leaves the first attempt's estimate untouched", () => {
    const current = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
    expect(bumpFees(current, undefined, 0)).toEqual(current);
  });

  it("adds 15 percent per attempt, rounding up", () => {
    expect(bumpFees({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 101n }, undefined, 1))
      .toEqual({ maxFeePerGas: 1_150n, maxPriorityFeePerGas: 117n });
    expect(bumpFees({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }, undefined, 2))
      .toEqual({ maxFeePerGas: 1_300n, maxPriorityFeePerGas: 130n });
  });

  it("takes the higher of the attempt bump and a 15 percent replacement bump", () => {
    const bumped = bumpFees(
      { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
      { maxFeePerGas: 5_000n, maxPriorityFeePerGas: 500n },
      1,
    );
    expect(bumped).toEqual({ maxFeePerGas: 5_750n, maxPriorityFeePerGas: 575n });
  });

  it("drops a legacy gasPrice once both EIP-1559 fields resolve", () => {
    expect(bumpFees({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n, gasPrice: 900n }, undefined, 1))
      .toEqual({ maxFeePerGas: 1_150n, maxPriorityFeePerGas: 115n });
  });

  it("bumps a legacy-only snapshot's gasPrice", () => {
    expect(bumpFees({ gasPrice: 1_000n }, undefined, 1)).toEqual({ gasPrice: 1_150n });
  });

  it("caps exponential backoff and adds bounded jitter", () => {
    const { baseDelayMs, maxDelayMs } = DEFAULT_BROADCAST_TUNING;
    expect(backoffDelayMs(0, baseDelayMs, maxDelayMs, () => 0)).toBe(400);
    expect(backoffDelayMs(3, baseDelayMs, maxDelayMs, () => 0)).toBe(3_200);
    expect(backoffDelayMs(20, baseDelayMs, maxDelayMs, () => 0)).toBe(12_000);
    expect(backoffDelayMs(0, baseDelayMs, maxDelayMs, () => 0.999)).toBeLessThanOrEqual(400 + 250);
  });
});
```

- [ ] **Step 5: Implement the fee module**

`packages/marketplace/venue-base/src/broadcast/fees.ts`:

```ts
// SPDX-License-Identifier: MIT

// The Defender-relayer profile's fee arithmetic (standards audit ruling 1): per-attempt bump,
// minimum replacement bump over the previously submitted fee, EIP-1559 preferred with a legacy
// fallback, and a legacy `gasPrice` removed once both 1559 fields resolve so a node never sees
// a conflicting pair.

export const DEFAULT_BROADCAST_TUNING = {
  maxAttempts: 6,
  baseDelayMs: 400,
  maxDelayMs: 12_000,
  feeBumpBpsPerAttempt: 1_500,
  replacementBumpBps: 1_500,
  stuckNonceAfterMs: 120_000,
} as const;

export interface FeeSnapshot {
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly gasPrice?: bigint;
}

function mulDivCeil(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator + denominator - 1n) / denominator;
}

function bumpField(
  current: bigint | undefined,
  previous: bigint | undefined,
  attemptIndex: number,
  attemptBps: bigint,
  replacementBps: bigint,
): bigint | undefined {
  if (current === undefined && previous === undefined) return undefined;
  const base = current ?? previous!;
  const attemptBumped = mulDivCeil(base, 10_000n + attemptBps * BigInt(attemptIndex), 10_000n);
  if (previous === undefined) return attemptBumped;
  const replacementBumped = mulDivCeil(previous, 10_000n + replacementBps, 10_000n);
  return attemptBumped > replacementBumped ? attemptBumped : replacementBumped;
}

/** Attempt 0 uses the estimate as-is; every later attempt must strictly outbid its predecessor. */
export function bumpFees(
  current: FeeSnapshot,
  previous: FeeSnapshot | undefined,
  attemptIndex: number,
  tuning: Partial<typeof DEFAULT_BROADCAST_TUNING> = {},
): FeeSnapshot {
  const attemptBps = BigInt(tuning.feeBumpBpsPerAttempt ?? DEFAULT_BROADCAST_TUNING.feeBumpBpsPerAttempt);
  const replacementBps = BigInt(tuning.replacementBumpBps ?? DEFAULT_BROADCAST_TUNING.replacementBumpBps);
  if (attemptIndex === 0 && previous === undefined) return current;

  const maxFeePerGas = bumpField(current.maxFeePerGas, previous?.maxFeePerGas, attemptIndex, attemptBps, replacementBps);
  const maxPriorityFeePerGas = bumpField(current.maxPriorityFeePerGas, previous?.maxPriorityFeePerGas, attemptIndex, attemptBps, replacementBps);
  if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined) {
    return { maxFeePerGas, maxPriorityFeePerGas };
  }
  const gasPrice = bumpField(current.gasPrice, previous?.gasPrice, attemptIndex, attemptBps, replacementBps);
  return gasPrice === undefined ? {} : { gasPrice };
}

/** Exponential backoff capped at `maxMs`, plus jitter bounded by `min(250, baseMs)`. */
export function backoffDelayMs(
  attemptIndex: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attemptIndex);
  const jitterCeiling = Math.min(250, baseMs);
  return exponential + Math.floor(random() * jitterCeiling);
}
```

- [ ] **Step 6: Add the fixture-driven kit suite**

Append to `packages/marketplace/testing/src/venue-conformance.ts`:

```ts
import { SafeInnerRevertError } from "@jinn-network/marketplace-binding";
import { REVERT_CLASSIFICATION_FIXTURES } from "./venue-fixtures.js";

export interface VenueClassificationSurface {
  classifyTransactionError(error: unknown): "retryable" | "terminal";
}

/** Every legacy revert-classification fixture, applied to the fresh classifier. */
export function describeVenueRevertClassification(surface: VenueClassificationSurface): void {
  describe("venue conformance: revert classification table", () => {
    for (const fixture of REVERT_CLASSIFICATION_FIXTURES) {
      it(fixture.name, () => {
        const error = fixture.decodedName === null && fixture.innerSelector === null
          ? new Error(fixture.message)
          : new SafeInnerRevertError(
              fixture.message,
              fixture.innerSelector as `0x${string}` | null,
              fixture.innerSelector as `0x${string}` | null,
              fixture.decodedName,
              fixture.decodedName === null ? null : [],
              null,
            );
        expect(surface.classifyTransactionError(error)).toBe(fixture.expected);
      });
    }
  });
}
```

Append to `packages/marketplace/testing/src/venue-conformance.test.ts`:

```ts
import { classifyTransactionError } from "@jinn-network/marketplace-venue-base";
import { describeVenueRevertClassification } from "./venue-conformance.js";

describeVenueRevertClassification({ classifyTransactionError });
```

- [ ] **Step 7: Export and verify**

Append to `packages/marketplace/venue-base/src/index.ts`:

```ts
export {
  STALE_SAFE_NONCE_TOKEN,
  classifyTransactionError,
  flattenErrorMessage,
  isNonceTooLow,
  isReplacementUnderpriced,
} from "./broadcast/classify.js";
export { DEFAULT_BROADCAST_TUNING, backoffDelayMs, bumpFees } from "./broadcast/fees.js";
export type { FeeSnapshot } from "./broadcast/fees.js";
```

Run:
```bash
cd packages/marketplace/venue-base && yarn typecheck && yarn test && yarn build
cd ../testing && yarn vitest run src/venue-conformance.test.ts
cd ../../.. && node --test .github/scripts/custody-boundaries.test.mjs
```
Expected: 9 classification + 6 fee unit tests PASS; 19 kit classification cases PASS; custody guard PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/marketplace/venue-base/src packages/marketplace/testing/src
git commit -m "feat(venue-base): transaction-error classification and fee-bump arithmetic

Fresh implementation gated by the legacy revert-classification fixture table:
RouterNotDelivered is the sole retryable inner revert, an undecoded inner
selector is terminal, and an unclassified failure surfaces instead of spinning.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: The transaction-submission (nonce) ledger

**Files:**
- Create: `packages/marketplace/venue-base/src/broadcast/ledger.ts`, `src/broadcast/ledger.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `VenueStateDb`, `FeeSnapshot`.
- Produces:
  - `interface TxSubmissionKey { readonly chainId: number; readonly from: Address; readonly nonce: number }`
  - `interface TxSubmissionEntry extends TxSubmissionKey { readonly txHash: Hex; readonly logicalTx: string; readonly to: Address; readonly value: bigint; readonly data: Hex; readonly fees: FeeSnapshot; readonly submittedAtMs: number; readonly resolvedAtMs?: number }`
  - `interface TxSubmissionLedger { record(entry: TxSubmissionEntry): void; read(key: TxSubmissionKey): TxSubmissionEntry | undefined; markResolved(key: TxSubmissionKey, atMs?: number): void; unresolvedFrom(chainId: number, from: Address, fromNonce: number, toNonce: number): readonly TxSubmissionEntry[] }`
  - `createTxSubmissionLedger(db: VenueStateDb): TxSubmissionLedger`
  - `matchesRequest(entry: TxSubmissionEntry, request: { readonly to: Address; readonly data: Hex }): boolean`

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/broadcast/ledger.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "../state/db.js";
import { createTxSubmissionLedger, matchesRequest, type TxSubmissionLedger } from "./ledger.js";

const FROM = "0x00000000000000000000000000000000000000f0" as Address;
const SAFE_A = "0x00000000000000000000000000000000000000a1" as Address;
const SAFE_B = "0x00000000000000000000000000000000000000b2" as Address;

let dir: string;
let db: VenueStateDb;
let ledger: TxSubmissionLedger;

const entry = (nonce: number, to: Address, data: Hex, hash: Hex) => ({
  chainId: 84532, from: FROM, nonce, txHash: hash, logicalTx: "safe.execTransaction",
  to, value: 0n, data, fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
  submittedAtMs: 1_000,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-ledger-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
  ledger = createTxSubmissionLedger(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("transaction submission ledger", () => {
  it("round-trips an entry keyed by (chainId, from, nonce), including bigint fees", () => {
    ledger.record(entry(7, SAFE_A, "0xdeadbeef", `0x${"1".repeat(64)}`));
    expect(ledger.read({ chainId: 84532, from: FROM, nonce: 7 })).toEqual({
      ...entry(7, SAFE_A, "0xdeadbeef", `0x${"1".repeat(64)}`),
      resolvedAtMs: undefined,
    });
  });

  it("is case-insensitive on the sender address", () => {
    ledger.record(entry(7, SAFE_A, "0xdeadbeef", `0x${"1".repeat(64)}`));
    expect(ledger.read({ chainId: 84532, from: FROM.toUpperCase() as Address, nonce: 7 })).toBeDefined();
  });

  it("replaces the entry at a nonce when the same nonce is re-submitted", () => {
    ledger.record(entry(7, SAFE_A, "0xdeadbeef", `0x${"1".repeat(64)}`));
    ledger.record(entry(7, SAFE_A, "0xdeadbeef", `0x${"2".repeat(64)}`));
    expect(ledger.read({ chainId: 84532, from: FROM, nonce: 7 })?.txHash).toBe(`0x${"2".repeat(64)}`);
  });

  it("marks an entry resolved and drops it from the unresolved window", () => {
    ledger.record(entry(7, SAFE_A, "0xdeadbeef", `0x${"1".repeat(64)}`));
    ledger.record(entry(8, SAFE_A, "0xcafe", `0x${"3".repeat(64)}`));
    ledger.markResolved({ chainId: 84532, from: FROM, nonce: 7 }, 2_000);
    expect(ledger.read({ chainId: 84532, from: FROM, nonce: 7 })?.resolvedAtMs).toBe(2_000);
    expect(ledger.unresolvedFrom(84532, FROM, 7, 9).map((e) => e.nonce)).toEqual([8]);
  });

  it("adopts a ledger entry only when BOTH target and calldata match the request", () => {
    const mine = entry(7, SAFE_A, "0xdeadbeef", `0x${"1".repeat(64)}`);
    expect(matchesRequest(mine, { to: SAFE_A, data: "0xdeadbeef" })).toBe(true);
    expect(matchesRequest(mine, { to: SAFE_B, data: "0xdeadbeef" })).toBe(false);
    expect(matchesRequest(mine, { to: SAFE_A, data: "0xcafebabe" })).toBe(false);
    expect(matchesRequest(mine, { to: SAFE_A.toUpperCase() as Address, data: "0xDEADBEEF" })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/ledger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the ledger**

`packages/marketplace/venue-base/src/broadcast/ledger.ts`:

```ts
// SPDX-License-Identifier: MIT

// The persistent submission ledger of the Defender-relayer profile (standards audit ruling 1):
// keyed `(chainId, from, nonce)`, durable across restarts, and the sole basis for reconciling
// "did my transaction actually land?" after a nonce-too-low. The ledger is SHARED across every
// logical transaction the process broadcasts, so an entry must never be adopted on nonce match
// alone -- `matchesRequest` is the identity guard that makes reconciliation safe.
import type { Address, Hex } from "viem";
import type { VenueStateDb } from "../state/db.js";
import type { FeeSnapshot } from "./fees.js";

export interface TxSubmissionKey {
  readonly chainId: number;
  readonly from: Address;
  readonly nonce: number;
}

export interface TxSubmissionEntry extends TxSubmissionKey {
  readonly txHash: Hex;
  readonly logicalTx: string;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly fees: FeeSnapshot;
  readonly submittedAtMs: number;
  readonly resolvedAtMs?: number;
}

export interface TxSubmissionLedger {
  record(entry: TxSubmissionEntry): void;
  read(key: TxSubmissionKey): TxSubmissionEntry | undefined;
  markResolved(key: TxSubmissionKey, atMs?: number): void;
  /** Unresolved entries in `[fromNonce, toNonce)`, ascending — the stuck-nonce scan window. */
  unresolvedFrom(chainId: number, from: Address, fromNonce: number, toNonce: number): readonly TxSubmissionEntry[];
}

interface Row {
  readonly chain_id: number; readonly from_address: string; readonly nonce: number;
  readonly tx_hash: string; readonly logical_tx: string; readonly to_address: string;
  readonly value: string; readonly data: string; readonly fees_json: string;
  readonly submitted_at_ms: number; readonly resolved_at_ms: number | null;
}

function serializeFees(fees: FeeSnapshot): string {
  return JSON.stringify({
    maxFeePerGas: fees.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas?.toString(),
    gasPrice: fees.gasPrice?.toString(),
  });
}

function parseFees(json: string): FeeSnapshot {
  const raw = JSON.parse(json) as Record<string, string | undefined>;
  const snapshot: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint } = {};
  if (raw["maxFeePerGas"] !== undefined) snapshot.maxFeePerGas = BigInt(raw["maxFeePerGas"]);
  if (raw["maxPriorityFeePerGas"] !== undefined) snapshot.maxPriorityFeePerGas = BigInt(raw["maxPriorityFeePerGas"]);
  if (raw["gasPrice"] !== undefined) snapshot.gasPrice = BigInt(raw["gasPrice"]);
  return snapshot;
}

function toEntry(row: Row): TxSubmissionEntry {
  return {
    chainId: row.chain_id, from: row.from_address as Address, nonce: row.nonce,
    txHash: row.tx_hash as Hex, logicalTx: row.logical_tx, to: row.to_address as Address,
    value: BigInt(row.value), data: row.data as Hex, fees: parseFees(row.fees_json),
    submittedAtMs: row.submitted_at_ms,
    resolvedAtMs: row.resolved_at_ms === null ? undefined : row.resolved_at_ms,
  };
}

/**
 * The reconciliation identity guard. The ledger is keyed on the EOA nonce alone, so a mined
 * transaction at that nonce may belong to an entirely different logical operation. Adopt its
 * hash only when the target AND the calldata are byte-identical to the request in hand.
 */
export function matchesRequest(
  entry: TxSubmissionEntry,
  request: { readonly to: Address; readonly data: Hex },
): boolean {
  return entry.to.toLowerCase() === request.to.toLowerCase()
    && entry.data.toLowerCase() === request.data.toLowerCase();
}

export function createTxSubmissionLedger(db: VenueStateDb): TxSubmissionLedger {
  return {
    record(entry) {
      db.run(
        "INSERT INTO venue_tx_submissions (chain_id, from_address, nonce, tx_hash, logical_tx, "
          + "to_address, value, data, fees_json, submitted_at_ms, resolved_at_ms) "
          + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
          + "ON CONFLICT(chain_id, from_address, nonce) DO UPDATE SET "
          + "tx_hash = excluded.tx_hash, logical_tx = excluded.logical_tx, "
          + "to_address = excluded.to_address, value = excluded.value, data = excluded.data, "
          + "fees_json = excluded.fees_json, submitted_at_ms = excluded.submitted_at_ms, "
          + "resolved_at_ms = excluded.resolved_at_ms",
        [
          entry.chainId, entry.from.toLowerCase(), entry.nonce, entry.txHash, entry.logicalTx,
          entry.to.toLowerCase(), entry.value.toString(), entry.data, serializeFees(entry.fees),
          entry.submittedAtMs, entry.resolvedAtMs ?? null,
        ],
      );
    },
    read(key) {
      const row = db.get<Row>(
        "SELECT * FROM venue_tx_submissions WHERE chain_id = ? AND from_address = ? AND nonce = ?",
        [key.chainId, key.from.toLowerCase(), key.nonce],
      );
      return row === undefined ? undefined : toEntry(row);
    },
    markResolved(key, atMs = Date.now()) {
      db.run(
        "UPDATE venue_tx_submissions SET resolved_at_ms = ? "
          + "WHERE chain_id = ? AND from_address = ? AND nonce = ?",
        [atMs, key.chainId, key.from.toLowerCase(), key.nonce],
      );
    },
    unresolvedFrom(chainId, from, fromNonce, toNonce) {
      return db.all<Row>(
        "SELECT * FROM venue_tx_submissions WHERE chain_id = ? AND from_address = ? "
          + "AND nonce >= ? AND nonce < ? AND resolved_at_ms IS NULL ORDER BY nonce ASC",
        [chainId, from.toLowerCase(), fromNonce, toNonce],
      ).map(toEntry);
    },
  };
}
```

- [ ] **Step 4: Run the suite and export**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/ledger.test.ts`
Expected: PASS (5 tests).

Append to `src/index.ts`:

```ts
export { createTxSubmissionLedger, matchesRequest } from "./broadcast/ledger.js";
export type { TxSubmissionEntry, TxSubmissionKey, TxSubmissionLedger } from "./broadcast/ledger.js";
```

- [ ] **Step 5: Verify and commit**

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test`
Expected: PASS.

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): the durable (chainId, from, nonce) submission ledger

The Defender-relayer profile's persistent ledger, plus matchesRequest -- the
target-and-calldata identity guard that stops reconciliation from adopting a
foreign transaction that merely shares an EOA nonce.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: The Safe broadcast port

**Files:**
- Create: `packages/marketplace/venue-base/src/broadcast/safe.ts`, `src/broadcast/safe.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`, `packages/marketplace/testing/src/venue-conformance.ts`, `venue-conformance.test.ts`

**Interfaces:**
- Consumes: `withVenueLock`, `createTxSubmissionLedger`, `matchesRequest`, `classifyTransactionError`, `isNonceTooLow`, `isReplacementUnderpriced`, `bumpFees`, `backoffDelayMs`, `DEFAULT_BROADCAST_TUNING`, `STALE_SAFE_NONCE_TOKEN`; `SAFE_ABI`, `decodeSafeInnerRevert`, `formatDecodedRevert`, `SafeInnerRevertError` from binding.
- Produces:
  - `interface VenueSafeExecuteInput { readonly to: Address; readonly value: bigint; readonly data: Hex; readonly logicalTx: string }`
  - `interface VenueEoaTransactionInput { readonly to: Address; readonly value: bigint; readonly data: Hex; readonly logicalTx: string }`
  - `interface VenueSafeBroadcast extends SafeBroadcastPort { broadcastSafeTransaction(input: VenueSafeExecuteInput): Promise<Hex>; sendEoaTransaction(input: VenueEoaTransactionInput): Promise<Hex> }` — `SafeBroadcastPort` is binding's (`broadcastCreateTask`)
  - `createSafeBroadcast(input: { db: VenueStateDb; publicClient: PublicClient; walletClient: WalletClient; chain: MarketplaceChainConfig; safeAddress: Address; tuning?: Partial<typeof DEFAULT_BROADCAST_TUNING> }): VenueSafeBroadcast`
  - `class SafeOwnerMismatchError extends Error`
  - `describeVenueNonceRecovery(surface: VenueNonceRecoverySurface): void`

**These two methods are the primary public surface** (decision D11). `broadcastCreateTask` is a caller of `broadcastSafeTransaction`, not a separate path. From cutover stage 1 they are the **only** transaction paths in the operator process (cross-plan contract 1): every port in this package routes through `broadcastSafeTransaction`, and the surviving legacy EOA legs (the earning and bootstrap family, which signs with the Safe's owner key directly) re-point onto `sendEoaTransaction`. Both share one per-sender lock, one submission ledger, and one fee-bump machine.

- [ ] **Step 1: Write the failing unit test**

`packages/marketplace/venue-base/src/broadcast/safe.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "../state/db.js";
import { createTxSubmissionLedger } from "./ledger.js";
import { SafeOwnerMismatchError, createSafeBroadcast } from "./safe.js";

const SAFE = "0x00000000000000000000000000000000000000a1" as Address;
const SIGNER = "0x00000000000000000000000000000000000000f0" as Address;
const TARGET = "0x00000000000000000000000000000000000000cc" as Address;
const MINED = `0x${"1".repeat(64)}` as Hex;

interface Script {
  safeNonce?: bigint;
  isOwner?: boolean;
  writes: (Error | Hex)[];
  receipts?: Record<string, "success" | "reverted">;
  eoaNonces?: number[];
}

function clients(script: Script): { publicClient: PublicClient; walletClient: WalletClient; writeCalls: number } {
  const state = { writeCalls: 0 };
  const eoaNonces = [...(script.eoaNonces ?? [4, 4, 4, 4, 4, 4])];
  const publicClient = {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "nonce") return script.safeNonce ?? 3n;
      if (functionName === "getTransactionHash") return `0x${"9".repeat(64)}`;
      if (functionName === "isOwner") return script.isOwner ?? true;
      throw new Error(`unexpected read ${functionName}`);
    },
    async getTransactionCount() { return eoaNonces.shift() ?? 4; },
    async estimateFeesPerGas() { return { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }; },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      return { status: script.receipts?.[hash] ?? "success" };
    },
    async getTransactionReceipt({ hash }: { hash: Hex }) {
      const status = script.receipts?.[hash];
      if (status === undefined) throw new Error("not found");
      return { status };
    },
    async call() { return { data: "0x" }; },
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: SIGNER },
    chain: undefined,
    async signMessage() { return `0x${"a".repeat(130)}`; },
    async writeContract() {
      const next = script.writes[state.writeCalls];
      state.writeCalls += 1;
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("script exhausted");
      return next;
    },
    async sendTransaction() {
      const next = script.writes[state.writeCalls];
      state.writeCalls += 1;
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("script exhausted");
      return next;
    },
  } as unknown as WalletClient;
  return { publicClient, walletClient, get writeCalls() { return state.writeCalls; } } as never;
}

let dir: string;
let db: VenueStateDb;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-safe-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

function broadcaster(script: Script) {
  const { publicClient, walletClient } = clients(script);
  return createSafeBroadcast({
    db, publicClient, walletClient, chain: BASE_SEPOLIA_TODAY, safeAddress: SAFE,
    tuning: { baseDelayMs: 1, maxDelayMs: 2 },
  });
}

describe("Safe broadcast", () => {
  it("signs, broadcasts, records the submission and marks it resolved", async () => {
    const safe = broadcaster({ writes: [MINED] });
    expect(await safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" })).toBe(MINED);
    const entry = createTxSubmissionLedger(db).read({ chainId: 84532, from: SIGNER, nonce: 4 });
    expect(entry?.txHash).toBe(MINED);
    expect(entry?.logicalTx).toBe("claim");
    expect(entry?.resolvedAtMs).toBeDefined();
  });

  it("reconciles a nonce-too-low against a MATCHING mined ledger entry instead of re-signing", async () => {
    // Ledger identity is the LOGICAL (target, calldata) pair, so it matches the request's own
    // inner call -- not the Safe address the outer transaction happens to be sent to.
    createTxSubmissionLedger(db).record({
      chainId: 84532, from: SIGNER, nonce: 4, txHash: MINED, logicalTx: "claim",
      to: TARGET, value: 0n, data: "0xdeadbeef", fees: {}, submittedAtMs: 1,
    });
    const safe = broadcaster({
      writes: [new Error("nonce too low")], receipts: { [MINED]: "success" },
    });
    expect(await safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" })).toBe(MINED);
  });

  it("refuses to adopt a FOREIGN mined ledger entry and retries with a refreshed nonce", async () => {
    const foreign = `0x${"7".repeat(64)}` as Hex;
    createTxSubmissionLedger(db).record({
      chainId: 84532, from: SIGNER, nonce: 4, txHash: foreign, logicalTx: "other",
      to: SAFE, value: 0n, data: "0xcafebabe", fees: {}, submittedAtMs: 1,
    });
    const safe = broadcaster({
      writes: [new Error("nonce too low"), MINED],
      receipts: { [foreign]: "success", [MINED]: "success" },
      eoaNonces: [4, 5, 5],
    });
    expect(await safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" })).toBe(MINED);
  });

  it("stops immediately on a terminal inner revert instead of exhausting the budget", async () => {
    const safe = broadcaster({ writes: [new Error("execution reverted: GS013")] });
    await expect(safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" }))
      .rejects.toThrow(/GS013/);
  });

  it("names a non-owner signer rather than reporting a nonce race", async () => {
    const safe = broadcaster({ isOwner: false, writes: [new Error("execution reverted: GS026")] });
    await expect(safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" }))
      .rejects.toBeInstanceOf(SafeOwnerMismatchError);
  });

  it("gives up after the attempt budget on a repeatedly retryable failure", async () => {
    const safe = broadcaster({
      writes: Array.from({ length: 6 }, () => new Error("socket hang up")),
      eoaNonces: [4, 4, 4, 4, 4, 4, 4],
    });
    await expect(safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" }))
      .rejects.toThrow(/after 6 attempts/);
  });

  it("decodes a reverted receipt into a named inner revert carrying the tx hash", async () => {
    const safe = broadcaster({ writes: [MINED], receipts: { [MINED]: "reverted" } });
    await expect(safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" }))
      .rejects.toThrow(/reverted/);
  });

  it("broadcastCreateTask decodes the router taskId from the receipt logs", async () => {
    const safe = broadcaster({ writes: [MINED] });
    await expect(safe.broadcastCreateTask({ safeAddress: SAFE, to: TARGET, value: 1n, data: "0x01" }))
      .rejects.toThrow(/no TaskCreated event/);
  });

  it("sends a bare EOA transaction through the same ledger and nonce", async () => {
    const safe = broadcaster({ writes: [MINED] });
    expect(await safe.sendEoaTransaction({
      to: TARGET, value: 1n, data: "0x01", logicalTx: "earning.stake",
    })).toBe(MINED);
    const entry = createTxSubmissionLedger(db).read({ chainId: 84532, from: SIGNER, nonce: 4 });
    expect(entry?.logicalTx).toBe("earning.stake");
    expect(entry?.resolvedAtMs).toBeDefined();
  });

  it("serializes a Safe transaction and a bare EOA transaction on the same sender key", async () => {
    const safe = broadcaster({ writes: [MINED, `0x${"c".repeat(64)}` as Hex], eoaNonces: [4, 5, 5] });
    await safe.broadcastSafeTransaction({ to: TARGET, value: 0n, data: "0xdeadbeef", logicalTx: "claim" });
    await safe.sendEoaTransaction({ to: TARGET, value: 1n, data: "0x01", logicalTx: "earning.stake" });
    const ledger = createTxSubmissionLedger(db);
    expect(ledger.read({ chainId: 84532, from: SIGNER, nonce: 4 })?.logicalTx).toBe("claim");
    expect(ledger.read({ chainId: 84532, from: SIGNER, nonce: 5 })?.logicalTx).toBe("earning.stake");
  });

  it("reports a reverted EOA transaction without probing Safe ownership", async () => {
    const safe = broadcaster({ writes: [MINED], receipts: { [MINED]: "reverted" }, isOwner: false });
    await expect(safe.sendEoaTransaction({
      to: TARGET, value: 1n, data: "0x01", logicalTx: "earning.stake",
    })).rejects.toThrow(/EOA transaction \(earning\.stake\) reverted/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/safe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the Safe broadcast**

`packages/marketplace/venue-base/src/broadcast/safe.ts`:

```ts
// SPDX-License-Identifier: MIT

// The single transaction path in the operator process (composition design §6.1 single-broadcaster
// rule). Standards audit ruling 1 names the profile: per-sender serialized nonce assignment, a
// persistent submission ledger keyed (chainId, from, nonce), fee-bumped replacement, stuck-nonce
// eviction, reconcile-on-nonce-too-low. The two hand-rolled fragments -- the eth_sign `v + 4`
// adjustment and the pre-validated signature encoding -- are Safe-contract-specified behavior
// (Safe contracts spec, `checkNSignatures`), not invention.
import {
  SAFE_ABI,
  SafeInnerRevertError,
  decodeSafeInnerRevert,
  formatDecodedRevert,
  type MarketplaceChainConfig,
  type SafeBroadcastPort,
} from "@jinn-network/marketplace-binding";
import { JINN_ROUTER_V3_ABI } from "@jinn-network/marketplace-binding";
import { decodeEventLog, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { VenueStateDb } from "../state/db.js";
import { withVenueLock } from "../state/lock.js";
import {
  STALE_SAFE_NONCE_TOKEN,
  classifyTransactionError,
  flattenErrorMessage,
  isNonceTooLow,
  isReplacementUnderpriced,
} from "./classify.js";
import { DEFAULT_BROADCAST_TUNING, backoffDelayMs, bumpFees, type FeeSnapshot } from "./fees.js";
import { createTxSubmissionLedger, matchesRequest } from "./ledger.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export class SafeOwnerMismatchError extends Error {
  constructor(readonly signer: Address, readonly safeAddress: Address) {
    super(
      `Safe execTransaction rejected (GS026: ${signer} is not an owner of ${safeAddress}) -- `
        + "this is a configuration fault, never a nonce race",
    );
    this.name = "SafeOwnerMismatchError";
  }
}

export interface VenueSafeExecuteInput {
  /** The INNER call the Safe makes. */
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  /** Stable operation label recorded in the ledger, e.g. "claim" or "settle.solution". */
  readonly logicalTx: string;
}

/** A bare transaction from the Safe's owner EOA -- the earning and bootstrap family's shape. */
export interface VenueEoaTransactionInput {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly logicalTx: string;
}

/**
 * The two general broadcast surfaces plus the binding's posting verb. Both general paths run
 * through ONE lock, ONE nonce ledger, and ONE fee-bump machine keyed on the sender EOA --
 * because the Safe's owner and the bare-EOA sender are the same key.
 */
export interface VenueSafeBroadcast extends SafeBroadcastPort {
  broadcastSafeTransaction(input: VenueSafeExecuteInput): Promise<Hex>;
  sendEoaTransaction(input: VenueEoaTransactionInput): Promise<Hex>;
}

export interface SafeBroadcastInput {
  readonly db: VenueStateDb;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly chain: MarketplaceChainConfig;
  readonly safeAddress: Address;
  readonly tuning?: Partial<typeof DEFAULT_BROADCAST_TUNING>;
}

/** Safe's contract-signature convention for an `eth_sign` signature: `v` is offset by 4. */
function toSafeSignature(ethSignature: Hex): Hex {
  const bytes = Uint8Array.from(
    (ethSignature.slice(2).match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)),
  );
  bytes[64] = bytes[64]! + 4;
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export function createSafeBroadcast(input: SafeBroadcastInput): VenueSafeBroadcast {
  const { db, publicClient, walletClient, chain, safeAddress } = input;
  const tuning = { ...DEFAULT_BROADCAST_TUNING, ...input.tuning };
  const ledger = createTxSubmissionLedger(db);
  const account = walletClient.account;
  if (account === undefined) throw new Error("venue Safe broadcast requires a wallet client with an account");
  const from = account.address;
  const lockKey = `eoa:${chain.chainId}:${from.toLowerCase()}`;

  async function assertOwner(): Promise<void> {
    const owner = await publicClient.readContract({
      address: safeAddress, abi: SAFE_ABI, functionName: "isOwner", args: [from],
    });
    if (owner !== true) throw new SafeOwnerMismatchError(from, safeAddress);
  }

  async function decodeInner(to: Address, value: bigint, data: Hex, txHash: Hex | null): Promise<Error | undefined> {
    const inner = await decodeSafeInnerRevert(publicClient, { safeAddress, to, value, data });
    if (inner.decodedName !== null) {
      return new SafeInnerRevertError(
        `Safe execTransaction inner revert: ${formatDecodedRevert(inner.decodedName, inner.decodedArgs)}`
          + (txHash === null ? "" : ` (txHash=${txHash})`),
        inner.innerSelector, inner.innerData, inner.decodedName, inner.decodedArgs, txHash,
      );
    }
    if (inner.innerSelector !== null) {
      return new SafeInnerRevertError(
        `Safe execTransaction inner revert (undecoded selector ${inner.innerSelector})`,
        inner.innerSelector, inner.innerData, null, null, txHash,
      );
    }
    return undefined;
  }

  async function attempt(
    exec: VenueSafeExecuteInput,
    attemptIndex: number,
    pinnedNonce: number,
    previousFees: FeeSnapshot | undefined,
  ): Promise<{ hash: Hex; fees: FeeSnapshot }> {
    const safeNonce = await publicClient.readContract({
      address: safeAddress, abi: SAFE_ABI, functionName: "nonce",
    });
    const safeTxHash = await publicClient.readContract({
      address: safeAddress, abi: SAFE_ABI, functionName: "getTransactionHash",
      args: [exec.to, exec.value, exec.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, safeNonce],
    });
    const signature = toSafeSignature(
      await walletClient.signMessage({ account, message: { raw: safeTxHash as Hex } }) as Hex,
    );
    const estimate = await publicClient.estimateFeesPerGas();
    const fees = bumpFees(
      { maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas },
      previousFees, attemptIndex, tuning,
    );
    const hash = await walletClient.writeContract({
      address: safeAddress, abi: SAFE_ABI, functionName: "execTransaction",
      args: [exec.to, exec.value, exec.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, signature],
      account, chain: walletClient.chain, value: exec.value, nonce: pinnedNonce, ...fees,
    } as never);
    return { hash, fees };
  }

  async function eoaAttempt(
    exec: VenueEoaTransactionInput,
    attemptIndex: number,
    pinnedNonce: number,
    previousFees: FeeSnapshot | undefined,
  ): Promise<{ hash: Hex; fees: FeeSnapshot }> {
    const estimate = await publicClient.estimateFeesPerGas();
    const fees = bumpFees(
      { maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas },
      previousFees, attemptIndex, tuning,
    );
    const hash = await walletClient.sendTransaction({
      account, chain: walletClient.chain, to: exec.to, value: exec.value, data: exec.data,
      nonce: pinnedNonce, ...fees,
    } as never);
    return { hash, fees };
  }

  /**
   * The one retry/ledger/lock machine both public paths share. `kind` selects the Safe-specific
   * post-mortem (owner probe + inner-revert decode); everything else -- the per-sender lock, the
   * pinned nonce, the ledger identity, the reconcile-first recovery, the fee bump, and the
   * attempt budget -- is identical, because the Safe's owner EOA and the bare-EOA sender ARE THE
   * SAME KEY. Two independent nonce stacks over one key is the #525/#562/#897 failure class.
   */
  async function broadcastWithLedger(
    exec: VenueSafeExecuteInput | VenueEoaTransactionInput,
    kind: "safe" | "eoa",
  ): Promise<Hex> {
    return withVenueLock(db, lockKey, async () => {
      let pinnedNonce = await publicClient.getTransactionCount({ address: from, blockTag: "pending" });
      let previousFees: FeeSnapshot | undefined;
      let lastError: unknown;

      for (let attemptIndex = 0; attemptIndex < tuning.maxAttempts; attemptIndex += 1) {
        const key = { chainId: chain.chainId, from, nonce: pinnedNonce };
        try {
          const { hash, fees } = kind === "safe"
            ? await attempt(exec, attemptIndex, pinnedNonce, previousFees)
            : await eoaAttempt(exec, attemptIndex, pinnedNonce, previousFees);
          previousFees = fees;
          // Ledger identity is the LOGICAL (target, calldata) pair in both paths: for a Safe
          // transaction that is the inner call, whose bytes are stable across retries, while the
          // outer execTransaction calldata carries a per-attempt signature and is not.
          ledger.record({
            ...key, txHash: hash, logicalTx: exec.logicalTx, to: exec.to, value: exec.value,
            data: exec.data, fees, submittedAtMs: Date.now(),
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === "success") {
            ledger.markResolved(key);
            return hash;
          }
          if (kind === "eoa") {
            throw new Error(`EOA transaction (${exec.logicalTx}) reverted (txHash=${hash})`);
          }
          await assertOwner();
          const inner = await decodeInner(exec.to, exec.value, exec.data, hash);
          throw inner ?? new Error(
            `Safe execTransaction reverted (${STALE_SAFE_NONCE_TOKEN}, txHash=${hash})`,
          );
        } catch (error) {
          lastError = error;
          if (error instanceof SafeOwnerMismatchError) throw error;
          const message = flattenErrorMessage(error).toLowerCase();
          if (kind === "safe" && message.includes("gs026")) { await assertOwner(); }

          if (isNonceTooLow(error) || isReplacementUnderpriced(error)) {
            // Reconcile FIRST, at the ORIGINAL pinned nonce, before refreshing it: a transaction
            // already mined at that nonce may be this very request, and re-signing at an advanced
            // Safe nonce is NOT idempotent -- it re-delivers and reverts as already-claimed.
            const recorded = ledger.read(key);
            if (recorded !== undefined && matchesRequest(recorded, { to: exec.to, data: exec.data })) {
              try {
                const receipt = await publicClient.getTransactionReceipt({ hash: recorded.txHash });
                if (receipt.status === "success") {
                  ledger.markResolved(key);
                  return recorded.txHash;
                }
              } catch {
                // Not yet mined, or a transient read failure: fall through and retry.
              }
            }
            pinnedNonce = await publicClient.getTransactionCount({ address: from, blockTag: "pending" });
          }

          if (classifyTransactionError(error) === "terminal") throw error;
          if (attemptIndex === tuning.maxAttempts - 1) break;
          await new Promise((resolve) =>
            setTimeout(resolve, backoffDelayMs(attemptIndex, tuning.baseDelayMs, tuning.maxDelayMs)));
        }
      }
      throw new Error(
        `${kind === "safe" ? "Safe execTransaction" : "EOA transaction"} (${exec.logicalTx}) `
          + `failed after ${tuning.maxAttempts} attempts: ${flattenErrorMessage(lastError)}`,
        { cause: lastError },
      );
    });
  }

  return {
    async broadcastSafeTransaction(exec) { return broadcastWithLedger(exec, "safe"); },
    async sendEoaTransaction(exec) { return broadcastWithLedger(exec, "eoa"); },
    async broadcastCreateTask(createInput) {
      const txHash = await broadcastWithLedger({
        to: createInput.to, value: createInput.value, data: createInput.data,
        logicalTx: "posting.createTask",
      }, "safe");
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics, strict: true,
          });
          if (decoded.eventName === "TaskCreated") {
            return { taskId: (decoded.args as { taskId: bigint }).taskId, txHash };
          }
        } catch {
          // Not a router event; the Safe receipt carries several.
        }
      }
      throw new Error(`posting transaction ${txHash} carries no TaskCreated event`);
    },
  };
}
```

- [ ] **Step 4: Run the unit suite**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/safe.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Add the nonce-recovery kit suite**

Append to `packages/marketplace/testing/src/venue-conformance.ts`:

```ts
import { NONCE_RECOVERY_FIXTURES } from "./venue-fixtures.js";

export interface VenueNonceRecoverySurface {
  /**
   * Applies the implementation's reconcile decision for one fixture and reports which branch it
   * took. The adapter package supplies this by driving `createSafeBroadcast` against scripted
   * clients; the kit owns only the expectations.
   */
  decide(fixture: (typeof NONCE_RECOVERY_FIXTURES)[number]): Promise<"reconciled" | "refresh-nonce-and-resign" | "terminal">;
}

/** Every legacy nonce/eviction recovery scenario, applied to the fresh broadcaster. */
export function describeVenueNonceRecovery(surface: VenueNonceRecoverySurface): void {
  describe("venue conformance: nonce and eviction recovery", () => {
    for (const fixture of NONCE_RECOVERY_FIXTURES) {
      it(fixture.name, async () => {
        expect(await surface.decide(fixture)).toBe(fixture.expected);
      });
    }
  });
}
```

Append to `packages/marketplace/testing/src/venue-conformance.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import {
  SafeOwnerMismatchError,
  createSafeBroadcast,
  createTxSubmissionLedger,
} from "@jinn-network/marketplace-venue-base";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import { describeVenueNonceRecovery } from "./venue-conformance.js";

const RECOVERY_SIGNER = "0x00000000000000000000000000000000000000f0";
const RECOVERY_SAFE = "0x0000000000000000000000000000000000000099";
const RECOVERED = `0x${"1".repeat(64)}`;
const FRESH = `0x${"2".repeat(64)}`;

describeVenueNonceRecovery({
  async decide(fixture) {
    const db = await openVenueStateDb(join(mkdtempSync(join(tmpdir(), "venue-nonce-")), "venue.db"));
    if (fixture.ledgerEntry !== undefined) {
      createTxSubmissionLedger(db).record({
        chainId: 84532, from: RECOVERY_SIGNER, nonce: 4, txHash: RECOVERED, logicalTx: "prior",
        to: fixture.ledgerEntry.to, value: 0n, data: fixture.ledgerEntry.data,
        fees: {}, submittedAtMs: 1,
      });
    }
    let writes = 0;
    const publicClient = {
      async readContract({ functionName }) {
        if (functionName === "nonce") return 3n;
        if (functionName === "getTransactionHash") return `0x${"9".repeat(64)}`;
        if (functionName === "isOwner") return !fixture.errorMessage.includes("GS026");
        throw new Error("unexpected read");
      },
      async getTransactionCount() { return 4; },
      async estimateFeesPerGas() { return { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }; },
      async waitForTransactionReceipt() { return { status: "success" }; },
      async getTransactionReceipt({ hash }) {
        if (hash === RECOVERED && fixture.ledgerEntry?.mined === true) return { status: "success" };
        throw new Error("not found");
      },
      async call() { return { data: "0x" }; },
    };
    const walletClient = {
      account: { address: RECOVERY_SIGNER }, chain: undefined,
      async signMessage() { return `0x${"a".repeat(130)}`; },
      async writeContract() {
        writes += 1;
        if (writes === 1) throw new Error(fixture.errorMessage);
        return FRESH;
      },
    };
    const safe = createSafeBroadcast({
      db, publicClient: publicClient as never, walletClient: walletClient as never,
      chain: BASE_SEPOLIA_TODAY, safeAddress: RECOVERY_SAFE as never,
      tuning: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    try {
      const hash = await safe.broadcastSafeTransaction({
        to: fixture.request.to as never, value: 0n, data: fixture.request.data as never,
        logicalTx: "conformance",
      });
      return hash === RECOVERED ? "reconciled" : "refresh-nonce-and-resign";
    } catch (error) {
      if (error instanceof SafeOwnerMismatchError) return "terminal";
      return "terminal";
    } finally {
      db.close();
    }
  },
});
```

(`openVenueStateDb`, `join`, and `tmpdir` are already imported at the top of that test file from Task 8.)

- [ ] **Step 6: Export and verify**

Append to `packages/marketplace/venue-base/src/index.ts`:

```ts
export { SafeOwnerMismatchError, createSafeBroadcast } from "./broadcast/safe.js";
export type {
  SafeBroadcastInput,
  VenueEoaTransactionInput,
  VenueSafeBroadcast,
  VenueSafeExecuteInput,
} from "./broadcast/safe.js";
```

Run:
```bash
cd packages/marketplace/venue-base && yarn typecheck && yarn test && yarn build
cd ../testing && yarn vitest run src/venue-conformance.test.ts
cd ../../.. && node --test .github/scripts/custody-boundaries.test.mjs
```
Expected: 11 unit tests PASS; 7 nonce-recovery kit cases PASS; custody guard PASS (no key material, no `process.env`).

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/venue-base/src packages/marketplace/testing/src
git commit -m "feat(venue-base): the single-broadcaster Safe execTransaction port

Cross-process lock, durable nonce ledger, fee-bumped retry, reconcile-first on
nonce-too-low at the ORIGINAL pinned nonce with the target-and-calldata identity
guard, decoded inner reverts, and a named non-owner failure. Gated by the seven
legacy nonce/eviction recovery fixtures.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: The claim writer

**Files:**
- Create: `packages/marketplace/venue-base/src/claim.ts`, `src/claim.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `VenueSafeBroadcast`, `JINN_ROUTER_V3_ABI`, `JINN_ROUTER_V4_ABI`, `MarketplaceChainConfig`, `ClaimPorts` from binding.
- Produces:
  - `type ClaimWriter = Pick<ClaimPorts, "claimTask">`
  - `createClaimWriter(input: { publicClient: PublicClient; safe: VenueSafeBroadcast; chain: MarketplaceChainConfig }): ClaimWriter`
  - `class ClaimReceiptError extends Error`

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/claim.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { BASE_SEPOLIA_TODAY, JINN_ROUTER_V3_ABI } from "@jinn-network/marketplace-binding";
import { encodeEventTopics, encodeAbiParameters, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { ClaimReceiptError, createClaimWriter } from "./claim.js";
import type { VenueSafeBroadcast } from "./broadcast/safe.js";

const MECH = "0x00000000000000000000000000000000000000dd" as Address;
const TX = `0x${"5".repeat(64)}` as Hex;

function attemptLog(taskId: bigint, attemptIndex: number, requestId: Hex) {
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_V3_ABI, eventName: "TaskAttemptCreated",
    args: { taskId, attemptIndex, requestId },
  });
  return {
    address: BASE_SEPOLIA_TODAY.jinnRouter,
    topics,
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [MECH, MECH, 1n],
    ),
  };
}

function client(logs: unknown[]): PublicClient {
  return { async getTransactionReceipt() { return { logs }; } } as unknown as PublicClient;
}

const safe = (calls: { to: Address; data: Hex }[]): VenueSafeBroadcast => ({
  async broadcastSafeTransaction(input) { calls.push({ to: input.to, data: input.data }); return TX; },
  async sendEoaTransaction() { throw new Error("unused"); },
  async broadcastCreateTask() { throw new Error("unused"); },
});

describe("claim writer", () => {
  it("broadcasts claimTask through the Safe and returns the router-emitted identity", async () => {
    const calls: { to: Address; data: Hex }[] = [];
    const requestId = `0x${"6".repeat(64)}` as Hex;
    const writer = createClaimWriter({
      publicClient: client([attemptLog(42n, 3, requestId)]),
      safe: safe(calls), chain: BASE_SEPOLIA_TODAY,
    });
    const receipt = await writer.claimTask({ taskId: 42n, priorityMech: MECH });
    expect(receipt).toEqual({ attemptIndex: 3, requestId, txHash: TX });
    expect(calls[0]!.to).toBe(BASE_SEPOLIA_TODAY.jinnRouter);
    expect(calls[0]!.data.startsWith("0x")).toBe(true);
  });

  it("refuses a receipt that carries no attempt event rather than inventing an index", async () => {
    const writer = createClaimWriter({
      publicClient: client([]), safe: safe([]), chain: BASE_SEPOLIA_TODAY,
    });
    await expect(writer.claimTask({ taskId: 42n, priorityMech: MECH }))
      .rejects.toBeInstanceOf(ClaimReceiptError);
  });

  it("refuses a receipt carrying more than one attempt event for the same task", async () => {
    const writer = createClaimWriter({
      publicClient: client([
        attemptLog(42n, 3, `0x${"6".repeat(64)}`),
        attemptLog(42n, 4, `0x${"7".repeat(64)}`),
      ]),
      safe: safe([]), chain: BASE_SEPOLIA_TODAY,
    });
    await expect(writer.claimTask({ taskId: 42n, priorityMech: MECH }))
      .rejects.toThrow(/exactly one/);
  });

  it("omits requestId in the revised generation, which binds only task-attempt identity", async () => {
    const revised = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    const writer = createClaimWriter({
      publicClient: client([]), safe: safe([]), chain: revised,
    });
    await expect(writer.claimTask({ taskId: 42n, priorityMech: MECH }))
      .rejects.toBeInstanceOf(ClaimReceiptError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/claim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the claim writer**

`packages/marketplace/venue-base/src/claim.ts`:

```ts
// SPDX-License-Identifier: MIT

// `ClaimPorts.claimTask` (composition design §6.1). The port is the WRITE only -- the rest of
// ClaimPorts is per-engagement data the host composes (decision D3). Today-mode claims bind a
// requestId; revised claims bind only monotonic task-attempt identity, and `claimAttempt`
// enforces the asymmetry, so this writer must report exactly what the generation emits.
import {
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
  type ClaimPorts,
  type MarketplaceChainConfig,
} from "@jinn-network/marketplace-binding";
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import type { VenueSafeBroadcast } from "./broadcast/safe.js";

export type ClaimWriter = Pick<ClaimPorts, "claimTask">;

export class ClaimReceiptError extends Error {
  constructor(readonly txHash: Hex, readonly taskId: bigint, detail: string) {
    super(`claim transaction ${txHash} for task ${taskId}: ${detail}`);
    this.name = "ClaimReceiptError";
  }
}

export interface ClaimWriterInput {
  readonly publicClient: PublicClient;
  readonly safe: VenueSafeBroadcast;
  readonly chain: MarketplaceChainConfig;
}

export function createClaimWriter(input: ClaimWriterInput): ClaimWriter {
  const { publicClient, safe, chain } = input;
  const abi = chain.generation === "today" ? JINN_ROUTER_V3_ABI : JINN_ROUTER_V4_ABI;

  return {
    async claimTask({ taskId, priorityMech }: { taskId: bigint; priorityMech: Address }) {
      const data = encodeFunctionData({ abi, functionName: "claimTask", args: [taskId, priorityMech] });
      const txHash = await safe.broadcastSafeTransaction({
        to: chain.jinnRouter, value: 0n, data, logicalTx: "claim.task",
      });

      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      const matches: { attemptIndex: number; requestId?: Hex }[] = [];
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
          if (decoded.eventName !== "TaskAttemptCreated") continue;
          const args = decoded.args as { taskId: bigint; attemptIndex: number; requestId?: Hex };
          if (args.taskId !== taskId) continue;
          matches.push(
            args.requestId === undefined
              ? { attemptIndex: Number(args.attemptIndex) }
              : { attemptIndex: Number(args.attemptIndex), requestId: args.requestId },
          );
        } catch {
          // Not a router event; a Safe receipt carries several.
        }
      }
      if (matches.length === 0) {
        throw new ClaimReceiptError(txHash, taskId, "carries no TaskAttemptCreated event");
      }
      if (matches.length > 1) {
        throw new ClaimReceiptError(
          txHash, taskId,
          `carries ${matches.length} TaskAttemptCreated events; exactly one is required to bind attempt identity`,
        );
      }
      const match = matches[0]!;
      if (chain.generation === "today") {
        if (match.requestId === undefined) {
          throw new ClaimReceiptError(txHash, taskId, "today-generation attempt event carries no requestId");
        }
        return { attemptIndex: match.attemptIndex, requestId: match.requestId, txHash };
      }
      return { attemptIndex: match.attemptIndex, txHash };
    },
  };
}
```

- [ ] **Step 4: Run the suite, export, verify**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/claim.test.ts`
Expected: PASS (4 tests).

Append to `src/index.ts`:

```ts
export { ClaimReceiptError, createClaimWriter } from "./claim.js";
export type { ClaimWriter, ClaimWriterInput } from "./claim.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): the claim writer

ClaimPorts.claimTask over the single Safe broadcaster, reading attempt identity
from exactly one router TaskAttemptCreated event and honoring the
today-binds-requestId / revised-binds-attempt-identity asymmetry.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Settlement fact readers

**Files:**
- Create: `packages/marketplace/venue-base/src/abi/venue-extras.ts`, `src/abi/venue-extras.test.ts`, `src/settlement/reads.ts`, `src/settlement/reads.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `MECH_ABI`, `TASK_COORDINATOR_ABI`, `MarketplaceChainConfig`, `SettlementPorts` from binding.
- Produces:
  - `TASK_COORDINATOR_REF_ABI`, `JINN_ROUTER_V3_EVALUATION_ABI`, `JINN_ROUTER_V4_RELEASE_ABI` — the ABI entries the binding does not export, transcribed from `contracts/src/tasks/TaskCoordinator.sol` and `contracts/src/tasks/TaskCoordinatorV4.sol`
  - `createSettlementReaders(input: { publicClient: PublicClient; chain: MarketplaceChainConfig; deliverLookbackBlocks?: bigint; chunkBlocks?: bigint }): Pick<SettlementPorts, "readMechDeliveryFacts" | "readRouterDeliveryFacts">`
  - `class MechDeliveryFactsNotFoundError extends Error`

- [ ] **Step 1: Write the failing ABI selector test**

`packages/marketplace/venue-base/src/abi/venue-extras.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  JINN_ROUTER_V3_EVALUATION_ABI,
  JINN_ROUTER_V4_RELEASE_ABI,
  TASK_COORDINATOR_REF_ABI,
} from "./venue-extras.js";

describe("venue-local ABI slices", () => {
  it("pins the coordinator reference readers to their Solidity signatures", () => {
    const selectors = TASK_COORDINATOR_REF_ABI.map((entry) => [entry.name, toFunctionSelector(entry)]);
    expect(Object.fromEntries(selectors)).toEqual({
      getRequestRef: toFunctionSelector("function getRequestRef(bytes32) returns (uint256,uint32,bool)"),
      getVerdictRequestRef: toFunctionSelector("function getVerdictRequestRef(bytes32) returns (uint256,uint32,uint32,bool)"),
      getVerdict: toFunctionSelector(
        "function getVerdict(uint256,uint32,uint32) returns ((uint256,uint32,uint32,address,bytes32,bytes32,uint8,uint8))",
      ),
    });
  });

  it("pins the today-generation evaluation claim signature", () => {
    expect(toFunctionSelector(JINN_ROUTER_V3_EVALUATION_ABI[0]!)).toBe(
      toFunctionSelector("function claimEvaluation(uint256,uint32,address,bytes32) returns (uint32,bytes32)"),
    );
  });

  it("pins the revised-generation verdict release signature", () => {
    expect(toFunctionSelector(JINN_ROUTER_V4_RELEASE_ABI[0]!)).toBe(
      toFunctionSelector("function releaseVerdict(uint256,uint32,uint32)"),
    );
  });
});
```

- [ ] **Step 2: Implement the ABI slices**

`packages/marketplace/venue-base/src/abi/venue-extras.ts`:

```ts
// SPDX-License-Identifier: MIT

// ABI entries the binding does not export, transcribed from the tracked Solidity sources
// (`contracts/src/tasks/TaskCoordinator.sol`, `TaskCoordinatorV4.sol`). They live here rather
// than in the binding because they serve venue MECHANICS -- resolving a requestId back to its
// engagement, reading a verdict record, and the evaluation-leg writes -- not the binding's
// document grammar. `venue-extras.test.ts` pins every selector against its canonical signature
// so a Solidity change surfaces as a failing selector, not as a silent decode miss.

export const TASK_COORDINATOR_REF_ABI = [
  {
    type: "function", name: "getRequestRef", stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "exists", type: "bool" },
    ],
  },
  {
    type: "function", name: "getVerdictRequestRef", stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "verdictIndex", type: "uint32" },
      { name: "exists", type: "bool" },
    ],
  },
  {
    type: "function", name: "getVerdict", stateMutability: "view",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "verdictIndex", type: "uint32" },
    ],
    outputs: [{
      name: "verdict", type: "tuple",
      components: [
        { name: "taskId", type: "uint256" },
        { name: "attemptIndex", type: "uint32" },
        { name: "verdictIndex", type: "uint32" },
        { name: "evaluator", type: "address" },
        { name: "requestId", type: "bytes32" },
        { name: "verdictCidDigest", type: "bytes32" },
        { name: "verdictCode", type: "uint8" },
        { name: "status", type: "uint8" },
      ],
    }],
  },
] as const;

export const JINN_ROUTER_V3_EVALUATION_ABI = [{
  type: "function", name: "claimEvaluation", stateMutability: "nonpayable",
  inputs: [
    { name: "taskId", type: "uint256" },
    { name: "attemptIndex", type: "uint32" },
    { name: "evaluatorMech", type: "address" },
    { name: "evaluationTaskCidDigest", type: "bytes32" },
  ],
  outputs: [
    { name: "verdictIndex", type: "uint32" },
    { name: "requestId", type: "bytes32" },
  ],
}] as const;

export const JINN_ROUTER_V4_RELEASE_ABI = [{
  type: "function", name: "releaseVerdict", stateMutability: "nonpayable",
  inputs: [
    { name: "taskId", type: "uint256" },
    { name: "attemptIndex", type: "uint32" },
    { name: "verdictIndex", type: "uint32" },
  ],
  outputs: [],
}] as const;
```

- [ ] **Step 3: Run the selector test**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/abi/venue-extras.test.ts`
Expected: PASS (3 tests). If a selector mismatches, stop — the transcription is wrong; re-read the Solidity source rather than adjusting the expectation.

- [ ] **Step 4: Write the failing readers test**

`packages/marketplace/venue-base/src/settlement/reads.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { BASE_SEPOLIA_TODAY, MECH_ABI } from "@jinn-network/marketplace-binding";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { MechDeliveryFactsNotFoundError, createSettlementReaders } from "./reads.js";

const REQUEST = `0x${"3".repeat(64)}` as Hex;
const DIGEST_HEX = "4".repeat(64);
const MECH = "0x00000000000000000000000000000000000000dd" as Address;

function deliverLog(requestId: Hex, digestHex: string) {
  return {
    address: MECH,
    topics: encodeEventTopics({ abi: MECH_ABI, eventName: "Deliver", args: { mech: MECH } }),
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes" }],
      [requestId, 1n, `0x01551220${digestHex}`],
    ),
    blockNumber: 500n,
  };
}

function client(options: {
  logs?: unknown[];
  requestRef?: readonly [bigint, number, boolean];
  attemptDigest?: Hex;
}): PublicClient {
  return {
    async getBlockNumber() { return 1_000n; },
    async getLogs() { return options.logs ?? []; },
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "getRequestRef") return options.requestRef ?? [7n, 2, true];
      if (functionName === "getAttempt") {
        return {
          taskId: 7n, attemptIndex: 2, operator: MECH, requestId: REQUEST,
          solutionCidDigest: options.attemptDigest ?? (`0x${DIGEST_HEX}` as Hex),
          solutionWeight: 0n, verdictCount: 0, status: 4,
        };
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("settlement fact readers", () => {
  it("reads the Mech's sha256 CID digest for a requestId", async () => {
    const readers = createSettlementReaders({
      publicClient: client({ logs: [deliverLog(REQUEST, DIGEST_HEX)] }), chain: BASE_SEPOLIA_TODAY,
    });
    await expect(readers.readMechDeliveryFacts({ requestId: REQUEST, config: BASE_SEPOLIA_TODAY }))
      .resolves.toEqual({ requestId: REQUEST, sha256CidDigest: `sha256:${DIGEST_HEX}` });
  });

  it("throws rather than fabricating facts when no Deliver event exists", async () => {
    const readers = createSettlementReaders({
      publicClient: client({ logs: [] }), chain: BASE_SEPOLIA_TODAY,
    });
    await expect(readers.readMechDeliveryFacts({ requestId: REQUEST, config: BASE_SEPOLIA_TODAY }))
      .rejects.toBeInstanceOf(MechDeliveryFactsNotFoundError);
  });

  it("resolves today router facts through getRequestRef then getAttempt", async () => {
    const readers = createSettlementReaders({
      publicClient: client({}), chain: BASE_SEPOLIA_TODAY,
    });
    await expect(readers.readRouterDeliveryFacts({ requestId: REQUEST, config: BASE_SEPOLIA_TODAY }))
      .resolves.toEqual({
        generation: "today", requestId: REQUEST, keccakEvidenceHash: `0x${DIGEST_HEX}`,
      });
  });

  it("refuses an unknown requestId instead of reporting a zero evidence hash", async () => {
    const readers = createSettlementReaders({
      publicClient: client({ requestRef: [0n, 0, false] }), chain: BASE_SEPOLIA_TODAY,
    });
    await expect(readers.readRouterDeliveryFacts({ requestId: REQUEST, config: BASE_SEPOLIA_TODAY }))
      .rejects.toThrow(/no engagement/);
  });

  it("reports revised router facts with the exact sha256 digest and engagement identity", async () => {
    const revised = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    const readers = createSettlementReaders({ publicClient: client({}), chain: revised });
    await expect(readers.readRouterDeliveryFacts({ requestId: REQUEST, config: revised }))
      .resolves.toEqual({
        generation: "revised", requestId: REQUEST, taskId: 7n, attemptIndex: 2,
        sha256Digest: `sha256:${DIGEST_HEX}`,
      });
  });
});
```

- [ ] **Step 5: Implement the readers**

`packages/marketplace/venue-base/src/settlement/reads.ts`:

```ts
// SPDX-License-Identifier: MIT

// The two independently-available chain facts settlement gates on (binding §6.3): the Mech's
// own Deliver event, and the router/coordinator's recorded engagement. Both are read, never
// asserted -- `settleDelivery` compares them against the sealed Delivery's own digests and
// rejects any divergence.
import {
  MECH_ABI,
  TASK_COORDINATOR_ABI,
  type MarketplaceChainConfig,
  type MechDeliveryFacts,
  type RouterDeliveryFacts,
  type SettlementPorts,
} from "@jinn-network/marketplace-binding";
import { decodeEventLog, type Address, type Hex, type PublicClient } from "viem";
import { DEFAULT_CHUNK_BLOCKS, blockChunks } from "../chain/chunking.js";
import { TASK_COORDINATOR_REF_ABI } from "../abi/venue-extras.js";

/** Deliver lookback wide enough for a slow Mech, narrow enough to stay inside RPC quota. */
export const DEFAULT_DELIVER_LOOKBACK_BLOCKS = 100_000n;

export class MechDeliveryFactsNotFoundError extends Error {
  constructor(readonly requestId: Hex, lookbackBlocks: bigint) {
    super(
      `no Mech Deliver event for request ${requestId} within the last ${lookbackBlocks} blocks -- `
        + "settlement refuses to proceed without the independent Mech fact",
    );
    this.name = "MechDeliveryFactsNotFoundError";
  }
}

export type SettlementReaders = Pick<
  SettlementPorts,
  "readMechDeliveryFacts" | "readRouterDeliveryFacts"
>;

export interface SettlementReadersInput {
  readonly publicClient: PublicClient;
  readonly chain: MarketplaceChainConfig;
  readonly deliverLookbackBlocks?: bigint;
  readonly chunkBlocks?: bigint;
}

/** The Mech's `data` payload carries the raw-codec CID prefix `0x01551220` + the 32-byte digest. */
function digestFromDeliverData(data: Hex): `sha256:${string}` | undefined {
  const hex = data.slice(2).toLowerCase();
  const marker = hex.indexOf("01551220");
  if (marker < 0 || hex.length < marker + 8 + 64) return undefined;
  return `sha256:${hex.slice(marker + 8, marker + 8 + 64)}`;
}

export function createSettlementReaders(input: SettlementReadersInput): SettlementReaders {
  const { publicClient, chain } = input;
  const lookback = input.deliverLookbackBlocks ?? DEFAULT_DELIVER_LOOKBACK_BLOCKS;
  const chunkBlocks = input.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS;

  return {
    async readMechDeliveryFacts({ requestId }): Promise<MechDeliveryFacts> {
      const head = await publicClient.getBlockNumber();
      const from = head > lookback ? head - lookback : 0n;
      // Newest-first: a delivery we are settling was emitted recently, so the first chunk
      // usually answers and the scan never pays for the whole lookback window.
      for (const [start, end] of [...blockChunks(from, head, chunkBlocks)].reverse()) {
        // eslint-disable-next-line no-await-in-loop -- ordered scan with an early exit.
        const logs = await publicClient.getLogs({ fromBlock: start, toBlock: end });
        for (const log of logs.reverse()) {
          try {
            const decoded = decodeEventLog({
              abi: MECH_ABI, data: log.data, topics: log.topics, strict: true,
            });
            const args = decoded.args as { requestId: Hex; data: Hex };
            if (args.requestId.toLowerCase() !== requestId.toLowerCase()) continue;
            const sha256CidDigest = digestFromDeliverData(args.data);
            if (sha256CidDigest === undefined) continue;
            return { requestId, sha256CidDigest };
          } catch {
            // Not a Deliver event.
          }
        }
      }
      throw new MechDeliveryFactsNotFoundError(requestId, lookback);
    },

    async readRouterDeliveryFacts({ requestId, config }): Promise<RouterDeliveryFacts> {
      const ref = await publicClient.readContract({
        address: config.taskCoordinator, abi: TASK_COORDINATOR_REF_ABI,
        functionName: "getRequestRef", args: [requestId],
      }) as readonly [bigint, number, boolean];
      const [taskId, attemptIndex, exists] = ref;
      if (!exists) {
        throw new Error(`request ${requestId} resolves to no engagement on ${config.taskCoordinator}`);
      }
      const attempt = await publicClient.readContract({
        address: config.taskCoordinator, abi: TASK_COORDINATOR_ABI,
        functionName: "getAttempt", args: [taskId, attemptIndex],
      }) as { solutionCidDigest: Hex };

      if (config.generation === "today") {
        return {
          generation: "today", requestId,
          keccakEvidenceHash: attempt.solutionCidDigest,
        };
      }
      return {
        generation: "revised", requestId, taskId, attemptIndex: Number(attemptIndex),
        sha256Digest: `sha256:${attempt.solutionCidDigest.slice(2).toLowerCase()}`,
      };
    },
  };
}

export type { Address };
```

- [ ] **Step 6: Run the suite, export, verify**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/settlement src/abi`
Expected: PASS (3 selector + 5 reader tests).

Append to `src/index.ts`:

```ts
export {
  JINN_ROUTER_V3_EVALUATION_ABI,
  JINN_ROUTER_V4_RELEASE_ABI,
  TASK_COORDINATOR_REF_ABI,
} from "./abi/venue-extras.js";
export {
  DEFAULT_DELIVER_LOOKBACK_BLOCKS,
  MechDeliveryFactsNotFoundError,
  createSettlementReaders,
} from "./settlement/reads.js";
export type { SettlementReaders, SettlementReadersInput } from "./settlement/reads.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): settlement fact readers and the venue-local ABI slices

Mech Deliver digest by newest-first chunked scan, router facts resolved through
getRequestRef then getAttempt, and selector-pinned ABI entries transcribed from
the tracked Solidity sources. Every reader refuses rather than fabricating.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Settlement writes and the assembled `SettlementPorts`

**Files:**
- Create: `packages/marketplace/venue-base/src/settlement/writes.ts`, `src/settlement/writes.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `createSettlementReaders`, `VenueSafeBroadcast`, `classifyTransactionError`; `JINN_ROUTER_V3_ABI`, `JINN_ROUTER_V4_ABI`, `SettlementPorts`, `IpfsPinPort` from binding.
- Produces:
  - `createSettlementPorts(input: { publicClient: PublicClient; safe: VenueSafeBroadcast; chain: MarketplaceChainConfig; pin: IpfsPinPort["pin"]; verifySettlementGrade: SettlementPorts["verifySettlementGrade"]; priorityMech: Address; deliverLookbackBlocks?: bigint }): SettlementPorts`
  - `class RevisedSettlementUnsupportedError extends Error`

`claimSolutionDelivery` must map chain outcomes to the four statuses `settleDelivery` understands, and must never throw for a lost race — a race loss is `rejected` or `delivered-unsettled`, not an error.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/settlement/writes.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { BASE_SEPOLIA_TODAY, SafeInnerRevertError } from "@jinn-network/marketplace-binding";
import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { VenueSafeBroadcast } from "../broadcast/safe.js";
import { RevisedSettlementUnsupportedError, createSettlementPorts } from "./writes.js";

const REQUEST = `0x${"3".repeat(64)}` as Hex;
const DIGEST = `0x${"4".repeat(64)}` as Hex;
const MECH = "0x00000000000000000000000000000000000000dd" as Address;
const TX = `0x${"8".repeat(64)}` as Hex;

const safe = (result: Hex | Error): VenueSafeBroadcast => ({
  async broadcastSafeTransaction() { if (result instanceof Error) throw result; return result; },
  async sendEoaTransaction() { throw new Error("unused"); },
  async broadcastCreateTask() { throw new Error("unused"); },
});

const client = {
  async getBlockNumber() { return 10n; },
  async getLogs() { return []; },
  async readContract() { return [7n, 2, true] as const; },
} as unknown as PublicClient;

function ports(safeResult: Hex | Error, chain = BASE_SEPOLIA_TODAY) {
  return createSettlementPorts({
    publicClient: client, safe: safe(safeResult), chain,
    pin: async () => {}, verifySettlementGrade: async () => ({
      executorBinding: { status: "verified" },
      dispatchBinding: { status: "verified" },
      evaluationSpecification: { status: "not-applicable" },
    }),
    priorityMech: MECH,
  });
}

describe("settlement writes", () => {
  it("reports settled when the router claim lands", async () => {
    await expect(ports(TX).claimSolutionDelivery({ requestId: REQUEST, solutionDigest: DIGEST }))
      .resolves.toEqual({ status: "settled" });
  });

  it("maps an already-claimed revert to already-settled, not to an error", async () => {
    const revert = new SafeInnerRevertError(
      "inner", "0x22d686d9", "0x22d686d9", "RouterAlreadyClaimed", [REQUEST], null,
    );
    await expect(ports(revert).claimSolutionDelivery({ requestId: REQUEST, solutionDigest: DIGEST }))
      .resolves.toEqual({ status: "already-settled" });
  });

  it("maps a wrong-delivery-operator revert to a lost race, not to an error", async () => {
    const revert = new SafeInnerRevertError(
      "inner", "0x601188e3", "0x601188e3", "RouterWrongDeliveryOperator", [], null,
    );
    await expect(ports(revert).claimSolutionDelivery({ requestId: REQUEST, solutionDigest: DIGEST }))
      .resolves.toEqual({ status: "rejected" });
  });

  it("maps a not-delivered revert to delivered-unsettled so the caller can retry later", async () => {
    const revert = new SafeInnerRevertError(
      "inner", "0xe5a88624", "0xe5a88624", "RouterNotDelivered", [], null,
    );
    await expect(ports(revert).claimSolutionDelivery({ requestId: REQUEST, solutionDigest: DIGEST }))
      .resolves.toEqual({ status: "delivered-unsettled" });
  });

  it("propagates an unclassified failure rather than silently reporting a race loss", async () => {
    await expect(ports(new Error("provider exploded")).claimSolutionDelivery({
      requestId: REQUEST, solutionDigest: DIGEST,
    })).rejects.toThrow(/provider exploded/);
  });

  it("omits the revised settle port in the today generation", () => {
    expect(ports(TX).settleRevisedSolutionDelivery).toBeUndefined();
  });

  it("refuses the revised batch until the revised contracts are deployed", async () => {
    const revised = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    const settle = ports(TX, revised).settleRevisedSolutionDelivery!;
    await expect(settle({
      taskId: 7n, attemptIndex: 2, deliveryDigest: DIGEST, deliveryBytes: new Uint8Array([1]),
    })).rejects.toBeInstanceOf(RevisedSettlementUnsupportedError);
  });

  it("passes the injected pin and verifier straight through", async () => {
    const pinned: Uint8Array[] = [];
    const assembled = createSettlementPorts({
      publicClient: client, safe: safe(TX), chain: BASE_SEPOLIA_TODAY,
      pin: async (bytes) => { pinned.push(bytes); },
      verifySettlementGrade: async () => ({
        executorBinding: { status: "missing", detail: "no key binding" },
        dispatchBinding: { status: "verified" },
        evaluationSpecification: { status: "not-applicable" },
      }),
      priorityMech: MECH,
    });
    await assembled.pin(new Uint8Array([9]));
    expect(pinned).toEqual([new Uint8Array([9])]);
    const verification = await assembled.verifySettlementGrade({} as never);
    expect(verification.executorBinding.status).toBe("missing");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/settlement/writes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the writes**

`packages/marketplace/venue-base/src/settlement/writes.ts`:

```ts
// SPDX-License-Identifier: MIT

// The settlement chain writes plus the assembled `SettlementPorts`. Two host-owned members --
// `pin` (the registry pin port) and `verifySettlementGrade` (which owns injected trust and
// referenced-evidence resolvers a tier-3 venue adapter must not depend on) -- are passed in and
// forwarded verbatim (decision D2). A LOST RACE IS NOT AN ERROR: the router's refusals for an
// already-claimed or foreign delivery map onto the statuses `settleDelivery` reasons about.
import {
  JINN_ROUTER_V3_ABI,
  SafeInnerRevertError,
  type IpfsPinPort,
  type MarketplaceChainConfig,
  type SettlementPorts,
} from "@jinn-network/marketplace-binding";
import { encodeFunctionData, type Address, type PublicClient } from "viem";
import type { VenueSafeBroadcast } from "../broadcast/safe.js";
import { createSettlementReaders } from "./reads.js";

export class RevisedSettlementUnsupportedError extends Error {
  constructor(readonly chainId: number) {
    super(
      `the revised prepare -> signed Deliver -> claim batch is not available on chain ${chainId}: `
        + "no revised-generation deployment is configured. Post-claim callers must treat this as "
        + "a venue failure, not as a settlement rejection.",
    );
    this.name = "RevisedSettlementUnsupportedError";
  }
}

type ClaimStatus = "settled" | "already-settled" | "rejected" | "delivered-unsettled";

/** Router refusals that are settlement OUTCOMES, not faults. */
const CLAIM_OUTCOME_BY_REVERT: Readonly<Record<string, ClaimStatus>> = {
  RouterAlreadyClaimed: "already-settled",
  AlreadyClaimed: "already-settled",
  DeliveryAlreadyClaimed: "already-settled",
  TCAttemptAlreadyFinalized: "already-settled",
  RouterWrongDeliveryOperator: "rejected",
  RouterWrongRequester: "rejected",
  RouterWrongRequestKind: "rejected",
  TCNotAttemptOperator: "rejected",
  RouterNotDelivered: "delivered-unsettled",
};

export interface SettlementPortsInput {
  readonly publicClient: PublicClient;
  readonly safe: VenueSafeBroadcast;
  readonly chain: MarketplaceChainConfig;
  readonly pin: IpfsPinPort["pin"];
  readonly verifySettlementGrade: SettlementPorts["verifySettlementGrade"];
  readonly priorityMech: Address;
  readonly deliverLookbackBlocks?: bigint;
}

export function createSettlementPorts(input: SettlementPortsInput): SettlementPorts {
  const { publicClient, safe, chain } = input;
  const readers = createSettlementReaders(
    input.deliverLookbackBlocks === undefined
      ? { publicClient, chain }
      : { publicClient, chain, deliverLookbackBlocks: input.deliverLookbackBlocks },
  );

  const base: SettlementPorts = {
    pin: input.pin,
    verifySettlementGrade: input.verifySettlementGrade,
    readMechDeliveryFacts: readers.readMechDeliveryFacts,
    readRouterDeliveryFacts: readers.readRouterDeliveryFacts,
    async claimSolutionDelivery({ requestId, solutionDigest }) {
      const data = encodeFunctionData({
        abi: JINN_ROUTER_V3_ABI, functionName: "claimSolutionDelivery",
        args: [requestId, solutionDigest],
      });
      try {
        await safe.broadcastSafeTransaction({
          to: chain.jinnRouter, value: 0n, data, logicalTx: "settle.solution",
        });
        return { status: "settled" };
      } catch (error) {
        if (error instanceof SafeInnerRevertError && error.decodedName !== null) {
          const mapped = CLAIM_OUTCOME_BY_REVERT[error.decodedName];
          if (mapped !== undefined) return { status: mapped };
        }
        throw error;
      }
    },
  };

  if (chain.generation === "today") return base;

  return {
    ...base,
    async settleRevisedSolutionDelivery() {
      // The revised batch (prepare -> signed Marketplace Deliver -> router claim as one
      // revert-on-failure Safe batch) needs a deployed V4 stack. Until one is configured this
      // refuses loudly rather than half-executing a multi-step settlement.
      throw new RevisedSettlementUnsupportedError(chain.chainId);
    },
  };
}
```

- [ ] **Step 4: Run, export, verify, commit**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/settlement/writes.test.ts`
Expected: PASS (8 tests).

Append to `src/index.ts`:

```ts
export { RevisedSettlementUnsupportedError, createSettlementPorts } from "./settlement/writes.js";
export type { SettlementPortsInput } from "./settlement/writes.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test`
Expected: PASS.

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): settlement writes and the assembled SettlementPorts

Router refusals for an already-claimed or foreign delivery map onto settlement
statuses rather than throwing; anything unclassified propagates. Host-owned pin
and settlement-grade verifier are injected and forwarded verbatim (decision D2).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: The verdict leg (§6.1 enumeration gap, decision D9)

**Files:**
- Create: `packages/marketplace/venue-base/src/verdict.ts`, `src/verdict.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `VenueSafeBroadcast`, `TASK_COORDINATOR_REF_ABI`, `JINN_ROUTER_V3_EVALUATION_ABI`, `JINN_ROUTER_V4_RELEASE_ABI`, `createSettlementReaders`; `JINN_ROUTER_V3_ABI`, `JINN_ROUTER_V4_ABI`, `VerdictCode` from binding.
- Produces:
  - `interface VerdictFacts { readonly requestId: Hex; readonly taskId: bigint; readonly attemptIndex: number; readonly verdictIndex: number; readonly evaluator: Address; readonly verdictCidDigest: Hex; readonly verdictCode: VerdictCode; readonly status: number }`
  - `interface VerdictPorts { claimVerdictAttempt(input: { taskId: bigint; attemptIndex: number; evaluatorMech: Address; evaluationTaskCidDigest: Hex }): Promise<{ verdictIndex: number; requestId?: Hex; txHash: Hex }>; canClaimVerdictAttempt(input: { taskId: bigint; attemptIndex: number; evaluatorMech: Address; evaluationTaskCidDigest: Hex; from: Address }): Promise<{ ok: true } | { ok: false; reason: string; revertName: string | null }>; readVerdictFacts(input: { requestId: Hex }): Promise<VerdictFacts>; settleVerdictDelivery(input: { verdictRequestId: Hex; verdictDigest: Hex; verdictCode: VerdictCode }): Promise<{ status: "settled" | "already-settled" | "rejected" | "delivered-unsettled" }>; releaseVerdict(input: { taskId: bigint; attemptIndex: number; verdictIndex: number }): Promise<void | { ok: false; kind: "unsupported" }> }`
  - `createVerdictPorts(input: { publicClient: PublicClient; safe: VenueSafeBroadcast; chain: MarketplaceChainConfig }): VerdictPorts`
  - `class VerdictReceiptError extends Error`

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/verdict.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import {
  BASE_SEPOLIA_TODAY,
  JINN_ROUTER_V3_ABI,
  SafeInnerRevertError,
  VerdictCode,
} from "@jinn-network/marketplace-binding";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { VenueSafeBroadcast } from "./broadcast/safe.js";
import { VerdictReceiptError, createVerdictPorts } from "./verdict.js";

const MECH = "0x00000000000000000000000000000000000000dd" as Address;
const EVALUATOR = "0x00000000000000000000000000000000000000ee" as Address;
const TX = `0x${"b".repeat(64)}` as Hex;
const REQUEST = `0x${"c".repeat(64)}` as Hex;
const DIGEST = `0x${"d".repeat(64)}` as Hex;
const SPEC = `0x${"e".repeat(64)}` as Hex;

function evaluationLog(taskId: bigint, attemptIndex: number, verdictIndex: number) {
  return {
    address: BASE_SEPOLIA_TODAY.jinnRouter,
    topics: encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI, eventName: "EvaluationAttemptCreated",
      args: { taskId, attemptIndex, verdictIndex },
    }),
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [REQUEST, EVALUATOR, MECH, 1n],
    ),
  };
}

const safe = (result: Hex | Error): VenueSafeBroadcast => ({
  async broadcastSafeTransaction() { if (result instanceof Error) throw result; return result; },
  async sendEoaTransaction() { throw new Error("unused"); },
  async broadcastCreateTask() { throw new Error("unused"); },
});

function client(options: { logs?: unknown[]; simulate?: Error; verdictRef?: readonly [bigint, number, number, boolean] }): PublicClient {
  return {
    async getTransactionReceipt() { return { logs: options.logs ?? [] }; },
    async simulateContract() { if (options.simulate !== undefined) throw options.simulate; return { result: [0, REQUEST] }; },
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "getVerdictRequestRef") return options.verdictRef ?? [7n, 2, 1, true];
      if (functionName === "getVerdict") {
        return {
          taskId: 7n, attemptIndex: 2, verdictIndex: 1, evaluator: EVALUATOR,
          requestId: REQUEST, verdictCidDigest: DIGEST, verdictCode: 1, status: 3,
        };
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

function ports(safeResult: Hex | Error, clientOptions = {}, chain = BASE_SEPOLIA_TODAY) {
  return createVerdictPorts({ publicClient: client(clientOptions), safe: safe(safeResult), chain });
}

describe("verdict leg", () => {
  it("claims a verdict attempt and reads its identity from the router event", async () => {
    const result = await ports(TX, { logs: [evaluationLog(7n, 2, 1)] }).claimVerdictAttempt({
      taskId: 7n, attemptIndex: 2, evaluatorMech: MECH, evaluationTaskCidDigest: SPEC,
    });
    expect(result).toEqual({ verdictIndex: 1, requestId: REQUEST, txHash: TX });
  });

  it("refuses a claim receipt with no evaluation event", async () => {
    await expect(ports(TX, { logs: [] }).claimVerdictAttempt({
      taskId: 7n, attemptIndex: 2, evaluatorMech: MECH, evaluationTaskCidDigest: SPEC,
    })).rejects.toBeInstanceOf(VerdictReceiptError);
  });

  it("reports the named revert for a preflight refusal instead of a bare boolean", async () => {
    const refusal = new SafeInnerRevertError(
      "inner", "0x1aed7019", "0x1aed7019", "TCSolverSelfEvaluation", [], null,
    );
    await expect(ports(TX, { simulate: refusal }).canClaimVerdictAttempt({
      taskId: 7n, attemptIndex: 2, evaluatorMech: MECH, evaluationTaskCidDigest: SPEC, from: EVALUATOR,
    })).resolves.toEqual({ ok: false, reason: expect.stringContaining("TCSolverSelfEvaluation"), revertName: "TCSolverSelfEvaluation" });
  });

  it("reports a clean preflight", async () => {
    await expect(ports(TX, {}).canClaimVerdictAttempt({
      taskId: 7n, attemptIndex: 2, evaluatorMech: MECH, evaluationTaskCidDigest: SPEC, from: EVALUATOR,
    })).resolves.toEqual({ ok: true });
  });

  it("resolves verdict facts through getVerdictRequestRef then getVerdict", async () => {
    await expect(ports(TX, {}).readVerdictFacts({ requestId: REQUEST })).resolves.toEqual({
      requestId: REQUEST, taskId: 7n, attemptIndex: 2, verdictIndex: 1, evaluator: EVALUATOR,
      verdictCidDigest: DIGEST, verdictCode: VerdictCode.Pass, status: 3,
    });
  });

  it("refuses an unknown verdict requestId", async () => {
    await expect(ports(TX, { verdictRef: [0n, 0, 0, false] }).readVerdictFacts({ requestId: REQUEST }))
      .rejects.toThrow(/no verdict engagement/);
  });

  it("settles a verdict delivery and maps an already-delivered revert to already-settled", async () => {
    await expect(ports(TX, {}).settleVerdictDelivery({
      verdictRequestId: REQUEST, verdictDigest: DIGEST, verdictCode: VerdictCode.Pass,
    })).resolves.toEqual({ status: "settled" });

    const revert = new SafeInnerRevertError(
      "inner", "0xb88eae99", "0xb88eae99", "TCVerdictAlreadyDelivered", [], null,
    );
    await expect(ports(revert, {}).settleVerdictDelivery({
      verdictRequestId: REQUEST, verdictDigest: DIGEST, verdictCode: VerdictCode.Pass,
    })).resolves.toEqual({ status: "already-settled" });
  });

  it("refuses to settle a verdict with the None code rather than defaulting to Pass", async () => {
    await expect(ports(TX, {}).settleVerdictDelivery({
      verdictRequestId: REQUEST, verdictDigest: DIGEST, verdictCode: VerdictCode.None,
    })).rejects.toThrow(/decision-grade verdict code/);
  });

  it("reports releaseVerdict as unsupported in the today generation", async () => {
    await expect(ports(TX, {}).releaseVerdict({ taskId: 7n, attemptIndex: 2, verdictIndex: 1 }))
      .resolves.toEqual({ ok: false, kind: "unsupported" });
  });

  it("broadcasts releaseVerdict in the revised generation", async () => {
    const revised = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    await expect(ports(TX, {}, revised).releaseVerdict({ taskId: 7n, attemptIndex: 2, verdictIndex: 1 }))
      .resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/verdict.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the verdict leg**

`packages/marketplace/venue-base/src/verdict.ts`:

```ts
// SPDX-License-Identifier: MIT

// The evaluation leg's chain surface. Design §6.1's deliverable table enumerates the solution
// leg only; the verdict leg's writes appear in no port anywhere (finding D9). This module is
// that additive surface: claim the verdict attempt, preflight it, read verdict facts, settle
// the verdict delivery, and release an unfulfilled verdict claim. It is a SEPARATE group rather
// than an extension of `SettlementPorts` because that binding type's attempt, facts, and gate
// shapes are all solution-scoped.
import {
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
  SafeInnerRevertError,
  TASK_COORDINATOR_ABI,
  VerdictCode,
  formatKnownRevertDetail,
  type MarketplaceChainConfig,
} from "@jinn-network/marketplace-binding";
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import {
  JINN_ROUTER_V3_EVALUATION_ABI,
  JINN_ROUTER_V4_RELEASE_ABI,
  TASK_COORDINATOR_REF_ABI,
} from "./abi/venue-extras.js";
import type { VenueSafeBroadcast } from "./broadcast/safe.js";
import { flattenErrorMessage } from "./broadcast/classify.js";

export class VerdictReceiptError extends Error {
  constructor(readonly txHash: Hex, detail: string) {
    super(`verdict claim transaction ${txHash}: ${detail}`);
    this.name = "VerdictReceiptError";
  }
}

export interface VerdictFacts {
  readonly requestId: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly evaluator: Address;
  readonly verdictCidDigest: Hex;
  readonly verdictCode: VerdictCode;
  readonly status: number;
}

export type VerdictSettleStatus =
  | "settled" | "already-settled" | "rejected" | "delivered-unsettled";

export interface VerdictPorts {
  claimVerdictAttempt(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly evaluatorMech: Address;
    readonly evaluationTaskCidDigest: Hex;
  }): Promise<{ readonly verdictIndex: number; readonly requestId?: Hex; readonly txHash: Hex }>;
  canClaimVerdictAttempt(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly evaluatorMech: Address;
    readonly evaluationTaskCidDigest: Hex;
    readonly from: Address;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly revertName: string | null }>;
  readVerdictFacts(input: { readonly requestId: Hex }): Promise<VerdictFacts>;
  settleVerdictDelivery(input: {
    readonly verdictRequestId: Hex;
    readonly verdictDigest: Hex;
    readonly verdictCode: VerdictCode;
  }): Promise<{ readonly status: VerdictSettleStatus }>;
  releaseVerdict(input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly verdictIndex: number;
  }): Promise<void | { readonly ok: false; readonly kind: "unsupported" }>;
}

const VERDICT_OUTCOME_BY_REVERT: Readonly<Record<string, VerdictSettleStatus>> = {
  TCVerdictAlreadyDelivered: "already-settled",
  RouterAlreadyClaimed: "already-settled",
  AlreadyClaimed: "already-settled",
  TCNotVerdictEvaluator: "rejected",
  RouterWrongDeliveryOperator: "rejected",
  RouterWrongRequestKind: "rejected",
  RouterNotDelivered: "delivered-unsettled",
};

export interface VerdictPortsInput {
  readonly publicClient: PublicClient;
  readonly safe: VenueSafeBroadcast;
  readonly chain: MarketplaceChainConfig;
}

export function createVerdictPorts(input: VerdictPortsInput): VerdictPorts {
  const { publicClient, safe, chain } = input;
  const today = chain.generation === "today";
  const claimAbi = today ? JINN_ROUTER_V3_EVALUATION_ABI : JINN_ROUTER_V4_ABI;
  const eventAbi = today ? JINN_ROUTER_V3_ABI : JINN_ROUTER_V4_ABI;

  function claimArgs(taskId: bigint, attemptIndex: number, evaluatorMech: Address, spec: Hex) {
    return today
      ? ([taskId, attemptIndex, evaluatorMech, spec] as const)
      : ([taskId, attemptIndex, evaluatorMech] as const);
  }

  return {
    async claimVerdictAttempt({ taskId, attemptIndex, evaluatorMech, evaluationTaskCidDigest }) {
      const data = encodeFunctionData({
        abi: claimAbi, functionName: "claimEvaluation",
        args: claimArgs(taskId, attemptIndex, evaluatorMech, evaluationTaskCidDigest) as never,
      });
      const txHash = await safe.broadcastSafeTransaction({
        to: chain.jinnRouter, value: 0n, data, logicalTx: "claim.verdict",
      });
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      const matches: { verdictIndex: number; requestId?: Hex }[] = [];
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: eventAbi, data: log.data, topics: log.topics, strict: true,
          });
          if (decoded.eventName !== "EvaluationAttemptCreated") continue;
          const args = decoded.args as {
            taskId: bigint; attemptIndex: number; verdictIndex: number; requestId?: Hex;
          };
          if (args.taskId !== taskId || Number(args.attemptIndex) !== attemptIndex) continue;
          matches.push(
            args.requestId === undefined
              ? { verdictIndex: Number(args.verdictIndex) }
              : { verdictIndex: Number(args.verdictIndex), requestId: args.requestId },
          );
        } catch {
          // Not a router event.
        }
      }
      if (matches.length !== 1) {
        throw new VerdictReceiptError(
          txHash,
          `carries ${matches.length} EvaluationAttemptCreated events; exactly one is required`,
        );
      }
      return { ...matches[0]!, txHash };
    },

    async canClaimVerdictAttempt({ taskId, attemptIndex, evaluatorMech, evaluationTaskCidDigest, from }) {
      try {
        await publicClient.simulateContract({
          address: chain.jinnRouter, abi: claimAbi, functionName: "claimEvaluation",
          args: claimArgs(taskId, attemptIndex, evaluatorMech, evaluationTaskCidDigest) as never,
          account: from,
        });
        return { ok: true };
      } catch (error) {
        const revertName = error instanceof SafeInnerRevertError
          ? error.decodedName
          : formatKnownRevertDetail(error)?.name ?? null;
        return {
          ok: false,
          reason: revertName === null ? flattenErrorMessage(error) : `${revertName}: ${flattenErrorMessage(error)}`,
          revertName,
        };
      }
    },

    async readVerdictFacts({ requestId }) {
      const ref = await publicClient.readContract({
        address: chain.taskCoordinator, abi: TASK_COORDINATOR_REF_ABI,
        functionName: "getVerdictRequestRef", args: [requestId],
      }) as readonly [bigint, number, number, boolean];
      const [taskId, attemptIndex, verdictIndex, exists] = ref;
      if (!exists) {
        throw new Error(`request ${requestId} resolves to no verdict engagement on ${chain.taskCoordinator}`);
      }
      const record = await publicClient.readContract({
        address: chain.taskCoordinator, abi: TASK_COORDINATOR_REF_ABI,
        functionName: "getVerdict", args: [taskId, attemptIndex, verdictIndex],
      }) as {
        evaluator: Address; verdictCidDigest: Hex; verdictCode: number; status: number;
      };
      return {
        requestId,
        taskId,
        attemptIndex: Number(attemptIndex),
        verdictIndex: Number(verdictIndex),
        evaluator: record.evaluator,
        verdictCidDigest: record.verdictCidDigest,
        verdictCode: record.verdictCode as VerdictCode,
        status: record.status,
      };
    },

    async settleVerdictDelivery({ verdictRequestId, verdictDigest, verdictCode }) {
      if (verdictCode === VerdictCode.None) {
        throw new Error(
          "settleVerdictDelivery requires a decision-grade verdict code -- refusing to default "
            + "an unset code to Pass",
        );
      }
      const data = encodeFunctionData({
        abi: JINN_ROUTER_V3_ABI, functionName: "claimVerdictDelivery",
        args: [verdictRequestId, verdictDigest, verdictCode],
      });
      try {
        await safe.broadcastSafeTransaction({
          to: chain.jinnRouter, value: 0n, data, logicalTx: "settle.verdict",
        });
        return { status: "settled" };
      } catch (error) {
        if (error instanceof SafeInnerRevertError && error.decodedName !== null) {
          const mapped = VERDICT_OUTCOME_BY_REVERT[error.decodedName];
          if (mapped !== undefined) return { status: mapped };
        }
        throw error;
      }
    },

    async releaseVerdict({ taskId, attemptIndex, verdictIndex }) {
      if (today) return { ok: false, kind: "unsupported" };
      const data = encodeFunctionData({
        abi: JINN_ROUTER_V4_RELEASE_ABI, functionName: "releaseVerdict",
        args: [taskId, attemptIndex, verdictIndex],
      });
      await safe.broadcastSafeTransaction({ to: chain.jinnRouter, value: 0n, data, logicalTx: "release.verdict" });
    },
  };
}

export type { TASK_COORDINATOR_ABI };
```

- [ ] **Step 4: Run, export, verify, commit**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/verdict.test.ts`
Expected: PASS (10 tests).

Append to `src/index.ts`:

```ts
export { VerdictReceiptError, createVerdictPorts } from "./verdict.js";
export type { VerdictFacts, VerdictPorts, VerdictPortsInput, VerdictSettleStatus } from "./verdict.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test`
Expected: PASS.

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): the evaluation leg's chain surface (finding D9)

Design §6.1 enumerates the solution leg only; the verdict leg's writes lived in
no port anywhere. Adds claimVerdictAttempt, its named-revert preflight, verdict
facts readers, verdict settlement with outcome mapping, and releaseVerdict --
as a separate group, since SettlementPorts is solution-scoped by construction.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Lifecycle writes and the release port

**Files:**
- Create: `packages/marketplace/venue-base/src/lifecycle.ts`, `src/lifecycle.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `VenueSafeBroadcast`, `VenueStateDb`, `deriveMarketplaceAttemptUri` from binding; `MarketplaceLifecyclePorts`, `ReleaseAttemptPort` from binding.
- Produces:
  - `createLifecyclePorts(input: { db: VenueStateDb; safe: VenueSafeBroadcast; chain: MarketplaceChainConfig; attemptIndexBound?: number }): MarketplaceLifecyclePorts`
  - `createReleasePort(input: { safe: VenueSafeBroadcast; chain: MarketplaceChainConfig }): ReleaseAttemptPort`
  - `readWithdrawnAnnouncements(db: VenueStateDb): readonly bigint[]` — the projector loop's read of decision D6's local markers
  - `class AttemptUriUnknownError extends Error`

`resolveAttempt` inverts the deterministic Attempt URI by scanning the venue state database's engagement rows, which the observe port (Task 20) writes — a URI the operator never engaged with is an error, never a guess.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/lifecycle.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_SEPOLIA_TODAY, deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "./state/db.js";
import type { VenueSafeBroadcast } from "./broadcast/safe.js";
import {
  AttemptUriUnknownError,
  createLifecyclePorts,
  createReleasePort,
  readWithdrawnAnnouncements,
} from "./lifecycle.js";

const TX = `0x${"f".repeat(64)}` as Hex;
const ATTEMPT = deriveMarketplaceAttemptUri({
  chainId: 84532, coordinator: BASE_SEPOLIA_TODAY.taskCoordinator, taskId: 7n, attemptIndex: 2,
});

let dir: string;
let db: VenueStateDb;
let calls: string[];
const safe: VenueSafeBroadcast = {
  async broadcastSafeTransaction(input) { calls.push(input.logicalTx); return TX; },
  async sendEoaTransaction() { throw new Error("unused"); },
  async broadcastCreateTask() { throw new Error("unused"); },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-lifecycle-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
  calls = [];
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("lifecycle ports", () => {
  it("inverts a marketplace Attempt URI by deterministic search over the bounded index space", async () => {
    const ports = createLifecyclePorts({ db, safe, chain: BASE_SEPOLIA_TODAY });
    await expect(ports.resolveAttempt(ATTEMPT)).resolves.toEqual({ taskId: 7n, attemptIndex: 2 });
  });

  it("errors on an Attempt URI outside the venue rather than guessing", async () => {
    const ports = createLifecyclePorts({ db, safe, chain: BASE_SEPOLIA_TODAY });
    await expect(ports.resolveAttempt("urn:uuid:00000000-0000-5000-8000-000000000000"))
      .rejects.toBeInstanceOf(AttemptUriUnknownError);
  });

  it("records a cancel signal durably and reports already-requested on replay", async () => {
    const ports = createLifecyclePorts({ db, safe, chain: BASE_SEPOLIA_TODAY });
    const args = { attempt: ATTEMPT, taskId: 7n, attemptIndex: 2, reason: "operator withdrew" } as const;
    await expect(ports.requestCancel(args)).resolves.toBe("requested");
    await expect(ports.requestCancel(args)).resolves.toBe("already-requested");
    expect(calls).toEqual([]); // cancellation is a local signal, never a chain write
  });

  it("records an announcement withdrawal locally and exposes it to the projector loop", async () => {
    const ports = createLifecyclePorts({ db, safe, chain: BASE_SEPOLIA_TODAY });
    await ports.withdrawAnnouncement({ taskId: 7n });
    await ports.withdrawAnnouncement({ taskId: 7n });
    await ports.withdrawAnnouncement({ taskId: 9n });
    expect(readWithdrawnAnnouncements(db)).toEqual([7n, 9n]);
    expect(calls).toEqual([]);
  });

  it("refunds the unused task budget on chain in the today generation", async () => {
    const ports = createLifecyclePorts({ db, safe, chain: BASE_SEPOLIA_TODAY });
    await ports.refundUnusedTaskBudget!({ taskId: 7n });
    expect(calls).toEqual(["lifecycle.refundUnusedTaskBudget"]);
  });

  it("omits closeTask in the today generation and supplies it in the revised one", async () => {
    expect(createLifecyclePorts({ db, safe, chain: BASE_SEPOLIA_TODAY }).closeTask).toBeUndefined();
    const revised = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    await createLifecyclePorts({ db, safe, chain: revised }).closeTask!({ taskId: 7n });
    expect(calls).toEqual(["lifecycle.closeTask"]);
  });

  it("reports release as unsupported in today mode and broadcasts it in revised mode", async () => {
    await expect(createReleasePort({ safe, chain: BASE_SEPOLIA_TODAY })
      .releaseAttempt({ taskId: 7n, attemptIndex: 2 }))
      .resolves.toEqual({ ok: false, kind: "unsupported" });
    const revised = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    await expect(createReleasePort({ safe, chain: revised })
      .releaseAttempt({ taskId: 7n, attemptIndex: 2 })).resolves.toBeUndefined();
    expect(calls).toEqual(["lifecycle.releaseAttempt"]);
  });

  it("forfeits a delivered reservation only in the revised generation", async () => {
    expect(createReleasePort({ safe, chain: BASE_SEPOLIA_TODAY }).forfeitDeliveredReservation)
      .toBeUndefined();
    const revised = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
    await createReleasePort({ safe, chain: revised })
      .forfeitDeliveredReservation!({ taskId: 7n, attemptIndex: 2, verdictIndex: 1, legKind: 1 });
    expect(calls).toEqual(["lifecycle.forfeitDeliveredReservation"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the lifecycle module**

`packages/marketplace/venue-base/src/lifecycle.ts`:

```ts
// SPDX-License-Identifier: MIT

// Lifecycle writes: resolve / cancel / withdraw / refund / close / release (composition design
// §6.1). Two of the six are deliberately NOT chain writes. Cancellation is a durable, idempotent
// requester signal that never revokes a live attempt (binding lifecycle.ts). Announcement
// withdrawal has no today-generation chain verb at all, so it is recorded locally and read by
// the host's projector loop, which emits the signed discovery retraction (decision D6).
import {
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
  deriveMarketplaceAttemptUri,
  type MarketplaceChainConfig,
  type MarketplaceLifecyclePorts,
  type ReleaseAttemptPort,
} from "@jinn-network/marketplace-binding";
import { encodeFunctionData } from "viem";
import type { VenueSafeBroadcast } from "./broadcast/safe.js";
import type { VenueStateDb } from "./state/db.js";

/** Attempt indices are `uint32` but bounded in practice by a Task's `maxClaims`. */
export const DEFAULT_ATTEMPT_INDEX_BOUND = 256;

export class AttemptUriUnknownError extends Error {
  constructor(readonly attempt: string) {
    super(
      `Attempt URI ${attempt} does not resolve to an engagement on this venue -- refusing to `
        + "guess a (taskId, attemptIndex) pair",
    );
    this.name = "AttemptUriUnknownError";
  }
}

export interface LifecyclePortsInput {
  readonly db: VenueStateDb;
  readonly safe: VenueSafeBroadcast;
  readonly chain: MarketplaceChainConfig;
  readonly attemptIndexBound?: number;
}

interface EngagementRow { readonly payload_json: string }

/** Task ids whose announcement the operator has withdrawn, ascending (decision D6). */
export function readWithdrawnAnnouncements(db: VenueStateDb): readonly bigint[] {
  return db.all<{ subject: string }>(
    "SELECT subject FROM venue_lifecycle_signals WHERE kind = 'announcement-withdrawn' "
      + "ORDER BY CAST(subject AS INTEGER) ASC",
  ).map((row) => BigInt(row.subject));
}

export function createLifecyclePorts(input: LifecyclePortsInput): MarketplaceLifecyclePorts {
  const { db, safe, chain } = input;
  const bound = input.attemptIndexBound ?? DEFAULT_ATTEMPT_INDEX_BOUND;
  const today = chain.generation === "today";

  const base: MarketplaceLifecyclePorts = {
    async resolveAttempt(attempt) {
      // The Attempt URI is a UUIDv5 over (chainId, coordinator, taskId, attemptIndex) -- one-way
      // by construction. Known engagements are indexed first; otherwise re-derive over the
      // bounded index space for the task ids this venue has seen.
      const known = db.all<EngagementRow>(
        "SELECT payload_json FROM venue_lifecycle_signals WHERE kind = 'engagement' AND subject = ?",
        [attempt],
      );
      if (known.length === 1) {
        const parsed = JSON.parse(known[0]!.payload_json) as { taskId: string; attemptIndex: number };
        return { taskId: BigInt(parsed.taskId), attemptIndex: parsed.attemptIndex };
      }
      const seen = db.all<{ subject: string }>(
        "SELECT DISTINCT subject FROM venue_lifecycle_signals WHERE kind = 'task-seen'",
      );
      for (const { subject } of seen) {
        const taskId = BigInt(subject);
        for (let attemptIndex = 0; attemptIndex < bound; attemptIndex += 1) {
          const candidate = deriveMarketplaceAttemptUri({
            chainId: chain.chainId, coordinator: chain.taskCoordinator, taskId, attemptIndex,
          });
          if (candidate === attempt) return { taskId, attemptIndex };
        }
      }
      throw new AttemptUriUnknownError(attempt);
    },

    async requestCancel({ attempt, taskId, attemptIndex, reason }) {
      return db.transaction(() => {
        const existing = db.get<{ subject: string }>(
          "SELECT subject FROM venue_lifecycle_signals WHERE kind = 'cancel' AND subject = ?",
          [attempt],
        );
        if (existing !== undefined) return "already-requested" as const;
        db.run(
          "INSERT INTO venue_lifecycle_signals (kind, subject, payload_json, recorded_at_ms) "
            + "VALUES ('cancel', ?, ?, ?)",
          [attempt, JSON.stringify({ taskId: taskId.toString(), attemptIndex, reason }), Date.now()],
        );
        return "requested" as const;
      });
    },

    async withdrawAnnouncement({ taskId }) {
      db.run(
        "INSERT INTO venue_lifecycle_signals (kind, subject, payload_json, recorded_at_ms) "
          + "VALUES ('announcement-withdrawn', ?, '{}', ?) ON CONFLICT(kind, subject) DO NOTHING",
        [taskId.toString(), Date.now()],
      );
    },
  };

  if (today) {
    return {
      ...base,
      async refundUnusedTaskBudget({ taskId }) {
        await safe.broadcastSafeTransaction({
          to: chain.jinnRouter, value: 0n,
          data: encodeFunctionData({
            abi: JINN_ROUTER_V3_ABI, functionName: "refundUnusedTaskBudget", args: [taskId],
          }),
          logicalTx: "lifecycle.refundUnusedTaskBudget",
        });
      },
    };
  }

  return {
    ...base,
    async closeTask({ taskId }) {
      await safe.broadcastSafeTransaction({
        to: chain.jinnRouter, value: 0n,
        data: encodeFunctionData({ abi: JINN_ROUTER_V4_ABI, functionName: "closeTask", args: [taskId] }),
        logicalTx: "lifecycle.closeTask",
      });
    },
    async releaseAttempt({ taskId, attemptIndex }) {
      await safe.broadcastSafeTransaction({
        to: chain.jinnRouter, value: 0n,
        data: encodeFunctionData({
          abi: JINN_ROUTER_V4_ABI, functionName: "releaseAttempt", args: [taskId, attemptIndex],
        }),
        logicalTx: "lifecycle.releaseAttempt",
      });
    },
  };
}

export function createReleasePort(input: {
  readonly safe: VenueSafeBroadcast;
  readonly chain: MarketplaceChainConfig;
}): ReleaseAttemptPort {
  const { safe, chain } = input;
  if (chain.generation === "today") {
    // Today-mode has no on-chain release. The pipeline surfaces this as an unreleased attempt
    // occupying its maxClaims slot until the revised generation's deadline reap (design §4).
    return { async releaseAttempt() { return { ok: false, kind: "unsupported" }; } };
  }
  return {
    async releaseAttempt({ taskId, attemptIndex }) {
      await safe.broadcastSafeTransaction({
        to: chain.jinnRouter, value: 0n,
        data: encodeFunctionData({
          abi: JINN_ROUTER_V4_ABI, functionName: "releaseAttempt", args: [taskId, attemptIndex],
        }),
        logicalTx: "lifecycle.releaseAttempt",
      });
    },
    async forfeitDeliveredReservation({ taskId, attemptIndex, verdictIndex, legKind }) {
      await safe.broadcastSafeTransaction({
        to: chain.jinnRouter, value: 0n,
        data: encodeFunctionData({
          abi: JINN_ROUTER_V4_ABI, functionName: "forfeitDeliveredReservation",
          args: [taskId, attemptIndex, verdictIndex, legKind],
        }),
        logicalTx: "lifecycle.forfeitDeliveredReservation",
      });
    },
  };
}
```

- [ ] **Step 4: Run, export, verify, commit**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/lifecycle.test.ts`
Expected: PASS (8 tests).

Append to `src/index.ts`:

```ts
export {
  AttemptUriUnknownError,
  DEFAULT_ATTEMPT_INDEX_BOUND,
  createLifecyclePorts,
  createReleasePort,
  readWithdrawnAnnouncements,
} from "./lifecycle.js";
export type { LifecyclePortsInput } from "./lifecycle.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test`
Expected: PASS.

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): lifecycle writes and the generation-aware release port

Chain writes for refund/close/release/forfeit; cancellation and announcement
withdrawal stay durable local signals (the latter has no today-generation chain
verb, so the projector loop reads the marker and emits the retraction).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: The finality waiter

**Files:**
- Create: `packages/marketplace/venue-base/src/finality.ts`, `src/finality.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `FinalityPort`, `FinalityAwaitResult` from binding (Task 1).
- Produces:
  - `createFinalityWaiter(input: { publicClient: PublicClient; pollIntervalMs?: number; timeoutMs?: number; depthFallbackBlocks?: bigint }): FinalityPort`
  - `DEFAULT_FINALITY_POLL_MS = 4_000`, `DEFAULT_FINALITY_TIMEOUT_MS = 900_000`, `DEFAULT_FINALITY_DEPTH_BLOCKS = 64n`

Finality gates expensive execution (design §8, N2), so this waiter must be honest in three ways: a reverted claim receipt is `failed`; a claim whose block hash no longer matches at the same height is `reorged`; a provider that does not serve OP-stack finality tags falls back to a depth constant rather than reporting a claim finalized it cannot see.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/finality.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import type { Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { createFinalityWaiter } from "./finality.js";

const CLAIM = `0x${"a".repeat(64)}` as Hex;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function client(options: {
  receiptStatus?: "success" | "reverted";
  receiptBlock?: bigint;
  finalizedSeries?: bigint[];
  headSeries?: bigint[];
  reorged?: boolean;
  finalizedThrows?: boolean;
}): PublicClient {
  const finalized = [...(options.finalizedSeries ?? [200n])];
  const heads = [...(options.headSeries ?? [500n])];
  return {
    async getTransactionReceipt() {
      return {
        status: options.receiptStatus ?? "success",
        blockNumber: options.receiptBlock ?? 100n,
        blockHash: hashOf(options.receiptBlock ?? 100n),
      };
    },
    async getBlockNumber() { return heads.length > 1 ? heads.shift()! : heads[0]!; },
    async getBlock({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) {
      if (blockTag === "finalized") {
        if (options.finalizedThrows === true) throw new Error("unsupported block tag");
        const next = finalized.length > 1 ? finalized.shift()! : finalized[0]!;
        return { number: next, hash: hashOf(next) };
      }
      const n = blockNumber!;
      return { number: n, hash: options.reorged === true ? hashOf(n + 9_999n) : hashOf(n) };
    },
  } as unknown as PublicClient;
}

const waiter = (c: PublicClient) =>
  createFinalityWaiter({ publicClient: c, pollIntervalMs: 1, timeoutMs: 200 });

describe("finality waiter", () => {
  it("returns ok once the finalized tag passes the claim's block", async () => {
    await expect(waiter(client({ receiptBlock: 100n, finalizedSeries: [200n] }))
      .awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM }))
      .resolves.toEqual({ ok: true });
  });

  it("polls until the finalized tag catches up", async () => {
    await expect(waiter(client({ receiptBlock: 100n, finalizedSeries: [50n, 80n, 150n] }))
      .awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM }))
      .resolves.toEqual({ ok: true });
  });

  it("reports failed for a reverted claim receipt", async () => {
    await expect(waiter(client({ receiptStatus: "reverted" }))
      .awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM }))
      .resolves.toEqual({ ok: false, kind: "failed" });
  });

  it("reports reorged when the claim's block hash no longer matches at that height", async () => {
    await expect(waiter(client({ receiptBlock: 100n, finalizedSeries: [200n], reorged: true }))
      .awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM }))
      .resolves.toEqual({ ok: false, kind: "reorged" });
  });

  it("falls back to a depth constant when the provider serves no finalized tag", async () => {
    await expect(waiter(client({ receiptBlock: 100n, finalizedThrows: true, headSeries: [1_000n] }))
      .awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM }))
      .resolves.toEqual({ ok: true });
  });

  it("reports failed rather than ok when the wait times out", async () => {
    await expect(waiter(client({ receiptBlock: 100n, finalizedSeries: [1n] }))
      .awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM }))
      .resolves.toEqual({ ok: false, kind: "failed" });
  });

  it("reports failed when the claim transaction cannot be found at all", async () => {
    const missing = {
      async getTransactionReceipt() { throw new Error("not found"); },
    } as unknown as PublicClient;
    await expect(waiter(missing)
      .awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM }))
      .resolves.toEqual({ ok: false, kind: "failed" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/finality.test.ts` — Expected: FAIL, module not found.

`packages/marketplace/venue-base/src/finality.ts`:

```ts
// SPDX-License-Identifier: MIT

// `FinalityPort` (composition design §6.1): gate expensive execution on finalized claim facts.
// OP-stack finality tags over a hand-tuned depth constant (standards audit ruling 2); depth is
// the FALLBACK for providers serving stale or absent tags, never the primary rule.
import type { FinalityAwaitResult, FinalityPort } from "@jinn-network/marketplace-binding";
import type { PublicClient } from "viem";

export const DEFAULT_FINALITY_POLL_MS = 4_000;
export const DEFAULT_FINALITY_TIMEOUT_MS = 900_000;
export const DEFAULT_FINALITY_DEPTH_BLOCKS = 64n;

export interface FinalityWaiterInput {
  readonly publicClient: PublicClient;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly depthFallbackBlocks?: bigint;
}

export function createFinalityWaiter(input: FinalityWaiterInput): FinalityPort {
  const { publicClient } = input;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_FINALITY_POLL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS;
  const depth = input.depthFallbackBlocks ?? DEFAULT_FINALITY_DEPTH_BLOCKS;

  return {
    async awaitFinalized({ claimTxHash }): Promise<FinalityAwaitResult> {
      let receipt: { status: string; blockNumber: bigint; blockHash: string };
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: claimTxHash }) as never;
      } catch {
        return { ok: false, kind: "failed" };
      }
      if (receipt.status !== "success") return { ok: false, kind: "failed" };

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let finalizedNumber: bigint | undefined;
        try {
          const block = await publicClient.getBlock({ blockTag: "finalized" });
          finalizedNumber = block.number ?? undefined;
        } catch {
          finalizedNumber = undefined;
        }
        if (finalizedNumber === undefined) {
          const head = await publicClient.getBlockNumber();
          finalizedNumber = head > depth ? head - depth : 0n;
        }

        if (finalizedNumber >= receipt.blockNumber) {
          const current = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
          return (current.hash as string) === receipt.blockHash
            ? { ok: true }
            : { ok: false, kind: "reorged" };
        }
        if (Date.now() >= deadline) return { ok: false, kind: "failed" };
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
  };
}
```

- [ ] **Step 3: Run, export, verify, commit**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/finality.test.ts` — Expected: PASS (7 tests).

Append to `src/index.ts`:

```ts
export {
  DEFAULT_FINALITY_DEPTH_BLOCKS,
  DEFAULT_FINALITY_POLL_MS,
  DEFAULT_FINALITY_TIMEOUT_MS,
  createFinalityWaiter,
} from "./finality.js";
export type { FinalityWaiterInput } from "./finality.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test` — Expected: PASS.

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): the finality waiter over OP-stack tags

Finalized-tag primary with a depth fallback for providers serving no tag; a
reverted claim is failed, a changed block hash at the same height is reorged,
and a timeout is failed -- never an optimistic ok.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 18: The delivery waiter

**Files:**
- Create: `packages/marketplace/venue-base/src/delivery-wait.ts`, `src/delivery-wait.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `DeliveryWaitPort`, `DeliveryWaitResult` from binding (Task 1); `TaskExecutionBackend`, `AttemptUri` from `@jinn-network/task-execution-backend`.
- Produces:
  - `createDeliveryWaiter(input: { pollIntervalMs?: number; timeoutMs?: number }): DeliveryWaitPort`
  - `DEFAULT_DELIVERY_POLL_MS = 2_000`, `DEFAULT_DELIVERY_TIMEOUT_MS = 3_600_000`

This is the **solver-side** wait: it observes the operator's own embedded backend, not the chain. The requester's await is a different surface — decision D10 routes it through `VenueObservePort.deliveries` / `fetchDelivery` in Task 20.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/delivery-wait.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import { describe, expect, it } from "vitest";
import { createDeliveryWaiter } from "./delivery-wait.js";

const ATTEMPT = "urn:uuid:00000000-0000-5000-8000-000000000001" as const;
const BYTES = new Uint8Array([1, 2, 3]);

function backend(script: {
  states?: string[];
  deliveries?: { ref: string }[][];
  fetch?: Uint8Array;
  observeThrows?: boolean;
}): TaskExecutionBackend {
  const states = [...(script.states ?? ["running", "delivered"])];
  const deliveries = [...(script.deliveries ?? [[], [{ ref: "d1" }]])];
  return {
    async observe() {
      if (script.observeThrows === true) throw new Error("backend gone");
      return { state: states.length > 1 ? states.shift()! : states[0]! };
    },
    async deliveries() { return deliveries.length > 1 ? deliveries.shift()! : deliveries[0]!; },
    async fetchDelivery() { return script.fetch ?? BYTES; },
  } as unknown as TaskExecutionBackend;
}

const waiter = createDeliveryWaiter({ pollIntervalMs: 1, timeoutMs: 200 });

describe("delivery waiter", () => {
  it("returns the sealed Delivery bytes once the backend records one", async () => {
    await expect(waiter.waitForDelivery({ attemptUri: ATTEMPT, backend: backend({}) }))
      .resolves.toEqual({ ok: true, deliveryBytes: BYTES });
  });

  it("reports the backend's terminal state instead of waiting out the timeout", async () => {
    await expect(waiter.waitForDelivery({
      attemptUri: ATTEMPT, backend: backend({ states: ["failed"], deliveries: [[]] }),
    })).resolves.toEqual({ ok: false, kind: "backend-terminal", state: "failed" });
  });

  it("times out rather than blocking a work loop forever", async () => {
    await expect(waiter.waitForDelivery({
      attemptUri: ATTEMPT, backend: backend({ states: ["running"], deliveries: [[]] }),
    })).resolves.toEqual({ ok: false, kind: "timeout" });
  });

  it("honors an abort signal as cancellation, not as failure", async () => {
    const controller = new AbortController();
    const pending = waiter.waitForDelivery({
      attemptUri: ATTEMPT, backend: backend({ states: ["running"], deliveries: [[]] }),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, kind: "cancelled" });
  });

  it("reports an already-aborted signal immediately without polling", async () => {
    await expect(waiter.waitForDelivery({
      attemptUri: ATTEMPT, backend: backend({}), signal: AbortSignal.abort(),
    })).resolves.toEqual({ ok: false, kind: "cancelled" });
  });

  it("surfaces a backend read failure as a terminal wait rather than a silent retry loop", async () => {
    await expect(waiter.waitForDelivery({
      attemptUri: ATTEMPT, backend: backend({ observeThrows: true }),
    })).resolves.toEqual({ ok: false, kind: "backend-terminal" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/delivery-wait.test.ts` — Expected: FAIL, module not found.

`packages/marketplace/venue-base/src/delivery-wait.ts`:

```ts
// SPDX-License-Identifier: MIT

// `DeliveryWaitPort` (composition design §6.1): the SOLVER-side wait. The pipeline hands the
// embedded backend in, and this port owns the poll-timer policy the library deliberately does
// not. It never reads the chain -- the operator's own backend is the authority on its own
// Attempt. (The REQUESTER's await is a different surface: VenueObservePort.deliveries /
// fetchDelivery, decision D10.)
import type {
  AttemptState,
  DeliveryWaitPort,
  DeliveryWaitResult,
} from "@jinn-network/marketplace-binding";

export const DEFAULT_DELIVERY_POLL_MS = 2_000;
export const DEFAULT_DELIVERY_TIMEOUT_MS = 3_600_000;

const TERMINAL_STATES = new Set(["failed", "rejected", "lost", "cancelled", "expired"]);

export interface DeliveryWaiterInput {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export function createDeliveryWaiter(input: DeliveryWaiterInput = {}): DeliveryWaitPort {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_DELIVERY_POLL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;

  return {
    async waitForDelivery({ attemptUri, backend, signal }): Promise<DeliveryWaitResult> {
      if (signal?.aborted === true) return { ok: false, kind: "cancelled" };
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        let snapshot: { state?: string };
        let refs: readonly { ref?: string }[];
        try {
          snapshot = await backend.observe(attemptUri) as never;
          refs = await backend.deliveries(attemptUri) as never;
        } catch {
          return { ok: false, kind: "backend-terminal" };
        }

        if (refs.length > 0) {
          try {
            const deliveryBytes = await backend.fetchDelivery(refs[refs.length - 1]! as never);
            return { ok: true, deliveryBytes };
          } catch {
            return { ok: false, kind: "backend-terminal" };
          }
        }
        if (snapshot.state !== undefined && TERMINAL_STATES.has(snapshot.state)) {
          return { ok: false, kind: "backend-terminal", state: snapshot.state as AttemptState };
        }
        if (signal?.aborted === true) return { ok: false, kind: "cancelled" };
        if (Date.now() >= deadline) return { ok: false, kind: "timeout" };
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        if (signal?.aborted === true) return { ok: false, kind: "cancelled" };
      }
    },
  };
}
```

- [ ] **Step 3: Run, export, verify, commit**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/delivery-wait.test.ts` — Expected: PASS (6 tests).

Append to `src/index.ts`:

```ts
export {
  DEFAULT_DELIVERY_POLL_MS,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  createDeliveryWaiter,
} from "./delivery-wait.js";
export type { DeliveryWaiterInput } from "./delivery-wait.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test` — Expected: PASS.

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): the cancel- and timeout-aware delivery waiter

Solver-side wait over the embedded backend with an explicit poll policy, a
terminal-state short circuit, and cancellation reported as cancelled rather
than as failure.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 19: The durable posting-intent store

**Files:**
- Create: `packages/marketplace/venue-base/src/intents.ts`, `src/intents.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`, `packages/marketplace/testing/src/venue-conformance.ts`, `venue-conformance.test.ts`

**Interfaces:**
- Consumes: `VenueStateDb`; `PostingIntentStore`, `PostingIntent`, `PostingIntentKey`, `PostingOwnerToken`, `PostingOutcome` from binding.
- Produces:
  - `createSqlitePostingIntentStore(db: VenueStateDb): PostingIntentStore` — the transactional-outbox replacement for the binding's in-memory reference store (standards audit ruling 4)
  - `describeVenuePostingIntentStore(makeStore: () => Promise<PostingIntentStore>): void` in the kit

The whole point is that `claim` is **linearizable**: a racy lookup-then-write would let two loops both believe they own the same intent and double-post a funded task.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/intents.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverPostingIntents, type PostingIntent } from "@jinn-network/marketplace-binding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "./state/db.js";
import { createSqlitePostingIntentStore } from "./intents.js";

const intent: PostingIntent = {
  creatorSafe: "0x00000000000000000000000000000000000000a1",
  taskCidDigest: `sha256:${"1".repeat(64)}`,
  submissionDigest: `sha256:${"2".repeat(64)}`,
  idempotencyKey: "idem-1",
  createdAt: "2026-07-30T00:00:00.000Z",
};
const outcome = { taskId: 42n, txHash: `0x${"3".repeat(64)}` } as const;
const key = {
  creatorSafe: intent.creatorSafe,
  taskCidDigest: intent.taskCidDigest,
  submissionDigest: intent.submissionDigest,
};

let dir: string;
let db: VenueStateDb;
let other: VenueStateDb;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-intents-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
  other = await openVenueStateDb(join(dir, "venue.db"));
});
afterEach(() => { db.close(); other.close(); rmSync(dir, { recursive: true, force: true }); });

describe("durable posting-intent store", () => {
  it("grants ownership once and reports pending-other to every later claimant", async () => {
    const mine = createSqlitePostingIntentStore(db);
    const theirs = createSqlitePostingIntentStore(other);
    const first = await mine.claim(intent);
    expect(first.kind).toBe("owner");
    expect((await theirs.claim(intent)).kind).toBe("pending-other");
  });

  it("survives a restart with the same owner token so recovery resumes ownership", async () => {
    const claim = await createSqlitePostingIntentStore(db).claim(intent);
    if (claim.kind !== "owner") throw new Error("unreachable");
    db.close();
    db = await openVenueStateDb(join(dir, "venue.db"));
    const reopened = createSqlitePostingIntentStore(db);
    expect(await reopened.fence(key, claim.ownerToken)).toBe(true);
  });

  it("fences only the current owner and only while unresolved", async () => {
    const store = createSqlitePostingIntentStore(db);
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("unreachable");
    expect(await store.fence(key, claim.ownerToken)).toBe(true);
    expect(await store.fence(key, "posting-owner:someone-else" as typeof claim.ownerToken)).toBe(false);
    await store.resolve(key, claim.ownerToken, outcome);
    expect(await store.fence(key, claim.ownerToken)).toBe(false);
  });

  it("returns the prior outcome on replay instead of re-broadcasting", async () => {
    const store = createSqlitePostingIntentStore(db);
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("unreachable");
    await store.resolve(key, claim.ownerToken, outcome);
    expect(await store.claim(intent)).toEqual({ kind: "resolved", outcome });
  });

  it("refuses a second, different outcome for the same intent", async () => {
    const store = createSqlitePostingIntentStore(db);
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("unreachable");
    await store.resolve(key, claim.ownerToken, outcome);
    await expect(store.resolve(key, claim.ownerToken, { taskId: 43n, txHash: outcome.txHash }))
      .rejects.toThrow(/already resolved to a different outcome/);
  });

  it("refuses a non-owner resolve", async () => {
    const store = createSqlitePostingIntentStore(db);
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("unreachable");
    await expect(store.resolve(key, "posting-owner:impostor" as typeof claim.ownerToken, outcome))
      .rejects.toThrow(/only the posting intent owner token may resolve/);
  });

  it("drives the binding's recovery scan: a matched intent resolves, an unmatched one stays uncertain", async () => {
    const store = createSqlitePostingIntentStore(db);
    await store.claim(intent);
    expect(await recoverPostingIntents(store, async () => outcome)).toEqual([]);
    expect((await store.lookup(key))?.resolved).toEqual(outcome);

    const second = { ...intent, submissionDigest: `sha256:${"9".repeat(64)}` as const, idempotencyKey: "idem-2" };
    await store.claim(second);
    const uncertain = await recoverPostingIntents(store, async () => null);
    expect(uncertain.map((i) => i.idempotencyKey)).toEqual(["idem-2"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/intents.test.ts` — Expected: FAIL, module not found.

`packages/marketplace/venue-base/src/intents.ts`:

```ts
// SPDX-License-Identifier: MIT

// The transactional-outbox posting-intent store (standards audit ruling 4), replacing the
// binding's in-memory reference implementation. The intent row is written in the same
// transaction as the motivating state change and BEFORE the broadcast, so a crash between the
// two leaves a recoverable at-most-once trace. `claim` is LINEARIZABLE by construction -- one
// INSERT under a transaction, never a lookup followed by an unconditional write -- because a
// racy claim lets two loops each believe they own the same intent and double-post a funded task.
import type {
  PostingIntent,
  PostingIntentClaim,
  PostingIntentKey,
  PostingIntentRecord,
  PostingIntentStore,
  PostingOutcome,
  PostingOwnerToken,
} from "@jinn-network/marketplace-binding";
import type { VenueStateDb } from "./state/db.js";

interface Row {
  readonly creator_safe: string; readonly task_cid_digest: string;
  readonly submission_digest: string; readonly idempotency_key: string;
  readonly created_at: string; readonly owner_token: string;
  readonly resolved_task_id: string | null; readonly resolved_tx_hash: string | null;
}

function toIntent(row: Row): PostingIntent {
  return {
    creatorSafe: row.creator_safe as `0x${string}`,
    taskCidDigest: row.task_cid_digest as `sha256:${string}`,
    submissionDigest: row.submission_digest as `sha256:${string}`,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function toOutcome(row: Row): PostingOutcome | undefined {
  if (row.resolved_task_id === null || row.resolved_tx_hash === null) return undefined;
  return { taskId: BigInt(row.resolved_task_id), txHash: row.resolved_tx_hash as `0x${string}` };
}

export function createSqlitePostingIntentStore(db: VenueStateDb): PostingIntentStore {
  const read = (key: PostingIntentKey): Row | undefined => db.get<Row>(
    "SELECT * FROM venue_posting_intents WHERE creator_safe = ? AND task_cid_digest = ? "
      + "AND submission_digest = ?",
    [key.creatorSafe.toLowerCase(), key.taskCidDigest, key.submissionDigest],
  );

  return {
    async claim(intent): Promise<PostingIntentClaim> {
      return db.transaction(() => {
        const existing = read(intent);
        if (existing !== undefined) {
          const outcome = toOutcome(existing);
          return outcome === undefined
            ? { kind: "pending-other" as const, intent: toIntent(existing) }
            : { kind: "resolved" as const, outcome };
        }
        const ownerToken = `posting-owner:${crypto.randomUUID()}` as PostingOwnerToken;
        db.run(
          "INSERT INTO venue_posting_intents (creator_safe, task_cid_digest, submission_digest, "
            + "idempotency_key, created_at, owner_token) VALUES (?, ?, ?, ?, ?, ?)",
          [
            intent.creatorSafe.toLowerCase(), intent.taskCidDigest, intent.submissionDigest,
            intent.idempotencyKey, intent.createdAt, ownerToken,
          ],
        );
        return { kind: "owner" as const, intent, ownerToken };
      });
    },

    async fence(key, ownerToken) {
      const row = read(key);
      return row !== undefined && row.owner_token === ownerToken && toOutcome(row) === undefined;
    },

    async resolve(key, ownerToken, outcome) {
      db.transaction(() => {
        const row = read(key);
        if (row === undefined) throw new Error("cannot resolve an intent that was never claimed");
        if (row.owner_token !== ownerToken) {
          throw new Error("only the posting intent owner token may resolve");
        }
        const existing = toOutcome(row);
        if (existing !== undefined) {
          if (existing.taskId !== outcome.taskId || existing.txHash !== outcome.txHash) {
            throw new Error("posting intent is already resolved to a different outcome");
          }
          return;
        }
        db.run(
          "UPDATE venue_posting_intents SET resolved_task_id = ?, resolved_tx_hash = ? "
            + "WHERE creator_safe = ? AND task_cid_digest = ? AND submission_digest = ?",
          [
            outcome.taskId.toString(), outcome.txHash, key.creatorSafe.toLowerCase(),
            key.taskCidDigest, key.submissionDigest,
          ],
        );
      });
    },

    async lookup(key): Promise<PostingIntentRecord | undefined> {
      const row = read(key);
      if (row === undefined) return undefined;
      const outcome = toOutcome(row);
      return outcome === undefined ? toIntent(row) : { ...toIntent(row), resolved: outcome };
    },

    async scanPending() {
      return db.all<Row>(
        "SELECT * FROM venue_posting_intents WHERE resolved_task_id IS NULL ORDER BY created_at ASC",
      ).map((row) => ({ ...toIntent(row), ownerToken: row.owner_token as PostingOwnerToken }));
    },
  };
}
```

- [ ] **Step 3: Add the kit suite**

Append to `packages/marketplace/testing/src/venue-conformance.ts`:

```ts
import type { PostingIntentStore } from "@jinn-network/marketplace-binding";

/** The crash-safety contract every durable posting-intent store must satisfy. */
export function describeVenuePostingIntentStore(makeStore: () => Promise<PostingIntentStore>): void {
  describe("venue conformance: durable posting-intent outbox", () => {
    const intent = {
      creatorSafe: "0x00000000000000000000000000000000000000a1" as const,
      taskCidDigest: `sha256:${"1".repeat(64)}` as const,
      submissionDigest: `sha256:${"2".repeat(64)}` as const,
      idempotencyKey: "conformance-1",
      createdAt: "2026-07-30T00:00:00.000Z",
    };

    it("grants ownership exactly once", async () => {
      const store = await makeStore();
      expect((await store.claim(intent)).kind).toBe("owner");
      expect((await store.claim(intent)).kind).toBe("pending-other");
    });

    it("lists an unresolved intent as pending and drops it once resolved", async () => {
      const store = await makeStore();
      const claim = await store.claim(intent);
      if (claim.kind !== "owner") throw new Error("unreachable");
      expect((await store.scanPending()).length).toBe(1);
      await store.resolve(intent, claim.ownerToken, {
        taskId: 1n, txHash: `0x${"3".repeat(64)}`,
      });
      expect(await store.scanPending()).toEqual([]);
    });
  });
}
```

Append to `packages/marketplace/testing/src/venue-conformance.test.ts`:

```ts
import { createSqlitePostingIntentStore } from "@jinn-network/marketplace-venue-base";
import { describeVenuePostingIntentStore } from "./venue-conformance.js";

describeVenuePostingIntentStore(async () =>
  createSqlitePostingIntentStore(
    await openVenueStateDb(join(mkdtempSync(join(tmpdir(), "venue-intent-kit-")), "venue.db")),
  ));
```

- [ ] **Step 4: Run, export, verify, commit**

Append to `packages/marketplace/venue-base/src/index.ts`:

```ts
export { createSqlitePostingIntentStore } from "./intents.js";
```

Run:
```bash
cd packages/marketplace/venue-base && yarn typecheck && yarn test && yarn build
cd ../testing && yarn vitest run src/venue-conformance.test.ts
```
Expected: 7 unit tests PASS; 2 kit cases PASS.

```bash
git add packages/marketplace/venue-base/src packages/marketplace/testing/src
git commit -m "feat(venue-base): the durable posting-intent outbox

Transactional-outbox store replacing the binding's in-memory reference: a
linearizable single-INSERT claim, owner tokens that survive restart, and
replay returning the prior outcome instead of re-broadcasting a funded post.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 20: The projector-backed observe port

**Files:**
- Create: `packages/marketplace/venue-base/src/observe.ts`, `src/observe.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `VenueStateDb`, `VenueRawLog`, `ChainLogSource`; `MarketplaceObservePort`, `SubmissionScopeRecord`, `SubmissionScopeClaim`, `SubmissionScopeOwnerToken`, `RecordSubmissionInput`, `deriveMarketplaceAttemptUri` from binding.
- Produces:
  - `interface VenueAttemptRef { readonly attempt: AttemptUri; readonly taskId: bigint; readonly attemptIndex: number; readonly operator: Address; readonly requestId?: Hex }`
  - `interface VenueObservePort extends MarketplaceObservePort { listAttemptsForTask(task: SubmissionUri | { readonly taskId: bigint }): Promise<readonly VenueAttemptRef[]>; ingest(logs: readonly VenueRawLog[]): Promise<void> }` — decision D10
  - `createVenueObservePort(input: { db: VenueStateDb; chain: MarketplaceChainConfig; fetchBytes: (uri: string) => Promise<Uint8Array> }): VenueObservePort`
  - `class SubmissionScopeConflictError extends Error`

`ingest` is how the host's projector loop feeds decoded chain facts in. Because the log source scans the router and coordinator addresses for **all** engagements, `deliveries` / `fetchDelivery` / `listAttemptsForTask` answer for tasks the operator **posted** as well as tasks it claimed — Step 1's test pins exactly that.

- [ ] **Step 1: Write the failing test**

`packages/marketplace/venue-base/src/observe.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_SEPOLIA_TODAY,
  JINN_ROUTER_V3_ABI,
  deriveMarketplaceAttemptUri,
} from "@jinn-network/marketplace-binding";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openVenueStateDb, type VenueStateDb } from "./state/db.js";
import { SubmissionScopeConflictError, createVenueObservePort } from "./observe.js";
import type { VenueRawLog } from "./chain/log-source.js";

const OTHER_OPERATOR = "0x00000000000000000000000000000000000000ee" as Address;
const REQUEST = `0x${"6".repeat(64)}` as Hex;

function attemptCreatedLog(taskId: bigint, attemptIndex: number, blockNumber: bigint): VenueRawLog {
  return {
    chainId: 84532,
    address: BASE_SEPOLIA_TODAY.jinnRouter,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    finalityTier: "finalized",
    topics: encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI, eventName: "TaskAttemptCreated",
      args: { taskId, attemptIndex, requestId: REQUEST },
    }),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [OTHER_OPERATOR, OTHER_OPERATOR, 1n],
    ),
  };
}

let dir: string;
let db: VenueStateDb;
const bytesByUri = new Map<string, Uint8Array>();

function port() {
  return createVenueObservePort({
    db, chain: BASE_SEPOLIA_TODAY,
    fetchBytes: async (uri) => {
      const found = bytesByUri.get(uri);
      if (found === undefined) throw new Error(`no bytes for ${uri}`);
      return found;
    },
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venue-observe-"));
  db = await openVenueStateDb(join(dir, "venue.db"));
  bytesByUri.clear();
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const scope = {
  requester: "0x00000000000000000000000000000000000000a1",
  idempotencyKey: "idem-1",
  submissionUri: "urn:uuid:00000000-0000-5000-8000-0000000000aa" as const,
  digest: `sha256:${"1".repeat(64)}` as const,
  submissionBytes: new Uint8Array([1, 2, 3]),
};

describe("projector-backed observe port", () => {
  it("grants requester scope once and reports pending to a concurrent claimant", async () => {
    const observe = port();
    expect((await observe.claimSubmissionScope(scope)).kind).toBe("owner");
    expect((await observe.claimSubmissionScope(scope)).kind).toBe("pending");
  });

  it("refuses a re-claim whose bytes differ under the same idempotency key", async () => {
    const observe = port();
    await observe.claimSubmissionScope(scope);
    const claim = await observe.claimSubmissionScope({
      ...scope, submissionBytes: new Uint8Array([9]), digest: `sha256:${"9".repeat(64)}`,
    });
    expect(claim.kind).toBe("conflict");
  });

  it("returns the durable record on replay after resolution", async () => {
    const observe = port();
    const claim = await observe.claimSubmissionScope(scope);
    if (claim.kind !== "owner") throw new Error("unreachable");
    await observe.resolveSubmissionScope({
      taskDigest: `sha256:${"2".repeat(64)}`, submissionDigest: scope.digest,
      submissionBytes: scope.submissionBytes, submission: {},
      outcome: { taskId: 7n, txHash: `0x${"3".repeat(64)}` },
    }, claim.ownerToken);
    const replay = await observe.claimSubmissionScope(scope);
    expect(replay.kind).toBe("resolved");
  });

  it("refuses a non-owner resolve", async () => {
    const observe = port();
    await observe.claimSubmissionScope(scope);
    await expect(observe.resolveSubmissionScope({
      taskDigest: `sha256:${"2".repeat(64)}`, submissionDigest: scope.digest,
      submissionBytes: scope.submissionBytes, submission: {},
      outcome: { taskId: 7n, txHash: `0x${"3".repeat(64)}` },
    }, "scope-owner:impostor" as never)).rejects.toBeInstanceOf(SubmissionScopeConflictError);
  });

  it("lists attempts for a task the operator POSTED but never claimed", async () => {
    const observe = port();
    const claim = await observe.claimSubmissionScope(scope);
    if (claim.kind !== "owner") throw new Error("unreachable");
    await observe.resolveSubmissionScope({
      taskDigest: `sha256:${"2".repeat(64)}`, submissionDigest: scope.digest,
      submissionBytes: scope.submissionBytes, submission: {},
      outcome: { taskId: 7n, txHash: `0x${"3".repeat(64)}` },
    }, claim.ownerToken);

    // The log source scans the venue addresses for ALL engagements, so a third party's attempt
    // on the operator's own posted task is ingested exactly like any other.
    await observe.ingest([attemptCreatedLog(7n, 0, 100n), attemptCreatedLog(7n, 1, 101n)]);

    const bySubmission = await observe.listAttemptsForTask(scope.submissionUri);
    expect(bySubmission.map((a) => a.attemptIndex)).toEqual([0, 1]);
    expect(bySubmission[0]!.operator).toBe(OTHER_OPERATOR);
    expect(bySubmission[0]!.attempt).toBe(deriveMarketplaceAttemptUri({
      chainId: 84532, coordinator: BASE_SEPOLIA_TODAY.taskCoordinator, taskId: 7n, attemptIndex: 0,
    }));
    expect(await observe.listAttemptsForTask({ taskId: 7n })).toEqual(bySubmission);
  });

  it("returns deliveries and exact bytes for a posted task's attempt", async () => {
    const observe = port();
    await observe.ingest([attemptCreatedLog(7n, 0, 100n)]);
    const attempt = deriveMarketplaceAttemptUri({
      chainId: 84532, coordinator: BASE_SEPOLIA_TODAY.taskCoordinator, taskId: 7n, attemptIndex: 0,
    });
    const bytes = new Uint8Array([4, 5, 6]);
    await observe.recordDelivery(attempt, bytes);
    const refs = await observe.deliveries(attempt);
    expect(refs.length).toBe(1);
    expect(await observe.fetchDelivery(refs[0]!)).toEqual(bytes);
  });

  it("is idempotent on re-ingest of the same log", async () => {
    const observe = port();
    await observe.ingest([attemptCreatedLog(7n, 0, 100n)]);
    await observe.ingest([attemptCreatedLog(7n, 0, 100n)]);
    expect((await observe.listAttemptsForTask({ taskId: 7n })).length).toBe(1);
  });

  it("folds driven observations into an attempt snapshot", async () => {
    const observe = port();
    await observe.ingest([attemptCreatedLog(7n, 0, 100n)]);
    const attempt = deriveMarketplaceAttemptUri({
      chainId: 84532, coordinator: BASE_SEPOLIA_TODAY.taskCoordinator, taskId: 7n, attemptIndex: 0,
    });
    await observe.drive(attempt, [{
      specversion: "1.0", id: "obs-1", source: "urn:jinn:venue-base", subject: attempt,
      time: "2026-07-30T00:00:00.000Z", datacontenttype: "application/json", sequence: 1,
      type: "network.jinn.task-execution.attempt-terminal.v1", data: { state: "delivered" },
    } as never]);
    const snapshot = await observe.observe(attempt);
    expect(snapshot.state).toBe("delivered");
  });

  it("reports an unknown attempt rather than an empty snapshot", async () => {
    await expect(port().observe("urn:uuid:00000000-0000-5000-8000-000000000000"))
      .rejects.toThrow(/unknown/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/observe.test.ts` — Expected: FAIL, module not found.

`packages/marketplace/venue-base/src/observe.ts`:

```ts
// SPDX-License-Identifier: MIT

// `MarketplaceObservePort`, projector-backed (composition design §6.1): retires the in-memory
// stub the binding flags as "Milestone M4, not yet built". The host's projector loop calls
// `ingest` with decoded chain facts; everything else reads the durable projection.
//
// REQUESTER-SIDE COVERAGE (decision D10): the log source scans the venue's router and
// coordinator addresses for ALL engagements, not a claim-filtered subset, so `deliveries`,
// `fetchDelivery`, and the additive `listAttemptsForTask` answer for tasks the operator POSTED
// exactly as they do for tasks it claimed.
import {
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
  deriveMarketplaceAttemptUri,
  type MarketplaceChainConfig,
  type MarketplaceObservePort,
  type RecordSubmissionInput,
  type SubmissionScopeClaim,
  type SubmissionScopeOwnerToken,
} from "@jinn-network/marketplace-binding";
import { foldObservations, type ProtocolObservation } from "@jinn-network/task-execution-protocol";
import { decodeEventLog, type Address, type Hex } from "viem";
import type { VenueRawLog } from "./chain/log-source.js";
import type { VenueStateDb } from "./state/db.js";

type AttemptUri = `urn:uuid:${string}`;
type SubmissionUri = `urn:uuid:${string}`;

export class SubmissionScopeConflictError extends Error {
  constructor(detail: string) {
    super(`submission scope: ${detail}`);
    this.name = "SubmissionScopeConflictError";
  }
}

export interface VenueAttemptRef {
  readonly attempt: AttemptUri;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly operator: Address;
  readonly requestId?: Hex;
}

export interface VenueObservePort extends MarketplaceObservePort {
  /** Decision D10: the requester's attempt listing, which `MarketplaceObservePort` lacks. */
  listAttemptsForTask(task: SubmissionUri | { readonly taskId: bigint }): Promise<readonly VenueAttemptRef[]>;
  /** The projector loop's feed. Idempotent by (blockHash, logIndex). */
  ingest(logs: readonly VenueRawLog[]): Promise<void>;
}

export interface VenueObservePortInput {
  readonly db: VenueStateDb;
  readonly chain: MarketplaceChainConfig;
  /** Injected transport: this package may not reach the ambient network (source-boundary guard). */
  readonly fetchBytes: (uri: string) => Promise<Uint8Array>;
}

interface ScopeRow {
  readonly submission_uri: string; readonly digest: string;
  readonly submission_bytes: Uint8Array; readonly owner_token: string;
  readonly resolved: number; readonly outcome_json: string | null;
}

export function createVenueObservePort(input: VenueObservePortInput): VenueObservePort {
  const { db, chain, fetchBytes } = input;
  const eventAbi = chain.generation === "today" ? JINN_ROUTER_V3_ABI : JINN_ROUTER_V4_ABI;

  const attemptUriFor = (taskId: bigint, attemptIndex: number): AttemptUri =>
    deriveMarketplaceAttemptUri({
      chainId: chain.chainId, coordinator: chain.taskCoordinator, taskId, attemptIndex,
    });

  function attemptRows(taskId: bigint): VenueAttemptRef[] {
    return db.all<{ observation_json: string }>(
      "SELECT observation_json FROM venue_observations WHERE ref = ? ORDER BY sequence ASC",
      [`task:${taskId.toString()}`],
    ).map((row) => {
      const parsed = JSON.parse(row.observation_json) as {
        attemptIndex: number; operator: Address; requestId?: Hex;
      };
      return {
        attempt: attemptUriFor(taskId, parsed.attemptIndex),
        taskId,
        attemptIndex: parsed.attemptIndex,
        operator: parsed.operator,
        ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
      };
    });
  }

  function taskIdForSubmission(submissionUri: SubmissionUri): bigint | undefined {
    const row = db.get<ScopeRow>(
      "SELECT * FROM venue_submission_scopes WHERE submission_uri = ?", [submissionUri],
    );
    if (row?.outcome_json == null) return undefined;
    return BigInt((JSON.parse(row.outcome_json) as { taskId: string }).taskId);
  }

  return {
    async claimSubmissionScope(scope): Promise<SubmissionScopeClaim> {
      return db.transaction(() => {
        const row = db.get<ScopeRow>(
          "SELECT * FROM venue_submission_scopes WHERE requester = ? AND idempotency_key = ?",
          [scope.requester.toLowerCase(), scope.idempotencyKey],
        );
        if (row !== undefined) {
          // TEP §12.2 idempotent resubmission matches by EXACT BYTES, never field equality.
          const same = row.digest === scope.digest
            && Buffer.from(row.submission_bytes).equals(Buffer.from(scope.submissionBytes));
          if (!same) return { kind: "conflict" as const };
          if (row.resolved === 1) {
            return {
              kind: "resolved" as const,
              record: {
                submissionUri: row.submission_uri as SubmissionUri,
                digest: row.digest as `sha256:${string}`,
                submissionBytes: new Uint8Array(row.submission_bytes),
              },
            };
          }
          return { kind: "pending" as const };
        }
        const ownerToken = `scope-owner:${crypto.randomUUID()}` as SubmissionScopeOwnerToken;
        db.run(
          "INSERT INTO venue_submission_scopes (requester, idempotency_key, submission_uri, "
            + "digest, submission_bytes, owner_token) VALUES (?, ?, ?, ?, ?, ?)",
          [
            scope.requester.toLowerCase(), scope.idempotencyKey, scope.submissionUri,
            scope.digest, Buffer.from(scope.submissionBytes), ownerToken,
          ],
        );
        return { kind: "owner" as const, ownerToken };
      });
    },

    async resolveSubmissionScope(record: RecordSubmissionInput, ownerToken) {
      db.transaction(() => {
        const row = db.get<ScopeRow>(
          "SELECT * FROM venue_submission_scopes WHERE digest = ?", [record.submissionDigest],
        );
        if (row === undefined) throw new SubmissionScopeConflictError("never claimed");
        if (row.owner_token !== ownerToken) {
          throw new SubmissionScopeConflictError("only the scope owner token may resolve");
        }
        db.run(
          "UPDATE venue_submission_scopes SET resolved = 1, outcome_json = ? WHERE digest = ?",
          [
            JSON.stringify({
              taskId: record.outcome.taskId.toString(), txHash: record.outcome.txHash,
            }),
            record.submissionDigest,
          ],
        );
      });
    },

    async ingest(logs) {
      db.transaction(() => {
        for (const log of logs) {
          let decoded: { eventName: string; args: unknown };
          try {
            decoded = decodeEventLog({
              abi: eventAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
            }) as never;
          } catch {
            continue; // not a router event this generation decodes
          }
          if (decoded.eventName !== "TaskAttemptCreated") continue;
          const args = decoded.args as {
            taskId: bigint; attemptIndex: number; operator: Address; requestId?: Hex;
          };
          db.run(
            "INSERT INTO venue_observations (ref, sequence, observation_json) VALUES (?, ?, ?) "
              + "ON CONFLICT(ref, sequence) DO NOTHING",
            [
              `task:${args.taskId.toString()}`,
              Number(args.attemptIndex),
              JSON.stringify({
                attemptIndex: Number(args.attemptIndex),
                operator: args.operator,
                ...(args.requestId === undefined ? {} : { requestId: args.requestId }),
              }),
            ],
          );
        }
      });
    },

    async listAttemptsForTask(task) {
      const taskId = typeof task === "string" ? taskIdForSubmission(task) : task.taskId;
      return taskId === undefined ? [] : attemptRows(taskId);
    },

    async observe(ref) {
      const rows = db.all<{ observation_json: string }>(
        "SELECT observation_json FROM venue_observations WHERE ref = ? ORDER BY sequence ASC",
        [`driven:${ref}`],
      );
      if (rows.length === 0) throw new Error(`unknown reference for this venue: ${ref}`);
      return foldObservations(
        rows.map((row) => JSON.parse(row.observation_json) as ProtocolObservation),
      ) as never;
    },

    async recover(ref) {
      const attempts = db.all<{ ref: string }>(
        "SELECT ref FROM venue_observations WHERE ref = ?", [`driven:${ref}`],
      );
      return { reference: ref, reconciled: attempts.length > 0 } as never;
    },

    async drive(attempt, observations) {
      db.transaction(() => {
        let sequence = db.all<{ sequence: number }>(
          "SELECT sequence FROM venue_observations WHERE ref = ? ORDER BY sequence DESC LIMIT 1",
          [`driven:${attempt}`],
        )[0]?.sequence ?? 0;
        for (const observation of observations) {
          sequence += 1;
          db.run(
            "INSERT INTO venue_observations (ref, sequence, observation_json) VALUES (?, ?, ?) "
              + "ON CONFLICT(ref, sequence) DO NOTHING",
            [`driven:${attempt}`, sequence, JSON.stringify(observation)],
          );
        }
      });
    },

    async recordDelivery(attempt, deliveryBytes) {
      const digest = [...new Uint8Array(
        await crypto.subtle.digest("SHA-256", deliveryBytes as unknown as ArrayBuffer),
      )].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      db.run(
        "INSERT INTO venue_delivery_bytes (attempt, digest, bytes) VALUES (?, ?, ?) "
          + "ON CONFLICT(attempt, digest) DO NOTHING",
        [attempt, `sha256:${digest}`, Buffer.from(deliveryBytes)],
      );
    },

    simulateReconciliation() {
      throw new Error(
        "simulateReconciliation is a test-double affordance; the projector-backed port refuses it",
      );
    },

    async deliveries(attempt) {
      return db.all<{ digest: string }>(
        "SELECT digest FROM venue_delivery_bytes WHERE attempt = ? ORDER BY digest ASC", [attempt],
      ).map((row) => ({ attempt, digest: row.digest })) as never;
    },

    async fetchDelivery(ref) {
      const record = ref as unknown as { attempt?: string; digest?: string; uri?: string };
      if (record.attempt !== undefined && record.digest !== undefined) {
        const row = db.get<{ bytes: Uint8Array }>(
          "SELECT bytes FROM venue_delivery_bytes WHERE attempt = ? AND digest = ?",
          [record.attempt, record.digest],
        );
        if (row !== undefined) return new Uint8Array(row.bytes);
      }
      if (record.uri === undefined) {
        throw new Error(`delivery reference ${JSON.stringify(ref)} is neither local nor addressable`);
      }
      return fetchBytes(record.uri);
    },
  };
}
```

- [ ] **Step 3: Run, export, verify, commit**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/observe.test.ts` — Expected: PASS (9 tests). If `foldObservations`'s return shape does not expose `state` directly, adjust the assertion in the "folds driven observations" case to read the field the protocol package actually returns (`DerivedAttemptState`) — do not change the implementation to match a guessed shape.

Append to `src/index.ts`:

```ts
export { SubmissionScopeConflictError, createVenueObservePort } from "./observe.js";
export type { VenueAttemptRef, VenueObservePort, VenueObservePortInput } from "./observe.js";
```

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test` — Expected: PASS.

```bash
git add packages/marketplace/venue-base/src
git commit -m "feat(venue-base): the projector-backed observe port

Retires the binding's in-memory M4 stub: durable submission scopes matched by
exact bytes, an idempotent chain-fact ingest, and requester-side reads that
answer for tasks the operator POSTED, plus the additive listAttemptsForTask
stage 3 needs (decision D10).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 21: The `createBaseVenue` facade and the closing gate

**Files:**
- Create: `packages/marketplace/venue-base/src/facade.ts`, `src/facade.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`, `packages/marketplace/venue-base/README.md`
- Modify: `packages/marketplace/testing/src/venue-conformance.test.ts`
- Modify: `.github/workflows/marketplace-ci.yml` (venue-anvil job)

**Interfaces:**
- Consumes: every factory from Tasks 4, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20.
- Produces the single supported composition surface:

```ts
export interface BaseVenueConfig {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safeAddress: Address;
  readonly stateDbPath: string;
  readonly priorityMech: Address;
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
  readonly pin: IpfsPinPort["pin"];
  readonly verifySettlementGrade: SettlementPorts["verifySettlementGrade"];
  readonly fetchBytes: (uri: string) => Promise<Uint8Array>;
  readonly logSource?: { readonly startBlock?: bigint; readonly chunkBlocks?: bigint };
  readonly broadcast?: Partial<typeof DEFAULT_BROADCAST_TUNING>;
  readonly waits?: {
    readonly finalityPollMs?: number; readonly finalityTimeoutMs?: number;
    readonly deliveryPollMs?: number; readonly deliveryTimeoutMs?: number;
  };
}

export interface BaseVenue {
  readonly claim: ClaimWriter;                       // Pick<ClaimPorts, "claimTask">, decision D3
  readonly settlement: SettlementPorts;
  readonly verdict: VerdictPorts;                    // decision D9
  readonly lifecycle: MarketplaceLifecyclePorts;
  readonly finality: FinalityPort;
  readonly deliveryWait: DeliveryWaitPort;
  readonly release: ReleaseAttemptPort;
  readonly observe: VenueObservePort;                // decision D10
  readonly safe: VenueSafeBroadcast;
  readonly logSource: ChainLogSource;
  readonly intents: PostingIntentStore;
  close(): void;
}

export function createBaseVenue(config: BaseVenueConfig): Promise<BaseVenue>;  // async, decision D8
```

- [ ] **Step 1: Write the failing facade test**

`packages/marketplace/venue-base/src/facade.test.ts`:

```ts
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import type { Address, PublicClient, WalletClient } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBaseVenue, type BaseVenue } from "./facade.js";

const SAFE = "0x00000000000000000000000000000000000000a1" as Address;
const MECH = "0x00000000000000000000000000000000000000dd" as Address;

let dir: string;
let venue: BaseVenue;

const config = () => ({
  chain: BASE_SEPOLIA_TODAY,
  publicClient: { async getBlockNumber() { return 1n; } } as unknown as PublicClient,
  walletClient: { account: { address: MECH } } as unknown as WalletClient,
  safeAddress: SAFE,
  stateDbPath: join(dir, "venue.db"),
  priorityMech: MECH,
  isAuthorizedMechOrigin: (address: Address) => address === MECH,
  pin: async () => {},
  verifySettlementGrade: async () => ({
    executorBinding: { status: "verified" as const },
    dispatchBinding: { status: "verified" as const },
    evaluationSpecification: { status: "not-applicable" as const },
  }),
  fetchBytes: async () => new Uint8Array(),
});

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "venue-facade-")); });
afterEach(() => { venue?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("createBaseVenue", () => {
  it("returns exactly the pinned facade keys plus the two additive groups", async () => {
    venue = await createBaseVenue(config());
    expect(Object.keys(venue).sort()).toEqual([
      "claim", "close", "deliveryWait", "finality", "intents", "lifecycle", "logSource",
      "observe", "release", "safe", "settlement", "verdict",
    ]);
  });

  it("wires every group to the same state database", async () => {
    venue = await createBaseVenue(config());
    const claim = await venue.intents.claim({
      creatorSafe: SAFE, taskCidDigest: `sha256:${"1".repeat(64)}`,
      submissionDigest: `sha256:${"2".repeat(64)}`, idempotencyKey: "k",
      createdAt: "2026-07-30T00:00:00.000Z",
    });
    expect(claim.kind).toBe("owner");
    venue.close();

    const reopened = await createBaseVenue(config());
    expect((await reopened.intents.claim({
      creatorSafe: SAFE, taskCidDigest: `sha256:${"1".repeat(64)}`,
      submissionDigest: `sha256:${"2".repeat(64)}`, idempotencyKey: "k",
      createdAt: "2026-07-30T00:00:00.000Z",
    })).kind).toBe("pending-other");
    venue = reopened;
  });

  it("reports release as unsupported in the today generation", async () => {
    venue = await createBaseVenue(config());
    await expect(venue.release.releaseAttempt({ taskId: 1n, attemptIndex: 0 }))
      .resolves.toEqual({ ok: false, kind: "unsupported" });
  });

  it("names the missing parent directory instead of creating it", async () => {
    await expect(createBaseVenue({ ...config(), stateDbPath: join(dir, "absent", "venue.db") }))
      .rejects.toThrow(/parent directory .* does not exist/);
  });

  it("refuses a wallet client with no account rather than deferring the failure to broadcast time", async () => {
    await expect(createBaseVenue({ ...config(), walletClient: {} as WalletClient }))
      .rejects.toThrow(/wallet client with an account/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/facade.test.ts` — Expected: FAIL, module not found.

`packages/marketplace/venue-base/src/facade.ts`:

```ts
// SPDX-License-Identifier: MIT

// The one supported composition surface (program plan §5). Per-port factories exist underneath
// and stay exported for tests and specialised hosts; this facade is what the operator runtime,
// Autopilot's adoption pass, and benchmarking's marketplace mode all consume.
import type {
  ClaimPorts,
  DeliveryWaitPort,
  FinalityPort,
  IpfsPinPort,
  MarketplaceChainConfig,
  MarketplaceLifecyclePorts,
  PostingIntentStore,
  ReleaseAttemptPort,
  SettlementPorts,
} from "@jinn-network/marketplace-binding";
import type { Address, PublicClient, WalletClient } from "viem";
import { DEFAULT_CHUNK_BLOCKS } from "./chain/chunking.js";
import { createChainLogSource, type ChainLogSource } from "./chain/log-source.js";
import { DEFAULT_BROADCAST_TUNING } from "./broadcast/fees.js";
import { createSafeBroadcast, type VenueSafeBroadcast } from "./broadcast/safe.js";
import { createClaimWriter, type ClaimWriter } from "./claim.js";
import { createDeliveryWaiter } from "./delivery-wait.js";
import { createFinalityWaiter } from "./finality.js";
import { createSqlitePostingIntentStore } from "./intents.js";
import { createLifecyclePorts, createReleasePort } from "./lifecycle.js";
import { createVenueObservePort, type VenueObservePort } from "./observe.js";
import { createSettlementPorts } from "./settlement/writes.js";
import { openVenueStateDb } from "./state/db.js";
import { createVerdictPorts, type VerdictPorts } from "./verdict.js";

export interface BaseVenueConfig {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safeAddress: Address;
  /** The host creates this file's parent directory; this package never will (decision D1). */
  readonly stateDbPath: string;
  readonly priorityMech: Address;
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
  /** Host-owned (decision D2): the registry pin port. */
  readonly pin: IpfsPinPort["pin"];
  /** Host-owned (decision D2): owns the injected trust and referenced-evidence resolvers. */
  readonly verifySettlementGrade: SettlementPorts["verifySettlementGrade"];
  /** Host-owned (decision D2): this package may not reach the ambient network. */
  readonly fetchBytes: (uri: string) => Promise<Uint8Array>;
  readonly logSource?: { readonly startBlock?: bigint; readonly chunkBlocks?: bigint };
  readonly broadcast?: Partial<typeof DEFAULT_BROADCAST_TUNING>;
  readonly waits?: {
    readonly finalityPollMs?: number;
    readonly finalityTimeoutMs?: number;
    readonly deliveryPollMs?: number;
    readonly deliveryTimeoutMs?: number;
  };
}

export interface BaseVenue {
  readonly claim: ClaimWriter;
  readonly settlement: SettlementPorts;
  readonly verdict: VerdictPorts;
  readonly lifecycle: MarketplaceLifecyclePorts;
  readonly finality: FinalityPort;
  readonly deliveryWait: DeliveryWaitPort;
  readonly release: ReleaseAttemptPort;
  readonly observe: VenueObservePort;
  readonly safe: VenueSafeBroadcast;
  readonly logSource: ChainLogSource;
  readonly intents: PostingIntentStore;
  close(): void;
}

export async function createBaseVenue(config: BaseVenueConfig): Promise<BaseVenue> {
  if (config.walletClient.account === undefined) {
    throw new Error(
      "createBaseVenue requires a wallet client with an account: this package is "
        + "signer-injection only and never constructs a signer of its own",
    );
  }
  const db = await openVenueStateDb(config.stateDbPath);
  const safe = createSafeBroadcast({
    db, publicClient: config.publicClient, walletClient: config.walletClient,
    chain: config.chain, safeAddress: config.safeAddress,
    ...(config.broadcast === undefined ? {} : { tuning: config.broadcast }),
  });

  return {
    claim: createClaimWriter({ publicClient: config.publicClient, safe, chain: config.chain }),
    settlement: createSettlementPorts({
      publicClient: config.publicClient, safe, chain: config.chain, pin: config.pin,
      verifySettlementGrade: config.verifySettlementGrade, priorityMech: config.priorityMech,
    }),
    verdict: createVerdictPorts({ publicClient: config.publicClient, safe, chain: config.chain }),
    lifecycle: createLifecyclePorts({ db, safe, chain: config.chain }),
    finality: createFinalityWaiter({
      publicClient: config.publicClient,
      ...(config.waits?.finalityPollMs === undefined ? {} : { pollIntervalMs: config.waits.finalityPollMs }),
      ...(config.waits?.finalityTimeoutMs === undefined ? {} : { timeoutMs: config.waits.finalityTimeoutMs }),
    }),
    deliveryWait: createDeliveryWaiter({
      ...(config.waits?.deliveryPollMs === undefined ? {} : { pollIntervalMs: config.waits.deliveryPollMs }),
      ...(config.waits?.deliveryTimeoutMs === undefined ? {} : { timeoutMs: config.waits.deliveryTimeoutMs }),
    }),
    release: createReleasePort({ safe, chain: config.chain }),
    observe: createVenueObservePort({ db, chain: config.chain, fetchBytes: config.fetchBytes }),
    safe,
    logSource: createChainLogSource({
      db, publicClient: config.publicClient, chain: config.chain,
      addresses: [config.chain.jinnRouter, config.chain.taskCoordinator, config.chain.mechMarketplace],
      startBlock: config.logSource?.startBlock ?? 0n,
      chunkBlocks: config.logSource?.chunkBlocks ?? DEFAULT_CHUNK_BLOCKS,
    }),
    intents: createSqlitePostingIntentStore(db),
    close() { db.close(); },
  };
}
```

- [ ] **Step 3: Run the facade suite and export**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/facade.test.ts` — Expected: PASS (5 tests).

Append to `src/index.ts`:

```ts
export { createBaseVenue } from "./facade.js";
export type { BaseVenue, BaseVenueConfig } from "./facade.js";
```

- [ ] **Step 4: Add the end-to-end fork suite to the kit**

Append to `packages/marketplace/testing/src/venue-conformance.ts`:

```ts
export interface VenueFacadeForkContext {
  readonly venue: {
    readonly logSource: { scan(): Promise<{ kind: string }> };
    readonly release: { releaseAttempt(input: { taskId: bigint; attemptIndex: number }): Promise<unknown> };
    readonly lifecycle: { withdrawAnnouncement(input: { taskId: bigint }): Promise<void> };
    readonly intents: { claim(intent: never): Promise<{ kind: string }> };
  };
}

/** The composed facade, exercised against a real fork of the deployed venue. */
export function describeVenueFacadeOverFork(context: VenueFacadeForkContext | undefined): void {
  describe.runIf(context !== undefined)("venue conformance: composed facade over a fork", () => {
    it("scans the live chain through the composed log source", async () => {
      expect(["advanced", "idle"]).toContain((await context!.venue.logSource.scan()).kind);
    });

    it("reports today-generation release as unsupported rather than pretending", async () => {
      await expect(context!.venue.release.releaseAttempt({ taskId: 1n, attemptIndex: 0 }))
        .resolves.toEqual({ ok: false, kind: "unsupported" });
    });

    it("records an announcement withdrawal without a chain write", async () => {
      await expect(context!.venue.lifecycle.withdrawAnnouncement({ taskId: 1n })).resolves.toBeUndefined();
    });
  });
}
```

Append to `packages/marketplace/testing/src/venue-conformance.test.ts`:

```ts
import { createBaseVenue } from "@jinn-network/marketplace-venue-base";
import { describeVenueFacadeOverFork } from "./venue-conformance.js";

describeVenueFacadeOverFork(fork === undefined ? undefined : {
  venue: await createBaseVenue({
    chain: fork.chain,
    publicClient: fork.publicClient,
    walletClient: fork.walletClient,
    safeAddress: fork.safeAddress,
    stateDbPath: join(fork.stateDir, "venue.db"),
    priorityMech: fork.safeAddress,
    isAuthorizedMechOrigin: () => true,
    pin: async () => {},
    verifySettlementGrade: async () => ({
      executorBinding: { status: "verified" },
      dispatchBinding: { status: "verified" },
      evaluationSpecification: { status: "not-applicable" },
    }),
    fetchBytes: async () => new Uint8Array(),
    logSource: { startBlock: (await fork.publicClient.getBlockNumber()) - 50n },
  }) as never,
});
```

- [ ] **Step 5: Complete the README**

Append to `packages/marketplace/venue-base/README.md`:

```markdown
## Composition

```ts
const venue = await createBaseVenue({
  chain: BASE_SEPOLIA_TODAY,
  publicClient, walletClient, safeAddress,
  stateDbPath: "/var/lib/jinn/venue.db",   // parent directory must already exist
  priorityMech, isAuthorizedMechOrigin,
  pin: createRegistryPinPort({ registryUrl, fetchImpl: fetch }).pin,
  verifySettlementGrade,                   // host-owned; owns the trust resolvers
  fetchBytes,                              // host-owned HTTP transport
});
```

`venue.safe.broadcastSafeTransaction` and `venue.safe.sendEoaTransaction` are the only two
transaction paths, sharing one lock, one nonce ledger, and one fee-bump machine on the sender
key. `venue.claim` is the claim WRITE only —
the rest of `ClaimPorts` is per-engagement data the host composes. `venue.verdict` carries the
evaluation leg's chain surface. `venue.observe` is a `MarketplaceObservePort` widened with
`listAttemptsForTask` for the requester side. Call `venue.close()` to release the database.
```

- [ ] **Step 6: Add the venue-anvil CI job**

In `.github/workflows/marketplace-ci.yml`, duplicate the existing `anvil-fork:` job as `venue-anvil:` with these differences: `needs: [binding, venue-base]`; an extra "Restore Marketplace Venue-Base distribution" download step and a `(cd packages/marketplace/venue-base && yarn install --immutable)` line in the cross-toolchain install step; and the run step becomes:

```yaml
      - name: Run the Anvil-fork venue conformance kit
        working-directory: packages/marketplace/testing
        run: yarn vitest run src/venue-anvil.test.ts src/venue-fixtures.test.ts src/venue-conformance.test.ts
```

Then add `venue-anvil` to the `verify` job's `needs`, add `VENUE_ANVIL_RESULT: ${{ needs.venue-anvil.result }}` to its `env`, and add `"$VENUE_ANVIL_RESULT" \` to the `for result in` list.

- [ ] **Step 7: Full verification**

Run:
```bash
cd packages/marketplace/binding && yarn install && yarn typecheck && yarn test && yarn build
cd ../pipeline && yarn install && yarn typecheck && yarn test
cd ../venue-base && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../testing && yarn install && yarn typecheck && yarn test && yarn build && yarn pack:smoke
cd ../../.. && node --test .github/scripts/marketplace-package-inventory.test.mjs \
                          .github/scripts/marketplace-source-boundaries.test.mjs \
                          .github/scripts/custody-boundaries.test.mjs
node .github/scripts/marketplace-packed-types.test.mjs
```
Expected: every package green; all guards PASS; the packed-types script prints `Compiled a packed TypeScript consumer against 11 public code entrypoints across all 5 marketplace packages.`

- [ ] **Step 8: Commit and open the PR train**

```bash
git add packages/marketplace/venue-base packages/marketplace/testing .github/workflows/marketplace-ci.yml
git commit -m "feat(venue-base): the createBaseVenue facade and the Anvil-fork CI gate

The one supported composition surface: eleven port groups over one state
database and one Safe broadcaster, with the venue conformance kit wired as a
required CI stage.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

PR into `integration/evidence-v1`. The description must carry: the design-finding list (D1–D10) with dispositions; the note that `createBaseVenue` is async and that `config` is wider than program §5's pinned shape (additive, return shape unchanged); and the request for the independent per-component review the program requires before stage 1 builds on this tree.

---

## Self-review

Run this checklist against the plan before executing.

**Spec coverage — design §6.1's nine deliverables plus the additions:**

| §6.1 deliverable | Task |
| --- | --- |
| Chain log source (chunked getLogs, durable `(blockNumber, blockHash)` cursor, reorg per §7.2) | 7, 8 |
| Safe broadcast (execTransaction, shared nonce ledger, cross-process lock, eviction-recovery retry, inner-revert decode) | 4, 9, 10, 11 |
| Claim writer (`ClaimPorts.claimTask`) | 12 |
| Settlement reads + writes | 13, 14 |
| Lifecycle writes (resolve / cancel / withdraw / refund / close / release) | 16 |
| Finality waiter (`FinalityPort`) | 17 |
| Delivery waiter (`DeliveryWaitPort`) | 18 |
| Durable posting-intent store (SQLite outbox, §7.4) | 19 |
| Projector-backed observe (`MarketplaceObservePort`) | 20 |
| Venue conformance kit (Anvil-fork backbone; legacy behavior as fixtures) | 5, 6, 7, 8, 9, 11, 19, 21 |
| Guard trio + `marketplace-ci.yml` wiring | 3, 21 |
| Stage-0 note: re-export the three pipeline ports from binding | 1 |
| Stage-0 note: supersession comment in `binding/src/venue/safe.ts` | 1 |
| **Addition D9:** verdict-leg chain writes | 15 |
| **Addition D10:** requester-side attempt listing | 20 |
| **Addition D11:** general Safe + bare-EOA broadcast surfaces | 11 |
| `createBaseVenue` facade (program §5) | 21 |

**Cross-plan contracts:** 1 single-broadcaster — every port in this tree writes through `safe.broadcastSafeTransaction`, and the legacy bare-EOA legs re-point onto `safe.sendEoaTransaction` on the same ledger and lock (Tasks 11–16, decision D11); 8 port-type home — Task 1; 11 signer-injection only — enforced by the custody guard run at the end of Tasks 4, 7, 8, 9, 11, 21 and by `createBaseVenue`'s explicit refusal of an account-less wallet client; 12 fresh rewrite with legacy as fixtures — Task 6 authors the corpus before any port exists, and Tasks 7, 9, 11, 19 gate on it. Contracts 2, 3, 4, 5, 6, 7, 9, 10 belong to the stage plans, not this tree.

**Standards-audit rulings:** ruling 1 (Defender-relayer profile) — Tasks 9, 10, 11; ruling 2 (thin reader profile, dual finality marks, rollback-and-rescan) — Tasks 7, 8, 17; ruling 4 (transactional outbox + idempotency keys over SQLite WAL) — Tasks 4, 19. Rulings 3 and 5 belong to the transport-http and evaluator-adapters plans.

**Placeholder scan:** no "TBD", no "add error handling", no "similar to Task N". Every test step carries runnable code; every implementation step carries the module in full. Two steps deliberately instruct the engineer to **stop rather than adjust** when reality disagrees — Task 13 Step 3 (a selector mismatch means the transcription is wrong) and Task 20 Step 3 (a `foldObservations` shape mismatch means the assertion is wrong, not the implementation). Those are decision rules, not placeholders.

**Type consistency:** `VenueStateDb` (Task 4) is the parameter name and type everywhere a store is built. `VenueSafeBroadcast` (Task 11) is what Tasks 12, 14, 15, 16 accept. `ClaimWriter = Pick<ClaimPorts, "claimTask">` is used identically in Tasks 12 and 21. `classifyTransactionError` returns `"retryable" | "terminal"` in Tasks 9, 11 and in the kit. `createSettlementReaders` (Task 13) returns exactly the two members `createSettlementPorts` (Task 14) spreads. `VenueRawLog` (Task 8) is what `VenueObservePort.ingest` (Task 20) accepts. `DEFAULT_BROADCAST_TUNING` (Task 9) is the type behind `BaseVenueConfig.broadcast` (Task 21).

**Known execution risk to watch:** the kit lives in `marketplace-testing`, which portals to `venue-base`'s built `dist/`. Every kit run in this plan is preceded by `cd packages/marketplace/venue-base && yarn build`. Skipping that build makes the kit test the previous revision and pass for the wrong reason.
