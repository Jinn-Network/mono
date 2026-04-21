# Operator dogfood — 2026-04-21 night run

External-operator walkthrough of the `@jinn-network/client` canary on Base
Sepolia. Author: dogfood tester wearing the shoes of a first-time external
operator, with protocol-team keys alongside for the L1 tokenomics track.

Canary pin: `@jinn-network/client@0.1.1-canary.466a467a`
(sha `466a467ade6f7433d92236a921408f61d1b3e045`).

## Summary (fill in last)

- Canary versions used:
- Full loop landed?: TBD
- JINN rewards claimed?: TBD
- Source of claimed JINN: TBD
- Time from `jinn quickstart` to daemon running: TBD
- Cycles observed (full create → restore → eval → claim): TBD
- % PASS vs INDETERMINATE vs FAIL: TBD
- Time to first reward arrival in operator Safe: TBD

## Timeline

- `2026-04-21T21:05Z` — Session start. Dogfood env exported:
  - `JINN_EARNING_DIR=/Users/adrianobradley/.jinn-client/earning-dogfood-2026-04-21`
  - `JINN_DB_PATH=/Users/adrianobradley/.jinn-client/jinn-dogfood-2026-04-21.db`
  - `JINN_NETWORK=testnet`, `JINN_PASSWORD=<dogfood>`
- `21:05Z` — `npx @jinn-network/client@0.1.1-canary.466a467a doctor` failed with
  `could not determine executable to run`. Package exposes two bins (`jinn`,
  `jinn-mcp`); npx cannot auto-select. Workaround: `npx -p
  @jinn-network/client@0.1.1-canary.466a467a jinn doctor --human`. Doc says
  plain `npx @jinn-network/client@...` — filed as a UX finding.
- `21:06Z` — `jinn doctor --human` passed. keystore absent (expected for fresh
  operator), deployment resolved on base-sepolia, distributor holds
  880 JINN (44 services of runway), claude_auth bare. Canary sha captured
  `466a467ade6f7433d92236a921408f61d1b3e045`.
- `21:06Z` — `jinn intents list --human` shows prediction.v0 enabled by default
  with impl `prediction-v0-baseline`; portfolio.v0 registered but disabled.
- `21:07Z` — `jinn intents --help` does **not** advertise any `--impl` flag;
  task brief's suggested `jinn intents enable prediction.v0 --impl
  claude-mcp-prediction --yes` is not supported. Switching impl currently
  requires editing `config.restorers.byKind['prediction.v0']`. UX gap.

## Track A (protocol-team cadence)

- L1 checkpoints run: 0
- L1 → L2 bridge calls successful: 0
- Confirmed fresh JINN arrived on L2 via distributor (not just the 549 seed)?:
  TBD

Going-in snapshot: L1 Tokenomics ≈ epoch 7+ (deployment
`0x302cd1f188fCFcA64EA038aFa738D90951360739`), 1000 JINN locked in veJINN with
100% vote weight on L2 staking nominee
`0x2c286651590b4DdC6d58d1270069B43183a851D1`, vote active since
`2026-04-21T16:15:00Z`. 549 JINN pre-seeded in L2 staking contract as
fallback.

## Track B (operator path)

Operator timeline with cycle-level detail.

## Fixes shipped

_(PR list)_

## Issues filed (not fixed)

_(beads list)_

## Blockers I couldn't resolve

_(none yet)_

## For an external operator

Copy-pasteable commands for tomorrow:

```bash
# Required env (pick a password, pick a home-dir for state):
export JINN_PASSWORD="<your-keystore-password>"
export JINN_NETWORK=testnet
# default JINN_EARNING_DIR is ~/.jinn-client/earning, fine to leave unset.

# Zero-to-running one-liner:
npx -p @jinn-network/client@0.1.1-canary.466a467a jinn quickstart
```

_More to come once the run confirms steady-state behaviour._

## Evidence

| Artifact | Address / tx |
|---|---|
| Master EOA | TBD |
| Operator Safe | TBD |
| Service ID | TBD |
| First creation tx | TBD |
| First restoration delivery | TBD |
| First eval delivery | TBD |
| Reward claim tx | TBD |

