/**
 * warm-operator-preflight — health-check + funding-gap report for the env-suite
 * warm operator (spec/2026-05-31-release-pipeline-two-gate-redesign.md §9, §11).
 *
 * The environment suite (Option B, §9) restores a dedicated, persistent, pre-
 * staked testnet operator's `~/.jinn-client/` from the `testnet-gate` secrets
 * and runs the real-harness loop against it — it NEVER re-bootstraps (bootstrap
 * correctness lives in the hermetic gate). Before the suite runs, this script
 * answers one question: "is the warm operator healthy and funded enough to run,
 * or is this an infra problem to fix before we can trust any verdict?"
 *
 * It is pure orchestration over the existing substrate helpers — it adds no new
 * health logic of its own:
 *   - substrate-adopt   (#531): lands the restored live `~/.jinn-client/` home as
 *                        a gold op-substrate home the doctor/verify/topup modules
 *                        read (they key off `goldPath(opName, root)/manifest.json`).
 *   - substrate-provision (#531 doctor): detects (and, with --repair, fixes) the
 *                        recurring substrate drift (RPC chain, fleet_safe, harness
 *                        config, evaluator role/pool, harness creds).
 *   - substrate-verify:  on-chain assertions (master ETH floor, agentId binding).
 *   - substrate-topup:   reports ETH/USDC funding gaps against the topup targets.
 *
 * Outcome classification (spec §10 — three outcomes, this script owns the
 * infra-blocked split, never product):
 *   - healthy      → exit 0. The suite proceeds.
 *   - infra-blocked → exit EXIT_INFRA_BLOCKED. The warm operator is unhealthy,
 *                     under-funded, or its substrate has un-repairable drift
 *                     (e.g. a missing harness credential / OAuth token, an
 *                     un-fundable master EOA). This is NOT a product red — the
 *                     env-suite workflow maps it to an `infra-blocked` verdict and
 *                     stops, so it shows up on the dashboard as "go fix the
 *                     operator", never as a mystery product failure.
 *   - exit 2       → usage / unexpected crash (the preflight itself is broken).
 *
 * This script makes ZERO product assertions. A green here means "the box is fit
 * to run the suite", nothing about whether the daemon is correct.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { adoptOperator } from './substrate-adopt.js';
import { provisionSubstrate, type ProvisionResult } from './substrate-provision.js';
import { verifySubstrate } from './substrate-verify.js';
import { checkSubstrateTopup } from './substrate-topup.js';
import { serializeVerifyResult, type SerializedVerifyResult, type TopupResult } from './types.js';
import { requestTestnetFunding } from '../../src/earning/faucet.js';

/** Minimal earning-state shape the faucet top-up reads. */
export interface FaucetTargetState {
  master_address?: string;
  agent_address?: string;
  safe_address?: string;
  fleet_safe_address?: string;
  services?: Array<{ agent_address?: string; safe_address?: string }>;
}

/**
 * Resolve the faucet drip targets (master + agent EOAs for ETH gas; the
 * operating Safe for USDC) from an earning state, handling BOTH shapes:
 *   - legacy single-service: top-level `agent_address` / `safe_address`.
 *   - FLEET: the agent EOA lives on the first service, and the operating Safe
 *     IS the fleetSafe (`fleet_safe_address`, verified by the doctor's
 *     fleet-safe-consistency check). Fleet ops carry NO top-level
 *     `agent_address` / `safe_address`, so reading those alone silently skipped
 *     the agent + USDC drips — op-b had to be hand-funded (#1018).
 * Pure + exported so the fleet/legacy resolution is unit-tested.
 */
export function resolveFaucetTargets(state: FaucetTargetState): {
  master?: string;
  agent?: string;
  safe?: string;
} {
  const svc0 = state.services?.[0];
  return {
    master: state.master_address,
    agent: state.agent_address ?? svc0?.agent_address,
    safe: state.fleet_safe_address ?? svc0?.safe_address ?? state.safe_address,
  };
}

/**
 * Best-effort gas top-up from the CDP testnet faucet (shipped creds — no stored
 * private key). Reads the warm operator's master + agent EOAs from its restored
 * earning state and drips each. This is why the env suite needs NO
 * JINN_FUNDER_PRIVATE_KEY: the operator already carries a buffer, and the faucet
 * (0.0001 ETH per address / 24h) keeps it topped at the gate's ~weekly cadence.
 * Rate-limit + error tolerant — a drip failure is NEVER a blocker; the topup
 * check below is the real funding gate.
 */
async function faucetTopUp(jinnClientDir: string): Promise<void> {
  let state: FaucetTargetState = {};
  try {
    state = JSON.parse(readFileSync(path.join(jinnClientDir, 'earning', 'earning_state.json'), 'utf8'));
  } catch {
    return;
  }
  const drip = async (addr: string, token: 'eth' | 'usdc'): Promise<void> => {
    try {
      const r = await requestTestnetFunding(addr, 'base-sepolia', token);
      console.error(
        `[faucet] ${token} ${addr}: ${r.ok ? 'dripped ' + r.txHash : r.rateLimited ? 'rate-limited (24h cap)' : 'skip — ' + r.reason}`,
      );
    } catch (e) {
      console.error(`[faucet] ${token} ${addr}: error ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const { master, agent, safe } = resolveFaucetTargets(state);
  // ETH gas for the master + agent EOAs.
  for (const addr of [master, agent].filter((a): a is string => Boolean(a))) {
    await drip(addr, 'eth');
  }
  // USDC on the operating Safe (legacy substrate balance; checkSubstrateTopup's
  // USDC target is the same Safe). Not consumed by artifact acquisition, which
  // is now a free fetch.
  if (safe) {
    await drip(safe, 'usdc');
  }
}

/**
 * Distinct exit code for an infra-blocked preflight. Chosen to be unambiguous in
 * a shell `if` (not 0, not the generic 1/2) so the env-suite workflow can branch
 * on it and emit the `infra-blocked` verdict rather than a product red. 75 is
 * EX_TEMPFAIL (sysexits.h) — "the operation failed for a transient/environmental
 * reason; the caller is invited to retry", which is exactly the §10 semantics.
 */
export const EXIT_INFRA_BLOCKED = 75;

export interface PreflightOptions {
  /** Op-substrate root the helpers read/write under. Default: ~/jinn-dev. */
  substrateRoot?: string;
  /** Logical op name the warm operator is adopted as. Default: warm-operator. */
  opName?: string;
  /** Restored live `~/.jinn-client/` dir to adopt. Default: ~/.jinn-client. */
  jinnClientDir?: string;
  /** Manifest role recorded for the adopted op. Default: launcher. */
  role?: 'launcher' | 'participant' | 'legacy-backup';
  /** Manifest shape recorded for the adopted op. Default: current. */
  shape?: 'current' | 'pre-fleet';
  /** apiPort recorded in the adopted op's config. Default: 7331. */
  apiPort?: number;
  /** Treat the warm operator as the evaluator (evaluator role + pool checks). */
  isEvaluator?: boolean;
  /** Apply idempotent doctor repairs (RPC chain, fleet_safe, harness config). */
  repair?: boolean;
  /** Optional paid RPC key to prepend to the testnet fallback chain. */
  paidRpcUrl?: string;
  /** Skip on-chain reads (offline smoke of the orchestration only). */
  skipOnChain?: boolean;
}

export type PreflightStatus = 'healthy' | 'infra-blocked';

export interface PreflightReport {
  status: PreflightStatus;
  opName: string;
  /** Human-readable reasons the operator is infra-blocked (empty when healthy). */
  blockers: string[];
  doctor: ProvisionResult;
  verify: SerializedVerifyResult;
  topup: { opName: string; ok: boolean; needs: { resource: string; have: string; want: string }[] };
}

/**
 * Run the warm-operator preflight: adopt the restored home, doctor it, verify it
 * on-chain, and report funding gaps — classifying the result as healthy vs
 * infra-blocked. Does not exit the process (the CLI wrapper does); returns the
 * report so the unit test and the workflow can both consume it.
 */
export async function runWarmOperatorPreflight(opts: PreflightOptions = {}): Promise<PreflightReport> {
  const opName = opts.opName ?? 'warm-operator';
  const jinnClientDir = opts.jinnClientDir ?? path.join(process.env.HOME || os.homedir(), '.jinn-client');
  const blockers: string[] = [];

  // 1. Adopt the restored live home as a gold op-substrate home the helpers read.
  //    This is the same shape `substrate:adopt` produces from a real operator.
  await adoptOperator({
    sourceDir: jinnClientDir,
    opName,
    role: opts.role ?? 'launcher',
    shape: opts.shape ?? 'current',
    apiPort: opts.apiPort ?? 7331,
    substrateRoot: opts.substrateRoot,
  });

  // 2. Doctor: detect (and optionally repair) the recurring substrate drift.
  const doctor = await provisionSubstrate(opName, {
    substrateRoot: opts.substrateRoot,
    repair: opts.repair ?? false,
    isEvaluator: opts.isEvaluator ?? false,
    paidRpcUrl: opts.paidRpcUrl,
    skipOnChain: opts.skipOnChain ?? false,
  });
  if (!doctor.ok) {
    const drifted = doctor.checks.filter((c) => c.status === 'drift').map((c) => `${c.id}: ${c.detail}`);
    blockers.push(`substrate doctor reports unresolved drift: ${drifted.join('; ')}`);
  }

  // 3. Verify: on-chain assertions (master ETH floor, agentId binding).
  const verify = await verifySubstrate(opName, {
    substrateRoot: opts.substrateRoot,
    skipOnChain: opts.skipOnChain ?? false,
  });
  if (!verify.ok) {
    blockers.push(`substrate verify failed: ${verify.failures.join('; ')}`);
  }

  // 4. Self-top-up from the CDP faucet (no stored funder key), THEN check gaps.
  //    The faucet drip is best-effort; a gap that survives it (operator
  //    critically low + faucet can't keep pace) is the real infra blocker.
  let topup: TopupResult | null = null;
  if (!(opts.skipOnChain ?? false)) {
    await faucetTopUp(jinnClientDir);
    topup = await checkSubstrateTopup(opName, { substrateRoot: opts.substrateRoot });
    if (!topup.ok) {
      const gaps = topup.needs.map((n) => `${n.resource} have=${n.have} want=${n.want}`);
      blockers.push(`warm operator under-funded: ${gaps.join('; ')}`);
    }
  }

  const status: PreflightStatus = blockers.length === 0 ? 'healthy' : 'infra-blocked';

  return {
    status,
    opName,
    blockers,
    doctor,
    verify: serializeVerifyResult(verify),
    topup: topup
      ? {
          opName: topup.opName,
          ok: topup.ok,
          needs: topup.needs.map((n) => ({ resource: n.resource, have: n.have.toString(), want: n.want.toString() })),
        }
      : { opName, ok: true, needs: [] },
  };
}

function parseArgs(argv: string[]): PreflightOptions {
  const opts: PreflightOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repair') opts.repair = true;
    else if (a === '--evaluator') opts.isEvaluator = true;
    else if (a === '--skip-on-chain') opts.skipOnChain = true;
    else if (a === '--op-name') opts.opName = argv[++i];
    else if (a === '--jinn-client-dir') opts.jinnClientDir = argv[++i];
    else if (a === '--substrate-root') opts.substrateRoot = argv[++i];
    else if (a === '--api-port') opts.apiPort = parseInt(argv[++i], 10);
    else if (a === '--role') opts.role = argv[++i] as PreflightOptions['role'];
    else if (a === '--shape') opts.shape = argv[++i] as PreflightOptions['shape'];
    else if (a === '--paid-rpc-url') opts.paidRpcUrl = argv[++i];
  }
  return opts;
}

async function cliMain(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runWarmOperatorPreflight(opts);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'infra-blocked') {
    console.error('\n=== warm-operator preflight: INFRA-BLOCKED (not a product failure) ===');
    for (const b of report.blockers) console.error(`  - ${b}`);
    console.error('\nFix the warm operator (fund / repair substrate / refresh OAuth token) and re-run.');
    console.error('This is an infrastructure problem, NOT a release-candidate regression.');
    process.exit(EXIT_INFRA_BLOCKED);
  }
  console.log('\n=== warm-operator preflight: HEALTHY — env suite may proceed ===');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error('warm-operator-preflight crashed:', err);
    process.exit(2);
  });
}
