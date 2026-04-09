# HD Wallet Fleet Architecture

**Date**: 2026-04-09
**Author**: adrianobradley + Claude
**Status**: Draft

## Summary

Replace the single-key wallet with an HD (mnemonic-based) wallet that derives a master funder address and per-service agent addresses. Evolve the earning state from single-service to multi-service. Operators fund one address, set `targetServices`, and the client handles the rest.

## Background

The OLAS service registry requires a unique agent instance address per service. The current client ties "the wallet you fund" to "the agent instance on-chain," making multi-service operation require separate earning directories and wallets. With stOLAS eliminating the OLAS capital requirement, the remaining friction is wallet management.

This design replaces the jinn-node operate middleware wallet hierarchy with a simpler HD derivation scheme native to this client.

## Wallet Architecture

### HD Derivation

A BIP-39 mnemonic is generated on first run, encrypted with `JINN_PASSWORD` via scrypt (same as current keystore v3 format), and saved as `~/.jinn-client/earning/master_keystore.json`.

Derivation paths:
- **Index 0** (`m/44'/60'/0'/0/0`): Master wallet. Operator funds this address. Calls `distributor.stake()`, distributes gas to agents. Never registered as an agent instance.
- **Index 1+** (`m/44'/60'/0'/0/N`): Agent wallets. Each is the `agentInstance` for one service. Gets a Safe created by the distributor. Receives gas from master.

### Backup

The mnemonic is the single backup. All keys are deterministically derived, so the operator can reconstruct everything from the mnemonic + on-chain state.

### Encryption

Same pattern as today: `JINN_PASSWORD` decrypts the mnemonic at runtime. Derived keys exist only in memory. The mnemonic never touches disk unencrypted.

## State Schema

The earning state evolves from single-service to multi-service:

```typescript
interface EarningState {
  // Master wallet
  master_address: string | null;

  // Global config
  chain: 'base' | 'base-sepolia';
  staking_mode: 'standard' | 'self-bond';

  // Per-service state
  services: ServiceState[];

  updated_at: string;
}

interface ServiceState {
  index: number;              // HD derivation index (1+)
  agent_address: string;      // derived from mnemonic
  safe_address: string | null;
  service_id: number | null;
  mech_address: string | null;
  staking_address: string | null;
  step: EarningStep;
  error: string | null;
}
```

The `step` field moves from top-level to per-service. Each service bootstraps independently through the same step progression.

State file location: `~/.jinn-client/earning/earning_state.json` (unchanged).
Keystore file: `~/.jinn-client/earning/master_keystore.json` (replaces `agent_keystore.json`).

## Bootstrap Flow

### Phase 1: Master setup (runs once)

1. Generate BIP-39 mnemonic
2. Encrypt with `JINN_PASSWORD`, save as `master_keystore.json`
3. Derive master address (index 0), display to operator
4. Check master address has sufficient ETH for gas
5. If underfunded, pause at `awaiting_funding` with master address and required amount

### Phase 2: Service bootstrap (runs per service)

For each service where `services.length < targetServices`:

1. Derive agent address at next index (`services.length + 1`)
2. Add service entry to state with `step: 'awaiting_stake'`
3. Master EOA calls `distributor.stake(stakingContract, 0, agentId, configHash, derivedAgentAddress)`
4. Parse `CreateService` and `CreateMultisigWithAgents` events from receipt
5. Update service entry with `service_id`, `safe_address`
6. Master EOA sends gas ETH to derived agent address
7. Derived agent deploys mech via its Safe
8. Mark service `step: 'complete'`

### Idempotency

On re-run:
- If mnemonic keystore exists, skip generation
- If master is funded, skip funding gate
- For each service, check on-chain state and resume from current step
- Only create new services if `services.length < targetServices`

## Config

New/changed fields:

| Config key | Env override | Default | Description |
|------------|-------------|---------|-------------|
| targetServices | JINN_TARGET_SERVICES | 1 | Number of services to bootstrap |

Existing fields unchanged. `stakingMode` defaults to `'standard'` (stOLAS) as already implemented.

## Operator Experience

### First run

```
$ JINN_PASSWORD=secret npm start

[main] No wallet found. Generating new mnemonic...
[main] Master address: 0xABC...
[main] Fund this address with ETH, then re-run.
```

### After funding

```
$ JINN_PASSWORD=secret npm start

[main] Master balance: 0.05 ETH
[earning] Bootstrapping 1 service...
[earning] Service 1: stOLAS stake() confirmed
[earning] Service 1: mech deployed
[earning] Bootstrap complete. 1/1 services running.
[daemon] Starting daemon loops...
```

### Adding services

```
$ JINN_TARGET_SERVICES=3 JINN_PASSWORD=secret npm start

[earning] 1/3 services already complete
[earning] Bootstrapping 2 new services...
[earning] Service 2: stOLAS stake() confirmed
[earning] Service 3: stOLAS stake() confirmed
[earning] Bootstrap complete. 3/3 services running.
```

## Migration

Existing operators with a `agent_keystore.json` (single private key): on first run after upgrade, the client detects the old keystore format and logs a message explaining they need to start fresh with a mnemonic. The old keystore and state are preserved (not deleted) but a new mnemonic must be generated. The existing service (602) remains staked on-chain and can be managed manually if needed.

No automated migration of the old single-key to an HD wallet — they're fundamentally different key types. The old files are renamed with a `.legacy` suffix and the new mnemonic keystore + state file are created in their place.

## Scope Boundaries

**In scope:**
- Mnemonic-based HD wallet (master at index 0, agents at index 1+)
- Multi-service state schema
- Master EOA as funder, derived agents as service instances
- `targetServices` config field
- stOLAS as default bootstrap path
- Master sends gas to derived agents during bootstrap

**Out of scope (follow-up):**
- Daemon running loops for multiple services simultaneously
- Ongoing fund distribution (master auto-topping agents with gas over time)
- `export-mnemonic` CLI command
- Self-bond mode with HD wallet (self-bond continues with current single-key flow until deprecated)
