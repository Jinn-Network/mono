# Requester-init live walk (2026-09-26)

Issue #4741 / #2446 criterion 6: a real `jinn requester init` on Base Sepolia
must create a funded creator Safe inside the 4:30 budget, with a CDP drip
count near 15 rather than the operator's ~200.

## Command

```bash
cd operator && JINN_LIVE_REQUESTER_INIT=1 yarn vitest run test/live/requester-init.live.test.ts
```

Flag-off skip: `yarn vitest run test/live/requester-init.live.test.ts` → 2 skipped.

## Verdict

**fail**

The faucet step cleared the requester target. Creator-Safe deployment did not.
Assertions were not widened; the live file stays red.

## Measurements

| Check | Result |
| --- | --- |
| First-run exit | 50 (`fatal`), not 0 |
| JSON `chain` / `master` / `creatorSafe` | no success payload (fatal envelope path) |
| Wall-clock vs 4:30 (270_000 ms) | 27_268 ms first `it` — under budget |
| Drip N vs ~15 | 20 (≤ 25 pass; not ≥ 40) |
| Disk persona | not asserted; deploy failed before success return |
| On-chain bytecode | not asserted; no `creatorSafe` from a passing payload |
| Second-run idempotency | not executed; first run did not establish scratch state |

Stderr receipts from the first run:

- Master: `0x76871A13913aEC82Bb06d2a3C3Dd4C1f9052dD21`
- Agent EOA (Safe owner): `0xA956463BAb233E9289E9a3B7B2e15363054961bd`
- Predicted Safe: `0x8208386e6376D3569bEbad8090C53C7faBCB8fCB`

Sequence:

1. `[requester-init] Wallet has 0 ETH; need 0.0015 ETH. Draining CDP faucet on base-sepolia (up to 50 drips or 300s).`
2. `[requester-init] CDP faucet reached target after 20 drips`
3. Stage 1 funded the agent EOA with `1000000000000000` wei, then:
   `Not enough ETH on the paying account to cover gas (and value, if any).`
   (A classifier summary, not the chain error — see Notes below.)

## Notes

- **CDP default vs env.** Parent `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` were
  unset. The child did not copy them. The walk used the shipped default pair.
  No secrets in this note.
- **Poll-every-5 overshoot.** Balance is sampled on drip 5, 10, 15, 20, …
  A target that lands between 16 and 20 reports N=20. Measured 20 against a
  ~15 raw estimate is that cadence, not an operator-scale loop.
- **5:00 loop timeout vs 4:30 budget.** `dripFaucetToward` advertises 300 s
  (`DEFAULT_FAUCET_LOOP_TIMEOUT_MS`). The live assertion is 270 s. This run
  finished the faucet well under both; the mismatch is latent.
- **Deploy failure after a green faucet — cause not yet established.** Stage 1
  funded the agent EOA and the Safe deploy then failed with
  `Not enough ETH on the paying account to cover gas (and value, if any).`
  That string is **not** the chain error. It is a classifier summary returned
  from two unrelated branches of `operator/src/operator-errors.ts`:
  `:134-136` on `gas required exceeds allowance (0)` (spendable balance ÷ gas
  price rounds to zero) and `:167-173` on the `insufficient funds for gas` /
  `insufficient funds for transfer` / `exceeds the balance of the account`
  family. The summary cannot discriminate them, so this run does not identify
  which account was short, and it does not support the earlier reading of this
  section that the 0.0015 ETH gate is undersized. Concretely against that
  reading: the deploy is submitted by the **agent EOA**, not the master
  (`operator/src/earning/steps/fleet-safe-deploy.ts:76-86` sends with
  `account: agentSigner`); at review time the agent EOA
  `0xA956463BAb233E9289E9a3B7B2e15363054961bd` held exactly 0.001 ETH at
  nonce 0 — funded with `REQUESTER_SAFE_DEPLOY_ETH`, nothing spent — and a
  ~250k-gas Safe deploy at the sub-gwei prices Base Sepolia settles at costs
  on the order of 1e-6 ETH (`operator/src/earning/requester-init.ts:20-25`).
  The gate arithmetic above is therefore recorded as context, not as the
  diagnosis.

  **What the re-run must capture** (#4848): the verbatim `details.cause` from
  the `fatal` envelope on stdout, and the `[requester-init] raw: …` line on
  stderr. Neither was in this walk's receipts — the requester catch in
  `FleetBootstrapper.ensureRequesterSafe` logged only the summary (unlike its
  two sibling catches), and the live test's exit-code assertion quoted stderr
  only. Both are fixed under #4848, so the next walk records the
  discriminating datum without any further instrumentation.

  One hypothesis to rule in or out while re-running, **not** a finding:
  `initPredictedSafe` (`operator/src/earning/safe-adapter.ts`) builds a fresh
  provider from `ctx.config.rpcUrl`, whereas the funding transfer's receipt is
  awaited on `ctx.publicClient`. If those resolve to different providers with
  different views of head state, the deploy could be priced against a balance
  that has not yet landed for that provider. The raw error decides it.

- **Envelope mapping.** Treating the deploy failure as `fatal` (exit 50)
  rather than `funding_required` is the current CLI mapping for a catch during
  deploy, not the funding-gate envelope. Follow-up:
  [#4791](https://github.com/Jinn-Network/mono/issues/4791) — whose implementer
  should start from this corrected section, not from the superseded
  undersized-gate reading, and whose outcome-shaped criteria still require a
  live run that exits 0.
- Spawn used `NODE_OPTIONS=--preserve-symlinks` (Yarn portal packages).
  Workspace `dist/` trees were built with the same prefix `yarn test` uses
  (`build:sdk`, `build:stack`, `build:plugin`, `build:core`).
