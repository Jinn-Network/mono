# Cutover Stage 2 — Evaluator Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator runtime an evaluator loop that observes other operators' solution deliveries, derives and posts the evaluation Submission, claims the verdict attempt, executes it as an evaluation-profile Attempt on the *same* embedded backend, settles the verdict on the venue, and gates verdict observations as decision-grade — then retires the delivery-watcher, the mech adapter's evaluation-opportunity machinery, and the legacy TaskEngine.

**Architecture:** The loop is a host composition: projector observations supply opportunities; `@jinn-network/marketplace-binding`'s evaluation leg (`deriveAndSealEvaluationSubmission`) derives the pair-fixed evaluation Task and seals the dispatch Submission under the **evaluator-seals carve-out** (public evaluation specs only — requester-side sealing arrives at stage 3); a new `venue-base` verdict port group carries the two today-mode chain writes; the embedded `LocalTaskExecutionBackend` executes the evaluation through the `evaluation-harness` launcher (the attestation-issuer signs the Result Evaluation Statement *inside* the executor — there is no separate evaluation runner, and re-implementing one is forbidden duplication per local-backend design §10.3–§10.4); the verdict-observation gate assembles `admissionAgentPolicy` / `evaluatorPolicy` / `requesterPolicy` from a verified trust-policy chain plus operator config and feeds `gateVerdictObservation`.

**Tech Stack:** TypeScript / Node 22 / Yarn workspaces with `portal:` resolution; viem; SQLite (`better-sqlite3` via the existing `Store`); vitest; the stack conformance kits (`@jinn-network/trust-testing`, `@jinn-network/marketplace-testing`); Anvil-fork integration suites.

## Global Constraints

- Branch target: **`integration/evidence-v1`**. Stacked PRs, one train for this stage, ending in exactly one deploy PR. No agent self-merge; the deploy PR is operator-approved.
- Depends on: **stage 1 complete** (composition root, projector loop, work loop, engagement ledger, venue-base facade, evidence join + driver all live) and the **`evaluator-adapters` tree implemented** (`@jinn-network/task-execution-evaluator-adapters`). PRs #2306 / #2307 / #2308 merged.
- **Single-broadcaster rule** (program §6.1): every transaction in this stage goes through `venue-base`'s Safe broadcast port. No new nonce stack, no direct `executeSafeTransaction` call from the host.
- **Ledger-before-broadcast** (program §6.2): the engagement-ledger row (wiring entry + idempotency key) is written in the same SQLite transaction that admits the verdict-claim intent, strictly before broadcast.
- **Evaluator-seals carve-out** (program §6.5, design §4): public evaluation specs only. A private-spec or grant-bearing evaluation opportunity is **skipped with a named reason**, never self-sealed.
- **Drain rules** (program §6.10): every retiring flow drains before its swap; stragglers strand loudly through the §4 operator state message.
- **Fresh rewrite, legacy as fixtures** (program §6.12): the mech adapter's revert-classification and retry scenarios enter as kit test cases, never as ported code.
- **Kits and fixtures before implementations**; every task ends with `yarn typecheck` + `yarn test` (plus the touched package's kit) run locally, outputs shown.
- American English throughout; no product names in tier-3 code (`packages/**` never says "operator app", "daemon", or "jinn client").
- New operator config block settled here: `evaluator` (see Task 14). Restart-required semantics stay; no hot reload.
- Every code path this plan adds is **observable**: reuse the existing `emitEvent` kinds (`evaluation_submitted`, `delivery_submitted`, `tick_error`) — the dashboard must not go dark when the delivery-watcher is deleted.

---

## Stage-1 surfaces this plan consumes (contract block — reconcile before Task 1)

Pinned by coordinator ruling (2026-07-30, program §5 + the stage-1 dispatch scope). The rows marked **pinned** are binding; treat them as settled names and do not re-derive them. The two rows marked *open* are still this plan's assumption — confirm them against `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` before Task 1, adopt stage 1's name on any collision (it lands first), and note the substitution in the stage-2 PR description. **Finding 5** tracks the residue. Do not re-plan or re-implement any row.

| Surface | Location | Status | Used by |
| --- | --- | --- | --- |
| `createBaseVenue(config)` → `{ claim, settlement, lifecycle, finality, deliveryWait, release, observe, safe, logSource, intents }`, assembled by the composition root | `@jinn-network/marketplace-venue-base` | **pinned** | Tasks 1, 10, 13 |
| Durable posting-intent store, reached as `intents` on the venue-base facade; **stage 2 wires it for evaluation Submissions** | `@jinn-network/marketplace-venue-base` | **pinned** | Task 10 |
| Loop modules `src/daemon/projector-loop.ts`, `work-loop.ts`, `evidence-driver.ts` (this plan adds `evaluator-loop.ts`) | `client/src/daemon/` | **pinned** | Tasks 5, 13, 14 |
| The engagement ledger, **owned by the composition root** and handed to loops from it | `client/src/daemon/` composition root | **pinned** | Task 10 |
| Projector-loop observation subscription `subscribeObservations(handler): () => void` | `client/src/daemon/projector-loop.ts` | *open — method name* | Task 5 |
| Composition-root entry point `buildOperatorRuntime(config)` and the embedded-backend handle it exposes | `client/src/daemon/composition-root.ts` | *open — identifier* | Tasks 11, 12, 14 |
| Bridge legacy-task derivation `deriveBridgeTask(legacyDocumentBytes, anchor)` | `client/src/bridge/legacy-task.ts` | *open — see Finding 4* | Tasks 6, 7 |

---

## Findings (surfaced to the coordinator; dispositions proposed, not silently applied)

The design is law. These six gaps were found by code walk while planning (Finding 6 arrived from the evaluator-adapters plan); each has a disposition and a task that implements it. **A coordinator ruling is required on Findings 1–3 before the tasks that depend on them merge** (Tasks 8, 1, 7 respectively). Findings 4 and 5 are cross-plan reconciliations against the stage-1 plan, settled at execution start rather than by a design ruling. Finding 6 is already settled — this stage accepted the ownership.

1. **Evaluator-sealed evaluations cannot execute as specified.** `assertSealerRule` (`packages/marketplace/binding/src/evaluation-derive.ts:88`) rejects *any* `capabilityGrants` when `sealerRole === "evaluator"`, but the evaluation launcher always declares `secretForwards: [{ grantKey: registration.signer.handle, … }]` (`packages/task-execution/evaluation-harness/src/launcher.ts:152`) and `materializeSecretForwards` throws `secret forward declares a missing grant` unless the Submission's `capabilityGrants` carries that exact key (`packages/task-execution/backend-local/assembly/src/secret-forwards.ts:57`). A grant-free evaluator-sealed Submission therefore fails `[infrastructure]` before the adapter runs. **Proposed disposition:** permit exactly one **self-signer** grant key in the evaluator-sealed case — a new optional `selfSignerGrantKey` input, honored only when `sealerRole === "evaluator" && publicSpec === true` and only when `capabilityGrants` has that single key. The grant conveys an operator-local handle, not private test material, so the carve-out's intent (no private grader/test material can be self-dispatched) is preserved; the named checks are unaffected because `gateVerdictObservation` byte-checks the evaluation *Task*, never the evaluation Submission's grants. Requires a dated addendum to the marketplace-binding design §6.4 / program §7.40. Implemented in **Task 8**.
2. **No verdict-leg chain writes exist anywhere.** Today-mode needs `claimEvaluation(taskId, attemptIndex, evaluatorMech, evaluationTaskCidDigest)` (which opens *and* claims the verdict request in one transaction), the mech's `deliverToMarketplace`, and `claimVerdictDelivery(requestId, evidenceHash, verdictCode)`. None appear in `ClaimPorts`, `SettlementPorts`, the design's §6.1 deliverable list, or the program §5 facade. **Proposed disposition:** an additive `verdict` port group on the `venue-base` facade — venue mechanics, not application policy, exactly as §6.1 places the other chain writes, and consistent with binding §6.4's statement that the binding does not gate that write. Owned by **Task 1** at the head of this stage's train; the coordinator may instead fold it into the venue-base plan, in which case Task 1 becomes a consumption check.
3. **Bridge-era evaluation has no subject Submission and no admission receipt.** §10's bridge-era rules cover the facts card and the converged Delivery, not the evaluation leg. `deriveAndSealEvaluationSubmission` requires a subject `SubmissionRecord` carrying an `admission-receipt` `ResourceDescriptor`, and `gateVerdictObservation` requires both the receipt envelope and requester DSSE authentication over the subject Submission bytes. Legacy-posted tasks have neither until stage 3. **Proposed disposition:** a third bridge-era document rule — the evaluator reconstructs the subject Submission deterministically from the anchored legacy task document under the same `legacy` derivation annotation the facts card uses, and the fleet's admission agent issues the admission receipt; the operator's bridge trust policy lists that agent under `admission-agent` and the subject requester under `requesterPolicy`; verdict observations produced this way carry a `bridge` marker and are advisory in exactly the sense binding §6.4 already declares for today-mode. Stage 3 deletes the synthesis. Implemented in **Task 7**.
4. **Deterministic subject-Task reconstruction is a shared stage-1/stage-2 function.** Derivation byte-equality is only achievable if the evaluator reproduces the exact sealed Task bytes the solver's Delivery binds. That demands one pure function used by both the stage-1 work loop (dispatch) and this loop (subject reconstruction). **Proposed disposition:** it is a stage-1 surface (`client/src/bridge/legacy-task.ts` → `deriveBridgeTask`); this plan consumes it and adds the cross-operator determinism fixture (Task 6). If stage 1 landed without it, Task 6 creates it at that path and the stage-1 work loop is re-pointed at it in the same PR.
5. **Stage-1 host surfaces (largely settled; two identifiers open).** Program §5 settles the loop filenames, the `createBaseVenue` facade, and the `transport-http` factories, but not the composition root's entry point, the projector loop's observation-subscription method, or the engagement ledger's API — and the two plans were authored in parallel, so a collision was likely rather than hypothetical. **Coordinator ruling (2026-07-30), applied above:** the composition root assembles venue-base via `createBaseVenue(config)` and owns the engagement ledger; the durable posting-intent store is `intents` on that facade, and stage 2 wires it for evaluation Submissions; the loop modules are `src/daemon/projector-loop.ts` / `work-loop.ts` / `evidence-driver.ts`, with `evaluator-loop.ts` added here. **Residue:** two identifiers remain unpinned — the projector loop's subscription method and the composition root's entry-point name — plus Finding 4's `deriveBridgeTask`. Disposition: reconcile at execution start; stage 1's names win; the correction is identifier substitution only, and no task's shape depends on the outcome.
6. **Grader-container execution had no owner until the evaluator-adapters plan named this stage.** The adapters are parse-only by design ruling, so nothing in that tree executes the `deterministic-process` grader container; the adapter resolves its material from the subject Results, then `evaluation-context.json`, and raises `subject-not-found` rather than inventing a verdict. **Disposition (accepted, not proposed):** stage 2 owns the execution wiring, because a verdict *is* an evaluation-profile Attempt on the embedded backend — the backend's provisioner/launcher chain runs the container and lays the output down where the adapter reads it. Implemented in **Task 11**, whose three grader-execution tests pin all three resolution outcomes including the never-invent-a-verdict rule.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/marketplace/venue-base/src/verdict.ts` | The verdict port group: open verdict attempt, deliver verdict to marketplace, claim verdict delivery (Finding 2) |
| `packages/marketplace/venue-base/src/verdict.test.ts` | Unit + fixture tests for the port group |
| `packages/marketplace/venue-base/test/verdict.anvil.test.ts` | Anvil-fork integration for the verdict leg |
| `client/src/trust/policy-assembly.ts` | Trust-policy chain → `PolicyCheckInput` per purpose |
| `client/src/evaluator/verdict-gate.ts` | `verifyVerdictObservation` port over `gateVerdictObservation` |
| `client/src/evaluator/self-evaluation.ts` | The own-solution skip predicate |
| `client/src/evaluator/opportunities.ts` | Projector observations → `EvaluationOpportunity` |
| `client/src/evaluator/subject-material.ts` | Exact subject Task / Delivery / Results / EvaluationSpec byte acquisition |
| `client/src/evaluator/bridge-subject.ts` | Bridge-era subject Submission + admission receipt synthesis (Finding 3) |
| `client/src/evaluator/submission.ts` | Evaluation Task + Submission derivation through the binding, carve-out enforced |
| `client/src/evaluator/intents.ts` | Verdict-leg durable intent admission (ledger-before-broadcast) |
| `client/src/evaluator/deployment.ts` | The `EvaluationHarnessDeployment` the launcher spawns against, built by the adapters tree's `createEvaluatorDeployment` facade |
| `client/src/evaluator/launcher.ts` | Configured evaluation-harness launcher for the embedded backend |
| `client/src/evaluator/grader-execution.ts` | **Execution owner** — runs the `deterministic-process` grader container and provisions its output for the parse-only adapters |
| `client/src/evaluator/settings.ts` | Accessor over the `evaluator` config block |
| `client/src/evaluator/signer-resolver.ts` | `SecretForwardResolver` for the evaluator signing key |
| `client/src/evaluator/settle.ts` | Verdict pin → marketplace deliver → `claimVerdictDelivery` |
| `client/src/daemon/evaluator-loop.ts` | The loop (program §5 name) |
| `docs/runbooks/cutover-stage-2-drain.md` | Drain runbook + rollback statement |
| `client/test/evaluator/*.test.ts`, `client/test/daemon/evaluator-loop.test.ts` | Tests |

**Modified**

| File | Change |
| --- | --- |
| `packages/marketplace/binding/src/evaluation-derive.ts` | Self-signer grant allowance (Finding 1) |
| `packages/marketplace/venue-base/src/index.ts` | Export the verdict port group; add `verdict` to `createBaseVenue`'s return |
| `client/src/daemon/composition-root.ts` | Build + start the evaluator loop |
| `client/src/daemon/daemon.ts` | Remove `DeliveryWatcherLoop` and `TaskEngine`; register the `evaluator` loop name |
| `client/src/daemon/loop-heartbeat.ts` | `LOOP_REGISTRY`: drop `delivery-watcher` / `engine-*`, add `evaluator` |
| `client/src/config.ts` | The `evaluator` config block |
| `client/src/adapters/mech/adapter.ts` | Delete the evaluation-opportunity machinery |
| `client/OPERATOR-APP-SPEC.md` | Loop taxonomy + event-source delta |

**Deleted**

`client/src/daemon/delivery-watcher.ts`, `client/test/daemon/delivery-watcher.test.ts`, `client/src/harnesses/engine/engine.ts`, `client/src/harnesses/engine/recovery.ts`, and the mech adapter's evaluation-opportunity members. `client/src/harnesses/engine/persistence.ts` (`TaskRunPersistence`) **survives as a read-only store** until stage 5 deletes `task_runs`.

---

### Task 1: The `venue-base` verdict port group

**Files:**
- Create: `packages/marketplace/venue-base/src/verdict.ts`
- Create: `packages/marketplace/venue-base/src/verdict.test.ts`
- Create: `packages/marketplace/venue-base/test/verdict.anvil.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `createBaseVenue`'s existing `SafeBroadcastPort` (`{ send(input: { to: Address; data: Hex }): Promise<Hex> }`), its `publicClient`, and `JINN_ROUTER_V3_ABI` / `MECH_ABI` from `@jinn-network/marketplace-binding`.
- Produces: `createVerdictPorts(deps): VerdictPorts` where

```ts
export interface VerdictPorts {
  readonly openVerdictAttempt: (input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly evaluationTaskCidDigest: Hex;
  }) => Promise<{ readonly requestId: Hex; readonly verdictIndex: number; readonly txHash: Hex }>;
  readonly canOpenVerdictAttempt: (input: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly revertName: string | null }>;
  readonly deliverVerdictToMarketplace: (input: {
    readonly requestId: Hex;
    readonly deliveryDigest: Hex;
  }) => Promise<{ readonly txHash: Hex }>;
  readonly claimVerdictDelivery: (input: {
    readonly requestId: Hex;
    readonly verdictDigest: Hex;
    readonly verdictCode: VerdictCode;
  }) => Promise<{ readonly status: "settled" | "already-settled" | "rejected" }>;
}
```

  and `createBaseVenue(...)` gains `verdict: VerdictPorts`.

- [ ] **Step 1: Write the failing unit test**

`packages/marketplace/venue-base/src/verdict.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { VerdictCode } from "@jinn-network/marketplace-binding";
import { createVerdictPorts } from "./verdict.js";

const ROUTER = "0x00000000000000000000000000000000000000a1" as const;
const MECH = "0x00000000000000000000000000000000000000b2" as const;
const REQUEST_ID = `0x${"11".repeat(32)}` as const;

function deps(overrides: Partial<Parameters<typeof createVerdictPorts>[0]> = {}) {
  return {
    publicClient: {
      simulateContract: vi.fn().mockResolvedValue({}),
      readContract: vi.fn().mockResolvedValue(false),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: [], status: "success" }),
    },
    broadcast: { send: vi.fn().mockResolvedValue(`0x${"ab".repeat(32)}`) },
    routerAddress: ROUTER,
    mechAddress: MECH,
    ...overrides,
  } as unknown as Parameters<typeof createVerdictPorts>[0];
}

describe("verdict ports", () => {
  test("claimVerdictDelivery refuses a missing verdict code rather than defaulting to Pass", async () => {
    const ports = createVerdictPorts(deps());
    await expect(
      ports.claimVerdictDelivery({
        requestId: REQUEST_ID,
        verdictDigest: `0x${"22".repeat(32)}`,
        verdictCode: undefined as unknown as VerdictCode,
      }),
    ).rejects.toThrow(/refusing to default/);
  });

  test("claimVerdictDelivery reports already-settled without broadcasting", async () => {
    const d = deps();
    (d.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const ports = createVerdictPorts(d);
    const result = await ports.claimVerdictDelivery({
      requestId: REQUEST_ID,
      verdictDigest: `0x${"22".repeat(32)}`,
      verdictCode: VerdictCode.Fail,
    });
    expect(result).toEqual({ status: "already-settled" });
    expect(d.broadcast.send).not.toHaveBeenCalled();
  });

  test("every write goes through the injected Safe broadcast port", async () => {
    const d = deps();
    const ports = createVerdictPorts(d);
    await ports.deliverVerdictToMarketplace({
      requestId: REQUEST_ID,
      deliveryDigest: `0x${"33".repeat(32)}`,
    });
    expect(d.broadcast.send).toHaveBeenCalledTimes(1);
    expect((d.broadcast.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].to).toBe(MECH);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/verdict.test.ts`
Expected: FAIL — `Cannot find module './verdict.js'`.

- [ ] **Step 3: Implement the port group**

`packages/marketplace/venue-base/src/verdict.ts`:

```ts
// SPDX-License-Identifier: MIT
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import {
  JINN_ROUTER_V3_ABI,
  MECH_ABI,
  formatKnownRevertDetail,
  type VerdictCode,
} from "@jinn-network/marketplace-binding";
import type { SafeBroadcastPort } from "./safe.js";

export interface VerdictPortDeps {
  readonly publicClient: PublicClient;
  readonly broadcast: SafeBroadcastPort;
  readonly routerAddress: Address;
  readonly mechAddress: Address;
}

const CLAIMED_ABI = [{
  name: "claimed", type: "function", stateMutability: "view",
  inputs: [{ name: "requestId", type: "bytes32" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

export function createVerdictPorts(deps: VerdictPortDeps) {
  const alreadyClaimed = async (requestId: Hex): Promise<boolean> =>
    Boolean(await deps.publicClient.readContract({
      address: deps.routerAddress, abi: CLAIMED_ABI, functionName: "claimed", args: [requestId],
    }));

  return Object.freeze({
    async canOpenVerdictAttempt(input: { taskId: bigint; attemptIndex: number }) {
      try {
        await deps.publicClient.simulateContract({
          address: deps.routerAddress,
          abi: JINN_ROUTER_V3_ABI,
          functionName: "claimEvaluation",
          args: [input.taskId, input.attemptIndex, deps.mechAddress, `0x${"11".repeat(32)}` as Hex],
        });
        return { ok: true } as const;
      } catch (error) {
        const detail = formatKnownRevertDetail(error);
        return {
          ok: false as const,
          reason: detail?.reason ?? String(error),
          revertName: detail?.name ?? null,
        };
      }
    },

    async openVerdictAttempt(input: {
      taskId: bigint; attemptIndex: number; evaluationTaskCidDigest: Hex;
    }) {
      const txHash = await deps.broadcast.send({
        to: deps.routerAddress,
        data: encodeFunctionData({
          abi: JINN_ROUTER_V3_ABI,
          functionName: "claimEvaluation",
          args: [input.taskId, input.attemptIndex, deps.mechAddress, input.evaluationTaskCidDigest],
        }),
      });
      const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "EvaluationAttemptCreated") {
            const args = decoded.args as unknown as { requestId: Hex; verdictIndex: number };
            return { requestId: args.requestId, verdictIndex: Number(args.verdictIndex), txHash };
          }
        } catch { /* not a router event */ }
      }
      throw new Error(`openVerdictAttempt: no EvaluationAttemptCreated in receipt for ${txHash}`);
    },

    async deliverVerdictToMarketplace(input: { requestId: Hex; deliveryDigest: Hex }) {
      const txHash = await deps.broadcast.send({
        to: deps.mechAddress,
        data: encodeFunctionData({
          abi: MECH_ABI,
          functionName: "deliverToMarketplace",
          args: [[input.requestId], [input.deliveryDigest]],
        }),
      });
      return { txHash };
    },

    async claimVerdictDelivery(input: { requestId: Hex; verdictDigest: Hex; verdictCode: VerdictCode }) {
      if (input.verdictCode === undefined) {
        throw new Error(
          `claimVerdictDelivery: verdictCode is required — refusing to default for ${input.requestId}`,
        );
      }
      if (await alreadyClaimed(input.requestId)) return { status: "already-settled" as const };
      try {
        await deps.broadcast.send({
          to: deps.routerAddress,
          data: encodeFunctionData({
            abi: JINN_ROUTER_V3_ABI,
            functionName: "claimVerdictDelivery",
            args: [input.requestId, input.verdictDigest, input.verdictCode],
          }),
        });
        return { status: "settled" as const };
      } catch (error) {
        if (await alreadyClaimed(input.requestId)) return { status: "already-settled" as const };
        const detail = formatKnownRevertDetail(error);
        if (detail?.name === "AlreadyClaimed") return { status: "already-settled" as const };
        return { status: "rejected" as const };
      }
    },
  });
}
```

Export it from `src/index.ts` and add `verdict: createVerdictPorts({ publicClient, broadcast: safe, routerAddress: config.chain.router, mechAddress: config.chain.mech })` to `createBaseVenue`'s returned facade.

- [ ] **Step 4: Run the unit test**

Run: `cd packages/marketplace/venue-base && yarn vitest run src/verdict.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the Anvil-fork integration test**

`packages/marketplace/venue-base/test/verdict.anvil.test.ts` — reuse the venue kit's existing Anvil-fork harness (the same fixture stage 0 built for the claim/settlement ports). Scenario: fork Base Sepolia at `BASE_SEPOLIA_TODAY`; post a task and claim it with a second funded Safe; deliver a solution; then from the evaluator Safe call `canOpenVerdictAttempt` (expect `ok`), `openVerdictAttempt` (expect a `requestId` and a `verdictIndex`), `deliverVerdictToMarketplace`, and `claimVerdictDelivery` with `VerdictCode.Fail`; assert the router's `claimed(requestId)` is true and a second `claimVerdictDelivery` returns `already-settled`. Add the legacy revert-classification fixtures (`NotDelivered`, `AlreadyClaimed`, `RequestNotFound`) as kit cases against `canOpenVerdictAttempt`, per program §6.12.

- [ ] **Step 6: Run the integration test and the package gates**

Run: `cd packages/marketplace/venue-base && yarn typecheck && yarn test && yarn vitest run test/verdict.anvil.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/venue-base
git commit -m "feat(venue-base): add the today-mode verdict port group (Finding 2)"
```

---

### Task 2: Verdict-gate policy assembly

**Files:**
- Create: `client/src/trust/policy-assembly.ts`
- Create: `client/test/trust/policy-assembly.test.ts`

**Interfaces:**
- Consumes: `verifyPolicyChain`, `TrustPolicy`, `PolicyCheckInput` from `@jinn-network/trust-core`; `buildPolicyFixture` from `@jinn-network/trust-testing`.
- Produces:

```ts
export interface AssembledVerdictPolicies {
  readonly admissionAgentPolicy: PolicyCheckInput;
  readonly evaluatorPolicy?: PolicyCheckInput;
  readonly requesterPolicy?: PolicyCheckInput;
}
export function assembleVerdictPolicies(input: {
  readonly policyVersions: readonly Uint8Array[];
  readonly genesisDigest: `sha256:${string}`;
  readonly now: string;
  readonly dsseVerifier: DsseChainVerifier;
  readonly extraAcceptedAdmissionAgents?: readonly string[];
}): AssembledVerdictPolicies;
export class TrustPolicyUnavailableError extends Error {}
```

- [ ] **Step 1: Write the failing test**

`client/test/trust/policy-assembly.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPolicyFixture, testAgentIri } from '@jinn-network/trust-testing';
import { assembleVerdictPolicies, TrustPolicyUnavailableError } from '../../src/trust/policy-assembly.js';

const NOW = '2026-07-30T00:00:00.000Z';

describe('assembleVerdictPolicies', () => {
  it('projects each registered purpose onto its PolicyCheckInput', async () => {
    const admissionAgent = testAgentIri('stage2-admission');
    const evaluator = testAgentIri('stage2-evaluator');
    const fixture = await buildPolicyFixture({
      purposes: {
        'admission-agent': { accepted: [admissionAgent], requiredStrength: 'strong' },
        'evaluator-eligibility': { accepted: [evaluator], requiredStrength: 'weak' },
      },
      refreshBy: '2027-01-01T00:00:00.000Z',
    });

    const assembled = assembleVerdictPolicies({
      policyVersions: [fixture.envelopeBytes],
      genesisDigest: fixture.digest,
      now: NOW,
      dsseVerifier: fixture.dsseVerifier,
    });

    expect(assembled.admissionAgentPolicy).toEqual({ accepted: [admissionAgent], requiredStrength: 'strong' });
    expect(assembled.evaluatorPolicy).toEqual({ accepted: [evaluator], requiredStrength: 'weak' });
    expect(assembled.requesterPolicy).toBeUndefined();
  });

  it('fails closed when the chain does not verify', async () => {
    const fixture = await buildPolicyFixture({
      purposes: { 'admission-agent': { accepted: [testAgentIri('a')], requiredStrength: 'weak' } },
      refreshBy: '2025-01-01T00:00:00.000Z',
    });
    expect(() => assembleVerdictPolicies({
      policyVersions: [fixture.envelopeBytes],
      genesisDigest: fixture.digest,
      now: NOW,
      dsseVerifier: fixture.dsseVerifier,
    })).toThrow(TrustPolicyUnavailableError);
  });

  it('refuses to assemble without an admission-agent purpose', async () => {
    const fixture = await buildPolicyFixture({
      purposes: { 'verifier-agent': { accepted: [testAgentIri('v')], requiredStrength: 'weak' } },
      refreshBy: '2027-01-01T00:00:00.000Z',
    });
    expect(() => assembleVerdictPolicies({
      policyVersions: [fixture.envelopeBytes],
      genesisDigest: fixture.digest,
      now: NOW,
      dsseVerifier: fixture.dsseVerifier,
    })).toThrow(/admission-agent/);
  });
});
```

If `buildPolicyFixture`'s option names differ from `{ purposes, refreshBy }` or it does not return `{ envelopeBytes, digest, dsseVerifier }`, read `packages/trust/testing/src/fixtures.ts` and adapt the test to the real shape — do not change the kit.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && yarn vitest run test/trust/policy-assembly.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`client/src/trust/policy-assembly.ts`:

```ts
import {
  verifyPolicyChain,
  type DsseChainVerifier,
  type PolicyCheckInput,
} from '@jinn-network/trust-core';

export class TrustPolicyUnavailableError extends Error {
  constructor(reason: string) {
    super(`operator trust policy is unusable: ${reason}`);
    this.name = 'TrustPolicyUnavailableError';
  }
}

export interface AssembledVerdictPolicies {
  readonly admissionAgentPolicy: PolicyCheckInput;
  readonly evaluatorPolicy?: PolicyCheckInput;
  readonly requesterPolicy?: PolicyCheckInput;
}

function entry(
  policy: { purposes: Record<string, { accepted: string[]; requiredStrength: 'weak' | 'strong' }> },
  purpose: string,
  extraAccepted: readonly string[] = [],
): PolicyCheckInput | undefined {
  const found = policy.purposes[purpose];
  if (found === undefined) return undefined;
  return {
    accepted: [...found.accepted, ...extraAccepted],
    requiredStrength: found.requiredStrength,
  };
}

/**
 * Resolves the three verdict-gate policy entries from the operator's verified trust-policy
 * chain. Fails closed: an unverifiable, expired, or admission-agent-less policy is an error,
 * never a permissive default (design §6.5; binding §6.4 named checks).
 */
export function assembleVerdictPolicies(input: {
  readonly policyVersions: readonly Uint8Array[];
  readonly genesisDigest: `sha256:${string}`;
  readonly now: string;
  readonly dsseVerifier: DsseChainVerifier;
  readonly extraAcceptedAdmissionAgents?: readonly string[];
}): AssembledVerdictPolicies {
  const verified = verifyPolicyChain([...input.policyVersions], {
    genesisAnchor: { digest: input.genesisDigest },
    now: input.now,
    dsseVerifier: input.dsseVerifier,
  });
  if (!verified.ok || verified.newest === undefined) {
    throw new TrustPolicyUnavailableError(verified.reason ?? 'chain verification failed');
  }
  const policy = verified.newest as unknown as {
    purposes: Record<string, { accepted: string[]; requiredStrength: 'weak' | 'strong' }>;
  };
  const admissionAgentPolicy = entry(policy, 'admission-agent', input.extraAcceptedAdmissionAgents);
  if (admissionAgentPolicy === undefined) {
    throw new TrustPolicyUnavailableError('policy declares no admission-agent purpose');
  }
  const evaluatorPolicy = entry(policy, 'evaluator-eligibility');
  const requesterPolicy = entry(policy, 'adoption-authority');
  return {
    admissionAgentPolicy,
    ...(evaluatorPolicy === undefined ? {} : { evaluatorPolicy }),
    ...(requesterPolicy === undefined ? {} : { requesterPolicy }),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `cd client && yarn vitest run test/trust/policy-assembly.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/trust/policy-assembly.ts client/test/trust/policy-assembly.test.ts
git commit -m "feat(operator): assemble verdict-gate trust policies from the verified policy chain"
```

---

### Task 3: The verdict-observation gate adapter

**Files:**
- Create: `client/src/evaluator/verdict-gate.ts`
- Create: `client/test/evaluator/verdict-gate.test.ts`

**Interfaces:**
- Consumes: `assembleVerdictPolicies` (Task 2); `gateVerdictObservation`, `decisionGradeVerdictCode`, `VerdictObservationGateInput`, `VerdictObservationGatePorts` from `@jinn-network/marketplace-binding`; `createBindingResolver` from `@jinn-network/trust-resolve`; `createFakeResolvers`, `runTwoSafeEvaluatorDistinctnessWalkthrough`, `runOldVerdictAfterKeyRotationWalkthrough` from `@jinn-network/trust-testing`.
- Produces:

```ts
export interface VerdictGateDeps {
  readonly policies: AssembledVerdictPolicies;
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
}
export function createVerdictGate(deps: VerdictGateDeps): {
  gate(input: VerdictObservationGateInput): Promise<VerdictObservationGate>;
};
```

  The projector loop's `AnnouncementProjectionPorts.verifyVerdictObservation` is wired to this in Task 14.

- [ ] **Step 1: Write the failing test**

`client/test/evaluator/verdict-gate.test.ts` — two cases, both driven by the trust kit's own §7.5a fixtures so the gate's policy plumbing is proved against the ratified scenarios (binding design §13):

```ts
import { describe, it, expect } from 'vitest';
import {
  createFakeResolvers,
  runTwoSafeEvaluatorDistinctnessWalkthrough,
  runOldVerdictAfterKeyRotationWalkthrough,
} from '@jinn-network/trust-testing';
import { createVerdictGate } from '../../src/evaluator/verdict-gate.js';

describe('createVerdictGate — §7.5a settlement join wiring', () => {
  it('carries the trust kit\'s rotated-key walkthrough through to a decision-grade result', async () => {
    const fakes = createFakeResolvers();
    const walkthrough = await runOldVerdictAfterKeyRotationWalkthrough(fakes);
    expect(walkthrough.settlementJoin.ok).toBe(true);

    const gate = createVerdictGate({
      policies: {
        admissionAgentPolicy: { accepted: [], requiredStrength: 'weak' },
        evaluatorPolicy: { accepted: [], requiredStrength: 'weak' },
      },
      bindingResolver: fakes.bindingResolver,
      witnessVerifier: fakes.witnessVerifier,
      dsseVerifier: fakes.dsseVerifier,
    });
    expect(typeof gate.gate).toBe('function');
  });

  it('reports a not-decision-grade result with named failures when the evaluator is the solver', async () => {
    const fakes = createFakeResolvers();
    const walkthrough = await runTwoSafeEvaluatorDistinctnessWalkthrough(fakes);
    expect(walkthrough).toBeDefined();
  });
});
```

Then extend both cases into full `gate()` invocations using a `SettlementAuthorizedEvaluationContext` builder placed in `client/test/_support/evaluation-fixtures.ts` (see Task 9's builder — write it there first if Task 9 has not landed): the positive case asserts `decisionGrade === true`; the negative case sets `verdict.evaluatorAddress === verdict.solver.address` and asserts `failures` contains `{ check: 'evaluator-distinctness' }`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && yarn vitest run test/evaluator/verdict-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`client/src/evaluator/verdict-gate.ts`:

```ts
import {
  gateVerdictObservation,
  type VerdictObservationGate,
  type VerdictObservationGateInput,
  type VerdictObservationGatePorts,
} from '@jinn-network/marketplace-binding';
import type { BindingResolver, DsseChainVerifier, WitnessVerifier } from '@jinn-network/trust-core';
import type { AssembledVerdictPolicies } from '../trust/policy-assembly.js';

export interface VerdictGateDeps {
  readonly policies: AssembledVerdictPolicies;
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
}

/**
 * The host side of the decision-grade verdict gate: it owns policy assembly and dependency
 * injection only. Every check lives in the binding (`gateVerdictObservation`); nothing here
 * re-implements one, and the gate never touches the on-chain settlement transaction
 * (binding §6.4 — today-mode on-chain finalization stays advisory).
 */
export function createVerdictGate(deps: VerdictGateDeps): {
  gate(input: VerdictObservationGateInput): Promise<VerdictObservationGate>;
} {
  const ports: VerdictObservationGatePorts = {
    bindingResolver: deps.bindingResolver,
    witnessVerifier: deps.witnessVerifier,
    dsseVerifier: deps.dsseVerifier,
    admissionAgentPolicy: deps.policies.admissionAgentPolicy,
    ...(deps.policies.evaluatorPolicy === undefined ? {} : { evaluatorPolicy: deps.policies.evaluatorPolicy }),
    ...(deps.policies.requesterPolicy === undefined ? {} : { requesterPolicy: deps.policies.requesterPolicy }),
  };
  return { gate: (input) => gateVerdictObservation(input, ports) };
}
```

- [ ] **Step 4: Run the test**

Run: `cd client && yarn vitest run test/evaluator/verdict-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/evaluator/verdict-gate.ts client/test/evaluator/verdict-gate.test.ts
git commit -m "feat(operator): wire the decision-grade verdict-observation gate"
```

---

### Task 4: The self-evaluation skip

**Files:**
- Create: `client/src/evaluator/self-evaluation.ts`
- Create: `client/test/evaluator/self-evaluation.test.ts`

**Interfaces:**
- Produces:

```ts
export interface OperatorIdentity {
  readonly safeAddress: string;
  readonly agentEoa: string;
  readonly agentIri: string;
}
export type EvaluationSkipReason =
  | 'own-solution-safe'
  | 'own-solution-eoa'
  | 'own-solution-agent-iri';
export function selfEvaluationSkip(
  identity: OperatorIdentity,
  solution: { readonly operatorAddress: string; readonly executorAgentIri?: string },
): EvaluationSkipReason | undefined;
```

This is the design's explicit "skipping the operator's own" rule. It is a hard, address-and-identity-level refusal evaluated **before** any material is fetched, so a self-loop never costs an RPC call, and it is defence in depth against the on-chain `evaluator ≠ solver` gate — not a substitute for it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { selfEvaluationSkip } from '../../src/evaluator/self-evaluation.js';

const identity = {
  safeAddress: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa',
  agentEoa: '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb',
  agentIri: 'https://agents.example/jinn/operator-1',
};

describe('selfEvaluationSkip', () => {
  it('skips a solution delivered by the operator\'s own Safe, case-insensitively', () => {
    expect(selfEvaluationSkip(identity, { operatorAddress: identity.safeAddress.toLowerCase() }))
      .toBe('own-solution-safe');
  });

  it('skips a solution delivered by the operator\'s own agent EOA', () => {
    expect(selfEvaluationSkip(identity, { operatorAddress: identity.agentEoa.toUpperCase() }))
      .toBe('own-solution-eoa');
  });

  it('skips a solution whose executor resolves to the operator\'s own Agent IRI', () => {
    expect(selfEvaluationSkip(identity, {
      operatorAddress: '0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc',
      executorAgentIri: identity.agentIri,
    })).toBe('own-solution-agent-iri');
  });

  it('does not skip another operator\'s solution', () => {
    expect(selfEvaluationSkip(identity, {
      operatorAddress: '0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc',
      executorAgentIri: 'https://agents.example/jinn/operator-2',
    })).toBeUndefined();
  });

  it('does not skip when the executor identity is absent and the address differs', () => {
    expect(selfEvaluationSkip(identity, {
      operatorAddress: '0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc',
    })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && yarn vitest run test/evaluator/self-evaluation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export interface OperatorIdentity {
  readonly safeAddress: string;
  readonly agentEoa: string;
  readonly agentIri: string;
}

export type EvaluationSkipReason =
  | 'own-solution-safe'
  | 'own-solution-eoa'
  | 'own-solution-agent-iri';

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The operator never evaluates its own solutions (design §4). Checked before any material is
 * fetched or any transaction is simulated. The on-chain `evaluator != solver` rule and the
 * gate's `evaluator-distinctness` check remain in force; this is the local refusal that keeps
 * the fleet from spending on a claim the venue would reject anyway.
 */
export function selfEvaluationSkip(
  identity: OperatorIdentity,
  solution: { readonly operatorAddress: string; readonly executorAgentIri?: string },
): EvaluationSkipReason | undefined {
  if (sameAddress(solution.operatorAddress, identity.safeAddress)) return 'own-solution-safe';
  if (sameAddress(solution.operatorAddress, identity.agentEoa)) return 'own-solution-eoa';
  if (solution.executorAgentIri !== undefined && solution.executorAgentIri === identity.agentIri) {
    return 'own-solution-agent-iri';
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test**

Run: `cd client && yarn vitest run test/evaluator/self-evaluation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/evaluator/self-evaluation.ts client/test/evaluator/self-evaluation.test.ts
git commit -m "feat(operator): refuse self-evaluation before any evaluation work starts"
```

---

### Task 5: Evaluation-opportunity source

**Files:**
- Create: `client/src/evaluator/opportunities.ts`
- Create: `client/test/evaluator/opportunities.test.ts`

**Interfaces:**
- Consumes: the stage-1 projector loop's `subscribeObservations(handler)` and `MarketplaceProtocolObservation` / `ObservationMarketplaceEvent` from `@jinn-network/marketplace-projector`; `selfEvaluationSkip` (Task 4).
- Produces:

```ts
export interface EvaluationOpportunity {
  readonly chainId: number;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly solutionRequestId: `0x${string}`;
  readonly operatorAddress: string;
  readonly deliveryCid: string;
  readonly blockHash: `0x${string}`;
}
export function createOpportunitySource(deps: {
  readonly subscribeObservations: (handler: (event: ObservationMarketplaceEvent) => void) => () => void;
  readonly identity: OperatorIdentity;
  readonly onSkip?: (reason: EvaluationSkipReason, taskId: bigint, attemptIndex: number) => void;
}): { subscribe(handler: (opportunity: EvaluationOpportunity) => void): () => void };
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createOpportunitySource } from '../../src/evaluator/opportunities.js';

const identity = {
  safeAddress: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa',
  agentEoa: '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb',
  agentIri: 'https://agents.example/jinn/operator-1',
};

function solutionClaimed(operator: string) {
  return {
    event: 'SolutionDeliveryClaimed',
    facts: {
      taskId: 7n,
      attemptIndex: 1,
      requestId: `0x${'cd'.repeat(32)}`,
      operator,
    },
    derivation: { chainId: 84532, blockHash: `0x${'ee'.repeat(32)}` },
    projection: { deliveryCorrespondence: { cid: 'bafySolutionCid' } },
  } as never;
}

describe('createOpportunitySource', () => {
  it('emits an opportunity for another operator\'s claimed solution delivery', () => {
    let emit: (event: never) => void = () => {};
    const source = createOpportunitySource({
      subscribeObservations: (handler) => { emit = handler as never; return () => {}; },
      identity,
    });
    const seen: unknown[] = [];
    source.subscribe((opportunity) => seen.push(opportunity));
    emit(solutionClaimed('0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId: 7n, attemptIndex: 1, deliveryCid: 'bafySolutionCid' });
  });

  it('never emits an opportunity for the operator\'s own solution and reports the skip', () => {
    let emit: (event: never) => void = () => {};
    const onSkip = vi.fn();
    const source = createOpportunitySource({
      subscribeObservations: (handler) => { emit = handler as never; return () => {}; },
      identity,
      onSkip,
    });
    const seen: unknown[] = [];
    source.subscribe((opportunity) => seen.push(opportunity));
    emit(solutionClaimed(identity.safeAddress));
    expect(seen).toHaveLength(0);
    expect(onSkip).toHaveBeenCalledWith('own-solution-safe', 7n, 1);
  });

  it('ignores verdict-delivery events — an evaluation is never an evaluation opportunity', () => {
    let emit: (event: never) => void = () => {};
    const source = createOpportunitySource({
      subscribeObservations: (handler) => { emit = handler as never; return () => {}; },
      identity,
    });
    const seen: unknown[] = [];
    source.subscribe((opportunity) => seen.push(opportunity));
    emit({ ...(solutionClaimed('0xCC') as object), event: 'VerdictDeliveryClaimed' } as never);
    expect(seen).toHaveLength(0);
  });
});
```

Confirm the exact `projection` field carrying the delivery CID against `packages/marketplace/projector/src/observe.ts` (`ObservationProjectionContext.deliveryCorrespondence`) and adjust the fixture to the real shape before implementing — the projector is law here.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && yarn vitest run test/evaluator/opportunities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { ObservationMarketplaceEvent } from '@jinn-network/marketplace-projector';
import {
  selfEvaluationSkip,
  type EvaluationSkipReason,
  type OperatorIdentity,
} from './self-evaluation.js';

export interface EvaluationOpportunity {
  readonly chainId: number;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly solutionRequestId: `0x${string}`;
  readonly operatorAddress: string;
  readonly deliveryCid: string;
  readonly blockHash: `0x${string}`;
}

/**
 * Evaluation opportunities are delivery announcements (binding §6.4) — the projector's
 * SolutionDeliveryClaimed observations, not a bespoke log scan. The operator's own solutions
 * are dropped here, before any material fetch.
 */
export function createOpportunitySource(deps: {
  readonly subscribeObservations: (handler: (event: ObservationMarketplaceEvent) => void) => () => void;
  readonly identity: OperatorIdentity;
  readonly onSkip?: (reason: EvaluationSkipReason, taskId: bigint, attemptIndex: number) => void;
}): { subscribe(handler: (opportunity: EvaluationOpportunity) => void): () => void } {
  return {
    subscribe(handler) {
      return deps.subscribeObservations((event) => {
        if (event.event !== 'SolutionDeliveryClaimed') return;
        const facts = event.facts as {
          taskId: bigint; attemptIndex: number; requestId: `0x${string}`; operator: string;
        };
        const skip = selfEvaluationSkip(deps.identity, { operatorAddress: facts.operator });
        if (skip !== undefined) {
          deps.onSkip?.(skip, facts.taskId, facts.attemptIndex);
          return;
        }
        const cid = event.projection.deliveryCorrespondence?.cid;
        if (cid === undefined) return;
        handler({
          chainId: event.derivation.chainId,
          taskId: facts.taskId,
          attemptIndex: facts.attemptIndex,
          solutionRequestId: facts.requestId,
          operatorAddress: facts.operator,
          deliveryCid: cid,
          blockHash: event.derivation.blockHash,
        });
      });
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `cd client && yarn vitest run test/evaluator/opportunities.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/evaluator/opportunities.ts client/test/evaluator/opportunities.test.ts
git commit -m "feat(operator): derive evaluation opportunities from projector delivery observations"
```

---

### Task 6: Exact subject-material acquisition

**Files:**
- Create: `client/src/evaluator/subject-material.ts`
- Create: `client/test/evaluator/subject-material.test.ts`

**Interfaces:**
- Consumes: `inspectDelivery`-equivalent parsing via `DeliveryRecordSchema` from `@jinn-network/task-execution-protocol`; `decodeRawCodecCidDigestHex` from `@jinn-network/marketplace-binding`; the stage-1 `deriveBridgeTask` (Finding 4); an injected `FetchBytesByDigest` port satisfied by the operator's IPFS gateway client and evidence retrieval.
- Produces:

```ts
export interface FetchBytesByDigest {
  byCid(cid: string): Promise<Uint8Array>;
  byDigest(digest: `sha256:${string}`): Promise<Uint8Array>;
}
export interface SubjectMaterial {
  readonly task: { readonly name: string; readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
  readonly delivery: { readonly name: string; readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
  readonly results: readonly { readonly name: string; readonly digest: `sha256:${string}`; readonly bytes: Uint8Array }[];
  readonly evaluationSpec: { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
}
export class SubjectMaterialError extends Error { readonly kind: 'unavailable' | 'digest-mismatch' | 'no-evaluation-spec' }
export async function acquireSubjectMaterial(
  opportunity: EvaluationOpportunity,
  fetcher: FetchBytesByDigest,
): Promise<SubjectMaterial>;
```

Every fetched blob is re-hashed and compared to the digest that named it; a mismatch is `SubjectMaterialError('digest-mismatch')` and the opportunity is abandoned. This is what makes derivation byte-equality reachable at all.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { acquireSubjectMaterial, SubjectMaterialError } from '../../src/evaluator/subject-material.js';

const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;

function fixtures() {
  const taskBytes = new TextEncoder().encode(JSON.stringify({ protocol: 'https://jinn.network/tep/1.0' }));
  const specBytes = new TextEncoder().encode(JSON.stringify({ family: 'deterministic-process' }));
  const resultBytes = new TextEncoder().encode('result-artifact');
  const delivery = {
    protocol: 'https://jinn.network/tep/1.0',
    attempt: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    task: { sha256: sha256(taskBytes).slice('sha256:'.length) },
    outputs: [{ name: 'patch', digest: { sha256: sha256(resultBytes).slice('sha256:'.length) } }],
    outcome: 'fulfilled',
    createdAt: '2026-07-30T00:00:00Z',
  };
  const deliveryBytes = new TextEncoder().encode(JSON.stringify(delivery));
  return { taskBytes, specBytes, resultBytes, deliveryBytes };
}

describe('acquireSubjectMaterial', () => {
  it('returns exact bytes for task, delivery, every result, and the evaluation spec', async () => {
    const f = fixtures();
    const material = await acquireSubjectMaterial(
      { deliveryCid: 'bafyDelivery' } as never,
      {
        byCid: async () => f.deliveryBytes,
        byDigest: async (digest) => {
          if (digest === sha256(f.taskBytes)) return f.taskBytes;
          if (digest === sha256(f.resultBytes)) return f.resultBytes;
          if (digest === sha256(f.specBytes)) return f.specBytes;
          throw new Error(`unexpected digest ${digest}`);
        },
      },
    );
    expect(material.task.bytes).toEqual(f.taskBytes);
    expect(material.results).toHaveLength(1);
    expect(material.results[0]!.name).toBe('patch');
  });

  it('refuses material whose bytes do not hash to the naming digest', async () => {
    const f = fixtures();
    await expect(acquireSubjectMaterial(
      { deliveryCid: 'bafyDelivery' } as never,
      { byCid: async () => f.deliveryBytes, byDigest: async () => new TextEncoder().encode('tampered') },
    )).rejects.toMatchObject({ kind: 'digest-mismatch' });
  });

  it('refuses a subject Task that declares no evaluation spec', async () => {
    const f = fixtures();
    await expect(acquireSubjectMaterial(
      { deliveryCid: 'bafyDelivery' } as never,
      { byCid: async () => f.deliveryBytes, byDigest: async () => f.taskBytes },
    )).rejects.toBeInstanceOf(SubjectMaterialError);
  });
});
```

The first test's Task fixture must carry an `evaluation: { digest: { sha256: … } }` descriptor pointing at the spec bytes — add it to `fixtures()` before running (the third test deliberately omits it).

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && yarn vitest run test/evaluator/subject-material.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`client/src/evaluator/subject-material.ts` — fetch the sealed Delivery by CID, parse it with `DeliveryRecordSchema`, fetch the Task by `delivery.task.sha256`, parse it with `TaskSpecificationSchema`, read `task.evaluation.digest.sha256` for the spec (throw `SubjectMaterialError('no-evaluation-spec')` when absent), fetch each `delivery.outputs[]` artifact by its descriptor digest, and re-hash every blob with `node:crypto` before returning it. Names: the Task subject is named `task`, the Delivery subject `delivery`, and each Result keeps its `outputs[].name` — the same names `deriveEvaluationTask` sorts on, so both parties derive identical bytes. Wrap every fetch failure as `SubjectMaterialError('unavailable')`.

- [ ] **Step 4: Add the cross-operator determinism fixture (Finding 4)**

Append to the test file: build a legacy task document, run `deriveBridgeTask` twice from two independently constructed inputs (simulating solver and evaluator), and assert the sealed bytes are byte-identical. If `client/src/bridge/legacy-task.ts` does not exist, create it in this task with the pure derivation and re-point the stage-1 work loop at it in this same commit.

- [ ] **Step 5: Run the tests**

Run: `cd client && yarn vitest run test/evaluator/subject-material.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/evaluator/subject-material.ts client/test/evaluator/subject-material.test.ts
git commit -m "feat(operator): acquire exact evaluation subject material with digest verification"
```

---

### Task 7: Bridge-era subject Submission and admission receipt (Finding 3)

**Files:**
- Create: `client/src/evaluator/bridge-subject.ts`
- Create: `client/test/evaluator/bridge-subject.test.ts`
- Modify: `docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md` (append the dated §10 bridge-era rule addendum note, once the coordinator rules)

**Interfaces:**
- Consumes: `sealSubmission`, `documentDigest`, `SubmissionRecordSchema` from `@jinn-network/task-execution-protocol`; `ADMISSION_RECEIPT_ANNOTATION_URI` from `@jinn-network/marketplace-binding`; `sealEvaluationSpec`, admission-receipt sealing from `@jinn-network/task-execution-profiles`; a `DsseSigner` for the fleet admission agent.
- Produces:

```ts
export interface BridgeSubject {
  readonly submission: { readonly document: SubmissionRecord; readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly admissionReceipt: { readonly envelopeBytes: Uint8Array; readonly digest: `sha256:${string}`; readonly effectiveTime: string };
  readonly derivation: 'legacy';
}
export async function synthesizeBridgeSubject(input: {
  readonly subjectTaskDigest: `sha256:${string}`;
  readonly evaluationSpecDigest: `sha256:${string}`;
  readonly requesterAgentIri: string;
  readonly admissionAgentIri: string;
  readonly legacyAnchor: { readonly chainId: number; readonly taskId: bigint; readonly blockHash: `0x${string}` };
  readonly now: string;
  readonly signer: DsseSigner;
}): Promise<BridgeSubject>;
```

The synthesized Submission is deterministic in every field: `submission` is a UUIDv5-style URN derived from `(chainId, taskId)`, `idempotencyKey` and `nonce` are derived from the anchor, `deadline` is the legacy task's deadline, and the `legacy` derivation annotation records `{ chainId, taskId, blockHash }`. Determinism is the whole point — a second party must reproduce the same bytes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { SubmissionRecordSchema } from '@jinn-network/task-execution-protocol';
import { ADMISSION_RECEIPT_ANNOTATION_URI } from '@jinn-network/marketplace-binding';
import { synthesizeBridgeSubject } from '../../src/evaluator/bridge-subject.js';
import { testDsseSigner } from '../_support/evaluation-fixtures.js';

const input = {
  subjectTaskDigest: `sha256:${'a'.repeat(64)}` as const,
  evaluationSpecDigest: `sha256:${'b'.repeat(64)}` as const,
  requesterAgentIri: 'https://agents.example/jinn/requester-1',
  admissionAgentIri: 'https://agents.example/jinn/admission-1',
  legacyAnchor: { chainId: 84532, taskId: 7n, blockHash: `0x${'ee'.repeat(32)}` as const },
  now: '2026-07-30T00:00:00.000Z',
};

describe('synthesizeBridgeSubject', () => {
  it('produces a schema-valid Submission carrying the admission-receipt descriptor', async () => {
    const subject = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    expect(() => SubmissionRecordSchema.parse(subject.submission.document)).not.toThrow();
    expect(subject.submission.document.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI]).toBeDefined();
    expect(subject.submission.document.task.digest?.sha256).toBe(input.subjectTaskDigest.slice(7));
  });

  it('is deterministic — two independent parties derive byte-identical Submissions', async () => {
    const a = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    const b = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    expect(a.submission.bytes).toEqual(b.submission.bytes);
    expect(a.submission.digest).toBe(b.submission.digest);
  });

  it('marks the derivation as legacy so consumers can see the bridge provenance', async () => {
    const subject = await synthesizeBridgeSubject({ ...input, signer: testDsseSigner('admission') });
    expect(subject.derivation).toBe('legacy');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && yarn vitest run test/evaluator/bridge-subject.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Build the admission receipt first (it is a `ResourceDescriptor` naming a DSSE envelope; use the profiles package's `checkAdmissionReceipt` structure as the contract — the receipt payload binds `expectedTaskDigest` and `expectedEvaluationSpecDigest`, and its issuer is `admissionAgentIri`). Seal it, take `documentDigest(envelopeBytes)` as the descriptor digest, then build the Submission document with the descriptor at `annotations[ADMISSION_RECEIPT_ANNOTATION_URI]` and `sealSubmission` it. Derive `submission`, `idempotencyKey` and `nonce` from `${chainId}:${taskId}` with a fixed namespace so nothing wall-clock or random enters the bytes.

- [ ] **Step 4: Run the test**

Run: `cd client && yarn vitest run test/evaluator/bridge-subject.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Record the addendum**

Append a dated note to the design's §10 bridge-era document rules naming this third rule and its stage-3 removal, per the program's designs-are-law discipline. Do not merge Task 7 before the coordinator rules on Finding 3.

- [ ] **Step 6: Commit**

```bash
git add client/src/evaluator/bridge-subject.ts client/test/evaluator/bridge-subject.test.ts docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md
git commit -m "feat(operator): synthesize the bridge-era evaluation subject Submission (Finding 3)"
```

---

### Task 8: Self-signer grant allowance in the binding (Finding 1)

**Files:**
- Modify: `packages/marketplace/binding/src/evaluation-derive.ts`
- Modify: `packages/marketplace/binding/src/evaluation-derive.test.ts`
- Modify: `docs/superpowers/specs/2026-07-28-marketplace-binding-design.md` (dated addendum to §6.4)

**Interfaces:**
- Produces: `DeriveAndSealEvaluationSubmissionInput` gains `readonly selfSignerGrantKey?: string;`. The rule, precisely: when `sealerRole === "evaluator"`, `publicSpec` must be `true`, and `capabilityGrants` must be either empty **or** exactly `{ [selfSignerGrantKey]: descriptor }` with `selfSignerGrantKey` supplied. Any other key, any missing `selfSignerGrantKey`, and any private spec still throws.

- [ ] **Step 1: Write the failing tests**

Append to `packages/marketplace/binding/src/evaluation-derive.test.ts`:

```ts
test("evaluator sealing admits exactly one declared self-signer grant (§7.40 addendum)", () => {
  const result = deriveAndSealEvaluationSubmission({
    ...evaluatorSealedInput(),
    publicSpec: true,
    sealerRole: "evaluator",
    selfSignerGrantKey: "evaluator-signer",
    capabilityGrants: { "evaluator-signer": { name: "evaluator-signer" } },
  });
  expect(result.submission.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("evaluator sealing still refuses a grant that is not the declared self-signer", () => {
  expect(() => deriveAndSealEvaluationSubmission({
    ...evaluatorSealedInput(),
    publicSpec: true,
    sealerRole: "evaluator",
    selfSignerGrantKey: "evaluator-signer",
    capabilityGrants: { "evaluator-signer": {}, "private-grader": {} },
  })).toThrow(/fully public/);
});

test("evaluator sealing still refuses a private specification even with a self-signer grant", () => {
  expect(() => deriveAndSealEvaluationSubmission({
    ...evaluatorSealedInput(),
    publicSpec: false,
    sealerRole: "evaluator",
    selfSignerGrantKey: "evaluator-signer",
    capabilityGrants: { "evaluator-signer": {} },
  })).toThrow(/requester-side sealing/);
});

test("evaluator sealing refuses a grant when no self-signer key is declared", () => {
  expect(() => deriveAndSealEvaluationSubmission({
    ...evaluatorSealedInput(),
    publicSpec: true,
    sealerRole: "evaluator",
    capabilityGrants: { "evaluator-signer": {} },
  })).toThrow(/fully public/);
});
```

`evaluatorSealedInput()` is a local helper in that file supplying `subjectTask`, `subjectDelivery`, `subjectResults`, `evaluationSpecDigest`, `subjectSubmission`, and `submissionFields` — reuse the file's existing fixture builder rather than writing a new one.

- [ ] **Step 2: Run them and confirm the first fails**

Run: `cd packages/marketplace/binding && yarn vitest run src/evaluation-derive.test.ts`
Expected: FAIL — the first new test throws `evaluator sealing is allowed only for a fully public, grant-free evaluation (§7.40)`.

- [ ] **Step 3: Implement the allowance**

Replace `assertSealerRule` in `packages/marketplace/binding/src/evaluation-derive.ts`:

```ts
function assertSealerRule(input: DeriveAndSealEvaluationSubmissionInput): void {
  const grantKeys = Object.keys(input.capabilityGrants);
  if (input.sealerRole !== "evaluator") return;
  if (!input.publicSpec) {
    throw new Error("private evaluation specifications require requester-side sealing (§7.40)");
  }
  if (grantKeys.length === 0) return;
  // §7.40 addendum (2026-07-30): the evaluator's OWN signing-key forward is an
  // operator-local handle, not requester-conveyed private material. Exactly one such key
  // is admitted, and only when the evaluator declares it.
  const selfSigner = input.selfSignerGrantKey;
  if (selfSigner === undefined || grantKeys.length !== 1 || grantKeys[0] !== selfSigner) {
    throw new Error("evaluator sealing is allowed only for a fully public, grant-free evaluation (§7.40)");
  }
}
```

and add `readonly selfSignerGrantKey?: string;` to `DeriveAndSealEvaluationSubmissionInput`.

- [ ] **Step 4: Run the binding package suite**

Run: `cd packages/marketplace/binding && yarn typecheck && yarn test`
Expected: PASS, including the pre-existing carve-out tests.

- [ ] **Step 5: Record the addendum**

Append the dated §6.4 addendum to the marketplace-binding design naming the allowance, its two conditions, and why the named checks are unaffected (the gate byte-checks the evaluation Task, never the evaluation Submission's grants). Do not merge before the coordinator rules on Finding 1.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/binding docs/superpowers/specs/2026-07-28-marketplace-binding-design.md
git commit -m "feat(binding): admit one self-signer grant under the evaluator-seals carve-out (Finding 1)"
```

---

### Task 9: Evaluation Submission derivation with the carve-out enforced

**Files:**
- Create: `client/src/evaluator/submission.ts`
- Create: `client/test/evaluator/submission.test.ts`
- Create: `client/test/_support/evaluation-fixtures.ts`

**Interfaces:**
- Consumes: `deriveAndSealEvaluationSubmission` (Task 8's shape); `SubjectMaterial` (Task 6); `BridgeSubject` (Task 7); `parseEvaluationSpec` from `@jinn-network/task-execution-profiles`.
- Produces:

```ts
export type CarveOutRefusal =
  | { readonly kind: 'private-specification'; readonly detail: string }
  | { readonly kind: 'grant-bearing-specification'; readonly detail: string };
export const EVALUATOR_SIGNER_GRANT_KEY = 'evaluator-signer';
export function evaluationCarveOutRefusal(spec: EvaluationSpec): CarveOutRefusal | undefined;
export function buildEvaluationDispatch(input: {
  readonly material: SubjectMaterial;
  readonly subject: BridgeSubject;
  readonly evaluatorAgentIri: string;
  readonly deadline: string;
}): { readonly task: SealedDocumentTriple; readonly submission: SealedDocumentTriple };
```

- [ ] **Step 1: Write the failing carve-out tests**

```ts
import { describe, it, expect } from 'vitest';
import { evaluationCarveOutRefusal, buildEvaluationDispatch, EVALUATOR_SIGNER_GRANT_KEY }
  from '../../src/evaluator/submission.js';
import { publicSpec, privateSpec, grantBearingSpec, subjectMaterialFixture, bridgeSubjectFixture }
  from '../_support/evaluation-fixtures.js';

describe('evaluator-seals carve-out', () => {
  it('accepts a fully public evaluation specification', () => {
    expect(evaluationCarveOutRefusal(publicSpec())).toBeUndefined();
  });

  it('refuses a specification whose test material is private — requester-side sealing is stage 3', () => {
    expect(evaluationCarveOutRefusal(privateSpec())).toMatchObject({ kind: 'private-specification' });
  });

  it('refuses a specification that requires capability grants', () => {
    expect(evaluationCarveOutRefusal(grantBearingSpec())).toMatchObject({ kind: 'grant-bearing-specification' });
  });
});

describe('buildEvaluationDispatch', () => {
  it('carries exactly the self-signer grant and nothing else', async () => {
    const dispatch = buildEvaluationDispatch({
      material: await subjectMaterialFixture(),
      subject: await bridgeSubjectFixture(),
      evaluatorAgentIri: 'https://agents.example/jinn/operator-1',
      deadline: '2026-07-31T00:00:00.000Z',
    });
    const grants = (dispatch.submission.document as { capabilityGrants: Record<string, unknown> }).capabilityGrants;
    expect(Object.keys(grants)).toEqual([EVALUATOR_SIGNER_GRANT_KEY]);
  });

  it('derives a Task byte-identical to an independent derivation of the same pair', async () => {
    const material = await subjectMaterialFixture();
    const subject = await bridgeSubjectFixture();
    const a = buildEvaluationDispatch({ material, subject, evaluatorAgentIri: 'x', deadline: '2026-07-31T00:00:00.000Z' });
    const b = buildEvaluationDispatch({ material, subject, evaluatorAgentIri: 'y', deadline: '2026-07-31T00:00:00.000Z' });
    expect(a.task.bytes).toEqual(b.task.bytes);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && yarn vitest run test/evaluator/submission.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the fixtures support module**

`client/test/_support/evaluation-fixtures.ts` exports `publicSpec()`, `privateSpec()`, `grantBearingSpec()` (all built through `sealEvaluationSpec` / `parseEvaluationSpec` so they are real specs, not object literals), `subjectMaterialFixture()`, `bridgeSubjectFixture()`, and `testDsseSigner(seed)` (an Ed25519 `DsseSigner` over a deterministic seed). Task 3 and Task 7 import from here.

- [ ] **Step 4: Implement**

`client/src/evaluator/submission.ts` — `evaluationCarveOutRefusal` inspects the parsed spec for private test material and declared capability-grant requirements; `buildEvaluationDispatch` calls `deriveAndSealEvaluationSubmission` with `sealerRole: 'evaluator'`, `publicSpec: true`, `selfSignerGrantKey: EVALUATOR_SIGNER_GRANT_KEY`, `capabilityGrants: { [EVALUATOR_SIGNER_GRANT_KEY]: { name: EVALUATOR_SIGNER_GRANT_KEY } }`, `subjectSubmission: input.subject.submission.document`, and the four subject references from `input.material`. It never constructs a Task document by hand — the binding owns the derivation.

- [ ] **Step 5: Run the tests**

Run: `cd client && yarn vitest run test/evaluator/submission.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/evaluator/submission.ts client/test/evaluator/submission.test.ts client/test/_support/evaluation-fixtures.ts
git commit -m "feat(operator): derive evaluation dispatch documents under the evaluator-seals carve-out"
```

---

### Task 10: Durable verdict-intent admission

**Files:**
- Create: `client/src/evaluator/intents.ts`
- Create: `client/test/evaluator/intents.test.ts`

**Interfaces:**
- Consumes: the stage-1 `EngagementLedger`; `venue.intents` (the venue-base durable posting-intent store); `recoverPostingIntents` / `PostingIntentStore` from `@jinn-network/marketplace-binding`.
- Produces:

```ts
export interface VerdictIntent {
  readonly idempotencyKey: string;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly evaluationTaskDigest: `sha256:${string}`;
  readonly wiringEntryId: string;
}
export function verdictIdempotencyKey(input: { chainId: number; taskId: bigint; attemptIndex: number; evaluationTaskDigest: string }): string;
export async function admitVerdictIntent(deps: {
  readonly ledger: EngagementLedger;
  readonly intents: PostingIntentStore;
}, intent: VerdictIntent): Promise<{ readonly admitted: boolean; readonly ownerToken?: PostingOwnerToken }>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { admitVerdictIntent, verdictIdempotencyKey } from '../../src/evaluator/intents.js';

const intent = {
  idempotencyKey: '',
  taskId: 7n,
  attemptIndex: 1,
  evaluationTaskDigest: `sha256:${'a'.repeat(64)}` as const,
  wiringEntryId: 'wiring-1',
};

describe('verdict intent admission', () => {
  it('derives a stable idempotency key from the logical operation identity, not a tx hash', () => {
    const key = verdictIdempotencyKey({ chainId: 84532, taskId: 7n, attemptIndex: 1, evaluationTaskDigest: intent.evaluationTaskDigest });
    expect(key).toBe(verdictIdempotencyKey({ chainId: 84532, taskId: 7n, attemptIndex: 1, evaluationTaskDigest: intent.evaluationTaskDigest }));
    expect(key).not.toBe(verdictIdempotencyKey({ chainId: 84532, taskId: 7n, attemptIndex: 2, evaluationTaskDigest: intent.evaluationTaskDigest }));
  });

  it('writes the ledger row before the intent is claimable for broadcast', async () => {
    const order: string[] = [];
    const ledger = { admitIntent: vi.fn(async () => { order.push('ledger'); }) };
    const intents = { claim: vi.fn(async () => { order.push('intent'); return { ok: true, ownerToken: 'token' }; }) };
    await admitVerdictIntent({ ledger, intents } as never, { ...intent, idempotencyKey: 'k' });
    expect(order).toEqual(['ledger', 'intent']);
  });

  it('does not re-admit an intent whose key is already claimed', async () => {
    const ledger = { admitIntent: vi.fn(async () => {}) };
    const intents = { claim: vi.fn(async () => ({ ok: false })) };
    const result = await admitVerdictIntent({ ledger, intents } as never, { ...intent, idempotencyKey: 'k' });
    expect(result.admitted).toBe(false);
  });
});
```

Read `packages/marketplace/binding/src/broadcast-intent.ts` for the real `PostingIntentStore` method names and adapt the fakes to them before implementing.

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && yarn vitest run test/evaluator/intents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

The ledger write and the intent row go in the **same SQLite transaction**, and both complete before any call reaches `venue.verdict.openVerdictAttempt` (program §6.2). The idempotency key is `sha256(`verdict:${chainId}:${taskId}:${attemptIndex}:${evaluationTaskDigest}`)` — a logical operation identity, never a transaction hash (design §7.4).

- [ ] **Step 4: Run the test**

Run: `cd client && yarn vitest run test/evaluator/intents.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/evaluator/intents.ts client/test/evaluator/intents.test.ts
git commit -m "feat(operator): admit verdict intents ledger-first through the durable intent store"
```

---

### Task 11: Evaluation deployment facade, grader-container execution, and launcher registration

**Files:**
- Create: `client/src/evaluator/deployment.ts`
- Create: `client/src/evaluator/launcher.ts`
- Create: `client/src/evaluator/grader-execution.ts`
- Create: `client/test/evaluator/deployment.test.ts`
- Create: `client/test/evaluator/grader-execution.test.ts`

**Interfaces:**
- Consumes: **`createEvaluatorDeployment({ evidenceWriter, maxClaimEvidenceBytes?, signerHandle?, evaluatorId? })` from `@jinn-network/task-execution-evaluator-adapters`** — the binding cross-plan composition surface published by the evaluator-adapters plan. It returns the assembled `EvaluationHarnessDeployment` (registrations + parser allowlist + evidence writer). **Do not re-derive registrations or the allowlist here**: the adapters tree owns both, and hand-assembling them in the host would fork the allowlist that gates parser selection. Also consumes `makeEvaluationLauncher` / `EVALUATION_LAUNCHER_ID` from `@jinn-network/task-execution-evaluation-harness`, the operator's evidence repository writer, and the operator's container runtime (the same one the solve-side launchers use).
- Produces:

```ts
export const evaluationHarnessDeployment: EvaluationHarnessDeployment; // built by createEvaluatorDeployment; the module the launcher spawns against
export function buildEvaluationLauncher(input: {
  readonly deploymentModule: string;
  readonly deployment: EvaluationHarnessDeployment;
}): LauncherContract;
export function graderExecutionProvisioner(input: {
  readonly containerRuntime: ContainerRuntime;
}): (provision: LocalProvisionerInput) => SelectedProvisioner;
```

The deployment module path handed to `makeEvaluationLauncher` must resolve **in the built tree** (`dist/evaluator/deployment.js`), because the launcher spawns a fresh Node process against it. Compute it with `new URL('./deployment.js', import.meta.url).href` from `launcher.ts` so dev (`tsx`) and production (`dist`) both resolve.

**This stage is the execution owner.** The evaluator-adapters are **parse-only by design ruling** — nothing in that tree executes the `deterministic-process` grader container. Execution belongs here, because a verdict *is* an evaluation-profile Attempt on the embedded backend: the backend's provisioner/launcher chain runs the grader container as part of provisioning the Attempt workspace, and the adapter then parses the provisioned output. The adapter's resolution order is fixed by that plan and this task must satisfy it in the workspace it lays down:

1. the subject **Results** already materialized in `input/` (the ordinary case — the grader output rode the subject Delivery), then
2. `evaluation-context.json` in `input/` (written by this task's provisioner from the grader container's run), and
3. neither present → the adapter raises `subject-not-found`. **The adapter never invents a verdict, and this task never papers over a missing artifact by synthesizing one** — a grader container that fails to produce output is `failed[infrastructure]`, which the profiles design's unscorable taxonomy keeps off the failing-verdict path.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { EVALUATION_TASK_PROFILE_URI } from '@jinn-network/task-execution-profiles';
import { buildEvaluationLauncher } from '../../src/evaluator/launcher.js';
import { evaluationHarnessDeployment } from '../../src/evaluator/deployment.js';

describe('evaluation launcher registration', () => {
  it('advertises the evaluation task profile once registrations are configured', () => {
    const launcher = buildEvaluationLauncher({
      deploymentModule: 'file:///dev/null',
      deployment: evaluationHarnessDeployment,
    });
    expect(launcher.capabilities().taskProfiles).toContain(EVALUATION_TASK_PROFILE_URI);
  });

  it('declares exactly one secret forward, for the evaluator signer handle', () => {
    const launcher = buildEvaluationLauncher({
      deploymentModule: 'file:///dev/null',
      deployment: evaluationHarnessDeployment,
    });
    const forwards = launcher.capabilities().secretForwards;
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.grantKey).toBe('evaluator-signer');
  });

  it('takes its registrations and parser allowlist from the adapters facade, not from local assembly', () => {
    expect(evaluationHarnessDeployment.parserAllowlist.size).toBeGreaterThan(0);
    expect(evaluationHarnessDeployment.registrations.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && yarn vitest run test/evaluator/deployment.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the deployment facade consumption**

```ts
// client/src/evaluator/deployment.ts
import { createEvaluatorDeployment } from '@jinn-network/task-execution-evaluator-adapters';
import type { EvaluationHarnessDeployment } from '@jinn-network/task-execution-evaluation-harness';
import { EVALUATOR_SIGNER_GRANT_KEY } from './submission.js';
import { operatorEvidenceWriter, evaluatorSettings } from './settings.js';

/**
 * The deployment the evaluation-harness launcher spawns against. The adapters tree owns the
 * registrations and the parser allowlist; the host supplies only its evidence writer, its
 * signer handle, and its evaluator identity. Re-deriving either set here would fork the
 * allowlist that gates parser selection inside the harness.
 */
export const evaluationHarnessDeployment: EvaluationHarnessDeployment =
  createEvaluatorDeployment({
    evidenceWriter: operatorEvidenceWriter(),
    maxClaimEvidenceBytes: evaluatorSettings().maxClaimEvidenceBytes,
    signerHandle: EVALUATOR_SIGNER_GRANT_KEY,
    evaluatorId: evaluatorSettings().evaluatorAgentIri,
  });
```

`launcher.ts` wraps `makeEvaluationLauncher({ deploymentModule, registrations: deployment.registrations, selectRegistration })` with a `selectRegistration` that picks by the resolved spec's `family` — never by anything the Task bytes can steer beyond the spec itself. `settings.ts` is a thin accessor over the Task 14 config block; create it in this task.

- [ ] **Step 4: Write the failing grader-execution test**

`client/test/evaluator/grader-execution.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { graderExecutionProvisioner } from '../../src/evaluator/grader-execution.js';
import { deterministicProcessSpec, provisionInputFixture } from '../_support/evaluation-fixtures.js';

describe('grader-container execution (this stage is the execution owner)', () => {
  it('runs the grader container and writes evaluation-context.json into input/', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-grader-'));
    const containerRuntime = { run: vi.fn(async () => ({ exitCode: 0, stdout: '{"tests_passed":3}' })) };
    const provisioner = graderExecutionProvisioner({ containerRuntime })(
      provisionInputFixture({ root, spec: deterministicProcessSpec() }),
    );
    await provisioner.contract.setup(...provisionInputFixture.setupArgs({ root }));
    expect(containerRuntime.run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, 'input/evaluation-context.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'input/evaluation-context.json'), 'utf8'))).toMatchObject({
      tests_passed: 3,
    });
  });

  it('does not run a container when the subject Results already carry the grader output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-grader-'));
    const containerRuntime = { run: vi.fn() };
    const provisioner = graderExecutionProvisioner({ containerRuntime })(
      provisionInputFixture({ root, spec: deterministicProcessSpec(), resultsCarryGraderOutput: true }),
    );
    await provisioner.contract.setup(...provisionInputFixture.setupArgs({ root }));
    expect(containerRuntime.run).not.toHaveBeenCalled();
  });

  it('fails the attempt as infrastructure when the container produces no parsable output — never invents a verdict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-grader-'));
    const containerRuntime = { run: vi.fn(async () => ({ exitCode: 1, stdout: '' })) };
    const provisioner = graderExecutionProvisioner({ containerRuntime })(
      provisionInputFixture({ root, spec: deterministicProcessSpec() }),
    );
    await expect(provisioner.contract.setup(...provisionInputFixture.setupArgs({ root })))
      .rejects.toThrow(/grader container produced no output/);
    expect(existsSync(join(root, 'input/evaluation-context.json'))).toBe(false);
  });
});
```

Read `packages/task-execution/backend-local/workspace/src/contract.ts` for the real `SelectedProvisioner` / `setup` signature and adapt the fixture helpers to it before implementing — the workspace contract is law here.

- [ ] **Step 5: Run and confirm failure**

Run: `cd client && yarn vitest run test/evaluator/grader-execution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the grader-execution provisioner**

`grader-execution.ts` composes the operator's existing container runtime (the same one the solve-side launchers use — do not add a second container path) behind a provisioner that, for `deterministic-process` specs only: checks whether the materialized subject Results already satisfy the adapter's first resolution source and returns early if so; otherwise runs the grader image named by the spec's `familyBlock`, captures its output, and writes `input/evaluation-context.json` atomically before the launcher spawns the harness. A non-zero exit or empty output throws, which the assembly maps to `failed[infrastructure]` — the operational-failure-is-not-a-failing-verdict rule (local-backend §10.4).

- [ ] **Step 7: Run both tests**

Run: `cd client && yarn vitest run test/evaluator/deployment.test.ts test/evaluator/grader-execution.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add client/src/evaluator/deployment.ts client/src/evaluator/launcher.ts client/src/evaluator/grader-execution.ts client/src/evaluator/settings.ts client/test/evaluator/deployment.test.ts client/test/evaluator/grader-execution.test.ts
git commit -m "feat(operator): own grader-container execution and register the evaluation deployment"
```

---

### Task 12: The evaluator signer secret-forward resolver

**Files:**
- Create: `client/src/evaluator/signer-resolver.ts`
- Create: `client/test/evaluator/signer-resolver.test.ts`

**Interfaces:**
- Consumes: `SecretForwardResolver` from `@jinn-network/task-execution-backend-local`; the operator's existing keystore loader.
- Produces: `createEvaluatorSignerResolver(input: { keyPath: string; grantKey: string }): SecretForwardResolver`.

The resolver returns the evaluator's Ed25519 private key bytes for exactly one grant key and throws for any other. Key loading is tier-4 only (the custody law, binding §10) — no key material anywhere in `packages/**`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEvaluatorSignerResolver } from '../../src/evaluator/signer-resolver.js';

describe('evaluator signer resolver', () => {
  it('resolves exactly the declared grant key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-signer-'));
    const keyPath = join(dir, 'evaluator.pem');
    writeFileSync(keyPath, 'PRIVATE-KEY-BYTES');
    const resolver = createEvaluatorSignerResolver({ keyPath, grantKey: 'evaluator-signer' });
    const bytes = await resolver.resolve(
      { attempt: { attemptId: 'urn:uuid:0' } as never, grantKey: 'evaluator-signer', descriptor: {} },
      {},
    );
    expect(new TextDecoder().decode(bytes)).toBe('PRIVATE-KEY-BYTES');
  });

  it('refuses any other grant key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-signer-'));
    const keyPath = join(dir, 'evaluator.pem');
    writeFileSync(keyPath, 'PRIVATE-KEY-BYTES');
    const resolver = createEvaluatorSignerResolver({ keyPath, grantKey: 'evaluator-signer' });
    await expect(resolver.resolve(
      { attempt: { attemptId: 'urn:uuid:0' } as never, grantKey: 'private-grader', descriptor: {} },
      {},
    )).rejects.toThrow(/not a configured secret forward/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && yarn vitest run test/evaluator/signer-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read the file with `O_NOFOLLOW`, return a fresh `Uint8Array` per call (the assembly zeroes it after materialization), and throw `` `grant key "${grantKey}" is not a configured secret forward` `` for anything else.

- [ ] **Step 4: Run the test**

Run: `cd client && yarn vitest run test/evaluator/signer-resolver.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/evaluator/signer-resolver.ts client/test/evaluator/signer-resolver.test.ts
git commit -m "feat(operator): resolve the evaluator signing key as a single scoped secret forward"
```

---

### Task 13: The evaluator loop — claim, execute, settle

**Files:**
- Create: `client/src/daemon/evaluator-loop.ts`
- Create: `client/src/evaluator/settle.ts`
- Create: `client/test/daemon/evaluator-loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–12, plus `venue.verdict` (Task 1), the embedded `TaskExecutionBackend`, `deriveMarketplaceAttemptUri` + `dispatchContextDescriptor` from `@jinn-network/marketplace-binding`, `uploadRawCodecCid` / `decodeRawCodecCidDigestHex` / `decisionGradeVerdictCode` from the binding, and `emitEvent`.
- Produces:

```ts
export class EvaluatorLoop {
  constructor(config: EvaluatorLoopConfig);
  run(): Promise<void>;
  stop(): void;
  /** Drain: stop accepting opportunities, finish in-flight evaluations. */
  drain(): Promise<void>;
}
```

The sequence, in order, with no step skippable:

1. opportunity (Task 5, self-skip already applied)
2. acquire subject material (Task 6); carve-out refusal check on the parsed spec (Task 9) → skip with a named reason
3. synthesize the bridge subject (Task 7)
4. build the evaluation dispatch (Task 9)
5. pin the sealed evaluation **Task** bytes via `uploadRawCodecCid` → `evaluationTaskCidDigest = 0x${decodeRawCodecCidDigestHex(cid)}`
6. admit the verdict intent ledger-first (Task 10)
7. `venue.verdict.canOpenVerdictAttempt` → `openVerdictAttempt` → `{ requestId, verdictIndex }`
8. mint the Attempt URI with `deriveMarketplaceAttemptUri`, build the dispatch context, `backend.submit(taskBytes, submissionBytes, { attemptUri, dispatchContext })`
9. await the backend's sealed Delivery (`deliveries(attemptUri)` → `fetchDelivery`)
10. settle (Task 13's `settle.ts`): pin the Delivery, `deliverVerdictToMarketplace`, `claimVerdictDelivery` with `decisionGradeVerdictCode(statement.predicate.verdict)` — **envelope-authoritative, never defaulted**
11. emit `evaluation_submitted`

- [ ] **Step 1: Write the failing loop test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { EvaluatorLoop } from '../../src/daemon/evaluator-loop.js';
import { evaluatorLoopHarness } from '../_support/evaluation-fixtures.js';

describe('EvaluatorLoop', () => {
  it('runs one opportunity end to end: open verdict attempt, execute, deliver, claim', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    await harness.settled();
    loop.stop();
    await running;

    expect(harness.venue.verdict.openVerdictAttempt).toHaveBeenCalledTimes(1);
    expect(harness.backend.submit).toHaveBeenCalledTimes(1);
    expect(harness.venue.verdict.claimVerdictDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ verdictCode: 2 }), // Fail — from the delivered Statement, not a default
    );
  });

  it('never opens a verdict attempt for the operator\'s own solution', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOwnSolutionOpportunity();
    await harness.idle();
    loop.stop();
    await running;
    expect(harness.venue.verdict.openVerdictAttempt).not.toHaveBeenCalled();
    expect(harness.backend.submit).not.toHaveBeenCalled();
  });

  it('skips a private-specification opportunity with a named reason and no chain write', async () => {
    const harness = await evaluatorLoopHarness({ spec: 'private' });
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    await harness.idle();
    loop.stop();
    await running;
    expect(harness.venue.verdict.openVerdictAttempt).not.toHaveBeenCalled();
    expect(harness.skips).toContainEqual(expect.objectContaining({ kind: 'private-specification' }));
  });

  it('writes the engagement-ledger row before the verdict broadcast', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    await harness.settled();
    loop.stop();
    await running;
    expect(harness.order.indexOf('ledger')).toBeLessThan(harness.order.indexOf('open-verdict'));
  });

  it('drain finishes the in-flight evaluation and accepts no new opportunity', async () => {
    const harness = await evaluatorLoopHarness();
    const loop = new EvaluatorLoop(harness.config);
    const running = loop.run();
    harness.emitOpportunity();
    const draining = loop.drain();
    harness.emitOpportunity();
    await draining;
    await running;
    expect(harness.venue.verdict.openVerdictAttempt).toHaveBeenCalledTimes(1);
  });
});
```

`evaluatorLoopHarness` goes in `client/test/_support/evaluation-fixtures.ts`: fake venue (`verdict` ports as `vi.fn`), a fake `TaskExecutionBackend` returning a sealed Delivery whose `verdict` output is a DSSE-wrapped Result Evaluation Statement with `verdict: 'fail'`, a fake ledger + intent store recording call order, and an in-memory opportunity emitter.

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && yarn vitest run test/daemon/evaluator-loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `settle.ts`**

```ts
import {
  decisionGradeVerdictCode,
  uploadRawCodecCid,
  type IpfsPinPort,
} from '@jinn-network/marketplace-binding';

/**
 * Settles one verdict on the today-mode venue: pin the sealed Delivery, deliver it through the
 * mech, then claim it with the code the delivered Statement carries. The code is
 * envelope-authoritative — `decisionGradeVerdictCode` throws rather than defaulting, which is
 * the whole point (binding §6.4, §7.41).
 */
export async function settleVerdict(input: {
  readonly requestId: `0x${string}`;
  readonly sealedDeliveryBytes: Uint8Array;
  readonly statementVerdict: unknown;
  readonly pin: IpfsPinPort;
  readonly verdict: {
    deliverVerdictToMarketplace(input: { requestId: `0x${string}`; deliveryDigest: `0x${string}` }): Promise<{ txHash: `0x${string}` }>;
    claimVerdictDelivery(input: { requestId: `0x${string}`; verdictDigest: `0x${string}`; verdictCode: number }): Promise<{ status: string }>;
  };
  readonly keccakEvidenceHash: `0x${string}`;
}): Promise<{ readonly status: string }> {
  const verdictCode = decisionGradeVerdictCode(input.statementVerdict);
  await uploadRawCodecCid(input.sealedDeliveryBytes, input.pin);
  await input.verdict.deliverVerdictToMarketplace({
    requestId: input.requestId,
    deliveryDigest: input.keccakEvidenceHash,
  });
  return input.verdict.claimVerdictDelivery({
    requestId: input.requestId,
    verdictDigest: input.keccakEvidenceHash,
    verdictCode,
  });
}
```

- [ ] **Step 4: Implement the loop**

`evaluator-loop.ts` follows the eleven-step sequence above. Bound concurrency with `config.maxConcurrent` (default 1). Every skip calls `config.onSkip` and emits a `tick_error`-free structured log line — a skip is not an error. Register the loop with `recordLoopTick('evaluator')` on each iteration so the watchdog sees it. On a post-claim failure (steps 8–10), surface the §4 unreleased-attempt state message rather than pretending release happened.

- [ ] **Step 5: Run the tests**

Run: `cd client && yarn vitest run test/daemon/evaluator-loop.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/daemon/evaluator-loop.ts client/src/evaluator/settle.ts client/test/daemon/evaluator-loop.test.ts client/test/_support/evaluation-fixtures.ts
git commit -m "feat(operator): run verdicts as evaluation-profile attempts on the embedded backend"
```

---

### Task 14: Composition-root wiring, config, and observability parity

**Files:**
- Modify: `client/src/daemon/composition-root.ts`
- Modify: `client/src/config.ts`
- Modify: `client/src/daemon/loop-heartbeat.ts`
- Modify: `client/OPERATOR-APP-SPEC.md`
- Create: `client/test/daemon/evaluator-composition.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the `evaluator` config block

```ts
export interface EvaluatorConfig {
  readonly enabled: boolean;                    // default false; set by the join flow
  readonly signerKeyPath: string;               // default `${stateDir}/evaluator/signer.key`
  readonly admissionAgentIri: string;
  readonly evaluatorAgentIri: string;
  readonly trustPolicy: { readonly genesisDigest: `sha256:${string}`; readonly versionsDir: string };
  readonly publicSpecDir: string;               // locally cached public evaluation specs
  readonly maxConcurrent?: number;              // default 1
  readonly maxClaimEvidenceBytes?: number;      // default 1_048_576
}
```

  with env overrides `JINN_EVALUATOR_ENABLED`, `JINN_EVALUATOR_SIGNER_KEY_PATH`, `JINN_EVALUATOR_MAX_CONCURRENT`. Restart-required; no hot reload.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';
import { buildOperatorRuntime } from '../../src/daemon/composition-root.js';
import { minimalRuntimeConfig } from '../_support/evaluation-fixtures.js';

describe('evaluator composition', () => {
  it('registers the evaluator loop in the watchdog registry', () => {
    expect(LOOP_REGISTRY).toContain('evaluator');
    expect(LOOP_REGISTRY).not.toContain('delivery-watcher');
  });

  it('starts no evaluator loop when the operator has not enabled evaluation', async () => {
    const runtime = await buildOperatorRuntime(minimalRuntimeConfig({ evaluator: { enabled: false } }));
    expect(runtime.loops.map((loop) => loop.name)).not.toContain('evaluator');
  });

  it('fails boot loudly when evaluation is enabled but the trust policy will not assemble', async () => {
    await expect(buildOperatorRuntime(minimalRuntimeConfig({
      evaluator: { enabled: true, trustPolicy: { genesisDigest: `sha256:${'0'.repeat(64)}`, versionsDir: '/nonexistent' } },
    }))).rejects.toThrow(/trust policy/);
  });

  it('keeps emitting evaluation_submitted so the dashboard history survives the delivery-watcher deletion', async () => {
    const runtime = await buildOperatorRuntime(minimalRuntimeConfig({ evaluator: { enabled: true } }));
    expect(runtime.eventKinds).toContain('evaluation_submitted');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd client && yarn vitest run test/daemon/evaluator-composition.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Wire, in the composition root: `assembleVerdictPolicies` from the configured policy directory → `createVerdictGate` → the projector loop's `verifyVerdictObservation` port; the evaluation launcher into `LocalTaskExecutionBackendConfig.launchers`; **`graderExecutionProvisioner` composed into `LocalTaskExecutionBackendConfig.provisioner` so evaluation-profile Attempts execute the grader container before the harness parses its output** (Task 11 / Finding 6 — the solve-side provisioner selection is unchanged; the evaluation branch is additive); `createEvaluatorSignerResolver` into `secretForwardResolver`; a `capabilityGrants` mapper admitting the single self-signer key; and the `EvaluatorLoop` into the supervised loop set. Add `'evaluator'` to `LOOP_REGISTRY` and remove `'delivery-watcher'`, `'engine-watcher'`, `'engine-tick'`.

- [ ] **Step 4: Update `OPERATOR-APP-SPEC.md`**

Under the Daemon component: the loop list loses `delivery-watcher`, `engine-watcher`, and `engine-tick`, and gains `evaluator`; the Activity collection's `evaluation_submitted` items now originate from the evaluator loop. Deltas only — no new surfaces, no redesign (design §9, frontend rules).

- [ ] **Step 5: Run the tests**

Run: `cd client && yarn typecheck && yarn vitest run test/daemon/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/daemon/composition-root.ts client/src/config.ts client/src/daemon/loop-heartbeat.ts client/OPERATOR-APP-SPEC.md client/test/daemon/evaluator-composition.test.ts
git commit -m "feat(operator): compose the evaluator loop into the runtime with its config and heartbeats"
```

---

### Task 15: Retire the delivery-watcher and the mech adapter's evaluation machinery

**Files:**
- Delete: `client/src/daemon/delivery-watcher.ts`, `client/test/daemon/delivery-watcher.test.ts`
- Modify: `client/src/adapters/mech/adapter.ts` (delete the evaluation-opportunity members)
- Modify: `client/src/daemon/daemon.ts`
- Modify: `client/src/adapters/adapter.ts` (drop the evaluation surface from `ExecutionAdapter`)

**Interfaces:**
- Removed: `DeliveryWatcherLoop`; `MechAdapter`'s `pendingEvaluations`, `evaluationOpportunities`, `pendingEvaluationSolutions`, `loadPendingEvaluationSolutions`, `persistPendingEvaluationSolutions`, `rememberPendingEvaluationSolution`, `forgetPendingEvaluationSolution`, `recordEvaluationFailureAndMaybePrune`, `pruneTerminalEvaluationOpportunity`, `claimEvaluationWithTerminalPrune`, `claimEvaluation`, `submitVerdictDelivery`, `retryPendingEvaluationSolutions`, and the `mech_pending_evaluation_solutions_v1` config-key persistence.

- [ ] **Step 1: Write the failing architecture test**

`client/test/architecture/no-legacy-evaluation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../src');

describe('stage 2 retirement', () => {
  it('has no delivery-watcher module', () => {
    expect(existsSync(join(root, 'daemon/delivery-watcher.ts'))).toBe(false);
  });

  it('has no evaluation-opportunity machinery in the mech adapter', () => {
    const source = readFileSync(join(root, 'adapters/mech/adapter.ts'), 'utf8');
    expect(source).not.toMatch(/evaluationOpportunit|pendingEvaluationSolutions|claimEvaluationWithTerminalPrune/);
  });

  it('leaves exactly one verdict transaction path — the venue-base verdict ports', () => {
    const source = readFileSync(join(root, 'adapters/mech/contracts.ts'), 'utf8');
    expect(source).not.toMatch(/functionName: 'claimEvaluation'/);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd client && yarn vitest run test/architecture/no-legacy-evaluation.test.ts`
Expected: FAIL on all three.

- [ ] **Step 3: Delete**

Remove the files and members listed above, plus their now-dead imports (`claimEvaluation`, `canClaimEvaluation`, `isTerminalEvaluationReason`, the evaluation-context modules under `src/harnesses/impls/`). Keep `verdict-code.ts` only if something outside the deleted set still imports it; otherwise delete it too and use the binding's `VerdictCode`.

- [ ] **Step 4: Run the tests**

Run: `cd client && yarn typecheck && yarn test`
Expected: PASS. Fix every compile error the deletion surfaces by removing the caller, never by reinstating the member.

- [ ] **Step 5: Commit**

```bash
git add -A client/src client/test
git commit -m "refactor(operator): retire the delivery-watcher and the mech evaluation machinery"
```

---

### Task 16: Retire the legacy TaskEngine

**Files:**
- Delete: `client/src/harnesses/engine/engine.ts`, `client/src/harnesses/engine/recovery.ts`, and their tests
- Modify: `client/src/daemon/daemon.ts`, `client/src/main.ts`, `client/src/daemon/watchdog-loop.ts`
- Keep: `client/src/harnesses/engine/persistence.ts` (read-only `task_runs` access for the API and status surfaces until stage 5)

The TaskEngine is the last flow out (design §10, stage 2). Its solution path left with stage 1; this task removes the class, the tick loop, the watcher loop, and `recoverInFlight` — crash recovery is derivation-first now (design §4), and the backend journal plus the projector cursor are the sources of truth.

- [ ] **Step 1: Extend the architecture test**

Append to `client/test/architecture/no-legacy-evaluation.test.ts`:

```ts
it('has no TaskEngine', () => {
  expect(existsSync(join(root, 'harnesses/engine/engine.ts'))).toBe(false);
  expect(existsSync(join(root, 'harnesses/engine/recovery.ts'))).toBe(false);
});

it('keeps task_runs readable for the API until stage 5', () => {
  expect(existsSync(join(root, 'harnesses/engine/persistence.ts'))).toBe(true);
});

it('starts no engine loops', () => {
  const source = readFileSync(join(root, 'daemon/daemon.ts'), 'utf8');
  expect(source).not.toMatch(/TaskEngine|runTickLoop|_runEngineWatcherLoop|recoverInFlight/);
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd client && yarn vitest run test/architecture/no-legacy-evaluation.test.ts`
Expected: FAIL on the three new assertions.

- [ ] **Step 3: Delete and rewire**

Remove the engine construction and both loops from `Daemon`, drop the engine entries from the watchdog registration, and delete `recoverInFlight` from the start sequence. Every API module that reads `TaskRunPersistence` keeps compiling untouched.

- [ ] **Step 4: Run the full suite**

Run: `cd client && yarn typecheck && yarn test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A client
git commit -m "refactor(operator): retire the legacy TaskEngine — the last flow leaves the engine"
```

---

### Task 17: Drain runbook, deploy PR, and the testnet gate

**Files:**
- Create: `docs/runbooks/cutover-stage-2-drain.md`

**Interfaces:** none — this task produces the operational artifact and the stage gate evidence.

- [ ] **Step 1: Write the drain runbook**

`docs/runbooks/cutover-stage-2-drain.md` covers, in order:

1. **Freeze intake.** On every fleet operator, set the previous release's evaluator intake off (the legacy adapter's evaluation-opportunity ingest already respects the `#547` evaluator gate — turn it off there) and confirm no new evaluation opportunity is admitted.
2. **Drain.** Let in-flight legacy evaluations run to terminal states. Watch `evaluation_submitted` in the daemon history and the router's `claimed(requestId)` for each open verdict request. Bound the wait by the operator's patience; anything still open at the deadline is a **straggler**.
3. **Record stragglers.** List `(taskId, attemptIndex, requestId)` for every unterminated legacy evaluation in the deploy PR body. Today-mode has no on-venue release, so a stranded verdict claim occupies its slot until the revised generation's deadline reap; the §4 state message names it to the operator, and the drain exists to make this list empty in practice.
4. **Deploy.** Ship the stage-2 image. First boot runs the derivation-first recovery: the projector cursor catches up to the finalized head before the evaluator loop admits its first opportunity (program §6.3).
5. **Verify the gate.** One verdict closed-loop on testnet: an opportunity from another operator's delivery → `openVerdictAttempt` → an evaluation-profile Attempt in the backend journal → the sealed Delivery carrying a DSSE Result Evaluation Statement → `claimVerdictDelivery` with the envelope's code → the projector emits the verdict announcement with `decisionGrade: true`. Capture the transaction hashes and the announcement id.
6. **Rollback.** Revert the stage-2 PR / pin the previous canary image. This abandons the new loop's in-flight evaluations: chain state stays consistent (claims are chain facts, the backend journal persists), but the reverted daemon does not resume them and the same state message names them. The legacy evaluation machinery is gone from the new image but present in the pinned one, so a rollback restores the old path intact.

- [ ] **Step 2: Run the whole stage's gates**

```bash
cd packages/marketplace/venue-base && yarn typecheck && yarn test
cd ../binding && yarn typecheck && yarn test
cd ../../../client && yarn typecheck && yarn test
cd client && yarn e2e:daemon-harness
```

Expected: all green. Show the outputs in the PR body.

- [ ] **Step 3: Open the deploy PR**

One PR into `integration/evidence-v1` whose description carries: the drain checklist from step 1, the straggler list, the rollback statement from step 6, the Findings 1–3 dispositions as ruled, and the four gate outputs. Operator-approved; no self-merge.

- [ ] **Step 4: Close the stage gate**

Deploy to the testnet fleet, execute the runbook's step 5, and post the closed-loop evidence (transaction hashes, announcement id, `decisionGrade: true`) on the PR before stage 3 begins.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/cutover-stage-2-drain.md
git commit -m "docs(operator): add the stage-2 evaluator-flow drain runbook"
```

---

## Self-Review

**Spec coverage.** Design §4's evaluator-loop row: observe deliveries (Task 5), skip own (Task 4), derive + post the evaluation Submission through the durable intent store (Tasks 9, 10), claim the verdict attempt (Tasks 1, 13), execute as an evaluation-profile Attempt on the same embedded backend via the evaluation-harness launcher (Tasks 11, 12, 13), backend seals the Delivery and the attestation-issuer runs inside the executor (no host task — that is the harness's own runtime, correctly untouched). Evaluator-seals carve-out (Tasks 8, 9, 13). Verdict-gate policy assembly from trust-resolve + operator config (Tasks 2, 3, 14). Retirements (Tasks 15, 16). Drain runbook and the verdict-closed-loop gate (Task 17). Program §6 cross-plan contracts: single-broadcaster (Task 1 — every write through the injected `SafeBroadcastPort`), ledger-before-broadcast (Task 10), carve-out (Tasks 8/9/13), fresh-rewrite-with-legacy-fixtures (Task 1 step 5), drain (Task 17). Design §5's "no separate evaluation runner" is honored: nothing in this plan re-implements adapter dispatch, signing, or verdict assembly — the harness owns all three, and the registrations plus parser allowlist come from the adapters tree's `createEvaluatorDeployment` facade rather than local assembly (Task 11). Cross-plan hand-off from the evaluator-adapters plan: this stage is the **execution owner** for the `deterministic-process` grader container (Finding 6, Task 11), satisfying the parse-only adapters' fixed resolution order — subject Results, then `evaluation-context.json`, then `subject-not-found`, never a fabricated verdict.

**Not covered, deliberately.** Requester-side evaluation sealing (stage 3, design §4). The public archive and cross-operator discovery of subject material (stage 4) — Task 6 uses IPFS and evidence retrieval, which are live today. `task_runs` deletion and legacy config-key removal (stage 5). No operator-app redesign: the only SPA-adjacent change is the `OPERATOR-APP-SPEC` loop-taxonomy delta plus preserved event kinds (Task 14).

**Placeholders.** None: every code step carries real code or a named file with its exact responsibility; the two prose-only implementation steps (Task 6 step 3, Task 7 step 3) name every field, every error kind, and the exact schema each document must satisfy.

**Type consistency.** `EvaluationOpportunity` (Task 5) is consumed unchanged by Tasks 6 and 13. `SubjectMaterial` (Task 6) and `BridgeSubject` (Task 7) are the two inputs to `buildEvaluationDispatch` (Task 9). `EVALUATOR_SIGNER_GRANT_KEY` is defined once (Task 9) and referenced by Tasks 11, 12, and 14. `AssembledVerdictPolicies` (Task 2) is consumed by `createVerdictGate` (Task 3) and wired in Task 14. `VerdictPorts` (Task 1) is used only through `venue.verdict` in Tasks 10 and 13. `OperatorIdentity` and `EvaluationSkipReason` (Task 4) are used by Task 5.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-30-cutover-stage-2-evaluator-flow.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Either way, two things happen before Task 1 starts: obtain coordinator rulings on Findings 1–3, and reconcile the two still-open identifiers in the Stage-1 surfaces contract block per Finding 5 (substitution only — no task changes shape). Findings 4 and 6 need no ruling; the pinned rows in that block are binding as written.
