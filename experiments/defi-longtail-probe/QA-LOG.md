# QA-LOG — long-tail protocol probe

Chronological log of harness fixes, design refinements that don't change the
approved design, and QA-gate results. Newest last.

## 2026-08-03 — build-time findings (pre-preregistration)

1. **Fork upstreams.** The prior probe's Tenderly gateway URL was env-only and
   is not recoverable. Keyless endpoints tested through anvil at the pins:
   Base — drpc (408 rate-limit), publicnode (403 archive requires token),
   llamarpc (HTML error) all failed; **1rpc.io/base works** (AERO symbol +
   Slipstream slot0 read through fork). Ethereum — **publicnode works** (WETH
   symbol + Aave V4 Main-Spoke getReserveCount()=14 through fork). Committed
   defaults set accordingly; `DEFI_PROBE_FORK_URL_BASE/_ETH` override. Risk
   noted: if 1rpc flakes mid-matrix, the resumable runner + an operator-side
   paid-gateway override is the escape hatch.
2. **Pendle "~90-day maturity" phrasing void.** Only one live sUSDe market
   exists (expiry 2026-08-13, $8.23M liquidity). M3a names PT-sUSDe →
   `unique`. The thin USDe sibling market ($393k) is recorded in ADDRESSES.md
   for the ambiguity audit. Design refinement, not a swap (nothing scored).
3. **Fira fixed-rate series all expired at pin** (last 2026-06-18; factory-log
   scan shows no new series since 2026-04-22). Historical-block pinning
   rejected: the agent's live web access would truthfully report "all terms
   expired", contradicting fork state and poisoning failure attribution. L4
   pivots to Fira's live variable-rate USDC/wstETH market (verified on-chain;
   7-field Morpho-divergent MarketParams). Coverage score unaffected (same
   protocol, quizzed blind). Predicted failure-mode text amended in
   PREREGISTRATION.md §2 before freeze; predicted pass rate unchanged.
   TVL floor re-checked: $15.7M ≥ $5M (the $450M press figure is the looped
   UZR USD0 market — reconciled in ADDRESSES.md).
4. **Twyne credit-LP liquidity.** eeWETH intermediate vault holds ~0.64 eWETH
   free under a 7-eWETH cap. L3 setup pre-funds the LP side permissionlessly
   (WETH → eWETH → intermediate deposit) inside the cap; no admin
   impersonation. Positions sized to fit.
5. **Aave V4 note for verifiers.** Users approve the Spoke but tokens land on
   the Hub — Hub-side balance assertions, not Spoke-side. HF is per-spoke.
6. **Ethereum fork upstream switched publicnode → drpc** during QA: publicnode
   403s ("Archive requests require a personal token") once the pin ages out of
   its 128-block window; eth.drpc.org serves archive state at the pin through
   anvil. Base stays on 1rpc.io. Committed defaults updated in trial.ts.
7. **Upstream flake observed and absorbed**: one cal-long-cooler-borrow
   reference run failed with an on-chain revert at the borrow step that a
   manual cast repro (twice) and an immediate re-run could not reproduce —
   attributed to a drpc read flake mid-tx. Anvil spawns already use
   `--retries 5 --timeout 45000`; matrix policy per the prior probe: infra
   errors are re-run, never scored.
8. **QA round 1 (14 scored refs): 6 pass, 8 fail — triage.**
   (a) Pendle market address had a bad EIP-55 checksum in `_protocols.ts`
   (transcription; viem rejects) — fixed from `cast to-check-sum-address`.
   (b) Aave V4 borrow reverts `0x851aedc1` unless `setUsingAsCollateral` is
   called first — **V4 does not auto-enable first supply as collateral,
   unlike V3.** Reference updated. Noted as a live candidate failure mode for
   the scored runs (a V3-habituated agent will skip this call).
   (c) Twyne pre-fund reverts and one V4 borrow revert did not reproduce
   manually (cast, twice) — same drpc flake class as §7.
   (d) Base upstream: 1rpc.io daily quota exhausted mid-QA; default switched
   to `base.gateway.tenderly.co` (public gateway, archive-capable, verified).
9. **Time-warp constraints.** L2b (Cooler interest accrual) warps ~30d — safe,
   no Chainlink in the Cooler path. L4b warps ~30d — supply/withdraw path has
   no oracle dependency (Morpho-shaped). L3 gets no warp (Euler Chainlink
   adapters enforce maxStaleness). M-tier gets no warp except M2 epoch
   positioning (< 8 days).

## 2026-08-03 — QA gates closed

- Reference sweep: 16/16 ALL PASS on final code (l3b fixed twice more:
  redeem margin 5e11 for reserved-credit interest accruing between read and
  tx — T_WithdrawMoreThanMax decoded; verifier credit-released tolerance
  1e11 since the invariant reserves credit proportional to residual dust).
- Null-op sweep: 16/16 CORE FAILS (no verifier passable by doing nothing).
- PREREGISTRATION.md §6 instance-prompt lock appended (14 prompts, byte-
  identical to task.md files). Sections 1–5 untouched.

## 2026-08-03 — scored-v1 first pass: session-rate-limit contamination (22 of 42 cells)

**What happened.** Mid-matrix, the Claude session hit its usage limit ("You've
hit your session limit · resets 4pm"). The CLI returned immediately with
`terminal_reason: api_error`, `num_turns: 1`, `total_cost_usd: 0` — the agent
never ran. The harness scored those empty runs as `clean-fail`, producing a
fake 0% for all three M-tier families and a fake 33% for L4. The first
analyzer pass reported a −50pt full→none coverage spread that was pure
artefact.

**Detection.** The M-tier's $0.00 mean cost and 0.0 min mean wall-clock are
impossible for a real run — that mismatch is what exposed it, not the scores.

**Contaminated set (22 cells, all discarded, backed up to
`~/defi-longtail-probe-runs/scored-v1-contaminated-backup/`):** all 18 M-tier
cells (1 turn, $0 — never started), plus l4b t1/t2/t3 and l4a t3 (cut off
mid-run at 12, 1, 1 and 31 turns). **20 cells retained** — every cell with a
`success` terminal, i.e. all of L1, L2, L3 and l4a t1/t2.

**Harness fixes (so this cannot recur silently):**
1. `claude.ts` surfaces `apiError` from the terminal result event.
2. `trial.ts` throws `INFRA: agent run terminated by API error, not scored`
   when `apiError` is set — an API-truncated run can never be scored.
3. `run-matrix.ts` resume now re-runs cells whose `result.json` carries an
   `error`, instead of skipping them as done.

No preregistration change; no instance change. The 22 cells re-run on the
same locked instances and prompts after the limit resets.
