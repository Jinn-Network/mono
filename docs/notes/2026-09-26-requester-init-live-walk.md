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
- **Deploy shortfall after a green faucet.** The requester gate is 0.0015 ETH
  (0.001 to the agent EOA + 0.0005 master gas reserve). Live Base Sepolia then
  refused the Safe deploy for insufficient gas/value. Treating that as
  `fatal` (exit 50) rather than `funding_required` is the current CLI mapping
  for a catch during deploy, not the funding-gate envelope.
- Spawn used `NODE_OPTIONS=--preserve-symlinks` (Yarn portal packages).
  Workspace `dist/` trees were built with the same prefix `yarn test` uses
  (`build:sdk`, `build:stack`, `build:plugin`, `build:core`).
