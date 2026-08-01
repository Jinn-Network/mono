# Supply C5 — task posting (binding adapters + posting application)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans

- **Date:** 2026-07-31
- **Program:** [`2026-07-31-supply-program.md`](2026-07-31-supply-program.md) (C5 row, §4 pinned
  interfaces, §5 cross-plan contracts)
- **Design (law):**
  [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  §8 (posting), §13 F2 + F7, §12 (non-goals), commit `5b0739832`
- **Pinned predecessor design (never rewritten):**
  [`../specs/2026-07-24-task-post-broadcast-intent-design.md`](../specs/2026-07-24-task-post-broadcast-intent-design.md)
- **Branches:** `supply/c5a-binding-adapters` (base `integration/evidence-v1`, half A) and
  `supply/c5-task-posting` (base `supply/c4-task-derivation`, half B)

## Goal

Two independently mergeable halves.

**Half A (branch `supply/c5a-binding-adapters`, `packages/marketplace/binding`)** closes the four
requester on-ramp gaps the design files as F2/D7, in the binding tree, under the binding's guards:
an EOA `createTask` broadcast port, a durable file-backed `PostingIntentStore` honoring the pinned
WAL claim/fence/resolve semantics exactly, a `TaskCreated` recovery scan, and
`DEFAULT_POSTING_TERMS` with an explicit `maxClaims` plus the escrow formula it implies. Additive
only: no existing binding file is rewritten beyond `index.ts` exports and one additive `export`
keyword (Finding 3).

**Half B (branch `supply/c5-task-posting`, `packages/task-supply/posting`)** is the posting
application: **supply policy only**. `planPosting` is a pure function from a pool listing plus a
policy to a `PostingPlan` carrying per-entry and total escrow; `executePosting` surfaces that plan,
requires approval before spending, and posts through injected ports. Auto-post is a policy flag
that pre-approves with the same visibility in a log line. The F7 residual — this package composes
the binding directly until the work client mints, then swaps its posting core beneath the same
policy surface — is recorded in the package README in the design's own wording class.

Success: both branches' packages typecheck, test, build, pack-smoke green; the marketplace guard
trio green on half A; the task-supply guard trio green on half B; no placeholder, no TODO, no
stubbed adapter left behind.

## Architecture

```
                    half B: supply POLICY                half A: on-ramp MECHANICS
                    packages/task-supply/posting         packages/marketplace/binding

C4 SupplyPool.list() ──► planPosting(pool, policy) ──► PostingPlan
                                                          │
                                          render ─────────┤ terms + per-entry + total escrow
                                          approve ────────┤ (auto-post = policy flag, logged)
                                                          ▼
                                        executePosting ──► buildDispatchSubmission (sealSubmission,
                                                          │  attempts.maxTotal explicit,
                                                          │  admission-receipt annotation)
                                                          ▼
                                                       postTask ──► ipfs / intents / safe ports
                                                                        │        │       │
                                          createFilePostingIntentStore ─┘        │       │
                                          scanForOnChainMatch ───► recoverPostingIntents │
                                          createEoaBroadcastPort ───────────────────────┘
                                          DEFAULT_POSTING_TERMS / postingEscrowValueWei
```

The seam that matters is `PostingDeps.postTask` + `PostingDeps.ports`. At work-client mint (F7) the
posting core behind that seam is replaced with the work client's; nothing above it changes.

`planPosting` is pure because the plan is the replay unit: the sealed dispatch Submission is a
function of the plan alone (fixed deadline, fixed `maxClaims`, fixed requester), so re-executing the
same plan produces byte-identical Submission bytes, the same `(creatorSafe, taskCidDigest,
submissionDigest)` WAL key, and therefore a no-op replay instead of a second post.

## Tech Stack

- TypeScript 5.9 (ESM, `NodeNext`), Node 22, Yarn 4.13.0 with `portal:` resolutions
- vitest 4.1.8 for package tests; `node --test` for the repo guard scripts
- viem ^2 (`PublicClient` / `WalletClient` are **parameters**, never constructed in-package)
- zod 4.4.3 via `@jinn-network/task-execution-protocol` schemas
- `node:fs/promises` (`open` with `wx`, `rename`, `fsync`) for the durable WAL

## Global Constraints (program §5)

1. **Designs are law** (spec `5b0739832`). A defect is a Finding with a proposed disposition, never
   a silent patch. This plan's Findings section is dated and closed-form.
2. **Kits and fixtures precede implementations.** Half A's WAL conformance suite runs against both
   store implementations before the file store is wired anywhere.
3. **Sealing is re-implemented per package** for kinds this program defines. TEP documents are
   sealed with `@jinn-network/task-execution-protocol`'s own `sealSubmission` — that is the
   canonical implementation for TEP kinds, not a shared re-implementation.
4. **Custody law.** No key material, no ambient authority, no ambient `fetch`. Every viem client,
   every port, the clock reading, and the approval decision are injected. Fail closed.
5. **No product names in tiers 1–3.** No unit imports `@jinn-network/core`, `plugin`, `jinn-layer`,
   or `client/`.
6. **Digest discipline.** Record-body digests are `sha256:`-prefixed; the on-chain `bytes32` anchor
   and in-toto DigestSet values are bare hex. Every conversion in this plan is explicit.
7. **Admission is attestation-agnostic.** Posting never reads an attestation and never re-runs
   admission; it carries the admission receipt by digest.
8. **Bounded claims.** No API name, log line, comment, or doc in either half says "deterministic" or
   "verified". Where byte-stability is the property, say byte-identical or fixed-order.
9. **Guards ship with the packages.** Half A stays inside the marketplace guard trio; half B
   registers itself in the task-supply guard trio C3 owns.
10. **TDD per task; verification before completion.** Typecheck, tests, guards run locally with
    output shown before any task is reported done.
11. **Stop on missing Consumes.** A symbol a task consumes that is not on the base branch is a
    stop-and-report, not an improvisation.
12. **Legacy code is reference only.** `client/src` may be read, never imported.

## Findings (2026-07-31)

Filed against spec §8 and program §4 after reading the binding tree. Each carries a proposed
disposition already reflected in the tasks below; a reviewer who rejects a disposition stops the
affected task rather than reshaping it in flight.

**F-C5-1 — `PostingTerms` has no `maxClaims`, and the escrow multiplier comes from the sealed
Submission.** Spec §8 and program §4 pin "`DEFAULT_POSTING_TERMS` (with explicit `maxClaims`)", but
`packages/marketplace/binding/src/posting.ts` computes `const maxClaims = submission.attempts
?.maxTotal ?? 1` and escrows `(solutionRate + verdictRate) × maxClaims`. `PostingTerms` carries no
such field, and adding one to `postTask`'s reading would fork the multiplier away from the sealed
document the digest-join is built on. *Proposed disposition:* keep `postTask` unchanged; export
`DefaultPostingTerms extends PostingTerms` adding `maxClaims`, plus `postingEscrowValueWei(terms)`
(the documented formula) and `assertMaxClaimsAgreement(submissionMaxTotal, termsMaxClaims)` which
**throws on `undefined`** so the silent `?? 1` fallback is unreachable from the posting path. Half B
seals `attempts.maxTotal` explicitly and re-parses its own sealed bytes to assert agreement.

**F-C5-2 — `planPosting(pool, policy)` is pinned pure, but `SupplyPool` is an async store.** A pure
function cannot await `list()`. *Proposed disposition:* keep the pinned name and arity; `pool` is
the **materialized listing** the caller already read from `SupplyPool.list()`, typed as
`readonly PostingPoolEntry[]`. The async read is the composition site's job (program §8's tier-4 ops
note), not the policy function's.

**F-C5-3 — `OwnedPostingIntentRecord` is declared but not exported.**
`PostingIntentStore.scanPending()` returns `readonly OwnedPostingIntentRecord[]`, and that interface
is module-local in `broadcast-intent.ts`. A durable adapter implements the store structurally
without it, but no adapter outside the module can *name* the element type it must return. *Proposed
disposition:* add the `export` keyword to the existing declaration (additive, no body change) and
re-export the type from `index.ts`.

**F-C5-4 — a pool entry must carry the sealed admission-receipt digest.** The evaluation leg
(`deriveAndSealEvaluationSubmission`, binding §7.39) refuses a subject Submission that does not
carry an admission-receipt `ResourceDescriptor` at
`https://jinn.network/annotations/admission-receipt/1.0`. The dispatch Submission half B seals is
that subject Submission. *Proposed disposition:* `PostingPoolEntry` requires
`admissionReceiptDigest` (`sha256:`-prefixed) and accepts an optional `admissionReceiptUri`. If
C4's pool listing on `supply/c4-task-derivation` does not expose the receipt digest per entry, that
is a **stop-and-report to the program** (contract 11), not a locally invented field.

**F-C5-5 — spec §3.3's dependency diagram has no posting → derivation arrow, but §4 pins
`SupplyPool` by name.** *Proposed disposition:* posting takes a **type-only** dependency on
`@jinn-network/task-derivation` (it imports `SupplyPool` with `import type` and nothing else), and
the task-supply source-boundary guard asserts that every specifier from posting into derivation is
`import type`. Duplicating the interface structurally would fork a pinned contract; a value import
would add a runtime edge the diagram does not have.

**F-C5-6 — `SafeBroadcastPort` names Safe-routing that today-mode posting does not use.**
`JinnRouterV3.createTask` is a plain `payable` function keyed on `msg.sender`. *Proposed
disposition:* keep the interface name (it is stable across the F7 swap, and renaming a binding
public type is the work client's territory); `createEoaBroadcastPort` documents the divergence at
its definition, checks that `input.safeAddress` equals the wallet's own account rather than
assuming it, and the binding README records that Safe-routing arrives with the work client.

---

# Half A — binding adapters (`supply/c5a-binding-adapters`)

Base: `integration/evidence-v1`. Independent of every other supply component; mergeable on its own.

**Worktree setup (once, before Task A1):**

```bash
cd /Users/adrianobradley/life\'s-work/jinn-mono
git worktree add ../jinn-mono_worktrees/supply-c5a -b supply/c5a-binding-adapters origin/integration/evidence-v1
WT=../jinn-mono_worktrees/supply-c5a
for p in task-execution/protocol task-execution/backend task-execution/profiles trust/core trust/resolve; do
  (cd "$WT/packages/$p" && yarn install --immutable && yarn build)
done
(cd "$WT/packages/marketplace/binding" && yarn install --immutable && yarn typecheck && yarn test)
```

Expected: every portal dependency builds, and the binding's existing suite is green **before** any
edit. A red baseline is a stop-and-report.

---

## Task A1 — `DEFAULT_POSTING_TERMS`, the escrow formula, and the `maxClaims` gate

**Files**
- `packages/marketplace/binding/src/posting-defaults.ts` (new)
- `packages/marketplace/binding/src/posting-defaults.test.ts` (new)
- `packages/marketplace/binding/src/index.ts` (exports only)

**Interfaces**
- *Consumes* (`integration/evidence-v1`, `@jinn-network/marketplace-binding`):
  `PostingTerms`, `postTask`, `PostingPorts` from `./posting.js`; `PostingOutcome`,
  `createInMemoryPostingIntentStore` from `./broadcast-intent.js`; `BASE_SEPOLIA_TODAY` from
  `./addresses.js`; `sealTask` / `sealSubmission` / `sha256Hex` from
  `@jinn-network/task-execution-protocol`.
- *Produces* (program §4): `DEFAULT_POSTING_TERMS`; plus `DefaultPostingTerms`,
  `postingEscrowValueWei`, `assertMaxClaimsAgreement` (the F-C5-1 disposition).

**Steps**

- [ ] Write the failing test first — `src/posting-defaults.test.ts`. The first case is the
  formula-pin: it drives the **real** `postTask` with a stub broadcast port and asserts the escrowed
  `value` equals `postingEscrowValueWei(DEFAULT_POSTING_TERMS)`.

  ```ts
  import { sealSubmission, sealTask, sha256Hex } from "@jinn-network/task-execution-protocol";
  import { describe, expect, test, vi } from "vitest";
  import { BASE_SEPOLIA_TODAY } from "./addresses.js";
  import { createInMemoryPostingIntentStore } from "./broadcast-intent.js";
  import {
    DEFAULT_POSTING_TERMS,
    assertMaxClaimsAgreement,
    postingEscrowValueWei,
  } from "./posting-defaults.js";
  import { postTask, type PostingPorts } from "./posting.js";

  const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;

  function goldenTask(): Uint8Array {
    return sealTask({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      profile: {
        uri: "https://jinn.network/task-profiles/repository-work/1.0",
        digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
      },
      instructions: "Fix the failing test.",
      outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
    });
  }

  function goldenSubmission(taskBytes: Uint8Array, maxTotal: number | undefined): Uint8Array {
    return sealSubmission({
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: "urn:uuid:11111111-2222-3333-4444-555555555555",
      task: { digest: { sha256: sha256Hex(taskBytes) } },
      requester: "urn:uuid:66666666-7777-8888-9999-aaaaaaaaaaaa",
      idempotencyKey: "defaults-1",
      nonce: "nonce-1",
      deadline: "2099-01-01T00:00:00Z",
      ...(maxTotal === undefined ? {} : { attempts: { maxTotal } }),
    });
  }

  describe("DEFAULT_POSTING_TERMS", () => {
    test("names maxClaims explicitly and never leaves the escrow multiplier to the fallback", () => {
      expect(DEFAULT_POSTING_TERMS.maxClaims).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(DEFAULT_POSTING_TERMS.maxClaims)).toBe(true);
      expect(DEFAULT_POSTING_TERMS.allowSolverSelfEvaluation).toBe(false);
    });

    test("postingEscrowValueWei is the exact msg.value postTask sends", async () => {
      const taskBytes = goldenTask();
      const submissionBytes = goldenSubmission(taskBytes, DEFAULT_POSTING_TERMS.maxClaims);
      const broadcastCreateTask = vi.fn(async () => ({ taskId: 7n, txHash: `0x${"a".repeat(64)}` as const }));
      const ports: PostingPorts = {
        ipfs: { pin: async () => {} },
        intents: createInMemoryPostingIntentStore(),
        safe: { broadcastCreateTask },
      };

      await postTask(taskBytes, submissionBytes, DEFAULT_POSTING_TERMS, BASE_SEPOLIA_TODAY, CREATOR, ports);

      expect(broadcastCreateTask.mock.calls[0]?.[0]?.value).toBe(postingEscrowValueWei(DEFAULT_POSTING_TERMS));
    });

    test("the formula is (solutionRate + verdictRate) x maxClaims", () => {
      expect(postingEscrowValueWei({
        solutionMaxDeliveryRateWei: 10n,
        verdictMaxDeliveryRateWei: 5n,
        maxClaims: 3,
      })).toBe(45n);
    });

    test("rejects a claim count that cannot be escrowed", () => {
      expect(() => postingEscrowValueWei({
        solutionMaxDeliveryRateWei: 10n,
        verdictMaxDeliveryRateWei: 5n,
        maxClaims: 0,
      })).toThrow(RangeError);
    });
  });

  describe("assertMaxClaimsAgreement", () => {
    test("refuses a Submission that omits attempts.maxTotal (the silent fallback of 1)", () => {
      expect(() => assertMaxClaimsAgreement(undefined, 1)).toThrow(/attempts\.maxTotal/u);
    });

    test("refuses a Submission whose maxTotal disagrees with the terms", () => {
      expect(() => assertMaxClaimsAgreement(2, 1)).toThrow(/disagrees/u);
    });

    test("accepts agreement", () => {
      expect(() => assertMaxClaimsAgreement(3, 3)).not.toThrow();
    });
  });
  ```

  Run `cd packages/marketplace/binding && yarn vitest run src/posting-defaults.test.ts`. Expected:
  the file fails to resolve `./posting-defaults.js` — the red state.

- [ ] Implement `src/posting-defaults.ts`.

  ```ts
  // SPDX-License-Identifier: MIT

  // Requester on-ramp defaults (supply design §8 "Economics honesty"; binding finding F2). The
  // escrow multiplier `postTask` uses is the sealed Submission's `attempts.maxTotal`, falling back
  // to 1 when the field is absent -- these defaults name the number at the call site instead, and
  // `assertMaxClaimsAgreement` makes the fallback unreachable from a posting application, so no
  // poster learns the multiplier by reading a `??`.
  import type { PostingTerms } from "./posting.js";

  /** `PostingTerms` plus the claim count the escrow is multiplied by. */
  export interface DefaultPostingTerms extends PostingTerms {
    readonly maxClaims: number;
  }

  /**
   * Reference terms for today-mode posting on the deployed Base Sepolia substrate. Rates are
   * per-delivery ceilings, not prices: the escrow is `(solution + verdict) x maxClaims` in native
   * wei, sent as `msg.value`. Operators override these; they exist so no caller has to invent an
   * escrow to get a first post out.
   *
   * `allowSolverSelfEvaluation: false` is not a default worth flipping casually -- it is the
   * self-evaluation prevention the recorder enforces.
   */
  export const DEFAULT_POSTING_TERMS: DefaultPostingTerms = {
    solutionMaxDeliveryRateWei: 1_000_000_000_000_000n, // 0.001 ETH
    verdictMaxDeliveryRateWei: 200_000_000_000_000n, // 0.0002 ETH
    responseTimeoutSeconds: 86_400n,
    allowSolverSelfEvaluation: false,
    maxClaims: 1,
  };

  /**
   * The escrow formula, in one place: `(solutionMaxDeliveryRateWei + verdictMaxDeliveryRateWei) x
   * maxClaims`. This is the exact `msg.value` `postTask` sends; `posting-defaults.test.ts` pins the
   * equality against the real `postTask` so the two cannot drift.
   *
   * A colluding solver+evaluator pair can drain this escrow with a junk delivery and a friendly
   * verdict under today-mode `minVerdicts: 1`. That risk is marketplace-owned and named here so a
   * poster prices it in (supply design §8); it is not mitigated by this function.
   */
  export function postingEscrowValueWei(terms: {
    readonly solutionMaxDeliveryRateWei: bigint;
    readonly verdictMaxDeliveryRateWei: bigint;
    readonly maxClaims: number;
  }): bigint {
    if (!Number.isInteger(terms.maxClaims) || terms.maxClaims < 1) {
      throw new RangeError(`maxClaims must be a positive integer, got ${String(terms.maxClaims)}`);
    }
    return (terms.solutionMaxDeliveryRateWei + terms.verdictMaxDeliveryRateWei) * BigInt(terms.maxClaims);
  }

  /**
   * Fail-closed agreement between the sealed Submission's `attempts.maxTotal` and the terms the
   * escrow was computed from. Throws on `undefined` deliberately: an absent `maxTotal` is exactly
   * the case where `postTask` would silently escrow for one claim.
   */
  export function assertMaxClaimsAgreement(
    submissionMaxTotal: number | undefined,
    termsMaxClaims: number,
  ): void {
    if (submissionMaxTotal === undefined) {
      throw new Error(
        "the sealed Submission omits attempts.maxTotal -- posting refuses to escrow against the "
          + "implicit single-claim fallback (supply design §8)",
      );
    }
    if (submissionMaxTotal !== termsMaxClaims) {
      throw new Error(
        `the sealed Submission's attempts.maxTotal (${submissionMaxTotal}) disagrees with the terms' `
          + `maxClaims (${termsMaxClaims}) -- the escrow would not cover the claims the task admits`,
      );
    }
  }
  ```

- [ ] Add the exports to `src/index.ts`, in a new block beside the existing posting block:

  ```ts
  // --- requester on-ramp defaults (supply design §8 D7; finding F2) ---
  export {
    DEFAULT_POSTING_TERMS,
    assertMaxClaimsAgreement,
    postingEscrowValueWei,
  } from "./posting-defaults.js";
  export type { DefaultPostingTerms } from "./posting-defaults.js";
  ```

- [ ] `cd packages/marketplace/binding && yarn vitest run src/posting-defaults.test.ts && yarn typecheck`
  Expected: 7 passing tests, zero type errors.

- [ ] Commit: `feat(marketplace): add DEFAULT_POSTING_TERMS and the escrow formula helpers`

---

## Task A2 — `createEoaBroadcastPort`

**Files**
- `packages/marketplace/binding/src/venue/eoa-broadcast.ts` (new)
- `packages/marketplace/binding/src/venue/eoa-broadcast.test.ts` (new)
- `packages/marketplace/binding/src/index.ts` (exports only)

**Interfaces**
- *Consumes* (`integration/evidence-v1`): `SafeBroadcastPort` from `./posting.js`; `PostingOutcome`
  from `./broadcast-intent.js`; `JINN_ROUTER_V3_ABI` from `./abis/jinn-router-v3.js`;
  `TaskExecutionError` from `@jinn-network/task-execution-backend`; viem's `decodeEventLog`,
  `PublicClient`, `WalletClient`. Reference wiring:
  `packages/marketplace/testing/src/backend-conformance.test.ts` `makeForkBackedBackend`.
- *Produces* (program §4): `createEoaBroadcastPort(publicClient, walletClient)`.

**Steps**

- [ ] Write `src/venue/eoa-broadcast.test.ts` first, with stub clients (no network, no viem client
  construction):

  ```ts
  import { TaskExecutionError } from "@jinn-network/task-execution-backend";
  import { encodeEventTopics, type PublicClient, type WalletClient } from "viem";
  import { describe, expect, test, vi } from "vitest";
  import { JINN_ROUTER_V3_ABI } from "../abis/jinn-router-v3.js";
  import { createEoaBroadcastPort } from "./eoa-broadcast.js";

  const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
  const ROUTER = "0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247" as const;
  const TX = `0x${"ab".repeat(32)}` as const;

  function taskCreatedLog(taskId: bigint, address: `0x${string}` = ROUTER) {
    const topics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskCreated",
      args: { creator: ACCOUNT, taskId, manifestDigest: `0x${"11".repeat(32)}` as const },
    });
    // taskCidDigest, maxClaims, solutionBudget, verdictBudget -- four unindexed words.
    const data = `0x${"22".repeat(32)}${(1).toString(16).padStart(64, "0")}${"0".repeat(64)}${"0".repeat(64)}` as const;
    return { address, topics, data };
  }

  function clients(overrides: {
    receipt?: unknown;
    sendTransaction?: ReturnType<typeof vi.fn>;
  } = {}) {
    const sendTransaction = overrides.sendTransaction ?? vi.fn(async () => TX);
    const waitForTransactionReceipt = vi.fn(async () => overrides.receipt ?? {
      status: "success",
      logs: [taskCreatedLog(42n)],
    });
    const publicClient = { waitForTransactionReceipt } as unknown as PublicClient;
    const walletClient = { account: { address: ACCOUNT }, chain: null, sendTransaction } as unknown as WalletClient;
    return { publicClient, walletClient, sendTransaction, waitForTransactionReceipt };
  }

  describe("createEoaBroadcastPort", () => {
    test("broadcasts postTask's calldata and returns the decoded TaskCreated taskId", async () => {
      const { publicClient, walletClient, sendTransaction } = clients();
      const port = createEoaBroadcastPort(publicClient, walletClient);

      const outcome = await port.broadcastCreateTask({
        safeAddress: ACCOUNT, to: ROUTER, value: 15n, data: "0xdeadbeef",
      });

      expect(outcome).toEqual({ taskId: 42n, txHash: TX });
      expect(sendTransaction.mock.calls[0]?.[0]).toMatchObject({ to: ROUTER, data: "0xdeadbeef", value: 15n });
    });

    test("refuses to post under a creator of record that is not this wallet's account", async () => {
      const { publicClient, walletClient, sendTransaction } = clients();
      const port = createEoaBroadcastPort(publicClient, walletClient);

      await expect(port.broadcastCreateTask({
        safeAddress: "0x2222222222222222222222222222222222222222",
        to: ROUTER, value: 1n, data: "0x00",
      })).rejects.toBeInstanceOf(TaskExecutionError);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    test("throws on a reverted receipt", async () => {
      const { publicClient, walletClient } = clients({ receipt: { status: "reverted", logs: [] } });
      const port = createEoaBroadcastPort(publicClient, walletClient);
      await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x00" }))
        .rejects.toThrow(/reverted/u);
    });

    test("ignores a TaskCreated emitted by another address and reports the missing event", async () => {
      const { publicClient, walletClient } = clients({
        receipt: { status: "success", logs: [taskCreatedLog(9n, "0x3333333333333333333333333333333333333333")] },
      });
      const port = createEoaBroadcastPort(publicClient, walletClient);
      await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x00" }))
        .rejects.toThrow(/TaskCreated/u);
    });

    test("serializes concurrent broadcasts so one EOA nonce sequence is not raced", async () => {
      const order: string[] = [];
      const sendTransaction = vi.fn(async () => { order.push("send"); return TX; });
      const { publicClient, walletClient } = clients({ sendTransaction });
      const port = createEoaBroadcastPort(publicClient, walletClient);

      await Promise.all([
        port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x01" }),
        port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x02" }),
      ]);

      expect(order).toEqual(["send", "send"]);
      expect(sendTransaction).toHaveBeenCalledTimes(2);
    });

    test("a failed broadcast does not wedge the queue for the next caller", async () => {
      const sendTransaction = vi.fn()
        .mockRejectedValueOnce(new Error("nonce too low"))
        .mockResolvedValueOnce(TX);
      const { publicClient, walletClient } = clients({ sendTransaction });
      const port = createEoaBroadcastPort(publicClient, walletClient);

      await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x01" }))
        .rejects.toThrow(/nonce too low/u);
      await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x02" }))
        .resolves.toEqual({ taskId: 42n, txHash: TX });
    });
  });
  ```

  Run `yarn vitest run src/venue/eoa-broadcast.test.ts`. Expected: module-not-found (red).

- [ ] Implement `src/venue/eoa-broadcast.ts`.

  ```ts
  // SPDX-License-Identifier: MIT

  // The production `SafeBroadcastPort` for today-mode posting: one direct EOA transaction carrying
  // the `createTask` calldata `postTask` already built, plus the `TaskCreated` receipt decode.
  // Productionizes the wiring that until now existed only inside the Anvil-fork conformance harness
  // (`packages/marketplace/testing/src/backend-conformance.test.ts`) -- supply design §8 D7,
  // binding finding F2.
  //
  // Named divergence (finding F-C5-6): `JinnRouterV3.createTask` is a plain `payable` function
  // keyed on `msg.sender`, so today-mode posting is not Safe-gated. Safe-routing itself
  // (`executeSafeTransaction` in `./safe.js`) is the work client's territory: the marketplace
  // consumption-boundary design owns posting mechanics, and this adapter is what the posting
  // application swaps out beneath its policy surface at that client's mint (supply design §8, F7).
  // The interface keeps its name because this is that interface's production implementation;
  // `input.safeAddress` is the creator of record, and this port CHECKS it against the wallet's own
  // account rather than assuming the caller got it right.
  import { TaskExecutionError } from "@jinn-network/task-execution-backend";
  import { decodeEventLog, type PublicClient, type WalletClient } from "viem";
  import { JINN_ROUTER_V3_ABI } from "../abis/jinn-router-v3.js";
  import type { PostingOutcome } from "../broadcast-intent.js";
  import type { SafeBroadcastPort } from "../posting.js";

  type TransactionReceipt = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;

  export interface EoaBroadcastOptions {
    /** Receipt poll interval in ms; omitted -> the client's own default. */
    readonly receiptPollingIntervalMs?: number;
    /** Receipt wait ceiling in ms; omitted -> the client's own default. */
    readonly receiptTimeoutMs?: number;
  }

  function decodeTaskCreatedTaskId(receipt: TransactionReceipt, router: string): bigint | undefined {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== router.toLowerCase()) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics });
      } catch {
        continue; // a router log this ABI does not describe is not an error, just not ours
      }
      if (decoded.eventName === "TaskCreated") return decoded.args.taskId;
    }
    return undefined;
  }

  /**
   * Builds the EOA broadcast port. Both viem clients are parameters -- this module never constructs
   * a transport, reads an env var, or touches key material (custody law). The wallet client's
   * account is the requester of record.
   *
   * Broadcasts are serialized per port instance: one EOA has one nonce sequence, and two concurrent
   * posts would race it. Serializing here keeps the lock out of `postTask`, which stays
   * chain-client-agnostic.
   */
  export function createEoaBroadcastPort(
    publicClient: PublicClient,
    walletClient: WalletClient,
    options: EoaBroadcastOptions = {},
  ): SafeBroadcastPort {
    const account = walletClient.account;
    if (account === undefined) {
      throw new Error("createEoaBroadcastPort requires a wallet client with an account");
    }
    let queue: Promise<unknown> = Promise.resolve();

    return {
      broadcastCreateTask: async (input) => {
        const run = queue.then(async (): Promise<PostingOutcome> => {
          if (input.safeAddress.toLowerCase() !== account.address.toLowerCase()) {
            throw new TaskExecutionError("access-denied", {
              detail:
                `creator of record ${input.safeAddress} is not this wallet's account `
                + `${account.address} -- refusing to post under another requester's identity`,
            });
          }

          const hash = await walletClient.sendTransaction({
            account,
            chain: walletClient.chain ?? null,
            to: input.to,
            data: input.data,
            value: input.value,
          });

          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            ...(options.receiptPollingIntervalMs === undefined
              ? {}
              : { pollingInterval: options.receiptPollingIntervalMs }),
            ...(options.receiptTimeoutMs === undefined ? {} : { timeout: options.receiptTimeoutMs }),
          });
          if (receipt.status !== "success") {
            throw new Error(`JinnRouterV3.createTask reverted (txHash=${hash})`);
          }

          const taskId = decodeTaskCreatedTaskId(receipt, input.to);
          if (taskId === undefined) {
            throw new TaskExecutionError("protocol-violation", {
              detail:
                `createTask succeeded but the router emitted no TaskCreated event (txHash=${hash}) `
                + "-- the post cannot be keyed, so the intent stays unresolved for the recovery scan",
            });
          }
          return { taskId, txHash: hash };
        });
        // The queue must survive a rejection: the next caller waits for this attempt to finish, not
        // for it to succeed.
        queue = run.then(() => undefined, () => undefined);
        return await run;
      },
    };
  }
  ```

- [ ] Add to `src/index.ts` (beside the other `venue/` exports):

  ```ts
  export { createEoaBroadcastPort } from "./venue/eoa-broadcast.js";
  export type { EoaBroadcastOptions } from "./venue/eoa-broadcast.js";
  ```

- [ ] `yarn vitest run src/venue/eoa-broadcast.test.ts && yarn typecheck` — expected: 6 passing,
  zero type errors.

- [ ] `node --test .github/scripts/marketplace-source-boundaries.test.mjs` from the repo root.
  Expected: all pass — in particular the ambient-network check (this file uses no `fetch`).

- [ ] Commit: `feat(marketplace): add the EOA createTask broadcast port`

---

## Task A3 — `createFilePostingIntentStore` and the shared WAL conformance suite

The WAL semantics are the whole point of this task: `claim` is atomic create-or-report, only the
unguessable token may `fence` or `resolve`, a resolved key replays its outcome, and a claim that
crashes before resolution is still visible to `scanPending` **with its owner token**. The suite runs
against both stores so the durable one cannot drift from the reference.

**Files**
- `packages/marketplace/binding/src/broadcast-intent.ts` (one additive `export` keyword — F-C5-3)
- `packages/marketplace/binding/src/posting-intent-file-store.ts` (new)
- `packages/marketplace/binding/src/posting-intent-store-conformance.test.ts` (new)
- `packages/marketplace/binding/src/posting-intent-file-store.test.ts` (new)
- `packages/marketplace/binding/src/index.ts` (exports only)

**Interfaces**
- *Consumes* (`integration/evidence-v1`): `PostingIntent`, `PostingIntentKey`, `PostingIntentClaim`,
  `PostingIntentRecord`, `PostingIntentStore`, `PostingOwnerToken`, `PostingOutcome`,
  `createInMemoryPostingIntentStore`, `recoverPostingIntents` from `./broadcast-intent.js`;
  `compareCodeUnitStrings` from `./order.js`.
- *Produces* (program §4): `createFilePostingIntentStore(dir)`; plus the `OwnedPostingIntentRecord`
  type export (F-C5-3 disposition).

**Steps**

- [ ] Apply the F-C5-3 disposition — in `src/broadcast-intent.ts`, change the one declaration:

  ```ts
  // was: interface OwnedPostingIntentRecord extends PostingIntentRecord {
  export interface OwnedPostingIntentRecord extends PostingIntentRecord {
    readonly ownerToken: PostingOwnerToken;
  }
  ```

  Nothing else in that file changes. Add `OwnedPostingIntentRecord` to the existing
  `export type { … } from "./broadcast-intent.js";` block in `src/index.ts`.

- [ ] Write `src/posting-intent-store-conformance.test.ts` — the shared suite, red for the file
  store, green for the in-memory one:

  ```ts
  import { mkdtempSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { afterEach, describe, expect, test } from "vitest";
  import {
    createInMemoryPostingIntentStore,
    recoverPostingIntents,
    type PostingIntent,
    type PostingIntentStore,
  } from "./broadcast-intent.js";
  import { createFilePostingIntentStore } from "./posting-intent-file-store.js";

  const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;
  const OUTCOME = { taskId: 7n, txHash: `0x${"cd".repeat(32)}` as const };

  function intent(seed: string): PostingIntent {
    return {
      creatorSafe: CREATOR,
      taskCidDigest: `sha256:${seed.repeat(2).padEnd(64, "0")}`,
      submissionDigest: `sha256:${seed.repeat(2).padEnd(64, "1")}`,
      idempotencyKey: `key-${seed}`,
      createdAt: "2026-07-31T00:00:00Z",
    };
  }

  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fileStore(): PostingIntentStore {
    const directory = mkdtempSync(join(tmpdir(), "jinn-posting-intents-"));
    directories.push(directory);
    return createFilePostingIntentStore(directory);
  }

  describe.each([
    ["in-memory", () => createInMemoryPostingIntentStore()],
    ["file", fileStore],
  ])("PostingIntentStore conformance -- %s", (_name, make) => {
    test("claim creates ownership once; a second claim reports pending-other", async () => {
      const store = make();
      const first = await store.claim(intent("a"));
      const second = await store.claim(intent("a"));
      expect(first.kind).toBe("owner");
      expect(second.kind).toBe("pending-other");
      if (second.kind === "pending-other") expect(second.intent.idempotencyKey).toBe("key-a");
    });

    test("a resolved key replays its outcome instead of re-claiming", async () => {
      const store = make();
      const claim = await store.claim(intent("b"));
      if (claim.kind !== "owner") throw new Error("expected owner");
      await store.resolve(intent("b"), claim.ownerToken, OUTCOME);
      const replay = await store.claim(intent("b"));
      expect(replay).toEqual({ kind: "resolved", outcome: OUTCOME });
    });

    test("fence is true only for the live owner of an unresolved intent", async () => {
      const store = make();
      const claim = await store.claim(intent("c"));
      if (claim.kind !== "owner") throw new Error("expected owner");
      expect(await store.fence(intent("c"), claim.ownerToken)).toBe(true);
      expect(await store.fence(intent("c"), "posting-owner:not-the-owner" as typeof claim.ownerToken)).toBe(false);
      expect(await store.fence(intent("d"), claim.ownerToken)).toBe(false);
      await store.resolve(intent("c"), claim.ownerToken, OUTCOME);
      expect(await store.fence(intent("c"), claim.ownerToken)).toBe(false);
    });

    test("only the owner token may resolve, and never to a second outcome", async () => {
      const store = make();
      const claim = await store.claim(intent("e"));
      if (claim.kind !== "owner") throw new Error("expected owner");
      await expect(store.resolve(intent("e"), "posting-owner:other" as typeof claim.ownerToken, OUTCOME))
        .rejects.toThrow(/owner token/u);
      await expect(store.resolve(intent("f"), claim.ownerToken, OUTCOME))
        .rejects.toThrow(/never claimed/u);
      await store.resolve(intent("e"), claim.ownerToken, OUTCOME);
      await store.resolve(intent("e"), claim.ownerToken, OUTCOME); // idempotent
      await expect(store.resolve(intent("e"), claim.ownerToken, { ...OUTCOME, taskId: 8n }))
        .rejects.toThrow(/different outcome/u);
    });

    test("lookup never leaks the owner token", async () => {
      const store = make();
      const claim = await store.claim(intent("9"));
      if (claim.kind !== "owner") throw new Error("expected owner");
      const record = await store.lookup(intent("9"));
      expect(record?.idempotencyKey).toBe("key-9");
      expect(Object.keys(record ?? {})).not.toContain("ownerToken");
      expect(await store.lookup(intent("8"))).toBeUndefined();
    });

    test("scanPending returns unresolved intents with their tokens, and recovery adopts a match", async () => {
      const store = make();
      const claimed = await store.claim(intent("7"));
      if (claimed.kind !== "owner") throw new Error("expected owner");
      const pending = await store.scanPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.ownerToken).toBe(claimed.ownerToken);

      const uncertain = await recoverPostingIntents(store, async () => OUTCOME);
      expect(uncertain).toEqual([]);
      expect(await store.lookup(intent("7"))).toMatchObject({ resolved: OUTCOME });
      expect(await store.scanPending()).toEqual([]);
    });

    test("a scan with no match leaves the intent uncertain and unresolved", async () => {
      const store = make();
      await store.claim(intent("6"));
      const uncertain = await recoverPostingIntents(store, async () => null);
      expect(uncertain).toHaveLength(1);
      expect(await store.scanPending()).toHaveLength(1);
    });
  });
  ```

  Run `yarn vitest run src/posting-intent-store-conformance.test.ts`. Expected: the in-memory rows
  pass, the file rows fail on the missing module — the red state.

- [ ] Implement `src/posting-intent-file-store.ts`.

  ```ts
  // SPDX-License-Identifier: MIT

  // A durable `PostingIntentStore` on the local filesystem -- the crash-safety half of the pinned
  // 2026-07-24 broadcast-intent design, surviving process death (supply design §8 D7). The
  // semantics are the in-memory store's, unchanged: `posting-intent-store-conformance.test.ts` runs
  // one suite against both.
  //
  // Atomicity, concretely:
  //   claim   -- a single `open(path, "wx")`. O_EXCL makes the OS pick the winner, so there is no
  //              read-then-write window and no racy lookup-then-unconditional-write (the port's
  //              stated prohibition).
  //   resolve -- write a sibling temp file, fsync it, `rename` it over the record. POSIX rename
  //              within one directory replaces atomically, so a reader sees the old record or the
  //              new one, never a half-written one.
  //   both    -- fsync the file and then the directory before returning. A write-ahead record that
  //              is only in the page cache is not a write-ahead record.
  //
  // This store owns the crash-safety half only. It is NOT a cross-session "already posted" ledger;
  // a caller wanting full idempotent resubmission keeps its own completed-post record (see
  // broadcast-intent.ts's header).
  import { open, readFile, readdir, rename, unlink } from "node:fs/promises";
  import { join } from "node:path";
  import type {
    OwnedPostingIntentRecord,
    PostingIntent,
    PostingIntentClaim,
    PostingIntentKey,
    PostingIntentRecord,
    PostingIntentStore,
    PostingOutcome,
    PostingOwnerToken,
  } from "./broadcast-intent.js";
  import { compareCodeUnitStrings } from "./order.js";

  const CREATOR_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
  const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
  const RECORD_SUFFIX = ".json";

  interface StoredRecord {
    readonly creatorSafe: `0x${string}`;
    readonly taskCidDigest: `sha256:${string}`;
    readonly submissionDigest: `sha256:${string}`;
    readonly idempotencyKey: string;
    readonly createdAt: string;
    readonly ownerToken: string;
    readonly resolved?: { readonly taskId: string; readonly txHash: `0x${string}` };
  }

  /**
   * The record file name. Every component is validated before it reaches a path: an unchecked
   * digest or address would be a path-traversal primitive, and a store that refuses a malformed key
   * fails closed instead of writing outside its directory.
   */
  function recordFileName(key: PostingIntentKey): string {
    if (!CREATOR_PATTERN.test(key.creatorSafe)) {
      throw new Error(`creatorSafe is not a 20-byte address: ${key.creatorSafe}`);
    }
    if (!DIGEST_PATTERN.test(key.taskCidDigest)) {
      throw new Error(`taskCidDigest is not a sha256: digest: ${key.taskCidDigest}`);
    }
    if (!DIGEST_PATTERN.test(key.submissionDigest)) {
      throw new Error(`submissionDigest is not a sha256: digest: ${key.submissionDigest}`);
    }
    return `${key.creatorSafe.toLowerCase().slice(2)}-${key.taskCidDigest.slice(7)}`
      + `-${key.submissionDigest.slice(7)}${RECORD_SUFFIX}`;
  }

  function serialize(record: StoredRecord): string {
    return `${JSON.stringify(record, undefined, 2)}\n`;
  }

  function parse(text: string): StoredRecord {
    const parsed = JSON.parse(text) as StoredRecord;
    if (typeof parsed.ownerToken !== "string" || typeof parsed.idempotencyKey !== "string") {
      throw new Error("posting intent record is missing its owner token or idempotency key");
    }
    return parsed;
  }

  function toOwnedRecord(stored: StoredRecord): OwnedPostingIntentRecord {
    return {
      creatorSafe: stored.creatorSafe,
      taskCidDigest: stored.taskCidDigest,
      submissionDigest: stored.submissionDigest,
      idempotencyKey: stored.idempotencyKey,
      createdAt: stored.createdAt,
      ownerToken: stored.ownerToken as PostingOwnerToken,
      ...(stored.resolved === undefined
        ? {}
        : { resolved: { taskId: BigInt(stored.resolved.taskId), txHash: stored.resolved.txHash } }),
    };
  }

  function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
  }

  async function syncDirectory(directory: string): Promise<void> {
    let handle;
    try {
      handle = await open(directory, "r");
    } catch (error) {
      // Directory handles are not openable for fsync everywhere; the file fsync already happened.
      if (["EPERM", "EACCES", "EISDIR", "EINVAL"].includes(errorCode(error) ?? "")) return;
      throw error;
    }
    try {
      await handle.sync();
    } catch (error) {
      if (!["EPERM", "EACCES", "EISDIR", "EINVAL"].includes(errorCode(error) ?? "")) throw error;
    } finally {
      await handle.close();
    }
  }

  /**
   * @param directory absolute path the store owns; created on first write. One directory per
   * requester identity keeps `scanPending` scoped to the intents that identity may resolve.
   */
  export function createFilePostingIntentStore(directory: string): PostingIntentStore {
    let prepared: Promise<void> | undefined;
    const ensureDirectory = async (): Promise<void> => {
      prepared ??= (async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(directory, { recursive: true });
      })();
      await prepared;
    };

    const readRecord = async (name: string): Promise<StoredRecord | undefined> => {
      let text: string;
      try {
        text = await readFile(join(directory, name), "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      if (text.trim() === "") return undefined; // a claim interrupted before its record was durable
      return parse(text);
    };

    const writeThroughRename = async (name: string, record: StoredRecord): Promise<void> => {
      const target = join(directory, name);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(serialize(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      await syncDirectory(directory);
    };

    const requireOwned = async (key: PostingIntentKey, ownerToken: PostingOwnerToken) => {
      const name = recordFileName(key);
      const existing = await readRecord(name);
      if (existing === undefined) throw new Error("cannot resolve an intent that was never claimed");
      if (existing.ownerToken !== ownerToken) {
        throw new Error("only the posting intent owner token may resolve");
      }
      return { name, existing };
    };

    return {
      async claim(intent: PostingIntent): Promise<PostingIntentClaim> {
        await ensureDirectory();
        const name = recordFileName(intent);
        const record: StoredRecord = {
          creatorSafe: intent.creatorSafe,
          taskCidDigest: intent.taskCidDigest,
          submissionDigest: intent.submissionDigest,
          idempotencyKey: intent.idempotencyKey,
          createdAt: intent.createdAt,
          ownerToken: `posting-owner:${crypto.randomUUID()}`,
        };

        let handle;
        try {
          handle = await open(join(directory, name), "wx");
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          const existing = await readRecord(name);
          if (existing === undefined) {
            // A zero-length record provably precedes any broadcast: `postTask` broadcasts only
            // after `claim` returns owner, and the record is durable before that. Taking it over is
            // safe, and if two callers do so at once the loser's `fence` fails and it raises
            // BroadcastUncertainError rather than posting twice -- at-most-once holds.
            await writeThroughRename(name, record);
            return { kind: "owner", intent, ownerToken: record.ownerToken as PostingOwnerToken };
          }
          if (existing.resolved !== undefined) {
            return {
              kind: "resolved",
              outcome: { taskId: BigInt(existing.resolved.taskId), txHash: existing.resolved.txHash },
            };
          }
          const { ownerToken: _ownerToken, resolved: _resolved, ...view } = toOwnedRecord(existing);
          return { kind: "pending-other", intent: view };
        }

        try {
          await handle.writeFile(serialize(record), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(directory);
        return { kind: "owner", intent, ownerToken: record.ownerToken as PostingOwnerToken };
      },

      async fence(key: PostingIntentKey, ownerToken: PostingOwnerToken): Promise<boolean> {
        const existing = await readRecord(recordFileName(key));
        return existing !== undefined
          && existing.resolved === undefined
          && existing.ownerToken === ownerToken;
      },

      async resolve(
        key: PostingIntentKey,
        ownerToken: PostingOwnerToken,
        outcome: PostingOutcome,
      ): Promise<void> {
        const { name, existing } = await requireOwned(key, ownerToken);
        if (existing.resolved !== undefined) {
          if (
            BigInt(existing.resolved.taskId) !== outcome.taskId
            || existing.resolved.txHash !== outcome.txHash
          ) {
            throw new Error("posting intent is already resolved to a different outcome");
          }
          return;
        }
        await writeThroughRename(name, {
          ...existing,
          resolved: { taskId: outcome.taskId.toString(10), txHash: outcome.txHash },
        });
      },

      async lookup(key: PostingIntentKey): Promise<PostingIntentRecord | undefined> {
        const existing = await readRecord(recordFileName(key));
        if (existing === undefined) return undefined;
        const { ownerToken: _ownerToken, ...view } = toOwnedRecord(existing);
        return view;
      },

      async scanPending(): Promise<readonly OwnedPostingIntentRecord[]> {
        let names: string[];
        try {
          names = await readdir(directory);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return [];
          throw error;
        }
        // readdir order is not specified; a fixed code-unit order makes recovery replay the same
        // way twice (localeCompare is banned in this tree -- see src/order.ts).
        const records: OwnedPostingIntentRecord[] = [];
        for (const name of names.filter((entry) => entry.endsWith(RECORD_SUFFIX)).sort(compareCodeUnitStrings)) {
          // eslint-disable-next-line no-await-in-loop -- recovery scans are small and sequential.
          const stored = await readRecord(name);
          if (stored === undefined || stored.resolved !== undefined) continue;
          records.push(toOwnedRecord(stored));
        }
        return records;
      },
    };
  }
  ```

- [ ] `yarn vitest run src/posting-intent-store-conformance.test.ts` — expected: both parameterized
  suites green (14 tests).

- [ ] Write `src/posting-intent-file-store.test.ts` for the file-specific behavior the shared suite
  cannot express:

  ```ts
  import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { afterEach, describe, expect, test } from "vitest";
  import { createFilePostingIntentStore } from "./posting-intent-file-store.js";

  const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;
  const KEY = {
    creatorSafe: CREATOR,
    taskCidDigest: `sha256:${"a".repeat(64)}`,
    submissionDigest: `sha256:${"b".repeat(64)}`,
  } as const;
  const INTENT = { ...KEY, idempotencyKey: "key-1", createdAt: "2026-07-31T00:00:00Z" } as const;

  let directory: string;
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  function makeDirectory(): string {
    directory = mkdtempSync(join(tmpdir(), "jinn-posting-file-store-"));
    return directory;
  }

  describe("createFilePostingIntentStore", () => {
    test("a claim survives process death: a fresh store instance still sees it pending", async () => {
      const path = makeDirectory();
      const crashed = createFilePostingIntentStore(path);
      const claim = await crashed.claim(INTENT);
      if (claim.kind !== "owner") throw new Error("expected owner");

      const restarted = createFilePostingIntentStore(path); // the process came back
      const pending = await restarted.scanPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.ownerToken).toBe(claim.ownerToken);
      expect(await restarted.fence(KEY, claim.ownerToken)).toBe(true);
    });

    test("a resolved outcome survives restart with its bigint taskId intact", async () => {
      const path = makeDirectory();
      const store = createFilePostingIntentStore(path);
      const claim = await store.claim(INTENT);
      if (claim.kind !== "owner") throw new Error("expected owner");
      await store.resolve(KEY, claim.ownerToken, { taskId: 2n ** 70n, txHash: `0x${"cd".repeat(32)}` });

      const restarted = createFilePostingIntentStore(path);
      expect(await restarted.lookup(KEY)).toMatchObject({ resolved: { taskId: 2n ** 70n } });
    });

    test("the record is readable JSON keyed by creator and both digests", async () => {
      const path = makeDirectory();
      await createFilePostingIntentStore(path).claim(INTENT);
      const [name] = readdirSync(path);
      expect(name).toBe(`${CREATOR.toLowerCase().slice(2)}-${"a".repeat(64)}-${"b".repeat(64)}.json`);
      expect(JSON.parse(readFileSync(join(path, name!), "utf8"))).toMatchObject({ idempotencyKey: "key-1" });
    });

    test("refuses a key whose components could escape the store directory", async () => {
      const store = createFilePostingIntentStore(makeDirectory());
      await expect(store.claim({ ...INTENT, creatorSafe: "../../etc" as `0x${string}` }))
        .rejects.toThrow(/not a 20-byte address/u);
      await expect(store.claim({ ...INTENT, taskCidDigest: "sha256:../x" as `sha256:${string}` }))
        .rejects.toThrow(/not a sha256/u);
    });

    test("takes over a zero-length record (a claim that died before its record was durable)", async () => {
      const path = makeDirectory();
      const store = createFilePostingIntentStore(path);
      writeFileSync(join(path, `${CREATOR.toLowerCase().slice(2)}-${"a".repeat(64)}-${"b".repeat(64)}.json`), "");
      const claim = await store.claim(INTENT);
      expect(claim.kind).toBe("owner");
      expect(await store.scanPending()).toHaveLength(1);
    });

    test("refuses a non-empty corrupt record instead of silently re-claiming it", async () => {
      const path = makeDirectory();
      const store = createFilePostingIntentStore(path);
      writeFileSync(join(path, `${CREATOR.toLowerCase().slice(2)}-${"a".repeat(64)}-${"b".repeat(64)}.json`), "{ nope");
      await expect(store.claim(INTENT)).rejects.toThrow();
    });

    test("leaves no temp files behind after resolve", async () => {
      const path = makeDirectory();
      const store = createFilePostingIntentStore(path);
      const claim = await store.claim(INTENT);
      if (claim.kind !== "owner") throw new Error("expected owner");
      await store.resolve(KEY, claim.ownerToken, { taskId: 1n, txHash: `0x${"ef".repeat(32)}` });
      expect(readdirSync(path).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });
  ```

- [ ] `yarn vitest run src/posting-intent-file-store.test.ts` — expected: 7 passing.

- [ ] Add to `src/index.ts`, inside the existing broadcast-intent block:

  ```ts
  export { createFilePostingIntentStore } from "./posting-intent-file-store.js";
  ```

- [ ] `yarn typecheck && yarn test` — expected: the whole binding suite green, zero type errors.

- [ ] Commit: `feat(marketplace): add the durable file-backed posting intent store`

---

## Task A4 — `scanForOnChainMatch`

**Files**
- `packages/marketplace/binding/src/venue/task-created-scan.ts` (new)
- `packages/marketplace/binding/src/venue/task-created-scan.test.ts` (new)
- `packages/marketplace/binding/src/index.ts` (exports only)

**Interfaces**
- *Consumes* (`integration/evidence-v1`): `ScanForOnChainMatch`, `PostingIntent`, `PostingOutcome`
  from `../broadcast-intent.js`; `MarketplaceChainConfig` from `../addresses.js`;
  `JINN_ROUTER_V3_ABI` from `../abis/jinn-router-v3.js`; viem's `PublicClient`.
- *Produces* (program §4): `scanForOnChainMatch(publicClient, config)`.

**Steps**

- [ ] Write `src/venue/task-created-scan.test.ts` first:

  ```ts
  import type { PublicClient } from "viem";
  import { describe, expect, test, vi } from "vitest";
  import { BASE_SEPOLIA_TODAY } from "../addresses.js";
  import type { PostingIntent } from "../broadcast-intent.js";
  import { DEFAULT_SCAN_BLOCK_RANGE, scanForOnChainMatch } from "./task-created-scan.js";

  const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;
  const TASK_DIGEST = "a".repeat(64);
  const INTENT: PostingIntent = {
    creatorSafe: CREATOR,
    taskCidDigest: `sha256:${TASK_DIGEST}`,
    submissionDigest: `sha256:${"b".repeat(64)}`,
    idempotencyKey: "key-1",
    createdAt: "2026-07-31T00:00:00Z",
  };

  function log(overrides: Record<string, unknown> = {}) {
    return {
      args: { creator: CREATOR, taskId: 42n, taskCidDigest: `0x${TASK_DIGEST}` },
      transactionHash: `0x${"cd".repeat(32)}`,
      blockNumber: 100n,
      logIndex: 0,
      ...overrides,
    };
  }

  function client(getLogs: ReturnType<typeof vi.fn>, head = 1_000n): PublicClient {
    return { getLogs, getBlockNumber: vi.fn(async () => head) } as unknown as PublicClient;
  }

  describe("scanForOnChainMatch", () => {
    test("adopts a post whose creator and task digest both match", async () => {
      const getLogs = vi.fn(async () => [log()]);
      const scan = scanForOnChainMatch(client(getLogs), { chain: BASE_SEPOLIA_TODAY, fromBlock: 0n });
      expect(await scan(INTENT)).toEqual({ taskId: 42n, txHash: `0x${"cd".repeat(32)}` });
      expect(getLogs.mock.calls[0]?.[0]).toMatchObject({
        address: BASE_SEPOLIA_TODAY.jinnRouter,
        args: { creator: CREATOR },
      });
    });

    test("ignores a post by the same creator for a different task digest", async () => {
      const getLogs = vi.fn(async () => [log({ args: { creator: CREATOR, taskId: 9n, taskCidDigest: `0x${"f".repeat(64)}` } })]);
      const scan = scanForOnChainMatch(client(getLogs), { chain: BASE_SEPOLIA_TODAY, fromBlock: 0n });
      expect(await scan(INTENT)).toBeNull();
    });

    test("returns null when nothing landed", async () => {
      const scan = scanForOnChainMatch(client(vi.fn(async () => [])), { chain: BASE_SEPOLIA_TODAY, fromBlock: 0n });
      expect(await scan(INTENT)).toBeNull();
    });

    test("windows the scan so a capped provider is never asked for the whole range at once", async () => {
      const getLogs = vi.fn(async () => []);
      const scan = scanForOnChainMatch(client(getLogs, 5_000n), {
        chain: BASE_SEPOLIA_TODAY, fromBlock: 0n, blockRange: 2_000n,
      });
      await scan(INTENT);
      expect(getLogs.mock.calls.map((call) => [call[0].fromBlock, call[0].toBlock]))
        .toEqual([[0n, 1_999n], [2_000n, 3_999n], [4_000n, 5_000n]]);
    });

    test("defaults to a provider-safe window and honors an explicit toBlock without asking for head", async () => {
      expect(DEFAULT_SCAN_BLOCK_RANGE).toBe(2_000n);
      const getBlockNumber = vi.fn();
      const getLogs = vi.fn(async () => []);
      const scan = scanForOnChainMatch({ getLogs, getBlockNumber } as unknown as PublicClient, {
        chain: BASE_SEPOLIA_TODAY, fromBlock: 10n, toBlock: 20n,
      });
      await scan(INTENT);
      expect(getBlockNumber).not.toHaveBeenCalled();
      expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 10n, toBlock: 20n });
    });

    test("adopts the earliest of two matching posts and reports the ambiguity", async () => {
      const onAmbiguousMatch = vi.fn();
      const getLogs = vi.fn(async () => [
        log({ taskId: 77n, blockNumber: 300n, args: { creator: CREATOR, taskId: 77n, taskCidDigest: `0x${TASK_DIGEST}` } }),
        log({ blockNumber: 200n }),
      ]);
      const scan = scanForOnChainMatch(client(getLogs), {
        chain: BASE_SEPOLIA_TODAY, fromBlock: 0n, onAmbiguousMatch,
      });
      expect(await scan(INTENT)).toMatchObject({ taskId: 42n });
      expect(onAmbiguousMatch).toHaveBeenCalledTimes(1);
    });

    test("rejects a non-positive window rather than looping forever", () => {
      expect(() => scanForOnChainMatch(client(vi.fn()), {
        chain: BASE_SEPOLIA_TODAY, fromBlock: 0n, blockRange: 0n,
      })).toThrow(RangeError);
    });
  });
  ```

- [ ] Implement `src/venue/task-created-scan.ts`.

  ```ts
  // SPDX-License-Identifier: MIT

  // The chain half of the recovery scan (pinned 2026-07-24 design's "exact recovery scan"; supply
  // design §8 D7): given a pending broadcast intent, ask the chain whether that exact post landed.
  // Keyed on the two facts `TaskCreated` carries -- the indexed `creator` and the `taskCidDigest`
  // word in the event data -- so an adopted match is the same pair the intent was claimed under,
  // never a near-miss on one leg.
  import type { Address, PublicClient } from "viem";
  import { JINN_ROUTER_V3_ABI } from "../abis/jinn-router-v3.js";
  import type { MarketplaceChainConfig } from "../addresses.js";
  import type { PostingIntent, PostingOutcome, ScanForOnChainMatch } from "../broadcast-intent.js";

  /** Blocks per `getLogs` window. Free Base endpoints cap the range (2k on several), so the scan windows. */
  export const DEFAULT_SCAN_BLOCK_RANGE = 2_000n;

  export interface AmbiguousMatchReport {
    readonly intent: PostingIntent;
    readonly adopted: PostingOutcome;
    readonly additionalMatches: number;
  }

  export interface OnChainMatchScanConfig {
    readonly chain: MarketplaceChainConfig;
    /** First block read -- the requester's first-post block, never an accidental 0n on mainnet. */
    readonly fromBlock: bigint;
    /** Last block read; omitted or "latest" asks the client for the head once per scan. */
    readonly toBlock?: bigint | "latest";
    readonly blockRange?: bigint;
    /**
     * Called when more than one on-chain post matches the same key. This store's WAL cannot produce
     * that (at-most-once per key), so it means a post was made outside it; the earliest match is
     * adopted and the caller is told, rather than the scan picking one quietly.
     */
    readonly onAmbiguousMatch?: (report: AmbiguousMatchReport) => void;
  }

  const TASK_CREATED_EVENT = (() => {
    const entry = JINN_ROUTER_V3_ABI.find((item) => item.type === "event" && item.name === "TaskCreated");
    if (entry === undefined) throw new Error("the JinnRouterV3 ABI is missing the TaskCreated event");
    return entry as Extract<(typeof JINN_ROUTER_V3_ABI)[number], { readonly type: "event"; readonly name: "TaskCreated" }>;
  })();

  interface Match extends PostingOutcome {
    readonly blockNumber: bigint;
    readonly logIndex: number;
  }

  /**
   * Builds the `ScanForOnChainMatch` port `recoverPostingIntents` calls. The viem client is a
   * parameter: this module never constructs a transport and never reads an RPC URL (custody law).
   */
  export function scanForOnChainMatch(
    publicClient: PublicClient,
    config: OnChainMatchScanConfig,
  ): ScanForOnChainMatch {
    const window = config.blockRange ?? DEFAULT_SCAN_BLOCK_RANGE;
    if (window <= 0n) throw new RangeError("blockRange must be a positive block count");

    return async (intent) => {
      const wanted = `0x${intent.taskCidDigest.slice("sha256:".length)}`.toLowerCase();
      const head = config.toBlock === undefined || config.toBlock === "latest"
        ? await publicClient.getBlockNumber()
        : config.toBlock;

      const matches: Match[] = [];
      for (let from = config.fromBlock; from <= head; from += window) {
        const to = from + window - 1n > head ? head : from + window - 1n;
        // eslint-disable-next-line no-await-in-loop -- windows must be sequential: providers cap the range.
        const logs = await publicClient.getLogs({
          address: config.chain.jinnRouter as Address,
          event: TASK_CREATED_EVENT,
          args: { creator: intent.creatorSafe as Address },
          fromBlock: from,
          toBlock: to,
        });
        for (const entry of logs) {
          const digest = entry.args.taskCidDigest;
          const taskId = entry.args.taskId;
          if (digest === undefined || taskId === undefined) continue;
          if (digest.toLowerCase() !== wanted) continue;
          if (entry.transactionHash === null || entry.blockNumber === null || entry.logIndex === null) continue;
          matches.push({
            taskId,
            txHash: entry.transactionHash,
            blockNumber: entry.blockNumber,
            logIndex: entry.logIndex,
          });
        }
      }

      if (matches.length === 0) return null;
      matches.sort((left, right) => {
        if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
        return left.logIndex - right.logIndex;
      });
      const [earliest, ...rest] = matches as [Match, ...Match[]];
      const adopted: PostingOutcome = { taskId: earliest.taskId, txHash: earliest.txHash };
      if (rest.length > 0) {
        config.onAmbiguousMatch?.({ intent, adopted, additionalMatches: rest.length });
      }
      return adopted;
    };
  }
  ```

- [ ] Add to `src/index.ts`:

  ```ts
  export { DEFAULT_SCAN_BLOCK_RANGE, scanForOnChainMatch } from "./venue/task-created-scan.js";
  export type { AmbiguousMatchReport, OnChainMatchScanConfig } from "./venue/task-created-scan.js";
  ```

- [ ] `yarn vitest run src/venue/task-created-scan.test.ts && yarn typecheck` — expected: 7 passing,
  zero type errors.

- [ ] Commit: `feat(marketplace): add the TaskCreated recovery scan`

---

## Task A5 — document the on-ramp and verify half A end to end

**Files**
- `packages/marketplace/binding/README.md` (new section)

**Interfaces**
- *Consumes:* everything produced by A1–A4.
- *Produces:* the binding-side record of D7/F2 and the F7 hand-off, plus a green half-A branch.

**Steps**

- [ ] Append a section to `packages/marketplace/binding/README.md` after
  "## The two-party engagement entry (Finding F1)":

  ```markdown
  ## The requester on-ramp adapters (D7, Finding F2)

  `postTask` has always taken its ports as parameters; until now the only implementations that
  existed were the in-memory intent store and a broadcast port assembled inside the Anvil-fork
  conformance harness. These four adapters close that gap, landed here rather than in a consuming
  application because the requester on-ramp is binding-tree work (verified-environment supply design
  §8 D7, finding F2):

  - `createEoaBroadcastPort(publicClient, walletClient)` — the production `SafeBroadcastPort`: one
    direct EOA transaction plus the `TaskCreated` receipt decode, serialized per port so one EOA
    nonce sequence is not raced. Today-mode `createTask` is a plain `payable` function keyed on
    `msg.sender`, so it is not Safe-gated. **Safe-routing arrives with the work client** — the
    marketplace consumption-boundary design owns posting mechanics, and this adapter is the piece a
    posting application swaps out at that client's mint.
  - `createFilePostingIntentStore(dir)` — the durable WAL: `open(…, "wx")` for the atomic claim,
    temp-file plus `rename` for resolution, fsync on both, owner tokens persisted so a restarted
    process resumes the same ownership. Same claim/fence/resolve/lookup/scanPending semantics as the
    in-memory store; one suite (`posting-intent-store-conformance.test.ts`) runs against both.
  - `scanForOnChainMatch(publicClient, config)` — the chain half of `recoverPostingIntents`: a
    windowed `TaskCreated` scan keyed on the indexed creator plus the `taskCidDigest`.
  - `DEFAULT_POSTING_TERMS` + `postingEscrowValueWei` + `assertMaxClaimsAgreement` — the escrow
    formula in one place, with `maxClaims` named explicitly. `postTask` takes its multiplier from
    the sealed Submission's `attempts.maxTotal`, falling back to 1; `assertMaxClaimsAgreement`
    throws on an absent `maxTotal` so a posting application cannot reach that fallback by accident.
  ```

- [ ] Run the full half-A verification from the worktree root and show the output:

  ```bash
  node --test .github/scripts/marketplace-package-inventory.test.mjs
  node --test .github/scripts/marketplace-source-boundaries.test.mjs
  (cd packages/marketplace/binding && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
  node .github/scripts/marketplace-packed-types.test.mjs
  ```

  Expected: guards pass (no new forbidden import, no ambient network API, no locale-sensitive API,
  binding `exports` still exactly `["."]`); the binding suite is green; `dist/` builds; the packed
  consumer compiles against the new public symbols.

- [ ] Push and open the PR against `integration/evidence-v1`, titled
  `feat(marketplace): requester on-ramp adapters for task posting (D7)`. Body names finding F2,
  finding F7's hand-off, and the six F-C5 findings' dispositions.

- [ ] Commit: `docs(marketplace): record the D7 requester on-ramp adapters`

---

# Half B — the posting application (`supply/c5-task-posting`)

Base: `supply/c4-task-derivation`. Starts only after C4's pool listing exists on that branch.

**Worktree setup (once, before Task B1):**

```bash
cd /Users/adrianobradley/life\'s-work/jinn-mono
git worktree add ../jinn-mono_worktrees/supply-c5 -b supply/c5-task-posting origin/supply/c4-task-derivation
WT=../jinn-mono_worktrees/supply-c5
git -C "$WT" log --oneline -3            # confirm C4 is the base, not integration
ls "$WT/packages/task-supply"            # expect: admission/ derivation/ (C3 + C4)
ls "$WT/.github/scripts" | grep task-supply
```

**Stop-and-report conditions (contract 11), checked before writing a line of code:**

1. `@jinn-network/task-derivation` does not export `SupplyPool` → stop.
2. The pool listing element does not expose the sealed Task bytes (or a way to read them) **and**
   the admission-receipt digest per entry → stop, citing F-C5-4.
3. The task-supply guard trio is not named `task-supply-{package-inventory,source-boundaries,
   packed-types}.test.mjs`, or the workflow is not `.github/workflows/task-supply-ci.yml` → stop and
   ask C3 for the actual names rather than adding a second convention.

---

## Task B1 — scaffold `@jinn-network/task-posting` and register it in the tree's guards

**Files**
- `packages/task-supply/posting/package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `vitest.config.ts`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`, `README.md`,
  `src/index.ts` (all new)
- `.github/scripts/task-supply-package-inventory.test.mjs` (C3-owned; add this package's row)
- `.github/scripts/task-supply-source-boundaries.test.mjs` (C3-owned; add this package's rules)
- `.github/scripts/task-supply-packed-types.test.mjs` (C3-owned; add the consumer)
- `.github/workflows/task-supply-ci.yml` (C3-owned; add the `posting` job)

**Interfaces**
- *Consumes* (`supply/c4-task-derivation`): the tree scaffolding and guard trio C3 owns; C4's
  package directory layout as the shape to copy.
- *Produces:* the package skeleton and the F7 residual record.

**Steps**

- [ ] Copy the shape, not the content, of a sibling: `packages/task-supply/derivation`'s
  `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `scripts/build.mjs`,
  `scripts/pack-smoke.mjs`. Adjust only the portal paths in `pack-smoke.mjs` (see the dependency
  list below) and the temp-dir prefix (`jinn-task-posting-`).

- [ ] Write `packages/task-supply/posting/package.json`:

  ```json
  {
    "name": "@jinn-network/task-posting",
    "version": "0.1.0",
    "description": "Supply policy for marketplace posting: which admitted, sealed task pairs post, when, at what terms, with the escrow surfaced before spending.",
    "type": "module",
    "packageManager": "yarn@4.13.0",
    "engines": { "node": ">=22" },
    "license": "MIT",
    "repository": {
      "type": "git",
      "url": "https://github.com/Jinn-Network/mono.git",
      "directory": "packages/task-supply/posting"
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
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
      "@jinn-network/task-derivation": "0.1.0",
      "@jinn-network/task-execution-protocol": "0.1.0",
      "viem": "^2.0.0"
    },
    "devDependencies": {
      "@jinn-network/task-execution-backend": "0.1.0",
      "@jinn-network/task-execution-profiles": "0.1.0",
      "@jinn-network/trust-core": "0.1.0",
      "@jinn-network/trust-resolve": "0.1.0",
      "@types/node": "^22.0.0",
      "typescript": "^5.9.3",
      "vitest": "^4.1.8"
    },
    "resolutions": {
      "@jinn-network/marketplace-binding": "portal:../../marketplace/binding",
      "@jinn-network/task-derivation": "portal:../derivation",
      "@jinn-network/task-execution-backend": "portal:../../task-execution/backend",
      "@jinn-network/task-execution-profiles": "portal:../../task-execution/profiles",
      "@jinn-network/task-execution-protocol": "portal:../../task-execution/protocol",
      "@jinn-network/trust-core": "portal:../../trust/core",
      "@jinn-network/trust-resolve": "portal:../../trust/resolve"
    }
  }
  ```

  The four shadow devDependencies mirror `marketplace-binding`'s own portal closure; a standalone
  Yarn project needs a top-level portal resolution for every transitively reachable
  `@jinn-network/*` package (the inventory guard's documented pattern).

- [ ] Write `src/index.ts` as the single public surface (root-only export, matching every other
  package in the stack):

  ```ts
  // @jinn-network/task-posting -- public surface.
  //
  // Policy in, posts out. The mechanics behind `PostingDeps.postTask` are the marketplace binding's
  // today; they are the work client's at its mint (README, finding F7). Nothing else here changes
  // when that swap happens.
  export { planPosting } from "./plan.js";
  export type {
    PostingPlan,
    PostingPlanEntry,
    PostingPolicy,
    PostingPoolEntry,
    PostingSkip,
    PostingSkipReason,
  } from "./types.js";
  export { POSTING_SUBMISSION_NAMESPACE, buildDispatchSubmission } from "./dispatch-submission.js";
  export { PostingRefusedError, executePosting } from "./execute.js";
  export type {
    PostingApproval,
    PostingApprovalPort,
    PostingDeps,
    PostingLogLine,
    PostingLogPort,
    PostingRenderPort,
    PostingRunSummary,
    PostTaskFn,
  } from "./execute.js";
  ```

  (The files these point at land in B2–B4; at B1 the file exports nothing and the package
  typechecks against an empty `src/index.ts` — write the block above only once B4 is done, or the
  build breaks. Keep `src/index.ts` empty with a header comment at B1.)

- [ ] Write `README.md`. The residual section is normative wording, taken from the design's own
  §8/§13-F7 text — do not paraphrase it into something softer:

  ```markdown
  # @jinn-network/task-posting

  Supply policy for marketplace posting: which pool entries post, when, at what terms, under whose
  identity, with the escrow surfaced before spending.

  `planPosting(pool, policy)` is pure — a materialized pool listing plus a policy in, a
  `PostingPlan` out, carrying per-entry and total escrow. `executePosting(deps, plan)` surfaces that
  plan, requires approval before spending, and posts through injected ports. Explicit post is the
  default; auto-post is an opt-in standing policy flag with the same visibility in a log line.

  The plan is the replay unit: the sealed dispatch Submission is a function of the plan alone, so
  re-executing the same plan produces byte-identical Submission bytes, the same broadcast-intent
  key, and a replayed outcome rather than a second post.

  ## Named residual: the work client (F7)

  This package owns supply **policy** only. *How to post safely* — posting and settlement mechanics,
  the preflight core, requester-side evaluation sealing, custody discipline — is the work client's
  job (`packages/marketplace/work-client`), whose design already owns it under a no-wrapper-layers
  rule. The work client's mint is gated on daemon cutover stage 3 plus published canaries; until
  then this package composes the marketplace binding's `postTask` plus the D7 on-ramp adapters
  directly.

  That interim composition is a **named residual of the same class the consumption-boundary design
  already records for benchmarking's marketplace venue**, with the same disposition: **at
  work-client mint, task-posting adopts the work client's posting core beneath its policy surface —
  same code, no fork.** Filed as F7 in
  `docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md` §13. The swap point is
  the injected `PostingDeps.postTask` and `PostingDeps.ports`; no policy code changes with it.

  ## What v1 does not do

  - No pricing engine — terms are operator-supplied (design §12).
  - No derivation, no admission, no attestation reading. Posting carries the admission receipt by
    digest and never re-decides admission.
  - No private evaluation material: v1 posts public-specification evaluation legs only, and
    `capabilityGrants` is never populated (design §8, D5).
  ```

- [ ] Register the package in C3's guard trio. In
  `.github/scripts/task-supply-package-inventory.test.mjs`, add the row and its approved graph:

  ```js
  ['posting', {
    dependencies: [
      '@jinn-network/marketplace-binding',
      '@jinn-network/task-derivation',
      '@jinn-network/task-execution-protocol',
    ],
    // Shadow devDependencies: marketplace-binding's own portal closure needs top-level
    // resolutions in a standalone yarn project (marketplace inventory guard's documented pattern).
    devDependencies: [
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    optionalDependencies: [],
    peerDependencies: [],
  }],
  ```

  In `.github/scripts/task-supply-source-boundaries.test.mjs`, add posting's forbidden set and the
  F-C5-5 type-only assertion:

  ```js
  // posting is an application over the binding (design §3.3): it may consume marketplace-binding
  // and task-execution-protocol. It never imports admission (it carries the receipt by digest and
  // never re-decides admission), never the environment tree (it reads no environment record),
  // never a discovery or trust package (posting signs nothing itself).
  const POSTING_FORBIDDEN_PACKAGES = [
    '@jinn-network/task-admission',
    '@jinn-network/environment-record',
    '@jinn-network/environment-verification',
    '@jinn-network/task-curation',
    '@jinn-network/marketplace-projector', '@jinn-network/marketplace-pipeline',
    '@jinn-network/marketplace-testing',
    '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
    '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
    '@jinn-network/trust-core', '@jinn-network/trust-resolve', '@jinn-network/trust-testing',
  ];

  test('task-posting reaches task-derivation for types only (supply plan finding F-C5-5)', () => {
    const production = files(join(packages, 'posting', 'src'))
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    const valueImports = production.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']@jinn-network\/task-derivation["']/gmu)]
        .map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
    });
    assert.deepEqual(valueImports, [],
      'posting may import @jinn-network/task-derivation with `import type` only: design §3.3 has no '
        + 'runtime posting -> derivation edge');
  });
  ```

  In `.github/scripts/task-supply-packed-types.test.mjs`, add a consumer that imports
  `planPosting`, `executePosting`, and the exported types from the packed entrypoint. In
  `.github/workflows/task-supply-ci.yml`, add a `posting` job needing `derivation`, building the
  binding's portal closure plus `packages/marketplace/binding` before
  `yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke`.

- [ ] Verify the scaffold:

  ```bash
  node --test .github/scripts/task-supply-package-inventory.test.mjs
  node --test .github/scripts/task-supply-source-boundaries.test.mjs
  (cd packages/task-supply/posting && yarn install --immutable && yarn typecheck)
  ```

  Expected: both guards pass with posting registered; the empty package typechecks.

- [ ] Commit: `feat(task-supply): scaffold @jinn-network/task-posting`

---

## Task B2 — `planPosting` (pure)

**Files**
- `packages/task-supply/posting/src/types.ts` (new)
- `packages/task-supply/posting/src/order.ts` (new)
- `packages/task-supply/posting/src/plan.ts` (new)
- `packages/task-supply/posting/src/plan.test.ts` (new)

**Interfaces**
- *Consumes* (`supply/c4-task-derivation`): `SupplyPool` from `@jinn-network/task-derivation`
  (**`import type` only**, F-C5-5) — used to type the listing element the caller passes in.
  (`integration/evidence-v1` via `supply/c5a-binding-adapters` once merged, else the same symbols
  from `@jinn-network/marketplace-binding` on this branch's binding checkout):
  `DEFAULT_POSTING_TERMS`, `DefaultPostingTerms`, `postingEscrowValueWei`.
- *Produces* (program §4): `planPosting(pool, policy): PostingPlan` (pure).

**Steps**

- [ ] Write `src/types.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import type { DefaultPostingTerms } from "@jinn-network/marketplace-binding";

  /**
   * One admitted, sealed pair as this application needs it. Structurally what C4's `SupplyPool`
   * listing yields; declared here because §3.1 makes this package usable by "any requester with
   * sealed pairs from any source", not only by C4's pool.
   *
   * `admissionReceiptDigest` is required: the dispatch Submission must carry the admission-receipt
   * descriptor, or the evaluation leg derived from it later is refused (binding §7.39; plan finding
   * F-C5-4).
   */
  export interface PostingPoolEntry {
    readonly taskDigest: `sha256:${string}`;
    readonly taskBytes: Uint8Array;
    readonly evaluationSpecDigest: `sha256:${string}`;
    readonly admissionReceiptDigest: `sha256:${string}`;
    readonly admissionReceiptUri?: string;
    /** v1 posts public-specification evaluation legs only (design §8, D5); false is refused. */
    readonly evaluationSpecPublic: boolean;
  }

  export type PostingSkipReason =
    | "excluded"
    | "already-posted"
    | "batch-limit"
    | "evaluation-not-public";

  export interface PostingSkip {
    readonly taskDigest: `sha256:${string}`;
    readonly reason: PostingSkipReason;
  }

  /**
   * Supply policy. `now` is an input, not a clock read: the sealed Submission is a function of the
   * plan, so a plan built twice from the same inputs yields byte-identical bytes and therefore the
   * same broadcast-intent key. A hidden clock would turn every replay into a new post.
   */
  export interface PostingPolicy {
    readonly terms: DefaultPostingTerms;
    readonly creatorSafe: `0x${string}`;
    /** The requester of record recorded in every Submission this plan seals. */
    readonly requester: string;
    /** RFC 3339 with an explicit offset. */
    readonly now: string;
    readonly deadlineSeconds: number;
    readonly closeAtSeconds?: number;
    readonly batchLimit: number;
    readonly excludedTaskDigests?: readonly string[];
    /** Digests already posted by this requester; never-posted entries always plan first. */
    readonly postedTaskDigests?: readonly string[];
    /** Default false: an already-posted entry is dropped, not merely deprioritized. */
    readonly repostPosted?: boolean;
    /** Opt-in standing approval. The plan still renders and still logs its terms and escrow. */
    readonly autoPost?: boolean;
  }

  export interface PostingPlanEntry {
    readonly taskDigest: `sha256:${string}`;
    readonly deadline: string;
    readonly closeAt?: string;
    readonly maxClaims: number;
    readonly escrowValueWei: bigint;
    /** True when this digest appears in `postedTaskDigests` and reposting was allowed. */
    readonly repost: boolean;
  }

  export interface PostingPlan {
    readonly createdAt: string;
    readonly creatorSafe: `0x${string}`;
    readonly requester: string;
    readonly terms: DefaultPostingTerms;
    readonly approval: "explicit" | "auto";
    readonly entries: readonly PostingPlanEntry[];
    readonly totalEscrowValueWei: bigint;
    readonly skipped: readonly PostingSkip[];
  }
  ```

- [ ] Write `src/order.ts` (the tree bans `localeCompare` for the same reason the marketplace tree
  does):

  ```ts
  // SPDX-License-Identifier: MIT

  /**
   * UTF-16 code-unit ordering. `String.prototype.localeCompare` reads the host locale and the
   * bundled ICU data, so it must never decide a batch's order: two hosts would plan two different
   * batches from the same pool.
   */
  export function compareCodeUnitStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  ```

- [ ] Write `src/plan.test.ts` first:

  ```ts
  import { DEFAULT_POSTING_TERMS, postingEscrowValueWei } from "@jinn-network/marketplace-binding";
  import { describe, expect, test } from "vitest";
  import { planPosting } from "./plan.js";
  import type { PostingPolicy, PostingPoolEntry } from "./types.js";

  function entry(seed: string, overrides: Partial<PostingPoolEntry> = {}): PostingPoolEntry {
    return {
      taskDigest: `sha256:${seed.repeat(64).slice(0, 64)}`,
      taskBytes: new TextEncoder().encode(`task-${seed}`),
      evaluationSpecDigest: `sha256:${seed.repeat(64).slice(0, 63)}e`,
      admissionReceiptDigest: `sha256:${seed.repeat(64).slice(0, 63)}a`,
      evaluationSpecPublic: true,
      ...overrides,
    };
  }

  const POLICY: PostingPolicy = {
    terms: { ...DEFAULT_POSTING_TERMS, maxClaims: 2 },
    creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
    requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
    now: "2026-07-31T00:00:00Z",
    deadlineSeconds: 86_400,
    batchLimit: 2,
  };

  describe("planPosting", () => {
    test("is pure: the same inputs plan the same batch twice", () => {
      const pool = [entry("1"), entry("2"), entry("3")];
      expect(planPosting(pool, POLICY)).toEqual(planPosting(pool, POLICY));
    });

    test("computes per-entry and total escrow from the terms", () => {
      const plan = planPosting([entry("1")], POLICY);
      const expected = postingEscrowValueWei(POLICY.terms);
      expect(plan.entries[0]?.escrowValueWei).toBe(expected);
      expect(plan.entries[0]?.maxClaims).toBe(2);
      expect(plan.totalEscrowValueWei).toBe(expected);
    });

    test("totals across a batch", () => {
      const plan = planPosting([entry("1"), entry("2")], POLICY);
      expect(plan.entries).toHaveLength(2);
      expect(plan.totalEscrowValueWei).toBe(postingEscrowValueWei(POLICY.terms) * 2n);
    });

    test("caps the batch and records the overflow as skipped", () => {
      const plan = planPosting([entry("1"), entry("2"), entry("3")], { ...POLICY, batchLimit: 1 });
      expect(plan.entries).toHaveLength(1);
      expect(plan.skipped).toContainEqual({ taskDigest: entry("2").taskDigest, reason: "batch-limit" });
      expect(plan.skipped).toContainEqual({ taskDigest: entry("3").taskDigest, reason: "batch-limit" });
    });

    test("drops excluded digests before anything else sees them", () => {
      const plan = planPosting([entry("1"), entry("2")], {
        ...POLICY, excludedTaskDigests: [entry("1").taskDigest],
      });
      expect(plan.entries.map((planned) => planned.taskDigest)).toEqual([entry("2").taskDigest]);
      expect(plan.skipped).toContainEqual({ taskDigest: entry("1").taskDigest, reason: "excluded" });
    });

    test("drops already-posted digests by default", () => {
      const plan = planPosting([entry("1"), entry("2")], {
        ...POLICY, postedTaskDigests: [entry("1").taskDigest],
      });
      expect(plan.entries.map((planned) => planned.taskDigest)).toEqual([entry("2").taskDigest]);
      expect(plan.skipped).toContainEqual({ taskDigest: entry("1").taskDigest, reason: "already-posted" });
    });

    test("plans never-posted entries before reposts when reposting is allowed", () => {
      const plan = planPosting([entry("1"), entry("2")], {
        ...POLICY, postedTaskDigests: [entry("1").taskDigest], repostPosted: true, batchLimit: 5,
      });
      expect(plan.entries.map((planned) => planned.taskDigest))
        .toEqual([entry("2").taskDigest, entry("1").taskDigest]);
      expect(plan.entries.map((planned) => planned.repost)).toEqual([false, true]);
    });

    test("refuses a non-public evaluation leg (D5) instead of posting it", () => {
      const plan = planPosting([entry("1", { evaluationSpecPublic: false }), entry("2")], POLICY);
      expect(plan.entries.map((planned) => planned.taskDigest)).toEqual([entry("2").taskDigest]);
      expect(plan.skipped).toContainEqual({
        taskDigest: entry("1").taskDigest, reason: "evaluation-not-public",
      });
    });

    test("pins the deadline (and closeAt) from policy.now, not from a host clock", () => {
      const plan = planPosting([entry("1")], { ...POLICY, closeAtSeconds: 3_600 });
      expect(plan.entries[0]?.deadline).toBe("2026-08-01T00:00:00.000Z");
      expect(plan.entries[0]?.closeAt).toBe("2026-07-31T01:00:00.000Z");
      expect(plan.createdAt).toBe(POLICY.now);
    });

    test("marks the plan auto when the policy pre-approves", () => {
      expect(planPosting([entry("1")], POLICY).approval).toBe("explicit");
      expect(planPosting([entry("1")], { ...POLICY, autoPost: true }).approval).toBe("auto");
    });

    test("rejects an unusable policy rather than planning a batch nobody can pay for", () => {
      expect(() => planPosting([entry("1")], { ...POLICY, batchLimit: 0 })).toThrow(RangeError);
      expect(() => planPosting([entry("1")], { ...POLICY, now: "not-a-time" })).toThrow(/RFC 3339/u);
      expect(() => planPosting([entry("1")], { ...POLICY, deadlineSeconds: 0 })).toThrow(RangeError);
    });
  });
  ```

- [ ] Implement `src/plan.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // Supply policy, and nothing else (design §8, D6: production never posts; posting never derives).
  // Pure by construction: the plan is the replay unit, so every value the sealed Submission depends
  // on -- deadline, closeAt, maxClaims, requester -- is decided here and carried, never read from a
  // host clock at execution time.
  import { postingEscrowValueWei } from "@jinn-network/marketplace-binding";
  import { compareCodeUnitStrings } from "./order.js";
  import type {
    PostingPlan,
    PostingPlanEntry,
    PostingPolicy,
    PostingPoolEntry,
    PostingSkip,
  } from "./types.js";

  function offsetIso(base: string, seconds: number): string {
    const parsed = Date.parse(base);
    if (Number.isNaN(parsed)) {
      throw new Error(`policy.now must be an RFC 3339 timestamp with an offset, got ${base}`);
    }
    return new Date(parsed + seconds * 1_000).toISOString();
  }

  /**
   * Selects and orders the entries this batch posts.
   *
   * @param pool the materialized pool listing (finding F-C5-2: the caller reads `SupplyPool.list()`
   * and passes the result; a pure function cannot await a store).
   */
  export function planPosting(
    pool: readonly PostingPoolEntry[],
    policy: PostingPolicy,
  ): PostingPlan {
    if (!Number.isInteger(policy.batchLimit) || policy.batchLimit < 1) {
      throw new RangeError(`batchLimit must be a positive integer, got ${String(policy.batchLimit)}`);
    }
    if (!Number.isInteger(policy.deadlineSeconds) || policy.deadlineSeconds < 1) {
      throw new RangeError(`deadlineSeconds must be a positive integer, got ${String(policy.deadlineSeconds)}`);
    }
    const deadline = offsetIso(policy.now, policy.deadlineSeconds);
    const closeAt = policy.closeAtSeconds === undefined
      ? undefined
      : offsetIso(policy.now, policy.closeAtSeconds);

    const excluded = new Set(policy.excludedTaskDigests ?? []);
    const posted = new Set(policy.postedTaskDigests ?? []);
    const skipped: PostingSkip[] = [];
    const eligible: { readonly entry: PostingPoolEntry; readonly repost: boolean }[] = [];

    for (const entry of pool) {
      if (excluded.has(entry.taskDigest)) {
        skipped.push({ taskDigest: entry.taskDigest, reason: "excluded" });
        continue;
      }
      if (!entry.evaluationSpecPublic) {
        skipped.push({ taskDigest: entry.taskDigest, reason: "evaluation-not-public" });
        continue;
      }
      const repost = posted.has(entry.taskDigest);
      if (repost && policy.repostPosted !== true) {
        skipped.push({ taskDigest: entry.taskDigest, reason: "already-posted" });
        continue;
      }
      eligible.push({ entry, repost });
    }

    // Never-posted first; within a group, code-unit order by digest so two hosts plan one batch.
    eligible.sort((left, right) => {
      if (left.repost !== right.repost) return left.repost ? 1 : -1;
      return compareCodeUnitStrings(left.entry.taskDigest, right.entry.taskDigest);
    });

    const entries: PostingPlanEntry[] = [];
    for (const candidate of eligible) {
      if (entries.length >= policy.batchLimit) {
        skipped.push({ taskDigest: candidate.entry.taskDigest, reason: "batch-limit" });
        continue;
      }
      entries.push({
        taskDigest: candidate.entry.taskDigest,
        deadline,
        ...(closeAt === undefined ? {} : { closeAt }),
        maxClaims: policy.terms.maxClaims,
        escrowValueWei: postingEscrowValueWei(policy.terms),
        repost: candidate.repost,
      });
    }

    return {
      createdAt: policy.now,
      creatorSafe: policy.creatorSafe,
      requester: policy.requester,
      terms: policy.terms,
      approval: policy.autoPost === true ? "auto" : "explicit",
      entries,
      totalEscrowValueWei: entries.reduce((total, planned) => total + planned.escrowValueWei, 0n),
      skipped,
    };
  }
  ```

- [ ] `cd packages/task-supply/posting && yarn vitest run src/plan.test.ts && yarn typecheck` —
  expected: 11 passing, zero type errors.

- [ ] Commit: `feat(task-supply): add planPosting`

---

## Task B3 — seal the dispatch Submission for a planned entry

The Submission is where three separate rules meet: `attempts.maxTotal` must be explicit (F-C5-1),
the admission-receipt annotation must ride along or the evaluation leg is refused later (F-C5-4),
and every field must be a function of the plan so a replay produces the same broadcast-intent key.

**Files**
- `packages/task-supply/posting/src/dispatch-submission.ts` (new)
- `packages/task-supply/posting/src/dispatch-submission.test.ts` (new)

**Interfaces**
- *Consumes* (`integration/evidence-v1` via `@jinn-network/task-execution-protocol`):
  `TASK_EXECUTION_PROTOCOL_URI`, `sealSubmission`, `sha256Hex`, `SubmissionRecordSchema`;
  (`@jinn-network/marketplace-binding`) `ADMISSION_RECEIPT_ANNOTATION_URI`,
  `assertMaxClaimsAgreement`.
- *Produces:* `buildDispatchSubmission(entry, planEntry, plan): Uint8Array`,
  `POSTING_SUBMISSION_NAMESPACE`.

**Steps**

- [ ] Write `src/dispatch-submission.test.ts` first:

  ```ts
  import { ADMISSION_RECEIPT_ANNOTATION_URI } from "@jinn-network/marketplace-binding";
  import { SubmissionRecordSchema, sha256Hex } from "@jinn-network/task-execution-protocol";
  import { describe, expect, test } from "vitest";
  import { buildDispatchSubmission } from "./dispatch-submission.js";
  import type { PostingPlan, PostingPlanEntry, PostingPoolEntry } from "./types.js";

  const TASK_BYTES = new TextEncoder().encode("sealed-task-bytes");
  const ENTRY: PostingPoolEntry = {
    taskDigest: `sha256:${sha256Hex(TASK_BYTES)}`,
    taskBytes: TASK_BYTES,
    evaluationSpecDigest: `sha256:${"e".repeat(64)}`,
    admissionReceiptDigest: `sha256:${"a".repeat(64)}`,
    admissionReceiptUri: "ipfs://bafyreiadmissionreceipt",
    evaluationSpecPublic: true,
  };
  const PLAN_ENTRY: PostingPlanEntry = {
    taskDigest: ENTRY.taskDigest,
    deadline: "2026-08-01T00:00:00.000Z",
    maxClaims: 2,
    escrowValueWei: 24n,
    repost: false,
  };
  const PLAN = {
    createdAt: "2026-07-31T00:00:00Z",
    creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
    requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
    terms: {
      solutionMaxDeliveryRateWei: 10n,
      verdictMaxDeliveryRateWei: 2n,
      responseTimeoutSeconds: 3_600n,
      allowSolverSelfEvaluation: false,
      maxClaims: 2,
    },
    approval: "explicit",
    entries: [PLAN_ENTRY],
    totalEscrowValueWei: 24n,
    skipped: [],
  } as const satisfies PostingPlan;

  function parse(bytes: Uint8Array) {
    return SubmissionRecordSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }

  describe("buildDispatchSubmission", () => {
    test("binds the sealed Task by digest and names the requester of record", () => {
      const parsed = parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
      expect(parsed.task.digest?.sha256).toBe(sha256Hex(TASK_BYTES));
      expect(parsed.requester).toBe(PLAN.requester);
      expect(parsed.deadline).toBe(PLAN_ENTRY.deadline);
    });

    test("states attempts.maxTotal explicitly so the escrow multiplier is never the fallback", () => {
      expect(parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN)).attempts?.maxTotal).toBe(2);
    });

    test("carries the admission receipt where the evaluation leg looks for it", () => {
      const parsed = parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
      expect(parsed.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI]).toEqual({
        name: "admission-receipt",
        digest: { sha256: "a".repeat(64) },
        uri: "ipfs://bafyreiadmissionreceipt",
      });
    });

    test("never populates capabilityGrants (D5: no private evaluation material in v1)", () => {
      const parsed = parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
      expect(Object.keys(parsed)).not.toContain("capabilityGrants");
      expect(parsed.capabilityGrants).toBeUndefined();
    });

    test("is byte-identical across calls, so a replayed plan reuses one broadcast-intent key", () => {
      expect(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN))
        .toEqual(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
    });

    test("changes bytes when the plan changes, so a new batch is a new key", () => {
      const later = { ...PLAN_ENTRY, deadline: "2026-08-02T00:00:00.000Z" };
      expect(buildDispatchSubmission(ENTRY, later, PLAN))
        .not.toEqual(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN));
    });

    test("refuses a non-public evaluation leg even if the plan let it through", () => {
      expect(() => buildDispatchSubmission({ ...ENTRY, evaluationSpecPublic: false }, PLAN_ENTRY, PLAN))
        .toThrow(/public-specification/u);
    });

    test("refuses an entry whose bytes do not hash to its own digest", () => {
      expect(() => buildDispatchSubmission(
        { ...ENTRY, taskBytes: new TextEncoder().encode("other") }, PLAN_ENTRY, PLAN,
      )).toThrow(/does not hash/u);
    });

    test("refuses a plan entry whose maxClaims disagrees with the plan's terms", () => {
      expect(() => buildDispatchSubmission(ENTRY, { ...PLAN_ENTRY, maxClaims: 3 }, PLAN))
        .toThrow(/disagrees/u);
    });

    test("carries closeAt only when the plan pinned one", () => {
      expect(parse(buildDispatchSubmission(ENTRY, PLAN_ENTRY, PLAN)).closeAt).toBeUndefined();
      const withClose = { ...PLAN_ENTRY, closeAt: "2026-07-31T01:00:00.000Z" };
      expect(parse(buildDispatchSubmission(ENTRY, withClose, PLAN)).closeAt).toBe(withClose.closeAt);
    });
  });
  ```

- [ ] Implement `src/dispatch-submission.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // The dispatch Submission a planned entry posts under. Every field is a function of the plan and
  // the entry -- no clock read, no random identifier -- because the broadcast-intent WAL is keyed on
  // `(creatorSafe, taskCidDigest, submissionDigest)`: a Submission that differed between two runs of
  // one plan would key a second intent and pay for a second post.
  import {
    ADMISSION_RECEIPT_ANNOTATION_URI,
    assertMaxClaimsAgreement,
  } from "@jinn-network/marketplace-binding";
  import {
    TASK_EXECUTION_PROTOCOL_URI,
    sealSubmission,
    sha256Hex,
  } from "@jinn-network/task-execution-protocol";
  import type { PostingPlan, PostingPlanEntry, PostingPoolEntry } from "./types.js";

  /** Namespace for the identifiers derived below; part of the byte-stability contract. */
  export const POSTING_SUBMISSION_NAMESPACE = "jinn:task-posting:submission:v1" as const;

  function bareHex(digest: `sha256:${string}`): string {
    return digest.slice("sha256:".length);
  }

  /** 32 hex characters of a digest, shaped as a URN UUID (§8's `submission` identifier form). */
  function urnUuidFromHex(hex: string): string {
    return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
      + `-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  /**
   * v1 posts public-specification evaluation legs only (design §8, D5). Grant hosting, minting, and
   * redemption are non-goals (§12), so this package has no code path that populates
   * `capabilityGrants` -- and refuses the entry that would need one rather than posting it with the
   * private material silently dropped.
   */
  export function assertPublicSpecEvaluationLeg(entry: PostingPoolEntry): void {
    if (entry.evaluationSpecPublic !== true) {
      throw new Error(
        `${entry.taskDigest} declares a non-public evaluation specification; v1 posts `
          + "public-specification evaluation legs only (design §8, D5)",
      );
    }
  }

  export function buildDispatchSubmission(
    entry: PostingPoolEntry,
    planEntry: PostingPlanEntry,
    plan: PostingPlan,
  ): Uint8Array {
    assertPublicSpecEvaluationLeg(entry);

    const taskHex = sha256Hex(entry.taskBytes);
    if (taskHex !== bareHex(entry.taskDigest)) {
      throw new Error(
        `pool entry ${entry.taskDigest} does not hash to its own bytes (sha256:${taskHex}) `
          + "-- refusing to seal a Submission against a mismatched pair",
      );
    }
    if (planEntry.maxClaims !== plan.terms.maxClaims) {
      throw new Error(
        `plan entry maxClaims (${planEntry.maxClaims}) disagrees with the plan's terms `
          + `(${plan.terms.maxClaims})`,
      );
    }
    assertMaxClaimsAgreement(planEntry.maxClaims, plan.terms.maxClaims);

    const seed = sha256Hex(new TextEncoder().encode(
      `${POSTING_SUBMISSION_NAMESPACE}|${entry.taskDigest}|${plan.requester}|${planEntry.deadline}`
        + `|${planEntry.closeAt ?? ""}|${planEntry.maxClaims}`,
    ));

    return sealSubmission({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      submission: urnUuidFromHex(seed),
      task: { digest: { sha256: taskHex } },
      requester: plan.requester,
      idempotencyKey: `${POSTING_SUBMISSION_NAMESPACE}:${entry.taskDigest}:${planEntry.deadline}`,
      nonce: seed.slice(0, 32),
      deadline: planEntry.deadline,
      ...(planEntry.closeAt === undefined ? {} : { closeAt: planEntry.closeAt }),
      attempts: { maxTotal: planEntry.maxClaims },
      annotations: {
        [ADMISSION_RECEIPT_ANNOTATION_URI]: {
          name: "admission-receipt",
          digest: { sha256: bareHex(entry.admissionReceiptDigest) },
          ...(entry.admissionReceiptUri === undefined ? {} : { uri: entry.admissionReceiptUri }),
        },
      },
    });
  }
  ```

  If `TASK_EXECUTION_PROTOCOL_URI` does not resolve on this base, read the constant's name from
  `packages/task-execution/protocol/src/index.ts` rather than hardcoding the URI string.

- [ ] `yarn vitest run src/dispatch-submission.test.ts && yarn typecheck` — expected: 10 passing,
  zero type errors.

- [ ] Commit: `feat(task-supply): seal the dispatch Submission for a planned post`

---

## Task B4 — `executePosting` (surface, approve, then spend)

**Files**
- `packages/task-supply/posting/src/execute.ts` (new)
- `packages/task-supply/posting/src/execute.test.ts` (new)

**Interfaces**
- *Consumes* (`@jinn-network/marketplace-binding`): `postTask` (as the injected default),
  `PostingPorts`, `PostingTerms`, `PostingOutcome`, `BroadcastUncertainError`,
  `MarketplaceChainConfig`, `assertMaxClaimsAgreement`; (`@jinn-network/task-execution-protocol`)
  `SubmissionRecordSchema`; this package's `buildDispatchSubmission`, `PostingPlan`.
- *Produces* (program §4): `executePosting(deps, plan)` — explicit post by default, auto-post as a
  policy flag with the same visibility in a log line.

**Steps**

- [ ] Write `src/execute.test.ts` first:

  ```ts
  import { BroadcastUncertainError, type PostingPorts } from "@jinn-network/marketplace-binding";
  import { sha256Hex } from "@jinn-network/task-execution-protocol";
  import { describe, expect, test, vi } from "vitest";
  import { executePosting, type PostingDeps, type PostingLogLine } from "./execute.js";
  import { planPosting } from "./plan.js";
  import type { PostingPolicy, PostingPoolEntry } from "./types.js";

  const CHAIN = { chainId: 84532, taskCoordinator: "0x01", jinnRouter: "0x02", mechMarketplace: "0x03", activityChecker: "0x04", generation: "today" } as never;

  function entry(seed: string): PostingPoolEntry {
    const taskBytes = new TextEncoder().encode(`task-${seed}`);
    return {
      taskDigest: `sha256:${sha256Hex(taskBytes)}`,
      taskBytes,
      evaluationSpecDigest: `sha256:${seed.repeat(64).slice(0, 63)}e`,
      admissionReceiptDigest: `sha256:${seed.repeat(64).slice(0, 63)}a`,
      evaluationSpecPublic: true,
    };
  }

  const POLICY: PostingPolicy = {
    terms: {
      solutionMaxDeliveryRateWei: 10n, verdictMaxDeliveryRateWei: 2n,
      responseTimeoutSeconds: 3_600n, allowSolverSelfEvaluation: false, maxClaims: 1,
    },
    creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
    requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
    now: "2026-07-31T00:00:00Z",
    deadlineSeconds: 86_400,
    batchLimit: 5,
  };

  function deps(overrides: Partial<PostingDeps> = {}, pool: readonly PostingPoolEntry[] = []) {
    const lines: PostingLogLine[] = [];
    const postTask = vi.fn(async () => ({ taskId: 1n, txHash: `0x${"ab".repeat(32)}` as const }));
    const base: PostingDeps = {
      entries: new Map(pool.map((item) => [item.taskDigest, item])),
      chain: CHAIN,
      ports: {} as PostingPorts,
      postTask,
      render: { renderPlan: vi.fn() },
      approval: { approvePlan: vi.fn(async () => ({ approved: true as const })) },
      log: { record: (line) => lines.push(line) },
      ...overrides,
    };
    return { deps: base, lines, postTask };
  }

  describe("executePosting", () => {
    test("surfaces the plan before anything is spent, then posts once approved", async () => {
      const pool = [entry("1")];
      const plan = planPosting(pool, POLICY);
      const { deps: d, postTask } = deps({}, pool);

      const summary = await executePosting(d, plan);

      expect(d.render.renderPlan).toHaveBeenCalledWith(plan);
      expect(d.approval.approvePlan).toHaveBeenCalledTimes(1);
      expect(postTask).toHaveBeenCalledTimes(1);
      expect(summary.posted).toEqual([{ taskDigest: pool[0]!.taskDigest, taskId: 1n, txHash: `0x${"ab".repeat(32)}` }]);
      expect(summary.spentEscrowValueWei).toBe(plan.totalEscrowValueWei);
    });

    test("renders the plan before asking for approval, and asks before posting", async () => {
      const pool = [entry("1")];
      const order: string[] = [];
      const { deps: d } = deps({
        render: { renderPlan: () => { order.push("render"); } },
        approval: { approvePlan: async () => { order.push("approve"); return { approved: true }; } },
        postTask: vi.fn(async () => { order.push("post"); return { taskId: 1n, txHash: `0x${"ab".repeat(32)}` as const }; }),
      }, pool);

      await executePosting(d, planPosting(pool, POLICY));
      expect(order).toEqual(["render", "approve", "post"]);
    });

    test("spends nothing when approval is withheld", async () => {
      const pool = [entry("1")];
      const { deps: d, postTask, lines } = deps({
        approval: { approvePlan: async () => ({ approved: false, reason: "escrow too high today" }) },
      }, pool);

      const summary = await executePosting(d, planPosting(pool, POLICY));

      expect(postTask).not.toHaveBeenCalled();
      expect(summary.refused).toBe("escrow too high today");
      expect(summary.spentEscrowValueWei).toBe(0n);
      expect(lines.map((line) => line.event)).toContain("posting.refused");
    });

    test("auto-post skips the approval call but logs the same terms and escrow", async () => {
      const pool = [entry("1")];
      const explicitRun = deps({}, pool);
      await executePosting(explicitRun.deps, planPosting(pool, POLICY));
      const autoRun = deps({}, pool);
      await executePosting(autoRun.deps, planPosting(pool, { ...POLICY, autoPost: true }));

      expect(autoRun.deps.approval.approvePlan).not.toHaveBeenCalled();
      const explicitFields = explicitRun.lines.find((line) => line.event === "posting.approved")?.fields;
      const autoFields = autoRun.lines.find((line) => line.event === "posting.auto-approved")?.fields;
      expect(autoFields).toEqual(explicitFields);
      expect(autoFields).toMatchObject({
        entries: "1",
        totalEscrowValueWei: String(planPosting(pool, POLICY).totalEscrowValueWei),
        solutionMaxDeliveryRateWei: "10",
        verdictMaxDeliveryRateWei: "2",
        maxClaims: "1",
      });
    });

    test("passes the plan's terms, chain, creator, and ports straight through to postTask", async () => {
      const pool = [entry("1")];
      const { deps: d, postTask } = deps({}, pool);
      const plan = planPosting(pool, POLICY);

      await executePosting(d, plan);

      const call = postTask.mock.calls[0]!;
      expect(call[0]).toEqual(pool[0]!.taskBytes);
      expect(call[2]).toBe(plan.terms);
      expect(call[3]).toBe(CHAIN);
      expect(call[4]).toBe(plan.creatorSafe);
      expect(call[5]).toBe(d.ports);
    });

    test("records an uncertain broadcast and keeps going with the rest of the batch", async () => {
      const pool = [entry("1"), entry("2")];
      const postTask = vi.fn()
        .mockRejectedValueOnce(new BroadcastUncertainError({
          creatorSafe: POLICY.creatorSafe,
          taskCidDigest: pool[0]!.taskDigest,
          submissionDigest: `sha256:${"c".repeat(64)}`,
          idempotencyKey: "k", createdAt: POLICY.now,
        }))
        .mockResolvedValueOnce({ taskId: 5n, txHash: `0x${"ef".repeat(32)}` });
      const { deps: d, lines } = deps({ postTask }, pool);

      const summary = await executePosting(d, planPosting(pool, POLICY));

      expect(summary.uncertain).toHaveLength(1);
      expect(summary.posted).toHaveLength(1);
      expect(lines.map((line) => line.event)).toContain("posting.uncertain");
      expect(summary.spentEscrowValueWei).toBe(planPosting(pool, POLICY).entries[0]!.escrowValueWei);
    });

    test("stops on an error that is not an uncertain broadcast", async () => {
      const pool = [entry("1"), entry("2")];
      const postTask = vi.fn().mockRejectedValue(new Error("insufficient funds"));
      const { deps: d } = deps({ postTask }, pool);
      await expect(executePosting(d, planPosting(pool, POLICY))).rejects.toThrow(/insufficient funds/u);
    });

    test("refuses a plan whose entry is not in the supplied pool", async () => {
      const pool = [entry("1")];
      const { deps: d } = deps({ entries: new Map() }, pool);
      await expect(executePosting(d, planPosting(pool, POLICY))).rejects.toThrow(/not in the supplied pool/u);
    });

    test("an empty plan spends nothing and still surfaces itself", async () => {
      const { deps: d, postTask, lines } = deps({}, []);
      const summary = await executePosting(d, planPosting([], POLICY));
      expect(postTask).not.toHaveBeenCalled();
      expect(summary.spentEscrowValueWei).toBe(0n);
      expect(lines.map((line) => line.event)).toContain("posting.plan-surfaced");
    });
  });
  ```

- [ ] Implement `src/execute.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // Explicit post is the default (design §8): the plan -- terms and the computed escrow total -- is
  // surfaced before a wei is spent, and an approval decision is required. Auto-post is an opt-in
  // standing policy flag that pre-approves with THE SAME fields in a log line, so a standing policy
  // is never quieter than a hand-approved one (visible-money-actions).
  //
  // Everything that touches the chain is injected. `postTask` is a parameter, not an import edge in
  // disguise: it is the marketplace binding's today, the work client's at its mint (README, F7).
  import {
    BroadcastUncertainError,
    type MarketplaceChainConfig,
    type PostingOutcome,
    type PostingPorts,
    type PostingTerms,
  } from "@jinn-network/marketplace-binding";
  import { buildDispatchSubmission } from "./dispatch-submission.js";
  import type { PostingPlan, PostingPoolEntry } from "./types.js";

  /** The posting core's shape. Swapped, not wrapped, when the work client mints (F7). */
  export type PostTaskFn = (
    taskBytes: Uint8Array,
    submissionBytes: Uint8Array,
    terms: PostingTerms,
    config: MarketplaceChainConfig,
    creatorSafe: `0x${string}`,
    ports: PostingPorts,
  ) => Promise<PostingOutcome>;

  /** Shows the operator what is about to be spent. Rendering is the host's job, not this package's. */
  export interface PostingRenderPort {
    renderPlan(plan: PostingPlan): void | Promise<void>;
  }

  export type PostingApproval =
    | { readonly approved: true }
    | { readonly approved: false; readonly reason: string };

  export interface PostingApprovalPort {
    approvePlan(plan: PostingPlan): Promise<PostingApproval>;
  }

  export interface PostingLogLine {
    readonly event:
      | "posting.plan-surfaced"
      | "posting.auto-approved"
      | "posting.approved"
      | "posting.refused"
      | "posting.posted"
      | "posting.uncertain";
    readonly fields: Readonly<Record<string, string>>;
  }

  /** Structured sink; this package never writes to an ambient console. */
  export interface PostingLogPort {
    record(line: PostingLogLine): void;
  }

  export interface PostingDeps {
    /** Task digest -> pool entry. The plan carries digests; the bytes are read here. */
    readonly entries: ReadonlyMap<string, PostingPoolEntry>;
    readonly chain: MarketplaceChainConfig;
    readonly ports: PostingPorts;
    readonly postTask: PostTaskFn;
    readonly render: PostingRenderPort;
    readonly approval: PostingApprovalPort;
    readonly log: PostingLogPort;
  }

  export interface PostingRunSummary {
    readonly posted: readonly {
      readonly taskDigest: `sha256:${string}`;
      readonly taskId: bigint;
      readonly txHash: `0x${string}`;
    }[];
    readonly uncertain: readonly { readonly taskDigest: `sha256:${string}`; readonly detail: string }[];
    /** Set only when approval was withheld; the batch then spent nothing. */
    readonly refused?: string;
    readonly spentEscrowValueWei: bigint;
  }

  export class PostingRefusedError extends Error {
    constructor(readonly reason: string, message: string) {
      super(message);
      this.name = "PostingRefusedError";
    }
  }

  /** The money fields, identical for the explicit and the auto path. */
  function planFields(plan: PostingPlan): Record<string, string> {
    return {
      createdAt: plan.createdAt,
      creatorSafe: plan.creatorSafe,
      requester: plan.requester,
      entries: String(plan.entries.length),
      totalEscrowValueWei: String(plan.totalEscrowValueWei),
      solutionMaxDeliveryRateWei: String(plan.terms.solutionMaxDeliveryRateWei),
      verdictMaxDeliveryRateWei: String(plan.terms.verdictMaxDeliveryRateWei),
      responseTimeoutSeconds: String(plan.terms.responseTimeoutSeconds),
      maxClaims: String(plan.terms.maxClaims),
      allowSolverSelfEvaluation: String(plan.terms.allowSolverSelfEvaluation),
    };
  }

  export async function executePosting(
    deps: PostingDeps,
    plan: PostingPlan,
  ): Promise<PostingRunSummary> {
    await deps.render.renderPlan(plan);
    deps.log.record({ event: "posting.plan-surfaced", fields: planFields(plan) });

    if (plan.approval === "auto") {
      deps.log.record({ event: "posting.auto-approved", fields: planFields(plan) });
    } else {
      const decision = await deps.approval.approvePlan(plan);
      if (!decision.approved) {
        deps.log.record({
          event: "posting.refused",
          fields: { ...planFields(plan), reason: decision.reason },
        });
        return { posted: [], uncertain: [], refused: decision.reason, spentEscrowValueWei: 0n };
      }
      deps.log.record({ event: "posting.approved", fields: planFields(plan) });
    }

    const posted: { taskDigest: `sha256:${string}`; taskId: bigint; txHash: `0x${string}` }[] = [];
    const uncertain: { taskDigest: `sha256:${string}`; detail: string }[] = [];
    let spentEscrowValueWei = 0n;

    for (const planEntry of plan.entries) {
      const entry = deps.entries.get(planEntry.taskDigest);
      if (entry === undefined) {
        throw new PostingRefusedError(
          "pool-entry-missing",
          `planned entry ${planEntry.taskDigest} is not in the supplied pool -- refusing to post a `
            + "batch whose bytes cannot be read",
        );
      }
      const submissionBytes = buildDispatchSubmission(entry, planEntry, plan);

      let outcome: PostingOutcome;
      try {
        // eslint-disable-next-line no-await-in-loop -- posts are sequential: one requester, one
        // nonce sequence, and one escrow balance draining as the batch proceeds.
        outcome = await deps.postTask(
          entry.taskBytes,
          submissionBytes,
          plan.terms,
          deps.chain,
          plan.creatorSafe,
          deps.ports,
        );
      } catch (error) {
        if (error instanceof BroadcastUncertainError) {
          // Never retried here: an uncertain broadcast is resolved by `recoverPostingIntents`
          // against the chain, not by posting again.
          uncertain.push({ taskDigest: planEntry.taskDigest, detail: error.message });
          deps.log.record({
            event: "posting.uncertain",
            fields: { taskDigest: planEntry.taskDigest, detail: error.message },
          });
          continue;
        }
        throw error;
      }

      posted.push({ taskDigest: planEntry.taskDigest, taskId: outcome.taskId, txHash: outcome.txHash });
      spentEscrowValueWei += planEntry.escrowValueWei;
      deps.log.record({
        event: "posting.posted",
        fields: {
          taskDigest: planEntry.taskDigest,
          taskId: String(outcome.taskId),
          txHash: outcome.txHash,
          escrowValueWei: String(planEntry.escrowValueWei),
        },
      });
    }

    return { posted, uncertain, spentEscrowValueWei };
  }
  ```

- [ ] `yarn vitest run src/execute.test.ts && yarn typecheck` — expected: 9 passing, zero type
  errors.

- [ ] Commit: `feat(task-supply): add executePosting with explicit approval`

---

## Task B5 — wire the public surface and verify half B end to end

**Files**
- `packages/task-supply/posting/src/index.ts` (fill in the surface deferred at B1)
- `packages/task-supply/posting/src/pool-shape.test.ts` (new)

**Interfaces**
- *Consumes* (`supply/c4-task-derivation`): `SupplyPool` from `@jinn-network/task-derivation`
  (`import type` only, F-C5-5).
- *Produces:* the package's public surface, and the compile-time evidence that a C4 pool listing
  satisfies `PostingPoolEntry`.

**Steps**

- [ ] Fill `src/index.ts` with the export block written at B1.

- [ ] Write `src/pool-shape.test.ts` — the one place this package names C4's contract, and the
  reason F-C5-4/F-C5-5 are checkable rather than assumed:

  ```ts
  import type { SupplyPool } from "@jinn-network/task-derivation";
  import { describe, expect, test } from "vitest";
  import { planPosting } from "./index.js";
  import type { PostingPoolEntry } from "./types.js";

  // A C4 pool listing element must satisfy PostingPoolEntry structurally. If this stops compiling,
  // the pool contract moved: stop and report to the program (contract 11), do not widen the type
  // here.
  type PoolListing = Awaited<ReturnType<SupplyPool["list"]>>;
  type PoolEntry = PoolListing[number];
  const _entryIsPostable: (entry: PoolEntry) => PostingPoolEntry = (entry) => entry;

  describe("pool shape", () => {
    test("a C4 listing plans without adaptation", () => {
      const listing: readonly PostingPoolEntry[] = [];
      expect(planPosting(listing, {
        terms: {
          solutionMaxDeliveryRateWei: 1n, verdictMaxDeliveryRateWei: 1n,
          responseTimeoutSeconds: 60n, allowSolverSelfEvaluation: false, maxClaims: 1,
        },
        creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
        requester: "urn:uuid:11111111-2222-3333-4444-555555555555",
        now: "2026-07-31T00:00:00Z",
        deadlineSeconds: 60,
        batchLimit: 1,
      }).entries).toEqual([]);
    });
  });
  ```

  If `_entryIsPostable` does not compile because C4's entry lacks `admissionReceiptDigest`,
  `evaluationSpecPublic`, or the sealed task bytes, **stop and report** citing F-C5-4 — that is the
  contract-11 case, not a signal to loosen `PostingPoolEntry`.

- [ ] Run the full half-B verification from the worktree root and show the output:

  ```bash
  node --test .github/scripts/task-supply-package-inventory.test.mjs
  node --test .github/scripts/task-supply-source-boundaries.test.mjs
  (cd packages/task-supply/posting && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke)
  node .github/scripts/task-supply-packed-types.test.mjs
  ```

  Expected: guards pass (posting registered, no forbidden import, `task-derivation` reached by
  `import type` only, exports exactly `["."]`); 31 tests green across the four suites; `dist/`
  builds; the packed consumer compiles against `planPosting` / `executePosting`.

- [ ] Confirm the residual is on the record: `grep -n "F7" packages/task-supply/posting/README.md`
  must show the named-residual paragraph written at B1, with the adoption sentence intact.

- [ ] Push and open the PR against `supply/c4-task-derivation`, titled
  `feat(task-supply): the posting application (supply policy, explicit post)`. Body links spec §8,
  names F7 and its adoption disposition, and lists the F-C5 findings this plan carries.

- [ ] Out of scope, do not add here: the tier-4 pipeline composition (which reads
  `SupplyPool.list()`, builds the ports from the D7 adapters, and runs the loop) is the thin ops
  note the program defers to after C5-app lands (program §8).

- [ ] Commit: `test(task-supply): pin the pool shape the posting application consumes`

---

## Self-review

Run before reporting either half done.

**Spec §8 coverage.** Every clause has an owner:

| §8 clause | Where |
| --- | --- |
| Supply policy only; not a wrapper | B2 `planPosting`, B4 `executePosting`; mechanics stay behind `PostTaskFn` |
| Consumes the work client at its mint; interim direct-binding composition | B1 README (F7, design wording), B4's injected `postTask` seam |
| Poster's key is the requester of record | A2 account check, B2 `policy.requester`/`creatorSafe`, B3 `requester` field |
| Explicit post default: terms + computed escrow surfaced before spending | B4 render → approve → post ordering test |
| Auto-post opt-in with the same visibility in logs | B4 `planFields` identity test across both paths |
| D7: EOA broadcast port | A2 |
| D7: durable intent store honoring claim/fence/resolve | A3 |
| D7: `ScanForOnChainMatch` on taskCidDigest + creator | A4 |
| D7: exported `DEFAULT_POSTING_TERMS` | A1 |
| Evaluation leg is public-spec; `capabilityGrants` never populated | B2 skip reason, B3 `assertPublicSpecEvaluationLeg` + the no-grants test |
| Economics honesty: explicit `maxClaims`, documented escrow formula | A1 (`postingEscrowValueWei`, `assertMaxClaimsAgreement`), B3 `attempts.maxTotal` |
| Escrow-drain residual named, not solved | A1 doc comment |
| F2 filed on the binding's record | A5 README section |

**WAL-semantics fidelity.** Check the file store against `createInMemoryPostingIntentStore`
line by line, not by eye on the tests alone:

- `claim` — creates ownership atomically (O_EXCL, no read-then-write window); returns `resolved`
  with the stored outcome when the record is resolved; returns `pending-other` carrying the stored
  intent (not the caller's) when it is not; the returned `pending-other.intent` has no `ownerToken`
  and no `resolved` key.
- `fence` — true only when the record exists, is unresolved, and the token matches; false (never a
  throw) otherwise, including for an unknown key.
- `resolve` — throws "never claimed" for a missing record, "only the posting intent owner token may
  resolve" for a token mismatch, is a no-op for the identical outcome, throws "already resolved to a
  different outcome" for a divergent one; writes through a temp file plus `rename`.
- `lookup` — strips `ownerToken`; returns `undefined` for a missing key.
- `scanPending` — returns unresolved records **with** their tokens, in a fixed order, so
  `recoverPostingIntents` can resolve what it adopts.
- Crash points — after `open(wx)` and before the write (zero-length record: taken over, safe because
  no broadcast can precede a returned claim); after the write and before broadcast (visible to
  `scanPending` with its token); after broadcast and before `resolve` (the recovery scan adopts the
  on-chain match). All three are covered by a test.
- `taskId` survives the JSON round trip as a `bigint` (decimal string on disk), asserted with a
  value above 2^53.

**Placeholder scan.** From each worktree root:

```bash
grep -rniE "TODO|FIXME|XXX|placeholder|not implemented|throw new Error\(\"unimplemented" \
  packages/marketplace/binding/src packages/task-supply/posting/src
grep -rniE "deterministic|verified" packages/task-supply/posting/src packages/task-supply/posting/README.md \
  packages/marketplace/binding/src/posting-defaults.ts packages/marketplace/binding/src/venue/eoa-broadcast.ts \
  packages/marketplace/binding/src/venue/task-created-scan.ts packages/marketplace/binding/src/posting-intent-file-store.ts
```

Expected: both empty. The second is contract 8 — those two words are not available to this program
without the K/controls or trust-policy qualification the spec attaches to them.

**Signature consistency with program §4 "C5 produces".** Confirm by name, not by memory:

```bash
grep -n "createEoaBroadcastPort\|createFilePostingIntentStore\|scanForOnChainMatch\|DEFAULT_POSTING_TERMS" \
  packages/marketplace/binding/src/index.ts
grep -n "planPosting\|executePosting" packages/task-supply/posting/src/index.ts
```

Expected: `createEoaBroadcastPort(publicClient, walletClient)`,
`createFilePostingIntentStore(dir)`, `scanForOnChainMatch(publicClient, config)`,
`DEFAULT_POSTING_TERMS` with an explicit `maxClaims`; `planPosting(pool, policy): PostingPlan`
(pure — no `async`, no `await` in its body) and `executePosting(deps, plan)`. Any drift from these
names is a program-plan amendment, not a local rename (program §4).

**Findings.** The dated Findings section (2026-07-31, F-C5-1 … F-C5-6) sits above the tasks. Each
disposition is implemented where the finding says it is; a reviewer rejecting a disposition stops
the affected task rather than reshaping it mid-flight (contract 1).
