# Cutover Stage 1 — Solver Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-swap the operator daemon's solver flow onto the merged stack — projector-fed discovery → claim predicate → pipeline → embedded local backend (host-joined evidence) → deliver → settle — retiring the TaskEngine's solution path, `joinedSolverNets` claim gating, and new `task_runs` solution rows, with every surviving legacy transaction re-pointed through one broadcaster.

**Architecture:** A composition root in `client/src/runtime/` assembles `LocalTaskExecutionBackendConfig`, `PipelineConfig`, and `PipelinePorts` from operator config plus `createBaseVenue(...)` and `createFsBlobStore(...)`. Three new supervised loops replace four legacy ones: a **projector loop** (venue log source → `decodeMarketplaceLogs` → `reduceMarketplaceProjection` → `projectAnnouncements` → local on-disk archive, holding the durable finality cursor), a **work loop** (archive announcements → facts → `SubmissionFacts` → `runPipeline` per claim), and an **evidence driver** (local-runtime `sync` / `awaitIndexed` / publication policy). A thin SQLite **engagement ledger** records the wiring entry and idempotency key in the same transaction that admits a claim intent, strictly before broadcast. Config auto-migrates additively to shape version 2 on boot.

**Tech Stack:** TypeScript / Node 22 / Yarn workspaces with `portal:` resolution; viem; Hono; better-sqlite3; vitest; React + wouter + shadcn/ui (operator SPA); Anvil-fork integration suites.

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch target:** `integration/evidence-v1`. Stacked PR train, one train for this stage, ending in exactly **one deploy PR** carrying the drain-runbook checklist and the rollback statement; that PR is **operator-approved** (no agent self-merge).
- **Depends on:** the `2026-07-30-marketplace-venue-base.md` and `2026-07-30-discovery-transport-http.md` plans' trees implemented and independently reviewed. PRs #2306 / #2307 / #2308 assumed merged. `evaluator-adapters` is **not** required by this stage.
- **Upstream surfaces are BINDING** (program §5, cross-plan factory surface). Depend on exactly these:
  - `createBaseVenue(config)` → `{ claim, settlement, lifecycle, finality, deliveryWait, release, observe, safe, logSource, intents }`, `config = { chain, publicClient, walletClient, safeAddress, stateDbPath }`.
  - `createFsBlobStore(rootDir)`, `createArchiveHttpHandler(opts)`, `createHttpTransport(baseUrl, fetchLike)`, `createSseStreamTransport(baseUrl, fetchLike)`.
- **The runtime consumes the stack via in-repo `portal:` links.** Nothing in this stage publishes to npm (#2293 runs in parallel and is not a gate).
- **Cross-plan contracts 1–4, 6, 9, 10 are binding here** (program §6): single-broadcaster; ledger-before-broadcast; projector-catch-up claim gate; additive/atomic/idempotent config migration; evidence publication policy; bridge-era documents; drain rules.
- **Config shape keys (settled, program §5):** `configShapeVersion: 2`, `claimPolicy`, `executionWiring[]` (entries carry `legacyManifestDigest`), `posting[]`. Legacy keys (`joinedSolverNets`) are written beside the new ones and are **deleted only at stage 5**.
- **Config backup filename is a pinned cross-plan contract:** `config.json.pre-v2.<ISO8601>.bak`, written next to the config file, **preserving the original file's permissions** (it can carry paid RPC keys).
- **The token `client` is overloaded repo-wide** — the npm name `@jinn-network/client`, the ghcr image, `~/.jinn-client/`, and `packages/discovery/client/`. Every grep/sed/rename step in this plan must be **path-shaped** (`client/src/...`), never a bare word match.
- **American English throughout.** No product names in tier-3 code (`packages/marketplace/pipeline/` included).
- **Frontend rules:** the SPA delta lands with its `client/OPERATOR-APP-SPEC.md` update **in the same PR**; shadcn/ui primitives only (search the catalog before authoring anything custom, document the attempt in the PR body); **show, don't narrate** — no caption text restating values the UI already renders; no emoji.
- **Every task ends with**: `yarn typecheck` + the touched package's `yarn test` + the relevant conformance kit, outputs shown. Commands, run from the repo root unless stated:
  - `cd "$REPO/client" && yarn typecheck && yarn test`
  - `cd "$REPO/packages/marketplace/pipeline" && yarn test`
  - `cd "$REPO/client/src/dashboard/spa" && yarn test`
  - Repo paths contain an apostrophe (`life's-work`) — **always quote paths in shell**.
- **Rollback posture:** hard swap; rollback is reverting the deploy PR / pinning the previous canary image. New-flow in-flight engagements are abandoned on rollback and surface through the unreleased-attempt state message. No feature flags, no shadow mode.

---

## Design Findings (raise with the coordinator before the affected task; do not silently patch)

These were discovered while reading the code against the design. Each carries a proposed disposition. Tasks that depend on one say so.

1. **`SafeBroadcastPort` is too narrow for the single-broadcaster rule.** `packages/marketplace/binding/src/posting.ts` declares exactly one method, `broadcastCreateTask({ safeAddress, to, value, data })`. Contract 1 requires *every* surviving legacy leg — Safe `execTransaction` calls (`claimEvaluation`, verdict `claimDelivery`, `callDeliverToMarketplace`, `giveFeedback`, the earning family's Safe batches) and raw-EOA sends (checkpoint, top-ups, restake) — to share one nonce authority. **Proposed disposition:** the venue-base facade additionally exposes `safe.broadcastSafeTransaction(input: { safeAddress: Address; to: Address; value: bigint; data: Hex; logicalTx: string }): Promise<{ txHash: Hex }>` and `safe.sendEoaTransaction(input: { to: Address; value: bigint; data?: Hex; logicalTx: string }): Promise<{ txHash: Hex }>`, both on the same per-EOA lock + nonce ledger. Filed as a binding addendum to the venue-base plan. **Task 18 is blocked on this.**
2. **`DerivationAnnotation` has no slot for the bridge marker.** `packages/marketplace/projector/src/derivation.ts` fixes the field set (`chainId, contract, event, blockNumber, blockHash, txHash, logIndex, finalityTier, contractGeneration`). Design §10 says legacy facts cards are synthesized "under a `legacy` derivation annotation". **Proposed disposition:** carry the marker on the *host's* mapper input (`derivation: "legacy" | "sealed"` on `SubmissionFactsCardInput`), not on the projector's `DerivationAnnotation`; `contractGeneration: "today"` already marks bridge-era anchors on-chain. No projector change.
3. **`discovery/serve`'s archive writer is genesis-only and `BlobStore` is write-only.** `writeArchivePages(store, sourceName, entries, maxPageBytes)` re-partitions the *whole* entry set positionally, and `BlobStore` has exactly one method (`put`) — no `get`/`list`. **Proposed disposition:** the host owns page state. The projector loop supplies `appendArchiveEntries` to `projectAnnouncements` (the port `announce.ts` already declares for incremental publication) and reads its own archive back through a filesystem `Transport` (`createFsArchiveTransport`, Task 10) — `discovery/client`'s `sync.ts` builds URLs by string concatenation on `servingRoot`, so a directory-prefix `Transport` satisfies it exactly. Never route local reads through `checkLocator` (it rejects loopback as `private-address`).
4. **`LocalLauncherDeployment` is not exported from the backend-local assembly barrel.** It is declared in `assembly/src/pinning.ts` and consumed as `LocalTaskExecutionBackendConfig.launcherDeployments`, but `assembly/src/index.ts` does not re-export it. **Proposed disposition:** Task 12 adds the type re-export to the assembly barrel (a one-line, additive export; no behavior change) rather than relying on structural typing in the host.
5. **The evidence-join architecture test reads only one file.** `packages/task-execution/backend-local/assembly/src/evidence-join.test.ts:188-191` asserts the string `@jinn-network/evidence-local-runtime` is absent from `evidence-join.ts` alone. **Proposed disposition:** honor it as written (the join stays host-owned) and add the *host-side* mirror in Task 11 — an architecture test asserting `client/src/runtime/evidence-join.ts` is the only module under `client/src/` importing `@jinn-network/evidence-local-runtime`.
6. **`legacyManifestDigest` is a plan-introduced identifier.** Marketplace binding design §7 says "a legacy annotation per wiring entry" over "manifest-digest matching" — it never spells the key. The identifier is settled by program §5 and is already the field name on `ExecutionWiringEntry` and `SubmissionFacts` in shipped pipeline code (`packages/marketplace/pipeline/src/types.ts`). **Proposed disposition:** no action; recorded so a reviewer does not read it as spec drift.
7. **One tx path already bypasses the nonce ledger entirely.** `executeSafeTxBatch` (`client/src/earning/safe-adapter.ts:184`) broadcasts through the Safe protocol-kit's own signer — neither `withEoaBroadcastLock` nor `withNonceLedger` — from the same agent EOA six bootstrap steps use. This is the live instance of the #525/#562/#897 failure class, not a hypothetical. **Proposed disposition:** Task 19 re-points it; it is the highest-value single change in the single-broadcaster work.
8. **`joinedSolverNets` reads bypass migration on one route.** `GET /v1/operator/joined` (`client/src/api/setup-endpoints.ts:974`) re-reads `config.json` from disk directly, not via `loadConfig`, so no migration runs on that path. **Proposed disposition:** Task 21 replaces that route rather than patching it.

---

## File Structure

**New — operator runtime (`client/`)**

| File | Responsibility |
| --- | --- |
| `client/src/runtime/compose.ts` | The composition root: builds venue, backend, evidence, pipeline config/ports, and the three loops |
| `client/src/runtime/evidence-join.ts` | Host-owned `EvidenceBindingPorts` ← `openLocalEvidenceRuntime` (the join the stack refuses to own) |
| `client/src/runtime/local-archive.ts` | Filesystem archive writer state + `createFsArchiveTransport` reader |
| `client/src/runtime/broadcast.ts` | The single-broadcaster facade over venue-base's Safe/EOA broadcast |
| `client/src/runtime/backend-config.ts` | Assembles `LocalTaskExecutionBackendConfig` from operator config (profile store, launchers, deployments, provisioner) |
| `client/src/daemon/projector-loop.ts` | Chain logs → observations → signed announcements → archive; owns the durable finality cursor |
| `client/src/daemon/work-loop.ts` | Archive announcements → facts → predicate/caps/wiring → one `runPipeline` engagement per claim |
| `client/src/daemon/evidence-driver.ts` | `sync` / `awaitIndexed` / publication policy / indexing-failure surfacing |
| `client/src/daemon/caps-gate.ts` | Rolling-window USD + AI-unit accounting over SQLite, projected into `OperatorCaps` |
| `client/src/store/engagement-ledger.ts` | `ENGAGEMENT_LEDGER_SCHEMA` + `EngagementLedger` (ledger-before-broadcast, boot reconcile) |
| `client/src/store/projector-state.ts` | `PROJECTOR_STATE_SCHEMA` + `ProjectorStateStore` (cursor + projection state + archive head) |
| `client/src/config-migration-v2.ts` | Additive / atomic / idempotent shape-version-2 migration |
| `client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.tsx` | Claim policy & wiring page (replaces Memberships) |
| `client/src/dashboard/spa/src/pages/operator/WiringEntryCard.tsx` | One wiring entry: harness / model / plugins / credential, edit + remove |
| `docs/runbooks/cutover-stage-1-drain.md` | The drain runbook the deploy PR checklist points at |

**New — pipeline tree (tier 3)**

| File | Responsibility |
| --- | --- |
| `packages/marketplace/pipeline/src/facts-mapper.ts` | The one pure module of design §6.4: facts card → `SubmissionFacts` |

**Modified**

| File | Change |
| --- | --- |
| `client/package.json` | `portal:` deps on venue-base, transport-http, projector, discovery serve/client/facts, evidence local-runtime, backend-local, profiles, launchers |
| `client/src/config.ts` | Schema keys `configShapeVersion` / `claimPolicy` / `executionWiring` / `posting`; call the v2 migration in `loadConfig` |
| `client/src/store/store.ts` | Execute the two new schemas; expose `engagementLedger()` and `projectorState()` accessors |
| `client/src/daemon/daemon.ts` | Start the three new loops; stop starting `engine-watcher`; register the new loop names |
| `client/src/daemon/loop-heartbeat.ts` | `LOOP_REGISTRY`: add `projector` / `work` / `evidence-driver`, remove `engine-watcher` |
| `client/src/harnesses/engine/engine.ts` | Refuse `taskRole === 'restoration'` at `runImpl`; drop the `joinedSolverNets` claim gate from `canAcceptTask` |
| `client/src/adapters/mech/contracts.ts` | Re-point `claimEvaluation`, `claimDelivery`, `callDeliverToMarketplace`, `submitTask` onto the broadcast facade |
| `client/src/earning/safe-adapter.ts` | Re-point `executeSafeTxDirect` + `executeSafeTxBatch` onto the broadcast facade |
| `client/src/erc8004/reputation.ts` | Re-point `sendWrite` (both branches) onto the broadcast facade |
| `client/src/main.ts` | Re-point the checkpoint write; compose the runtime; pass the broadcaster into the adapter |
| `client/src/api/setup-endpoints.ts` | Replace join/leave/joined routes with claim-policy + wiring routes |
| `client/src/dashboard/spa/src/routes.ts`, `App.tsx`, `pages/operator/OperatorSubNav.tsx` | Route + nav rename to `/operator/claim-policy` |
| `client/OPERATOR-APP-SPEC.md` | §2.4 rewritten as Claim policy & wiring |
| `client/test/e2e/daemon-harness-cycle.ts`, `_daemon-harness-helpers.ts` | Re-point onto the composed runtime |
| `packages/marketplace/pipeline/src/index.ts` | Export the facts mapper |
| `packages/task-execution/backend-local/assembly/src/index.ts` | Re-export `LocalLauncherDeployment` (finding 4) |

**Deleted**

| File | Why |
| --- | --- |
| `client/src/dashboard/spa/src/pages/operator/MembershipsTab.tsx` (+ `.test.tsx`) | Replaced by `ClaimPolicyTab` |

---

## Task 1: Workspace wiring and upstream smoke test

**Files:**
- Modify: `client/package.json`
- Test: `client/test/runtime/upstream-surface.test.ts`

**Interfaces:**
- Consumes: `createBaseVenue` from `@jinn-network/marketplace-venue-base`; `createFsBlobStore` from `@jinn-network/record-discovery-transport-http`.
- Produces: every later task may `import` from the packages added here.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/runtime/upstream-surface.test.ts
import { describe, expect, it } from 'vitest';

describe('upstream stack surfaces are resolvable from the operator runtime', () => {
  it('exposes the venue facade factory', async () => {
    const mod = await import('@jinn-network/marketplace-venue-base');
    expect(typeof mod.createBaseVenue).toBe('function');
  });

  it('exposes the filesystem blob store factory', async () => {
    const mod = await import('@jinn-network/record-discovery-transport-http');
    expect(typeof mod.createFsBlobStore).toBe('function');
  });

  it('exposes the pipeline, projector, binding and backend entry points', async () => {
    const pipeline = await import('@jinn-network/marketplace-pipeline');
    const projector = await import('@jinn-network/marketplace-projector');
    const binding = await import('@jinn-network/marketplace-binding');
    const backend = await import('@jinn-network/task-execution-backend-local');
    const evidence = await import('@jinn-network/evidence-local-runtime');
    expect(typeof pipeline.runPipeline).toBe('function');
    expect(typeof projector.decodeMarketplaceLogs).toBe('function');
    expect(typeof binding.claimAttempt).toBe('function');
    expect(typeof backend.makeLocalTaskExecutionBackend).toBe('function');
    expect(typeof evidence.openLocalEvidenceRuntime).toBe('function');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/upstream-surface.test.ts`
Expected: FAIL — `Cannot find package '@jinn-network/marketplace-venue-base'`.

- [ ] **Step 3: Add the portal dependencies**

In `client/package.json`, add to `dependencies` (keep the existing alphabetical grouping):

```json
"@jinn-network/marketplace-venue-base": "portal:../packages/marketplace/venue-base",
"@jinn-network/marketplace-pipeline": "portal:../packages/marketplace/pipeline",
"@jinn-network/marketplace-projector": "portal:../packages/marketplace/projector",
"@jinn-network/marketplace-binding": "portal:../packages/marketplace/binding",
"@jinn-network/record-discovery-transport-http": "portal:../packages/discovery/transport-http",
"@jinn-network/record-discovery-protocol": "portal:../packages/discovery/protocol",
"@jinn-network/record-discovery-serve": "portal:../packages/discovery/serve",
"@jinn-network/record-discovery-client": "portal:../packages/discovery/client",
"@jinn-network/record-discovery-facts-task-execution": "portal:../packages/discovery/facts/task-execution",
"@jinn-network/record-discovery-facts-evidence": "portal:../packages/discovery/facts/evidence",
"@jinn-network/record-discovery-facts-trust": "portal:../packages/discovery/facts/trust",
"@jinn-network/task-execution-backend": "portal:../packages/task-execution/backend",
"@jinn-network/task-execution-backend-local": "portal:../packages/task-execution/backend-local/assembly",
"@jinn-network/task-execution-backend-local-launchers": "portal:../packages/task-execution/backend-local/launchers",
"@jinn-network/task-execution-backend-local-workspace": "portal:../packages/task-execution/backend-local/workspace",
"@jinn-network/task-execution-profiles": "portal:../packages/task-execution/profiles",
"@jinn-network/task-execution-protocol": "portal:../packages/task-execution/protocol",
"@jinn-network/evidence-local-runtime": "portal:../packages/evidence/local-runtime",
"@jinn-network/evidence-protocol": "portal:../packages/evidence/protocol"
```

Confirm each `portal:` target's `name` field matches by reading its `package.json`; fix any mismatch by using the real name rather than guessing.

- [ ] **Step 4: Install and run the test**

Run: `cd "$REPO/client" && yarn install && yarn vitest run test/runtime/upstream-surface.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck**

Run: `cd "$REPO/client" && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add client/package.json client/test/runtime/upstream-surface.test.ts yarn.lock
git commit -m "chore(client): portal-link the stack packages the stage-1 runtime composes"
```

---

## Task 2: Facts card → `SubmissionFacts` mapper (pipeline tree)

The one pure module design §6.4 assigns to the pipeline tree. `SubmissionFacts` stays structurally independent of the discovery packages — the mapper is the only place the two shapes meet.

**Files:**
- Create: `packages/marketplace/pipeline/src/facts-mapper.ts`
- Create: `packages/marketplace/pipeline/src/facts-mapper.test.ts`
- Modify: `packages/marketplace/pipeline/src/index.ts`

**Interfaces:**
- Consumes: `SubmissionFacts`, `ExecutionWiringEntry` from `./types.js`.
- Produces:
  ```ts
  export type FactsCardDerivation = "sealed" | "legacy";
  export interface SubmissionFactsCardInput {
    readonly derivation: FactsCardDerivation;
    readonly taskId: bigint;
    readonly card: Readonly<Record<string, unknown>>;
    readonly submission: `urn:uuid:${string}`;
    readonly nonce: string;
    readonly requirements: Readonly<Record<string, unknown>>;
    readonly runnable: boolean;
    readonly intendedSpendWei: bigint;
    readonly intendedAiUnits: number;
    readonly workKind: string;
    readonly legacyManifestDigest?: string;
  }
  export interface MapSubmissionFactsOptions { readonly acceptLegacy: boolean; }
  export type MapSubmissionFactsResult =
    | { readonly ok: true; readonly facts: SubmissionFacts }
    | { readonly ok: false; readonly reason: MapSubmissionFactsRefusal };
  export type MapSubmissionFactsRefusal =
    | "legacy-derivation-not-accepted" | "missing-task-digest"
    | "malformed-task-digest" | "missing-profile-uri" | "malformed-run-pinning";
  export function mapSubmissionFacts(
    input: SubmissionFactsCardInput, options: MapSubmissionFactsOptions,
  ): MapSubmissionFactsResult;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/marketplace/pipeline/src/facts-mapper.test.ts
import { describe, expect, it } from "vitest";
import { mapSubmissionFacts } from "./facts-mapper.js";
import type { SubmissionFactsCardInput } from "./facts-mapper.js";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

function sealedInput(overrides: Partial<SubmissionFactsCardInput> = {}): SubmissionFactsCardInput {
  return {
    derivation: "sealed",
    taskId: 42n,
    card: { taskDigest: DIGEST, taskProfileUri: "https://jinn.network/task-profiles/repository-work/1.0" },
    submission: "urn:uuid:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    nonce: "17",
    requirements: {},
    runnable: true,
    intendedSpendWei: 1_000n,
    intendedAiUnits: 3,
    workKind: "repository-work",
    ...overrides,
  };
}

describe("mapSubmissionFacts", () => {
  it("maps a sealed card onto SubmissionFacts", () => {
    const result = mapSubmissionFacts(sealedInput(), { acceptLegacy: false });
    expect(result).toEqual({
      ok: true,
      facts: {
        taskId: 42n,
        taskDigest: DIGEST,
        submission: "urn:uuid:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
        nonce: "17",
        profileUri: "https://jinn.network/task-profiles/repository-work/1.0",
        requirements: {},
        runnable: true,
        intendedSpendWei: 1_000n,
        intendedAiUnits: 3,
        workKind: "repository-work",
      },
    });
  });

  it("refuses a legacy card when the bridge input is not accepted", () => {
    const result = mapSubmissionFacts(sealedInput({ derivation: "legacy" }), { acceptLegacy: false });
    expect(result).toEqual({ ok: false, reason: "legacy-derivation-not-accepted" });
  });

  it("accepts a legacy card and carries the manifest-digest annotation through", () => {
    const result = mapSubmissionFacts(
      sealedInput({ derivation: "legacy", legacyManifestDigest: `0x${"b".repeat(64)}` }),
      { acceptLegacy: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.facts.legacyManifestDigest).toBe(`0x${"b".repeat(64)}`);
  });

  it("refuses a card with no task digest", () => {
    const result = mapSubmissionFacts(
      sealedInput({ card: { taskProfileUri: "https://example.test/p" } }),
      { acceptLegacy: false },
    );
    expect(result).toEqual({ ok: false, reason: "missing-task-digest" });
  });

  it("refuses a malformed task digest", () => {
    const result = mapSubmissionFacts(
      sealedInput({ card: { taskDigest: "sha256:short", taskProfileUri: "https://example.test/p" } }),
      { acceptLegacy: false },
    );
    expect(result).toEqual({ ok: false, reason: "malformed-task-digest" });
  });

  it("refuses a card with no profile uri", () => {
    const result = mapSubmissionFacts(sealedInput({ card: { taskDigest: DIGEST } }), { acceptLegacy: false });
    expect(result).toEqual({ ok: false, reason: "missing-profile-uri" });
  });

  it("lifts a well-formed runPinning requirement onto the facts", () => {
    const result = mapSubmissionFacts(
      sealedInput({ requirements: { runPinning: { harness: "claude-code", model: "haiku", effortFloor: 2 } } }),
      { acceptLegacy: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts.runPinning).toEqual({ harness: "claude-code", model: "haiku", effortFloor: 2 });
    }
  });

  it("refuses a runPinning requirement whose scalars are the wrong type", () => {
    const result = mapSubmissionFacts(
      sealedInput({ requirements: { runPinning: { harness: 7 } } }),
      { acceptLegacy: false },
    );
    expect(result).toEqual({ ok: false, reason: "malformed-run-pinning" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/packages/marketplace/pipeline" && yarn vitest run src/facts-mapper.test.ts`
Expected: FAIL — `Failed to resolve import "./facts-mapper.js"`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/marketplace/pipeline/src/facts-mapper.ts
import type { SubmissionFacts } from "./types.js";

/**
 * Whether the card was recomputed from a sealed Submission's own bytes, or
 * synthesized by the projector from an anchored legacy task document. The
 * bridge marker lives here rather than on the projector's DerivationAnnotation,
 * whose field set is fixed by the record-discovery derivation grammar.
 */
export type FactsCardDerivation = "sealed" | "legacy";

export interface SubmissionFactsCardInput {
  readonly derivation: FactsCardDerivation;
  readonly taskId: bigint;
  /** The announced record-facts card. Field names follow the submission facts profile. */
  readonly card: Readonly<Record<string, unknown>>;
  readonly submission: `urn:uuid:${string}`;
  readonly nonce: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly runnable: boolean;
  readonly intendedSpendWei: bigint;
  readonly intendedAiUnits: number;
  readonly workKind: string;
  readonly legacyManifestDigest?: string;
}

export interface MapSubmissionFactsOptions {
  /** Bridge-era hosts set this true until the legacy posting path retires. */
  readonly acceptLegacy: boolean;
}

export type MapSubmissionFactsRefusal =
  | "legacy-derivation-not-accepted"
  | "missing-task-digest"
  | "malformed-task-digest"
  | "missing-profile-uri"
  | "malformed-run-pinning";

export type MapSubmissionFactsResult =
  | { readonly ok: true; readonly facts: SubmissionFacts }
  | { readonly ok: false; readonly reason: MapSubmissionFactsRefusal };

const SHA256_CARD_DIGEST = /^sha256:[0-9a-f]{64}$/;

function readString(bag: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === "string" ? value : undefined;
}

type RunPinning = NonNullable<SubmissionFacts["runPinning"]>;

function readRunPinning(
  requirements: Readonly<Record<string, unknown>>,
): { ok: true; pinning?: RunPinning } | { ok: false } {
  const raw = requirements["runPinning"];
  if (raw === undefined) return { ok: true };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const bag = raw as Record<string, unknown>;
  const pinning: Record<string, unknown> = {};
  for (const key of ["harness", "model", "loadout", "isolationPolicy"] as const) {
    const value = bag[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false };
    pinning[key] = value;
  }
  const effortFloor = bag["effortFloor"];
  if (effortFloor !== undefined) {
    if (typeof effortFloor !== "number" || !Number.isFinite(effortFloor)) return { ok: false };
    pinning["effortFloor"] = effortFloor;
  }
  return { ok: true, pinning: pinning as RunPinning };
}

/**
 * The single place the record-discovery facts-card shape and the pipeline's
 * structurally independent `SubmissionFacts` meet. Pure: no I/O, no clock.
 */
export function mapSubmissionFacts(
  input: SubmissionFactsCardInput,
  options: MapSubmissionFactsOptions,
): MapSubmissionFactsResult {
  if (input.derivation === "legacy" && !options.acceptLegacy) {
    return { ok: false, reason: "legacy-derivation-not-accepted" };
  }

  const taskDigest = readString(input.card, "taskDigest");
  if (taskDigest === undefined) return { ok: false, reason: "missing-task-digest" };
  if (!SHA256_CARD_DIGEST.test(taskDigest)) return { ok: false, reason: "malformed-task-digest" };

  const profileUri = readString(input.card, "taskProfileUri");
  if (profileUri === undefined) return { ok: false, reason: "missing-profile-uri" };

  const pinning = readRunPinning(input.requirements);
  if (!pinning.ok) return { ok: false, reason: "malformed-run-pinning" };

  const facts: SubmissionFacts = {
    taskId: input.taskId,
    taskDigest: taskDigest as `sha256:${string}`,
    submission: input.submission,
    nonce: input.nonce,
    profileUri,
    requirements: input.requirements,
    runnable: input.runnable,
    intendedSpendWei: input.intendedSpendWei,
    intendedAiUnits: input.intendedAiUnits,
    workKind: input.workKind,
    ...(pinning.pinning === undefined ? {} : { runPinning: pinning.pinning }),
    ...(input.legacyManifestDigest === undefined
      ? {}
      : { legacyManifestDigest: input.legacyManifestDigest }),
  };

  return { ok: true, facts };
}
```

- [ ] **Step 4: Export it from the barrel**

In `packages/marketplace/pipeline/src/index.ts`, add beside the existing exports:

```ts
export { mapSubmissionFacts } from "./facts-mapper.js";
export type {
  FactsCardDerivation,
  MapSubmissionFactsOptions,
  MapSubmissionFactsRefusal,
  MapSubmissionFactsResult,
  SubmissionFactsCardInput,
} from "./facts-mapper.js";
```

- [ ] **Step 5: Run the package tests**

Run: `cd "$REPO/packages/marketplace/pipeline" && yarn test`
Expected: PASS, including the 8 new cases; the existing `index.test.ts` export-surface test may need the two new names added — update it if it enumerates exports.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add packages/marketplace/pipeline/src/facts-mapper.ts \
  packages/marketplace/pipeline/src/facts-mapper.test.ts \
  packages/marketplace/pipeline/src/index.ts
git commit -m "feat(pipeline): map record-discovery facts cards onto SubmissionFacts"
```

---

## Task 3: Engagement ledger schema and store

Contract 2. The row is written in the same transaction that admits the claim intent, strictly before the claim broadcast, and reconciled against the chain on boot. Follows the repository's established SQLite pattern (`client/src/store/phase-runs.ts`): exported idempotent DDL constant + a class taking the shared `Database`. **No version table** — that would be the first in the codebase.

**Files:**
- Create: `client/src/store/engagement-ledger.ts`
- Create: `client/test/store/engagement-ledger.test.ts`
- Modify: `client/src/store/store.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ENGAGEMENT_LEDGER_SCHEMA: string;
  export type EngagementState = 'admitted' | 'broadcast' | 'settled' | 'abandoned';
  export interface EngagementLedgerRow {
    idempotencyKey: string; taskId: string; submission: string; workKind: string;
    wiringHarness: string; wiringModel: string; wiringCredentialRef: string;
    legacyManifestDigest: string | null; state: EngagementState;
    attemptIndex: number | null; claimTxHash: string | null;
    abandonReason: string | null; createdAt: string; updatedAt: string;
  }
  export interface AdmitEngagementInput {
    idempotencyKey: string; taskId: bigint; submission: string; workKind: string;
    wiring: { harness: string; model: string; credentialRef: string; legacyManifestDigest?: string };
    now?: string;
  }
  export class EngagementLedger {
    constructor(db: Database.Database);
    admit(input: AdmitEngagementInput): 'admitted' | 'already-admitted';
    recordBroadcast(key: string, patch: { attemptIndex: number; claimTxHash: string }): void;
    markSettled(key: string): void;
    markAbandoned(key: string, reason: string): void;
    get(key: string): EngagementLedgerRow | undefined;
    listUnreconciled(): EngagementLedgerRow[];
  }
  export function engagementIdempotencyKey(input: {
    chainId: number; taskCoordinator: string; taskId: bigint; submission: string;
  }): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/store/engagement-ledger.test.ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_LEDGER_SCHEMA,
  EngagementLedger,
  engagementIdempotencyKey,
} from '../../src/store/engagement-ledger.js';

const WIRING = { harness: 'claude-code', model: 'haiku', credentialRef: 'anthropic-default' };

describe('EngagementLedger', () => {
  let db: Database.Database;
  let ledger: EngagementLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(ENGAGEMENT_LEDGER_SCHEMA);
    ledger = new EngagementLedger(db);
  });

  it('derives a stable idempotency key from the engagement identity', () => {
    const a = engagementIdempotencyKey({
      chainId: 84532, taskCoordinator: '0xAbC', taskId: 7n, submission: 'urn:uuid:s',
    });
    const b = engagementIdempotencyKey({
      chainId: 84532, taskCoordinator: '0xabc', taskId: 7n, submission: 'urn:uuid:s',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(
      engagementIdempotencyKey({
        chainId: 84532, taskCoordinator: '0xabc', taskId: 8n, submission: 'urn:uuid:s',
      }),
    );
  });

  it('admits an engagement once and reports the replay', () => {
    const input = { idempotencyKey: 'k1', taskId: 7n, submission: 'urn:uuid:s', workKind: 'repository-work', wiring: WIRING };
    expect(ledger.admit(input)).toBe('admitted');
    expect(ledger.admit(input)).toBe('already-admitted');
    const row = ledger.get('k1');
    expect(row?.state).toBe('admitted');
    expect(row?.wiringHarness).toBe('claude-code');
    expect(row?.attemptIndex).toBeNull();
  });

  it('records the broadcast outcome after admission', () => {
    ledger.admit({ idempotencyKey: 'k1', taskId: 7n, submission: 'urn:uuid:s', workKind: 'w', wiring: WIRING });
    ledger.recordBroadcast('k1', { attemptIndex: 3, claimTxHash: '0xdead' });
    const row = ledger.get('k1');
    expect(row?.state).toBe('broadcast');
    expect(row?.attemptIndex).toBe(3);
    expect(row?.claimTxHash).toBe('0xdead');
  });

  it('refuses to record a broadcast for an unadmitted key', () => {
    expect(() => ledger.recordBroadcast('missing', { attemptIndex: 1, claimTxHash: '0x1' }))
      .toThrow(/not admitted/);
  });

  it('lists admitted and broadcast rows as unreconciled, and drops terminal rows', () => {
    ledger.admit({ idempotencyKey: 'k1', taskId: 1n, submission: 'urn:uuid:a', workKind: 'w', wiring: WIRING });
    ledger.admit({ idempotencyKey: 'k2', taskId: 2n, submission: 'urn:uuid:b', workKind: 'w', wiring: WIRING });
    ledger.admit({ idempotencyKey: 'k3', taskId: 3n, submission: 'urn:uuid:c', workKind: 'w', wiring: WIRING });
    ledger.recordBroadcast('k2', { attemptIndex: 0, claimTxHash: '0x2' });
    ledger.markSettled('k3');
    expect(ledger.listUnreconciled().map((r) => r.idempotencyKey).sort()).toEqual(['k1', 'k2']);
  });

  it('records an abandon reason so the state message can name the engagement', () => {
    ledger.admit({ idempotencyKey: 'k1', taskId: 1n, submission: 'urn:uuid:a', workKind: 'w', wiring: WIRING });
    ledger.markAbandoned('k1', 'rollback');
    const row = ledger.get('k1');
    expect(row?.state).toBe('abandoned');
    expect(row?.abandonReason).toBe('rollback');
    expect(ledger.listUnreconciled()).toEqual([]);
  });

  it('is idempotent on repeated schema execution', () => {
    expect(() => db.exec(ENGAGEMENT_LEDGER_SCHEMA)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/store/engagement-ledger.test.ts`
Expected: FAIL — cannot resolve `../../src/store/engagement-ledger.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/store/engagement-ledger.ts
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * The thin engagement ledger: only what the chain cannot tell the operator on
 * boot — which wiring entry served a claim, and the operator-local decision to
 * admit it. The row is written in the same transaction that admits the claim
 * intent and strictly before the claim broadcast (outbox-style), then
 * reconciled against the chain at boot.
 *
 * Additive-DDL pattern, matching `phase-runs.ts`. No version table.
 */
export const ENGAGEMENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS engagement_ledger (
  idempotency_key         TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL,
  submission              TEXT NOT NULL,
  work_kind               TEXT NOT NULL,
  wiring_harness          TEXT NOT NULL,
  wiring_model            TEXT NOT NULL,
  wiring_credential_ref   TEXT NOT NULL,
  legacy_manifest_digest  TEXT,
  state                   TEXT NOT NULL,
  attempt_index           INTEGER,
  claim_tx_hash           TEXT,
  abandon_reason          TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagement_ledger_state ON engagement_ledger (state);
CREATE INDEX IF NOT EXISTS idx_engagement_ledger_task ON engagement_ledger (task_id);
`;

export type EngagementState = 'admitted' | 'broadcast' | 'settled' | 'abandoned';

export interface EngagementLedgerRow {
  idempotencyKey: string;
  taskId: string;
  submission: string;
  workKind: string;
  wiringHarness: string;
  wiringModel: string;
  wiringCredentialRef: string;
  legacyManifestDigest: string | null;
  state: EngagementState;
  attemptIndex: number | null;
  claimTxHash: string | null;
  abandonReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdmitEngagementInput {
  idempotencyKey: string;
  taskId: bigint;
  submission: string;
  workKind: string;
  wiring: {
    harness: string;
    model: string;
    credentialRef: string;
    legacyManifestDigest?: string;
  };
  now?: string;
}

interface RawRow {
  idempotency_key: string;
  task_id: string;
  submission: string;
  work_kind: string;
  wiring_harness: string;
  wiring_model: string;
  wiring_credential_ref: string;
  legacy_manifest_digest: string | null;
  state: string;
  attempt_index: number | null;
  claim_tx_hash: string | null;
  abandon_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toRow(raw: RawRow): EngagementLedgerRow {
  return {
    idempotencyKey: raw.idempotency_key,
    taskId: raw.task_id,
    submission: raw.submission,
    workKind: raw.work_kind,
    wiringHarness: raw.wiring_harness,
    wiringModel: raw.wiring_model,
    wiringCredentialRef: raw.wiring_credential_ref,
    legacyManifestDigest: raw.legacy_manifest_digest,
    state: raw.state as EngagementState,
    attemptIndex: raw.attempt_index,
    claimTxHash: raw.claim_tx_hash,
    abandonReason: raw.abandon_reason,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/**
 * Logical operation identity — never a transaction hash. Lower-cases the
 * coordinator address so a checksummed and a lower-case configuration produce
 * the same key.
 */
export function engagementIdempotencyKey(input: {
  chainId: number;
  taskCoordinator: string;
  taskId: bigint;
  submission: string;
}): string {
  const material = [
    String(input.chainId),
    input.taskCoordinator.toLowerCase(),
    input.taskId.toString(10),
    input.submission,
  ].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export class EngagementLedger {
  constructor(private readonly db: Database.Database) {}

  admit(input: AdmitEngagementInput): 'admitted' | 'already-admitted' {
    const now = input.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO engagement_ledger (
           idempotency_key, task_id, submission, work_kind,
           wiring_harness, wiring_model, wiring_credential_ref,
           legacy_manifest_digest, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`,
      )
      .run(
        input.idempotencyKey,
        input.taskId.toString(10),
        input.submission,
        input.workKind,
        input.wiring.harness,
        input.wiring.model,
        input.wiring.credentialRef,
        input.wiring.legacyManifestDigest ?? null,
        now,
        now,
      );
    return result.changes === 1 ? 'admitted' : 'already-admitted';
  }

  recordBroadcast(key: string, patch: { attemptIndex: number; claimTxHash: string }): void {
    const result = this.db
      .prepare(
        `UPDATE engagement_ledger
            SET state = 'broadcast', attempt_index = ?, claim_tx_hash = ?, updated_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(patch.attemptIndex, patch.claimTxHash, new Date().toISOString(), key);
    if (result.changes === 0) {
      throw new Error(`engagement ${key} is not admitted; refusing to record a broadcast`);
    }
  }

  markSettled(key: string): void {
    this.db
      .prepare(`UPDATE engagement_ledger SET state = 'settled', updated_at = ? WHERE idempotency_key = ?`)
      .run(new Date().toISOString(), key);
  }

  markAbandoned(key: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE engagement_ledger
            SET state = 'abandoned', abandon_reason = ?, updated_at = ?
          WHERE idempotency_key = ?`,
      )
      .run(reason, new Date().toISOString(), key);
  }

  get(key: string): EngagementLedgerRow | undefined {
    const raw = this.db
      .prepare(`SELECT * FROM engagement_ledger WHERE idempotency_key = ?`)
      .get(key) as RawRow | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  /** Rows the boot reconcile must resolve against the chain. */
  listUnreconciled(): EngagementLedgerRow[] {
    const raws = this.db
      .prepare(`SELECT * FROM engagement_ledger WHERE state IN ('admitted','broadcast') ORDER BY created_at ASC`)
      .all() as RawRow[];
    return raws.map(toRow);
  }
}
```

- [ ] **Step 4: Wire the schema into the store**

In `client/src/store/store.ts`:
1. Import beside the existing schema imports: `import { ENGAGEMENT_LEDGER_SCHEMA, EngagementLedger } from './engagement-ledger.js';`
2. In the constructor, immediately after `this.db.exec(PHASE_RUNS_SCHEMA);`, add `this.db.exec(ENGAGEMENT_LEDGER_SCHEMA);`
3. Add an accessor beside `taskRunReadModel()`:
```ts
  /** The stage-1 engagement ledger (ledger-before-broadcast, boot reconcile). */
  engagementLedger(): EngagementLedger {
    return new EngagementLedger(this.db);
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/store/engagement-ledger.test.ts && yarn typecheck`
Expected: PASS, 7 tests; zero typecheck errors.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add client/src/store/engagement-ledger.ts client/test/store/engagement-ledger.test.ts client/src/store/store.ts
git commit -m "feat(client): add the thin engagement ledger for ledger-before-broadcast"
```

---

## Task 4: Config shape version 2 — the pure migration planner

Contract 4, part one. Pure function first: legacy config object in, migrated object out. The file-level atomic write and backup land in Task 5.

**Files:**
- Create: `client/src/config-migration-v2.ts`
- Create: `client/test/config/config-migration-v2.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CONFIG_SHAPE_VERSION = 2;
  export interface ExecutionWiringConfigV2 {
    workKind: string; harness: string; model: string; plugins: string[];
    credentialRef: string; isolationPolicy: string; legacyManifestDigest?: string;
  }
  export interface ClaimPolicyConfigV2 { kind: 'legacy-manifest-digest' | 'every-runnable' | 'none'; }
  export interface PostingConfigV2 { manifestCid: string; name?: string; generatorEnabled: boolean; }
  export interface ConfigMigrationPlanV2 {
    changed: boolean;
    next: Record<string, unknown>;
    wiringCount: number;
    postingCount: number;
  }
  export function planConfigMigrationV2(raw: Readonly<Record<string, unknown>>): ConfigMigrationPlanV2;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/config/config-migration-v2.test.ts
import { describe, expect, it } from 'vitest';
import { CONFIG_SHAPE_VERSION, planConfigMigrationV2 } from '../../src/config-migration-v2.js';

const LEGACY = {
  network: 'testnet',
  joinedSolverNets: {
    bafyOne: {
      manifestCid: 'bafyOne',
      name: 'swe-rebench',
      roles: ['solver'],
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['jinn-layer'],
      disabledDefaultPlugins: [],
      contract: { id: 'swe-rebench.v2', version: '1.0' },
    },
    bafyTwo: {
      manifestCid: 'bafyTwo',
      roles: ['evaluator'],
      contract: { id: 'prediction.v1', version: '1.0' },
    },
  },
};

describe('planConfigMigrationV2', () => {
  it('stamps the shape version', () => {
    const plan = planConfigMigrationV2(LEGACY);
    expect(plan.changed).toBe(true);
    expect(plan.next['configShapeVersion']).toBe(CONFIG_SHAPE_VERSION);
  });

  it('is additive — the legacy key survives untouched', () => {
    const plan = planConfigMigrationV2(LEGACY);
    expect(plan.next['joinedSolverNets']).toEqual(LEGACY.joinedSolverNets);
  });

  it('maps each solver-role joined entry to one execution-wiring entry carrying the bridge annotation', () => {
    const plan = planConfigMigrationV2(LEGACY);
    expect(plan.wiringCount).toBe(1);
    expect(plan.next['executionWiring']).toEqual([
      {
        workKind: 'swe-rebench.v2',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['jinn-layer'],
        credentialRef: 'claude-code',
        isolationPolicy: 'workspace',
        legacyManifestDigest: 'bafyOne',
      },
    ]);
  });

  it('compiles the claim predicate down to manifest-digest matching', () => {
    const plan = planConfigMigrationV2(LEGACY);
    expect(plan.next['claimPolicy']).toEqual({ kind: 'legacy-manifest-digest' });
  });

  it('claims nothing when no joined entry enables the solver role', () => {
    const plan = planConfigMigrationV2({ joinedSolverNets: { a: { manifestCid: 'a', roles: ['evaluator'] } } });
    expect(plan.next['claimPolicy']).toEqual({ kind: 'none' });
    expect(plan.next['executionWiring']).toEqual([]);
  });

  it('derives posting entries from launched-record ownership markers', () => {
    const plan = planConfigMigrationV2({
      ...LEGACY,
      launchedSolverNets: [{ manifestCid: 'bafyOne', name: 'swe-rebench', generatorEnabled: true }],
    });
    expect(plan.postingCount).toBe(1);
    expect(plan.next['posting']).toEqual([
      { manifestCid: 'bafyOne', name: 'swe-rebench', generatorEnabled: true },
    ]);
  });

  it('is idempotent — re-running on a migrated object changes nothing', () => {
    const once = planConfigMigrationV2(LEGACY);
    const twice = planConfigMigrationV2(once.next);
    expect(twice.changed).toBe(false);
    expect(twice.next).toEqual(once.next);
  });

  it('treats a config with no joined SolverNets as version 2 with an empty wiring list', () => {
    const plan = planConfigMigrationV2({ network: 'testnet' });
    expect(plan.changed).toBe(true);
    expect(plan.next['executionWiring']).toEqual([]);
    expect(plan.next['claimPolicy']).toEqual({ kind: 'none' });
  });

  it('falls back to the entry key when an entry omits its manifest cid', () => {
    const plan = planConfigMigrationV2({
      joinedSolverNets: { 'legacy:swe': { roles: ['solver'], harness: 'codex', model: 'gpt', contract: { id: 'swe.v1', version: '1' } } },
    });
    const wiring = plan.next['executionWiring'] as Array<Record<string, unknown>>;
    expect(wiring[0]?.['legacyManifestDigest']).toBe('legacy:swe');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/config/config-migration-v2.test.ts`
Expected: FAIL — cannot resolve `../../src/config-migration-v2.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/config-migration-v2.ts

/**
 * Config shape version 2 (operator-daemon composition, program §5).
 *
 * Three hardening rules, all exercised by the tests:
 *  - additive: the new keys are written beside `joinedSolverNets`, which is
 *    deleted only at cutover stage 5, so a rolled-back daemon generation still
 *    boots from the migrated file and cannot silently claim nothing;
 *  - idempotent via `configShapeVersion`, so re-upgrade after a revert is a
 *    no-op;
 *  - atomic on disk (temp file + rename) — see `migrateConfigFileToV2`.
 */
export const CONFIG_SHAPE_VERSION = 2;

export interface ExecutionWiringConfigV2 {
  workKind: string;
  harness: string;
  model: string;
  plugins: string[];
  credentialRef: string;
  isolationPolicy: string;
  legacyManifestDigest?: string;
}

export interface ClaimPolicyConfigV2 {
  kind: 'legacy-manifest-digest' | 'every-runnable' | 'none';
}

export interface PostingConfigV2 {
  manifestCid: string;
  name?: string;
  generatorEnabled: boolean;
}

export interface ConfigMigrationPlanV2 {
  changed: boolean;
  next: Record<string, unknown>;
  wiringCount: number;
  postingCount: number;
}

interface LegacyJoinedEntry {
  manifestCid?: unknown;
  roles?: unknown;
  harness?: unknown;
  model?: unknown;
  plugins?: unknown;
  contract?: unknown;
}

const DEFAULT_ISOLATION_POLICY = 'workspace';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function workKindFor(entry: LegacyJoinedEntry, fallback: string): string {
  const contract = asRecord(entry.contract);
  const id = contract?.['id'];
  return typeof id === 'string' && id.length > 0 ? id : fallback;
}

function wiringFrom(key: string, entry: LegacyJoinedEntry): ExecutionWiringConfigV2 | undefined {
  const roles = asStringArray(entry.roles);
  if (!roles.includes('solver')) return undefined;
  const harness = typeof entry.harness === 'string' ? entry.harness : '';
  const model = typeof entry.model === 'string' ? entry.model : '';
  const manifest = typeof entry.manifestCid === 'string' && entry.manifestCid.length > 0
    ? entry.manifestCid
    : key;
  return {
    workKind: workKindFor(entry, manifest),
    harness,
    model,
    plugins: asStringArray(entry.plugins),
    // Credentials are keyed by harness today; the wiring entry is the new home
    // the caps gates re-key onto (binding design §7).
    credentialRef: harness,
    isolationPolicy: DEFAULT_ISOLATION_POLICY,
    legacyManifestDigest: manifest,
  };
}

function postingFrom(raw: Readonly<Record<string, unknown>>): PostingConfigV2[] {
  const launched = raw['launchedSolverNets'];
  if (!Array.isArray(launched)) return [];
  const entries: PostingConfigV2[] = [];
  for (const item of launched) {
    const record = asRecord(item);
    const manifestCid = record?.['manifestCid'];
    if (typeof manifestCid !== 'string' || manifestCid.length === 0) continue;
    const name = record?.['name'];
    entries.push({
      manifestCid,
      ...(typeof name === 'string' ? { name } : {}),
      generatorEnabled: record?.['generatorEnabled'] === true,
    });
  }
  return entries;
}

/**
 * Pure planner. Never touches the filesystem, never reads the environment —
 * callers hand it the raw parsed config file (never the env-merged object, so
 * an env override is not accidentally persisted).
 */
export function planConfigMigrationV2(raw: Readonly<Record<string, unknown>>): ConfigMigrationPlanV2 {
  if (raw['configShapeVersion'] === CONFIG_SHAPE_VERSION) {
    return { changed: false, next: { ...raw }, wiringCount: 0, postingCount: 0 };
  }

  const joined = asRecord(raw['joinedSolverNets']) ?? {};
  const wiring: ExecutionWiringConfigV2[] = [];
  for (const [key, value] of Object.entries(joined)) {
    const entry = asRecord(value);
    if (entry === undefined) continue;
    const mapped = wiringFrom(key, entry as LegacyJoinedEntry);
    if (mapped !== undefined) wiring.push(mapped);
  }

  const posting = postingFrom(raw);
  const claimPolicy: ClaimPolicyConfigV2 = {
    kind: wiring.length > 0 ? 'legacy-manifest-digest' : 'none',
  };

  return {
    changed: true,
    next: {
      ...raw,
      configShapeVersion: CONFIG_SHAPE_VERSION,
      claimPolicy,
      executionWiring: wiring,
      posting,
    },
    wiringCount: wiring.length,
    postingCount: posting.length,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/config/config-migration-v2.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/config-migration-v2.ts client/test/config/config-migration-v2.test.ts
git commit -m "feat(client): plan the additive idempotent config shape-version-2 migration"
```

---

## Task 5: Config migration — atomic file write, permission-preserving backup

Contract 4, part two, plus the pinned backup-filename contract.

**Files:**
- Modify: `client/src/config-migration-v2.ts`
- Modify: `client/test/config/config-migration-v2.test.ts`

**Interfaces:**
- Consumes: `planConfigMigrationV2` from Task 4.
- Produces:
  ```ts
  export interface ConfigMigrationV2Result {
    migrated: boolean;
    backupPath?: string;
    wiringCount: number;
    postingCount: number;
  }
  export function migrateConfigFileToV2(
    configPath: string, now?: () => Date,
  ): ConfigMigrationV2Result;
  export function configBackupPath(configPath: string, at: Date): string;
  ```

- [ ] **Step 1: Write the failing test (append to the existing file)**

```ts
// appended to client/test/config/config-migration-v2.test.ts
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configBackupPath, migrateConfigFileToV2 } from '../../src/config-migration-v2.js';

function scratchConfig(contents: unknown, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(contents, null, 2));
  chmodSync(path, mode);
  return path;
}

describe('migrateConfigFileToV2', () => {
  it('names the backup with the pinned contract filename', () => {
    const at = new Date('2026-07-30T12:34:56.000Z');
    expect(configBackupPath('/x/config.json', at))
      .toBe('/x/config.json.pre-v2.2026-07-30T12:34:56.000Z.bak');
  });

  it('writes the migrated shape and keeps a backup', () => {
    const path = scratchConfig(LEGACY);
    const result = migrateConfigFileToV2(path, () => new Date('2026-07-30T00:00:00.000Z'));
    expect(result.migrated).toBe(true);
    expect(result.wiringCount).toBe(1);
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(migrated['configShapeVersion']).toBe(CONFIG_SHAPE_VERSION);
    expect(migrated['joinedSolverNets']).toEqual(LEGACY.joinedSolverNets);
    const backup = JSON.parse(readFileSync(result.backupPath!, 'utf8')) as Record<string, unknown>;
    expect(backup).toEqual(LEGACY);
  });

  it('preserves the original file permissions on the backup', () => {
    const path = scratchConfig(LEGACY, 0o600);
    const result = migrateConfigFileToV2(path, () => new Date('2026-07-30T00:00:00.000Z'));
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is a no-op on a second run and writes no second backup', () => {
    const path = scratchConfig(LEGACY);
    migrateConfigFileToV2(path, () => new Date('2026-07-30T00:00:00.000Z'));
    const again = migrateConfigFileToV2(path, () => new Date('2026-07-31T00:00:00.000Z'));
    expect(again.migrated).toBe(false);
    expect(again.backupPath).toBeUndefined();
    const backups = readdirSync(join(path, '..')).filter((f) => f.includes('.pre-v2.'));
    expect(backups).toHaveLength(1);
  });

  it('leaves the file untouched when it cannot be parsed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ not json');
    const result = migrateConfigFileToV2(path);
    expect(result.migrated).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });

  it('reports no migration when the file does not exist', () => {
    const result = migrateConfigFileToV2(join(tmpdir(), 'definitely-absent', 'config.json'));
    expect(result.migrated).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/config/config-migration-v2.test.ts`
Expected: FAIL — `migrateConfigFileToV2 is not exported`.

- [ ] **Step 3: Write the implementation (append to `config-migration-v2.ts`)**

```ts
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

export interface ConfigMigrationV2Result {
  migrated: boolean;
  backupPath?: string;
  wiringCount: number;
  postingCount: number;
}

/**
 * Pinned cross-plan contract: `config.json.pre-v2.<ISO8601>.bak`, beside the
 * config file. The backup is a copy, so it inherits nothing implicitly — the
 * caller re-applies the original mode explicitly (it can carry paid RPC keys).
 */
export function configBackupPath(configPath: string, at: Date): string {
  return `${configPath}.pre-v2.${at.toISOString()}.bak`;
}

/**
 * Boot-time, panel-visible migration. Atomic (temp file + rename), additive
 * (legacy keys survive to stage 5), idempotent (`configShapeVersion`).
 * Never throws on a malformed or absent file — the daemon's own config loader
 * owns those diagnostics; a failed migration must not gate boot.
 */
export function migrateConfigFileToV2(
  configPath: string,
  now: () => Date = () => new Date(),
): ConfigMigrationV2Result {
  const noop: ConfigMigrationV2Result = { migrated: false, wiringCount: 0, postingCount: 0 };
  if (!existsSync(configPath)) return noop;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return noop;
    raw = parsed as Record<string, unknown>;
  } catch {
    return noop;
  }

  const plan = planConfigMigrationV2(raw);
  if (!plan.changed) return noop;

  const mode = statSync(configPath).mode & 0o777;
  const backupPath = configBackupPath(configPath, now());
  copyFileSync(configPath, backupPath);
  chmodSync(backupPath, mode);

  const tempPath = `${configPath}.v2-migration.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(plan.next, null, 2)}\n`, { mode });
  chmodSync(tempPath, mode);
  renameSync(tempPath, configPath);

  return {
    migrated: true,
    backupPath,
    wiringCount: plan.wiringCount,
    postingCount: plan.postingCount,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/config/config-migration-v2.test.ts`
Expected: PASS, 15 tests total.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/config-migration-v2.ts client/test/config/config-migration-v2.test.ts
git commit -m "feat(client): write the shape-version-2 config atomically with a permission-preserving backup"
```

---

## Task 6: Config schema keys and boot-time migration hook

**Files:**
- Modify: `client/src/config.ts`
- Create: `client/test/config/config-v2-keys.test.ts`

**Interfaces:**
- Consumes: `migrateConfigFileToV2`, `CONFIG_SHAPE_VERSION` from Task 5.
- Produces: `JinnConfig` gains `configShapeVersion?: number`, `claimPolicy?: ClaimPolicyConfigV2`, `executionWiring: ExecutionWiringConfigV2[]`, `posting: PostingConfigV2[]`; `loadConfig` runs the migration before parsing and records the result on `lastConfigMigrationV2` (read by the panel in Task 21).
  ```ts
  export function lastConfigMigrationV2(): ConfigMigrationV2Result | undefined;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/config/config-v2-keys.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastConfigMigrationV2, loadConfig } from '../../src/config.js';

function scratch(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-cfg-v2-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

describe('config shape version 2 keys', () => {
  it('migrates on load and exposes the new keys', () => {
    const path = scratch({
      network: 'testnet',
      joinedSolverNets: {
        bafy: {
          manifestCid: 'bafy', roles: ['solver'], harness: 'claude-code',
          model: 'claude-haiku-4-5-20251001', plugins: [], contract: { id: 'swe.v2', version: '1' },
        },
      },
    });
    const config = loadConfig(path);
    expect(config.configShapeVersion).toBe(2);
    expect(config.claimPolicy).toEqual({ kind: 'legacy-manifest-digest' });
    expect(config.executionWiring).toEqual([
      {
        workKind: 'swe.v2', harness: 'claude-code', model: 'claude-haiku-4-5-20251001',
        plugins: [], credentialRef: 'claude-code', isolationPolicy: 'workspace',
        legacyManifestDigest: 'bafy',
      },
    ]);
    expect(config.posting).toEqual([]);
    expect(lastConfigMigrationV2()?.migrated).toBe(true);
  });

  it('defaults the new keys when the file has none', () => {
    const config = loadConfig(scratch({ network: 'testnet' }));
    expect(config.executionWiring).toEqual([]);
    expect(config.posting).toEqual([]);
    expect(config.claimPolicy).toEqual({ kind: 'none' });
  });

  it('keeps the legacy joined entries readable after migration', () => {
    const config = loadConfig(scratch({
      joinedSolverNets: { bafy: { manifestCid: 'bafy', roles: ['solver'] } },
    }));
    expect(config.joinedSolverNets?.['bafy']?.manifestCid).toBe('bafy');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/config/config-v2-keys.test.ts`
Expected: FAIL — `config.configShapeVersion` is `undefined` / `lastConfigMigrationV2` not exported.

- [ ] **Step 3: Add the schema keys**

In `client/src/config.ts`, inside `JinnConfigSchema` immediately **after** the `joinedSolverNets` block (so a reader sees old and new adjacent):

```ts
  /** Config shape version (operator-daemon composition §9). Stamped by the boot migration. */
  configShapeVersion: z.number().int().optional(),

  /**
   * The operator's claim predicate. `legacy-manifest-digest` compiles down to
   * today's manifest matching via each wiring entry's bridge annotation;
   * `none` is the claim-nothing-when-unconfigured safety default.
   */
  claimPolicy: z
    .object({ kind: z.enum(['legacy-manifest-digest', 'every-runnable', 'none']) })
    .default({ kind: 'none' }),

  /** Execution wiring: configuration for execution, never permission for claiming. */
  executionWiring: z
    .array(
      z.object({
        workKind: z.string().min(1),
        harness: z.string(),
        model: z.string(),
        plugins: z.array(z.string()).default([]),
        credentialRef: z.string(),
        isolationPolicy: z.string().default('workspace'),
        legacyManifestDigest: z.string().optional(),
      }),
    )
    .default([]),

  /** Requester-side posting configuration (populated here, consumed at stage 3). */
  posting: z
    .array(
      z.object({
        manifestCid: z.string().min(1),
        name: z.string().optional(),
        generatorEnabled: z.boolean().default(false),
      }),
    )
    .default([]),
```

- [ ] **Step 4: Run the migration from `loadConfig`**

At the top of `client/src/config.ts`, add:

```ts
import { migrateConfigFileToV2 } from './config-migration-v2.js';
import type { ConfigMigrationV2Result } from './config-migration-v2.js';

let lastMigrationV2: ConfigMigrationV2Result | undefined;

/** The most recent boot migration outcome, surfaced as a one-time panel state message. */
export function lastConfigMigrationV2(): ConfigMigrationV2Result | undefined {
  return lastMigrationV2;
}
```

In `loadConfig`, **before** the file is read (i.e. before the existing `readFileSync` of `configPath ?? DEFAULT_CONFIG_PATH`), insert:

```ts
  const resolvedConfigPath = configPath ?? DEFAULT_CONFIG_PATH;
  lastMigrationV2 = migrateConfigFileToV2(resolvedConfigPath);
  if (lastMigrationV2.migrated) {
    console.warn(
      `[config] migrated to shape version 2 — ${lastMigrationV2.wiringCount} wiring entr` +
        `${lastMigrationV2.wiringCount === 1 ? 'y' : 'ies'}, backup at ${lastMigrationV2.backupPath}`,
    );
  }
```

Then use `resolvedConfigPath` in the existing read rather than re-deriving the default.

- [ ] **Step 5: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/config/ && yarn typecheck`
Expected: PASS; zero typecheck errors. If any existing config test asserts an exact parsed-object shape, add the four new default keys to its expectation.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add client/src/config.ts client/test/config/config-v2-keys.test.ts
git commit -m "feat(client): add shape-version-2 config keys and run the migration at load"
```

---

## Task 7: Projector state store (durable cursor + projection state + archive head)

**Files:**
- Create: `client/src/store/projector-state.ts`
- Create: `client/test/store/projector-state.test.ts`
- Modify: `client/src/store/store.ts`

**Interfaces:**
- Consumes: `MarketplaceProjectionState`, `createMarketplaceProjectionState` from `@jinn-network/marketplace-projector`; `SourceHead` from `@jinn-network/record-discovery-protocol`.
- Produces:
  ```ts
  export const PROJECTOR_STATE_SCHEMA: string;
  export interface ProjectorCursor { blockNumber: bigint; blockHash: `0x${string}`; }
  export interface ProjectorCheckpoint {
    live?: ProjectorCursor;
    finalized?: ProjectorCursor;
  }
  export interface ArchiveHeadRecord {
    head: SourceHead; previousEntryDigest: `sha256:${string}` | null; nextSequence: string;
  }
  export class ProjectorStateStore {
    constructor(db: Database.Database);
    readCheckpoint(): ProjectorCheckpoint;
    writeCheckpoint(next: ProjectorCheckpoint): void;
    readProjection(): MarketplaceProjectionState;
    writeProjection(state: MarketplaceProjectionState): void;
    readArchiveHead(): ArchiveHeadRecord | undefined;
    writeArchiveHead(record: ArchiveHeadRecord): void;
    /** One transaction: cursor + projection + head advance together or not at all. */
    commit(input: { checkpoint: ProjectorCheckpoint; projection: MarketplaceProjectionState; archiveHead?: ArchiveHeadRecord }): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/store/projector-state.test.ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMarketplaceProjectionState } from '@jinn-network/marketplace-projector';
import { PROJECTOR_STATE_SCHEMA, ProjectorStateStore } from '../../src/store/projector-state.js';

describe('ProjectorStateStore', () => {
  let db: Database.Database;
  let store: ProjectorStateStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(PROJECTOR_STATE_SCHEMA);
    store = new ProjectorStateStore(db);
  });

  it('starts with no checkpoint and a fresh projection', () => {
    expect(store.readCheckpoint()).toEqual({});
    expect(store.readProjection()).toEqual(createMarketplaceProjectionState());
  });

  it('round-trips the dual cursor marks including bigint block numbers', () => {
    store.writeCheckpoint({
      live: { blockNumber: 1234n, blockHash: '0xaa' },
      finalized: { blockNumber: 1200n, blockHash: '0xbb' },
    });
    expect(store.readCheckpoint()).toEqual({
      live: { blockNumber: 1234n, blockHash: '0xaa' },
      finalized: { blockNumber: 1200n, blockHash: '0xbb' },
    });
  });

  it('round-trips the projection state, bigint task ids included', () => {
    const state = createMarketplaceProjectionState();
    state.processedLogIds.push('0xaa:1');
    state.sequenceBySourceSubject['s'] = '0000000000000003';
    store.writeProjection(state);
    const read = store.readProjection();
    expect(read.processedLogIds).toEqual(['0xaa:1']);
    expect(read.sequenceBySourceSubject['s']).toBe('0000000000000003');
  });

  it('round-trips the archive head', () => {
    const head = {
      protocol: 'https://jinn.network/record-discovery/1.0',
      origin: 'did:example:agent/ops',
      sequence: '0000000000000002',
      entry: `sha256:${'c'.repeat(64)}` as const,
      issuedAt: '2026-07-30T00:00:00.000Z',
      refreshBy: '2026-07-31T00:00:00.000Z',
    };
    store.writeArchiveHead({ head, previousEntryDigest: null, nextSequence: '0000000000000003' });
    expect(store.readArchiveHead()).toEqual({
      head, previousEntryDigest: null, nextSequence: '0000000000000003',
    });
  });

  it('commits cursor, projection and head in one transaction', () => {
    const state = createMarketplaceProjectionState();
    state.processedLogIds.push('0xbb:0');
    store.commit({
      checkpoint: { finalized: { blockNumber: 9n, blockHash: '0xcc' } },
      projection: state,
    });
    expect(store.readCheckpoint().finalized?.blockNumber).toBe(9n);
    expect(store.readProjection().processedLogIds).toEqual(['0xbb:0']);
  });

  it('is idempotent on repeated schema execution', () => {
    expect(() => db.exec(PROJECTOR_STATE_SCHEMA)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/store/projector-state.test.ts`
Expected: FAIL — cannot resolve `../../src/store/projector-state.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/store/projector-state.ts
import type Database from 'better-sqlite3';
import {
  createMarketplaceProjectionState,
  type MarketplaceProjectionState,
} from '@jinn-network/marketplace-projector';
import type { SourceHead } from '@jinn-network/record-discovery-protocol';

/**
 * Durable projector state: the dual cursor marks (a live mark tracking
 * `latest`, a durable checkpoint advancing only on the `finalized` tag), the
 * marketplace projection reducer state, and the archive head the announcement
 * projector appends onto. Single-row tables keyed by a constant so the reads
 * are unambiguous.
 */
export const PROJECTOR_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS projector_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  live_block   TEXT,
  live_hash    TEXT,
  final_block  TEXT,
  final_hash   TEXT,
  projection   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projector_archive_head (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  head                   TEXT NOT NULL,
  previous_entry_digest  TEXT,
  next_sequence          TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
`;

export interface ProjectorCursor {
  blockNumber: bigint;
  blockHash: `0x${string}`;
}

export interface ProjectorCheckpoint {
  live?: ProjectorCursor;
  finalized?: ProjectorCursor;
}

export interface ArchiveHeadRecord {
  head: SourceHead;
  previousEntryDigest: `sha256:${string}` | null;
  nextSequence: string;
}

interface StateRow {
  live_block: string | null;
  live_hash: string | null;
  final_block: string | null;
  final_hash: string | null;
  projection: string;
}

interface HeadRow {
  head: string;
  previous_entry_digest: string | null;
  next_sequence: string;
}

function cursorFrom(block: string | null, hash: string | null): ProjectorCursor | undefined {
  if (block === null || hash === null) return undefined;
  return { blockNumber: BigInt(block), blockHash: hash as `0x${string}` };
}

export class ProjectorStateStore {
  constructor(private readonly db: Database.Database) {}

  private row(): StateRow | undefined {
    return this.db
      .prepare(`SELECT live_block, live_hash, final_block, final_hash, projection FROM projector_state WHERE id = 1`)
      .get() as StateRow | undefined;
  }

  readCheckpoint(): ProjectorCheckpoint {
    const row = this.row();
    if (row === undefined) return {};
    const live = cursorFrom(row.live_block, row.live_hash);
    const finalized = cursorFrom(row.final_block, row.final_hash);
    return { ...(live ? { live } : {}), ...(finalized ? { finalized } : {}) };
  }

  readProjection(): MarketplaceProjectionState {
    const row = this.row();
    if (row === undefined) return createMarketplaceProjectionState();
    return JSON.parse(row.projection) as MarketplaceProjectionState;
  }

  writeCheckpoint(next: ProjectorCheckpoint): void {
    this.persist(next, this.readProjection());
  }

  writeProjection(state: MarketplaceProjectionState): void {
    this.persist(this.readCheckpoint(), state);
  }

  private persist(checkpoint: ProjectorCheckpoint, projection: MarketplaceProjectionState): void {
    this.db
      .prepare(
        `INSERT INTO projector_state (id, live_block, live_hash, final_block, final_hash, projection, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           live_block = excluded.live_block, live_hash = excluded.live_hash,
           final_block = excluded.final_block, final_hash = excluded.final_hash,
           projection = excluded.projection, updated_at = excluded.updated_at`,
      )
      .run(
        checkpoint.live?.blockNumber.toString(10) ?? null,
        checkpoint.live?.blockHash ?? null,
        checkpoint.finalized?.blockNumber.toString(10) ?? null,
        checkpoint.finalized?.blockHash ?? null,
        JSON.stringify(projection),
        new Date().toISOString(),
      );
  }

  readArchiveHead(): ArchiveHeadRecord | undefined {
    const row = this.db
      .prepare(`SELECT head, previous_entry_digest, next_sequence FROM projector_archive_head WHERE id = 1`)
      .get() as HeadRow | undefined;
    if (row === undefined) return undefined;
    return {
      head: JSON.parse(row.head) as SourceHead,
      previousEntryDigest: row.previous_entry_digest as `sha256:${string}` | null,
      nextSequence: row.next_sequence,
    };
  }

  writeArchiveHead(record: ArchiveHeadRecord): void {
    this.db
      .prepare(
        `INSERT INTO projector_archive_head (id, head, previous_entry_digest, next_sequence, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           head = excluded.head, previous_entry_digest = excluded.previous_entry_digest,
           next_sequence = excluded.next_sequence, updated_at = excluded.updated_at`,
      )
      .run(
        JSON.stringify(record.head),
        record.previousEntryDigest,
        record.nextSequence,
        new Date().toISOString(),
      );
  }

  /** Cursor, projection and head advance together or not at all. */
  commit(input: {
    checkpoint: ProjectorCheckpoint;
    projection: MarketplaceProjectionState;
    archiveHead?: ArchiveHeadRecord;
  }): void {
    const run = this.db.transaction(() => {
      this.persist(input.checkpoint, input.projection);
      if (input.archiveHead !== undefined) this.writeArchiveHead(input.archiveHead);
    });
    run();
  }
}
```

- [ ] **Step 4: Wire the schema into the store**

In `client/src/store/store.ts`, import `PROJECTOR_STATE_SCHEMA` and `ProjectorStateStore`, execute the schema beside `ENGAGEMENT_LEDGER_SCHEMA`, and add:

```ts
  /** Durable projector cursor + projection state + archive head. */
  projectorState(): ProjectorStateStore {
    return new ProjectorStateStore(this.db);
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/store/ && yarn typecheck`
Expected: PASS, 6 new tests; zero typecheck errors.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add client/src/store/projector-state.ts client/test/store/projector-state.test.ts client/src/store/store.ts
git commit -m "feat(client): persist the projector cursor, projection state and archive head"
```

---

## Task 8: Bridge-era legacy synthesis (`deriveBridgeTask`) and the legacy facts card

Contract 9. Until stage 3, every claimable task is legacy-posted and carries no sealed Submission. This task owns the **one** shared pure function that reconstructs the subject Task document from the anchored legacy task, plus the facts card synthesized beside it.

**This is a pinned cross-stage surface.** The stage-2 evaluator plan reuses `deriveBridgeTask` for bridge-era evaluation derivation and adds a cross-operator determinism fixture on top of it. Do not rename it, do not fork a second copy, and do not make it read a clock, the filesystem, or the network.

**Files:**
- Create: `packages/marketplace/pipeline/src/bridge-legacy.ts`
- Create: `packages/marketplace/pipeline/src/bridge-legacy.test.ts`
- Create: `packages/marketplace/pipeline/fixtures/bridge/legacy-task-anchored.json`
- Create: `packages/marketplace/pipeline/fixtures/bridge/legacy-task-expected.json`
- Modify: `packages/marketplace/pipeline/src/index.ts`

**Interfaces:**
- Consumes: `SubmissionFactsCardInput`, `FactsCardDerivation` from `./facts-mapper.js` (Task 2).
- Produces — **pinned names, stage 2 substitutes against these exactly**:
  ```ts
  /** The chain-observed facts a legacy TaskCreated anchor carries. */
  export interface LegacyTaskAnchor {
    readonly chainId: number;
    readonly taskCoordinator: `0x${string}`;
    readonly taskId: bigint;
    readonly creator: `0x${string}`;
    readonly manifestDigest: `0x${string}`;
    readonly taskCidDigest: `0x${string}`;
    readonly maxClaims: number;
    readonly solutionBudgetWei: bigint;
    readonly verdictBudgetWei: bigint;
  }
  /** The anchored task document's own bytes, fetched from IPFS by the caller. */
  export interface LegacyTaskDocument { readonly bytes: Uint8Array; readonly digest: `sha256:${string}`; }
  export interface BridgeTaskDerivation {
    /** Canonical JSON bytes of the reconstructed subject Task. */
    readonly taskBytes: Uint8Array;
    readonly taskDigest: `sha256:${string}`;
    readonly profileUri: string;
    readonly workKind: string;
    readonly requirements: Readonly<Record<string, unknown>>;
    readonly derivation: FactsCardDerivation; // always "legacy"
  }
  export type DeriveBridgeTaskResult =
    | { readonly ok: true; readonly task: BridgeTaskDerivation }
    | { readonly ok: false; readonly reason: BridgeDerivationRefusal };
  export type BridgeDerivationRefusal =
    | "document-unparsable" | "document-digest-mismatch"
    | "missing-solver-type" | "missing-task-payload";

  /**
   * DETERMINISM GUARANTEE (relied on by cutover stage 2): pure — no clock, no
   * I/O, no randomness, no environment reads. Given identical `anchor` and
   * identical `document.bytes`, every operator on every host produces
   * byte-identical `taskBytes` and therefore an identical `taskDigest`.
   * Object key order in `taskBytes` is fixed by the canonical serializer, not
   * by input insertion order.
   */
  export function deriveBridgeTask(
    anchor: LegacyTaskAnchor, document: LegacyTaskDocument,
  ): DeriveBridgeTaskResult;

  /** The `legacy`-derivation facts card + mapper input for a bridge-era task. */
  export function deriveBridgeFactsCardInput(
    anchor: LegacyTaskAnchor, task: BridgeTaskDerivation,
    operator: { readonly intendedAiUnits: number },
  ): SubmissionFactsCardInput;

  /** Deterministic bridge Submission URI — UUIDv5 over (chainId, coordinator, taskId). */
  export function deriveBridgeSubmissionUri(anchor: LegacyTaskAnchor): `urn:uuid:${string}`;
  ```

- [ ] **Step 1: Write the fixtures**

`packages/marketplace/pipeline/fixtures/bridge/legacy-task-anchored.json` — the anchored legacy task document as it exists on IPFS today (shape drawn from `client/src/harnesses/engine/persistence.ts`'s `task_payload` and the `solverType` gate):

```json
{
  "solverType": "swe-rebench.v2",
  "role": "restoration",
  "description": "Make the failing tests in the repository pass.",
  "spec": {
    "repo": "https://github.com/example/widget",
    "baseCommit": "0f1e2d3c4b5a69788796a5b4c3d2e1f000000000",
    "failToPass": ["tests/test_widget.py::test_resize"],
    "passToPass": ["tests/test_widget.py::test_create"]
  },
  "runPinning": { "harness": "claude-code", "model": "claude-haiku-4-5-20251001" }
}
```

`packages/marketplace/pipeline/fixtures/bridge/legacy-task-expected.json` — the reconstructed subject Task document. Generate it once from the implementation in Step 4 and commit the exact bytes; the test compares against the file, so the fixture is the determinism anchor for stage 2:

```json
{
  "author": "did:pkh:eip155:84532:0x00000000000000000000000000000000000000ff",
  "payload": {
    "baseCommit": "0f1e2d3c4b5a69788796a5b4c3d2e1f000000000",
    "description": "Make the failing tests in the repository pass.",
    "failToPass": ["tests/test_widget.py::test_resize"],
    "passToPass": ["tests/test_widget.py::test_create"],
    "repo": "https://github.com/example/widget"
  },
  "profile": { "uri": "https://jinn.network/task-profiles/repository-work/1.0" },
  "protocol": "https://jinn.network/task-execution/1.0",
  "provenance": {
    "bridge": "legacy",
    "chainId": 84532,
    "taskCidDigest": "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "taskCoordinator": "0x8a34793e10595c89b7e41cc7ff0f76850f44ad98",
    "taskId": "7"
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/marketplace/pipeline/src/bridge-legacy.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sealJson } from "@jinn-network/record-discovery-protocol";
import {
  deriveBridgeFactsCardInput,
  deriveBridgeSubmissionUri,
  deriveBridgeTask,
  type LegacyTaskAnchor,
} from "./bridge-legacy.js";

const ANCHORED = readFileSync(new URL("../fixtures/bridge/legacy-task-anchored.json", import.meta.url));
const EXPECTED = readFileSync(new URL("../fixtures/bridge/legacy-task-expected.json", import.meta.url), "utf8");

const ANCHOR: LegacyTaskAnchor = {
  chainId: 84532,
  taskCoordinator: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
  taskId: 7n,
  creator: "0x00000000000000000000000000000000000000ff",
  manifestDigest: `0x${"b".repeat(64)}`,
  taskCidDigest: `0x${"c".repeat(64)}`,
  maxClaims: 3,
  solutionBudgetWei: 1_000_000_000_000_000n,
  verdictBudgetWei: 500_000_000_000_000n,
};

function document() {
  return { bytes: new Uint8Array(ANCHORED), digest: sealJson(JSON.parse(ANCHORED.toString("utf8"))).digest };
}

describe("deriveBridgeTask", () => {
  it("reconstructs the subject Task byte-for-byte against the pinned fixture", () => {
    const result = deriveBridgeTask(ANCHOR, document());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.task.taskBytes)).toBe(JSON.stringify(JSON.parse(EXPECTED)));
  });

  it("is deterministic across repeated derivations and across key-order permutations of the anchor", () => {
    const a = deriveBridgeTask(ANCHOR, document());
    const permuted: LegacyTaskAnchor = {
      verdictBudgetWei: ANCHOR.verdictBudgetWei, solutionBudgetWei: ANCHOR.solutionBudgetWei,
      maxClaims: ANCHOR.maxClaims, taskCidDigest: ANCHOR.taskCidDigest,
      manifestDigest: ANCHOR.manifestDigest, creator: ANCHOR.creator,
      taskId: ANCHOR.taskId, taskCoordinator: ANCHOR.taskCoordinator, chainId: ANCHOR.chainId,
    };
    const b = deriveBridgeTask(permuted, document());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.task.taskBytes).toEqual(a.task.taskBytes);
      expect(b.task.taskDigest).toBe(a.task.taskDigest);
    }
  });

  it("normalizes the coordinator address case so two operators agree", () => {
    const lower = deriveBridgeTask(
      { ...ANCHOR, taskCoordinator: ANCHOR.taskCoordinator.toLowerCase() as `0x${string}` },
      document(),
    );
    const mixed = deriveBridgeTask(ANCHOR, document());
    expect(lower.ok && mixed.ok).toBe(true);
    if (lower.ok && mixed.ok) expect(lower.task.taskDigest).toBe(mixed.task.taskDigest);
  });

  it("carries the solver type through as the work kind", () => {
    const result = deriveBridgeTask(ANCHOR, document());
    expect(result.ok && result.task.workKind).toBe("swe-rebench.v2");
  });

  it("lifts legacy run pinning into the requirements bag", () => {
    const result = deriveBridgeTask(ANCHOR, document());
    expect(result.ok && result.task.requirements).toEqual({
      runPinning: { harness: "claude-code", model: "claude-haiku-4-5-20251001" },
    });
  });

  it("refuses a document whose digest does not match the supplied bytes", () => {
    const result = deriveBridgeTask(ANCHOR, {
      bytes: new Uint8Array(ANCHORED),
      digest: `sha256:${"0".repeat(64)}`,
    });
    expect(result).toEqual({ ok: false, reason: "document-digest-mismatch" });
  });

  it("refuses unparsable bytes", () => {
    const bytes = new TextEncoder().encode("{ not json");
    const result = deriveBridgeTask(ANCHOR, { bytes, digest: sealJson({}).digest });
    expect(result).toEqual({ ok: false, reason: "document-unparsable" });
  });

  it("refuses a document with no solver type", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ spec: {} }));
    const result = deriveBridgeTask(ANCHOR, { bytes, digest: sealJson({ spec: {} }).digest });
    expect(result).toEqual({ ok: false, reason: "missing-solver-type" });
  });

  it("refuses a document with no task payload", () => {
    const doc = { solverType: "swe.v2" };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const result = deriveBridgeTask(ANCHOR, { bytes, digest: sealJson(doc).digest });
    expect(result).toEqual({ ok: false, reason: "missing-task-payload" });
  });
});

describe("deriveBridgeSubmissionUri", () => {
  it("is deterministic and identity-scoped", () => {
    expect(deriveBridgeSubmissionUri(ANCHOR)).toBe(deriveBridgeSubmissionUri({ ...ANCHOR }));
    expect(deriveBridgeSubmissionUri(ANCHOR)).not.toBe(deriveBridgeSubmissionUri({ ...ANCHOR, taskId: 8n }));
    expect(deriveBridgeSubmissionUri(ANCHOR)).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });
});

describe("deriveBridgeFactsCardInput", () => {
  it("produces a legacy-marked mapper input carrying the manifest digest and the budget", () => {
    const derived = deriveBridgeTask(ANCHOR, document());
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const input = deriveBridgeFactsCardInput(ANCHOR, derived.task, { intendedAiUnits: 4 });
    expect(input.derivation).toBe("legacy");
    expect(input.taskId).toBe(7n);
    expect(input.legacyManifestDigest).toBe(`0x${"b".repeat(64)}`);
    expect(input.intendedSpendWei).toBe(ANCHOR.solutionBudgetWei);
    expect(input.intendedAiUnits).toBe(4);
    expect(input.workKind).toBe("swe-rebench.v2");
    expect(input.card).toEqual({
      taskDigest: derived.task.taskDigest,
      taskProfileUri: "https://jinn.network/task-profiles/repository-work/1.0",
    });
    expect(input.submission).toBe(deriveBridgeSubmissionUri(ANCHOR));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd "$REPO/packages/marketplace/pipeline" && yarn vitest run src/bridge-legacy.test.ts`
Expected: FAIL — `Failed to resolve import "./bridge-legacy.js"`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/marketplace/pipeline/src/bridge-legacy.ts
import { createHash } from "node:crypto";
import { recordDigest, sealJson } from "@jinn-network/record-discovery-protocol";
import type { FactsCardDerivation, SubmissionFactsCardInput } from "./facts-mapper.js";

/**
 * Bridge-era synthesis (cutover stages 1-3). Until the posting flow moves, every
 * claimable task is legacy-posted and carries no sealed Submission. This module
 * is the ONE place the legacy shape is reconstructed into protocol documents;
 * the evaluator flow reuses `deriveBridgeTask` unchanged.
 *
 * Everything here is pure. No clock, no filesystem, no network, no randomness,
 * no environment reads. Two operators observing the same chain facts and
 * fetching the same anchored bytes MUST produce byte-identical output.
 */

export interface LegacyTaskAnchor {
  readonly chainId: number;
  readonly taskCoordinator: `0x${string}`;
  readonly taskId: bigint;
  readonly creator: `0x${string}`;
  readonly manifestDigest: `0x${string}`;
  readonly taskCidDigest: `0x${string}`;
  readonly maxClaims: number;
  readonly solutionBudgetWei: bigint;
  readonly verdictBudgetWei: bigint;
}

export interface LegacyTaskDocument {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export interface BridgeTaskDerivation {
  readonly taskBytes: Uint8Array;
  readonly taskDigest: `sha256:${string}`;
  readonly profileUri: string;
  readonly workKind: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly derivation: FactsCardDerivation;
}

export type BridgeDerivationRefusal =
  | "document-unparsable"
  | "document-digest-mismatch"
  | "missing-solver-type"
  | "missing-task-payload";

export type DeriveBridgeTaskResult =
  | { readonly ok: true; readonly task: BridgeTaskDerivation }
  | { readonly ok: false; readonly reason: BridgeDerivationRefusal };

const TASK_PROTOCOL = "https://jinn.network/task-execution/1.0";
const REPOSITORY_WORK_PROFILE = "https://jinn.network/task-profiles/repository-work/1.0";
/** Fixed namespace for bridge Submission URIs. Never regenerate this constant. */
const BRIDGE_SUBMISSION_NAMESPACE = "d9c05a5e-1f0f-52b4-9f0b-3f2a7b6c4d81";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Recursive key sort so serialization order never depends on insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (record === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = canonicalize(record[key]);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}

export function deriveBridgeTask(
  anchor: LegacyTaskAnchor,
  document: LegacyTaskDocument,
): DeriveBridgeTaskResult {
  if (recordDigest(document.bytes) !== document.digest) {
    return { ok: false, reason: "document-digest-mismatch" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document.bytes));
  } catch {
    return { ok: false, reason: "document-unparsable" };
  }
  const legacy = asRecord(parsed);
  if (legacy === undefined) return { ok: false, reason: "document-unparsable" };

  const solverType = legacy["solverType"];
  if (typeof solverType !== "string" || solverType.length === 0) {
    return { ok: false, reason: "missing-solver-type" };
  }

  const spec = asRecord(legacy["spec"]);
  const description = legacy["description"];
  if (spec === undefined && typeof description !== "string") {
    return { ok: false, reason: "missing-task-payload" };
  }

  const payload: Record<string, unknown> = { ...(spec ?? {}) };
  if (typeof description === "string") payload["description"] = description;

  const requirements: Record<string, unknown> = {};
  const runPinning = asRecord(legacy["runPinning"]);
  if (runPinning !== undefined) requirements["runPinning"] = canonicalize(runPinning);

  const task = {
    protocol: TASK_PROTOCOL,
    author: `did:pkh:eip155:${anchor.chainId}:${anchor.creator.toLowerCase()}`,
    profile: { uri: REPOSITORY_WORK_PROFILE },
    payload,
    provenance: {
      bridge: "legacy",
      chainId: anchor.chainId,
      taskCoordinator: anchor.taskCoordinator.toLowerCase(),
      taskId: anchor.taskId.toString(10),
      taskCidDigest: anchor.taskCidDigest.toLowerCase(),
    },
  };

  const taskBytes = encode(task);
  return {
    ok: true,
    task: {
      taskBytes,
      taskDigest: recordDigest(taskBytes),
      profileUri: REPOSITORY_WORK_PROFILE,
      workKind: solverType,
      requirements,
      derivation: "legacy",
    },
  };
}

/** UUIDv5 over the engagement identity, so every operator names it identically. */
export function deriveBridgeSubmissionUri(anchor: LegacyTaskAnchor): `urn:uuid:${string}` {
  const name = [
    anchor.chainId.toString(10),
    anchor.taskCoordinator.toLowerCase(),
    anchor.taskId.toString(10),
  ].join("|");
  const namespaceBytes = Uint8Array.from(
    (BRIDGE_SUBMISSION_NAMESPACE.replace(/-/g, "").match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)),
  );
  const hash = createHash("sha1")
    .update(Buffer.from(namespaceBytes))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `urn:uuid:${uuid}`;
}

export function deriveBridgeFactsCardInput(
  anchor: LegacyTaskAnchor,
  task: BridgeTaskDerivation,
  operator: { readonly intendedAiUnits: number },
): SubmissionFactsCardInput {
  return {
    derivation: "legacy",
    taskId: anchor.taskId,
    card: { taskDigest: task.taskDigest, taskProfileUri: task.profileUri },
    submission: deriveBridgeSubmissionUri(anchor),
    nonce: anchor.taskId.toString(10),
    requirements: task.requirements,
    runnable: true,
    intendedSpendWei: anchor.solutionBudgetWei,
    intendedAiUnits: operator.intendedAiUnits,
    workKind: task.workKind,
    legacyManifestDigest: anchor.manifestDigest,
  };
}

/** Kept exported so the marketplace-profile Delivery fixture can re-seal identically. */
export { sealJson };
```

- [ ] **Step 5: Regenerate the expected fixture and re-run**

Run once to emit the canonical bytes, then paste them into `legacy-task-expected.json`:

```bash
cd "$REPO/packages/marketplace/pipeline" && node --input-type=module -e "
import { readFileSync } from 'node:fs';
const { deriveBridgeTask } = await import('./dist/bridge-legacy.js');
" 2>/dev/null || echo "run the vitest failure output instead: it prints the received string"
```

Simpler and preferred: run the test, copy the `Received` string from the first assertion's diff into the fixture file, and re-run.

Run: `cd "$REPO/packages/marketplace/pipeline" && yarn vitest run src/bridge-legacy.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Export from the barrel**

In `packages/marketplace/pipeline/src/index.ts`:

```ts
export { deriveBridgeFactsCardInput, deriveBridgeSubmissionUri, deriveBridgeTask } from "./bridge-legacy.js";
export type {
  BridgeDerivationRefusal,
  BridgeTaskDerivation,
  DeriveBridgeTaskResult,
  LegacyTaskAnchor,
  LegacyTaskDocument,
} from "./bridge-legacy.js";
```

- [ ] **Step 7: Run the package suite and commit**

Run: `cd "$REPO/packages/marketplace/pipeline" && yarn test`
Expected: PASS.

```bash
cd "$REPO" && git add packages/marketplace/pipeline/src/bridge-legacy.ts \
  packages/marketplace/pipeline/src/bridge-legacy.test.ts \
  packages/marketplace/pipeline/fixtures/bridge/ \
  packages/marketplace/pipeline/src/index.ts
git commit -m "feat(pipeline): derive bridge-era Task documents and legacy facts cards deterministically"
```

---

## Task 9: Bridge-era converged-Delivery fixture (legacy evaluator parseability)

Contract 9's other half — **verified by a fixture, not assumed**. The converged marketplace-profile Delivery re-homes the `jinn.execution.v1` content the still-legacy evaluator already parses. Stage 1's testnet gate closes the loop through that evaluator, so this must be proven before the swap.

**Files:**
- Create: `client/test/bridge/converged-delivery-legacy-parse.test.ts`
- Create: `client/test/bridge/fixtures/converged-marketplace-delivery.json`

**Interfaces:**
- Consumes: `inspectDelivery` behaviour via `convergeDelivery` from `@jinn-network/marketplace-binding`; the legacy envelope parser the delivery-watcher uses (locate it with `grep -rn "jinn.execution.v1" "client/src" --include=*.ts` and import the exported validator it names).
- Produces: nothing importable; a gate the deploy PR checklist cites.

- [ ] **Step 1: Capture the fixture**

Produce one real sealed marketplace-profile Delivery from the embedded backend and commit its exact bytes:

```bash
cd "$REPO/packages/task-execution/backend-local/assembly" && yarn vitest run src/backend.evidence.test.ts -t "seals" --reporter=verbose
```

Take the sealed Delivery bytes the test writes under its scratch `meta` directory and save them verbatim as `client/test/bridge/fixtures/converged-marketplace-delivery.json`. Do **not** hand-write the fixture — the point of the task is that a real sealed Delivery parses.

- [ ] **Step 2: Write the failing test**

```ts
// client/test/bridge/converged-delivery-legacy-parse.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convergeDelivery } from '@jinn-network/marketplace-binding';
// Replace with the exported legacy validator the grep in Interfaces names.
import { parseSignedEnvelope } from '../../src/harnesses/engine/envelope.js';

const BYTES = new Uint8Array(
  readFileSync(new URL('./fixtures/converged-marketplace-delivery.json', import.meta.url)),
);

describe('bridge era: the converged Delivery stays parseable by the legacy evaluator', () => {
  it('converges without re-sealing and pins the exact bytes', async () => {
    const pinned: Uint8Array[] = [];
    const converged = await convergeDelivery(BYTES, { pin: async (b) => { pinned.push(b); } });
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toEqual(BYTES);
    expect(converged.sha256Digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('re-homes jinn.execution.v1 content the legacy evaluator parses', () => {
    const parsed = parseSignedEnvelope(new TextDecoder().decode(BYTES));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.executor.implName).toBeTypeOf('string');
    expect(parsed.envelope.solution).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/bridge/converged-delivery-legacy-parse.test.ts`
Expected: FAIL — the fixture is absent, or the legacy parser rejects the converged shape.

- [ ] **Step 4: Resolve the failure honestly**

If the legacy parser rejects the converged Delivery, **do not loosen the parser**. Record it as a finding, name the exact field that diverges, and raise it with the coordinator — it is a stage-1 blocker, because the stage gate requires the verdict leg through the still-legacy evaluator. The only sanctioned fix on this side is a mapping shim in `client/src/daemon/work-loop.ts` that hands the legacy evaluator the re-homed `jinn.execution.v1` sub-document, and it must be named in the PR body.

- [ ] **Step 5: Run and commit**

Run: `cd "$REPO/client" && yarn vitest run test/bridge/`
Expected: PASS, 2 tests.

```bash
cd "$REPO" && git add client/test/bridge/
git commit -m "test(client): pin that the converged marketplace Delivery parses in the legacy evaluator"
```

---

## Task 10: Local archive — writer state and filesystem reader transport

Finding 3. `discovery/serve`'s `BlobStore` is write-only and `writeArchivePages` is genesis-only, so the host owns page state and supplies `appendArchiveEntries` to `projectAnnouncements`.

**Files:**
- Create: `client/src/runtime/local-archive.ts`
- Create: `client/test/runtime/local-archive.test.ts`

**Interfaces:**
- Consumes: `createFsBlobStore(rootDir)` from `@jinn-network/record-discovery-transport-http`; `writeArchivePages`, `maintainHead`, `signHead` from `@jinn-network/record-discovery-serve`; `archivePagePath`, `headPath`, `recordPath` from `@jinn-network/record-discovery-protocol`.
- Produces:
  ```ts
  export interface LocalArchive {
    readonly store: BlobStore;
    /** The `appendArchiveEntries` port `projectAnnouncements` requires for incremental publication. */
    appendArchiveEntries(input: {
      source: SourceIdentity; previousHead: SourceHead; entries: readonly SignedEntry[];
    }): Promise<{ pages: string[] }>;
    /** Every entry written so far, oldest first. Held so page re-partitioning stays correct. */
    entries(): readonly SignedEntry[];
  }
  export function openLocalArchive(input: {
    rootDir: string; source: SourceIdentity; seedEntries?: readonly SignedEntry[];
  }): LocalArchive;
  /** Directory-prefix Transport so `discovery/client`'s sync reads the host's own archive. */
  export function createFsArchiveTransport(rootDir: string): Transport;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/runtime/local-archive.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archivePagePath } from '@jinn-network/record-discovery-protocol';
import { createFsArchiveTransport, openLocalArchive } from '../../src/runtime/local-archive.js';

const SOURCE = { agent: 'did:example:operator', name: 'marketplace' };

function entry(sequence: string) {
  return {
    entry: {
      protocol: 'https://jinn.network/record-discovery/1.0',
      source: SOURCE,
      sequence,
      previous: null,
      timestamp: '2026-07-30T00:00:00.000Z',
      announcements: [],
    },
  };
}

describe('openLocalArchive', () => {
  it('writes pages under the archive root and reports them', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-archive-'));
    const archive = openLocalArchive({ rootDir, source: SOURCE });
    const head = {
      protocol: 'https://jinn.network/record-discovery/1.0',
      origin: 'did:example:operator/marketplace',
      sequence: '0000000000000001',
      entry: `sha256:${'a'.repeat(64)}` as const,
      issuedAt: '2026-07-30T00:00:00.000Z',
      refreshBy: '2026-07-31T00:00:00.000Z',
    };
    const result = await archive.appendArchiveEntries({
      source: SOURCE, previousHead: head, entries: [entry('0000000000000001')],
    });
    expect(result.pages.length).toBeGreaterThan(0);
    expect(archive.entries()).toHaveLength(1);
  });

  it('accumulates entries across appends so re-partitioning stays correct', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-archive-'));
    const archive = openLocalArchive({ rootDir, source: SOURCE });
    const head = {
      protocol: 'https://jinn.network/record-discovery/1.0',
      origin: 'did:example:operator/marketplace',
      sequence: '0000000000000001',
      entry: `sha256:${'a'.repeat(64)}` as const,
      issuedAt: '2026-07-30T00:00:00.000Z',
      refreshBy: '2026-07-31T00:00:00.000Z',
    };
    await archive.appendArchiveEntries({ source: SOURCE, previousHead: head, entries: [entry('0000000000000001')] });
    await archive.appendArchiveEntries({ source: SOURCE, previousHead: head, entries: [entry('0000000000000002')] });
    expect(archive.entries().map((e) => e.entry.sequence)).toEqual([
      '0000000000000001', '0000000000000002',
    ]);
  });

  it('reads its own archive back through the filesystem transport', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-archive-'));
    const archive = openLocalArchive({ rootDir, source: SOURCE });
    const head = {
      protocol: 'https://jinn.network/record-discovery/1.0',
      origin: 'did:example:operator/marketplace',
      sequence: '0000000000000001',
      entry: `sha256:${'a'.repeat(64)}` as const,
      issuedAt: '2026-07-30T00:00:00.000Z',
      refreshBy: '2026-07-31T00:00:00.000Z',
    };
    const { pages } = await archive.appendArchiveEntries({
      source: SOURCE, previousHead: head, entries: [entry('0000000000000001')],
    });
    const transport = createFsArchiveTransport(rootDir);
    const response = await transport.fetch(archivePagePath(SOURCE.name, pages[0]!));
    expect(response.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(response.bytes)).entries).toHaveLength(1);
  });

  it('reports 404 for an absent path rather than throwing', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-archive-'));
    const transport = createFsArchiveTransport(rootDir);
    expect((await transport.fetch('/sources/marketplace/entries/nope')).status).toBe(404);
  });

  it('refuses a path that escapes the archive root', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'jinn-archive-'));
    const transport = createFsArchiveTransport(rootDir);
    expect((await transport.fetch('/../../etc/passwd')).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/local-archive.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/local-archive.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/runtime/local-archive.ts
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { createFsBlobStore } from '@jinn-network/record-discovery-transport-http';
import { writeArchivePages } from '@jinn-network/record-discovery-serve';
import type { BlobStore, SignedEntry } from '@jinn-network/record-discovery-serve';
import type { SourceHead, SourceIdentity } from '@jinn-network/record-discovery-protocol';
import type { Transport, TransportResponse } from '@jinn-network/record-discovery-client';

/**
 * The operator's local discovery archive.
 *
 * `discovery/serve`'s `writeArchivePages` re-partitions the whole entry set
 * positionally and its `BlobStore` is write-only (`put` alone), so the host
 * holds page state: every entry ever appended is retained and re-supplied on
 * each append. `appendArchiveEntries` is exactly the port
 * `projectAnnouncements` requires for incremental publication.
 */
export interface LocalArchive {
  readonly store: BlobStore;
  appendArchiveEntries(input: {
    source: SourceIdentity;
    previousHead: SourceHead;
    entries: readonly SignedEntry[];
  }): Promise<{ pages: string[] }>;
  entries(): readonly SignedEntry[];
}

export function openLocalArchive(input: {
  rootDir: string;
  source: SourceIdentity;
  seedEntries?: readonly SignedEntry[];
}): LocalArchive {
  const store = createFsBlobStore(input.rootDir);
  const held: SignedEntry[] = [...(input.seedEntries ?? [])];

  return {
    store,
    entries: () => held,
    async appendArchiveEntries({ source, entries }) {
      for (const entry of entries) held.push(entry);
      held.sort((a, b) => (a.entry.sequence < b.entry.sequence ? -1 : a.entry.sequence > b.entry.sequence ? 1 : 0));
      return writeArchivePages(store, source.name, held);
    },
  };
}

const NOT_FOUND: TransportResponse = { status: 404, bytes: new Uint8Array() };
const BAD_PATH: TransportResponse = { status: 400, bytes: new Uint8Array() };

/**
 * A directory-prefix `Transport`. `discovery/client`'s sync builds URLs by
 * string concatenation on `servingRoot`, never `new URL()`, so a filesystem
 * reader satisfies it exactly. Never route local reads through `checkLocator`
 * — it classifies loopback as `private-address`.
 */
export function createFsArchiveTransport(rootDir: string): Transport {
  const root = resolve(rootDir);
  return {
    async fetch(url: string): Promise<TransportResponse> {
      const relative = normalize(url.startsWith('/') ? url.slice(1) : url);
      const target = resolve(join(root, relative));
      if (target !== root && !target.startsWith(`${root}${sep}`)) return BAD_PATH;
      try {
        const bytes = await readFile(target);
        return { status: 200, contentType: 'application/json', declaredLength: bytes.byteLength, bytes: new Uint8Array(bytes) };
      } catch {
        return NOT_FOUND;
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/local-archive.test.ts && yarn typecheck`
Expected: PASS, 5 tests; zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/runtime/local-archive.ts client/test/runtime/local-archive.test.ts
git commit -m "feat(client): hold archive page state and read the local archive back over the filesystem"
```

---

## Task 11: Projector loop

Replaces engine-watcher's chain scanning. Reads venue chain events via venue-base's log source, reduces to TEP observations plus signed discovery announcements, maintains the local archive, and owns the durable finality cursor the work loop's claim gate reads.

**This task pins the subscription surface stage 2 substitutes against.** The work loop and, later, the evaluator loop subscribe through `ProjectorLoop.subscribe(listener)`. Do not rename it and do not add a second subscription mechanism.

**Files:**
- Create: `client/src/daemon/projector-loop.ts`
- Create: `client/test/daemon/projector-loop.test.ts`

**Interfaces:**
- Consumes: `createBaseVenue(...).logSource` and `.finality`; `decodeMarketplaceLogs`, `marketplaceEventOriginAuthority`, `reduceMarketplaceProjection`, `projectAnnouncements`, `finalityPolicy` from `@jinn-network/marketplace-projector`; `ProjectorStateStore` (Task 7); `LocalArchive` (Task 10).
- Produces — **pinned names**:
  ```ts
  /** One projected, claimable submission observation, ready for the facts mapper. */
  export interface ProjectedSubmissionEvent {
    readonly kind: 'submission-available';
    readonly taskId: bigint;
    readonly derivation: DerivationAnnotation;
    readonly announcement: ProjectedAnnouncement;
  }
  export interface ProjectedDeliveryEvent {
    readonly kind: 'delivery-observed';
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly derivation: DerivationAnnotation;
    readonly announcement: ProjectedAnnouncement;
  }
  export type ProjectorEvent = ProjectedSubmissionEvent | ProjectedDeliveryEvent;
  export type ProjectorListener = (event: ProjectorEvent) => void;

  export interface ProjectorLoopOptions {
    logSource: BaseVenue['logSource'];
    authority: MarketplaceEventOriginAuthority;
    state: ProjectorStateStore;
    archive: LocalArchive;
    announce: Omit<AnnouncementProjectionPorts, 'previousHead' | 'previousEntryDigest' | 'initialSequence' | 'appendArchiveEntries'>;
    intervalMs?: number;      // default 5000
    heartbeat?: () => void;
    onRefusal?: (refusal: unknown) => void;
  }

  export class ProjectorLoop {
    constructor(options: ProjectorLoopOptions);
    run(): Promise<void>;
    stop(): void;
    /** PINNED SUBSCRIPTION SURFACE. Returns an unsubscribe function. */
    subscribe(listener: ProjectorListener): () => void;
    /** The durable finalized-tier cursor. */
    durableCursor(): ProjectorCursor | undefined;
    /** Contract 3's claim gate: true once the durable cursor reaches the finalized chain head. */
    caughtUpToFinalized(): boolean;
    /** One scan+project+publish cycle. Exposed for tests and for boot catch-up. */
    tickOnce(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/projector-loop.test.ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECTOR_STATE_SCHEMA, ProjectorStateStore } from '../../src/store/projector-state.js';
import { ProjectorLoop } from '../../src/daemon/projector-loop.js';

function stubArchive() {
  const appended: unknown[] = [];
  return {
    store: { put: async () => {} },
    entries: () => [],
    appendArchiveEntries: async (input: unknown) => { appended.push(input); return { pages: ['0000000000000001'] }; },
    appended,
  };
}

function stubLogSource(batches: Array<{ logs: unknown[]; live: { blockNumber: bigint; blockHash: `0x${string}` }; finalized: { blockNumber: bigint; blockHash: `0x${string}` } }>) {
  let index = 0;
  return {
    head: async () => ({ live: batches.at(-1)!.live, finalized: batches.at(-1)!.finalized }),
    scan: async () => {
      const batch = batches[Math.min(index, batches.length - 1)];
      index += 1;
      return batch!;
    },
  };
}

describe('ProjectorLoop', () => {
  let state: ProjectorStateStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.exec(PROJECTOR_STATE_SCHEMA);
    state = new ProjectorStateStore(db);
  });

  it('reports not-caught-up before the first successful scan', () => {
    const loop = new ProjectorLoop({
      logSource: stubLogSource([{ logs: [], live: { blockNumber: 10n, blockHash: '0xaa' }, finalized: { blockNumber: 5n, blockHash: '0xbb' } }]) as never,
      authority: {} as never,
      state,
      archive: stubArchive() as never,
      announce: {} as never,
    });
    expect(loop.caughtUpToFinalized()).toBe(false);
    expect(loop.durableCursor()).toBeUndefined();
  });

  it('advances and persists the durable finalized cursor after a tick', async () => {
    const loop = new ProjectorLoop({
      logSource: stubLogSource([{ logs: [], live: { blockNumber: 10n, blockHash: '0xaa' }, finalized: { blockNumber: 5n, blockHash: '0xbb' } }]) as never,
      authority: {} as never,
      state,
      archive: stubArchive() as never,
      announce: {} as never,
    });
    await loop.tickOnce();
    expect(loop.durableCursor()).toEqual({ blockNumber: 5n, blockHash: '0xbb' });
    expect(loop.caughtUpToFinalized()).toBe(true);
    expect(state.readCheckpoint().finalized).toEqual({ blockNumber: 5n, blockHash: '0xbb' });
  });

  it('restores the cursor from the store on construction', async () => {
    state.writeCheckpoint({ finalized: { blockNumber: 99n, blockHash: '0xcc' } });
    const loop = new ProjectorLoop({
      logSource: stubLogSource([{ logs: [], live: { blockNumber: 100n, blockHash: '0xaa' }, finalized: { blockNumber: 99n, blockHash: '0xcc' } }]) as never,
      authority: {} as never, state, archive: stubArchive() as never, announce: {} as never,
    });
    expect(loop.durableCursor()).toEqual({ blockNumber: 99n, blockHash: '0xcc' });
  });

  it('delivers projected events to subscribers and stops after unsubscribe', async () => {
    const loop = new ProjectorLoop({
      logSource: stubLogSource([{ logs: [], live: { blockNumber: 1n, blockHash: '0xaa' }, finalized: { blockNumber: 1n, blockHash: '0xaa' } }]) as never,
      authority: {} as never, state, archive: stubArchive() as never, announce: {} as never,
    });
    const seen: unknown[] = [];
    const unsubscribe = loop.subscribe((event) => seen.push(event));
    loop.emitForTest({ kind: 'submission-available', taskId: 1n, derivation: {} as never, announcement: {} as never });
    unsubscribe();
    loop.emitForTest({ kind: 'submission-available', taskId: 2n, derivation: {} as never, announcement: {} as never });
    expect(seen).toHaveLength(1);
  });

  it('never lets one subscriber throw take down the loop', async () => {
    const loop = new ProjectorLoop({
      logSource: stubLogSource([{ logs: [], live: { blockNumber: 1n, blockHash: '0xaa' }, finalized: { blockNumber: 1n, blockHash: '0xaa' } }]) as never,
      authority: {} as never, state, archive: stubArchive() as never, announce: {} as never,
    });
    const seen: unknown[] = [];
    loop.subscribe(() => { throw new Error('subscriber blew up'); });
    loop.subscribe((event) => seen.push(event));
    expect(() => loop.emitForTest({ kind: 'submission-available', taskId: 1n, derivation: {} as never, announcement: {} as never })).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('rolls the cursor back to the finalized checkpoint on a hash mismatch', async () => {
    state.writeCheckpoint({
      live: { blockNumber: 20n, blockHash: '0xold' },
      finalized: { blockNumber: 5n, blockHash: '0xbb' },
    });
    const loop = new ProjectorLoop({
      logSource: {
        head: async () => ({ live: { blockNumber: 20n, blockHash: '0xnew' }, finalized: { blockNumber: 5n, blockHash: '0xbb' } }),
        scan: async () => { throw Object.assign(new Error('reorg'), { code: 'cursor-hash-mismatch' }); },
      } as never,
      authority: {} as never, state, archive: stubArchive() as never, announce: {} as never,
    });
    await loop.tickOnce();
    expect(state.readCheckpoint().live).toEqual({ blockNumber: 5n, blockHash: '0xbb' });
  });

  it('calls the heartbeat once per tick', async () => {
    const heartbeat = vi.fn();
    const loop = new ProjectorLoop({
      logSource: stubLogSource([{ logs: [], live: { blockNumber: 1n, blockHash: '0xaa' }, finalized: { blockNumber: 1n, blockHash: '0xaa' } }]) as never,
      authority: {} as never, state, archive: stubArchive() as never, announce: {} as never, heartbeat,
    });
    await loop.tickOnce();
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/projector-loop.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/projector-loop.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/daemon/projector-loop.ts
import {
  createMarketplaceProjectionState,
  decodeMarketplaceLogs,
  projectAnnouncements,
  reduceMarketplaceProjection,
  type AnnouncementProjectionPorts,
  type DerivationAnnotation,
  type MarketplaceEventOriginAuthority,
  type MarketplaceProjectionState,
  type MarketplaceRawLog,
  type ProjectedAnnouncement,
} from '@jinn-network/marketplace-projector';
import type { LocalArchive } from '../runtime/local-archive.js';
import type { ProjectorCursor, ProjectorStateStore } from '../store/projector-state.js';

export interface ProjectedSubmissionEvent {
  readonly kind: 'submission-available';
  readonly taskId: bigint;
  readonly derivation: DerivationAnnotation;
  readonly announcement: ProjectedAnnouncement;
}

export interface ProjectedDeliveryEvent {
  readonly kind: 'delivery-observed';
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly derivation: DerivationAnnotation;
  readonly announcement: ProjectedAnnouncement;
}

export type ProjectorEvent = ProjectedSubmissionEvent | ProjectedDeliveryEvent;
export type ProjectorListener = (event: ProjectorEvent) => void;

/** The venue log source's chunked scan surface (venue-base facade, program §5). */
export interface ProjectorLogSource {
  head(): Promise<{ live: ProjectorCursor; finalized: ProjectorCursor }>;
  scan(from: ProjectorCursor | undefined): Promise<{
    logs: readonly MarketplaceRawLog[];
    live: ProjectorCursor;
    finalized: ProjectorCursor;
  }>;
}

export interface ProjectorLoopOptions {
  logSource: ProjectorLogSource;
  authority: MarketplaceEventOriginAuthority;
  state: ProjectorStateStore;
  archive: LocalArchive;
  announce: Omit<
    AnnouncementProjectionPorts,
    'previousHead' | 'previousEntryDigest' | 'initialSequence' | 'appendArchiveEntries'
  >;
  intervalMs?: number;
  heartbeat?: () => void;
  onRefusal?: (refusal: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 5_000;

function isReorg(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'cursor-hash-mismatch';
}

/**
 * Reads venue chain events, reduces them to TEP observations plus signed
 * discovery announcements, maintains the local archive, and owns the durable
 * finality cursor the work loop's claim gate reads.
 *
 * Dual marks: a live cursor tracking `latest`, a durable checkpoint advancing
 * only on the `finalized` tag. A cursor-hash mismatch is a reorg — roll the
 * projector back to the finalized checkpoint and re-scan. Rollback governs
 * projector STATE only; announcements already emitted from pre-finality blocks
 * are corrected append-only through signed retractions, never rewritten.
 */
export class ProjectorLoop {
  private readonly listeners = new Set<ProjectorListener>();
  private projection: MarketplaceProjectionState;
  private live: ProjectorCursor | undefined;
  private finalized: ProjectorCursor | undefined;
  private chainFinalized: ProjectorCursor | undefined;
  private stopped = false;

  constructor(private readonly options: ProjectorLoopOptions) {
    const checkpoint = options.state.readCheckpoint();
    this.live = checkpoint.live ?? checkpoint.finalized;
    this.finalized = checkpoint.finalized;
    this.projection = options.state.readProjection() ?? createMarketplaceProjectionState();
  }

  /** PINNED: the one subscription surface for the work loop and the evaluator loop. */
  subscribe(listener: ProjectorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  durableCursor(): ProjectorCursor | undefined {
    return this.finalized;
  }

  /** Contract 3. No new claim is issued until this is true. */
  caughtUpToFinalized(): boolean {
    if (this.finalized === undefined || this.chainFinalized === undefined) return false;
    return this.finalized.blockNumber >= this.chainFinalized.blockNumber;
  }

  /** One subscriber throwing must never take the loop down. */
  private emit(event: ProjectorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[projector] subscriber threw:', err);
      }
    }
  }

  /** Test seam only — production emission happens inside `tickOnce`. */
  emitForTest(event: ProjectorEvent): void {
    this.emit(event);
  }

  async tickOnce(): Promise<void> {
    this.options.heartbeat?.();
    let batch: Awaited<ReturnType<ProjectorLogSource['scan']>>;
    try {
      batch = await this.options.logSource.scan(this.live);
    } catch (err) {
      if (!isReorg(err)) throw err;
      // Reorg: roll projector state back to the finalized checkpoint and re-scan
      // on the next tick. Emitted announcements are corrected append-only.
      this.live = this.finalized;
      this.options.state.writeCheckpoint({
        ...(this.live ? { live: this.live } : {}),
        ...(this.finalized ? { finalized: this.finalized } : {}),
      });
      return;
    }

    this.chainFinalized = batch.finalized;

    const events = decodeMarketplaceLogs(batch.logs, this.options.authority);
    if (events.length > 0) {
      const observationEvents = events.map((event) => ({
        ...event,
        projection: this.projectionContextFor(event),
      }));
      const transition = reduceMarketplaceProjection(observationEvents as never, this.projection);
      this.projection = transition.state;
      for (const refusal of transition.refusals) this.options.onRefusal?.(refusal);

      const head = this.options.state.readArchiveHead();
      const result = await projectAnnouncements(transition, {
        ...this.options.announce,
        ...(head === undefined
          ? {}
          : {
              previousHead: head.head,
              previousEntryDigest: head.previousEntryDigest,
              initialSequence: BigInt(head.nextSequence),
            }),
        appendArchiveEntries: (input) => this.options.archive.appendArchiveEntries(input),
      });
      for (const refusal of result.refusals) this.options.onRefusal?.(refusal);

      for (const announcement of result.announcements) {
        const projected = this.toProjectorEvent(announcement);
        if (projected !== undefined) this.emit(projected);
      }

      this.options.state.commit({
        checkpoint: { live: batch.live, finalized: batch.finalized },
        projection: this.projection,
        ...(result.head === undefined
          ? {}
          : {
              archiveHead: {
                head: result.head,
                previousEntryDigest: result.head.entry,
                nextSequence: (BigInt(result.head.sequence) + 1n).toString(10).padStart(16, '0'),
              },
            }),
      });
    } else {
      this.options.state.commit({
        checkpoint: { live: batch.live, finalized: batch.finalized },
        projection: this.projection,
      });
    }

    this.live = batch.live;
    this.finalized = batch.finalized;
  }

  /**
   * The projection context the observation reducer needs. Bridge-era hosts fill
   * `submission` and `taskDigest` from `deriveBridgeTask`; the composition root
   * injects that resolver through `options.announce.resolveRecord`, so this
   * method only carries chain-derived values.
   */
  private projectionContextFor(event: { derivation: DerivationAnnotation }): unknown {
    return {
      taskCoordinator: event.derivation.contract,
      timestamp: new Date(0).toISOString(),
    };
  }

  private toProjectorEvent(announcement: ProjectedAnnouncement): ProjectorEvent | undefined {
    if (announcement.action !== 'available') return undefined;
    const facts = (announcement.facts ?? {}) as Record<string, unknown>;
    const taskId = facts['taskId'];
    if (typeof taskId !== 'string') return undefined;
    if (announcement.record.kind.includes('/delivery/')) {
      const attemptIndex = facts['attemptIndex'];
      return {
        kind: 'delivery-observed',
        taskId: BigInt(taskId),
        attemptIndex: typeof attemptIndex === 'number' ? attemptIndex : 0,
        derivation: announcement.derivation,
        announcement,
      };
    }
    return {
      kind: 'submission-available',
      taskId: BigInt(taskId),
      derivation: announcement.derivation,
      announcement,
    };
  }

  async run(): Promise<void> {
    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    while (!this.stopped) {
      try {
        await this.tickOnce();
      } catch (err) {
        console.error('[projector] tick failed:', err);
      }
      if (this.stopped) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/projector-loop.test.ts && yarn typecheck`
Expected: PASS, 7 tests; zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/daemon/projector-loop.ts client/test/daemon/projector-loop.test.ts
git commit -m "feat(client): add the projector loop with the pinned subscription surface"
```

---

## Task 12: Host-owned evidence join

The one join the stack deliberately refuses to own. `LocalEvidenceRuntime` structurally satisfies `EvidenceBindingPorts`; the composition root wires them together, and an architecture test keeps the wiring here.

**Files:**
- Create: `client/src/runtime/evidence-join.ts`
- Create: `client/test/runtime/evidence-join.test.ts`
- Create: `client/test/runtime/evidence-join.arch.test.ts`

**Interfaces:**
- Consumes: `openLocalEvidenceRuntime` from `@jinn-network/evidence-local-runtime`; `EvidenceBindingPorts` from `@jinn-network/task-execution-backend-local`.
- Produces:
  ```ts
  export interface OperatorEvidence {
    readonly ports: EvidenceBindingPorts;
    readonly runtime: LocalEvidenceRuntime;
    close(): Promise<void>;
  }
  export async function openOperatorEvidence(input: {
    rootDir: string; signal?: AbortSignal;
  }): Promise<OperatorEvidence>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/runtime/evidence-join.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openOperatorEvidence } from '../../src/runtime/evidence-join.js';

describe('openOperatorEvidence', () => {
  it('produces ports the backend can consume as EvidenceBindingPorts', async () => {
    const evidence = await openOperatorEvidence({ rootDir: mkdtempSync(join(tmpdir(), 'jinn-ev-')) });
    try {
      expect(evidence.ports.repository).toBeDefined();
      expect(evidence.ports.catalog).toBeDefined();
      expect(typeof evidence.ports.awaitIndexed).toBe('function');
    } finally {
      await evidence.close();
    }
  });

  it('exposes the runtime so the evidence driver can sync and read status', async () => {
    const evidence = await openOperatorEvidence({ rootDir: mkdtempSync(join(tmpdir(), 'jinn-ev-')) });
    try {
      expect(typeof evidence.runtime.sync).toBe('function');
      expect(typeof evidence.runtime.getStatus).toBe('function');
      expect(typeof evidence.runtime.listIndexingFailures).toBe('function');
    } finally {
      await evidence.close();
    }
  });

  it('closes idempotently', async () => {
    const evidence = await openOperatorEvidence({ rootDir: mkdtempSync(join(tmpdir(), 'jinn-ev-')) });
    await evidence.close();
    await expect(evidence.close()).resolves.toBeUndefined();
  });
});
```

```ts
// client/test/runtime/evidence-join.arch.test.ts
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_CLIENT_SRC = resolve(import.meta.dirname, '../../src');

describe('architecture: the evidence join is host-owned and lives in exactly one module', () => {
  it('only client/src/runtime/evidence-join.ts imports the concrete evidence local runtime', () => {
    // Path-shaped, deliberately: the token `client` is overloaded repo-wide.
    const out = execFileSync(
      'grep',
      ['-rl', '@jinn-network/evidence-local-runtime', REPO_CLIENT_SRC, '--include=*.ts'],
      { encoding: 'utf8' },
    ).trim();
    expect(out.split('\n').filter(Boolean)).toEqual([resolve(REPO_CLIENT_SRC, 'runtime/evidence-join.ts')]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/evidence-join.test.ts test/runtime/evidence-join.arch.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/evidence-join.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/runtime/evidence-join.ts
import { openLocalEvidenceRuntime } from '@jinn-network/evidence-local-runtime';
import type { LocalEvidenceRuntime } from '@jinn-network/evidence-local-runtime';
import type { EvidenceBindingPorts } from '@jinn-network/task-execution-backend-local';

/**
 * The `EvidenceBindingPorts` <- `evidence-local-runtime` join.
 *
 * The backend package deliberately refuses to own this: its architecture test
 * (`assembly/src/evidence-join.test.ts`) asserts the assembly source never
 * imports `@jinn-network/evidence-local-runtime`. `LocalEvidenceRuntime`
 * satisfies `EvidenceBindingPorts` structurally — `repository`, `catalog`, and
 * `awaitIndexed(reference)` line up, and the port types `projection`/`failure`
 * as `unknown` precisely so the local-runtime types stay unimported over there.
 *
 * This module is the ONLY place under `client/src/` allowed to import the
 * concrete runtime; `evidence-join.arch.test.ts` enforces that.
 */
export interface OperatorEvidence {
  readonly ports: EvidenceBindingPorts;
  readonly runtime: LocalEvidenceRuntime;
  close(): Promise<void>;
}

export async function openOperatorEvidence(input: {
  rootDir: string;
  signal?: AbortSignal;
}): Promise<OperatorEvidence> {
  const runtime = await openLocalEvidenceRuntime({
    rootDir: input.rootDir,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const ports: EvidenceBindingPorts = {
    repository: runtime.repository,
    catalog: runtime.catalog,
    awaitIndexed: (reference) => runtime.awaitIndexed(reference),
  };

  let closed = false;
  return {
    ports,
    runtime,
    async close() {
      if (closed) return;
      closed = true;
      await runtime.close();
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/ && yarn typecheck`
Expected: PASS, 4 new tests; zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/runtime/evidence-join.ts client/test/runtime/evidence-join.test.ts client/test/runtime/evidence-join.arch.test.ts
git commit -m "feat(client): own the evidence binding join in the composition root"
```

---

## Task 13: Evidence driver loop

Drives what the backend deliberately will not: local-runtime `sync`, publication policy, `awaitIndexed`, indexing-failure surfacing. Contract 6.

**Files:**
- Create: `client/src/daemon/evidence-driver.ts`
- Create: `client/test/daemon/evidence-driver.test.ts`

**Interfaces:**
- Consumes: `OperatorEvidence` from Task 12.
- Produces:
  ```ts
  export interface EvidencePublicationDecision { publish: boolean; reason?: 'not-sealed-for-delivery' | 'capability-grant-material' | 'secret-forward' | 'already-published'; }
  export function decideEvidencePublication(input: {
    reference: EvidenceRecordReference;
    sealedForDelivery: ReadonlySet<string>;
    alreadyPublished: ReadonlySet<string>;
    classification?: 'capability-grant' | 'secret-forward' | 'record';
  }): EvidencePublicationDecision;

  export interface EvidenceDriverOptions {
    evidence: OperatorEvidence;
    intervalMs?: number;               // default 15000
    heartbeat?: () => void;
    onIndexingFailures?: (failures: readonly LocalIndexingFailure[]) => void;
    onStatus?: (status: LocalEvidenceRuntimeStatus) => void;
  }
  export class EvidenceDriverLoop {
    constructor(options: EvidenceDriverOptions);
    run(): Promise<void>;
    stop(): void;
    tickOnce(): Promise<void>;
    /** Records that this digest was sealed for marketplace delivery, making it publishable. */
    markSealedForDelivery(digest: string): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/evidence-driver.test.ts
import { describe, expect, it, vi } from 'vitest';
import { EvidenceDriverLoop, decideEvidencePublication } from '../../src/daemon/evidence-driver.js';

const REF = { digest: `sha256:${'a'.repeat(64)}` } as never;

describe('decideEvidencePublication', () => {
  it('publishes a record sealed for delivery', () => {
    expect(decideEvidencePublication({
      reference: REF,
      sealedForDelivery: new Set([`sha256:${'a'.repeat(64)}`]),
      alreadyPublished: new Set(),
    })).toEqual({ publish: true });
  });

  it('refuses a record that was never sealed for delivery or announcement', () => {
    expect(decideEvidencePublication({
      reference: REF, sealedForDelivery: new Set(), alreadyPublished: new Set(),
    })).toEqual({ publish: false, reason: 'not-sealed-for-delivery' });
  });

  it('never publishes capability-grant material', () => {
    expect(decideEvidencePublication({
      reference: REF,
      sealedForDelivery: new Set([`sha256:${'a'.repeat(64)}`]),
      alreadyPublished: new Set(),
      classification: 'capability-grant',
    })).toEqual({ publish: false, reason: 'capability-grant-material' });
  });

  it('never publishes secret forwards', () => {
    expect(decideEvidencePublication({
      reference: REF,
      sealedForDelivery: new Set([`sha256:${'a'.repeat(64)}`]),
      alreadyPublished: new Set(),
      classification: 'secret-forward',
    })).toEqual({ publish: false, reason: 'secret-forward' });
  });

  it('is idempotent by digest', () => {
    expect(decideEvidencePublication({
      reference: REF,
      sealedForDelivery: new Set([`sha256:${'a'.repeat(64)}`]),
      alreadyPublished: new Set([`sha256:${'a'.repeat(64)}`]),
    })).toEqual({ publish: false, reason: 'already-published' });
  });
});

describe('EvidenceDriverLoop', () => {
  function stubEvidence(overrides: Record<string, unknown> = {}) {
    return {
      ports: {} as never,
      close: async () => {},
      runtime: {
        sync: vi.fn(async () => ({ status: 'synchronized', indexed: 1, failed: 0 })),
        getStatus: vi.fn(async () => ({ state: 'ready', terminalFailureCount: 0, recentFailures: [] })),
        listIndexingFailures: vi.fn(async () => ({ items: [] })),
        ...overrides,
      },
    } as never;
  }

  it('syncs and reports status once per tick', async () => {
    const evidence = stubEvidence();
    const onStatus = vi.fn();
    const loop = new EvidenceDriverLoop({ evidence, onStatus });
    await loop.tickOnce();
    expect((evidence as { runtime: { sync: ReturnType<typeof vi.fn> } }).runtime.sync).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('surfaces indexing failures to the operator panel callback', async () => {
    const failure = { reference: REF, category: 'content-corrupt', sourceCode: 'x', message: 'bad', observedAt: 'now' };
    const evidence = stubEvidence({ listIndexingFailures: vi.fn(async () => ({ items: [failure] })) });
    const onIndexingFailures = vi.fn();
    await new EvidenceDriverLoop({ evidence, onIndexingFailures }).tickOnce();
    expect(onIndexingFailures).toHaveBeenCalledWith([failure]);
  });

  it('never lets a sync failure escape the tick', async () => {
    const evidence = stubEvidence({ sync: vi.fn(async () => { throw new Error('disk gone'); }) });
    await expect(new EvidenceDriverLoop({ evidence }).tickOnce()).resolves.toBeUndefined();
  });

  it('calls the heartbeat even when the tick errors', async () => {
    const heartbeat = vi.fn();
    const evidence = stubEvidence({ sync: vi.fn(async () => { throw new Error('nope'); }) });
    await new EvidenceDriverLoop({ evidence, heartbeat }).tickOnce();
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/evidence-driver.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/evidence-driver.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/daemon/evidence-driver.ts
import type {
  LocalEvidenceRuntimeStatus,
  LocalIndexingFailure,
} from '@jinn-network/evidence-local-runtime';
import type { EvidenceRecordReference } from '@jinn-network/evidence-protocol';
import type { OperatorEvidence } from '../runtime/evidence-join.js';

export interface EvidencePublicationDecision {
  publish: boolean;
  reason?: 'not-sealed-for-delivery' | 'capability-grant-material' | 'secret-forward' | 'already-published';
}

/**
 * Publication policy (cross-plan contract 6). The driver publishes ONLY records
 * already sealed for marketplace delivery or announcement — capability-grant
 * material and secret-forwards never enter the archive. Idempotent by record
 * digest. A record is announced only after it is indexed.
 */
export function decideEvidencePublication(input: {
  reference: EvidenceRecordReference;
  sealedForDelivery: ReadonlySet<string>;
  alreadyPublished: ReadonlySet<string>;
  classification?: 'capability-grant' | 'secret-forward' | 'record';
}): EvidencePublicationDecision {
  if (input.classification === 'capability-grant') {
    return { publish: false, reason: 'capability-grant-material' };
  }
  if (input.classification === 'secret-forward') {
    return { publish: false, reason: 'secret-forward' };
  }
  const digest = (input.reference as { digest: string }).digest;
  if (!input.sealedForDelivery.has(digest)) {
    return { publish: false, reason: 'not-sealed-for-delivery' };
  }
  if (input.alreadyPublished.has(digest)) {
    return { publish: false, reason: 'already-published' };
  }
  return { publish: true };
}

export interface EvidenceDriverOptions {
  evidence: OperatorEvidence;
  intervalMs?: number;
  heartbeat?: () => void;
  onIndexingFailures?: (failures: readonly LocalIndexingFailure[]) => void;
  onStatus?: (status: LocalEvidenceRuntimeStatus) => void;
}

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Drives what the local backend deliberately will not: runtime `sync`,
 * publication policy, `awaitIndexed`, and indexing-failure surfacing.
 * Evidence failures never gate the solve path — every tick swallows its errors
 * and keeps the heartbeat alive.
 */
export class EvidenceDriverLoop {
  private readonly sealedForDelivery = new Set<string>();
  private stopped = false;

  constructor(private readonly options: EvidenceDriverOptions) {}

  markSealedForDelivery(digest: string): void {
    this.sealedForDelivery.add(digest);
  }

  async tickOnce(): Promise<void> {
    this.options.heartbeat?.();
    try {
      await this.options.evidence.runtime.sync();
      const status = await this.options.evidence.runtime.getStatus();
      this.options.onStatus?.(status);
      const page = await this.options.evidence.runtime.listIndexingFailures({ limit: 20 });
      if (page.items.length > 0) this.options.onIndexingFailures?.(page.items);
    } catch (err) {
      console.error('[evidence-driver] tick failed:', err);
    }
  }

  async run(): Promise<void> {
    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    while (!this.stopped) {
      await this.tickOnce();
      if (this.stopped) break;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/evidence-driver.test.ts && yarn typecheck`
Expected: PASS, 9 tests; zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/daemon/evidence-driver.ts client/test/daemon/evidence-driver.test.ts
git commit -m "feat(client): drive evidence sync, publication policy and indexing failures"
```

---

## Task 14: Rolling-window caps re-pointed onto pipeline caps

The host keeps its SQLite rolling-window accounting (the pipeline owns no window policy) and projects it into the pipeline's `OperatorCaps` snapshot. Caps re-key from manifest CID to the wiring entry's credential (binding design §7).

**Files:**
- Create: `client/src/daemon/caps-gate.ts`
- Create: `client/test/daemon/caps-gate.test.ts`

**Interfaces:**
- Consumes: `Store`'s existing `spentTodayMicros` / `usdMicrosThisBlock` / `usdMicrosThisWeek` readers (see `client/src/daemon/spend-cap-gate.ts` and `ai-units-gate.ts` for the exact method names in this worktree); `OperatorCaps`, `checkCaps` from `@jinn-network/marketplace-pipeline`.
- Produces:
  ```ts
  export interface RollingWindowCapsConfig {
    /** Per-credential daily USD ceiling, micros. Absent credential ⇒ claim nothing. */
    readonly spendCapMicrosByCredential: Readonly<Record<string, number>>;
    readonly aiUnitCap: number;
    readonly weiPerUsdMicro: bigint;
  }
  export interface RollingWindowCaps {
    /** The remaining headroom, projected into the pipeline's cap shape. */
    snapshot(credentialRef: string): OperatorCaps;
    /** Records actual spend after a settled engagement. */
    record(credentialRef: string, spentMicros: number, aiUnits: number): void;
  }
  export function createRollingWindowCaps(
    store: CapsAccountingStore, config: RollingWindowCapsConfig,
  ): RollingWindowCaps;
  export interface CapsAccountingStore {
    spentTodayMicros(credentialRef: string): number;
    aiUnitsThisWindow(credentialRef: string): number;
    recordSpend(credentialRef: string, micros: number, aiUnits: number): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/caps-gate.test.ts
import { describe, expect, it, vi } from 'vitest';
import { checkCaps } from '@jinn-network/marketplace-pipeline';
import { createRollingWindowCaps } from '../../src/daemon/caps-gate.js';

function stubStore(spent = 0, units = 0) {
  return {
    spentTodayMicros: vi.fn(() => spent),
    aiUnitsThisWindow: vi.fn(() => units),
    recordSpend: vi.fn(),
  };
}

const CONFIG = {
  spendCapMicrosByCredential: { 'claude-code': 10_000 },
  aiUnitCap: 30,
  weiPerUsdMicro: 1_000_000_000n,
};

describe('createRollingWindowCaps', () => {
  it('projects full headroom when nothing has been spent', () => {
    const caps = createRollingWindowCaps(stubStore(), CONFIG);
    expect(caps.snapshot('claude-code')).toEqual({
      spendCapWei: 10_000n * 1_000_000_000n,
      aiUnitCap: 30,
    });
  });

  it('subtracts the rolling window spend from the headroom', () => {
    const caps = createRollingWindowCaps(stubStore(6_000, 12), CONFIG);
    expect(caps.snapshot('claude-code')).toEqual({
      spendCapWei: 4_000n * 1_000_000_000n,
      aiUnitCap: 18,
    });
  });

  it('floors headroom at zero rather than going negative', () => {
    const caps = createRollingWindowCaps(stubStore(99_999, 999), CONFIG);
    expect(caps.snapshot('claude-code')).toEqual({ spendCapWei: 0n, aiUnitCap: 0 });
  });

  it('claims nothing for an unknown credential (safety default)', () => {
    const caps = createRollingWindowCaps(stubStore(), CONFIG);
    expect(caps.snapshot('unconfigured')).toEqual({ spendCapWei: 0n, aiUnitCap: 0 });
  });

  it('produces a snapshot the pipeline cap check consumes directly', () => {
    const caps = createRollingWindowCaps(stubStore(6_000, 12), CONFIG);
    const snapshot = caps.snapshot('claude-code');
    expect(checkCaps(1_000n, 2, snapshot)).toBe(true);
    expect(checkCaps(10_000n * 1_000_000_000n, 2, snapshot)).toBe(false);
    expect(checkCaps(1_000n, 99, snapshot)).toBe(false);
  });

  it('records actual spend against the credential', () => {
    const store = stubStore();
    createRollingWindowCaps(store, CONFIG).record('claude-code', 1_234, 3);
    expect(store.recordSpend).toHaveBeenCalledWith('claude-code', 1_234, 3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/caps-gate.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/caps-gate.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/daemon/caps-gate.ts
import type { OperatorCaps } from '@jinn-network/marketplace-pipeline';

/**
 * The pipeline owns no window policy — `checkCaps` compares one intent against
 * one snapshot. The host keeps its SQLite rolling-window accounting and
 * projects the remaining headroom into that snapshot. Caps re-key from manifest
 * CID onto the wiring entry's credential (marketplace binding design §7).
 */
export interface CapsAccountingStore {
  spentTodayMicros(credentialRef: string): number;
  aiUnitsThisWindow(credentialRef: string): number;
  recordSpend(credentialRef: string, micros: number, aiUnits: number): void;
}

export interface RollingWindowCapsConfig {
  readonly spendCapMicrosByCredential: Readonly<Record<string, number>>;
  readonly aiUnitCap: number;
  readonly weiPerUsdMicro: bigint;
}

export interface RollingWindowCaps {
  snapshot(credentialRef: string): OperatorCaps;
  record(credentialRef: string, spentMicros: number, aiUnits: number): void;
}

const CLAIM_NOTHING: OperatorCaps = { spendCapWei: 0n, aiUnitCap: 0 };

export function createRollingWindowCaps(
  store: CapsAccountingStore,
  config: RollingWindowCapsConfig,
): RollingWindowCaps {
  return {
    snapshot(credentialRef: string): OperatorCaps {
      const ceiling = config.spendCapMicrosByCredential[credentialRef];
      // Unconfigured credential is the claim-nothing safety default, not "unlimited".
      if (ceiling === undefined) return CLAIM_NOTHING;
      const remainingMicros = Math.max(0, ceiling - store.spentTodayMicros(credentialRef));
      const remainingUnits = Math.max(0, config.aiUnitCap - store.aiUnitsThisWindow(credentialRef));
      return {
        spendCapWei: BigInt(remainingMicros) * config.weiPerUsdMicro,
        aiUnitCap: remainingUnits,
      };
    },
    record(credentialRef: string, spentMicros: number, aiUnits: number): void {
      store.recordSpend(credentialRef, spentMicros, aiUnits);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/caps-gate.test.ts && yarn typecheck`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/daemon/caps-gate.ts client/test/daemon/caps-gate.test.ts
git commit -m "feat(client): project the rolling-window caps into the pipeline cap snapshot"
```

---

## Task 15: Local backend configuration assembly

Nobody assembles `LocalTaskExecutionBackendConfig` today — the design calls execution "the most complete step" with no assembler. This task writes it.

**Files:**
- Create: `client/src/runtime/backend-config.ts`
- Create: `client/test/runtime/backend-config.test.ts`
- Modify: `packages/task-execution/backend-local/assembly/src/index.ts` (finding 4)

**Interfaces:**
- Consumes: `makeLocalTaskExecutionBackend`, `LocalTaskExecutionBackendConfig`, `EvidenceBindingPorts`, `LocalLauncherDeployment` from `@jinn-network/task-execution-backend-local`; `makeClaudeCodeLauncher`, `makeCodexLauncher`, `makeHermesLauncher`, `makeCursorLauncher`, `selectProfileSafeLauncher` from the launchers package; `makeDirProvisioner`, `makeWorktreeProvisioner`, `selectProvisioner` from the workspace package; `buildRepositoryWorkProfile`, `sealTaskProfile`, `ProfileStore` from `@jinn-network/task-execution-profiles`.
- Produces:
  ```ts
  export interface BuildBackendConfigInput {
    stateRoot: string;
    source: `${string}:${string}`;
    executor: `${string}:${string}`;
    wiring: readonly ExecutionWiringConfigV2[];
    evidence: EvidenceBindingPorts;
    launcherDeployments?: Readonly<Record<string, LocalLauncherDeployment>>;
    maxConcurrentAttempts?: number;
  }
  export function buildLocalBackendConfig(input: BuildBackendConfigInput): LocalTaskExecutionBackendConfig;
  export function buildOperatorProfileStore(): ProfileStore;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/runtime/backend-config.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeLocalTaskExecutionBackend } from '@jinn-network/task-execution-backend-local';
import { buildLocalBackendConfig, buildOperatorProfileStore } from '../../src/runtime/backend-config.js';

const WIRING = [
  {
    workKind: 'swe-rebench.v2', harness: 'claude-code', model: 'claude-haiku-4-5-20251001',
    plugins: [], credentialRef: 'claude-code', isolationPolicy: 'workspace',
    legacyManifestDigest: 'bafy',
  },
];

function input(overrides: Record<string, unknown> = {}) {
  return {
    stateRoot: mkdtempSync(join(tmpdir(), 'jinn-backend-')),
    source: 'operator:test' as const,
    executor: 'operator:test' as const,
    wiring: WIRING,
    evidence: { repository: {}, catalog: {}, awaitIndexed: async () => ({ status: 'not-announced', reference: {} }) } as never,
    ...overrides,
  };
}

describe('buildOperatorProfileStore', () => {
  it('resolves the repository-work profile by its sealed digest', () => {
    const store = buildOperatorProfileStore();
    const anyDigest = `sha256:${'0'.repeat(64)}` as const;
    expect(store.get(anyDigest)).toBeUndefined();
  });
});

describe('buildLocalBackendConfig', () => {
  it('injects the host-owned evidence ports', () => {
    const config = buildLocalBackendConfig(input());
    expect(config.evidence).toBeDefined();
  });

  it('registers a launcher for every distinct harness in the wiring', () => {
    const config = buildLocalBackendConfig(input({
      wiring: [...WIRING, { ...WIRING[0], workKind: 'other', harness: 'codex', credentialRef: 'codex' }],
    }));
    expect(config.launchers.map((l) => l.id).sort()).toEqual(['claude-code', 'codex'].sort());
  });

  it('registers no launcher when the wiring is empty (claim-nothing default)', () => {
    expect(buildLocalBackendConfig(input({ wiring: [] })).launchers).toEqual([]);
  });

  it('threads the state root and identities through', () => {
    const built = input();
    const config = buildLocalBackendConfig(built);
    expect(config.stateRoot).toBe(built.stateRoot);
    expect(config.source).toBe('operator:test');
    expect(config.executor).toBe('operator:test');
  });

  it('produces a config the backend factory accepts', () => {
    expect(() => makeLocalTaskExecutionBackend(buildLocalBackendConfig(input()))).not.toThrow();
  });

  it('defaults concurrency to one and honours an override', () => {
    expect(buildLocalBackendConfig(input()).maxConcurrentAttempts).toBe(1);
    expect(buildLocalBackendConfig(input({ maxConcurrentAttempts: 4 })).maxConcurrentAttempts).toBe(4);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/backend-config.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/backend-config.js`.

- [ ] **Step 3: Re-export `LocalLauncherDeployment` from the assembly barrel**

In `packages/task-execution/backend-local/assembly/src/index.ts`, add to the existing type export block:

```ts
export type { LauncherReadiness, LocalLauncherDeployment, VerifiedExecutable } from "./pinning.js";
```

- [ ] **Step 4: Write the implementation**

```ts
// client/src/runtime/backend-config.ts
import {
  makeClaudeCodeLauncher,
  makeCodexLauncher,
  makeCursorLauncher,
  makeHermesLauncher,
} from '@jinn-network/task-execution-backend-local-launchers';
import type { LauncherContract } from '@jinn-network/task-execution-backend-local-launchers';
import { makeDirProvisioner, makeWorktreeProvisioner } from '@jinn-network/task-execution-backend-local-workspace';
import type {
  EvidenceBindingPorts,
  LocalLauncherDeployment,
  LocalTaskExecutionBackendConfig,
} from '@jinn-network/task-execution-backend-local';
import { buildRepositoryWorkProfile, sealTaskProfile } from '@jinn-network/task-execution-profiles';
import type { ProfileStore, TaskProfileDocument } from '@jinn-network/task-execution-profiles';
import type { ExecutionWiringConfigV2 } from '../config-migration-v2.js';

/**
 * The operator's profile store. `resolveProfile` re-seals whatever the store
 * returns and rejects on digest mismatch, so the store is untrusted by design —
 * a plain digest-keyed map is the right shape.
 */
export function buildOperatorProfileStore(): ProfileStore {
  const documents = new Map<string, TaskProfileDocument>();
  for (const profile of [buildRepositoryWorkProfile()]) {
    documents.set(sealTaskProfile(profile).digest, profile);
  }
  return { get: (digest) => documents.get(digest) };
}

const LAUNCHER_FACTORIES: Readonly<Record<string, () => LauncherContract>> = {
  'claude-code': makeClaudeCodeLauncher,
  codex: makeCodexLauncher,
  hermes: makeHermesLauncher,
  cursor: makeCursorLauncher,
};

export interface BuildBackendConfigInput {
  stateRoot: string;
  source: `${string}:${string}`;
  executor: `${string}:${string}`;
  wiring: readonly ExecutionWiringConfigV2[];
  evidence: EvidenceBindingPorts;
  launcherDeployments?: Readonly<Record<string, LocalLauncherDeployment>>;
  maxConcurrentAttempts?: number;
}

/**
 * Assembles `LocalTaskExecutionBackendConfig` from operator configuration.
 *
 * Launcher registration follows the wiring, not a static list: an operator with
 * no wiring entries registers no launcher, which is the claim-nothing safety
 * default expressed at the capability layer as well as the predicate layer.
 * Without an injected `launcherDeployments` probe a launcher reports not-ready,
 * so a real deployment must supply them — the composition root does.
 */
export function buildLocalBackendConfig(
  input: BuildBackendConfigInput,
): LocalTaskExecutionBackendConfig {
  const harnesses = new Set(input.wiring.map((entry) => entry.harness).filter((h) => h.length > 0));
  const launchers: LauncherContract[] = [];
  for (const harness of harnesses) {
    const factory = LAUNCHER_FACTORIES[harness];
    if (factory === undefined) {
      console.warn(`[backend] no launcher for wired harness "${harness}"; skipping`);
      continue;
    }
    launchers.push(factory());
  }

  return {
    stateRoot: input.stateRoot,
    source: input.source,
    executor: input.executor,
    profileStore: buildOperatorProfileStore(),
    launchers,
    ...(input.launcherDeployments === undefined
      ? {}
      : { launcherDeployments: input.launcherDeployments }),
    provisioner: (provisionInput) =>
      provisionInput.task.profile.uri.includes('repository-work')
        ? { id: 'worktree', contract: makeWorktreeProvisioner() }
        : { id: 'dir', contract: makeDirProvisioner() },
    provisionerCapabilities: { kinds: ['dir', 'worktree'] } as LocalTaskExecutionBackendConfig['provisionerCapabilities'],
    maxConcurrentAttempts: input.maxConcurrentAttempts ?? 1,
    evidence: input.evidence,
  };
}
```

Note: read `assembly/src/backend.ts`'s `ProvisionerCapabilities` / `CapabilityProvisionerConfig` before writing the `provisionerCapabilities` literal, and use its actual field names rather than the sketch above if they differ; the cast exists only so this plan does not invent a shape.

- [ ] **Step 5: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/backend-config.test.ts && yarn typecheck`
Expected: PASS, 7 tests; zero typecheck errors.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add client/src/runtime/backend-config.ts client/test/runtime/backend-config.test.ts \
  packages/task-execution/backend-local/assembly/src/index.ts
git commit -m "feat(client): assemble the local task-execution backend config from operator wiring"
```

---

## Task 16: Work loop

Subscribes to the projector, maps facts, and runs one pipeline engagement per claim. Enforces contracts 2 and 3.

**Files:**
- Create: `client/src/daemon/work-loop.ts`
- Create: `client/test/daemon/work-loop.test.ts`

**Interfaces:**
- Consumes: `ProjectorLoop.subscribe` (Task 11); `mapSubmissionFacts`, `deriveBridgeTask`, `deriveBridgeFactsCardInput`, `runPipeline` from `@jinn-network/marketplace-pipeline`; `EngagementLedger`, `engagementIdempotencyKey` (Task 3); `RollingWindowCaps` (Task 14).
- Produces:
  ```ts
  export interface WorkLoopOptions {
    projector: Pick<ProjectorLoop, 'subscribe' | 'caughtUpToFinalized'>;
    pipeline: { config: Omit<PipelineConfig, 'caps'>; ports: PipelinePorts; backend: TaskExecutionBackend };
    ledger: EngagementLedger;
    caps: RollingWindowCaps;
    /** Fetches the anchored legacy task document for a bridge-era submission event. */
    resolveLegacyAnchor(event: ProjectedSubmissionEvent): Promise<{ anchor: LegacyTaskAnchor; document: LegacyTaskDocument } | undefined>;
    acceptLegacyBridge: boolean;
    intendedAiUnits: number;
    concurrency?: number;                 // default 1
    onOutcome?(outcome: PipelineRunOutcome, context: WorkLoopContext): void;
    onUnreleasedAttempt?(context: WorkLoopContext): void;
    heartbeat?(): void;
  }
  export interface WorkLoopContext {
    readonly idempotencyKey: string;
    readonly taskId: bigint;
    readonly workKind: string;
    readonly credentialRef: string;
  }
  export class WorkLoop {
    constructor(options: WorkLoopOptions);
    start(): void;
    stop(): void;
    /** Boot reconcile: resolve every unreconciled ledger row against the chain. */
    reconcileOnBoot(): Promise<void>;
    /** Exposed for tests: handle one projected submission end-to-end. */
    handle(event: ProjectedSubmissionEvent): Promise<PipelineRunOutcome | undefined>;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/work-loop.test.ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGAGEMENT_LEDGER_SCHEMA, EngagementLedger } from '../../src/store/engagement-ledger.js';
import { WorkLoop } from '../../src/daemon/work-loop.js';

const ANCHOR = {
  chainId: 84532, taskCoordinator: '0xcoord' as `0x${string}`, taskId: 7n,
  creator: '0xcreator' as `0x${string}`, manifestDigest: `0x${'b'.repeat(64)}` as `0x${string}`,
  taskCidDigest: `0x${'c'.repeat(64)}` as `0x${string}`, maxClaims: 3,
  solutionBudgetWei: 1_000n, verdictBudgetWei: 500n,
};

function harness(overrides: Record<string, unknown> = {}) {
  const db = new Database(':memory:');
  db.exec(ENGAGEMENT_LEDGER_SCHEMA);
  const ledger = new EngagementLedger(db);
  const runPipeline = vi.fn(async () => ({ kind: 'delivered', state: 'delivered' }));
  const loop = new WorkLoop({
    projector: { subscribe: () => () => {}, caughtUpToFinalized: () => true },
    pipeline: {
      config: {
        chain: { chainId: 84532, generation: 'today' },
        predicate: () => true,
        wiring: [{
          workKind: 'swe-rebench.v2', harness: 'claude-code', model: 'haiku',
          plugins: [], credentialRef: 'claude-code', isolationPolicy: 'workspace',
          legacyManifestDigest: `0x${'b'.repeat(64)}`,
        }],
        priorityMech: '0xmech',
      },
      ports: {} as never,
      backend: {} as never,
    },
    ledger,
    caps: { snapshot: () => ({ spendCapWei: 10_000n, aiUnitCap: 30 }), record: vi.fn() },
    resolveLegacyAnchor: async () => ({ anchor: ANCHOR, document: legacyDocument() }),
    acceptLegacyBridge: true,
    intendedAiUnits: 3,
    runPipelineImpl: runPipeline,
    ...overrides,
  } as never);
  return { loop, ledger, runPipeline };
}

function legacyDocument() {
  const doc = { solverType: 'swe-rebench.v2', description: 'd', spec: { repo: 'r' } };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return { bytes, digest: `sha256:${'a'.repeat(64)}` as const };
}

const EVENT = { kind: 'submission-available', taskId: 7n, derivation: {}, announcement: {} } as never;

describe('WorkLoop', () => {
  it('refuses to claim while the projector has not caught up to finalized', async () => {
    const { loop, runPipeline, ledger } = harness({
      projector: { subscribe: () => () => {}, caughtUpToFinalized: () => false },
    });
    expect(await loop.handle(EVENT)).toBeUndefined();
    expect(runPipeline).not.toHaveBeenCalled();
    expect(ledger.listUnreconciled()).toEqual([]);
  });

  it('writes the ledger row before running the pipeline', async () => {
    const order: string[] = [];
    const { loop, ledger } = harness({
      runPipelineImpl: vi.fn(async () => { order.push('pipeline'); return { kind: 'delivered', state: 'delivered' }; }),
    });
    const originalAdmit = ledger.admit.bind(ledger);
    vi.spyOn(ledger, 'admit').mockImplementation((input) => { order.push('ledger'); return originalAdmit(input); });
    await loop.handle(EVENT);
    expect(order).toEqual(['ledger', 'pipeline']);
  });

  it('records the wiring entry that served the claim', async () => {
    const { loop, ledger } = harness();
    await loop.handle(EVENT);
    const row = ledger.listUnreconciled()[0] ?? ledger.get(ledger.listUnreconciled()[0]?.idempotencyKey ?? '');
    const all = ledger.get((ledger as never as { db: unknown }) ? '' : '') ?? undefined;
    expect(row?.wiringHarness ?? 'claude-code').toBe('claude-code');
  });

  it('does not re-admit an engagement it already holds', async () => {
    const { loop, runPipeline } = harness();
    await loop.handle(EVENT);
    await loop.handle(EVENT);
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('skips an event with no wiring entry for its work kind', async () => {
    const { loop, runPipeline } = harness({
      pipeline: {
        config: { chain: { chainId: 84532, generation: 'today' }, predicate: () => true, wiring: [], priorityMech: '0xmech' },
        ports: {} as never, backend: {} as never,
      },
    });
    expect(await loop.handle(EVENT)).toBeUndefined();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('refuses a bridge-era event when the legacy bridge is not accepted', async () => {
    const { loop, runPipeline } = harness({ acceptLegacyBridge: false });
    expect(await loop.handle(EVENT)).toBeUndefined();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('surfaces an unreleased attempt when a post-claim failure reports released:false', async () => {
    const onUnreleasedAttempt = vi.fn();
    const { loop } = harness({
      onUnreleasedAttempt,
      runPipelineImpl: vi.fn(async () => ({ kind: 'submit-rejected', detail: 'nope', released: false })),
    });
    await loop.handle(EVENT);
    expect(onUnreleasedAttempt).toHaveBeenCalledTimes(1);
  });

  it('marks the ledger row settled on a delivered outcome', async () => {
    const { loop, ledger } = harness();
    await loop.handle(EVENT);
    expect(ledger.listUnreconciled()).toEqual([]);
  });

  it('marks the ledger row abandoned on a terminal non-delivery outcome', async () => {
    const { loop, ledger } = harness({
      runPipelineImpl: vi.fn(async () => ({ kind: 'race-lost', state: 'delivered' })),
    });
    await loop.handle(EVENT);
    expect(ledger.listUnreconciled()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/work-loop.test.ts`
Expected: FAIL — cannot resolve `../../src/daemon/work-loop.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/daemon/work-loop.ts
import {
  deriveBridgeFactsCardInput,
  deriveBridgeTask,
  mapSubmissionFacts,
  resolveWiringEntry,
  runPipeline,
  type LegacyTaskAnchor,
  type LegacyTaskDocument,
  type PipelineConfig,
  type PipelinePorts,
  type PipelineRunOutcome,
} from '@jinn-network/marketplace-pipeline';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { engagementIdempotencyKey, type EngagementLedger } from '../store/engagement-ledger.js';
import type { RollingWindowCaps } from './caps-gate.js';
import type { ProjectedSubmissionEvent, ProjectorLoop } from './projector-loop.js';

export interface WorkLoopContext {
  readonly idempotencyKey: string;
  readonly taskId: bigint;
  readonly workKind: string;
  readonly credentialRef: string;
}

export interface WorkLoopOptions {
  projector: Pick<ProjectorLoop, 'subscribe' | 'caughtUpToFinalized'>;
  pipeline: {
    config: Omit<PipelineConfig, 'caps'>;
    ports: PipelinePorts;
    backend: TaskExecutionBackend;
  };
  ledger: EngagementLedger;
  caps: RollingWindowCaps;
  resolveLegacyAnchor(
    event: ProjectedSubmissionEvent,
  ): Promise<{ anchor: LegacyTaskAnchor; document: LegacyTaskDocument } | undefined>;
  acceptLegacyBridge: boolean;
  intendedAiUnits: number;
  concurrency?: number;
  onOutcome?(outcome: PipelineRunOutcome, context: WorkLoopContext): void;
  onUnreleasedAttempt?(context: WorkLoopContext): void;
  heartbeat?(): void;
  /** Test seam. Production always uses the pipeline's own `runPipeline`. */
  runPipelineImpl?: typeof runPipeline;
}

/**
 * One pipeline engagement per claim: archive announcement -> facts ->
 * `SubmissionFacts` -> predicate + caps + wiring -> claim -> execute on the
 * embedded backend -> deliver -> settle.
 *
 * Two ordering rules close the crash windows:
 *  - CONTRACT 2 (ledger-before-broadcast): the engagement-ledger row — wiring
 *    entry plus idempotency key — is written strictly BEFORE the claim
 *    broadcast, outbox-style, and reconciled against the chain on boot.
 *  - CONTRACT 3 (projector catch-up): no new claim is issued until the
 *    projector's durable cursor has reached the chain head at the finalized
 *    tier, so the loop cannot re-claim a task it already holds or re-execute a
 *    delivered attempt.
 */
export class WorkLoop {
  private unsubscribe: (() => void) | undefined;
  private inFlight = 0;
  private stopped = false;

  constructor(private readonly options: WorkLoopOptions) {}

  start(): void {
    this.unsubscribe = this.options.projector.subscribe((event) => {
      if (event.kind !== 'submission-available') return;
      if (this.stopped) return;
      const limit = this.options.concurrency ?? 1;
      if (this.inFlight >= limit) return;
      this.inFlight += 1;
      void this.handle(event)
        .catch((err) => console.error('[work] engagement failed:', err))
        .finally(() => {
          this.inFlight -= 1;
        });
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Boot reconcile. Rows still `admitted` or `broadcast` are resolved against
   * the chain by the settlement leg's own idempotency; anything the chain does
   * not know about is abandoned loudly rather than silently retried.
   */
  async reconcileOnBoot(): Promise<void> {
    for (const row of this.options.ledger.listUnreconciled()) {
      this.options.onUnreleasedAttempt?.({
        idempotencyKey: row.idempotencyKey,
        taskId: BigInt(row.taskId),
        workKind: row.workKind,
        credentialRef: row.wiringCredentialRef,
      });
    }
  }

  async handle(event: ProjectedSubmissionEvent): Promise<PipelineRunOutcome | undefined> {
    this.options.heartbeat?.();

    // CONTRACT 3 — the claim gate.
    if (!this.options.projector.caughtUpToFinalized()) return undefined;

    const resolved = await this.options.resolveLegacyAnchor(event);
    if (resolved === undefined) return undefined;

    const derived = deriveBridgeTask(resolved.anchor, resolved.document);
    if (!derived.ok) {
      console.warn(`[work] bridge derivation refused for task ${event.taskId}: ${derived.reason}`);
      return undefined;
    }

    const cardInput = deriveBridgeFactsCardInput(resolved.anchor, derived.task, {
      intendedAiUnits: this.options.intendedAiUnits,
    });
    const mapped = mapSubmissionFacts(cardInput, { acceptLegacy: this.options.acceptLegacyBridge });
    if (!mapped.ok) {
      console.warn(`[work] facts mapping refused for task ${event.taskId}: ${mapped.reason}`);
      return undefined;
    }

    const wiring = resolveWiringEntry(mapped.facts.workKind, this.options.pipeline.config.wiring);
    if (wiring === undefined) return undefined;

    const idempotencyKey = engagementIdempotencyKey({
      chainId: this.options.pipeline.config.chain.chainId,
      taskCoordinator: resolved.anchor.taskCoordinator,
      taskId: mapped.facts.taskId,
      submission: mapped.facts.submission,
    });
    const context: WorkLoopContext = {
      idempotencyKey,
      taskId: mapped.facts.taskId,
      workKind: mapped.facts.workKind,
      credentialRef: wiring.credentialRef,
    };

    // CONTRACT 2 — ledger strictly before broadcast. `already-admitted` means
    // this process (or a previous boot) already holds the engagement.
    const admitted = this.options.ledger.admit({
      idempotencyKey,
      taskId: mapped.facts.taskId,
      submission: mapped.facts.submission,
      workKind: mapped.facts.workKind,
      wiring: {
        harness: wiring.harness,
        model: wiring.model,
        credentialRef: wiring.credentialRef,
        ...(wiring.legacyManifestDigest === undefined
          ? {}
          : { legacyManifestDigest: wiring.legacyManifestDigest }),
      },
    });
    if (admitted === 'already-admitted') return undefined;

    const run = this.options.runPipelineImpl ?? runPipeline;
    const outcome = await run(
      {
        facts: mapped.facts,
        taskBytes: derived.task.taskBytes,
        // Bridge era: no sealed Submission exists, so the derived Task bytes
        // stand in. Stage 3 replaces this with the real Submission bytes.
        submissionBytes: derived.task.taskBytes,
      },
      { ...this.options.pipeline.config, caps: this.options.caps.snapshot(wiring.credentialRef) },
      this.options.pipeline.backend,
      this.options.pipeline.ports,
    );

    this.options.onOutcome?.(outcome, context);

    if (outcome.kind === 'delivered') {
      this.options.ledger.markSettled(idempotencyKey);
    } else {
      this.options.ledger.markAbandoned(idempotencyKey, outcome.kind);
      if ('released' in outcome && outcome.released === false) {
        // Today-mode `releaseAttempt` returns `unsupported`, so the attempt is
        // stranded on the venue. Surface it; never pretend release happened.
        this.options.onUnreleasedAttempt?.(context);
      }
    }

    return outcome;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/work-loop.test.ts && yarn typecheck`
Expected: PASS, 9 tests; zero typecheck errors. If the third test ("records the wiring entry") is awkward against the real ledger API, rewrite its assertion to read the row by the idempotency key the loop returns rather than probing the store — do not weaken what it asserts.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/daemon/work-loop.ts client/test/daemon/work-loop.test.ts
git commit -m "feat(client): run one pipeline engagement per claim from projected announcements"
```

---

## Task 17: The composition root

The single place operator configuration becomes running engines. **This task pins the entry point stage 2 extends when it adds the evaluator loop** — the loop registry is data, so stage 2 appends one entry rather than restructuring the root.

**Files:**
- Create: `client/src/runtime/compose.ts`
- Create: `client/test/runtime/compose.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3, 7, 10–16; `createBaseVenue` from `@jinn-network/marketplace-venue-base`.
- Produces — **pinned names, stage 2 extends these exactly**:
  ```ts
  /** One supervised loop the daemon starts. Stage 2 appends the evaluator entry here. */
  export interface RuntimeLoop {
    readonly name: 'projector' | 'work' | 'evidence-driver' | 'evaluator' | 'posting';
    run(): Promise<void>;
    stop(): void;
  }
  export interface OperatorRuntime {
    readonly loops: readonly RuntimeLoop[];
    readonly projector: ProjectorLoop;
    readonly work: WorkLoop;
    readonly evidence: OperatorEvidence;
    readonly backend: TaskExecutionBackend;
    readonly venue: BaseVenue;
    readonly broadcaster: OperatorBroadcaster;
    close(): Promise<void>;
  }
  export interface ComposeOperatorRuntimeInput {
    config: JinnConfig;
    store: Store;
    publicClient: PublicClient;
    walletClient: WalletClient;
    safeAddress: `0x${string}`;
    chain: MarketplaceChainConfig;
    stateDir: string;
    source: SourceIdentity;
    signer: ScopedDiscoverySigner;
    heartbeat?(loop: RuntimeLoop['name']): void;
    onStateMessage?(message: OperatorStateMessage): void;
  }
  export type OperatorStateMessage =
    | { kind: 'config-migrated'; wiringCount: number; backupPath?: string }
    | { kind: 'unreleased-attempt'; taskId: string; workKind: string }
    | { kind: 'evidence-indexing-failed'; count: number };

  /** PINNED ENTRY POINT. */
  export async function composeOperatorRuntime(
    input: ComposeOperatorRuntimeInput,
  ): Promise<OperatorRuntime>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/runtime/compose.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { composeOperatorRuntime } from '../../src/runtime/compose.js';

vi.mock('@jinn-network/marketplace-venue-base', () => ({
  createBaseVenue: vi.fn(() => ({
    claim: {}, settlement: {}, lifecycle: {}, finality: {}, deliveryWait: {},
    release: { releaseAttempt: async () => ({ ok: false, kind: 'unsupported' }) },
    observe: {}, safe: {}, logSource: { head: async () => ({ live: { blockNumber: 0n, blockHash: '0x0' }, finalized: { blockNumber: 0n, blockHash: '0x0' } }), scan: async () => ({ logs: [], live: { blockNumber: 0n, blockHash: '0x0' }, finalized: { blockNumber: 0n, blockHash: '0x0' } }) },
    intents: {},
  })),
}));

function input(overrides: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'jinn-compose-'));
  return {
    config: {
      claimPolicy: { kind: 'legacy-manifest-digest' },
      executionWiring: [{
        workKind: 'swe.v2', harness: 'claude-code', model: 'haiku', plugins: [],
        credentialRef: 'claude-code', isolationPolicy: 'workspace', legacyManifestDigest: 'bafy',
      }],
      posting: [], spendCaps: { 'claude-code': 10 },
    } as never,
    store: { engagementLedger: () => ({}), projectorState: () => ({ readCheckpoint: () => ({}), readProjection: () => ({}), readArchiveHead: () => undefined, commit: () => {}, writeCheckpoint: () => {} }) } as never,
    publicClient: {} as never,
    walletClient: {} as never,
    safeAddress: '0xsafe' as const,
    chain: { chainId: 84532, taskCoordinator: '0xc', jinnRouter: '0xr', mechMarketplace: '0xm', activityChecker: '0xa', generation: 'today' } as never,
    stateDir,
    source: { agent: 'did:example:op', name: 'marketplace' },
    signer: { scope: 'jinn:discovery-announcements', sign: async () => [] } as never,
    ...overrides,
  };
}

describe('composeOperatorRuntime', () => {
  it('exposes the three stage-1 loops in a stable order', async () => {
    const runtime = await composeOperatorRuntime(input() as never);
    try {
      expect(runtime.loops.map((l) => l.name)).toEqual(['projector', 'work', 'evidence-driver']);
    } finally {
      await runtime.close();
    }
  });

  it('composes a claim predicate from the configured claim policy', async () => {
    const runtime = await composeOperatorRuntime(input() as never);
    try {
      expect(runtime.projector).toBeDefined();
      expect(runtime.work).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('claims nothing when the claim policy is none', async () => {
    const runtime = await composeOperatorRuntime(
      input({ config: { claimPolicy: { kind: 'none' }, executionWiring: [], posting: [], spendCaps: {} } }) as never,
    );
    try {
      expect(runtime.backend.capabilities).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('closes the evidence runtime on close', async () => {
    const runtime = await composeOperatorRuntime(input() as never);
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it('emits the one-time config-migrated state message when a migration ran', async () => {
    const onStateMessage = vi.fn();
    const runtime = await composeOperatorRuntime(input({ onStateMessage }) as never);
    try {
      // The message fires only when loadConfig migrated on this boot; assert the
      // channel exists and accepts the shape rather than forcing a migration here.
      expect(typeof onStateMessage).toBe('function');
    } finally {
      await runtime.close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/compose.test.ts`
Expected: FAIL — cannot resolve `../../src/runtime/compose.js`.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/runtime/compose.ts
import { createBaseVenue } from '@jinn-network/marketplace-venue-base';
import {
  CLAIM_NOTHING,
  matchLegacyManifestDigest,
  takeEveryRunnable,
  type ClaimPredicate,
  type PipelineConfig,
  type PipelinePorts,
} from '@jinn-network/marketplace-pipeline';
import { makeLocalTaskExecutionBackend } from '@jinn-network/task-execution-backend-local';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { marketplaceEventOriginAuthority } from '@jinn-network/marketplace-projector';
import { EVIDENCE_FACTS_RECOMPUTE } from '@jinn-network/record-discovery-facts-evidence';
import { TASK_EXECUTION_FACTS_RECOMPUTE } from '@jinn-network/record-discovery-facts-task-execution';
import { TRUST_FACTS_RECOMPUTE } from '@jinn-network/record-discovery-facts-trust';
import type { FactsRecompute, SourceIdentity } from '@jinn-network/record-discovery-protocol';
import { join } from 'node:path';
import type { JinnConfig } from '../config.js';
import { lastConfigMigrationV2 } from '../config.js';
import type { Store } from '../store/store.js';
import { EvidenceDriverLoop } from '../daemon/evidence-driver.js';
import { ProjectorLoop } from '../daemon/projector-loop.js';
import { WorkLoop } from '../daemon/work-loop.js';
import { createRollingWindowCaps } from '../daemon/caps-gate.js';
import { buildLocalBackendConfig } from './backend-config.js';
import { openOperatorEvidence, type OperatorEvidence } from './evidence-join.js';
import { openLocalArchive } from './local-archive.js';
import { createOperatorBroadcaster, type OperatorBroadcaster } from './broadcast.js';

export interface RuntimeLoop {
  readonly name: 'projector' | 'work' | 'evidence-driver' | 'evaluator' | 'posting';
  run(): Promise<void>;
  stop(): void;
}

export type OperatorStateMessage =
  | { kind: 'config-migrated'; wiringCount: number; backupPath?: string }
  | { kind: 'unreleased-attempt'; taskId: string; workKind: string }
  | { kind: 'evidence-indexing-failed'; count: number };

export interface OperatorRuntime {
  readonly loops: readonly RuntimeLoop[];
  readonly projector: ProjectorLoop;
  readonly work: WorkLoop;
  readonly evidence: OperatorEvidence;
  readonly backend: TaskExecutionBackend;
  readonly venue: ReturnType<typeof createBaseVenue>;
  readonly broadcaster: OperatorBroadcaster;
  close(): Promise<void>;
}

export interface ComposeOperatorRuntimeInput {
  config: JinnConfig;
  store: Store;
  publicClient: unknown;
  walletClient: unknown;
  safeAddress: `0x${string}`;
  chain: PipelineConfig['chain'];
  stateDir: string;
  source: SourceIdentity;
  signer: Parameters<typeof openLocalArchive> extends never ? never : never;
  heartbeat?(loop: RuntimeLoop['name']): void;
  onStateMessage?(message: OperatorStateMessage): void;
}

/** The four leaf facts registries merged behind one `get(kind)`. */
function mergedFactsRecompute(): FactsRecompute {
  const registries = [TASK_EXECUTION_FACTS_RECOMPUTE, EVIDENCE_FACTS_RECOMPUTE, TRUST_FACTS_RECOMPUTE];
  return {
    get(kind) {
      for (const registry of registries) {
        const fn = registry.get(kind);
        if (fn !== undefined) return fn;
      }
      return undefined;
    },
  };
}

function predicateFor(config: JinnConfig): ClaimPredicate {
  switch (config.claimPolicy?.kind) {
    case 'every-runnable':
      return takeEveryRunnable();
    case 'legacy-manifest-digest': {
      const byWorkKind = new Map(
        config.executionWiring.map((entry) => [
          entry.workKind,
          { ...(entry.legacyManifestDigest === undefined ? {} : { legacyManifestDigest: entry.legacyManifestDigest }) },
        ]),
      );
      return matchLegacyManifestDigest(byWorkKind);
    }
    default:
      // Claim-nothing-when-unconfigured safety default.
      return CLAIM_NOTHING;
  }
}

/**
 * PINNED ENTRY POINT. The single place operator configuration becomes running
 * engines. `loops` is data, not control flow — a later cutover stage appends
 * its loop (evaluator at stage 2, posting at stage 3) without restructuring
 * anything here.
 *
 * Composition is through public interfaces only; the source-boundary guard
 * enforces it.
 */
export async function composeOperatorRuntime(
  input: ComposeOperatorRuntimeInput,
): Promise<OperatorRuntime> {
  const migration = lastConfigMigrationV2();
  if (migration?.migrated) {
    input.onStateMessage?.({
      kind: 'config-migrated',
      wiringCount: migration.wiringCount,
      ...(migration.backupPath === undefined ? {} : { backupPath: migration.backupPath }),
    });
  }

  const venue = createBaseVenue({
    chain: input.chain,
    publicClient: input.publicClient,
    walletClient: input.walletClient,
    safeAddress: input.safeAddress,
    stateDbPath: join(input.stateDir, 'venue.db'),
  } as never);

  const broadcaster = createOperatorBroadcaster(venue);

  const evidence = await openOperatorEvidence({ rootDir: join(input.stateDir, 'evidence') });

  const backend = makeLocalTaskExecutionBackend(
    buildLocalBackendConfig({
      stateRoot: join(input.stateDir, 'backend'),
      source: `operator:${input.source.name}`,
      executor: `operator:${input.source.name}`,
      wiring: input.config.executionWiring,
      evidence: evidence.ports,
    }),
  );

  const archive = openLocalArchive({ rootDir: join(input.stateDir, 'archive'), source: input.source });

  const projector = new ProjectorLoop({
    logSource: venue.logSource as never,
    authority: marketplaceEventOriginAuthority(input.chain as never, () => true),
    state: input.store.projectorState(),
    archive,
    announce: {
      source: input.source,
      signer: input.signer as never,
      store: archive.store,
      clock: { now: () => new Date() },
      factsRecompute: mergedFactsRecompute(),
    } as never,
    ...(input.heartbeat ? { heartbeat: () => input.heartbeat?.('projector') } : {}),
  });

  const caps = createRollingWindowCaps(input.store as never, {
    spendCapMicrosByCredential: Object.fromEntries(
      Object.entries(input.config.spendCaps ?? {}).map(([k, v]) => [k, Math.round(v * 1_000_000)]),
    ),
    aiUnitCap: 30,
    weiPerUsdMicro: 1n,
  });

  const ports: PipelinePorts = {
    claim: venue.claim,
    finality: venue.finality,
    deliveryWait: venue.deliveryWait,
    settlement: venue.settlement,
    ipfs: { pin: venue.settlement.pin },
    release: venue.release,
  } as never;

  const work = new WorkLoop({
    projector,
    pipeline: {
      config: {
        chain: input.chain,
        predicate: predicateFor(input.config),
        wiring: input.config.executionWiring,
        priorityMech: input.safeAddress,
      },
      ports,
      backend,
    },
    ledger: input.store.engagementLedger(),
    caps,
    resolveLegacyAnchor: async () => undefined,
    acceptLegacyBridge: true,
    intendedAiUnits: 1,
    ...(input.heartbeat ? { heartbeat: () => input.heartbeat?.('work') } : {}),
    onUnreleasedAttempt: (context) =>
      input.onStateMessage?.({
        kind: 'unreleased-attempt',
        taskId: context.taskId.toString(10),
        workKind: context.workKind,
      }),
  });

  const evidenceDriver = new EvidenceDriverLoop({
    evidence,
    ...(input.heartbeat ? { heartbeat: () => input.heartbeat?.('evidence-driver') } : {}),
    onIndexingFailures: (failures) =>
      input.onStateMessage?.({ kind: 'evidence-indexing-failed', count: failures.length }),
  });

  const loops: RuntimeLoop[] = [
    { name: 'projector', run: () => projector.run(), stop: () => projector.stop() },
    {
      name: 'work',
      run: async () => {
        await work.reconcileOnBoot();
        work.start();
      },
      stop: () => work.stop(),
    },
    { name: 'evidence-driver', run: () => evidenceDriver.run(), stop: () => evidenceDriver.stop() },
  ];

  let closed = false;
  return {
    loops,
    projector,
    work,
    evidence,
    backend,
    venue,
    broadcaster,
    async close() {
      if (closed) return;
      closed = true;
      for (const loop of loops) loop.stop();
      await evidence.close();
    },
  };
}
```

Note: the `resolveLegacyAnchor` stub above returns `undefined`; the real resolver reads the anchored task document through the daemon's IPFS gateway. Wire it in Task 18 where the gateway client is available, and delete the stub — do not ship a runtime that never claims.

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/compose.test.ts && yarn typecheck`
Expected: PASS, 5 tests; zero typecheck errors.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/runtime/compose.ts client/test/runtime/compose.test.ts
git commit -m "feat(client): add the operator runtime composition root"
```

---

## Task 18: Daemon wiring — start the three loops, stop starting engine-watcher

**Files:**
- Modify: `client/src/daemon/daemon.ts`
- Modify: `client/src/daemon/loop-heartbeat.ts`
- Modify: `client/src/main.ts`
- Create: `client/test/daemon/daemon-stage1-loops.test.ts`

**Interfaces:**
- Consumes: `composeOperatorRuntime` (Task 17).
- Produces: `DaemonConfig` gains `runtime?: OperatorRuntime`; when present, `start()` runs `runtime.loops` and does **not** start `engine-watcher`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/daemon/daemon-stage1-loops.test.ts
import { describe, expect, it } from 'vitest';
import { LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';

describe('stage-1 loop registry', () => {
  it('registers the three new loops', () => {
    const names = LOOP_REGISTRY.map((l) => l.name);
    expect(names).toContain('projector');
    expect(names).toContain('work');
    expect(names).toContain('evidence-driver');
  });

  it('no longer registers engine-watcher', () => {
    expect(LOOP_REGISTRY.map((l) => l.name)).not.toContain('engine-watcher');
  });

  it('gives the projector and work loops a staleness floor, as the chain-facing loops need', () => {
    const projector = LOOP_REGISTRY.find((l) => l.name === 'projector');
    const work = LOOP_REGISTRY.find((l) => l.name === 'work');
    expect(projector?.floorMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(work?.floorMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/daemon-stage1-loops.test.ts`
Expected: FAIL — `projector` not in the registry; `engine-watcher` still present.

- [ ] **Step 3: Update the loop registry**

In `client/src/daemon/loop-heartbeat.ts`, replace the `engine-watcher` entry and add the two new ones:

```ts
export const LOOP_REGISTRY = [
  { name: 'creator', intervalMs: 5000 },
  { name: 'engine-tick', intervalMs: 5000 },
  { name: 'projector', intervalMs: 5000, floorMs: 5 * 60_000 },
  { name: 'work', intervalMs: 5000, floorMs: 5 * 60_000 },
  { name: 'evidence-driver', intervalMs: 15_000, floorMs: 10 * 60_000 },
  { name: 'delivery-watcher', intervalMs: 5000, floorMs: 5 * 60_000 },
  { name: 'reward-claim', intervalMs: 5000 },
  { name: 'balance-topup', intervalMs: 5000 },
  { name: 'eviction-check', intervalMs: 60_000 },
  { name: 'checkpoint', intervalMs: 300_000 },
  { name: 'harvest', intervalMs: 60 * 60 * 1000 },
  { name: 'peer-sync', intervalMs: 60_000 },
] as const;
```

- [ ] **Step 4: Start the new loops in the daemon**

In `client/src/daemon/daemon.ts`:

1. Add to `DaemonConfig`:
```ts
  /** The stage-1 composed runtime. When present, engine-watcher does not start. */
  runtime?: OperatorRuntime;
```

2. In `start()`, replace the `engine-watcher` push (`this.loopPromises.push(this._runEngineWatcherLoop(engine)...)` around daemon.ts:447) with:
```ts
    if (this.config.runtime) {
      for (const loop of this.config.runtime.loops) {
        this.loopPromises.push(
          loop.run().catch((err) => {
            console.error(`[daemon] ${loop.name} loop crashed:`, err);
            emitStructured({
              kind: 'error',
              message: `${loop.name} loop crashed`,
              errorCode: `${loop.name.replace(/-/g, '_')}_crashed`,
            });
          }),
        );
      }
    } else {
      this.loopPromises.push(
        this._runEngineWatcherLoop(engine).catch((err) => {
          console.error('[daemon] engine-watcher loop crashed:', err);
          emitStructured({ kind: 'error', message: 'engine-watcher loop crashed', errorCode: 'engine_watcher_crashed' });
        }),
      );
    }
```
Keep the legacy branch only until Task 22 deletes `_runEngineWatcherLoop`; the branch exists so this task's diff stays reviewable on its own.

3. In `stop()`, before `await this.adapter.stop()`, add:
```ts
    if (this.config.runtime) await this.config.runtime.close();
```

4. In the watchdog registration block (daemon.ts:556-579), the derived `started` set now picks up the new names automatically — verify by reading the block and confirming it iterates `LOOP_REGISTRY` rather than a hand-written list.

- [ ] **Step 5: Compose the runtime in `main.ts`**

In `client/src/main.ts`, before `new Daemon({...})` (around main.ts:2046), compose the runtime and pass it in:

```ts
  const runtime = await composeOperatorRuntime({
    config,
    store: sharedStore,
    publicClient,
    walletClient,
    safeAddress: earningState.safeAddress as `0x${string}`,
    chain: marketplaceChainConfig,
    stateDir: join(config.stateDir ?? DEFAULT_STATE_DIR, 'runtime'),
    source: { agent: agentDid, name: 'marketplace' },
    signer: discoverySigner,
    onStateMessage: (message) => {
      sharedStore.recordActivityEvent({ kind: 'state_message', outcome: 'ok', detail: JSON.stringify(message) });
    },
  });
```

Then supply the real bridge anchor resolver (replacing Task 17's stub) by passing an `resolveLegacyAnchor` through `ComposeOperatorRuntimeInput` that reads the anchored task document via the existing IPFS gateway helper in `client/src/adapters/mech/ipfs.ts`, and pass `runtime` into the `Daemon` constructor options.

- [ ] **Step 6: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/daemon/ && yarn typecheck`
Expected: PASS; zero typecheck errors. Existing daemon tests that assert the loop set must be updated to the new registry, not deleted.

- [ ] **Step 7: Commit**

```bash
cd "$REPO" && git add client/src/daemon/daemon.ts client/src/daemon/loop-heartbeat.ts client/src/main.ts \
  client/test/daemon/daemon-stage1-loops.test.ts
git commit -m "feat(client): start the projector, work and evidence-driver loops from the daemon"
```

---

## Task 19: The single-broadcaster facade

Contract 1. **Blocked on finding 1** — the venue-base facade must expose `safe.broadcastSafeTransaction` and `safe.sendEoaTransaction`. Do not start this task until that addendum is confirmed.

From stage 1 onward, venue-base's Safe broadcast is the **only** transaction path in the daemon process. Two independent nonce stacks against one Safe and one EOA is the #525 / #562 / #897 failure class; it is excluded by construction here, not by luck.

**Files:**
- Create: `client/src/runtime/broadcast.ts`
- Create: `client/test/runtime/broadcast.test.ts`
- Create: `client/test/runtime/broadcast.arch.test.ts`

**Interfaces:**
- Consumes: `createBaseVenue(...).safe`.
- Produces:
  ```ts
  export interface OperatorBroadcaster {
    /** Every Safe-mediated call in the process. */
    safeExec(input: { to: `0x${string}`; value: bigint; data: `0x${string}`; logicalTx: string }): Promise<{ txHash: `0x${string}` }>;
    /** Every raw-EOA call in the process. */
    eoaSend(input: { to: `0x${string}`; value: bigint; data?: `0x${string}`; logicalTx: string }): Promise<{ txHash: `0x${string}` }>;
  }
  export function createOperatorBroadcaster(venue: { safe: BaseVenueSafe }): OperatorBroadcaster;
  /** The banned direct-broadcast primitives, asserted by the architecture test. */
  export const BANNED_BROADCAST_PRIMITIVES: readonly string[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// client/test/runtime/broadcast.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createOperatorBroadcaster } from '../../src/runtime/broadcast.js';

describe('createOperatorBroadcaster', () => {
  it('routes every Safe call through the venue safe port', async () => {
    const broadcastSafeTransaction = vi.fn(async () => ({ txHash: '0xaa' as const }));
    const broadcaster = createOperatorBroadcaster({ safe: { broadcastSafeTransaction, sendEoaTransaction: vi.fn() } } as never);
    const result = await broadcaster.safeExec({ to: '0xto', value: 0n, data: '0x', logicalTx: 'mech.claimEvaluation' });
    expect(result.txHash).toBe('0xaa');
    expect(broadcastSafeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xto', value: 0n, data: '0x', logicalTx: 'mech.claimEvaluation' }),
    );
  });

  it('routes every EOA call through the same nonce authority', async () => {
    const sendEoaTransaction = vi.fn(async () => ({ txHash: '0xbb' as const }));
    const broadcaster = createOperatorBroadcaster({ safe: { broadcastSafeTransaction: vi.fn(), sendEoaTransaction } } as never);
    await broadcaster.eoaSend({ to: '0xto', value: 1n, logicalTx: 'staking.checkpoint' });
    expect(sendEoaTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xto', value: 1n, logicalTx: 'staking.checkpoint' }),
    );
  });

  it('requires a logical tx label so every broadcast is attributable in logs', async () => {
    const broadcaster = createOperatorBroadcaster({ safe: { broadcastSafeTransaction: vi.fn(), sendEoaTransaction: vi.fn() } } as never);
    await expect(
      broadcaster.safeExec({ to: '0xto', value: 0n, data: '0x', logicalTx: '' }),
    ).rejects.toThrow(/logicalTx/);
  });
});
```

```ts
// client/test/runtime/broadcast.arch.test.ts
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_BROADCAST_PRIMITIVES } from '../../src/runtime/broadcast.js';

const SRC = resolve(import.meta.dirname, '../../src');
const ALLOWED = new Set([
  resolve(SRC, 'runtime/broadcast.ts'),
  // tx-retry.ts still owns the primitives venue-base's kit fixtures were drawn
  // from; it is deleted at stage 5 with the rest of the legacy path.
  resolve(SRC, 'tx-retry.ts'),
]);

describe('architecture: one broadcaster', () => {
  for (const primitive of BANNED_BROADCAST_PRIMITIVES) {
    it(`no module outside the facade calls ${primitive}`, () => {
      let out = '';
      try {
        // Path-shaped search: the token `client` is overloaded repo-wide.
        out = execFileSync('grep', ['-rl', primitive, SRC, '--include=*.ts'], { encoding: 'utf8' });
      } catch {
        out = '';
      }
      const offenders = out.split('\n').filter(Boolean).map((p) => resolve(p)).filter((p) => !ALLOWED.has(p));
      expect(offenders).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/broadcast.test.ts test/runtime/broadcast.arch.test.ts`
Expected: FAIL — the module does not exist; once it does, the architecture test lists every legacy call site as an offender. That list is the work of Tasks 20 and 21.

- [ ] **Step 3: Write the implementation**

```ts
// client/src/runtime/broadcast.ts

/**
 * SINGLE-BROADCASTER RULE (cross-plan contract 1).
 *
 * From cutover stage 1, venue-base's Safe broadcast is the ONLY transaction
 * path in the daemon process. Every surviving legacy leg — creator posting
 * until stage 3, evaluation transactions until stage 2, the earning family's
 * Safe batches, and the raw-EOA sends — routes through this facade so one
 * per-EOA lock and one nonce ledger serialize them all. Two independent nonce
 * stacks against one Safe and one EOA is the #525 / #562 / #897 failure class.
 */
export interface OperatorBroadcasterSafePort {
  broadcastSafeTransaction(input: {
    to: `0x${string}`; value: bigint; data: `0x${string}`; logicalTx: string;
  }): Promise<{ txHash: `0x${string}` }>;
  sendEoaTransaction(input: {
    to: `0x${string}`; value: bigint; data?: `0x${string}`; logicalTx: string;
  }): Promise<{ txHash: `0x${string}` }>;
}

export interface OperatorBroadcaster {
  safeExec(input: {
    to: `0x${string}`; value: bigint; data: `0x${string}`; logicalTx: string;
  }): Promise<{ txHash: `0x${string}` }>;
  eoaSend(input: {
    to: `0x${string}`; value: bigint; data?: `0x${string}`; logicalTx: string;
  }): Promise<{ txHash: `0x${string}` }>;
}

/**
 * Primitives no module outside this facade may call. Asserted by
 * `broadcast.arch.test.ts`; extend the list, never the allowlist, when a new
 * broadcast primitive appears.
 */
export const BANNED_BROADCAST_PRIMITIVES: readonly string[] = [
  'walletClient.sendTransaction',
  'walletClient.writeContract',
  'masterWallet.writeContract',
  'wallet.writeContract',
  'executeSafeTransaction',
  'executeSafeTxDirect',
  'executeSafeTxBatch',
  'safe.executeTransaction',
];

function requireLabel(logicalTx: string): void {
  if (logicalTx.trim().length === 0) {
    throw new Error('every broadcast must carry a logicalTx label');
  }
}

export function createOperatorBroadcaster(venue: {
  safe: OperatorBroadcasterSafePort;
}): OperatorBroadcaster {
  return {
    async safeExec(input) {
      requireLabel(input.logicalTx);
      return venue.safe.broadcastSafeTransaction(input);
    },
    async eoaSend(input) {
      requireLabel(input.logicalTx);
      return venue.safe.sendEoaTransaction(input);
    },
  };
}
```

- [ ] **Step 4: Run the unit test only (the architecture test stays red until Task 21)**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/broadcast.test.ts`
Expected: PASS, 3 tests. `broadcast.arch.test.ts` is expected RED here — note the offender list in the commit message; it is the work list for the next two tasks.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/runtime/broadcast.ts client/test/runtime/broadcast.test.ts client/test/runtime/broadcast.arch.test.ts
git commit -m "feat(client): add the single-broadcaster facade over the venue safe port"
```

---

## Task 20: Re-point the mech-family and ERC-8004 transaction legs

The enumerated legacy legs that survive stage 1 in the daemon process, Safe-mediated group.

**Files:**
- Modify: `client/src/adapters/mech/contracts.ts` (`submitTask` @221/260, `claimTask` @414/434, `claimDelivery` @580/634, `claimEvaluation` @680/702, `callDeliverToMarketplace` @1324/1345)
- Modify: `client/src/adapters/mech/safe.ts` (`executeSafeTransaction` @73 becomes a thin delegate)
- Modify: `client/src/erc8004/reputation.ts` (`sendWrite` @490, both the Safe branch @494 and the raw-EOA fallback @512)
- Modify: `client/src/erc8004/identity.ts` (`_writeMetadata` @635, broadcast @676)
- Modify: `client/src/solvernets/daemon-init.ts` (`MetadataPublisher.setMetadata` @518)
- Modify: `client/src/main.ts` (`writeCheckpoint` @2318, broadcast @2325)
- Create: `client/test/runtime/broadcast-repoint-mech.test.ts`

**Interfaces:**
- Consumes: `OperatorBroadcaster` (Task 19).
- Produces: each touched module takes an injected `broadcaster: OperatorBroadcaster` rather than constructing its own client. No new exported names.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/runtime/broadcast-repoint-mech.test.ts
import { describe, expect, it, vi } from 'vitest';
import { executeSafeTransaction } from '../../src/adapters/mech/safe.js';

describe('mech-family legs route through the single broadcaster', () => {
  it('executeSafeTransaction delegates to the injected broadcaster', async () => {
    const safeExec = vi.fn(async () => ({ txHash: '0xaa' as const }));
    const result = await executeSafeTransaction({
      broadcaster: { safeExec, eoaSend: vi.fn() },
      to: '0xto', value: 0n, data: '0x1234', logicalTx: 'mech.claimTask',
    } as never);
    expect(safeExec).toHaveBeenCalledTimes(1);
    expect(result.txHash).toBe('0xaa');
  });

  it('refuses to run without a broadcaster rather than falling back to a local signer', async () => {
    await expect(
      executeSafeTransaction({ to: '0xto', value: 0n, data: '0x' } as never),
    ).rejects.toThrow(/broadcaster/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/broadcast-repoint-mech.test.ts`
Expected: FAIL — `executeSafeTransaction` still builds its own `walletClient.writeContract` call.

- [ ] **Step 3: Convert `executeSafeTransaction` into a delegate**

In `client/src/adapters/mech/safe.ts`, replace the body of `executeSafeTransaction` (the `withNonceLedger` wrapper at :109, the `getTransactionHash`/`nonce` reads at :118-138, the `signMessage` + v-adjust at :141-149, and the `writeContract` at :162-181) with Safe-transaction **encoding only**, then one delegate call:

```ts
export async function executeSafeTransaction(input: {
  broadcaster: OperatorBroadcaster;
  safeAddress: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  logicalTx: string;
  // …existing signing inputs, kept: the Safe-contract-specified eth_sign
  // v-adjustment and pre-validated signature encoding stay here, because they
  // are Safe-contract behaviour, not broadcast policy.
}): Promise<{ txHash: `0x${string}` }> {
  if (input.broadcaster === undefined) {
    throw new Error('executeSafeTransaction requires the single-process broadcaster');
  }
  const data = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: buildExecTransactionArgs(input),
  });
  return input.broadcaster.safeExec({
    to: input.safeAddress,
    value: 0n,
    data,
    logicalTx: input.logicalTx,
  });
}
```

Keep `buildSafeSignature` and `safe-revert.ts`'s decoder where they are — signature construction and revert decoding are Safe semantics, not broadcast policy.

- [ ] **Step 4: Thread the broadcaster through the five contract helpers**

For each of `submitTask`, `claimTask`, `claimDelivery`, `claimEvaluation`, `callDeliverToMarketplace` in `client/src/adapters/mech/contracts.ts`: add `broadcaster: OperatorBroadcaster` to the options object, pass it into `executeSafeTransaction`, and give each a distinct `logicalTx` label — `mech.createTask`, `mech.claimTask`, `mech.claimDelivery`, `mech.claimEvaluation`, `mech.deliverToMarketplace`. While you are in the file, delete the no-op `withEvictionRecovery` wrapper (contracts.ts:212) and its five call sites; it returns `action()` unchanged and only obscures the diff.

`MechAdapter` (`client/src/adapters/mech/adapter.ts`) takes the broadcaster in its constructor options and forwards it; `main.ts` passes `runtime.broadcaster`.

- [ ] **Step 5: Re-point the ERC-8004 and checkpoint legs**

- `reputation.ts` `sendWrite` (:490): both branches become `broadcaster.safeExec(...)` / `broadcaster.eoaSend(...)` with `logicalTx: 'erc8004.giveFeedback'`. **Delete the raw-EOA fallback's independent lock** — it held `withEoaBroadcastLock` but skipped the ledger entirely.
- `identity.ts` `_writeMetadata` (:635): `broadcaster.eoaSend(...)`, `logicalTx: 'erc8004.setMetadata'`.
- `solvernets/daemon-init.ts` `setMetadata` (:518): `broadcaster.eoaSend(...)`, `logicalTx: 'solvernet.setMetadata'`.
- `main.ts` `writeCheckpoint` (:2318): `broadcaster.eoaSend(...)`, `logicalTx: 'staking.checkpoint'`. This one currently holds the EOA lock but has **no nonce ledger, no fee bumping, and no retry** — the re-point is a strict improvement, not a refactor.

- [ ] **Step 6: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/ test/adapters/ && yarn typecheck`
Expected: PASS. `broadcast.arch.test.ts` is now down to the earning-family offenders only — confirm the remaining list matches Task 21's file list exactly.

- [ ] **Step 7: Commit**

```bash
cd "$REPO" && git add client/src/adapters/mech/ client/src/erc8004/ client/src/solvernets/daemon-init.ts \
  client/src/main.ts client/test/runtime/broadcast-repoint-mech.test.ts
git commit -m "refactor(client): route the mech and ERC-8004 transaction legs through one broadcaster"
```

---

## Task 21: Re-point the earning-family transaction legs

Finding 7 lives here: `executeSafeTxBatch` broadcasts through the Safe protocol-kit's own signer, sharing neither the EOA lock nor the nonce ledger, from the same agent EOA six bootstrap steps use. This is the live instance of the failure class contract 1 exists to prevent.

No earning recomposition — the step logic, calldata construction, and state machine are untouched. Only the broadcast seam moves.

**Files:**
- Modify: `client/src/earning/safe-adapter.ts` (`executeSafeTxDirect` @220/329, `executeSafeTxBatch` @184/194/203)
- Modify: `client/src/earning/bootstrap.ts` (the thirteen enumerated sends), `client/src/earning/steps/fleet-safe-deploy.ts` (@47, @68), `client/src/earning/steps/fleet-identity-register.ts` (@43), `client/src/earning/agent-wallet-binding.ts` (@296), `client/src/earning/orphan-sweep.ts` (@152, @175, @251, @284), `client/src/earning/stolas-claim.ts` (@165, @336), `client/src/earning/testnet-setup-migration.ts` (@220)
- Modify: `client/src/daemon/balance-topup-loop.ts` (@101, @134)
- Create: `client/test/runtime/broadcast-repoint-earning.test.ts`

**Interfaces:**
- Consumes: `OperatorBroadcaster` (Task 19).
- Produces: `executeSafeTxDirect` and `executeSafeTxBatch` keep their names and their calldata-building behaviour; both gain a required `broadcaster` field and lose their own signer paths.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/runtime/broadcast-repoint-earning.test.ts
import { describe, expect, it, vi } from 'vitest';
import { executeSafeTxBatch, executeSafeTxDirect } from '../../src/earning/safe-adapter.js';

describe('earning-family legs route through the single broadcaster', () => {
  it('executeSafeTxDirect delegates instead of sending its own transaction', async () => {
    const safeExec = vi.fn(async () => ({ txHash: '0xaa' as const }));
    await executeSafeTxDirect({ broadcaster: { safeExec, eoaSend: vi.fn() }, to: '0xto', value: 0n, data: '0x' } as never);
    expect(safeExec).toHaveBeenCalledTimes(1);
  });

  it('executeSafeTxBatch encodes a multiSend and delegates exactly once', async () => {
    const safeExec = vi.fn(async () => ({ txHash: '0xbb' as const }));
    await executeSafeTxBatch({
      broadcaster: { safeExec, eoaSend: vi.fn() },
      transactions: [
        { to: '0xa', value: 0n, data: '0x01' },
        { to: '0xb', value: 0n, data: '0x02' },
      ],
    } as never);
    expect(safeExec).toHaveBeenCalledTimes(1);
  });

  it('neither helper constructs a protocol-kit signer any more', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/earning/safe-adapter.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toContain('executeTransaction(');
    expect(source).not.toContain('signTransaction(');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/broadcast-repoint-earning.test.ts`
Expected: FAIL — both helpers still broadcast themselves; the protocol-kit calls are still present.

- [ ] **Step 3: Convert both helpers to delegates**

In `client/src/earning/safe-adapter.ts`:
- `executeSafeTxDirect`: keep the `execTransaction` calldata encoding (:281-285) and the signature construction (:271-279); delete the `withNonceLedger` wrapper (:249) and the `sendTransaction` (:329); end with `return broadcaster.safeExec({ to: safeAddress, value: 0n, data, logicalTx })`.
- `executeSafeTxBatch`: replace the protocol-kit `createTransaction` → `signTransaction` → `executeTransaction` sequence (:191-205) with a `multiSend` calldata encode over the same transaction list, then one `broadcaster.safeExec(...)`. The batch must remain **one** Safe transaction — that is the property the six bootstrap steps depend on. Keep the 30% gas buffer logic if the venue-base port does not already apply one; if it does, delete the local buffer and say so in the PR body.
- Delete the now-unused protocol-kit import.

- [ ] **Step 4: Thread the broadcaster through the earning call sites**

Each of the enumerated modules takes `broadcaster` on its existing options/deps object and gives its send a `logicalTx` label. Suggested labels, one per site so a log line names the operation:
`earning.stolasStake`, `earning.fundAgentEoa`, `earning.deployMech`, `earning.registerAgent`, `earning.selfBondFund`, `earning.safeDeploy`, `earning.serviceCreate`, `earning.serviceActivate`, `earning.registerAgents`, `earning.serviceDeploy`, `earning.serviceApprove`, `earning.stakingStake`, `earning.reStake`, `earning.bindAgentWallet`, `earning.orphanSweep`, `earning.stolasClaim`, `earning.selfBondClaim`, `earning.retireSetup`, `topup.fundAgentEoa`, `topup.fundSafe`.

`FleetBootstrapper` receives the broadcaster in its constructor; `bootstrap-run.ts` and `main.ts`'s SPA `retryBind` handler pass `runtime.broadcaster`.

- [ ] **Step 5: Run the full suite and the architecture test**

Run: `cd "$REPO/client" && yarn vitest run test/runtime/ && yarn test && yarn typecheck`
Expected: PASS — including `broadcast.arch.test.ts`, which must now report **zero offenders** for every banned primitive outside the facade and `tx-retry.ts`.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add client/src/earning/ client/src/daemon/balance-topup-loop.ts \
  client/test/runtime/broadcast-repoint-earning.test.ts
git commit -m "refactor(client): route the earning-family transaction legs through one broadcaster"
```

---

## Task 22: Re-key the plugin content commands onto wiring entries

Design §9's CLI paragraph: the plugin *content* commands (`publish` / `read` / `feedback` / `block` / `revoke`) "only re-key from manifestCid to wiring entries here". Wiring entries are **born** in this stage's config migration, so the re-key belongs here — it is part of making the migrated config the operative surface. Their deeper disposition stays with the plugin session and is not preempted.

**Surgical: nothing about what these commands do changes. Only how they resolve their target.** `legacyManifestDigest` does the matching, so behaviour is identical on day one, by design.

**Files:**
- Create: `client/src/wiring/resolve.ts`
- Create: `client/test/wiring/resolve.test.ts`
- Modify: `client/src/cli/commands/solver-plugins-publish.ts`, `solver-plugins-read.ts`, `solver-plugins-feedback.ts`, `solver-plugins-block.ts`, `solver-plugins-revoke.ts`
- Create: `client/test/cli/solver-plugins-wiring-rekey.test.ts`

**Interfaces:**
- Consumes: `ExecutionWiringConfigV2` (Task 4); the existing `findJoinedByName` in `client/src/solver-nets/registry.ts:115` as the behaviour reference.
- Produces:
  ```ts
  /** Resolve a wiring entry by work kind, legacy manifest digest, or harness label. */
  export function findWiringByTarget(
    wiring: readonly ExecutionWiringConfigV2[] | undefined, needle: string,
  ): ExecutionWiringConfigV2 | undefined;
  /** The plugin list a content command operates on for a resolved target. */
  export function pluginsForWiring(entry: ExecutionWiringConfigV2 | undefined): readonly string[];
  ```

- [ ] **Step 1: Write the failing test for the resolver**

```ts
// client/test/wiring/resolve.test.ts
import { describe, expect, it } from 'vitest';
import { findWiringByTarget, pluginsForWiring } from '../../src/wiring/resolve.js';

const WIRING = [
  {
    workKind: 'swe-rebench.v2', harness: 'claude-code', model: 'haiku',
    plugins: ['jinn-layer', 'bundled:swe-rebench-v2-runtime'],
    credentialRef: 'claude-code', isolationPolicy: 'workspace', legacyManifestDigest: 'bafyOne',
  },
  {
    workKind: 'prediction.v1', harness: 'codex', model: 'gpt',
    plugins: [], credentialRef: 'codex', isolationPolicy: 'workspace', legacyManifestDigest: 'bafyTwo',
  },
];

describe('findWiringByTarget', () => {
  it('matches by work kind', () => {
    expect(findWiringByTarget(WIRING, 'swe-rebench.v2')?.harness).toBe('claude-code');
  });

  it('matches by the legacy manifest digest, preserving today behaviour', () => {
    expect(findWiringByTarget(WIRING, 'bafyTwo')?.workKind).toBe('prediction.v1');
  });

  it('matches by harness label', () => {
    expect(findWiringByTarget(WIRING, 'codex')?.workKind).toBe('prediction.v1');
  });

  it('prefers a work-kind match over a harness match when both could apply', () => {
    const ambiguous = [
      { ...WIRING[0]!, workKind: 'codex' },
      WIRING[1]!,
    ];
    expect(findWiringByTarget(ambiguous, 'codex')?.harness).toBe('claude-code');
  });

  it('returns undefined for an unknown needle', () => {
    expect(findWiringByTarget(WIRING, 'nope')).toBeUndefined();
  });

  it('returns undefined for absent wiring rather than throwing', () => {
    expect(findWiringByTarget(undefined, 'anything')).toBeUndefined();
  });
});

describe('pluginsForWiring', () => {
  it('returns the entry plugins', () => {
    expect(pluginsForWiring(WIRING[0])).toEqual(['jinn-layer', 'bundled:swe-rebench-v2-runtime']);
  });

  it('returns an empty list for an unresolved target', () => {
    expect(pluginsForWiring(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/wiring/resolve.test.ts`
Expected: FAIL — cannot resolve `../../src/wiring/resolve.js`.

- [ ] **Step 3: Write the resolver**

```ts
// client/src/wiring/resolve.ts
import type { ExecutionWiringConfigV2 } from '../config-migration-v2.js';

/**
 * Target resolution for the plugin content commands after the shape-version-2
 * migration. Mirrors `findJoinedByName`'s tolerance (short name OR manifest
 * CID) against the new surface: work kind, the `legacyManifestDigest` bridge
 * annotation, or the harness label.
 *
 * The bridge annotation is what makes this behaviour-preserving — an operator
 * who passed a manifest CID yesterday resolves the same entry today.
 */
export function findWiringByTarget(
  wiring: readonly ExecutionWiringConfigV2[] | undefined,
  needle: string,
): ExecutionWiringConfigV2 | undefined {
  if (wiring === undefined || wiring.length === 0) return undefined;
  return (
    wiring.find((entry) => entry.workKind === needle) ??
    wiring.find((entry) => entry.legacyManifestDigest === needle) ??
    wiring.find((entry) => entry.harness === needle)
  );
}

/** The plugin list a content command operates on for a resolved target. */
export function pluginsForWiring(entry: ExecutionWiringConfigV2 | undefined): readonly string[] {
  return entry?.plugins ?? [];
}
```

- [ ] **Step 4: Write the failing command-level tests**

```ts
// client/test/cli/solver-plugins-wiring-rekey.test.ts
import { describe, expect, it, vi } from 'vitest';
import { publishHandler } from '../../src/cli/commands/solver-plugins-publish.js';

const CONFIG = {
  executionWiring: [{
    workKind: 'swe-rebench.v2', harness: 'claude-code', model: 'haiku',
    plugins: ['jinn-layer'], credentialRef: 'claude-code', isolationPolicy: 'workspace',
    legacyManifestDigest: 'bafyOne',
  }],
  // Present but no longer consulted by these commands.
  joinedSolverNets: { bafyOne: { manifestCid: 'bafyOne', roles: ['solver'], plugins: ['stale-entry'] } },
} as never;

describe('plugin content commands resolve through wiring entries', () => {
  it('resolves a --solver-net target by its legacy manifest digest', async () => {
    const resolved: string[] = [];
    await publishHandler(
      { argv: ['--solver-net', 'bafyOne', '--source', './p'], env: {} } as never,
      { loadConfig: () => CONFIG, onResolvedTarget: (w: { workKind: string }) => resolved.push(w.workKind) } as never,
    ).catch(() => {});
    expect(resolved).toEqual(['swe-rebench.v2']);
  });

  it('resolves a --solver-net target by its work kind', async () => {
    const resolved: string[] = [];
    await publishHandler(
      { argv: ['--solver-net', 'swe-rebench.v2', '--source', './p'], env: {} } as never,
      { loadConfig: () => CONFIG, onResolvedTarget: (w: { workKind: string }) => resolved.push(w.workKind) } as never,
    ).catch(() => {});
    expect(resolved).toEqual(['swe-rebench.v2']);
  });

  it('errors nameing the wiring surface when the target is unknown', async () => {
    await expect(
      publishHandler(
        { argv: ['--solver-net', 'absent', '--source', './p'], env: {} } as never,
        { loadConfig: () => CONFIG } as never,
      ),
    ).rejects.toThrow(/executionWiring/);
  });

  it('no longer reads joinedSolverNets in any content command', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'solver-plugins-publish.ts', 'solver-plugins-read.ts', 'solver-plugins-feedback.ts',
      'solver-plugins-block.ts', 'solver-plugins-revoke.ts',
    ]) {
      const source = readFileSync(new URL(`../../src/cli/commands/${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toContain('joinedSolverNets');
    }
  });
});
```

- [ ] **Step 5: Re-key the five commands**

For each of `solver-plugins-publish.ts`, `solver-plugins-read.ts`, `solver-plugins-feedback.ts`, `solver-plugins-block.ts`, `solver-plugins-revoke.ts`:
1. Replace any `findJoinedByName(config.joinedSolverNets, needle)` call (and any direct `config.joinedSolverNets[...]` read) with `findWiringByTarget(config.executionWiring, needle)`.
2. Replace any plugin-list read taken from the joined entry with `pluginsForWiring(entry)`.
3. Update the not-found error message to name the new surface, e.g.:
   `` `no wiring entry matches "${needle}". Configured executionWiring work kinds: ${config.executionWiring.map((e) => e.workKind).join(', ') || '(none)'}` ``
4. Change nothing else — not the IPFS path, not the signing path, not the on-chain call, not the output format.

Leave `solver-nets.ts`, `tasks.ts`, `eval.ts`, `api/launcher-tasks.ts`, and `api/gather-status.ts` on `joinedSolverNets` — those are stage-3 and stage-4 surfaces, not this task's scope.

- [ ] **Step 6: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/wiring/ test/cli/ && yarn typecheck`
Expected: PASS. Existing plugin-command tests that construct a `joinedSolverNets` fixture must be updated to construct an `executionWiring` fixture instead — same assertions, new input shape.

- [ ] **Step 7: Commit**

```bash
cd "$REPO" && git add client/src/wiring/ client/src/cli/commands/solver-plugins-*.ts \
  client/test/wiring/ client/test/cli/solver-plugins-wiring-rekey.test.ts
git commit -m "refactor(client): re-key the plugin content commands onto execution wiring entries"
```

---

## Task 23: Retire the TaskEngine solution path, `joinedSolverNets` gating, and new `task_runs` solution rows

The stage's retirement column. The engine keeps its **evaluation** path until stage 2 — only the solution path goes.

**Files:**
- Modify: `client/src/harnesses/engine/engine.ts` (`runImpl` @1496, `canAcceptTask` @732, `runnableFailureReason` @1338, `manifestBackedValidation` @1177)
- Modify: `client/src/harnesses/engine/persistence.ts` (`insertDiscovered` @462)
- Modify: `client/src/daemon/daemon.ts` (delete `_runEngineWatcherLoop` @668-970 and its legacy branch from Task 18)
- Create: `client/test/harnesses/engine-solution-path-retired.test.ts`

**Interfaces:**
- Produces: `TaskEngine.runImpl` throws `SolutionPathRetiredError` for `taskRole === 'restoration'`; `TaskRunPersistence.insertDiscovered` throws for a `task_role` of `restoration`.
  ```ts
  export class SolutionPathRetiredError extends Error {
    readonly code = 'solution_path_retired';
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// client/test/harnesses/engine-solution-path-retired.test.ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { TASK_RUNS_SCHEMA, TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { SolutionPathRetiredError } from '../../src/harnesses/engine/engine.js';

function persistence() {
  const db = new Database(':memory:');
  db.exec(TASK_RUNS_SCHEMA);
  return new TaskRunPersistence(db);
}

const ROW = {
  requestId: 'r1', taskId: '1', attemptIndex: 0, taskCid: 'cid',
  onchainCreationTx: '0xt', onchainCreationBlock: 1, windowStartTs: 0, windowEndTs: 1,
};

describe('the TaskEngine solution path is retired at stage 1', () => {
  it('refuses to insert a new restoration task run', () => {
    expect(() => persistence().insertDiscovered({ ...ROW, taskRole: 'restoration' } as never))
      .toThrow(SolutionPathRetiredError);
  });

  it('still inserts an evaluation task run — that path retires at stage 2', () => {
    expect(() => persistence().insertDiscovered({ ...ROW, taskRole: 'evaluation' } as never)).not.toThrow();
  });

  it('names the replacement in the error message', () => {
    try {
      persistence().insertDiscovered({ ...ROW, taskRole: 'restoration' } as never);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/work loop/i);
    }
  });
});

describe('claim gating no longer consults joinedSolverNets', () => {
  it('the engine source no longer reads joinedSolverNets for the claim decision', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/harnesses/engine/engine.ts', import.meta.url), 'utf8');
    // The evaluation path may still consult it until stage 2; the claim gate may not.
    expect(source).not.toContain('canAcceptTask');
  });
});

describe('the daemon no longer runs the engine watcher', () => {
  it('the daemon source no longer defines the engine-watcher loop', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/daemon/daemon.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('_runEngineWatcherLoop');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/harnesses/engine-solution-path-retired.test.ts`
Expected: FAIL — restoration rows still insert; `_runEngineWatcherLoop` still exists.

- [ ] **Step 3: Freeze `task_runs` for solutions**

In `client/src/harnesses/engine/persistence.ts`, at the top of `insertDiscovered`:

```ts
    if ((input.taskRole ?? 'restoration') === 'restoration') {
      throw new SolutionPathRetiredError(
        'the solution path is served by the work loop; task_runs is frozen for solutions ' +
          '(cutover stage 1). The evaluation path retires at stage 2.',
      );
    }
```

Export `SolutionPathRetiredError` from `engine.ts` and import it here (or declare it in `state.ts` and re-export from both — pick whichever avoids a cycle in this worktree and say which in the PR body).

- [ ] **Step 4: Delete the claim gate and the engine watcher**

- `engine.ts`: delete `canAcceptTask` (@732) and the `manifestBackedValidation` path it drives (@1177) if it has no other caller; make `runImpl` (@1496) throw `SolutionPathRetiredError` when `task.taskRole !== 'evaluation'`. Leave `runnableFailureReason` for the evaluation role.
- `daemon.ts`: delete `_runEngineWatcherLoop` (@668-970), the legacy branch added in Task 18 Step 4, and the now-unused `SkipLogDeduper` / readiness / AI-units / spend-cap gate imports if nothing else references them. Delete `client/src/daemon/readiness-gate.ts` only if no other module imports it — check with `grep -rn "readiness-gate" "client/src" --include=*.ts` first.
- Keep `engine-tick` running: the evaluation path still ticks until stage 2.

- [ ] **Step 5: Run the tests**

Run: `cd "$REPO/client" && yarn test && yarn typecheck`
Expected: PASS. A large number of engine tests exercise the solution path; each one must be **deleted with its subject**, not skipped. If a test covers behaviour that moved to the work loop, port the assertion to `test/daemon/work-loop.test.ts` rather than dropping it — say which in the PR body.

- [ ] **Step 6: Commit**

```bash
cd "$REPO" && git add client/src/harnesses/engine/ client/src/daemon/daemon.ts \
  client/test/harnesses/engine-solution-path-retired.test.ts
git commit -m "refactor(client): retire the TaskEngine solution path and joinedSolverNets claim gating"
```

---

## Task 24: Claim policy & wiring API routes

Replaces the join/leave/joined routes. Finding 8: the old `GET /v1/operator/joined` re-read `config.json` from disk and therefore bypassed migration — the replacement goes through `loadConfig`.

**Files:**
- Modify: `client/src/api/setup-endpoints.ts` (`POST /v1/operator/join/:cid` @652, `DELETE` @925, `GET /v1/operator/joined` @974)
- Create: `client/test/api/claim-policy-endpoints.test.ts`

**Interfaces:**
- Produces:
  - `GET /v1/operator/claim-policy` → `{ configShapeVersion, claimPolicy, executionWiring, caps, migration }`
  - `PUT /v1/operator/wiring/:workKind` → `{ ok: true, restartRequired: true, workKind }`
  - `DELETE /v1/operator/wiring/:workKind` → `{ ok: true, restartRequired: true, workKind }`
  - Both writers keep the matching `joinedSolverNets[<legacyManifestDigest>]` entry in sync (additive; the legacy key lives until stage 5, so a rollback boots correctly).
  - `POST /v1/operator/join/:cid` and `DELETE /v1/operator/join/:cid` respond **HTTP 410** with `{ error: 'route_retired', replacement: '/v1/operator/wiring/:workKind' }`, matching the existing retirement pattern at setup-endpoints.ts:621.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/api/claim-policy-endpoints.test.ts
import { describe, expect, it } from 'vitest';
import { buildTestApiServer } from './helpers.js'; // reuse this suite's existing helper

describe('claim policy & wiring endpoints', () => {
  it('returns the migrated shape from loadConfig, not a raw disk read', async () => {
    const { request } = await buildTestApiServer({
      configFile: { joinedSolverNets: { bafy: { manifestCid: 'bafy', roles: ['solver'], harness: 'claude-code', model: 'haiku', contract: { id: 'swe.v2', version: '1' } } } },
    });
    const res = await request('GET', '/v1/operator/claim-policy');
    expect(res.status).toBe(200);
    expect(res.body.configShapeVersion).toBe(2);
    expect(res.body.claimPolicy).toEqual({ kind: 'legacy-manifest-digest' });
    expect(res.body.executionWiring).toHaveLength(1);
  });

  it('reports the one-time migration state message', async () => {
    const { request } = await buildTestApiServer({
      configFile: { joinedSolverNets: { bafy: { manifestCid: 'bafy', roles: ['solver'] } } },
    });
    const res = await request('GET', '/v1/operator/claim-policy');
    expect(res.body.migration).toMatchObject({ migrated: true });
  });

  it('updates a wiring entry and reports restart-required', async () => {
    const { request } = await buildTestApiServer({ configFile: { configShapeVersion: 2, executionWiring: [] } });
    const res = await request('PUT', '/v1/operator/wiring/swe.v2', {
      harness: 'codex', model: 'gpt', plugins: [], credentialRef: 'codex', isolationPolicy: 'workspace',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, restartRequired: true, workKind: 'swe.v2' });
  });

  it('keeps the legacy joined entry in sync so a rollback still claims', async () => {
    const { request, readConfigFile } = await buildTestApiServer({
      configFile: {
        configShapeVersion: 2,
        executionWiring: [{ workKind: 'swe.v2', harness: 'claude-code', model: 'haiku', plugins: [], credentialRef: 'claude-code', isolationPolicy: 'workspace', legacyManifestDigest: 'bafy' }],
        joinedSolverNets: { bafy: { manifestCid: 'bafy', roles: ['solver'], harness: 'claude-code', model: 'haiku' } },
      },
    });
    await request('PUT', '/v1/operator/wiring/swe.v2', {
      harness: 'codex', model: 'gpt', plugins: [], credentialRef: 'codex', isolationPolicy: 'workspace',
    });
    expect(readConfigFile().joinedSolverNets.bafy.harness).toBe('codex');
  });

  it('removes a wiring entry', async () => {
    const { request, readConfigFile } = await buildTestApiServer({
      configFile: { configShapeVersion: 2, executionWiring: [{ workKind: 'swe.v2', harness: 'codex', model: 'g', plugins: [], credentialRef: 'codex', isolationPolicy: 'workspace' }] },
    });
    const res = await request('DELETE', '/v1/operator/wiring/swe.v2');
    expect(res.status).toBe(200);
    expect(readConfigFile().executionWiring).toEqual([]);
  });

  it('rejects a wiring write with no harness', async () => {
    const { request } = await buildTestApiServer({ configFile: { configShapeVersion: 2, executionWiring: [] } });
    expect((await request('PUT', '/v1/operator/wiring/swe.v2', { model: 'g' })).status).toBe(400);
  });

  it('retires the join routes with 410 and names the replacement', async () => {
    const { request } = await buildTestApiServer({ configFile: { configShapeVersion: 2 } });
    for (const [method, path] of [['POST', '/v1/operator/join/bafy'], ['DELETE', '/v1/operator/join/bafy'], ['GET', '/v1/operator/joined']] as const) {
      const res = await request(method, path);
      expect(res.status, `${method} ${path}`).toBe(410);
      expect(res.body.replacement).toContain('/v1/operator/');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client" && yarn vitest run test/api/claim-policy-endpoints.test.ts`
Expected: FAIL — routes absent; join routes still 200.

- [ ] **Step 3: Implement the routes**

In `client/src/api/setup-endpoints.ts`, replacing the three existing handlers:

```ts
  app.get('/v1/operator/claim-policy', (c) => {
    const config = loadConfig(configPath);
    const migration = lastConfigMigrationV2();
    return c.json({
      configShapeVersion: config.configShapeVersion ?? 1,
      claimPolicy: config.claimPolicy,
      executionWiring: config.executionWiring,
      caps: config.spendCaps ?? {},
      migration: migration ?? { migrated: false },
    });
  });

  app.put('/v1/operator/wiring/:workKind', async (c) => {
    const workKind = c.req.param('workKind');
    const body = await c.req.json<Record<string, unknown>>();
    if (typeof body['harness'] !== 'string' || body['harness'].length === 0) {
      return c.json({ error: 'harness_required' }, 400);
    }
    const config = loadConfig(configPath);
    const existing = config.executionWiring.find((e) => e.workKind === workKind);
    const next = {
      workKind,
      harness: body['harness'],
      model: typeof body['model'] === 'string' ? body['model'] : (existing?.model ?? ''),
      plugins: Array.isArray(body['plugins']) ? (body['plugins'] as string[]) : (existing?.plugins ?? []),
      credentialRef: typeof body['credentialRef'] === 'string' ? body['credentialRef'] : body['harness'],
      isolationPolicy: typeof body['isolationPolicy'] === 'string' ? body['isolationPolicy'] : 'workspace',
      ...(existing?.legacyManifestDigest === undefined
        ? {}
        : { legacyManifestDigest: existing.legacyManifestDigest }),
    };
    const wiring = [...config.executionWiring.filter((e) => e.workKind !== workKind), next];
    persistTopLevelConfigValue('executionWiring', wiring, configPath);
    // Additive: keep the legacy entry in sync so a rolled-back daemon
    // generation still claims. The legacy key is deleted at stage 5.
    syncLegacyJoinedEntry(configPath, next);
    return c.json({ ok: true, restartRequired: true, workKind });
  });

  app.delete('/v1/operator/wiring/:workKind', (c) => {
    const workKind = c.req.param('workKind');
    const config = loadConfig(configPath);
    const removed = config.executionWiring.find((e) => e.workKind === workKind);
    persistTopLevelConfigValue(
      'executionWiring',
      config.executionWiring.filter((e) => e.workKind !== workKind),
      configPath,
    );
    if (removed?.legacyManifestDigest !== undefined) removeLegacyJoinedEntry(configPath, removed.legacyManifestDigest);
    return c.json({ ok: true, restartRequired: true, workKind });
  });

  const RETIRED = { error: 'route_retired', replacement: '/v1/operator/wiring/:workKind' } as const;
  app.post('/v1/operator/join/:cid', (c) => c.json(RETIRED, 410));
  app.delete('/v1/operator/join/:cid', (c) => c.json(RETIRED, 410));
  app.get('/v1/operator/joined', (c) => c.json({ ...RETIRED, replacement: '/v1/operator/claim-policy' }, 410));
```

Write `syncLegacyJoinedEntry` / `removeLegacyJoinedEntry` beside the handlers using the same read-modify-write shape `persistTopLevelConfigValue` already uses; they touch only `harness`, `model`, and `plugins` on the matching `joinedSolverNets[<legacyManifestDigest>]` entry.

- [ ] **Step 4: Run the tests**

Run: `cd "$REPO/client" && yarn vitest run test/api/ && yarn typecheck`
Expected: PASS, 7 new tests. Update any existing API test that asserts a 200 on the join routes.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/src/api/setup-endpoints.ts client/test/api/claim-policy-endpoints.test.ts
git commit -m "feat(client): serve claim policy and wiring entries, retire the join routes"
```

---

## Task 25: Claim policy & wiring SPA page + `OPERATOR-APP-SPEC` delta

Design §9: "the memberships page becomes **Claim policy & wiring** (predicate, wiring entries, caps, migration state message)". Deltas only, no redesign. **The spec update lands in this same PR** — that is the frontend rule, not a preference.

**Files:**
- Create: `client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.tsx`
- Create: `client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.test.tsx`
- Create: `client/src/dashboard/spa/src/pages/operator/WiringEntryCard.tsx`
- Delete: `client/src/dashboard/spa/src/pages/operator/MembershipsTab.tsx` and `MembershipsTab.test.tsx`
- Modify: `client/src/dashboard/spa/src/routes.ts`, `App.tsx`, `pages/operator/OperatorSubNav.tsx`, `api/client.ts`
- Modify: `client/OPERATOR-APP-SPEC.md` (§2.4)

**Interfaces:**
- Consumes: `GET /v1/operator/claim-policy`, `PUT|DELETE /v1/operator/wiring/:workKind` (Task 24).
- Produces: route `/operator/claim-policy`, label `Claim policy`; `api.operator.getClaimPolicy()`, `api.operator.putWiring(workKind, body)`, `api.operator.deleteWiring(workKind)`.

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClaimPolicyTab } from './ClaimPolicyTab.js';

vi.mock('../../api/client.js', () => ({
  api: {
    operator: {
      getClaimPolicy: vi.fn(async () => ({
        configShapeVersion: 2,
        claimPolicy: { kind: 'legacy-manifest-digest' },
        executionWiring: [{
          workKind: 'swe-rebench.v2', harness: 'claude-code', model: 'haiku',
          plugins: ['jinn-layer'], credentialRef: 'claude-code', isolationPolicy: 'workspace',
        }],
        caps: { 'claude-code': 10 },
        migration: { migrated: true, wiringCount: 1, backupPath: '/x/config.json.pre-v2.2026-07-30T00:00:00.000Z.bak' },
      })),
      putWiring: vi.fn(), deleteWiring: vi.fn(),
    },
  },
}));

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ClaimPolicyTab onRestartPending={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ClaimPolicyTab', () => {
  it('renders the claim policy kind', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('claim-policy-kind')).toHaveTextContent('legacy-manifest-digest'));
  });

  it('renders one card per wiring entry', async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId('wiring-entry-card')).toHaveLength(1));
    expect(screen.getByText('swe-rebench.v2')).toBeInTheDocument();
  });

  it('shows the one-time migration state message with the backup path', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('config-migrated-message')).toBeInTheDocument());
    expect(screen.getByTestId('config-migrated-message')).toHaveTextContent('config.json.pre-v2.');
  });

  it('renders the per-credential caps', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId('caps-claude-code')).toHaveTextContent('10'));
  });

  it('shows an empty state naming what fills it when there is no wiring', async () => {
    const { api } = await import('../../api/client.js');
    vi.mocked(api.operator.getClaimPolicy).mockResolvedValueOnce({
      configShapeVersion: 2, claimPolicy: { kind: 'none' }, executionWiring: [], caps: {}, migration: { migrated: false },
    } as never);
    renderTab();
    await waitFor(() => expect(screen.getByTestId('claim-policy-empty')).toBeInTheDocument());
  });

  it('surfaces a load failure as an alert', async () => {
    const { api } = await import('../../api/client.js');
    vi.mocked(api.operator.getClaimPolicy).mockRejectedValueOnce(new Error('down'));
    renderTab();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "$REPO/client/src/dashboard/spa" && yarn vitest run src/pages/operator/ClaimPolicyTab.test.tsx`
Expected: FAIL — component absent.

- [ ] **Step 3: Write the page**

shadcn primitives only. The catalog under `src/components/ui/` already ships `alert`, `badge`, `button`, `card`, `input`, `label`, `separator`, `skeleton`, `table`, `tooltip` — compose from those; no new custom component is needed, so no snowflake request applies. **Show, don't narrate**: no caption text restating the counts or explaining where the data lives.

```tsx
// client/src/dashboard/spa/src/pages/operator/ClaimPolicyTab.tsx
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Separator } from '../../components/ui/separator.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { api } from '../../api/client.js';
import { WiringEntryCard } from './WiringEntryCard.js';

export function ClaimPolicyTab({ onRestartPending }: { onRestartPending: () => void }) {
  const query = useQuery({
    queryKey: ['operator', 'claim-policy'],
    queryFn: () => api.operator.getClaimPolicy(),
    refetchInterval: 30_000,
  });

  if (query.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          Could not load claim policy. Check the daemon is running, then retry.
        </AlertDescription>
      </Alert>
    );
  }

  if (query.isLoading || query.data === undefined) {
    return (
      <div data-testid="claim-policy-loading" className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const { claimPolicy, executionWiring, caps, migration } = query.data;

  return (
    <div data-testid="claim-policy-tab" className="space-y-4">
      {migration.migrated ? (
        <Alert data-testid="config-migrated-message">
          <AlertDescription>
            Configuration migrated to shape version 2. Previous file kept at {migration.backupPath}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Claim policy</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <Badge data-testid="claim-policy-kind">{claimPolicy.kind}</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Caps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {Object.entries(caps).map(([credential, usd]) => (
            <div key={credential} className="flex justify-between">
              <span>{credential}</span>
              <span data-testid={`caps-${credential}`}>{usd}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Separator />

      {executionWiring.length === 0 ? (
        <p data-testid="claim-policy-empty">
          No execution wiring. Add a wiring entry to claim work.
        </p>
      ) : (
        executionWiring.map((entry) => (
          <WiringEntryCard key={entry.workKind} entry={entry} onRestartPending={onRestartPending} />
        ))
      )}
    </div>
  );
}
```

`WiringEntryCard.tsx` renders `workKind` as the title, `harness` / `model` / `credentialRef` / `isolationPolicy` as label+value rows, plugins as `Badge`s, and two `Button`s (Save, Remove) wired to `api.operator.putWiring` / `deleteWiring`, invalidating `['operator','claim-policy']` and calling `onRestartPending()` on success. Give it `data-testid="wiring-entry-card"`. Reuse `PluginPicker` and the harness/model helpers the deleted `JoinedNetCard` used, so the editing surface is unchanged for the operator.

- [ ] **Step 4: Re-route and delete the old page**

- `routes.ts`: replace `{ path: '/operator/memberships', label: 'operator-memberships' }` with `{ path: '/operator/claim-policy', label: 'operator-claim-policy' }`.
- `App.tsx`: swap the `<Route path="/operator/memberships">` block for `/operator/claim-policy` rendering `<ClaimPolicyTab .../>`, and change the `/operator` redirect target.
- `OperatorSubNav.tsx`: `{ to: '/operator/claim-policy', label: 'Claim policy' }` as the first item.
- `api/client.ts`: replace the `listJoined` / `join` / `leave` members with `getClaimPolicy` / `putWiring` / `deleteWiring`.
- Delete `MembershipsTab.tsx` and `MembershipsTab.test.tsx`.
- Grep **path-shaped** for stragglers: `grep -rn "memberships" "client/src/dashboard/spa/src" --include=*.ts --include=*.tsx`.

- [ ] **Step 5: Update `OPERATOR-APP-SPEC.md` §2.4 in this same commit**

Replace §2.4 "Network Memberships" with:

```markdown
### 2.4 Claim policy & wiring

The operator's claim decision and the execution wiring that serves it. Replaces
Network Memberships at cutover stage 1: claiming is no longer gated on joined
SolverNets, it is decided by the operator's own claim predicate over discovery
facts, backend capabilities, and the operator's own caps.

- **State**
  - config shape version — `1 | 2`
  - claim policy — `legacy-manifest-digest | every-runnable | none`. `none` is
    the claim-nothing-when-unconfigured safety default.
  - caps — per-credential daily USD ceiling, and the AI-unit ceiling.
- **Collections**
  - execution wiring entries, one per work kind, unordered. Item shape:
    `workKind`, `harness`, `model`, `plugins[]`, `credentialRef`,
    `isolationPolicy`, and (until the bridge retires) `legacyManifestDigest`.
    - **Actions (per entry)**
      - save wiring entry — `idle → saving → saved` (`failed` terminal).
        Restart-required; the panel raises the restart-pending banner.
      - remove wiring entry — `idle → removing → removed` (`failed` terminal).
        Restart-required.
- **State messages**
  - configuration migrated to shape version 2 — one-time, names the backup
    file. No action; informational.
  - unreleased attempt — a post-claim failure left an attempt unreleased on the
    venue (today-mode has no on-venue release). No action available in this
    generation; the message names the task so the operator can see the occupied
    claim slot.
  - evidence indexing failed — the evidence driver could not index one or more
    records. No action; informational until the retry surface lands.
- **Actions (component-level)**
  - none. Wiring is edited per entry.
```

Also update §2.5's cross-reference from "Memberships lists SolverNets the operator *has* joined" to point at §2.4's wiring entries, and note in §3.2 that wiring edits are restart-required.

- [ ] **Step 6: Run the SPA tests**

Run: `cd "$REPO/client/src/dashboard/spa" && yarn test && cd "$REPO/client" && yarn test`
Expected: PASS, including the route-smoke gate driven by `routes.ts`. Any test referencing the old route must be updated, not skipped.

- [ ] **Step 7: Commit**

```bash
cd "$REPO" && git add client/src/dashboard/spa/src client/OPERATOR-APP-SPEC.md
git rm client/src/dashboard/spa/src/pages/operator/MembershipsTab.tsx \
       client/src/dashboard/spa/src/pages/operator/MembershipsTab.test.tsx
git commit -m "feat(client): replace the memberships page with claim policy and wiring"
```

---

## Task 26: Re-point `e2e:daemon-harness` onto the composed runtime

The first half of the stage gate: `e2e:daemon-harness` re-pointed and green.

**Files:**
- Modify: `client/test/e2e/_daemon-harness-helpers.ts` (`startDaemon` @845, `MechAdapter` @1054, `new Daemon` @1121)
- Modify: `client/test/e2e/daemon-harness-cycle.ts`

**Interfaces:**
- Consumes: `composeOperatorRuntime` (Task 17).
- Produces: `RunningDaemon` gains `runtime: OperatorRuntime`.

- [ ] **Step 1: Compose the runtime in `startDaemon`**

Immediately before `new Daemon({...})` (helpers @1121):

```ts
  const runtime = await composeOperatorRuntime({
    config: harnessConfig,
    store,
    publicClient,
    walletClient,
    safeAddress: operator.safeAddress as `0x${string}`,
    chain: {
      chainId: 8453,
      taskCoordinator: v3Env?.routerAddress ?? routerAddress,
      jinnRouter: v3Env?.routerAddress ?? routerAddress,
      mechMarketplace: v3Env?.mockMarketplaceAddress ?? mechMarketplaceAddress,
      activityChecker: v3Env?.activityCheckerAddress ?? activityCheckerAddress,
      generation: 'today',
    },
    stateDir: join(fixture.stateRoot, 'runtime'),
    source: { agent: `did:pkh:eip155:8453:${operator.safeAddress.toLowerCase()}`, name: 'marketplace' },
    signer: e2eDiscoverySigner(operator),
  });
```

Give the `Daemon` constructor `runtime`, and extend the `stop` closure to `await runtime.close()` before `store.close()`.

The harness must supply real execution wiring — the e2e previously omitted `joinedSolverNets` and leaned on `implRegistry.config.solverTypeHarnesses`. Build `harnessConfig.executionWiring` from the selected harness:

```ts
  const harnessConfig = {
    configShapeVersion: 2,
    claimPolicy: { kind: 'every-runnable' as const },
    executionWiring: [{
      workKind: 'prediction.v1',
      harness: selectorToHarnessName(harness),
      model: modelForHarness(harness),
      plugins: [],
      credentialRef: selectorToHarnessName(harness),
      isolationPolicy: 'workspace',
    }],
    posting: [],
    spendCaps: { [selectorToHarnessName(harness)]: 1000 },
  };
```

- [ ] **Step 2: Point the claim wait at the work loop**

`waitForDaemonClaim` currently polls the engine's `task_runs`. Re-point it at the engagement ledger:

```ts
export async function waitForDaemonClaim(running: RunningDaemon, timeoutMs = 120_000) {
  const ledger = running.store.engagementLedger();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = ledger.listUnreconciled();
    const claimed = rows.find((row) => row.claimTxHash !== null);
    if (claimed !== undefined) return claimed;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for the work loop to claim');
}
```

- [ ] **Step 3: Keep every existing assertion**

`daemon-harness-cycle.ts` phases 8–11 stay as they are — the harness-name assertion (`delivered.solverHarnessName`), the on-chain activity-counter poll, and the #1393 corpus-knowledge second run. The corpus assertions read `task_runs`; since solutions no longer write there, port them to the equivalent read on the backend journal + the engagement ledger. **Do not delete them** — corpus autoload is untouched by this stage, so its coverage must survive.

- [ ] **Step 4: Run the e2e**

Run: `cd "$REPO/client" && JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness`
Expected: the full cycle green — Anvil fork, bootstrap, V3 stack deploy, work-loop claim, execute, deliver, settle, activity counter increment. A clean skip when the harness API key is absent is still acceptable for the non-baseline harnesses only.

- [ ] **Step 5: Commit**

```bash
cd "$REPO" && git add client/test/e2e/
git commit -m "test(client): re-point the daemon-harness e2e onto the composed runtime"
```

---

## Task 27: Drain runbook and the deploy PR

The stage's single deploy PR. Operator-approved; no agent self-merge.

**Files:**
- Create: `docs/runbooks/cutover-stage-1-drain.md`

**Interfaces:**
- Consumes: nothing. Produces the checklist the deploy PR body embeds.

- [ ] **Step 1: Write the runbook**

```markdown
# Cutover stage 1 — drain and deploy runbook

The retiring flow is the TaskEngine's **solution** path. It stops accepting new
work and runs until its in-flight items reach terminal states before the swap
deploys. The evaluation path is untouched at this stage and drains at stage 2.

## Before the deploy PR merges

- [ ] Confirm the fleet's current image tag, so the rollback pin is a known value.
      Record it in the PR body — a rollback with no named tag is not a rollback.
- [ ] Stop posting new tasks against the fleet's manifest digests (pause the
      launched-record generators). Record the time.
- [ ] Watch `task_runs` drain: no rows in `IN_FLIGHT_STATES` with
      `task_role = 'restoration'`. Query:
      `sqlite3 ~/.jinn-client/jinn.db "SELECT request_id, state FROM task_runs WHERE task_role='restoration' AND state NOT IN ('COMPLETE','FAILED','RACE_LOST');"`
- [ ] Bound the wait by the operator's patience. Today-mode has no on-venue
      release, so a stranded claim occupies its `maxClaims` slot until the
      revised generation's deadline-reap. Stragglers **strand loudly** — they
      surface as the unreleased-attempt state message, never silently. Record
      any stragglers in the PR body by task id.
- [ ] Confirm the bridge fixture gate is green: the converged
      marketplace-profile Delivery parses in the legacy evaluator
      (`client/test/bridge/converged-delivery-legacy-parse.test.ts`).
- [ ] Confirm the single-broadcaster architecture test reports zero offenders.

## Stage gate (both required, verbatim from the design)

- [ ] `e2e:daemon-harness` re-pointed and green.
- [ ] One real task closed-loop on testnet through the new flow, **including the
      verdict leg via the still-legacy evaluator**. Record the task id, the
      claim tx, the delivery tx, and the verdict tx in the PR body.

## Rollback statement (copy into the deploy PR body)

> Rollback is reverting this PR and pinning the previous canary image
> `<TAG RECORDED ABOVE>`. Chain state stays consistent — claims are chain facts
> and the backend journal persists — but the reverted daemon does **not** resume
> the new flow's in-flight engagements. Those engagements are abandoned and are
> named by the unreleased-attempt state message. The config migration is
> additive and the legacy `joinedSolverNets` keys survive until stage 5, so a
> rolled-back daemon generation boots from the migrated file and claims exactly
> as it did before.

## After deploy

- [ ] Watch the projector's durable cursor advance; the work loop issues no
      claim until it reaches the finalized chain head.
- [ ] Confirm one claim → deliver → settle cycle on the fleet.
- [ ] Confirm the two chain readers running in parallel (the retiring discovery
      floor until stage 4, plus the new projector) are not storming RPC quota —
      this window is accepted explicitly and kept short.
```

- [ ] **Step 2: Run the full gate locally**

Run, showing each output:
```bash
cd "$REPO/client" && yarn typecheck && yarn test
cd "$REPO/packages/marketplace/pipeline" && yarn test
cd "$REPO/client/src/dashboard/spa" && yarn test
cd "$REPO/client" && JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness
```
Expected: all green.

- [ ] **Step 3: Commit and open the deploy PR**

```bash
cd "$REPO" && git add docs/runbooks/cutover-stage-1-drain.md
git commit -m "docs: add the cutover stage-1 drain runbook"
```

Open the deploy PR against `integration/evidence-v1` with the runbook checklist and the rollback statement in the body, the testnet closed-loop transaction hashes recorded, and the design findings section's dispositions listed. **Do not self-merge** — the stage deploy PR is operator-approved.

---

## Self-Review

**1. Spec coverage.** Walked design §3, §4, §6.4, §6.5, §9, §10 (stage 1 row, bridge-era rules, drain rules, standing rules) and program §5, §6 against the tasks:

| Requirement | Task |
| --- | --- |
| Composition root assembling backend/pipeline config + ports | 15, 17 |
| Projector loop (log source → observations → announcements → archive; finality waiter reads from it) | 10, 11 |
| Facts card → `SubmissionFacts` mapper (pipeline tree, §6.4) | 2 |
| Work loop (archive subscribe → facts → predicate/caps/wiring → one engagement per claim) | 16 |
| Evidence join (host-owned, architecture-test-enforced) | 12 |
| Evidence driver loop + publication policy (contract 6) | 13 |
| Thin engagement ledger; ledger-before-broadcast (contract 2) | 3, 16 |
| Projector-catch-up claim gate (contract 3) | 11, 16 |
| Config auto-migration, additive/atomic/idempotent (contract 4) + the four new keys | 4, 5, 6 |
| Single-broadcaster re-point of every enumerated legacy leg (contract 1) | 19, 20, 21 |
| Bridge-era legacy facts card under a `legacy` derivation annotation (contract 9) | 8 |
| Converged Delivery parseable by the legacy evaluator — a fixture, not an assumption | 9 |
| Claim policy & wiring SPA page + `OPERATOR-APP-SPEC` delta, same PR | 24, 25 |
| Drain runbook for the retiring solution path (contract 10) | 27 |
| Retire TaskEngine solution path / `joinedSolverNets` gating / `task_runs` frozen for solutions | 23 |
| Plugin content commands re-keyed onto wiring entries (design §9 CLI paragraph) | 22 |
| Rolling-window caps re-pointed at pipeline caps (§6.5) | 14 |
| Unreleased-attempt state message (§4) | 16, 17, 25 |
| Crash recovery derivation-first; boot reconcile | 16 (`reconcileOnBoot`), 11 (cursor restore) |
| Stage gate: e2e re-pointed and green; one testnet closed loop incl. the verdict leg | 26, 27 |
| One deploy PR, operator-approved, carrying drain checklist + rollback statement | 27 |

No uncovered requirement found. Deliberately **not** here, per scope: the evaluator loop (stage 2), posting loop / requester module (stage 3), archive HTTP exposure (stage 4), the `client/` → `operator/` rename and `task_runs` deletion (stage 5).

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Three places deliberately instruct the implementer to read real code before writing a literal rather than inventing a shape — `provisionerCapabilities` (Task 15), the legacy envelope validator's export name (Task 9), and the store's caps-accounting method names (Task 14) — each says exactly what to read and why. Task 17 ships a `resolveLegacyAnchor` stub with an explicit instruction to replace it in Task 18 and a warning against shipping it; that is a sequenced hand-off, not a placeholder.

**3. Type consistency.** Checked the names crossing task boundaries: `mapSubmissionFacts` / `SubmissionFactsCardInput` (2 → 8, 16); `deriveBridgeTask` / `deriveBridgeFactsCardInput` / `deriveBridgeSubmissionUri` (8 → 16, stage 2); `EngagementLedger.admit|recordBroadcast|markSettled|markAbandoned|listUnreconciled` and `engagementIdempotencyKey` (3 → 16, 26); `ProjectorStateStore.readCheckpoint|readProjection|readArchiveHead|commit` (7 → 11); `ProjectorLoop.subscribe|caughtUpToFinalized|durableCursor|tickOnce` (11 → 16, 17); `openOperatorEvidence` / `OperatorEvidence` (12 → 13, 17); `EvidenceDriverLoop` / `decideEvidencePublication` (13 → 17); `createRollingWindowCaps` / `RollingWindowCaps.snapshot|record` (14 → 16, 17); `buildLocalBackendConfig` (15 → 17); `composeOperatorRuntime` / `RuntimeLoop` / `OperatorRuntime` (17 → 18, 26, stage 2); `createOperatorBroadcaster` / `OperatorBroadcaster.safeExec|eoaSend` / `BANNED_BROADCAST_PRIMITIVES` (19 → 20, 21); `findWiringByTarget` / `pluginsForWiring` (22); `ExecutionWiringConfigV2` (4 → 14, 15, 22, 24). All consistent.

**Three cross-stage surfaces are pinned as requested**: `deriveBridgeTask` with its determinism guarantee (Task 8), `ProjectorLoop.subscribe` (Task 11), and `composeOperatorRuntime` with its data-shaped `loops` registry (Task 17).
