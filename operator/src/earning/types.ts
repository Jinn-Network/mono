import { z } from 'zod/v3';

// ── Staking mode ─────────────────────────────────────────────────────────────

export const StakingModeSchema = z.enum(['standard', 'self-bond']);
export type StakingMode = z.infer<typeof StakingModeSchema>;

// ── Fleet bootstrap stage marker (nghf) ─────────────────────────────────────
//
// `none`         — fresh fleet; no identity provisioned yet.
// `stage1`       — fleet-level identity is provisioned (Safe deployed, agentId
//                  minted, setAgentWallet bound). Builder-only completion.
// `stage1_and_2` — at least one service row has reached `complete` /
//                  `safe_binding_pending`. Full operator completion.
//
// See docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §5.1
// and docs/superpowers/specs/2026-05-14-nghf-staged-bootstrap-fit-findings.md.
export const FleetStageSchema = z.enum(['none', 'stage1', 'stage1_and_2']);
export type FleetStage = z.infer<typeof FleetStageSchema>;

// ── Service step progression ─────────────────────────────────────────────────
//
// Standard (stOLAS) mode:
//   awaiting_stake -> staked -> mech_deployed -> agent_registered ->
//   safe_binding_pending -> complete
//
// Self-bond mode (legacy):
//   awaiting_stake -> service_created -> service_activated -> agents_registered ->
//   service_deployed -> service_staked -> mech_deployed -> agent_registered ->
//   safe_binding_pending -> complete
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
  'safe_binding_pending',
  'complete',
]);

export type ServiceStep = z.infer<typeof ServiceStepSchema>;

export const OPERATIONAL_SERVICE_STEPS = new Set<ServiceStep>([
  'safe_binding_pending',
  'complete',
]);

export const STAKED_LIKE_SERVICE_STEPS = new Set<ServiceStep>([
  'staked',
  'mech_deployed',
  'agent_registered',
  'safe_binding_pending',
  'complete',
  'service_staked',
]);

export function isOperationalServiceStep(step: ServiceStep | string): boolean {
  return step === 'complete' || step === 'safe_binding_pending';
}

export function isStakedLikeServiceStep(step: ServiceStep | string): boolean {
  return STAKED_LIKE_SERVICE_STEPS.has(step as ServiceStep);
}

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

  // ERC-8004 IdentityRegistry mint state.
  //
  // Populated by the operator-NFT mint step at bootstrap (jinn-mono-j07,
  // see bootstrap.ts `stepRegisterAgent`). Read in main.ts (jinn-mono-3zk)
  // to construct an `IdentityPublisher` for the engine when bootstrap has
  // produced an agentId.
  //
  // All optional — missing on legacy state files written before the mint
  // step landed; the daemon defensively skips publishing when `agent_id`
  // is null. Decimal string because the on-chain `agentId` is `uint256`.
  agent_id: z.string().nullable().optional().default(null),
  agent_uri: z.string().nullable().optional().default(null),
  identity_registry_address: z.string().nullable().optional().default(null),
  agent_registered_tx: z.string().nullable().optional().default(null),
  // True once `IdentityRegistry.setAgentWallet` succeeds for this Safe.
  // Currently always `false` — wallet binding is deferred to jinn-mono-aev
  // (Safe ERC-1271 wrapping).
  safe_bound_to_agent: z.boolean().nullable().optional().default(false),

  // Structured diagnostics for safe_binding_failed errors (jinn-mono-hjex.4).
  // Optional — absent on state files written before this field was added.
  // `error_revert_reason` is the decoded contract Error(string) payload or
  // named custom error name; null when the revert had no reason data.
  // `error_short_message` is the concise one-liner from viem's BaseError.
  error_revert_reason: z.string().nullable().optional().default(null),
  error_short_message: z.string().nullable().optional().default(null),
});

export type ServiceState = z.infer<typeof ServiceStateSchema>;

// ── Fleet state (top-level) ──────────────────────────────────────────────────

export const FleetStateSchema = z.object({
  master_address: z.string().nullable(),
  chain: z.enum(['base', 'base-sepolia']),
  staking_mode: StakingModeSchema.default('standard'),
  services: z.array(ServiceStateSchema),
  updated_at: z.string(),

  // ── Fleet-level Stage 1 identity (nghf) ─────────────────────────────────
  //
  // These four fields are added so a fleet can carry ERC-8004 identity
  // independently of any service row, enabling builder-only (services: [])
  // operation. Stage 1 always uses the self-bond Safe topology
  // (deterministic prediction from the HD-index-1 agent EOA) regardless of
  // the eventual staking mode — in standard mode, Stage 2 later creates a
  // separate staking Safe via `distributor.stake()`, so dual-role operators
  // end up with two Safes. See findings §8 (Option A).
  fleet_agent_id: z.string().nullable().optional().default(null),
  fleet_safe_address: z.string().nullable().optional().default(null),
  fleet_identity_registry: z.string().nullable().optional().default(null),
  fleet_stage: FleetStageSchema.optional().default('none'),
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
    fleet_agent_id: null,
    fleet_safe_address: null,
    fleet_identity_registry: null,
    fleet_stage: 'none',
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
    error_revert_reason: null,
    error_short_message: null,
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
  /** Raw underlying error message, preserved when `ok` is false so the
   *  envelope-side error formatter has not yet collapsed the diagnostic.
   *  See `operator-errors.ts` and jinn-mono-jz9f. */
  rawErrorMessage?: string;
  funding?: FundingRequirement;
  self_bond_funding?: SelfBondFundingRequirement;
  /**
   * Structured category for operator-error cases where the error type is
   * known but comes from an exception (rather than the early-return funding
   * gate above). Currently used to propagate `'insufficient_funds'` so the
   * error envelope in main.ts can surface a structured `category` field
   * instead of a prose disjunction. jinn-mono-hjex.6
   */
  errorCategory?: 'insufficient_funds' | 'gas_too_low' | 'nonce_conflict';
  /**
   * Transaction hash of the failed on-chain tx, when available.
   * Extracted from the thrown error message in the bootstrap catch path.
   * Surfaced in the fatal envelope `details.txHash` so the SPA can render
   * a block-explorer link. jinn-mono-hjex reviewer fix.
   */
  txHash?: string | null;
}
