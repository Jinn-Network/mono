# Operator runbook — Jinn mainnet (Base)

**Status: placeholder. Mainnet operator flow ships with Phase 2.**

Until the Phase 2 mainnet launch milestone, Jinn protocol activity lives
entirely on testnet. Operators should use `JINN_NETWORK=testnet` and follow
[`docs/operator-testnet.md`](./operator-testnet.md).

This document will be filled in closer to Phase 2 launch with:

- Mainnet economics (tokenless, OLAS-native): OLAS is both stake and reward.
  No JINN token. The daemon `reward-claim` loop settles stOLAS distributor
  rewards; there is no claim-relayer.
- Fund-requirement specifics: operators hold real OLAS on mainnet; Phase 1b's
  pooled stOLAS model does not apply to mainnet standard staking.
- Mainnet-specific risk rails and safety thresholds.
- Migration path from testnet fleet state to a mainnet fleet.
- The mainnet equivalent of the stOLAS distributor seed dependency (short
  answer: there isn't one — real stakers provide the pool).

Track Phase 2 readiness via the protocol team's release channel.
