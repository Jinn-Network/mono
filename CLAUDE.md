# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jinn Network monorepo. Currently in the specification phase — no implementation code yet.

Jinn is a training protocol for state restoration. It defines a loop (Creation → Restoration → Evaluation → Knowledge) where desired states are published with fees, participants attempt restoration, evaluators verify results, and knowledge accumulates to improve future attempts.

## Repository Structure

```
spec/   Dated specification proposals (protocol and implementation)
```

## Architecture (from specs)

Three layers, top to bottom:

1. **DAO Layer (Ethereum Mainnet)** — JINN ERC-20 token, treasury with epoch emissions, ve-JINN gauge for directing emissions to distribution contracts
2. **Distribution Contracts (per-chain)** — Four incentive channels (creation, restoration, outcome, evaluation rewards), read execution layer events, distribute JINN to qualifying participants
3. **Execution Layer (Base, Arbitrum, etc.)** — OLAS Mech Marketplace (Phase 0 request/delivery), ERC-8004 (knowledge discovery/reputation), x402 (payment-gated knowledge access). Phase 0 uses the JinnRouter to mediate marketplace requests and track per-role activity.

Dual incentive model: USDC marketplace layer (demand signal via marketplace escrow) + JINN protocol layer (network rewards via distribution contracts). Anti-farming decay uses locality-sensitive hashing of evidence checkpoints.

## Phased Rollout

- **Phase 0**: Prove on OLAS ecosystem, single chain (Base), OLAS Mech Marketplace + JinnRouter, optimistic evidence, no JINN token
- **Phase 1**: Fair-launch JINN, deploy DAO (multisig → ve-JINN), fork minimal OLAS contract surface, anti-farming + challenge mechanism live
- **Phase 2**: Multi-chain, ZK-requiring distribution contracts, broader governance
- **Phase 3**: Autonomous — full ve-JINN governance, USDC revenue exceeds JINN emissions

## Key Roles

- **Creator** — defines desired states and funds restoration
- **Restorer** — attempts to make desired states true
- **Evaluator** — independently verifies restoration success

## Spec Conventions

Spec files are named `YYYY-MM-DD-<topic>.md` and placed in `spec/`. Each has a version, date, and author in the header.
