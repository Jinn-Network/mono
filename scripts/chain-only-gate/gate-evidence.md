# Chain-only gate evidence (program §5 / E14)

Generated: 2026-08-02T00:31:26.482Z

## Digests

| Item | Value |
| --- | --- |
| Composite record (`informationWorlds: []`) | `sha256:ab446a8c3083b3ae9ba7af8c751b4093ce45831c20e01ba1f4ab0bf29c603442` |
| Chain environment record | `sha256:cfa54cc2c7760e30440159b45ec0e4ebb6758dacc61ea2fade36050df2474ffc` |
| Verification attestation | `sha256:d77df65ceed2f7e34e964830af4c17d9636ecf62be4a85efa98f2625442db3c6` |
| Attestation outcome | `closed-reproducible` |
| Admission receipt | `sha256:c96b33596ef0aee37181d72cebaa0887fab10f38acbd108698a0ddc333789a0d` |

## Run context

- Archive host (live eth_getProof): `https://sepolia.base.org/…`
- Anchor block: `44931197`
- Source address: `0x4200000000000000000000000000000000000006` (WETH)
- Anvil on PATH: `1.6.0-nightly` (`sha256:bd5cbc478265e74931a65bc49c99ffd777398017188bf148c352b40b550897a1`)

## Findings

### F-GATE-1

- **Claim:** Anvil pin is measured PATH binary, not fixture 1.3.7 (F-T17-1).
- **Disposition:** accept for this gate evidence

### F-GATE-2

- **Claim:** Blackhole K≥5 spawns a live Anvil ProcessHost, loads the harvested state artifact via anvil_set*, and reads WETH keys over RPC for the observation fingerprint.
- **Disposition:** closed — live Anvil sealed materializer

### F-GATE-3

- **Claim:** Admission observes do-nothing/reference on a live Anvil MiniToken world (setCode + seeded allowances + impersonated approve(0)), then composes evaluatePredicates into ChainObservationPort with no safety override.
- **Disposition:** closed — live Anvil observation + evaluatePredicates composition

### F-GATE-4

- **Claim:** Extract assemble drove live eth_getProof against a frozen tip via https://sepolia.base.org (Coinbase public Base Sepolia). Probe requires tip-1 so tip-only publicnode/Tenderly slots are rejected. Source address is WETH.
- **Disposition:** closed — free archive RPC verified for capture→assemble

### F-GATE-5

- **Claim:** approvalConstraint.allowedSpenders skips Approval(amount=0) revokes; positive grants to non-allowed spenders still violate.
- **Disposition:** closed — CE2 evaluateApprovalConstraint fix


## Honesty

Extract→widen assembled against **live** archive `eth_getProof` (F-GATE-4) and
blackhole K≥5 on a **live Anvil** ProcessHost loaded from the harvested artifact
(F-GATE-2). Admission observed do-nothing/reference on a **live Anvil MiniToken**
world and composed `evaluatePredicates` with no safety override (F-GATE-3, F-GATE-5).
Outcome: `closed-reproducible` with empty-`informationWorlds` composite.
