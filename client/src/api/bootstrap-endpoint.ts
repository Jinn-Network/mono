/**
 * GET /v1/bootstrap — exposes the fleet bootstrap state machine to the SPA.
 *
 * Reads the persisted fleet state file at `<earningDir>/earning_state.json`
 * (the same file FleetStateStore writes) and returns:
 * - mode: 'uninitialized' | 'setup' | 'running'
 * - currentStep: the lowest-progress step across all services
 * - per-service step status
 *
 * No external chain reads — state file is the source of truth for this endpoint.
 */
import type { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBootstrapError } from '../errors/persisted-bootstrap-error.js';

export interface BootstrapEndpointConfig {
  earningDir: string;
  /** Reads operator-tunable runtime fields (rpcUrl, defaultRpcUrl,
   *  solverNets, joinedSolverNets) and merges them into the response so the SPA's
   *  Configuration page can render them without a separate fetch. */
  configReader?: () => {
    rpcUrl?: string;
    defaultRpcUrl?: string;
    solverNets?: Record<string, unknown>;
    joinedSolverNets?: Record<string, unknown>;
  };
}

const STEPS = [
  'wallet',
  'safe_predicted',
  'awaiting_funding',
  'safe_deployed',
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
] as const;

type Step = typeof STEPS[number];
const STEP_INDEX = new Map<Step, number>(STEPS.map((s, i) => [s, i]));
const RUNNING_STEPS = new Set<Step>(['safe_binding_pending', 'complete']);

interface ServiceState {
  index: number;
  step: Step;
  safe_address?: string;
  service_id?: number;
}

interface FleetStateOnDisk {
  master_address?: string;
  chain?: string;
  services?: ServiceState[];
}

interface FundingGateOnDisk {
  master_address?: string;
  eth_required?: string;
  eth_balance?: string;
}

function fundingTargetWei(fundingGate: FundingGateOnDisk): string | undefined {
  const required = fundingGate.eth_required;
  const balance = fundingGate.eth_balance;
  if (required === undefined || balance === undefined) return undefined;
  if (!/^\d+$/.test(required) || !/^\d+$/.test(balance)) return undefined;
  return (BigInt(required) + BigInt(balance)).toString();
}

export function addBootstrapRoutes(app: Hono, config: BootstrapEndpointConfig): void {
  app.get('/v1/bootstrap', (c) => {
    const path = join(config.earningDir, 'earning_state.json');
    if (!existsSync(path)) {
      return c.json({
        schemaVersion: 1,
        mode: 'uninitialized',
        steps: STEPS,
        currentStep: STEPS[0],
        services: [],
      });
    }

    let parsed: FleetStateOnDisk;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as FleetStateOnDisk;
    } catch {
      return c.json({ error: 'unreadable_state_file' }, 500);
    }

    const services = parsed.services ?? [];
    let fundingGate: FundingGateOnDisk | null = null;
    const fundingGatePath = join(config.earningDir, 'bootstrap-funding.json');
    if (existsSync(fundingGatePath)) {
      try {
        fundingGate = JSON.parse(readFileSync(fundingGatePath, 'utf-8')) as FundingGateOnDisk;
      } catch {
        fundingGate = null;
      }
    }
    // `[].every(...)` returns true vacuously, so a fresh fleet (no services
    // yet) was previously treated as "all services running" and the funding
    // gate was suppressed even when bootstrap-funding.json existed. Compute
    // allRunning explicitly and gate funding on it instead.
    const allRunning = services.length > 0 && services.every((s) => RUNNING_STEPS.has(s.step));
    const fundingGateActive =
      Boolean(parsed.master_address) &&
      fundingGate?.master_address?.toLowerCase() === parsed.master_address?.toLowerCase() &&
      !allRunning;
    const currentStepIdx = fundingGateActive
      ? STEP_INDEX.get('awaiting_funding')!
      : services.length === 0
      ? (parsed.master_address ? STEP_INDEX.get('awaiting_funding')! : 0)
      : Math.min(...services.map((s) => STEP_INDEX.get(s.step) ?? 0));
    const currentStep = STEPS[currentStepIdx];

    // Surface the most recent persisted bootstrap-error envelope so the panel
    // can render a "Bootstrap failed at X" state instead of staying frozen on
    // the last persisted step. Cleared at the start of each bootstrap attempt.
    const error = readBootstrapError(config.earningDir);

    const cfg = config.configReader?.() ?? {};

    return c.json({
      schemaVersion: 1,
      mode: allRunning ? 'running' : 'setup',
      steps: STEPS,
      currentStep,
      services,
      master_address: parsed.master_address,
      chain: parsed.chain,
      ...(cfg.rpcUrl !== undefined ? { rpcUrl: cfg.rpcUrl } : {}),
      ...(cfg.defaultRpcUrl !== undefined ? { defaultRpcUrl: cfg.defaultRpcUrl } : {}),
      ...(cfg.solverNets !== undefined ? { solverNets: cfg.solverNets } : {}),
      ...(cfg.joinedSolverNets !== undefined ? { joinedSolverNets: cfg.joinedSolverNets } : {}),
      ...(fundingGateActive && fundingGate ? {
        funding: {
          master_address: fundingGate.master_address,
          eth_required: fundingGate.eth_required,
          eth_balance: fundingGate.eth_balance,
          targetWei: fundingTargetWei(fundingGate),
        },
      } : {}),
      ...(error ? { error } : {}),
    });
  });
}
