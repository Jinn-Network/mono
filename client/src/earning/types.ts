import { z } from 'zod';

// ── Staking mode ─────────────────────────────────────────────────────────────

export const StakingModeSchema = z.enum(['standard', 'self-bond']);
export type StakingMode = z.infer<typeof StakingModeSchema>;

// ── Service step progression ─────────────────────────────────────────────────
//
// Standard (stOLAS) mode:
//   awaiting_stake -> staked -> mech_deployed -> complete
//
// Self-bond mode (legacy):
//   awaiting_stake -> service_created -> service_activated -> agents_registered ->
//   service_deployed -> service_staked -> mech_deployed -> complete

export const ServiceStepSchema = z.enum([
  'awaiting_stake',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'staked',
  'mech_deployed',
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
