import { z } from 'zod';

/**
 * Earning bootstrap step progression:
 *   wallet -> safe_predicted -> awaiting_funding -> safe_deployed ->
 *   service_created -> service_activated -> agents_registered ->
 *   service_deployed -> service_staked -> mech_deployed -> complete
 */
export const EarningStepSchema = z.enum([
  'wallet',
  'safe_predicted',
  'awaiting_funding',
  'safe_deployed',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'mech_deployed',
  'complete',
]);

export type EarningStep = z.infer<typeof EarningStepSchema>;

/**
 * Ordered list for state machine progression.
 * Index determines which steps have been completed.
 */
export const EARNING_STEP_ORDER: readonly EarningStep[] = [
  'wallet',
  'safe_predicted',
  'awaiting_funding',
  'safe_deployed',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'mech_deployed',
  'complete',
] as const;

export const EarningStateSchema = z
  .object({
    step: EarningStepSchema,
    agent_address: z.string().nullable(),
    safe_address: z.string().nullable(),
    service_id: z.number().nullable(),
    mech_address: z.string().nullable(),
    staking_address: z.string().nullable(),
    chain: z.literal('base'),
    error: z.string().nullable(),
    updated_at: z.string(),
  })
  .strict();

export type EarningState = z.infer<typeof EarningStateSchema>;

export function createDefaultEarningState(): EarningState {
  return {
    step: 'wallet',
    agent_address: null,
    safe_address: null,
    service_id: null,
    mech_address: null,
    staking_address: null,
    chain: 'base',
    error: null,
    updated_at: new Date().toISOString(),
  };
}

export interface FundingRequirement {
  eoa_address: string;
  eoa_eth_required: string;
  eoa_eth_balance: string;
  safe_address: string;
  safe_olas_required: string;
  safe_olas_balance: string;
}

export interface EarningBootstrapResult {
  ok: boolean;
  step: EarningStep;
  earning_state: EarningState;
  message: string;
  funding?: FundingRequirement;
}

export interface EarningStepChangedEvent {
  from: EarningStep;
  to: EarningStep;
  at: string;
}
