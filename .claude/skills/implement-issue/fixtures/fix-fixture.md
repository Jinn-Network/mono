Issue Type: fix | Effort: Low

Title: fee cap below base fee is misclassified as nonce_conflict in formatBootstrapOperatorMessage

**Context.** `client/src/operator-errors.ts` → `formatBootstrapOperatorMessage` handles three error phrases in one branch (lines 110–121):

```
lower.includes('replacement transaction underpriced') ||
lower.includes('replacement fee too low') ||
lower.includes('fee cap less than block base fee')
```

All three return `category: 'nonce_conflict'` with the summary "A transaction with the same nonce is already pending, and the new gas price is too low." The first two phrases do indicate a nonce-replacement scenario (two transactions with the same nonce, second gas too low to replace the first). The third phrase — `fee cap less than block base fee` — does not. It means the caller's `maxFeePerGas` cap is below the current block base fee; there is no competing transaction involved. Classifying it as `nonce_conflict` causes the SPA to render "clear the stuck nonce" guidance that does not apply, while the real fix (raise `maxFeePerGas` or wait for base fee to drop) is absent.

The test file `client/test/operator-errors.test.ts` covers the `replacement transaction underpriced` path but has no case for `fee cap less than block base fee`, so the mismatch has gone undetected.

**Impact.** Operators who encounter a base-fee surge during bootstrap see incorrect "clear the stuck nonce" guidance instead of "raise maxFeePerGas or wait for base fee to drop". The structured `category` field drives the SPA's recovery UI — a wrong category renders the wrong call to action.

**Acceptance criteria.**
- [ ] After the fix, `formatBootstrapOperatorMessage(new Error('fee cap less than block base fee'))` returns `category: 'gas_too_low'` (not `'nonce_conflict'`) and a summary that does not mention "nonce" or "pending".
- [ ] A regression test for the `fee cap less than block base fee` path is present in `client/test/operator-errors.test.ts` and passes under `yarn test`.

**Files/components.** `client/src/operator-errors.ts` (branch at lines 110–121), `client/test/operator-errors.test.ts` — unit-tested module, regression test first per the fix SOP.
