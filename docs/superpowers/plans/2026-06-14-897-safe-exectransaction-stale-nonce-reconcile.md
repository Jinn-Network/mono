# Safe execTransaction stale-nonce reconcile-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Safe `execTransaction` retry loop hits "nonce too low" or "replacement underpriced", reconcile against the already-submitted tx (fetch its receipt, mark delivered if it mined) before refreshing the nonce and re-signing — so a mid-retry mine of the original delivery is detected instead of looping 5× on a stale nonce and ultimately reverting as already-claimed.

**Architecture:** Confine the change to `executeSafeTransactionInner`'s `catch (writeErr)` block in `client/src/adapters/mech/safe.ts`. `tx-retry.ts` gains one tiny exported predicate, `isReplacementUnderpricedError`, mirroring the existing `isNonceTooLowError`, so the catch block and `isRecoverableTransactionError` share one definition. The catch block: (1) when nonce-too-low OR replacement-underpriced, look up the ledger entry for the currently pinned nonce; if it has a `hash`, fetch that receipt and — if `status === 'success'` — mark resolved and return the hash to short-circuit the retry loop (AC1); (2) when replacement-underpriced, refresh the pinned nonce before rethrowing so the next attempt bumps fees against the fresh nonce (AC2). Reconciliation MUST precede re-signing because Safe-level delivery is NOT idempotent — re-signing at the advanced Safe nonce re-attempts the delivery and reverts as already-claimed (a permanent `SafeInnerRevertError` → FAILED), which is the bug.

**Tech Stack:** TypeScript, viem, vitest. All commands run from `client/`.

---

## Context the implementer needs

**The bug (issue #897).** `executeSafeTransactionInner` (`client/src/adapters/mech/safe.ts:73-216`) submits a Safe `execTransaction` via `walletClient.writeContract({ ..., nonce: nonceLedger.nonce })` inside `withRecoverableRetry`. The EOA tx can land in the mempool, then the next attempt's `eth_sendRawTransaction` returns "nonce too low" (the original already mined at nonce N) or "replacement underpriced" (the original is still pending at nonce N and the bumped fee was insufficient). Today the catch block (lines 153-177) only handles `isNonceTooLowError` by calling `refreshNonce()` and rethrowing — it never checks whether the original tx already delivered. The retry then re-signs a NEW Safe execTransaction at the advanced Safe nonce, which reverts as already-claimed → permanent `SafeInnerRevertError` → task FAILED, even though the delivery actually succeeded.

**Key symbols (verified present in the worktree):**
- `client/src/adapters/mech/safe.ts`
  - `executeSafeTransactionInner` — lines 73-216. The `catch (writeErr)` block is lines 153-177.
  - Current catch logic: `if (isNonceTooLowError(writeErr)) { await nonceLedger.refreshNonce(); ... }` then GS013/GS026 decode, then `throw writeErr`.
  - `nonceLedger` is the `NonceLedgerContext` bound by `withNonceLedger`.
- `client/src/tx-retry.ts`
  - `isNonceTooLowError(error: unknown): boolean` — line 218. Returns `flattenErrorMessage(error).toLowerCase().includes('nonce too low')`.
  - `isRecoverableTransactionError` — lines 50-208. The replacement-underpriced strings it already matches (lines 140-148): `'replacement transaction underpriced'`, `'replacement fee too low'`, `'transaction underpriced'` (plus `'fee cap less than block base fee'`, `'max fee per gas less than block base fee'`). The new predicate must reuse the SAME substrings the recoverable check uses for replacement (the three underpriced/replacement strings); do NOT fold the base-fee strings into the replacement predicate.
  - `NonceLedgerContext` interface — lines 340-357. Exposes: `ledger: TxSubmissionLedger`, `chainId: number`, `from: Address`, `nonce: number`, `feeResultForAttempt(...)`, `recordSubmitted(...)`, `markResolved(resolvedAtMs?: number): Promise<void>`, `refreshNonce(): Promise<number>`.
  - `TxSubmissionLedger.getTxSubmission(key: TxSubmissionKey): MaybePromise<TxSubmissionLedgerEntry | null>` — line 325. `TxSubmissionKey = { chainId, from, nonce }` (line 305). `TxSubmissionLedgerEntry` includes optional `hash?: Hex` (line 312).
  - `createMemoryTxSubmissionLedger()` — line 426. In-memory ledger; `recordTxSubmission(entry)` keys by `${chainId}:${from.toLowerCase()}:${nonce}`.
- viem: `publicClient.getTransactionReceipt({ hash })` resolves a `TransactionReceipt` (with `status: 'success' | 'reverted'`) when mined, and **throws** when the tx is not yet mined (`TransactionReceiptNotFoundError`). The catch block wraps this call in its own try/catch and treats any throw as "not yet mined → fall through".

**Test file (verified):** `client/test/adapters/mech/safe.test.ts`. The existing `describe('executeSafeTransaction nonce refresh', ...)` block (lines 43-98) is the template:
- It builds a hand-rolled `publicClient` object literal with `vi.fn()` members (`getChainId`, `getTransactionCount`, `readContract`, `estimateFeesPerGas`, `getGasPrice`, `waitForTransactionReceipt`) cast `as never`.
- It builds a hand-rolled `walletClient` literal (`account: { address }`, `chain: baseSepolia`, `signMessage`, `writeContract`) cast `as never`.
- It passes a seeded `{ ledger: createMemoryTxSubmissionLedger() }` as options.
- `readContract` mock returns `0n` for `functionName === 'nonce'` and `TEST_SAFE_TX_HASH` for `'getTransactionHash'`.
- Success path needs `waitForTransactionReceipt` → `{ status: 'success' }`.

**Note for AC3 test:** the existing mock `publicClient` does NOT provide `getTransactionReceipt`. The reconcile path the implementer adds calls `publicClient.getTransactionReceipt({ hash })`, so the AC3 test MUST add a `getTransactionReceipt` mock to the `publicClient` literal. To make the receipt lookup deterministic, the AC3 test pre-populates the ledger via `ledger.recordTxSubmission(...)` BEFORE calling `executeSafeTransaction`, so the entry for the pinned nonce already carries the original `hash`.

---

## File Structure

- **Modify** `client/src/tx-retry.ts` — add and export `isReplacementUnderpricedError` next to `isNonceTooLowError`.
- **Modify** `client/src/adapters/mech/safe.ts` — import the new predicate; rewrite the `catch (writeErr)` block to reconcile-first then refresh.
- **Modify** `client/test/adapters/mech/safe.test.ts` — add the AC3 regression test (and an AC2 nonce-refresh-on-replacement-underpriced assertion).

---

## Task 1: Regression test — reconcile when the original mines mid-retry (AC3, AC1)

**Files:**
- Test: `client/test/adapters/mech/safe.test.ts` (append a new `describe` block after line 98)

This task is written FIRST (fix shape → regression test before the fix). The test will FAIL on the current code because today's catch block re-signs at the advanced nonce instead of reconciling, so `writeContract` is called twice and the receipt-success short-circuit never happens.

- [ ] **Step 1: Write the failing regression test**

Append this block to `client/test/adapters/mech/safe.test.ts` (after the existing `describe('executeSafeTransaction nonce refresh', ...)` block, i.e. after line 98). It reuses the constants already declared at the top of the file (`TEST_PRIVATE_KEY`, `TEST_SIGNER_ADDRESS`, `TEST_SAFE_ADDRESS`, `TEST_TARGET_ADDRESS`, `TEST_CALL_DATA`, `TEST_SAFE_TX_HASH`, `TEST_SAFE_SIGNATURE`, `TEST_SUCCESS_HASH`).

```typescript
describe('executeSafeTransaction reconcile-first (issue #897)', () => {
  const ORIGINAL_HASH = `0x${'11'.repeat(32)}` as Hex;
  const CHAIN_ID = baseSepolia.id;
  const PINNED_NONCE = 2301;

  it('reconciles to the mined original tx on replacement-underpriced instead of re-signing (AC3)', async () => {
    // Seed the ledger so the entry for the pinned nonce already carries the
    // hash of the original delivery tx submitted on a prior attempt.
    const ledger = createMemoryTxSubmissionLedger();
    await ledger.recordTxSubmission({
      chainId: CHAIN_ID,
      from: TEST_SIGNER_ADDRESS,
      nonce: PINNED_NONCE,
      hash: ORIGINAL_HASH,
      logicalTx: 'safe.execTransaction',
      submittedAtMs: Date.now(),
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
      to: TEST_SAFE_ADDRESS,
      value: 0n,
      data: TEST_CALL_DATA,
    });

    // Attempt 0 (the bump) fails replacement-underpriced; the original tx
    // mined mid-bump. The loop must reconcile, NOT re-sign.
    const writeContract = vi
      .fn()
      .mockRejectedValue(new Error('replacement transaction underpriced'));
    const signMessage = vi.fn().mockResolvedValue(TEST_SAFE_SIGNATURE);
    // The original tx is now mined and successful.
    const getTransactionReceipt = vi.fn(async (args: { hash: Hex }) => {
      if (args.hash === ORIGINAL_HASH) return { status: 'success' };
      throw new Error(`unexpected getTransactionReceipt: ${args.hash}`);
    });
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const readContract = vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'nonce') return 0n;
      if (args.functionName === 'getTransactionHash') return TEST_SAFE_TX_HASH;
      throw new Error(`unexpected readContract call: ${args.functionName}`);
    });
    const estimateFeesPerGas = vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    const getGasPrice = vi.fn();
    const getChainId = vi.fn().mockResolvedValue(CHAIN_ID);
    const getTransactionCount = vi.fn(async (args: { blockTag?: string }) => {
      if (args.blockTag === 'latest') return PINNED_NONCE;
      return PINNED_NONCE;
    });

    const hash = await executeSafeTransaction(
      {
        getChainId,
        getTransactionCount,
        readContract,
        estimateFeesPerGas,
        getGasPrice,
        getTransactionReceipt,
        waitForTransactionReceipt,
      } as never,
      {
        account: { address: TEST_SIGNER_ADDRESS },
        chain: baseSepolia,
        signMessage,
        writeContract,
      } as never,
      {
        safeAddress: TEST_SAFE_ADDRESS,
        to: TEST_TARGET_ADDRESS,
        value: 0n,
        data: TEST_CALL_DATA,
      },
      { ledger },
    );

    // Reconciled to the original tx — returned its hash, did NOT loop 5×.
    expect(hash).toBe(ORIGINAL_HASH);
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: ORIGINAL_HASH });
    // Exactly one write attempt happened (the one that failed underpriced);
    // the loop did not re-sign a fresh execTransaction at the advanced nonce.
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `yarn test test/adapters/mech/safe.test.ts -t "reconciles to the mined original"`
Expected: FAIL. On current code the catch block does not check the ledger receipt, so it rethrows the underpriced error; `withRecoverableRetry` retries, `writeContract` is called more than once, and `hash` is never `ORIGINAL_HASH`. (The exact failure may be an assertion mismatch on `writeContract` call count or `hash`, or an unexpected-call throw — any FAIL is acceptable here; we just need red before green.)

- [ ] **Step 3: Commit the failing test**

```bash
git add client/test/adapters/mech/safe.test.ts
git commit -m "test(safe): regression for #897 stale-nonce reconcile on replacement-underpriced"
```

---

## Task 2: Export `isReplacementUnderpricedError` predicate from tx-retry

**Files:**
- Modify: `client/src/tx-retry.ts` (add the predicate immediately after `isNonceTooLowError`, around line 220)

- [ ] **Step 1: Add the exported predicate**

Insert this directly AFTER the `isNonceTooLowError` function (which ends at line 220 with its closing brace):

```typescript
/**
 * True when the RPC rejected an `eth_sendRawTransaction` because a tx already
 * occupies the target nonce and the resubmission's fee bump was insufficient to
 * replace it ("replacement underpriced"). Distinct from `nonce too low`: the
 * original tx is still PENDING at this nonce, not yet mined.
 *
 * Issue #897: the Safe execTransaction retry uses this to refresh the pinned
 * nonce before the next fee bump and to trigger a reconcile against the
 * pending original tx (it may mine mid-retry). The substrings mirror the
 * replacement branch of `isRecoverableTransactionError`.
 */
export function isReplacementUnderpricedError(error: unknown): boolean {
  const lower = flattenErrorMessage(error).toLowerCase();
  return (
    lower.includes('replacement transaction underpriced') ||
    lower.includes('replacement fee too low') ||
    lower.includes('transaction underpriced')
  );
}
```

- [ ] **Step 2: Refactor `isRecoverableTransactionError` to reuse the predicate (DRY)**

In `isRecoverableTransactionError`, replace the three replacement/underpriced substring checks (currently lines 141, 142, 145 inside the `if (...)` at lines 140-148) with a call to the new predicate, leaving the two base-fee checks in place. Change the block from:

```typescript
  if (
    lower.includes('replacement transaction underpriced') ||
    lower.includes('replacement fee too low') ||
    lower.includes('fee cap less than block base fee') ||
    lower.includes('max fee per gas less than block base fee') ||
    lower.includes('transaction underpriced')
  ) {
    return true;
  }
```

to:

```typescript
  if (
    isReplacementUnderpricedError(error) ||
    lower.includes('fee cap less than block base fee') ||
    lower.includes('max fee per gas less than block base fee')
  ) {
    return true;
  }
```

(`isReplacementUnderpricedError` is defined later in the same module; function declarations are hoisted, so this forward reference is valid TypeScript.)

- [ ] **Step 3: Add a focused unit test for the predicate**

Append to `client/test/tx-retry.test.ts` (in the existing top-level `describe`, or a new `describe('isReplacementUnderpricedError', ...)` — match the file's existing style; if the file imports predicates by name, add `isReplacementUnderpricedError` to that import):

```typescript
describe('isReplacementUnderpricedError', () => {
  it('matches replacement-underpriced RPC messages', () => {
    expect(isReplacementUnderpricedError(new Error('replacement transaction underpriced'))).toBe(true);
    expect(isReplacementUnderpricedError(new Error('replacement fee too low'))).toBe(true);
    expect(isReplacementUnderpricedError(new Error('transaction underpriced'))).toBe(true);
  });

  it('does not match nonce-too-low or unrelated errors', () => {
    expect(isReplacementUnderpricedError(new Error('nonce too low'))).toBe(false);
    expect(isReplacementUnderpricedError(new Error('insufficient funds'))).toBe(false);
  });
});
```

Before writing, open `client/test/tx-retry.test.ts` and confirm the import line for `tx-retry.js` so you add `isReplacementUnderpricedError` to the existing named import rather than adding a duplicate import.

- [ ] **Step 4: Run the predicate test**

Run: `yarn test test/tx-retry.test.ts -t "isReplacementUnderpricedError"`
Expected: PASS (both cases).

- [ ] **Step 5: Confirm no regression in the broader tx-retry suite**

Run: `yarn test test/tx-retry.test.ts`
Expected: PASS (the `isRecoverableTransactionError` refactor is behavior-preserving — the same five strings still return true).

- [ ] **Step 6: Commit**

```bash
git add client/src/tx-retry.ts client/test/tx-retry.test.ts
git commit -m "feat(tx-retry): export isReplacementUnderpricedError predicate (#897)"
```

---

## Task 3: Reconcile-first catch block in `executeSafeTransactionInner` (AC1 + AC2)

**Files:**
- Modify: `client/src/adapters/mech/safe.ts` (import on lines 13-18; catch block on lines 153-177)

- [ ] **Step 1: Import the new predicate**

In the existing import from `'../../tx-retry.js'` (lines 13-18), add `isReplacementUnderpricedError` to the named imports so it reads:

```typescript
import {
  isNonceTooLowError,
  isReplacementUnderpricedError,
  type TxSubmissionLedger,
  withNonceLedger,
  withRecoverableRetry,
} from '../../tx-retry.js';
```

- [ ] **Step 2: Rewrite the `catch (writeErr)` block (reconcile-first, then refresh)**

Replace the current catch block. The current block is:

```typescript
      } catch (writeErr) {
        if (isNonceTooLowError(writeErr)) {
          const refreshed = await nonceLedger.refreshNonce();
          console.error(`[safe/viem] execTransaction refreshed pinned nonce -> ${refreshed}`);
        }
        // viem pre-flight gas estimation may revert with GS013 when the inner
        // call would fail. Decode the inner reason so callers (and tx-retry)
        // can distinguish self-already-claimed from lost-race from transient.
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        if (msg.includes('GS013') || msg.includes('GS026')) {
          const inner = await decodeSafeInnerRevert(publicClient, params);
          if (inner.decodedName) {
            const formatted = formatDecodedRevert(inner.decodedName, inner.decodedArgs);
            throw new SafeInnerRevertError(
              `Safe execTransaction inner revert (estimate): ${formatted}`,
              inner.innerSelector,
              inner.innerData,
              inner.decodedName,
              inner.decodedArgs,
              null,
            );
          }
        }
        throw writeErr;
      }
```

Replace it with:

```typescript
      } catch (writeErr) {
        const nonceTooLow = isNonceTooLowError(writeErr);
        const replacementUnderpriced = isReplacementUnderpricedError(writeErr);

        // Issue #897: before re-signing at a fresh nonce, reconcile against the
        // tx already submitted at the currently-pinned nonce. The original EOA
        // tx may have mined mid-retry (nonce-too-low = it mined; replacement-
        // underpriced = it is still pending but the bump was too small and it
        // may mine before the next attempt). Re-signing a NEW Safe
        // execTransaction at the advanced Safe nonce is NOT idempotent — it
        // re-attempts the delivery and reverts as already-claimed. So if the
        // original receipt is already a success, short-circuit and return it.
        if (nonceTooLow || replacementUnderpriced) {
          const existing = await nonceLedger.ledger.getTxSubmission({
            chainId: nonceLedger.chainId,
            from: nonceLedger.from,
            nonce: nonceLedger.nonce,
          });
          if (existing?.hash) {
            try {
              const reconciled = await publicClient.getTransactionReceipt({ hash: existing.hash });
              if (reconciled.status === 'success') {
                console.error(
                  `[safe/viem] execTransaction reconciled: original tx ${existing.hash} mined ` +
                    `at pinned nonce ${nonceLedger.nonce} — delivery already landed`,
                );
                await nonceLedger.markResolved();
                return existing.hash;
              }
            } catch {
              // TransactionReceiptNotFoundError (or any lookup failure): the
              // original is not yet mined. Fall through to refresh + re-sign.
            }
          }
        }

        // Both nonce-too-low and replacement-underpriced advance the pinned
        // nonce: nonce-too-low means the original mined; replacement-underpriced
        // means the next attempt must bump fees against the fresh nonce so a
        // mid-retry mine of the original is detected on the following pass.
        if (nonceTooLow || replacementUnderpriced) {
          const refreshed = await nonceLedger.refreshNonce();
          console.error(`[safe/viem] execTransaction refreshed pinned nonce -> ${refreshed}`);
        }

        // viem pre-flight gas estimation may revert with GS013 when the inner
        // call would fail. Decode the inner reason so callers (and tx-retry)
        // can distinguish self-already-claimed from lost-race from transient.
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        if (msg.includes('GS013') || msg.includes('GS026')) {
          const inner = await decodeSafeInnerRevert(publicClient, params);
          if (inner.decodedName) {
            const formatted = formatDecodedRevert(inner.decodedName, inner.decodedArgs);
            throw new SafeInnerRevertError(
              `Safe execTransaction inner revert (estimate): ${formatted}`,
              inner.innerSelector,
              inner.innerData,
              inner.decodedName,
              inner.decodedArgs,
              null,
            );
          }
        }
        throw writeErr;
      }
```

Notes the implementer must hold:
- `return existing.hash;` returns from the per-attempt `fn` passed to `withRecoverableRetry`, which makes it the attempt's success result (the retry loop stops). `existing.hash` is typed `Hex | undefined` on the entry but is guarded by `if (existing?.hash)`, so inside that block it is `Hex` — matches the function's `Promise<Hex>` return type.
- Reconcile runs BEFORE `refreshNonce()` so the lookup uses the ORIGINAL pinned nonce (`nonceLedger.nonce` before refresh), which is the nonce the original tx was recorded under.
- The `getTransactionReceipt` call is wrapped in its own try/catch: viem throws when the tx is not yet mined, and we must treat that as "fall through to refresh + re-sign", not as a hard error.

- [ ] **Step 3: Run the Task 1 regression test — it should now PASS**

Run: `yarn test test/adapters/mech/safe.test.ts -t "reconciles to the mined original"`
Expected: PASS. `writeContract` called once, `getTransactionReceipt` called with `{ hash: ORIGINAL_HASH }`, returned `hash === ORIGINAL_HASH`.

- [ ] **Step 4: Run the full safe-adapter suite (no regression in AC1/AC2 nonce-refresh)**

Run: `yarn test test/adapters/mech/safe.test.ts`
Expected: PASS, including the pre-existing `executeSafeTransaction nonce refresh` test (lines 43-98) — that test's ledger has no `hash` recorded for the pinned nonce until after the first failed write records it, so the reconcile branch finds no success receipt and correctly falls through to refresh-and-resign. If that pre-existing test now records a `hash` and the reconcile path triggers unexpectedly, the test's `waitForTransactionReceipt`/added `getTransactionReceipt` mocks must reflect a NOT-success / not-found original; adjust only if it breaks.

- [ ] **Step 5: Commit**

```bash
git add client/src/adapters/mech/safe.ts
git commit -m "fix(safe): reconcile original tx before re-signing on stale nonce (#897)

Closes #897"
```

---

## Task 4: Full verification

- [ ] **Step 1: Typecheck**

Run: `yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Run both touched test files together**

Run: `yarn test test/adapters/mech/safe.test.ts test/tx-retry.test.ts`
Expected: all PASS.

- [ ] **Step 3: Run the full client test suite (catch any cross-module fallout)**

Run: `yarn test`
Expected: PASS (or pre-existing unrelated failures only — diff against a clean `next` run if unsure; nothing in this change touches modules outside `tx-retry.ts` and `safe.ts`).

- [ ] **Step 4: Build (the published-package gate)**

Run: `yarn build`
Expected: completes; `dist/` produced without TS errors.

---

## AC → Task mapping

| Acceptance criterion | Satisfied by |
|---|---|
| **AC1** — on "nonce too low", refetch nonce and either re-sign at fresh nonce OR reconcile by fetching the receipt at the now-mined nonce and mark delivered, rather than looping on the stale nonce | Task 3 Step 2: nonce-too-low triggers the ledger lookup → `getTransactionReceipt` → if `status === 'success'`, `markResolved()` + `return existing.hash` (reconcile path); otherwise `refreshNonce()` + rethrow → re-sign at fresh nonce. The Task 1 regression test exercises the reconcile branch (its message is replacement-underpriced; the nonce-too-low branch shares the identical reconcile code path — both are covered by the `nonceTooLow || replacementUnderpriced` guard). |
| **AC2** — on "replacement underpriced", refresh the nonce before bumping fees so a mid-retry mine of the original is detected | Task 2 (new `isReplacementUnderpricedError` predicate) + Task 3 Step 2: replacement-underpriced now enters the same `refreshNonce()` branch (previously only nonce-too-low did). The reconcile lookup that precedes the refresh is exactly the "detect a mid-retry mine of the original" check. |
| **AC3** — regression test: pending tx at nonce N → bump fee → original mines mid-bump → loop reconciles instead of looping 5× at stale N | Task 1: `executeSafeTransaction reconcile-first (issue #897)` test. Seeds the ledger with the original `hash` at the pinned nonce, makes `writeContract` reject `replacement transaction underpriced`, makes `getTransactionReceipt(ORIGINAL_HASH)` return `{ status: 'success' }`, and asserts `hash === ORIGINAL_HASH` with `writeContract` called exactly once (no 5× loop, no re-sign). |

---

## Self-Review

**Spec coverage.** All three ACs map to concrete tasks (table above). The Stage-1 design's two parts — AC2 (refresh on replacement-underpriced) and AC1 (reconcile-first via ledger receipt lookup) — are both implemented in Task 3's catch-block rewrite, with the predicate extracted in Task 2 and the regression in Task 1. No `tx-retry.ts` behavioral change beyond the exported predicate (the `isRecoverableTransactionError` refactor is string-for-string equivalent).

**Placeholder scan.** No TBD/TODO/"handle edge cases" placeholders; every code step shows full code; every run step gives an exact command and expected outcome.

**Type consistency.** Symbols used (`isNonceTooLowError`, `isReplacementUnderpricedError`, `NonceLedgerContext.ledger`/`.chainId`/`.from`/`.nonce`/`.markResolved`/`.refreshNonce`, `TxSubmissionLedger.getTxSubmission`, `TxSubmissionKey = {chainId,from,nonce}`, `TxSubmissionLedgerEntry.hash?: Hex`, `createMemoryTxSubmissionLedger`, viem `publicClient.getTransactionReceipt`) all verified present in `client/src/tx-retry.ts` and `client/src/adapters/mech/safe.ts` in this worktree. `existing.hash` is `Hex` under the `if (existing?.hash)` guard, matching the `Promise<Hex>` return type. The new predicate's name is used identically in Tasks 2 and 3.

**Ordering.** Regression test first (Task 1, red), predicate second (Task 2), fix third (Task 3, green), full verification last (Task 4) — matches the `fix`-shape regression-first discipline.
