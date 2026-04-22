# Operator dogfood — 2026-04-21 night run

External-operator walkthrough of the `@jinn-network/client` canary on Base
Sepolia. Author: dogfood tester wearing the shoes of a first-time external
operator, with protocol-team keys alongside for the L1 tokenomics track.

Final validated canary pin: `@jinn-network/client@0.1.1-canary.6eeaf175`
(sha `6eeaf1757d0bf1090b75d492688350dd1ccec433`).

## Summary

- Canary versions used:
  - `0.1.1-canary.466a467a` — original overnight pin.
  - `0.1.1-canary.4a2d9b80` — default Base Sepolia ClaimRegistry.
  - `0.1.1-canary.8e2a9d83` — idempotent replayed delivery claims.
  - `0.1.1-canary.6eeaf175` — final validated canary.
- Full loop landed?: yes, for `prediction.v0` on Base Sepolia.
- JINN rewards claimed?: yes, distributor claim tx landed for service 30.
- Source of claimed JINN: stOLAS L2 distributor `0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81`.
- Time from `jinn quickstart` to daemon running: about 30 seconds on an already-funded operator state.
- Cycles observed (full create → restore → eval → claim): 1 complete `prediction.v0` cycle on final canary.
- Final on-chain counters for Safe `0x426306Edd920fd73D13b51DF8c3B9D4FB332bF26`: creation `80`, restoration delivery `4`, evaluation creation `2`, evaluation delivery `1`.
- Legacy `health-check` still fails while Claude Code account quota is exhausted; this does not block the deterministic `prediction.v0` operator path.

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

Final validated run used:

```bash
JINN_NETWORK=testnet
JINN_EARNING_DIR=/Users/adrianobradley/.jinn-client/earning-dogfood-2026-04-21
JINN_DB_PATH=/Users/adrianobradley/.jinn-client/jinn-dogfood-2026-04-22-6eeaf175.db
JINN_API_PORT=7331
npx -p @jinn-network/client@0.1.1-canary.6eeaf175 jinn quickstart \
  --config /Users/adrianobradley/.jinn-client/config-dogfood-2026-04-21.json
```

Cycle-level detail:

- Daemon started on Base Sepolia with service 30, Safe `0x426306Edd920fd73D13b51DF8c3B9D4FB332bF26`, mech `0x3Cd2512a1a88d850B283412a3C942b1b7A90326A`.
- `ClaimRegistry` resolved automatically to `0xd229A2C20333B747675090Ce38B8a1Fb2dafe6AC`.
- Reward claim submitted before the loop.
- Health-check restoration was claimed but failed because Claude Code quota was exhausted.
- `prediction.v0` restoration request `0x95c4b0250a2dbe7595d1fdce97f6c41bc919a5ebcf6dfa9545320f1540ee5d82` completed and claimed.
- Delivery watcher treated replayed restoration delivery claim as idempotent and created evaluation request `0xf1ac57e93090a879468305e648fbfb541b108d64a4b2124748fe2ee62a06b85f`.
- `prediction-v0-evaluator` produced a verdict, delivered to the marketplace, claimed delivery, and delivery watcher processed the evaluation delivery.

## Fixes shipped

- PR #19 — documented npx `-p ... jinn` invocation to avoid multi-bin package ambiguity.
- PR #21 — shipped Base Sepolia ClaimRegistry as the default testnet deployment and added doctor/default coverage.
- PR #22 — made `claimDelivery` idempotent when replayed delivery logs hit already-claimed requests hidden behind Safe `GS013`.
- PR #23 — allowed `prediction-v0-evaluator` to evaluate the signed engine manifest shape actually emitted by restorations.

## Issues filed (not fixed)

- None blocking the validated `prediction.v0` operator flow.
- Remaining UX follow-up: legacy health-check should probably not depend on Claude quota in the default external-operator smoke path.

## Blockers I couldn't resolve

- Claude Code quota is exhausted until Apr 23 at 22:00 Europe/Brussels, so the legacy free-form health-check restoration cannot run right now.
- Master EOA gas runway is low; quickstart warns to top up `0x1a8435E635DBE7608611858eA5a0A0D9a28f8E6a`.

## For an external operator

Copy-pasteable commands for tomorrow:

```bash
# Required env (pick a password, pick a home-dir for state):
export JINN_PASSWORD="<your-keystore-password>"
export JINN_NETWORK=testnet
# default JINN_EARNING_DIR is ~/.jinn-client/earning, fine to leave unset.

# Confirm local environment:
npx -p @jinn-network/client@0.1.1-canary.6eeaf175 jinn doctor --human

# Zero-to-running one-liner:
npx -p @jinn-network/client@0.1.1-canary.6eeaf175 jinn quickstart
```

If a daemon is already running from an older canary, stop and restart it with the
new pin so the bundled ClaimRegistry default, idempotent delivery claim handling,
and evaluator manifest parser are all active.

## Evidence

| Artifact | Address / tx |
|---|---|
| Master EOA | `0x1a8435E635DBE7608611858eA5a0A0D9a28f8E6a` |
| Operator Safe | `0x426306Edd920fd73D13b51DF8c3B9D4FB332bF26` |
| Service ID | `30` |
| Mech | `0x3Cd2512a1a88d850B283412a3C942b1b7A90326A` |
| ClaimRegistry | `0xd229A2C20333B747675090Ce38B8a1Fb2dafe6AC` |
| Restoration creation tx | `0xd4c8027f8e4e73b9f42daf0a658ee7dcf1693b658214d618ef1041baf715e97f` |
| Restoration delivery tx | `0x92b3dcfc7d329c6a809f8b6a1227be33a340dfba79655cdde0377b694ad9ee3c` |
| Restoration claim tx | `0x8bc9fbe0e020993cb5eb038863c2ae5bb392c9cd1226e660c72b7ecd9e5e0176` |
| Evaluation creation tx | `0xbbb7e99ba8656e039b4af659da2c745f942616916f7f36abe21881a4330b723b` |
| Evaluation delivery tx | `0x9294fa84bd0f753a776ea784166c5cb666c31af586fc8728d253ec550e660134` |
| Evaluation claim tx | `0x6a522caa0deaebf5fda9a1a5e110ea2be3d3e3db586f2d1e8d648f0ada340820` |
| Reward claim tx | `0xc5ee90f8a21e4e40daa9a4aecf5dec95ef05d3cdae68c7ea27dde1806b7907dc` |
