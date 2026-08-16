/**
 * substrate-provision — idempotent doctor for gold op-substrate homes.
 *
 * Issue #531 (v0.1.8 release-readiness sweep): getting release-readiness
 * Tier 2/3 to a real green repeatedly required the same operator-local,
 * one-time fixes to the gold homes (`~/jinn-dev/operators/op-{a,b}`).
 * None of it is repo state — it is operator-local substrate setup that was
 * discovered ad hoc and re-done by hand every run. This doctor detects and
 * (with `--repair`) fixes that drift idempotently so Tier 2/3 is reproducible
 * on any machine and is a prerequisite for ever running it autonomously / in CI.
 *
 * The five recurring drift categories (all hit as manual one-offs):
 *   1. RPC fallback chain     — config.rpcUrl must be a multi-provider chain
 *                               (testnet default DEFAULT_TESTNET_RPC_URLS, with
 *                               an optional paid key prepended), NOT a single
 *                               quota-limited endpoint. The manifest's single
 *                               config.rpcUrl (read by substrate-verify via one
 *                               `http()`) must be a working endpoint — kept as
 *                               the first slot of the chain.
 *   2. fleet_safe consistency — manifest.operator.fleetSafeAddress and
 *                               earning_state.fleet_safe_address must equal the
 *                               on-chain IdentityRegistry.getAgentWallet(fleetAgentId).
 *                               A stale value fails substrate-verify.
 *   3. Harness config         — each joinedSolverNets entry must use a learner
 *                               harness with CLI-session auth (default
 *                               claude-code-learner / claude-haiku-4-5) so the
 *                               per-SolverNet readiness gate does not gate ALL
 *                               of an op's claims for want of an API key.
 *   4. Evaluator role + pool  — the evaluator op needs the `evaluator` role on
 *                               its joinedSolverNets entry, the evaluator harness
 *                               state seeded, and a validated-pool.json admission
 *                               file (without it every swe-rebench-v2 task fails
 *                               admission as `admission_missing_or_unscorable`).
 *   5. Harness creds          — the configured solve harness's credential must be
 *                               present (CLI session for claude-code-learner; an
 *                               auth.json / API key for codex / hermes), else the
 *                               readiness gate gates all claims.
 *
 * Design: a doctor, not a from-scratch provisioner. It never bootstraps a wallet
 * or touches funds — `substrate-adopt` / the earning bootstrap own that. It only
 * reconciles the post-bootstrap substrate to a Tier-2/3-ready resting state.
 * Detect-only by default; pass `--repair` to apply fixes.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { goldPath } from './substrate-paths.js';
import { loadManifestSafe, type Manifest } from './types.js';
import { chainForNetwork } from './substrate-verify.js';
import { DEFAULT_TESTNET_RPC_URLS } from '../../src/config.js';
import { canonicalHarnessName } from '../../src/harnesses/names.js';
import { EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
// The instance the T3.1 real-harness loop actually submits — single source of
// truth shared with the gate's evaluator preflight (admission-pool-fixture check).
import { KNOWN_INSTANCE_ID } from '../../test/release/tier-2/fixtures/known-instance.js';

const IDENTITY_REGISTRY_ABI = parseAbi([
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);

/** The team's chosen swe-rebench solve harness — CLI session auth, no API key. */
export const DEFAULT_SOLVE_HARNESS = 'claude-code-learner';
export const DEFAULT_SOLVE_MODEL = 'claude-haiku-4-5-20251001';
/** Directory name (under engine/impl-state) where the evaluator harness keeps
 *  its state.json and the validated-pool.json admission file. Mirrors the
 *  `name` of SweRebenchV2EvaluatorHarness and main.ts's implStateDir join. */
export const EVALUATOR_STATE_DIR_NAME = 'swe-rebench-v2-evaluator';
const EVALUATOR_STATE_FILE = 'state.json';
const ADMISSION_FILE = 'validated-pool.json';
const ADMISSION_SCHEMA_VERSION = 'swe-rebench-v2-validated-pool.v1';

export type CheckStatus = 'ok' | 'drift' | 'repaired' | 'skipped';

export interface CheckResult {
  /** Stable id for the drift category. */
  id:
    | 'rpc-fallback-chain'
    | 'manifest-rpc-endpoint'
    | 'fleet-safe-consistency'
    | 'harness-config'
    | 'evaluator-role'
    | 'evaluator-harness-state'
    | 'admission-pool'
    | 'admission-pool-fixture'
    | 'harness-creds';
  status: CheckStatus;
  detail: string;
}

export interface ProvisionResult {
  opName: string;
  /** true if, after this run, the home has no remaining drift. */
  ok: boolean;
  checks: CheckResult[];
}

export interface ProvisionOptions {
  substrateRoot?: string;
  /** false = detect only (default); true = apply repairs. */
  repair?: boolean;
  /** Skip the on-chain fleet_safe reconcile (offline / unit tests). */
  skipOnChain?: boolean;
  /** Treat this op as the evaluator (needs evaluator role + harness state + pool). */
  isEvaluator?: boolean;
  /** Solve harness to enforce on joinedSolverNets entries. */
  harness?: string;
  /** Model to enforce on joinedSolverNets entries. */
  model?: string;
  /** Optional paid RPC key to PREPEND to the testnet fallback chain. */
  paidRpcUrl?: string;
  /**
   * Predicate that reports whether the configured solve harness's credential
   * is present. Injectable so the unit test does not depend on the host's
   * `~/.claude` / `~/.codex`. Defaults to a filesystem probe.
   */
  hasHarnessCreds?: (harness: string) => Promise<boolean>;
  /**
   * Idempotently enable the SWE-rebench v2 evaluator harness in the given impl
   * state directory. Production uses the harness's real onEnable() path
   * (Docker/Python validation + upstream git clone); tests inject a fake so the
   * doctor stays unit-fast and offline.
   */
  enableEvaluatorHarness?: (implStateDir: string) => Promise<{ status: string; message?: string; details?: unknown; action?: { description?: string } }>;
}

interface OperatorConfig {
  rpcUrl?: string | string[];
  apiPort?: number;
  evaluator?: { enabled?: boolean };
  executionWiring?: ExecutionWiringRow[];
  [k: string]: unknown;
}

interface ExecutionWiringRow {
  workKind?: string;
  harness?: string;
  model?: string;
  legacyManifestDigest?: string;
  [k: string]: unknown;
}

interface EarningState {
  fleet_agent_id?: string;
  fleet_safe_address?: string;
  fleet_identity_registry?: string;
  [k: string]: unknown;
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultEnableEvaluatorHarness(
  implStateDir: string,
): Promise<{ status: string; message?: string; details?: unknown; action?: { description?: string } }> {
  const { SweRebenchV2EvaluatorHarness } = await import(
    '../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js'
  );
  const harness = new SweRebenchV2EvaluatorHarness({ implStateDir });
  return harness.onEnable({ runtimePlugins: [], args: {} });
}

/** The canonical testnet fallback chain, optionally with a paid key prepended. */
export function buildRpcChain(paidRpcUrl?: string): string[] {
  const base = [...DEFAULT_TESTNET_RPC_URLS];
  if (paidRpcUrl && paidRpcUrl.trim() && !base.includes(paidRpcUrl.trim())) {
    return [paidRpcUrl.trim(), ...base];
  }
  return base;
}

/** True if `rpcUrl` is already a multi-provider chain whose slots cover the
 *  canonical testnet defaults (a single string, or an array missing a default
 *  slot, is drift). */
export function rpcChainIsHealthy(rpcUrl: string | string[] | undefined): boolean {
  if (!Array.isArray(rpcUrl)) return false;
  if (rpcUrl.length < 2) return false;
  return DEFAULT_TESTNET_RPC_URLS.every((u) => rpcUrl.includes(u));
}

/**
 * Default harness-creds probe. claude-code-learner authenticates via a
 * `CLAUDE_CODE_OAUTH_TOKEN` (the `claude setup-token` subscription token — the
 * env-based auth path used by the hosted operator and this suite's solve step),
 * an `ANTHROPIC_API_KEY`, or a logged-in `~/.claude` CLI session; codex needs
 * `~/.codex/auth.json` (or an OPENAI_API_KEY); hermes needs OPENROUTER_API_KEY.
 */
async function defaultHasHarnessCreds(harness: string): Promise<boolean> {
  const canonical = canonicalHarnessName(harness);
  const home = process.env.HOME ?? '';
  if (canonical === 'claude-code') {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
    return fs.stat(path.join(home, '.claude')).then(() => true).catch(() => false);
  }
  if (canonical === 'codex') {
    if (process.env.OPENAI_API_KEY) return true;
    const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
    return fs.stat(path.join(codexHome, 'auth.json')).then(() => true).catch(() => false);
  }
  if (canonical === 'hermes-agent') {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }
  return true;
}

export async function provisionSubstrate(opName: string, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  const repair = opts.repair ?? false;
  const harness = opts.harness ?? DEFAULT_SOLVE_HARNESS;
  const model = opts.model ?? DEFAULT_SOLVE_MODEL;
  const hasHarnessCreds = opts.hasHarnessCreds ?? defaultHasHarnessCreds;
  const checks: CheckResult[] = [];

  const opDir = goldPath(opName, opts.substrateRoot);
  const jinnDir = path.join(opDir, '.jinn-client');
  const cfgPath = path.join(jinnDir, 'config.json');
  const earningPath = path.join(jinnDir, 'earning', 'earning_state.json');
  const implStateRoot = path.join(jinnDir, 'engine', 'impl-state');

  const loaded = await loadManifestSafe(opDir);
  if (!loaded.ok) {
    checks.push({ id: 'rpc-fallback-chain', status: 'skipped', detail: loaded.error });
    return { opName, ok: false, checks };
  }
  const manifest = loaded.manifest;

  const cfg = (await readJson<OperatorConfig>(cfgPath)) ?? {};
  let cfgDirty = false;

  // ── 1. RPC fallback chain (config.rpcUrl) ──────────────────────────────
  {
    if (rpcChainIsHealthy(cfg.rpcUrl)) {
      checks.push({ id: 'rpc-fallback-chain', status: 'ok', detail: `chain of ${(cfg.rpcUrl as string[]).length} providers` });
    } else if (repair) {
      cfg.rpcUrl = buildRpcChain(opts.paidRpcUrl);
      cfgDirty = true;
      checks.push({ id: 'rpc-fallback-chain', status: 'repaired', detail: `set ${(cfg.rpcUrl as string[]).length}-provider chain` });
    } else {
      const shape = Array.isArray(cfg.rpcUrl) ? `array(${cfg.rpcUrl.length})` : typeof cfg.rpcUrl;
      checks.push({ id: 'rpc-fallback-chain', status: 'drift', detail: `config.rpcUrl is ${shape}, want multi-provider chain` });
    }
  }

  // ── 1b. Manifest RPC endpoint (single working http() endpoint) ─────────
  {
    const chain = Array.isArray(cfg.rpcUrl) ? cfg.rpcUrl : rpcChainIsHealthy(cfg.rpcUrl) ? cfg.rpcUrl : buildRpcChain(opts.paidRpcUrl);
    const want = (Array.isArray(chain) ? chain[0] : chain) ?? DEFAULT_TESTNET_RPC_URLS[0];
    if (manifest.config.rpcUrl === want) {
      checks.push({ id: 'manifest-rpc-endpoint', status: 'ok', detail: `manifest endpoint = ${want}` });
    } else if (repair) {
      manifest.config.rpcUrl = want;
      await writeJson(path.join(opDir, 'manifest.json'), manifest);
      checks.push({ id: 'manifest-rpc-endpoint', status: 'repaired', detail: `manifest endpoint → ${want}` });
    } else {
      checks.push({ id: 'manifest-rpc-endpoint', status: 'drift', detail: `manifest endpoint ${manifest.config.rpcUrl} != head ${want}` });
    }
  }

  // ── 2. fleet_safe consistency (on-chain reconcile) ─────────────────────
  await checkFleetSafe(opName, manifest, earningPath, opDir, checks, { repair, skipOnChain: opts.skipOnChain ?? false });

  // ── 3 + 4. Harness config + evaluator enablement across executionWiring ─────
  {
    const wiring = cfg.executionWiring ?? [];
    if (wiring.length === 0) {
      checks.push({ id: 'harness-config', status: 'skipped', detail: 'no executionWiring entries' });
    } else {
      let harnessDrift = 0;
      let harnessRepaired = 0;
      for (const entry of wiring) {
        const wantCanonical = canonicalHarnessName(harness);
        const haveCanonical = entry.harness ? canonicalHarnessName(entry.harness) : undefined;
        if (haveCanonical !== wantCanonical || entry.model !== model) {
          if (repair) {
            entry.harness = harness;
            entry.model = model;
            cfgDirty = true;
            harnessRepaired++;
          } else {
            harnessDrift++;
          }
        }
      }
      checks.push(summarize('harness-config', wiring.length, harnessDrift, harnessRepaired, `harness=${harness} model=${model}`));
    }
    if (opts.isEvaluator) {
      const evaluatorOn =
        cfg.evaluator?.enabled === true
        || wiring.some((entry) => typeof entry.harness === 'string' && entry.harness.includes('evaluator'));
      if (evaluatorOn) {
        checks.push({ id: 'evaluator-role', status: 'ok', detail: 'evaluator enabled' });
      } else if (repair) {
        cfg.evaluator = { ...(typeof cfg.evaluator === 'object' && cfg.evaluator !== null ? cfg.evaluator : {}), enabled: true };
        cfgDirty = true;
        checks.push({ id: 'evaluator-role', status: 'repaired', detail: 'evaluator.enabled → true' });
      } else {
        checks.push({ id: 'evaluator-role', status: 'drift', detail: 'evaluator not enabled' });
      }
    }
  }

  // ── 4b. Evaluator harness enablement ───────────────────────────────────
  if (opts.isEvaluator) {
    const evaluatorStateDir = path.join(implStateRoot, EVALUATOR_STATE_DIR_NAME);
    const statePath = path.join(evaluatorStateDir, EVALUATOR_STATE_FILE);
    const defaultUpstreamRepoDir = path.join(evaluatorStateDir, 'upstream');
    const existing = await readJson<{ enabled?: boolean; upstreamRepoDir?: string }>(statePath);
    const existingUpstreamRepoDir =
      typeof existing?.upstreamRepoDir === 'string' ? existing.upstreamRepoDir : defaultUpstreamRepoDir;
    const existingReady =
      existing?.enabled === true && await pathExists(existingUpstreamRepoDir);

    if (existingReady) {
      checks.push({
        id: 'evaluator-harness-state',
        status: 'ok',
        detail: `evaluator harness enabled; upstream=${existingUpstreamRepoDir}`,
      });
    } else if (repair) {
      const enable = opts.enableEvaluatorHarness ?? defaultEnableEvaluatorHarness;
      const result = await enable(evaluatorStateDir);
      const refreshed = await readJson<{ enabled?: boolean; upstreamRepoDir?: string }>(statePath);
      const refreshedUpstreamRepoDir =
        typeof refreshed?.upstreamRepoDir === 'string' ? refreshed.upstreamRepoDir : defaultUpstreamRepoDir;
      const refreshedReady =
        refreshed?.enabled === true && await pathExists(refreshedUpstreamRepoDir);

      if (result.status === 'ready' && refreshedReady) {
        checks.push({
          id: 'evaluator-harness-state',
          status: 'repaired',
          detail: `enabled evaluator harness; upstream=${refreshedUpstreamRepoDir}`,
        });
      } else {
        const reason =
          result.message ??
          result.action?.description ??
          (refreshed?.enabled === true
            ? `upstream repo missing at ${refreshedUpstreamRepoDir}`
            : 'evaluator harness state missing/not enabled');
        checks.push({
          id: 'evaluator-harness-state',
          status: 'drift',
          detail: `evaluator harness not ready after enable attempt: ${reason}`,
        });
      }
    } else {
      const detail = existing?.enabled === true
        ? `evaluator harness state enabled but upstream repo missing at ${existingUpstreamRepoDir}`
        : 'evaluator harness state missing/not enabled';
      checks.push({ id: 'evaluator-harness-state', status: 'drift', detail });
    }

    // ── 4c. Admission pool (validated-pool.json must exist & be parseable) ─
    const poolPath = path.join(evaluatorStateDir, ADMISSION_FILE);
    const pool = await readJson<{
      schemaVersion?: string;
      evalSemanticsVersion?: string;
      entries?: Record<string, { scorable?: boolean; reason?: string }>;
    }>(poolPath);
    const poolValid = pool?.schemaVersion === ADMISSION_SCHEMA_VERSION && pool?.evalSemanticsVersion === EVAL_SEMANTICS_VERSION;
    if (poolValid) {
      checks.push({ id: 'admission-pool', status: 'ok', detail: `pool present (semantics v${EVAL_SEMANTICS_VERSION})` });
    } else if (repair) {
      // Seed an empty admission file at the current semantics version. The
      // operator still runs `jinn solver-nets validate-pool` to populate it;
      // this guarantees the file exists & parses so admission lookups return a
      // clean empty set rather than crashing, and the verify step can assert it.
      await writeJson(poolPath, {
        schemaVersion: ADMISSION_SCHEMA_VERSION,
        evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
        updatedAt: new Date().toISOString(),
        entries: {},
      });
      checks.push({ id: 'admission-pool', status: 'repaired', detail: `seeded empty pool (semantics v${EVAL_SEMANTICS_VERSION}) — run validate-pool to populate` });
    } else {
      checks.push({ id: 'admission-pool', status: 'drift', detail: 'validated-pool.json missing or wrong semantics version' });
    }

    // ── 4d. Gate fixture admission (fast-fail) ─────────────────────────────
    // The shared T2.2/T3.1 fixture instance MUST be scorable under the current
    // semantics, or the evaluator throws admission_missing_or_unscorable and the
    // real-harness loop burns its full ~23-min budget before failing — surfaced
    // as a mystery flake-timing rather than the real cause (2026-06-08 cut). A
    // scorable admission can't be synthesised (it needs a real gold-patch grade
    // via `jinn solver-nets validate-pool`), so — like harness-creds — this is
    // ALWAYS drift when missing, even under --repair (the empty seeded pool above
    // still can't grade the fixture). Caught here, it's an instant infra-blocked
    // verdict naming the fix, not a 23-minute silent timeout.
    const fixtureEntry =
      pool?.evalSemanticsVersion === EVAL_SEMANTICS_VERSION ? pool?.entries?.[KNOWN_INSTANCE_ID] : undefined;
    if (fixtureEntry?.scorable === true) {
      checks.push({ id: 'admission-pool-fixture', status: 'ok', detail: `gate fixture ${KNOWN_INSTANCE_ID} scorable (semantics v${EVAL_SEMANTICS_VERSION})` });
    } else {
      const why = fixtureEntry ? `recorded unscorable (${fixtureEntry.reason ?? 'no reason'})` : 'no scorable entry';
      checks.push({
        id: 'admission-pool-fixture',
        status: 'drift',
        detail: `gate fixture ${KNOWN_INSTANCE_ID}: ${why} under semantics v${EVAL_SEMANTICS_VERSION} — run \`jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad\` on the warm operator and refresh its state; cannot auto-repair`,
      });
    }
  }

  // ── 5. Harness creds present for the configured solve harness ──────────
  {
    const present = await hasHarnessCreds(harness);
    if (present) {
      checks.push({ id: 'harness-creds', status: 'ok', detail: `${harness} credential present` });
    } else {
      // Creds cannot be synthesised — repair cannot manufacture a login. Always
      // report drift so the operator seeds them (codex login / claude login /
      // OPENROUTER_API_KEY).
      checks.push({ id: 'harness-creds', status: 'drift', detail: `${harness} credential missing — log in / set the key, cannot auto-repair` });
    }
  }

  if (cfgDirty && repair) {
    await writeJson(cfgPath, cfg);
  }

  const ok = checks.every((c) => c.status === 'ok' || c.status === 'repaired' || c.status === 'skipped');
  return { opName, ok, checks };
}

function summarize(
  id: CheckResult['id'],
  total: number,
  drift: number,
  repaired: number,
  what: string,
): CheckResult {
  if (repaired > 0) return { id, status: 'repaired', detail: `${repaired}/${total} entries set ${what}` };
  if (drift > 0) return { id, status: 'drift', detail: `${drift}/${total} entries need ${what}` };
  return { id, status: 'ok', detail: `all ${total} entries: ${what}` };
}

async function checkFleetSafe(
  opName: string,
  manifest: Manifest,
  earningPath: string,
  opDir: string,
  checks: CheckResult[],
  opts: { repair: boolean; skipOnChain: boolean },
): Promise<void> {
  if (manifest.shape !== 'current' || manifest.operator.fleetAgentId === null) {
    checks.push({ id: 'fleet-safe-consistency', status: 'skipped', detail: 'pre-fleet shape or no fleetAgentId' });
    return;
  }
  if (opts.skipOnChain) {
    checks.push({ id: 'fleet-safe-consistency', status: 'skipped', detail: 'on-chain check skipped' });
    return;
  }

  const client = createPublicClient({
    chain: chainForNetwork(manifest.network),
    transport: http(manifest.config.rpcUrl),
  });
  let bound: string;
  try {
    bound = await client.readContract({
      address: manifest.operator.identityRegistry as Address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'getAgentWallet',
      args: [BigInt(manifest.operator.fleetAgentId)],
    });
  } catch (err) {
    checks.push({ id: 'fleet-safe-consistency', status: 'skipped', detail: `getAgentWallet read failed: ${(err as Error).message}` });
    return;
  }

  const earning = (await readJson<EarningState>(earningPath)) ?? {};
  const manifestStale = manifest.operator.fleetSafeAddress?.toLowerCase() !== bound.toLowerCase();
  const earningStale = (earning.fleet_safe_address ?? '').toLowerCase() !== bound.toLowerCase();

  if (!manifestStale && !earningStale) {
    checks.push({ id: 'fleet-safe-consistency', status: 'ok', detail: `fleetSafe == on-chain ${bound}` });
    return;
  }
  if (opts.repair) {
    manifest.operator.fleetSafeAddress = bound;
    await writeJson(path.join(opDir, 'manifest.json'), manifest);
    earning.fleet_safe_address = bound;
    await writeJson(earningPath, earning);
    checks.push({ id: 'fleet-safe-consistency', status: 'repaired', detail: `fleetSafe → on-chain ${bound}` });
  } else {
    checks.push({
      id: 'fleet-safe-consistency',
      status: 'drift',
      detail: `manifest=${manifest.operator.fleetSafeAddress} earning=${earning.fleet_safe_address} on-chain=${bound}`,
    });
  }
}

function parseArgs(argv: string[]): { opName?: string; opts: ProvisionOptions } {
  const opts: ProvisionOptions = {};
  let opName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repair') opts.repair = true;
    else if (a === '--skip-on-chain') opts.skipOnChain = true;
    else if (a === '--evaluator') opts.isEvaluator = true;
    else if (a === '--harness') opts.harness = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--paid-rpc-url') opts.paidRpcUrl = argv[++i];
    else if (a === '--substrate-root') opts.substrateRoot = argv[++i];
    else if (!a.startsWith('--')) opName = a;
  }
  return { opName, opts };
}

async function cliMain(): Promise<void> {
  const { opName, opts } = parseArgs(process.argv.slice(2));
  if (!opName) {
    console.error(
      'usage: substrate-provision <op-name> [--repair] [--evaluator] [--skip-on-chain]\n' +
        '         [--harness <name>] [--model <id>] [--paid-rpc-url <url>] [--substrate-root <dir>]\n' +
        '\n' +
        'Detect-only by default; pass --repair to apply idempotent fixes.\n' +
        'Do NOT run against live ~/jinn-dev/operators homes during a release run\n' +
        'without --skip-on-chain awareness — use --substrate-root for a copy.',
    );
    process.exit(2);
  }
  const result = await provisionSubstrate(opName, opts);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
