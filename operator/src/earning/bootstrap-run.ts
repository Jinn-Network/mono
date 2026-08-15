import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JinnConfig } from '../config.js';
import type { ProgressEnvelope } from '../observability/progress.js';
import { FleetBootstrapper } from './bootstrap.js';
import { runLegacyAgentIdMigration } from './migrate-agent-id.js';
import { FleetStateStore } from './store.js';
import {
  isOperationalServiceStep,
  type FleetState,
  type ServiceState,
  type ServiceStep,
} from './types.js';
import { decryptMnemonic, walletPrivateKeyAtIndex } from './wallet.js';
import { buildEnvelope, emitEnvelope, type ErrorCode, type ErrorEnvelope } from '../errors/envelope.js';
import { clearBootstrapError, persistBootstrapError } from '../errors/persisted-bootstrap-error.js';
import { emitStructured } from '../events/emitter.js';
import { keepSetupUiOnBootstrapError } from '../setup/halt-mode.js';

const STANDARD_SERVICE_PROGRESSION: readonly ServiceStep[] = [
  'awaiting_stake',
  'staked',
  'mech_deployed',
  'agent_registered',
  'safe_binding_pending',
  'complete',
];

const SELF_BOND_SERVICE_PROGRESSION: readonly ServiceStep[] = [
  'awaiting_stake',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'mech_deployed',
  'agent_registered',
  'safe_binding_pending',
  'complete',
];

/** §6.2 `bootstrap_incomplete` — `{ currentStep, nextStep }` from persisted fleet state. */
function bootstrapIncompleteSteps(state: FleetState): { currentStep: string; nextStep: string } {
  const progression =
    state.staking_mode === 'self-bond'
      ? SELF_BOND_SERVICE_PROGRESSION
      : STANDARD_SERVICE_PROGRESSION;
  const byIndex = [...state.services].sort((a, b) => a.index - b.index);
  const focus: ServiceState | undefined =
    byIndex.find(s => isOperationalServiceStep(s.step) && !s.safe_address) ??
    byIndex.find(s => !isOperationalServiceStep(s.step)) ??
    byIndex.find(s => s.step === 'safe_binding_pending') ??
    byIndex[0];

  if (!focus) {
    return { currentStep: 'awaiting_service', nextStep: 'awaiting_stake' };
  }
  if (isOperationalServiceStep(focus.step) && !focus.safe_address) {
    return { currentStep: 'complete', nextStep: 'bootstrap' };
  }
  const i = progression.indexOf(focus.step);
  if (i === -1) {
    return { currentStep: focus.step, nextStep: 'bootstrap' };
  }
  if (i < progression.length - 1) {
    return { currentStep: focus.step, nextStep: progression[i + 1]! };
  }
  return { currentStep: focus.step, nextStep: 'bootstrap' };
}

export class SetupBootstrapHalted extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'SetupBootstrapHalted';
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

export async function runFleetBootstrap(deps: {
  config: JinnConfig;
  password: string;
  network: 'base' | 'base-sepolia';
  emitProgress: (envelope: ProgressEnvelope) => void;
}): Promise<{
  masterAddress: `0x${string}`;
  serviceIndex: number;
  serviceId: number | null;
  stakingAddress: `0x${string}` | null;
  agentPrivateKey: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress?: `0x${string}`;
  /** ERC-8004 agent NFT id (decimal string). null if bootstrap mint not yet complete. */
  agentId: string | null;
  /** ERC-8004 IdentityRegistry contract used for the mint. null if unknown. */
  identityRegistryAddress: `0x${string}` | null;
}> {
  const { config, password: PASSWORD, network: NETWORK_CHAIN, emitProgress } = deps;
  console.log('[main] Running fleet bootstrap...');

  // A fresh bootstrap attempt clears any stale error breadcrumb. If this run
  // hits the same failure, it'll be re-persisted below; if it succeeds (or
  // proceeds past the previously-failed step), the panel returns to a clean
  // state on the next /v1/bootstrap poll.
  clearBootstrapError(config.earningDir);

  // Persist the envelope to disk before emitEnvelope's process.exit fires,
  // so /v1/bootstrap can surface it to the panel after the daemon has
  // exited (operator restart → panel reload → error visible).
  function failBootstrap(input: {
    code: ErrorCode;
    message: string;
    hint?: string;
    exampleCli?: string;
    details?: Record<string, unknown>;
  }): never {
    const envelope = buildEnvelope(input);
    persistBootstrapError(envelope, config.earningDir);
    if (keepSetupUiOnBootstrapError()) {
      emitStructured({
        kind: 'error',
        message: envelope.message,
        errorCode: envelope.code,
        details: {
          phase: 'bootstrap',
          exitCode: envelope.exitCode,
          ...(envelope.details ?? {}),
        },
      });
      console.error(
        `[main] Bootstrap halted (${envelope.code}); setup UI remains available. ` +
          `Resolve the issue and run jinn run again.`,
      );
      throw new SetupBootstrapHalted(envelope);
    }
    emitEnvelope(input);
    // Unreachable in production (emitEnvelope exits); satisfies `never`.
    throw new Error('unreachable');
  }

  const bootstrapper = new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: NETWORK_CHAIN,
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    debug: config.debug,
    masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
    minEoaGasWei: config.minEoaGasWei,
    minSafeEthWei: config.minSafeEthWei,
    pollIntervalMs: config.pollIntervalMs,
    autoTestnetFaucet: process.env['JINN_AUTO_TESTNET_FAUCET'] === '1',
  });

  // Funding poll: stay up while waiting for the operator to fund the wallet.
  // The setup-mode API server is already running; the panel renders the
  // funding card and auto-advances when funds land. Daemon-side, we poll
  // bootstrap on a 15s tick and only escalate (exit) if a non-funding error
  // occurs or the configured timeout elapses. Each tick re-runs the full
  // bootstrap state machine — completed steps are no-ops, so this is safe.
  // Testnet faucet funding is panel-driven: bootstrap reports the funding gate,
  // and the operator clicks the funding action before this loop can advance.
  const FUNDING_POLL_INTERVAL_MS = 15_000;
  const fundingTimeoutMs = (() => {
    const raw = process.env['JINN_FUNDING_TIMEOUT_MS'];
    if (!raw) return Number.POSITIVE_INFINITY;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
  })();

  emitProgress({
    type: 'progress',
    phase: 'bootstrap',
    step: 'advance_state_machine',
    estimatedWaitMs: 60_000,
  });

  const fundingStartedAt = Date.now();
  let result: Awaited<ReturnType<typeof bootstrapper.ensureStage1And2>>;
  let lastFundingMessage = '';
  const fundingGatePath = join(config.earningDir, 'bootstrap-funding.json');
  const persistFundingGate = (funding: NonNullable<Awaited<ReturnType<typeof bootstrapper.ensureStage1And2>>['funding']>): void => {
    mkdirSync(config.earningDir, { recursive: true, mode: 0o700 });
    writeFileSync(fundingGatePath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ...funding,
    }, null, 2)}\n`, { mode: 0o600 });
  };
  const clearFundingGate = (): void => {
    try {
      unlinkSync(fundingGatePath);
    } catch {
      // best-effort: absent/stale funding gate should not affect bootstrap
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    result = await bootstrapper.ensureStage1And2(PASSWORD);
    if (!result.funding) {
      clearFundingGate();
      break;
    }
    persistFundingGate(result.funding);

    // Emit a structured event so the panel's Visibility region shows the gate.
    // Dedupe by message to avoid spamming the ring buffer on each poll.
    const fundingMsg = result.message ?? 'awaiting funding';
    if (fundingMsg !== lastFundingMessage) {
      emitStructured({
        kind: 'fleet',
        message: fundingMsg,
        details: {
          phase: 'awaiting_funding',
          role: 'master',
          address: result.funding.master_address,
          asset: 'native',
          needWei: result.funding.eth_required,
          haveWei: result.funding.eth_balance,
        },
      });
      // Mirror the structured event to NDJSON progress for --json-progress
      // consumers (CI, agents). Same dedup gate so we don't spam stdout.
      emitProgress({
        type: 'progress',
        phase: 'bootstrap',
        step: 'awaiting_funding',
        blocking: true,
        nextAction:
          'Fund the address shown in addresses.fundingAddress, then wait for automatic retry.',
        addresses: { fundingAddress: result.funding.master_address },
        estimatedWaitMs: 1_800_000,
      });
      lastFundingMessage = fundingMsg;
    }

    const elapsed = Date.now() - fundingStartedAt;
    if (elapsed >= fundingTimeoutMs) {
      failBootstrap({
        code: 'funding_required',
        message: `${result.message} (timeout after ${Math.round(elapsed / 1000)}s)`,
        hint: 'Fund the listed address and re-run this command.',
        exampleCli: 'jinn fund-requirements --json',
        details: {
          // jinn-mono-hjex.6: structured envelope so SPA can render the
          // specific address + amount instead of a prose disjunction.
          category: 'insufficient_funds',
          step: 'awaiting_funding',
          address: result.funding.master_address,
          requiredWei: result.funding.eth_required,
          haveWei: result.funding.eth_balance,
          // Legacy aliases kept for any external consumers that read these.
          role: 'master',
          asset: 'native',
          needWei: result.funding.eth_required,
        },
      });
    }

    console.log(
      `[main] Awaiting funding... (${Math.round(elapsed / 1000)}s elapsed; ` +
      `will retry in ${FUNDING_POLL_INTERVAL_MS / 1000}s)`,
    );
    await new Promise((r) => setTimeout(r, FUNDING_POLL_INTERVAL_MS));
  }

  if (!result.ok) {
    failBootstrap({
      code: 'fatal',
      message: result.message,
      hint: 'Bootstrap failed before the fleet reached a runnable state.',
      details: {
        cause: result.message,
        // jinn-mono-hjex.6: propagate structured category from the bootstrapper
        // so the SPA can render category-specific UI (e.g. funding shortfall).
        ...(result.errorCategory !== undefined ? { category: result.errorCategory } : {}),
        // Preserve the raw underlying error so a misclassified summary can
        // be diagnosed without re-running with JINN_DEBUG. See jinn-mono-jz9f.
        ...(result.rawErrorMessage && result.rawErrorMessage !== result.message
          ? { rawErrorMessage: result.rawErrorMessage }
          : {}),
        // jinn-mono-hjex reviewer fix: propagate tx hash so the SPA can render
        // a block-explorer link for failed on-chain revert transactions.
        ...(result.txHash != null ? { txHash: result.txHash } : {}),
      },
    });
  }

  // Legacy migration (jinn-mono-jgp): backfill `agent_id` on `complete`
  // services that pre-date j07. Idempotent + per-service failure-isolated;
  // a failure here does not abort daemon startup, but we surface counts so
  // operators notice. Disabled via `runLegacyMigrations: false` /
  // JINN_RUN_LEGACY_MIGRATIONS=0 — operators can run `jinn migrate-agent-id`
  // explicitly instead.
  let state = result.fleet_state;
  if (config.runLegacyMigrations) {
    try {
      const migration = await runLegacyAgentIdMigration({
        earningDir: config.earningDir,
        network: NETWORK_CHAIN,
        rpcUrl: config.rpcUrl,
        password: PASSWORD,
        testnetL2DeploymentPath: config.testnetL2DeploymentPath,
        testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
        testnetMechDeploymentPath: config.testnetMechDeploymentPath,
        testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
      });
      if (migration.migrated.length > 0 || migration.failed.length > 0) {
        console.log(
          `[main] Legacy agent_id migration: migrated=${migration.migrated.length} ` +
          `skipped=${migration.skipped.length} failed=${migration.failed.length}`,
        );
        for (const f of migration.failed) {
          console.log(
            `[main]   service ${f.service.index} (agent ${f.service.agent_address}): ${f.error}`,
          );
        }
        // Reload state so downstream wiring (agent_id, identityRegistry)
        // sees the migrated rows.
        state = await new FleetStateStore(config.earningDir).load(NETWORK_CHAIN);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[main] Legacy agent_id migration failed (non-fatal): ${message}`);
    }
  }

  // Use the first operational service for the daemon. `safe_binding_pending`
  // means staking/mech are live; only the ERC-8004 Safe→agent metadata bind
  // is still retrying.
  const firstComplete = state.services.find(s => isOperationalServiceStep(s.step));
  if (!firstComplete || !firstComplete.safe_address) {
    failBootstrap({
      code: 'bootstrap_incomplete',
      message: 'Bootstrap completed but no service is ready.',
      hint: 'Re-run to continue the state machine toward a running fleet.',
      exampleCli: 'jinn bootstrap --json',
      details: bootstrapIncompleteSteps(state),
    });
  }

  // Derive agent private key from mnemonic
  const store = new FleetStateStore(config.earningDir);
  const mnemonic = await decryptMnemonic(
    await store.loadMnemonicKeystore(),
    PASSWORD,
  );
  const agentPrivateKey = walletPrivateKeyAtIndex(mnemonic, firstComplete.index);

  console.log(`[main] Fleet bootstrap complete.`);
  console.log(`  Master:  ${state.master_address}`);
  console.log(`  Services: ${state.services.filter(s => isOperationalServiceStep(s.step)).length}/${config.targetServices}`);
  console.log(`  Active:  service ${firstComplete.service_id} (agent ${firstComplete.agent_address})`);
  if (firstComplete.mech_address) {
    console.log(`  Mech:    ${firstComplete.mech_address}`);
  }

  return {
    masterAddress: state.master_address as `0x${string}`,
    serviceIndex: firstComplete.index,
    serviceId: firstComplete.service_id ?? null,
    stakingAddress: firstComplete.staking_address ? (firstComplete.staking_address as `0x${string}`) : null,
    agentPrivateKey: agentPrivateKey as `0x${string}`,
    safeAddress: firstComplete.safe_address as `0x${string}`,
    mechAddress: firstComplete.mech_address ? (firstComplete.mech_address as `0x${string}`) : undefined,
    agentId: firstComplete.agent_id ?? null,
    identityRegistryAddress: firstComplete.identity_registry_address
      ? (firstComplete.identity_registry_address as `0x${string}`)
      : null,
  };
}

// ── Degrade-open retry-loop orchestration (#2407 part 2, spec §5) ──────────

/** Anything that can be stopped — degraded-recovery.ts's DegradedRecoveryHandle satisfies this. */
export interface StoppableRecovery {
  stop: () => void | Promise<void>;
}

export interface RunBootstrapWithDegradeOpenDeps<TResult> {
  /**
   * Runs one bootstrap attempt. Resolves with the result on success;
   * throws `SetupBootstrapHalted` on an expected halt (any other thrown
   * error propagates out of `runBootstrapWithDegradeOpen` uncaught, exactly
   * like the inline loop this replaces).
   */
  runBootstrap: () => Promise<TResult>;
  /**
   * Classifies + starts degraded recovery for a halt's envelope. Returns
   * `null` when the halt is integrity-class (isEconomicBootstrapHalt says
   * no degraded loops) or when construction itself failed — either way,
   * readiness stays at whatever it already was rather than flipping to
   * `'degraded'` for a recovery surface that isn't actually running.
   */
  startDegraded: (envelope: ErrorEnvelope) => StoppableRecovery | null;
  setReadiness: (readiness: 'bootstrapping' | 'ready' | 'degraded') => void;
  /**
   * Waits for the retry signal (SPA click, or the funding auto-resume
   * poller) to fire for THIS halt. Resolves once the signal fires; the
   * caller then stops any degraded recovery and loops back to
   * `runBootstrap()`. Receives the halt's envelope so the caller can decide
   * whether to run the funding auto-resume poller for it.
   */
  awaitRetry: (envelope: ErrorEnvelope) => Promise<void>;
}

/**
 * Extracted from main.ts's inline `while (true)` retry loop so the
 * ORDERING it guarantees is independently testable (main.ts itself is
 * established in this codebase as impractical to test directly — see
 * `test/main/rpc-boot-probe-format.test.ts`'s docstring — but this function
 * has no such dependency): on a `SetupBootstrapHalted`, `startDegraded` runs
 * BEFORE `setReadiness('degraded')` (so readiness never claims a recovery
 * surface that failed to start), `setReadiness('degraded')` runs before
 * `awaitRetry` is awaited, the degraded handle's `stop()` is awaited to
 * completion BEFORE the loop calls `runBootstrap()` again, and
 * `setReadiness('ready')` runs only after a successful `runBootstrap()`
 * resolves — i.e. before the caller goes on to construct the full Daemon.
 */
export async function runBootstrapWithDegradeOpen<TResult>(
  deps: RunBootstrapWithDegradeOpenDeps<TResult>,
): Promise<TResult> {
  deps.setReadiness('bootstrapping');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await deps.runBootstrap();
      deps.setReadiness('ready');
      return result;
    } catch (err) {
      if (err instanceof SetupBootstrapHalted) {
        const degradedRecovery = deps.startDegraded(err.envelope);
        if (degradedRecovery) {
          deps.setReadiness('degraded');
        }
        try {
          await deps.awaitRetry(err.envelope);
        } finally {
          if (degradedRecovery) {
            await degradedRecovery.stop();
          }
          deps.setReadiness('bootstrapping');
        }
        continue;
      }
      throw err;
    }
  }
}
