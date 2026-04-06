---
title: Constants Reference
purpose: reference
scope: [worker, deployment]
last_verified: 2026-01-30
related_code:
  - worker/OlasStakingManager.ts
  - olas-operate-middleware/
keywords: [constants, addresses, contracts, endpoints, configuration]
when_to_read: "When looking up contract addresses, API endpoints, or system constants"
---

# Constants Reference

Contract addresses, endpoints, and other constants used throughout the Jinn system.

---

## Supabase

| Constant | Value |
|----------|-------|
| Project ID | `clnwgxgvmnrkwqdblqgf` |

---

## Base Mainnet Contracts

| Contract | Address |
|----------|---------|
| Mech Marketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |
| AgentsFun1 Staking | `0x2585e63df7BD9De8e058884D496658a030b5c6ce` |

---

## Jinn Staking (Base)

| Contract | Address |
|----------|---------|
| Activity Checker | `0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B` |
| Staking Contract | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` |

**Note:** Nomination uses `addNomineeEVM(address, chainId)` NOT `addNominee`

---

## Ethereum Mainnet Contracts (veOLAS)

| Contract | Address | Purpose |
|----------|---------|---------|
| VoteWeighting | `0x95418b46d5566D3d1ea62C12Aea91227E566c5c1` | Staking nominations |
| veOLAS | `0x7e01A500805f8A52Fad229b3015AD130A332B7b3` | Voting escrow |

### veOLAS Voting Mechanics
- Vote weight decays linearly based on lock expiration (slope-based)
- UI "veOLAS" display = projected OLAS rewards, NOT raw voting power
- Vote cooldown: 10 days per nominee per address
- Generate Safe batches: `yarn tsx scripts/generate-safe-batch.ts` (new lock) or `generate-safe-batch-increase.ts` (add to existing)
- Simulate before execution: `yarn tsx scripts/simulate-safe-batch.ts <safe-address> <json-file>`

---

## Production Endpoints

| Service | URL |
|---------|-----|
| Ponder GraphQL | `https://indexer.jinn.network/graphql` |
| Explorer | `https://indexer.jinn.network/` |

---

## Local Development Endpoints

| Service | URL | Notes |
|---------|-----|-------|
| Ponder GraphQL | `http://localhost:42069/graphql` | Default local port |
| Control API | `http://localhost:4001/graphql` | Requires ERC-8128 signed requests |

---

## Default Configuration Values

| Setting | Default | Description |
|---------|---------|-------------|
| `PONDER_PORT` | `42069` | Local Ponder port |
| `CONTROL_API_PORT` | `4001` | Local Control API port |
| `PONDER_START_BLOCK` | `38187727` | OlasMech Deliver start block |
| Factory scan start | `20,000,000` | ~Jan 2024, covers all Jinn marketplace history |

---

## Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Marketplace response timeout | Configurable (default 61s) | Min/max queried from on-chain marketplace contract |
| Control API stale claim threshold | 5 minutes | After which re-claiming allowed |
| Tool calls per job | ~10-15 | ~5-30s each |
| QuickNode free tier | 15 req/sec | Add 70ms delay between calls |

---

*Keep this file updated when contract addresses or endpoints change.*
