#!/usr/bin/env node
/**
 * jinn-client production entry point.
 *
 * Bootstraps earning (wallet → Safe → service → staking → mech),
 * then starts the daemon with MechAdapter + ClaudeRunner on Base.
 *
 * Config resolution (highest priority wins):
 *   1. Environment variables (JINN_*, BASE_RPC_URL, BASE_SEPOLIA_RPC_URL)
 *   2. Config file (~/.jinn-client/config.json or --config <path>)
 *   3. Built-in defaults
 *
 * Keystore password (used to encrypt the wallet at rest) resolves in this
 * order: JINN_PASSWORD env var → ~/.jinn-client/keystore-password file →
 * auto-generated random value (persisted mode 0600 to that same file). A
 * brand-new operator can run `jinn run` with no env var and no input.
 *
 * Canonical operator command:
 *   jinn run
 */

import { config as dotenvConfig } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync as writeFileSyncMain } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from './config.js';
import { Store } from './store/store.js';
import { startApiServer, type ApiServer } from './api/server.js';
import { ensureUiToken } from './api/ui-token.js';
import { attachAgentWs } from './agent/agent-ws.js';
import { createSetupModeController } from './setup-mode.js';
import { formatBootstrapOperatorMessage } from './operator-errors.js';
import { buildEnvelope, emitEnvelope, type ErrorCode } from './errors/envelope.js';
import {
  clearBootstrapError,
  persistBootstrapError,
} from './errors/persisted-bootstrap-error.js';
import { emitStructured } from './events/emitter.js';
import { checkClaudeBinary } from './preflight/claude-binary.js';
import { emitClaudeBinaryPreflightFailure } from './preflight/claude-invocation-envelope.js';
import { detectAuthContext, probeClaudeAuth } from './preflight/claude-auth.js';
import { FleetBootstrapper } from './earning/bootstrap.js';
import { DEFAULT_TESTNET_ARTIFACTS, applyChainGasOverrides, getChainConfig, loadJinnMviConfig } from './earning/contracts.js';
import { runLegacyAgentIdMigration } from './earning/migrate-agent-id.js';
import { FleetStateStore } from './earning/store.js';
import {
  isOperationalServiceStep,
  type FleetState,
  type ServiceState,
  type ServiceStep,
} from './earning/types.js';
import { decryptMnemonic, deriveMasterSigner, walletPrivateKeyAtIndex } from './earning/wallet.js';
import { MechAdapter } from './adapters/mech/adapter.js';
import { ClaudeRunner } from './runner/claude.js';
import type { RunnerContext } from './runner/runner.js';
import { Daemon } from './daemon/daemon.js';
import { createJinnPublicClient, createJinnWalletClient, createJinnL1PublicClient, createJinnL1WalletClient } from './earning/viem-clients.js';
import { privateKeyToAccount } from 'viem/accounts';
import { HarnessRegistry } from './harnesses/engine/registry.js';
import { buildHarnesses } from './harnesses/impls/index.js';
import { loadExternalImpl } from './harnesses/external-impls/index.js';
import type { Harness } from './harnesses/types.js';
import { createClients } from './adapters/mech/safe.js';
import { collectTestnetAutoTaskGenerators } from './solver-types/index.js';
import { loadSolverNets } from './solver-nets/registry.js';
import { createCorpus } from './corpus/index.js';
import { BASE_FEEDS } from './venues/chainlink/feeds.js';
import { GeneratedTaskSource, StaticConfiguredTaskSource } from './tasks/sources.js';
import { checkRpcNetwork, logRpcLocalDevToStderr, rpcNetworkFailureHint } from './preflight/rpc-network.js';
import { apiPortFailureMessage, checkApiPortAvailable } from './preflight/api-port.js';
import { openBrowser } from './cli/open-browser.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

// ── Password (env > file > auto-generated) ─────────────────────────────────
//
// Resolution order:
//   1. JINN_PASSWORD env var (explicit operator-set, never in config files)
//   2. ~/.jinn-client/keystore-password (file from a previous auto-gen)
//   3. Auto-generate a 32-byte hex string, persist mode 0600, and reuse next run
//
// Auto-generation matches what `jinn quickstart` used to do so a brand-new
// operator can run `jinn run` with no env var, no setup, no input. The
// known security trade-off is documented in client/src/cli/password.ts:
// plaintext on disk + encrypted keystore on the same disk only defends
// against casual snooping. Treat the wallet as hot until rotated.

function resolveOrGenerateKeystorePassword(): {
  password: string;
  source: 'env' | 'file' | 'generated';
  filePath?: string;
} {
  const envPw = process.env['JINN_PASSWORD'];
  if (envPw && envPw.length > 0) {
    return { password: envPw, source: 'env' };
  }

  const home = process.env['HOME'] ?? homedir();
  const pwFilePath = join(home, '.jinn-client', 'keystore-password');
  if (existsSync(pwFilePath)) {
    const fromDisk = readFileSync(pwFilePath, 'utf-8').trim();
    if (fromDisk.length > 0) {
      return { password: fromDisk, source: 'file', filePath: pwFilePath };
    }
  }

  const generated = cryptoRandomBytes(32).toString('hex');
  mkdirSync(dirname(pwFilePath), { recursive: true, mode: 0o700 });
  writeFileSyncMain(pwFilePath, generated + '\n', { mode: 0o600 });
  return { password: generated, source: 'generated', filePath: pwFilePath };
}

const passwordResolution = resolveOrGenerateKeystorePassword();
const PASSWORD: string = passwordResolution.password;
// Sub-commands (e.g. the embedded `init` invocation below) read JINN_PASSWORD
// from env. Mirror our resolved value so they don't have to redo this dance.
process.env['JINN_PASSWORD'] = PASSWORD;

if (passwordResolution.source === 'generated') {
  console.log('━'.repeat(64));
  console.log('A keystore password was auto-generated for you.');
  console.log(`  Stored at: ${passwordResolution.filePath}`);
  console.log('  Mode 0600. Treat the wallet as hot until you rotate the password.');
  console.log('  To rotate: JINN_NEW_PASSWORD=<new> jinn keys change-password');
  console.log('━'.repeat(64));
}

// ── Load config ─────────────────────────────────────────────────────────────

const CONFIG_PATH = getConfigPathFromArgs();
const config = loadConfig(CONFIG_PATH);

const NETWORK_CHAIN = config.network === 'testnet' ? 'base-sepolia' : 'base';
const CHAIN_CONFIG = applyChainGasOverrides(getChainConfig(NETWORK_CHAIN, {
  testnetL2DeploymentPath: config.testnetL2DeploymentPath,
  testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
  testnetMechDeploymentPath: config.testnetMechDeploymentPath,
  testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
}), {
  minEoaGasWei: config.minEoaGasWei,
  minSafeEthWei: config.minSafeEthWei,
});
const MESSENGER_MODE_EXPLICIT =
  process.env['JINN_MESSENGER_MODE'] !== undefined ||
  configFileHasTopLevelKey(CONFIG_PATH, 'jinnMessengerMode');
const JINN_MVI_CONFIG = loadJinnMviConfig({
  l1ArtifactPath:
    config.jinnMviL1DeploymentPath ??
    (config.network === 'testnet' ? DEFAULT_TESTNET_ARTIFACTS.jinnMviL1 : undefined),
  l2ArtifactPath:
    config.jinnMviL2DeploymentPath ??
    (config.network === 'testnet' ? DEFAULT_TESTNET_ARTIFACTS.jinnMviL2 : undefined),
  distributorAddress: config.jinnDistributorAddress,
  messengerAddress: config.jinnMessengerAddress,
  claimEmitterAddress: config.jinnClaimEmitterAddress,
  messengerMode: MESSENGER_MODE_EXPLICIT ? config.jinnMessengerMode : undefined,
});
const JINN_CLAIM_MESSENGER_MODE = JINN_MVI_CONFIG.messengerMode ?? config.jinnMessengerMode;
const MARKETPLACE_ADDRESS = CHAIN_CONFIG.mechMarketplace as `0x${string}`;
const ROUTER_ADDRESS = (CHAIN_CONFIG.jinnRouter ?? '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`;

function configFileHasTopLevelKey(configPath: string | undefined, key: string): boolean {
  const filePath = configPath ?? join(process.env['HOME'] ?? '', '.jinn-client', 'config.json');
  if (!filePath || !existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return !!raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
}

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

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<{
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
  let result: Awaited<ReturnType<typeof bootstrapper.bootstrap>>;
  let lastFundingMessage = '';
  const fundingGatePath = join(config.earningDir, 'bootstrap-funding.json');
  const persistFundingGate = (funding: NonNullable<Awaited<ReturnType<typeof bootstrapper.bootstrap>>['funding']>): void => {
    mkdirSync(config.earningDir, { recursive: true, mode: 0o700 });
    writeFileSyncMain(fundingGatePath, `${JSON.stringify({
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
    result = await bootstrapper.bootstrap(PASSWORD);
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
          role: 'master',
          address: result.funding.master_address,
          asset: 'native',
          needWei: result.funding.eth_required,
          haveWei: result.funding.eth_balance,
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
      details: { cause: result.message },
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

export interface DaemonStartupInfo {
  schemaVersion: 1;
  generatedAt: string;
  kind: 'daemon_started';
  pid: number;
  network: 'testnet' | 'mainnet';
  phase: 'phase-1b' | 'phase-0';
  apiPort: number;
  masterAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress: `0x${string}`;
  serviceIndex: number;
  serviceId: number | null;
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * --json-progress: emit NDJSON progress envelopes on stdout during long
 * phases (init, bootstrap, daemon startup). The `jinn run --json-progress`
 * flag flips JINN_JSON_PROGRESS=1 in run.ts before calling main(); when
 * unset this is a no-op so tests / non-flag invocations stay silent on
 * stdout.
 */
function progressEnabled(): boolean {
  return process.env['JINN_JSON_PROGRESS'] === '1';
}

interface ProgressEnvelope {
  type: 'progress';
  phase: 'init' | 'bootstrap' | 'daemon';
  step: string;
  attempt?: number;
  blocking?: boolean;
  nextAction?: string;
  addresses?: Record<string, string>;
  estimatedWaitMs?: number;
}

function emitProgress(envelope: ProgressEnvelope): void {
  if (progressEnabled()) {
    process.stdout.write(JSON.stringify(envelope) + '\n');
  }
}

export async function main(): Promise<DaemonStartupInfo | void> {
  console.log(`[main] jinn-client starting on ${NETWORK_CHAIN}`);

  // ── Daemon API bearer token (jinn-mono-pr64 hardening) ───────────────────
  //
  // Cost-mutating API routes (`POST /v1/artifacts/acquire`, `POST /artifacts`)
  // require an `Authorization: Bearer <token>` header. Read from env when
  // operators want a stable token (e.g. multi-process tools); otherwise
  // generate a fresh one per daemon process. Logged only as an 8-char prefix.
  // The token is forwarded to the MCP subprocess via `DAEMON_API_TOKEN` env
  // so `acquire_artifact` and `submit_restoration_result` can authenticate
  // their calls back to the daemon.
  const envToken = process.env['DAEMON_API_TOKEN']?.trim();
  const apiToken = envToken && envToken.length > 0
    ? envToken
    : cryptoRandomBytes(32).toString('hex');
  if (!envToken) {
    console.log(`[main] Generated DAEMON_API_TOKEN (prefix=${apiToken.slice(0, 8)}...)`);
  }

  // The keystore-presence probe happens twice: once now (to decide initial
  // setup-mode) and once after we run init below (to flip the controller).
  const masterKeystorePath = join(config.earningDir, 'master_keystore.json');
  const legacyKeystorePath = join(config.earningDir, 'agent_keystore.json');

  const rpcPreflight = await checkRpcNetwork(config);
  if (!rpcPreflight.ok) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: rpcPreflight.message,
      hint: rpcNetworkFailureHint(rpcPreflight),
      exampleCli: 'jinn doctor --human',
      details: {
        field: 'rpcUrl',
        network: rpcPreflight.network,
        expectedChainId: rpcPreflight.expectedChainId,
        actualChainId: rpcPreflight.actualChainId ?? null,
        rpcHost: rpcPreflight.rpcHost,
        reason: rpcPreflight.reason,
      },
    });
  } else {
    logRpcLocalDevToStderr(rpcPreflight);
  }

  const portPreflight = await checkApiPortAvailable(config.apiPort);
  if (!portPreflight.ok) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: apiPortFailureMessage(portPreflight),
      hint: 'Stop the other daemon or set JINN_API_PORT / apiPort to a free port.',
      exampleCli: 'JINN_API_PORT=7332 jinn run',
      details: {
        field: 'apiPort',
        port: portPreflight.port,
        reason: portPreflight.code ?? 'unavailable',
      },
    });
  }

  // ── Setup-mode API server ────────────────────────────────────────────────
  // Start the operator-facing API early so the SPA can show bootstrap
  // progress while we may still be waiting on funding. The daemon loops are
  // gated until bootstrap completes — we just bring up the API + handshake +
  // /v1/bootstrap + /v1/events + /v1/status here. The same Store instance is
  // later passed into Daemon so we don't double-open the SQLite file.
  const sharedStore = new Store(config.dbPath);
  const earningStateStore = new FleetStateStore(config.earningDir);
  const initialFleet = await earningStateStore.tryLoadExisting();
  const initialServices = initialFleet?.services ?? [];
  const initialAllComplete =
    initialServices.length > 0 && initialServices.every((s) => isOperationalServiceStep(s.step));
  const setupController = createSetupModeController({
    keystoreExists: existsSync(masterKeystorePath),
    allComplete: initialAllComplete,
  });

  const uiToken = ensureUiToken();
  const handshakeKey = cryptoRandomBytes(16).toString('hex');
  const apiBindHost = process.env['JINN_API_BIND_HOST'] ?? '127.0.0.1';
  let corpusForApi: ReturnType<typeof createCorpus> | undefined;

  let setupApiServer: ApiServer;
  try {
    setupApiServer = await startApiServer({
      port: config.apiPort,
      store: sharedStore,
      apiToken,
      bindHost: apiBindHost,
      corpus: config.subgraphUrl?.trim() ? () => corpusForApi : undefined,
      ui: { token: uiToken, handshakeKey },
      admin: {
        onRestartRequested: () => {
          console.log('[main] Restart requested via operator MCP. Exiting...');
          process.exit(0);
        },
      },
      bootstrap: { earningDir: config.earningDir },
      setup: {
        earningDir: config.earningDir,
        chain: NETWORK_CHAIN,
        rpcUrl: config.rpcUrl,
        minEoaGasWei: (CHAIN_CONFIG.minEoaGasEth * 2n).toString(),
      },
      status: {
        earningDir: config.earningDir,
        rpcUrl: config.rpcUrl,
        network: config.network,
        pollIntervalMs: config.pollIntervalMs,
        masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
        rewardClaimIntervalMs: config.rewardClaimIntervalMs,
        testnetL2DeploymentPath: config.testnetL2DeploymentPath,
        testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
        testnetMechDeploymentPath: config.testnetMechDeploymentPath,
        testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
        engine: config.engine,
      },
    });
  } catch (error) {
    sharedStore.close();
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'EADDRINUSE') {
      emitEnvelope({
        code: 'invalid_invocation',
        message: `Port ${config.apiPort} is already in use. Stop the other daemon or set JINN_API_PORT / apiPort to another port.`,
        hint: 'Set JINN_API_PORT to a free port, or stop the process currently listening on the dashboard/API port.',
        exampleCli: 'JINN_API_PORT=7332 jinn run',
        details: {
          field: 'apiPort',
          port: config.apiPort,
          reason: 'EADDRINUSE',
        },
      });
    }
    throw error;
  }
  process.env['JINN_UI_HANDSHAKE_URL'] =
    `http://127.0.0.1:${setupApiServer.port}/?k=${handshakeKey}`;
  // Auto-open the operator panel as soon as the setup-mode API is up so the
  // operator can watch bootstrap progress (including the funding wait, which
  // is the whole point of starting the API early). Suppressed by setting
  // JINN_NO_UI=1 — `jinn run --no-ui` translates the flag into this env var.
  if (process.env['JINN_NO_UI'] !== '1') {
    openBrowser(process.env['JINN_UI_HANDSHAKE_URL']!);
  }
  console.log(
    `[main] Setup-mode API up (mode=${setupController.mode()}). ` +
      `Dashboard: http://127.0.0.1:${setupApiServer.port}`,
  );

  // ── Operator agent WebSocket bridge ──────────────────────────────────────
  // Mount /api/agent/ws on the same HTTP server so the SPA's xterm.js panel
  // can attach to a long-lived embedded `claude` subprocess. The embedded
  // session reads MCP config we materialise to disk so it can reach the
  // operator MCP server (`jinn mcp`) for tool calls.
  const operatorMcpConfigPath = join(homedir(), '.jinn-client', 'operator-mcp-config.json');
  try {
    mkdirSync(dirname(operatorMcpConfigPath), { recursive: true });
    writeFileSyncMain(
      operatorMcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            'jinn-operator': {
              command: 'jinn',
              args: ['mcp'],
            },
          },
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.warn(
      `[main] Failed to write operator MCP config at ${operatorMcpConfigPath}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  attachAgentWs({
    httpServer: setupApiServer.server,
    uiToken,
    claudePath: config.claudePath ?? 'claude',
    cwd: process.cwd(),
    mcpConfigPath: operatorMcpConfigPath,
  });
  console.log(`[main] Agent WS bridge mounted at ws://127.0.0.1:${setupApiServer.port}/api/agent/ws`);

  // ── Init-if-missing ──────────────────────────────────────────────────────
  // If the keystore is missing but we have a password, run `jinn init` now so
  // bootstrap has something to decrypt. Idempotent: init is a no-op when the
  // keystore already exists. This makes `jinn run` work first-time on a fresh
  // host. We run AFTER startApiServer so the operator's panel can already
  // render the loading screen / setup steps while init does its work — the
  // /v1/bootstrap endpoint reports `mode:'uninitialized'` until init writes
  // earning_state.json, then the panel transitions on the next 3s poll.
  if (!existsSync(masterKeystorePath) && !existsSync(legacyKeystorePath)) {
    emitProgress({
      type: 'progress',
      phase: 'init',
      step: 'creating_wallet',
      estimatedWaitMs: 2000,
    });
    emitStructured({ kind: 'system', message: 'creating wallet keystore' });
    console.log('[main] No keystore found — initializing wallet from password.');
    const initCmd = (await import('./cli/commands/init.js')).default;
    let initExitCode = 0;
    await initCmd.run({
      argv: ['--json'],
      stdoutIsTty: false,
      writer: { write: (_s: string) => true }, // discard init's structured output
      exit: (code) => {
        initExitCode = code;
      },
      env: { ...process.env, JINN_PASSWORD: PASSWORD },
    });
    if (initExitCode !== 0) {
      console.error('[main] init failed; cannot continue.');
      await setupApiServer.close().catch(() => undefined);
      sharedStore.close();
      process.exit(initExitCode);
    }
    emitStructured({ kind: 'system', message: 'wallet keystore ready' });
    // Refresh the controller so the panel's loading screen knows the
    // keystore is on disk and we're transitioning into bootstrap.
    setupController.refresh({ keystoreExists: true, allComplete: false });
  }

  let bootstrapResult;
  try {
    bootstrapResult = await bootstrap();
  } catch (err) {
    // If bootstrap throws (vs. emitEnvelope-exits), tear down the API we
    // just started so we don't leave a dangling listener on the port.
    await setupApiServer.close().catch(() => undefined);
    sharedStore.close();
    throw err;
  }

  // Bootstrap completed — flip the controller into 'running' so any waiters
  // (future loops gated on this) unblock.
  setupController.refresh({ keystoreExists: true, allComplete: true });

  // ── --no-daemon: exit cleanly after bootstrap completes ──────────────────
  // `jinn run --no-daemon` flips JINN_NO_DAEMON=1 in run.ts. Emit a JSON
  // summary on stdout and exit 0 so CI / agent flows can stop after the
  // bootstrap state machine reaches 'complete' without paying for the
  // long-lived daemon.
  // We close the setup-mode API server here because its listening socket
  // would otherwise hold the event loop open and prevent process exit.
  if (process.env['JINN_NO_DAEMON'] === '1') {
    console.log('[main] --no-daemon: bootstrap complete, exiting before daemon loops.');
    await setupApiServer.close().catch(() => undefined);
    sharedStore.close();
    const summary = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'run',
      status: 'ready' as const,
      masterAddress: bootstrapResult.masterAddress,
      dashboardUrl: `http://127.0.0.1:${config.apiPort}`,
    };
    process.stdout.write(JSON.stringify(summary) + '\n');
    process.exit(0);
  }

  const {
    agentPrivateKey,
    masterAddress,
    safeAddress,
    mechAddress,
    serviceIndex,
    serviceId,
    stakingAddress,
    agentId,
    identityRegistryAddress,
  } = bootstrapResult;

  if (!mechAddress) {
    emitEnvelope({
      code: 'fatal',
      message: 'Bootstrap completed without a runnable mech deployment.',
      hint: 'Set a valid mech deployment and re-run `jinn run`.',
      exampleCli: 'jinn doctor',
      details: {
        network: config.network,
        expected: 'configured mech deployment with a non-zero mech marketplace address',
      },
    });
  }

  const preflight = await checkClaudeBinary(config.claudePath);
  if (!preflight.ok) {
    emitClaudeBinaryPreflightFailure(preflight.detail, config.claudePath);
  }

  const authContext = detectAuthContext({ cwd: process.cwd(), configuredMode: config.runtimeMode });
  const authProbe = probeClaudeAuth({ context: authContext, cwd: process.cwd() });
  if (!authProbe.authenticated) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: 'Claude is not authenticated. Run `jinn auth` in an interactive terminal before starting the daemon.',
      hint: `Detected context: ${authContext}. The daemon cannot function without Claude authentication.`,
      exampleCli: 'jinn auth',
      details: {
        field: 'claude_auth',
        context: authContext,
        authenticated: false,
      },
    });
  }

  const runner = new ClaudeRunner({
    claudePath: config.claudePath,
    model: config.claudeModel,
  });

  const earningStore = new FleetStateStore(config.earningDir);
  const mnemonicForMaster = await decryptMnemonic(
    await earningStore.loadMnemonicKeystore(),
    PASSWORD,
  );
  const masterAccount = deriveMasterSigner(mnemonicForMaster);
  const publicClient = createJinnPublicClient(config.rpcUrl, NETWORK_CHAIN);
  const masterWallet = createJinnWalletClient(config.rpcUrl, NETWORK_CHAIN, masterAccount);

  const evictionRecovery =
    config.stakingMode === 'standard' &&
    serviceId !== null &&
    stakingAddress &&
    CHAIN_CONFIG.distributorAddress
      ? {
          serviceId,
          stakingProxyAddress: stakingAddress,
          distributorAddress: CHAIN_CONFIG.distributorAddress as `0x${string}`,
          masterWalletClient: masterWallet,
        }
      : undefined;

  const adapter = new MechAdapter({
    rpcUrl: config.rpcUrl,
    mechMarketplaceAddress: MARKETPLACE_ADDRESS,
    routerAddress: ROUTER_ADDRESS,
    mechContractAddress: mechAddress,
    safeAddress,
    agentEoaPrivateKey: agentPrivateKey,
    ipfsRegistryUrl: config.ipfsRegistryUrl,
    ipfsGatewayUrl: config.ipfsGatewayUrl,
    pollIntervalMs: config.pollIntervalMs,
    chainId: config.network === 'testnet' ? 84532 : 8453,
    routerClaimDeliveryVariant: CHAIN_CONFIG.routerClaimDeliveryVersion,
    evictionRecovery,
  });

  // ── TaskEngine wiring ─────────────────────────────────────────────────

  // Build agent viem clients (same creds as MechAdapter uses internally).
  const viemChains = await import('viem/chains');
  const agentChain = config.network === 'testnet'
    ? viemChains.baseSepolia
    : viemChains.base;
  const l1Chain = config.jinnL1Network === 'sepolia' ? viemChains.sepolia : viemChains.mainnet;
  const agentChainContracts = agentChain.contracts as {
    portal?: Record<number, { address: `0x${string}` }>;
    disputeGameFactory?: Record<number, { address: `0x${string}` }>;
  } | undefined;
  const optimismPortalAddress =
    agentChainContracts?.portal?.[l1Chain.id]?.address;
  const disputeGameFactoryAddress =
    agentChainContracts?.disputeGameFactory?.[l1Chain.id]?.address;
  const l2ProofClient = config.l2ProofRpcUrl
    ? createJinnPublicClient(config.l2ProofRpcUrl, NETWORK_CHAIN)
    : undefined;
  const agentClients = createClients(config.rpcUrl, agentPrivateKey, agentChain);

  // ── L1 (Sepolia / Ethereum mainnet) clients for cross-chain JINN claim loop ──
  // Uses the agent EOA because MockMessenger.owner is the agent on testnet.
  // Same key as L2; only the chain differs.
  const l1ClientsForJinnClaim =
    JINN_MVI_CONFIG.distributor && config.ethereumRpcUrl
      ? {
          public: createJinnL1PublicClient(config.ethereumRpcUrl, config.jinnL1Network),
          wallet: createJinnL1WalletClient(
            config.ethereumRpcUrl,
            config.jinnL1Network,
            privateKeyToAccount(agentPrivateKey),
          ),
        }
      : undefined;
  if (l1ClientsForJinnClaim) {
    console.log(
      `[main] JinnClaimLoop: enabled (mode=${JINN_CLAIM_MESSENGER_MODE}, ` +
      `interval=${config.jinnClaimLoopIntervalMs}ms, distributor=${JINN_MVI_CONFIG.distributor}, ` +
      `emitter=${JINN_MVI_CONFIG.claimEmitter})`,
    );
  } else {
    console.log(
      `[main] JinnClaimLoop: disabled (JinnDistributor artifact/override or JINN_ETHEREUM_RPC_URL not set)`,
    );
  }

  // ── Harness registry ─────────────────────────────────────────────────────────

  const solverNetRegistry = await loadSolverNets(config);
  for (const net of solverNetRegistry.list()) {
    const plugins = [net.canonicalPlugin, ...net.plugins]
      .map((plugin) => `${plugin.name}@${plugin.version}`)
      .join(', ');
    console.log(
      `[main] Loaded SolverNet: ${net.name} solverType=${net.solverType} harness=${net.harness} plugins=${plugins}`,
    );
  }

  // Default-disable Harnesses with external dependencies the operator must opt into.
  const DEFAULT_DISABLED_HARNESSES = ['claude-mcp-hyperliquid'];
  const DEFAULT_HARNESS = 'claude-code-learner';
  const implRegistry = new HarnessRegistry({
    solverTypeHarnesses: solverNetRegistry.harnessSelections(),
    default: config.harnesses?.default ?? DEFAULT_HARNESS,
    disabled: config.harnesses?.disabled ?? [...DEFAULT_DISABLED_HARNESSES],
  });

  // Load operator-supplied external harness impls (Path 2 plug-in surface).
  // Each entry in `config.harnesses.externalImpls` is verified against
  // `config.trustedImplSigners` before its factory is invoked. Failed loads
  // are logged + skipped — they don't bring down the daemon.
  const externalImpls: Harness[] = [];
  const trustedSigners = config.trustedImplSigners ?? [];
  const externalEntries = config.harnesses?.externalImpls ?? [];
  if (externalEntries.length > 0) {
    for (const entry of externalEntries) {
      const result = await loadExternalImpl({
        entry: {
          name: entry.name,
          entry: entry.entry,
          package: entry.package,
          version: entry.version,
        },
        trustedSigners,
        env: {
          implName: entry.name,
          implVersion: '0.0.0', // overridden by manifest validation below
          network: config.network,
          implStateDir: join(config.engine.implStateDirRoot, entry.name),
          secrets: Object.freeze({}),
          log: ({ level, msg, data }) =>
            console.log(`[external-impl:${entry.name}] [${level}] ${msg}`, data ?? ''),
          stub: false,
        },
      });
      if (result.kind === 'ok') {
        externalImpls.push(result.impl);
        console.log(`[main] Loaded external impl: ${result.impl.name}@${result.impl.version}`);
      } else {
        console.warn(
          `[main] Failed to load external impl ${entry.name}: ${result.reason}` +
            (result.detail ? ` (${result.detail})` : ''),
        );
      }
    }
  }

  // legacy-claude: wraps ClaudeRunner; handles spec=undefined (health-check) tasks
  const corpusEnv: RunnerContext['corpusEnv'] | undefined =
    config.subgraphUrl?.trim()
      ? {
          subgraphUrl: config.subgraphUrl,
          ipfsGatewayUrl: config.ipfsGatewayUrl,
        }
      : undefined;

  for (const impl of buildHarnesses({
    rpcUrl: config.rpcUrl,
    archiveRpcUrl: config.archiveRpcUrl,
    claudePath: config.claudePath,
    claudeModel: config.claudeModel,
    pk: agentPrivateKey,
    safe: safeAddress,
    runner,
    storePath: config.dbPath,
    daemonApiUrl: `http://127.0.0.1:${config.apiPort}`,
    daemonApiToken: apiToken,
    implStateDirRoot: config.engine.implStateDirRoot,
    externalImpls,
    disabledNames: config.harnesses?.disabled,
    corpusEnv,
  })) {
    implRegistry.register(impl);
  }

  console.log(`[main] HarnessRegistry: ${implRegistry.list().map(i => i.name).join(', ')}`);

  // ── Engine deps ───────────────────────────────────────────────────────────────

  // Packaging deps: artifact bytes are written to served_artifacts (operator-local
  // SQLite) and served via the operator's HTTP server with x402 gating per
  // spec/2026-04-30-phase-a-umbrella.md §1. IPFS only holds the manifest envelope.
  // The `store` field is filled by Daemon (which owns the SQLite handle); here
  // we just configure the endpoint + price defaults from `config.operator`
  // (Phase 3, jinn-mono-vy37.1.3). Operators who don't declare an operator
  // block fall back to the daemon's local API port so dev/test runs still work
  // — but the resulting envelopes won't be reachable from outside the host.
  const operatorPublicEndpoint =
    config.operator?.publicEndpoint ?? `http://localhost:${config.apiPort}`;
  const operatorDefaultPrice = config.operator?.defaultPriceUsdc ?? '0';
  const operatorPerTypePrice = config.operator?.perArtifactTypePrice ?? {};
  if (!config.operator?.publicEndpoint) {
    console.warn(
      '[main] config.operator.publicEndpoint not set; defaulting to local API port. ' +
        'External evaluators will not be able to fetch artifacts from this operator. ' +
        'Set operator.publicEndpoint (or JINN_OPERATOR_PUBLIC_ENDPOINT) before going live.',
    );
  }
  const packagingDeps = {
    operatorEndpoint: operatorPublicEndpoint,
    defaultPriceUsdc: operatorDefaultPrice,
    perArtifactTypePrice: operatorPerTypePrice,
  };
  const operatorConfig = {
    publicEndpoint: operatorPublicEndpoint,
    defaultPriceUsdc: operatorDefaultPrice,
    perArtifactTypePrice: operatorPerTypePrice,
  };

  // Envelope assembly deps: sign envelopes with agent EOA private key
  const envelopeDeps = {
    ipfsRegistryUrl: config.ipfsRegistryUrl,
    agentEoaPrivateKey: agentPrivateKey,
    safeAddress,
  };

  // Delivery deps: deliver to marketplace + claimDelivery via JinnRouter
  const deliveryDeps = {
    publicClient: agentClients.publicClient,
    walletClient: agentClients.walletClient,
    safeAddress,
    mechContractAddress: mechAddress,
    routerAddress: ROUTER_ADDRESS,
    claimDeliveryVariant: CHAIN_CONFIG.routerClaimDeliveryVersion,
    evictionRecovery,
  };

  // ── IdentityPublisher (jinn-mono-3zk) ───────────────────────────────────────
  //
  // When the bootstrap has minted an ERC-8004 IdentityRegistry NFT for the
  // active service (agent_id non-null) AND we know the registry address, wire
  // an IdentityPublisher so the engine anchors each envelope under the
  // operator's agent NFT via setMetadata. Otherwise log a warning — publishing
  // is disabled until bootstrap completes that step (jinn-mono-j07).
  let identityPublisher: import('./erc8004/index.js').IdentityPublisher | undefined;
  if (agentId && identityRegistryAddress) {
    const { IdentityPublisher } = await import('./erc8004/index.js');
    identityPublisher = new IdentityPublisher({
      identityRegistryAddress,
      agentId: BigInt(agentId),
      walletClient: agentClients.walletClient,
      publicClient: agentClients.publicClient,
    });
    console.log(
      `[main] IdentityPublisher: agentId=${agentId} registry=${identityRegistryAddress}`,
    );
  } else {
    console.log(
      '[main] IdentityPublisher: disabled (no agent_id on active service — re-run bootstrap to mint the operator agent NFT)',
    );
  }

  // ── Reputation feedback hook (jinn-mono-yg4) ──────────────────────────────
  //
  // After the evaluator's claimDelivery succeeds, the engine fires
  // `ReputationRegistry.giveFeedback(harnessAgentId, …)` so the harness's
  // agent NFT accrues a rating (DR §4.3). This requires:
  //
  //   1. A `ReputationRegistryClient` for the active chain. We use the
  //      canonical 0x8004… deployment; writes route through the operator's
  //      Safe so `msg.sender` matches the OLAS staking + 8004 IdentityRegistry
  //      identity.
  //   2. An agentId resolver — looks up the harness's agentId from the
  //      parent manifest's evidenceHash via the subgraph. When `subgraphUrl`
  //      is unconfigured the resolver returns null cleanly and the hook
  //      becomes a no-op (defensive: feedback is non-fatal).
  //
  // Skipped when the operator hasn't minted an agent NFT yet (matches the
  // IdentityPublisher gating above).
  let reputationFeedback:
    | NonNullable<import('./harnesses/engine/engine.js').TaskEngineOptions['reputationFeedback']>
    | undefined;
  if (agentId) {
    const { getReputationRegistryAddress, ReputationRegistryClient } = await import(
      './erc8004/index.js'
    );
    const chainId = config.network === 'testnet' ? 84532 : 8453;
    const reputationRegistryAddress = getReputationRegistryAddress(chainId);
    if (reputationRegistryAddress) {
      const reputationClient = new ReputationRegistryClient({
        reputationRegistryAddress,
        publicClient: agentClients.publicClient,
        walletClient: agentClients.walletClient,
        safeAddress,
      });
      const { resolveAgentIdForManifest } = await import(
        './erc8004/index.js'
      );
      const subgraphUrl = config.subgraphUrl;
      reputationFeedback = {
        client: reputationClient,
        resolveAgentId: (manifestHash) =>
          resolveAgentIdForManifest({ manifestHash, subgraphUrl }),
      };
      console.log(
        `[main] ReputationFeedback: registry=${reputationRegistryAddress}${subgraphUrl ? ` subgraph=${subgraphUrl}` : ' (no subgraph configured — resolver always null)'}`,
      );
    } else {
      console.log(
        `[main] ReputationFeedback: disabled (no canonical ReputationRegistry deployed on chainId=${chainId})`,
      );
    }
  } else {
    console.log(
      '[main] ReputationFeedback: disabled (no agent_id on active service — same gating as IdentityPublisher)',
    );
  }

  // ── Auto Task generators (testnet only, opt-out via env) ─────────────────
  const autoTasksDisabled =
    process.env['JINN_DISABLE_AUTO_TASKS'] === '1';
  const { privateKeyToAccount: _pkToAccount } = await import('viem/accounts');
  const agentEoaAddress = _pkToAccount(agentPrivateKey).address as `0x${string}`;
  const { generators: autoTaskGenerators, logLines: autoTaskLogLines } = collectTestnetAutoTaskGenerators({
    network: config.network,
    rpcUrl: config.rpcUrl,
    autoTasksDisabled,
    env: process.env,
    agentEoa: agentEoaAddress,
    safeAddress,
    agentPrivateKey,
    predictionV1WindowMs: config.predictionV1WindowMs,
    predictionV1ResolveGapMs: config.predictionV1ResolveGapMs,
  });
  for (const line of autoTaskLogLines) {
    console.log(line);
  }
  if (config.network === 'mainnet' && !autoTasksDisabled && BASE_FEEDS['ETH / USD']) {
    // Mainnet auto-task opt-in only; default is OFF. Reserved for a future flag.
  }
  const taskSources = [
    new StaticConfiguredTaskSource(config.tasks),
    ...autoTaskGenerators
      .filter(({ solverType }) => solverNetRegistry.forSolverType(solverType)?.taskGenerator.enabled)
      .map(({ solverType, generator }) => new GeneratedTaskSource(`generated:${solverType}`, generator)),
  ];

  // ── Corpus (daemon-side, jinn-mono-vy37.1.6) ─────────────────────────────
  //
  // Built once per daemon lifetime; the agent EOA private key stays in this
  // process's memory and never crosses into the MCP subprocess. The MCP
  // tool `acquire_artifact` proxies to `POST /v1/artifacts/acquire` instead.
  // Disabled when subgraphUrl is unset — the API route is then absent and
  // MCP falls back to local-only behaviour with a warning.
  const corpusFactory = config.subgraphUrl?.trim()
    ? (store: Store) =>
        (corpusForApi = createCorpus({
          subgraphUrl: config.subgraphUrl!,
          ipfsGatewayUrl: config.ipfsGatewayUrl,
          store,
          signer: { privateKey: agentPrivateKey },
          selfSafeAddress: safeAddress,
        }))
    : undefined;
  if (!corpusFactory) {
    console.warn(
      '[main] Corpus disabled (config.subgraphUrl not set); ' +
        'MCP acquire_artifact / search_artifacts network branches will be unavailable.',
    );
  }

  const daemon = new Daemon({
    adapter,
    runner,
    taskSources,
    dbPath: config.dbPath,
    store: sharedStore,
    apiServer: setupApiServer,
    pollIntervalMs: config.pollIntervalMs,
    apiPort: config.apiPort,
    apiBindHost,
    apiToken,
    peers: config.peers.length > 0 ? config.peers : undefined,
    subgraphUrl: config.subgraphUrl,
    nodeEndpoint: config.nodeEndpoint,
    creatorSafeAddress: safeAddress,
    corpusFactory,
    status: {
      earningDir: config.earningDir,
      rpcUrl: config.rpcUrl,
      network: config.network,
      pollIntervalMs: config.pollIntervalMs,
      masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
      rewardClaimIntervalMs: config.rewardClaimIntervalMs,
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
      engine: config.engine,
    },
    rewardClaim:
      config.rewardClaimIntervalMs > 0
        ? {
            intervalMs: config.rewardClaimIntervalMs,
            publicClient,
            masterWallet,
            store: earningStore,
            chain: NETWORK_CHAIN,
            distributorAddress: CHAIN_CONFIG.distributorAddress,
          }
        : undefined,
    jinnClaim:
      l1ClientsForJinnClaim &&
      JINN_MVI_CONFIG.claimEmitter &&
      JINN_MVI_CONFIG.messenger &&
      JINN_MVI_CONFIG.distributor &&
      config.jinnClaimLoopIntervalMs > 0
        ? {
            intervalMs: config.jinnClaimLoopIntervalMs,
            l2Client: agentClients.publicClient,
            l2ProofClient,
            l2Wallet: agentClients.walletClient,
            l1Client: l1ClientsForJinnClaim.public,
            l1Wallet: l1ClientsForJinnClaim.wallet,
            store: earningStore,
            chain: NETWORK_CHAIN,
            claimEmitterAddress: JINN_MVI_CONFIG.claimEmitter as `0x${string}`,
            distributorAddress: JINN_MVI_CONFIG.distributor as `0x${string}`,
            messengerAddress: JINN_MVI_CONFIG.messenger as `0x${string}`,
            messengerMode: JINN_CLAIM_MESSENGER_MODE,
            optimismPortalAddress,
            disputeGameFactoryAddress,
          }
        : undefined,
    restorationEngine: {
      paths: {
        workingDirRoot: config.engine.workingDirRoot,
        implStateDirRoot: config.engine.implStateDirRoot,
      },
      packagingDeps,
      envelopeDeps,
      deliveryDeps,
      implRegistry,
      solverNetRegistry,
      identityPublisher,
      reputationFeedback,
      operatorConfig,
    },
    balanceTopup:
      config.balanceTopupIntervalMs > 0
        ? {
            intervalMs: config.balanceTopupIntervalMs,
            publicClient,
            masterWallet,
            store: earningStore,
            chain: NETWORK_CHAIN,
            eoaTopupTrigger: CHAIN_CONFIG.eoaTopupTrigger,
            eoaTopupTarget: CHAIN_CONFIG.minEoaGasEth,
            safeTopupTrigger: CHAIN_CONFIG.safeTopupTrigger,
            safeTopupTarget: CHAIN_CONFIG.minSafeEth,
          }
        : undefined,
  });

  // Graceful shutdown — Daemon doesn't own the API server or Store in this
  // flow (they were created in setup-mode before bootstrap), so we close
  // them explicitly after Daemon.stop() completes.
  const shutdown = async (signal: string) => {
    console.log(`\n[main] Received ${signal}, shutting down...`);
    await daemon.stop();
    await setupApiServer.close().catch(() => undefined);
    sharedStore.close();
    console.log('[main] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Write pidfile so `jinn stop` can find us.
  const pidPath = join(config.earningDir, 'daemon.pid');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(pidPath, String(process.pid) + '\n', 'utf-8');
  const removePidfile = () => {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', removePidfile);

  emitProgress({
    type: 'progress',
    phase: 'daemon',
    step: 'starting',
    estimatedWaitMs: 5000,
  });

  try {
    await daemon.start();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'EADDRINUSE') {
      emitEnvelope({
        code: 'invalid_invocation',
        message: `Port ${config.apiPort} is already in use. Stop the other daemon or set JINN_API_PORT / apiPort to another port.`,
        hint: 'Set JINN_API_PORT to a free port, or stop the process currently listening on the dashboard/API port.',
        exampleCli: 'JINN_API_PORT=7332 jinn run',
        details: {
          field: 'apiPort',
          port: config.apiPort,
          reason: 'EADDRINUSE',
        },
      });
    }
    throw error;
  }
  console.log(`[main] Daemon running. Dashboard: http://127.0.0.1:${config.apiPort}`);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: 'daemon_started',
    pid: process.pid,
    network: config.network,
    phase: config.network === 'testnet' ? 'phase-1b' : 'phase-0',
    apiPort: config.apiPort,
    masterAddress,
    safeAddress,
    mechAddress,
    serviceIndex,
    serviceId,
  };
}
