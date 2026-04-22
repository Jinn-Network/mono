# Naming Alignment — Discussion Doc

> Version: 1 (draft, discussion input)
> Date: 2026-04-22
> Author: ritsukai
> Status: **Draft — not a spec yet.** Needs review with Oak before any work is scheduled.
> Related audit: `docs/reviews/2026-04-22-architecture-audit-j75.md` §10
> Related issues: `jinn-mono-j75` (audit), `jinn-mono-7zz`, `jinn-mono-y6w`
> Supersedes: none

## 0. Why this is a draft, not a spec

The audit (§10) recommended a staged rename. A subsequent discussion
rejected staging: bit-by-bit creates exactly the "multiple names for the
same thing" problem the rename is meant to fix. The choice is now one of
three paths, and it needs Oak's input before any implementation:

- **A. All-at-once now** — rename client + contracts + config + manifest
  + CLI + docs in one coordinated release; redeploy `JinnRouter` +
  `RestorationActivityChecker` on Base Sepolia and Base mainnet.
- **B. All-at-once at Phase 2 relaunch** — freeze "restoration" as the
  vocabulary everywhere (including new TS code) until Phase 2's
  clean-slate redeploy naturally gives us a renaming window.
- **C. Never rename** — declare "restoration" canonical, rewrite the
  spec and audit to match, close the thread.

This doc is the input for that discussion. It contains the full rename
table, on-chain impact analysis, and cost breakdown. It does **not**
prescribe a plan. Sections 2–8 describe what "A" would look like if
chosen; they are not commitments.

## 1. Purpose and scope

The architecture audit (§10) identified that four overlapping vocabularies
— spec, TypeScript, CLI, and on-chain — don't align. This doc catalogues
the misalignment and the full cost of fixing it, so we can pick A / B / C
with eyes open.

### 1.1 Surfaces that would change under option A

- Internal TypeScript types in `client/src/` (full rename table in §2).
- Directory layout: `client/src/restorer/engine/` → `client/src/execution/`,
  `client/src/restorer/impls/` → `client/src/executors/`.
- `client/src/types/desired-state.ts` file + type renames
  (`DesiredState → Intent`, collapse `RestorationRequest`, …).
- Config keys: `config.desiredStates → config.intents`, `restorers.*` →
  `executors.*` (both with one-release compat aliases).
- Manifest schema: `*.manifest.v1` → `*.submission.v1`,
  `*.eval.manifest.v1` → `*.verdict.v1` (readers accept both for one
  release).
- Contracts (see §1.2).
- Docs (`CLAUDE.md`, `AGENTS.md`, `spec/`, `docs/`).
- CLI verbs stay (`jinn intents …` is already correct).

### 1.2 On-chain surface that would change

All items below are behind upgradeable proxies (`JinnRouterProxy`,
`ActivityCheckerProxy`), so **addresses** can stay, but **selectors** and
**event topic0 hashes** are ABI-breaking for any external caller or
indexer pinned to old names.

**`contracts/src/staking/JinnRouter.sol` (+ `JinnRouterV2.sol`):**

| Today | Proposed |
|---|---|
| `function createRestorationJob(...)` | `function createIntent(...)` |
| `function createEvaluationJob(..., bytes32 restorationRequestId)` | `function createEvaluationJob(..., bytes32 intentRequestId)` (arg rename) |
| `function claimDelivery(bytes32 requestId)` | **no change** |
| `event RestorationJobCreated(address creator, bytes32 requestId)` | `event IntentCreated(address creator, bytes32 requestId)` |
| `event EvaluationJobCreated(..., bytes32 restorationRequestId)` | `event EvaluationJobCreated(..., bytes32 intentRequestId)` |
| `error RestorationNotClaimed(bytes32 restorationRequestId)` | `error IntentNotClaimed(bytes32 intentRequestId)` |

**`contracts/src/staking/RestorationActivityChecker.sol` (+ V2):**

| Today | Proposed |
|---|---|
| Contract name `RestorationActivityChecker` | `ExecutionActivityChecker` (new deploy artifact) |
| V2 `restorationDeliveryCount(address)` | `deliveryCount(address)` |
| V2 `recordRestorationEvidence(address, bytes32)` | `recordEvidence(address, bytes32)` |

Unaffected on-chain surfaces (double-checked):

- `getMultisigNonces(address)` / `isRatioPass(...)` — read by OLAS
  staking contract; names are part of the OLAS interface, must stay.
- `claimDelivery(bytes32)` — name is already role-correct, keep.
- `ClaimRegistry`, `AcceptAllChecker`, `IEligibilityChecker` — clean.
- Operator state (Safe addresses, service IDs, OLAS staking
  registrations) — unaffected; those live in OLAS registries, not our
  contracts.
- `~/.jinn-client/earning/earning_state.json` — unaffected.

**Deployment impact under option A:**

- Base Sepolia: proxy-upgrade both implementations to new bytecode.
  Operators re-run bootstrap if they have stale session state.
- Base mainnet (`0xfFa7…181B` / `0x477C…a24d`): either proxy-upgrade in
  place (old selectors silently disappear) **or** deploy fresh at new
  addresses and sunset the old pair. Need Oak's call on which.
- Any external subgraph indexing `RestorationJobCreated` must re-index
  against the new `IntentCreated` topic. We do not ship such an indexer
  in-tree.

## 2. Full vocabulary proposal (option A)

The audit's full vocabulary table is in §10.2. Under option A, every row
lands in one release:

| Before (TS)                          | After (TS)                           | Where |
|---                                   |---                                   |---    |
| `DesiredState` (the type)            | `Intent`                             | `client/src/types/desired-state.ts` and all importers |
| `RestorationRequest` (the type)      | `Intent` (collapse; add optional `requestId`, `onchainCreationTx`, `onchainCreationBlock`, `intentCid` fields) | same file |
| `RestorationResult` (bytes payload)  | `Submission`                         | same file |
| `DeliveredResult`                    | `Delivery`                           | same file |
| `RestorerImpl` (interface)           | `Executor`                           | `client/src/restorer/types.ts` → `client/src/execution/types.ts` |
| `RestorationContext`                 | `ExecutionContext`                   | same file |
| `RestorationOutput`                  | `ExecutionOutput`                    | same file |
| `RestorationEngine` (class)          | `ExecutionEngine`                    | `client/src/restorer/engine/` → `client/src/execution/` |
| `RestorerImplRegistry`               | `ExecutorRegistry`                   | same dir |
| `client/src/restorer/impls/*`        | `client/src/executors/*`             | directory rename |
| impl names like `claude-mcp-hyperliquid` | `<kind>-<role>[-<variant>]`, e.g. `portfolio-v0-agentic` | role-first naming |
| `*.manifest.v1` (restorer-signed)    | `*.submission.v1`                    | readers accept both for one release |
| `*.eval.manifest.v1`                 | `*.verdict.v1`                       | readers accept both for one release |
| config `restorers.*`                 | `executors.{byKind, default, disabled}` | one-release compat alias |
| config `desiredStates`               | `intents`                            | one-release compat alias |
| CLI `jinn intents …`                 | **no change**                        | already correct |

On-chain surface: see §1.2.

## 3. Data-type collapse (`RestorationRequest` → `Intent`)

Today:

```ts
interface DesiredState { id: string; spec: Spec; … }

interface RestorationRequest {
  id: RequestId;                 // on-chain requestId
  desiredState: DesiredState;
  onchainCreationTx?: Hex;
  onchainCreationBlock?: bigint;
  intentCid?: string;
}
```

After Stage B:

```ts
interface Intent {
  id: string;                    // stable client-side intent id
  spec: Spec;
  // Provenance, populated after on-chain posting:
  requestId?: RequestId;         // from the chain (renamed inline)
  onchainCreationTx?: Hex;
  onchainCreationBlock?: bigint;
  intentCid?: string;
}
```

Rationale: "you don't request an intent" (user feedback on the audit).
One noun (`Intent`) carries the definition plus any provenance fields
populated along the way. Functions that today take
`RestorationRequest` accept `Intent` where `requestId` is guaranteed
present (documented via a type guard or a narrower `PostedIntent =
Intent & { requestId: RequestId }` alias if the compiler needs it).

If the call sites prove the narrowing too noisy in practice, introduce
`PostedIntent` as a derived type in the same file. The decision is
deferred to implementation; the spec requires only that there be no
separate `RestorationRequest` noun.

## 4. Cost comparison (A vs B vs C)

| Dimension | A: all-at-once now | B: wait for Phase 2 | C: never, freeze "restoration" |
|---|---|---|---|
| Client codemod effort | ~1 PR, ~30 files | 0 now, same PR later | 0 |
| Contract work | Upgrade 2 proxies on Sepolia + Base mainnet, new ABI shipped | Folded into Phase 2 redeploy (already planned) | 0 |
| Operator migration | Re-run bootstrap on upgrade; config compat alias handles `desiredStates → intents` | None | 0 |
| Third-party impact | Anyone pinned to `RestorationJobCreated` topic0 must re-index; none known in-tree | Handled at Phase 2 | 0 |
| Spec / audit / docs changes | Rewrite to "Intent" vocabulary; publish naming spec | Defer; mark audit §10 "decision pending Phase 2" | Rewrite spec + audit **the other way**: "restoration" becomes canonical |
| Plug-in author experience (`jinn-mono-7zz`) | Clean `Executor` / `Intent` surface at launch | Plug-in API ships with "restoration" vocabulary; breaking rename later | Plug-in API lives with "restoration" forever |
| Phase 2 relaunch work | Smaller (already renamed) | Bigger (rename + relaunch bundled) | None (naming stays) |
| Risk of half-done rename | Low (one coordinated PR) | Low (natural break at Phase 2) | Zero |
| Cognitive tax until Phase 2 | Pay once now | Pay daily until relaunch | Pay forever, but same word throughout |

The two dimensions that decide it:

1. **Phase 2 relaunch timeline.** If it's near, B is fine — the natural
   break absorbs the cost.
2. **`jinn-mono-7zz` plug-in launch timing.** That issue publishes the
   external `Executor` contract. Whatever vocabulary is live at that
   moment becomes the plug-in contract. This is the real forcing
   function.

## 5. Open questions for the Oak conversation

1. Phase 2 mainnet relaunch timeline — rough, so we can weigh A vs B.
2. External operators currently running against Base mainnet
   `0xfFa7…181B`? If effectively zero, A is much cheaper than it looks.
3. Subgraph / indexer dependencies on current event topic0 hashes?
4. When does `jinn-mono-7zz` start? Whatever vocabulary is live at that
   moment becomes the plug-in contract.
5. On-chain rename strategy if A wins: proxy-upgrade in place (same
   addresses, silent ABI swap) vs. new addresses with the old pair
   sunset.
6. Any appetite for option C (keep "restoration")? It's cheapest and
   one-vocabulary-consistent; the cost is the spec gets renamed, not
   the code.
7. `intent.kind` vs `intent.spec.kind` — flatten the container while we
   have the chance? (Only relevant under A.)
8. Does `Executor` absorb evaluator-role impls, or do we want a
   distinct `Evaluator` interface?

## 6. What happens after the decision

- **A chosen:** file a new epic covering client + contracts + deployment
  + docs in one coordinated release. Convert this doc into an
  implementation spec under `spec/`.
- **B chosen:** note it on the Phase 2 tracking issue. Mark audit §10
  "decision: deferred to Phase 2." Leave this doc for reference.
- **C chosen:** rewrite the audit and spec to use "restoration"
  vocabulary consistently. Close the thread. Ship `jinn-mono-7zz` with
  `Restorer` / `RestorationContext` in the external API.

This doc does not pick. That's Oak + ritsukai, offline.
