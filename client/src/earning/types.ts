import { z } from 'zod';

// ── Staking mode ─────────────────────────────────────────────────────────────

export const StakingModeSchema = z.enum(['standard', 'self-bond']);
export type StakingMode = z.infer<typeof StakingModeSchema>;

// ── Service step progression ─────────────────────────────────────────────────
//
// Standard (stOLAS) mode:
//   awaiting_stake -> staked -> mech_deployed -> agent_registered -> complete
//
// Self-bond mode (legacy):
//   awaiting_stake -> service_created -> service_activated -> agents_registered ->
//   service_deployed -> service_staked -> mech_deployed -> agent_registered -> complete
//
// `agent_registered` is the ERC-8004 IdentityRegistry mint
// (one agent NFT per operator Safe; see
// docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md §4.1).

export const ServiceStepSchema = z.enum([
  'awaiting_stake',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'staked',
  'mech_deployed',
  'agent_registered',
  'complete',
]);

export type ServiceStep = z.infer<typeof ServiceStepSchema>;

// ── Per-service state ────────────────────────────────────────────────────────

export const ServiceStateSchema = z.object({
  index: z.number().int().min(1),
  agent_address: z.string(),
  safe_address: z.string().nullable(),
  service_id: z.number().nullable(),
  mech_address: z.string().nullable(),
  staking_address: z.string().nullable(),
  step: ServiceStepSchema,
  error: z.string().nullable(),

  // ERC-8004 IdentityRegistry mint state (jinn-mono-j07).
  // All optional — missing on legacy state files written before the
  // `agent_registered` step landed; bootstrap fills them on first run.
  // Decimal string because the on-chain `agentId` is a `uint256`.
  agent_id: z.string().nullable().optional().default(null),
  agent_uri: z.string().nullable().optional().default(null),
  identity_registry_address: z.string().nullable().optional().default(null),
  agent_registered_tx: z.string().nullable().optional().default(null),
  // True once `IdentityRegistry.setAgentWallet` succeeds for this Safe.
  // Currently always `false` — wallet binding is deferred to a follow-up
  // bead (Safe ERC-1271 wrapping); see bootstrap.ts `stepRegisterAgent`.
  safe_bound_to_agent: z.boolean().nullable().optional().default(false),
});

export type ServiceState = z.infer<typeof ServiceStateSchema>;

// ── Fleet state (top-level) ──────────────────────────────────────────────────

export const FleetStateSchema = z.object({
  master_address: z.string().nullable(),
  chain: z.enum(['base', 'base-sepolia']),
  staking_mode: StakingModeSchema.default('standard'),
  services: z.array(ServiceStateSchema),
  updated_at: z.string(),
});

export type FleetState = z.infer<typeof FleetStateSchema>;

// ── Factories ────────────────────────────────────────────────────────────────

export function createDefaultFleetState(chain: 'base' | 'base-sepolia' = 'base'): FleetState {
  return {
    master_address: null,
    chain,
    staking_mode: 'standard',
    services: [],
    updated_at: new Date().toISOString(),
  };
}

export function createDefaultServiceState(index: number, agentAddress: string): ServiceState {
  return {
    index,
    agent_address: agentAddress,
    safe_address: null,
    service_id: null,
    mech_address: null,
    staking_address: null,
    step: 'awaiting_stake',
    error: null,
    agent_id: null,
    agent_uri: null,
    identity_registry_address: null,
    agent_registered_tx: null,
    safe_bound_to_agent: false,
  };
}

// ── Result types ─────────────────────────────────────────────────────────────

export interface FundingRequirement {
  master_address: string;
  eth_required: string;
  eth_balance: string;
}

export interface SelfBondFundingRequirement {
  agent_address: string;
  agent_eth_required: string;
  agent_eth_balance: string;
  safe_address: string;
  safe_eth_required: string;
  safe_eth_balance: string;
  safe_olas_required: string;
  safe_olas_balance: string;
}

export interface FleetBootstrapResult {
  ok: boolean;
  fleet_state: FleetState;
  message: string;
  funding?: FundingRequirement;
  self_bond_funding?: SelfBondFundingRequirement;
}
