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
    const fundingGateActive =
      Boolean(parsed.master_address) &&
      fundingGate?.master_address?.toLowerCase() === parsed.master_address?.toLowerCase() &&
      !services.every((s) => RUNNING_STEPS.has(s.step));
    const currentStepIdx = fundingGateActive
      ? STEP_INDEX.get('awaiting_funding')!
      : services.length === 0
      ? (parsed.master_address ? STEP_INDEX.get('awaiting_funding')! : 0)
      : Math.min(...services.map((s) => STEP_INDEX.get(s.step) ?? 0));
    const currentStep = STEPS[currentStepIdx];
    const allRunning = services.length > 0 && services.every((s) => RUNNING_STEPS.has(s.step));

    // Surface the most recent persisted bootstrap-error envelope so the panel
    // can render a "Bootstrap failed at X" state instead of staying frozen on
    // the last persisted step. Cleared at the start of each bootstrap attempt.
    const error = readBootstrapError(config.earningDir);

    return c.json({
      schemaVersion: 1,
      mode: allRunning ? 'running' : 'setup',
      steps: STEPS,
      currentStep,
      services,
      master_address: parsed.master_address,
      chain: parsed.chain,
      ...(error ? { error } : {}),
    });
  });
}
