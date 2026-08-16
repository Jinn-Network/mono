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
import { MIGRATIONS_FILE } from '../earning/store.js';
import {
  FLEET_BOOTSTRAP_PHASES,
  FLEET_BOOTSTRAP_PHASE_INDEX,
  type FleetBootstrapPhase,
} from '../earning/fleet-bootstrap-phase.js';

/** Per-slot boot-probe health (#913). Host masked by the daemon before this point. */
export interface RpcSlotHealthEntry {
  ok: boolean;
  host: string;
  expectedChainId?: number;
  actualChainId?: number;
  latencyMs?: number;
  code?: number;
  reason?: 'chain_mismatch' | 'unreachable' | 'unknown';
  localDev?: true;
}

export interface BootstrapEndpointConfig {
  earningDir: string;
  /** Reads operator-tunable runtime fields (rpcUrl, defaultRpcUrl, rpcUrls,
   *  publicDefaults, rpcSlotHealth, joinedSolverNets) and merges them into the
   *  response so the SPA's Configuration page can render them without a
   *  separate fetch. */
  configReader?: () => {
    rpcUrl?: string;
    defaultRpcUrl?: string;
    rpcUrls?: readonly string[];
    publicDefaults?: readonly string[];
    rpcSlotHealth?: readonly RpcSlotHealthEntry[];
    executionWiring?: readonly unknown[];
    onboardingComplete?: boolean;
  };
}

// The fleet-phase display list. Previously a hand-maintained 14-entry copy
// that silently dropped `awaiting_stake` (issue #2407) — now the single
// typed union from earning/fleet-bootstrap-phase.ts (15 entries: 4
// pre-service phases + all 11 ServiceSteps).
const STEPS = FLEET_BOOTSTRAP_PHASES;
type Step = FleetBootstrapPhase;
const STEP_INDEX = FLEET_BOOTSTRAP_PHASE_INDEX;
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
  fleet_agent_id?: string | null;
  fleet_safe_address?: string | null;
}

interface MigrationArchiveEntryOnDisk {
  retire_status?: string;
  retire_error?: string | null;
  retire_tx_hash?: string | null;
  state_reset_at?: string | null;
  /**
   * True iff the migration explicitly suppressed the local-state wipe because
   * the on-chain retire failed (jinn-mono-hjex.1). Pre-PR archive entries do
   * NOT carry this field, so `wipe_suppressed === true` is the correct filter
   * — `!state_reset_at` would falsely match legacy entries (where state was
   * wiped even though retire failed) and surface a spurious envelope.
   */
  wipe_suppressed?: boolean;
}

interface MigrationArchiveOnDisk {
  entries?: MigrationArchiveEntryOnDisk[];
}

/**
 * Reads the migration archive and returns the most recent retire_error from
 * any entry where the migration explicitly suppressed the local-state wipe
 * (`wipe_suppressed === true`). Pre-PR archive entries lack the field — they
 * are intentionally NOT surfaced because their local state was wiped, so
 * showing a "service state preserved" envelope would mislead the operator.
 */
function readLatestRetireError(earningDir: string): { retire_error: string; tx_hash: string | null } | null {
  const archivePath = join(earningDir, MIGRATIONS_FILE);
  if (!existsSync(archivePath)) return null;
  let archive: MigrationArchiveOnDisk;
  try {
    archive = JSON.parse(readFileSync(archivePath, 'utf-8')) as MigrationArchiveOnDisk;
  } catch {
    return null;
  }
  const entries = archive.entries ?? [];
  // Only surface entries where the wipe was *explicitly* suppressed by this
  // PR's guard. Pre-PR entries have wipe_suppressed=undefined (falsy) and are
  // ignored even though retire_status==='failed' — their state was reset, so
  // the envelope would not apply.
  const failed = entries.filter(
    e => e.retire_status === 'failed' && e.wipe_suppressed === true && e.retire_error,
  );
  if (failed.length === 0) return null;
  const latest = failed[failed.length - 1]!;
  return {
    retire_error: latest.retire_error!,
    tx_hash: latest.retire_tx_hash ?? null,
  };
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

function readFundingGate(earningDir: string): FundingGateOnDisk | null {
  const path = join(earningDir, 'bootstrap-funding.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as FundingGateOnDisk;
  } catch {
    return null;
  }
}

// targetMet is always false in responses where we surface the funding block:
//   - uninitialized branch surfaces it pre-bootstrap, before any balance check
//   - setup branch only surfaces it when fundingGateActive (master balance < target)
// Once the gate clears, callers omit the funding block entirely.
function fundingResponse(gate: FundingGateOnDisk): {
  master_address?: string;
  eth_required?: string;
  eth_balance?: string;
  targetWei: string | undefined;
  targetMet: false;
} {
  return {
    master_address: gate.master_address,
    eth_required: gate.eth_required,
    eth_balance: gate.eth_balance,
    targetWei: fundingTargetWei(gate),
    targetMet: false,
  };
}

export function addBootstrapRoutes(app: Hono, config: BootstrapEndpointConfig): void {
  app.get('/v1/bootstrap', (c) => {
    const path = join(config.earningDir, 'earning_state.json');
    if (!existsSync(path)) {
      // No earning_state.json yet — but the daemon may have exited before
      // writing it (e.g. funding_required before first full run). Surface any
      // persisted bootstrap-error.json and bootstrap-funding.json so the SPA
      // can render actionable states rather than a blank "uninitialized" screen.
      const uninitError = readBootstrapError(config.earningDir);
      const uninitFunding = readFundingGate(config.earningDir);
      // The `funding` block is supplementary. The SPA's Onboarding region
      // surfaces funding details only via the BootstrapErrorCard path (which
      // requires `error` to be present), because the phase-row +
      // AwaitingFundingCard path requires `mode === 'setup'` and a non-empty
      // `master_address`. The error envelope is the canonical display mechanism
      // for the uninitialized window. The funding block is kept in the response
      // because downstream clients may want it; surfacing it directly in
      // Onboarding for the uninitialized case is in-scope for a later PR.
      return c.json({
        schemaVersion: 1,
        mode: 'uninitialized',
        steps: STEPS,
        currentStep: STEPS[0],
        services: [],
        ...(uninitError ? { error: uninitError } : {}),
        ...(uninitFunding ? { funding: fundingResponse(uninitFunding) } : {}),
      });
    }

    let parsed: FleetStateOnDisk;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as FleetStateOnDisk;
    } catch {
      return c.json({ error: 'unreadable_state_file' }, 500);
    }

    const services = parsed.services ?? [];
    const fundingGate = readFundingGate(config.earningDir);
    // `[].every(...)` returns true vacuously, so a fresh fleet (no services
    // yet) was previously treated as "all services running" and the funding
    // gate was suppressed even when bootstrap-funding.json existed. Compute
    // allRunning explicitly and gate funding on it instead.
    const allRunning = services.length > 0 && services.every((s) => RUNNING_STEPS.has(s.step));
    const fundingGateActive =
      Boolean(parsed.master_address) &&
      fundingGate?.master_address?.toLowerCase() === parsed.master_address?.toLowerCase() &&
      !allRunning;
    // Three states map to currentStep:
    //   1. fundingGateActive → 'awaiting_funding' (phase 2 in the panel).
    //   2. funding cleared, services.length === 0 → 'safe_deployed' (phase 3,
    //      subState 'Deploying'). This is the "Stage 1 in flight" window —
    //      the daemon is deploying the fleet Safe, minting agentId, and
    //      binding via setAgentWallet, none of which creates a service row
    //      until Stage 2's distributor.stake() lands. Previously this branch
    //      also returned 'awaiting_funding' which left the panel lying for
    //      30-60s of post-funding bootstrap work. jinn-mono-u34i UX fix.
    //   3. services.length > 0 → first service's step (the normal post-
    //      Stage-2 path).
    const currentStepIdx = fundingGateActive
      ? STEP_INDEX.get('awaiting_funding')!
      : services.length === 0
      ? (parsed.master_address ? STEP_INDEX.get('safe_deployed')! : 0)
      : Math.min(...services.map((s) => STEP_INDEX.get(s.step) ?? 0));
    const currentStep = STEPS[currentStepIdx];

    // Surface the most recent persisted bootstrap-error envelope so the panel
    // can render a "Bootstrap failed at X" state instead of staying frozen on
    // the last persisted step. Cleared at the start of each bootstrap attempt.
    const error = readBootstrapError(config.earningDir);

    // Surface a retire_failed envelope when migration archived a failure but
    // preserved local state. The BootstrapErrorCard (PR-6) will render it;
    // for now we just expose the field so the dashboard can act on it.
    const retireFailed = readLatestRetireError(config.earningDir);

    const cfg = config.configReader?.() ?? {};

    return c.json({
      schemaVersion: 1,
      mode: allRunning ? 'running' : 'setup',
      steps: STEPS,
      currentStep,
      services,
      master_address: parsed.master_address,
      chain: parsed.chain,
      ...(parsed.fleet_agent_id ? { fleet_agent_id: parsed.fleet_agent_id } : {}),
      ...(parsed.fleet_safe_address ? { fleet_safe_address: parsed.fleet_safe_address } : {}),
      ...(cfg.rpcUrl !== undefined ? { rpcUrl: cfg.rpcUrl } : {}),
      ...(cfg.defaultRpcUrl !== undefined ? { defaultRpcUrl: cfg.defaultRpcUrl } : {}),
      ...(cfg.rpcUrls !== undefined ? { rpcUrls: cfg.rpcUrls } : {}),
      ...(cfg.publicDefaults !== undefined ? { publicDefaults: cfg.publicDefaults } : {}),
      ...(cfg.rpcSlotHealth !== undefined ? { rpcSlotHealth: cfg.rpcSlotHealth } : {}),
      ...(cfg.executionWiring !== undefined ? { executionWiring: cfg.executionWiring } : {}),
      ...(cfg.onboardingComplete !== undefined ? { onboardingComplete: cfg.onboardingComplete } : {}),
      ...(fundingGateActive && fundingGate ? { funding: fundingResponse(fundingGate) } : {}),
      ...(error ? { error } : {}),
      ...(retireFailed ? {
        retire_failed: {
          retire_error: retireFailed.retire_error,
          tx_hash: retireFailed.tx_hash,
          message: 'We could not retire your previous setup. Your service state is preserved; resolve the retire failure before upgrading.',
        },
      } : {}),
    });
  });
}
