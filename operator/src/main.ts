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
import { homedir, hostname, userInfo } from 'node:os';
import { randomBytes as cryptoRandomBytes, randomUUID as cryptoRandomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, getConfigPathFromArgs, DEFAULT_CONFIG_PATH, DEFAULT_TESTNET_RPC_URLS } from './config.js';
import { resolveApiBindHost, isLoopbackBindHost } from './preflight/api-bind-host.js';
import { Store } from './store/store.js';
import { startApiServer, type ApiServer } from './api/server.js';
import { setDefaultTxSubmissionLedger, withEoaBroadcastLock } from './tx-retry.js';
// addHarnessReadinessRoutes is wired through startApiServer's holder ref now
// (jinn-mono-u34i). No direct import needed.
import { invalidatePredictionOperatorStatusCache } from './api/gather-status.js';
import { ensureUiTokenRecord, defaultTokenPath } from './api/ui-token.js';
import { daemonApiTokenPath, ensureDaemonApiToken } from './api/daemon-token.js';
import { decideUiAutoOpen } from './cli/ui-auto-open-gate.js';
import { getFileLogger, closeFileLogger } from './observability/file-logger.js';
import { emitProgress } from './observability/progress.js';
import { hashImplStateDir } from './harnesses/freeze.js';
import { hashProfileForHarness } from './harnesses/hash-profile.js';
import { readModeState } from './harnesses/mode-state.js';
import { createSetupModeController } from './setup-mode.js';
import { formatBootstrapOperatorMessage } from './operator-errors.js';
import { requestDaemonRestart } from './restart-daemon.js';
import { emitEnvelope, type ErrorEnvelope } from './errors/envelope.js';
import { emitStructured } from './events/emitter.js';
import { checkClaudeBinary } from './preflight/claude-binary.js';
import { emitClaudeBinaryPreflightFailure } from './preflight/claude-invocation-envelope.js';
import { applyPidfileLivenessGate } from './preflight/pidfile-liveness.js';
import { applyDeploymentReadinessGate } from './preflight/deployment-readiness.js';
import { ensureStableCwd } from './preflight/stable-cwd.js';
import { detectAuthContext } from './preflight/claude-auth.js';
import { FleetBootstrapper, recoverEvictedService as recoverEvictedServiceFn } from './earning/bootstrap.js';
import { runFleetBootstrap, runBootstrapWithDegradeOpen } from './earning/bootstrap-run.js';
import { isEconomicBootstrapHalt, isPendingMasterFundingHalt } from './earning/bootstrap-halt-classification.js';
import { startDegradedRecoveryLoops } from './daemon/degraded-recovery.js';
import {
  setDaemonReadiness,
  getDaemonReadiness,
  buildLoopMetricsSnapshot,
} from './daemon/loop-heartbeat.js';
import { applyChainGasOverrides, getChainConfig } from './earning/contracts.js';
import { addressSetFromChainConfig, isAddressDigestCheckOverridden, verifyBroadcastTargetAddressSet } from './earning/address-digests.js';
import { getJinnRouterAddress } from './contracts/addresses.js';
import { FleetStateStore } from './earning/store.js';
import { isOperationalServiceStep } from './earning/types.js';
import { decryptMnemonic, deriveMasterSigner } from './earning/wallet.js';
import { deriveLegacyBridgeSigner } from './daemon/trust-keys.js';
import { MechAdapter } from './adapters/mech/adapter.js';
import { ClaudeRunner } from './runner/claude.js';
import type { RunnerContext } from './runner/runner.js';
import { Daemon } from './daemon/daemon.js';
import {
  buildDaemonStartupInfo,
  resolveMainEntryEffectiveMode,
  type DaemonStartupInfo,
} from './daemon/daemon-startup-info.js';
import { resolveConfiguredOperatorVerticalMode } from './daemon/native-vertical-config.js';
import { resolveFleetCompositionMode } from './daemon/native-composition-mode.js';
import { buildSpendCapConfig } from './spend/daemon-config.js';
import { buildAiUnitsConfig } from './spend/ai-units-config.js';
import { REFERENCE_CEILING } from './spend/ai-units.js';
import { createJinnPublicClient, createJinnWalletClient } from './earning/viem-clients.js';
import type { PluginPublicationReader } from './plugin-registry/publication-reader.js';
import {
  createPluginPublicationReader,
  createRpcPluginLogSource,
} from './plugin-registry/publication-host.js';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address } from 'viem';
import {
  DEFAULT_DISABLED_HARNESSES,
  DEFAULT_HARNESS,
  HarnessRegistry,
} from './harnesses/engine/registry.js';
import { createAutopilotEvaluationContextResolver } from './autopilot/autopilot-evaluation-context-resolver.js';
import { createAutopilotGitHubAdoptionReceiptObserver } from './autopilot/github-adoption-receipt-observer.js';
import { createJinnMonoGitHubAdoptionReadPort } from './autopilot/github-rest-adoption-read.js';
import { buildHarnesses } from './harnesses/impls/index.js';
import { protocolExecutorMode } from './erc8004/identity.js';
import {
  makeConfiguredSemanticEvaluatorRunnerResolver,
} from './harnesses/impls/jinn-repo-evaluator/semantic-runner-resolver.js';
import {
  makeDockerImmutableMechanicalVerifier,
} from './harnesses/impls/jinn-repo-evaluator/docker-immutable-verifier.js';
import { loadExternalImpl } from './harnesses/external-impls/index.js';
import { harnessStateDirName } from './harnesses/names.js';
import type { Harness } from './harnesses/types.js';
import { HarnessReadinessRegistry } from './harnesses/readiness-registry.js';
import type { JinnConfig } from './config.js';
import { createClients, type VenueBroadcaster } from './adapters/mech/safe.js';
import {
  loadSolverNets,
} from './solver-nets/registry.js';
import {
  contractRefFromWorkKind,
  discoveryDigestsFromWiring,
  wiringParticipationKey,
} from './config/participation.js';
import { createCorpus } from './corpus/index.js';
import { DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK } from './corpus/onchain-query.js';
import { createHttpCorpusDiscovery } from '@jinn-network/core/corpus-read';
import { createArchiveReadsFromStore, type ArchiveReads } from './archive/reads.js';
import { CapturesStore } from './store/captures.js';
import { createLiveCapturePublisher } from './captures/live-publisher.js';
import { EnsurePendingCaptureProcessor, ensurePendingCapture, ingestStopHookCapture } from './captures/ingest.js';
import { startReceiver, type Receiver } from './trajectory/receiver.js';
import { startSyntheticSpanProvider, emitSyntheticSpan } from './trajectory/synthetic-span-builder.js';
import { CredentialScrubProcessor } from './trajectory/processors/credential-scrub.js';
import { TranscriptContentScrubProcessor } from './trajectory/processors/transcript-content-scrub.js';
import { IdentityScrubProcessor } from './trajectory/processors/identity-scrub.js';
import { PathScrubProcessor } from './trajectory/processors/path-scrub.js';
import {
  buildScrubPipeline,
  maybeBuildPiiDetector,
} from '@jinn-network/core/scrub';
import { SqliteExporterProcessor } from './trajectory/processors/sqlite-exporter.js';
import {
  startTranscriptWatcher,
  type DispatchEnvelope,
  type TranscriptWatcher,
} from './trajectory/transcript-watcher.js';
import { defaultTranscriptWatchDirectories } from './trajectory/transcript-session-dirs.js';
import { buildInfo } from './build-info.js';
import {
  checkRpcNetwork,
  logRpcLocalDevToStderr,
  probeFallbackChain,
  type ProbeResult,
  rpcNetworkFailureHint,
  summarizeFallbackChain,
} from './preflight/rpc-network.js';
import { apiPortFailureMessage, checkApiPortAvailable } from './preflight/api-port.js';
import {
  fetchLatestVersion,
  getRunningVersion,
  isNewerVersion,
  isVersionCheckEnabled,
  formatUpdateLogLine,
  VERSION_CHECK_INTERVAL_MS,
} from './preflight/version-check.js';
import { openBrowser } from './cli/open-browser.js';
import { resolveDefaultStateDir } from './state-dir.js';

if (process.env['JINN_LOAD_DEV_ENV'] === '1' || process.env['NODE_ENV'] === 'development') {
  dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
}

// ── Password (env > file > auto-generated) ─────────────────────────────────
//
// Resolution order:
//   1. JINN_PASSWORD env var (explicit operator-set, never in config files)
//   2. ~/.jinn-client/keystore-password (file from a previous auto-gen)
//   3. Auto-generate a 32-byte hex string, persist mode 0600, and reuse next run
//
// Auto-generation matches `jinn run` CLI password behavior so a brand-new
// operator can run `jinn run` with no env var, no setup, no input. The
// known security trade-off is documented in operator/src/cli/password.ts:
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
  const pwFilePath = join(resolveDefaultStateDir({ home }), 'keystore-password');
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
/**
 * One-swap M2 (#2461): the network AS WRITTEN, captured before the pre-launch clamp below rewrites
 * mainnet to testnet. `resolveFleetCompositionMode` gates on THIS value, not the clamped one — an
 * operator who wrote `network: "mainnet"` with `compositionMode: "native"` must see the refusal
 * (DR-2026-08-05 decision 8). Letting the clamp turn that into a quiet native-on-testnet boot would
 * be exactly the silent fallback the decision forbids.
 */
const CONFIGURED_NETWORK: 'mainnet' | 'testnet' = config.network;
if (config.network === 'mainnet' && process.env['JINN_ENABLE_MAINNET'] !== '1') {
  console.warn('[main] Mainnet is disabled before launch; using testnet defaults.');
  config.network = 'testnet';
  config.rpcUrl = 'https://base-sepolia-rpc.publicnode.com';
}
// #2380 / D5: recomputed here (not threaded through argv) so /v1/status and daemon_started
// report the resolved vertical mode. After D5 every `jinn run` reaches this file; leftover
// `operator.verticalMode: "native-v1"` is clamped to 'legacy' with a loud warning rather than
// implying a second entry still exists.
const verticalDecision = resolveConfiguredOperatorVerticalMode(config);
const { effectiveMode: reportedEffectiveMode, warning: verticalModeWarning } =
  resolveMainEntryEffectiveMode(verticalDecision);
if (verticalModeWarning !== undefined) {
  console.warn(`[main] WARNING: ${verticalModeWarning}`);
}
/**
 * One-swap M2 (#2461, DR-2026-08-05): which composition this ONE fleet daemon assembles.
 *
 * Absent `compositionMode` is legacy, so today's boot is byte-identical — nothing native is
 * constructed and `native-fleet-runtime.js` is not even imported. Wave 3's deploy PR sets the key.
 *
 * Resolved HERE, at the top of boot, deliberately: `assertNativeDeployment` throws on native +
 * mainnet, and that refusal must happen before a wallet is unlocked or a loop is built, not
 * halfway through composition. Distinct from `verticalDecision` above (retired axis 1);
 * this selects a COMPOSITION inside the single remaining entry.
 */
const COMPOSITION_MODE = resolveFleetCompositionMode({
  compositionMode: config.compositionMode,
  configuredNetwork: CONFIGURED_NETWORK,
});
if (COMPOSITION_MODE === 'native') {
  console.log('[main] composition mode: native (one-swap; compositionMode="native")');
}

let activeClaudePath = config.claudePath ?? 'claude';
const selectClaudePath = (claudePath: string): void => {
  activeClaudePath = claudePath;
  config.claudePath = claudePath;
};

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
const MARKETPLACE_ADDRESS = CHAIN_CONFIG.mechMarketplace as `0x${string}`;
const ROUTER_ADDRESS = (CHAIN_CONFIG.jinnRouter ?? getJinnRouterAddress(CHAIN_CONFIG.chainId)) as `0x${string}`;

/** #913: the bundled public RPC fallback chain for the current network. The
 *  setup/network endpoint persists `[primary, ...RPC_PUBLIC_DEFAULTS]` so the
 *  operator keeps the public backup chain when they set a primary, and the
 *  Settings → Network UI renders these as the trailing read-only slots. */
const RPC_PUBLIC_DEFAULTS: readonly string[] =
  NETWORK_CHAIN === 'base-sepolia' ? DEFAULT_TESTNET_RPC_URLS : [CHAIN_CONFIG.rpcUrl];

/** #913: last L2 boot-probe result per RPC slot. Captured at boot, surfaced
 *  via /v1/bootstrap so Settings → Network can render per-slot health. Hosts
 *  are already masked by probeFallbackChain. The RPC chain is restart-required,
 *  so this never drifts without a re-probing restart. */
let lastL2Probe: ProbeResult[] = [];

function configFileHasTopLevelKey(configPath: string | undefined, key: string): boolean {
  const filePath = configPath ?? join(resolveDefaultStateDir(), 'config.json');
  if (!filePath || !existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return !!raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
}

export type { DaemonStartupInfo };

export interface SetupHaltedInfo {
  schemaVersion: 1;
  generatedAt: string;
  kind: 'setup_halted';
  pid: number;
  network: 'testnet' | 'mainnet';
  phase: 'phase-1b' | 'phase-0';
  apiPort: number;
  dashboardUrl: string;
  error: ErrorEnvelope;
}

// hjex.6: gate for the halt-and-resume loop. Lives in ./setup/halt-mode.ts
// so it can be unit-tested without dragging main.ts's top-level side
// effects (password resolution, config load) into the test.

// ── Main ────────────────────────────────────────────────────────────────────

export async function main(): Promise<DaemonStartupInfo | SetupHaltedInfo | void> {
  // Issue #909: chdir to a stable directory before spawning any child process.
  // `jinn run` inherits the launch shell's CWD; when daemonised from an
  // ephemeral dir that is later deleted, the CWD becomes a dangling inode and
  // child processes (the `claude` CLI harness probe) crash on getcwd() ENOENT.
  // Must run first — before getFileLogger() and any subprocess spawn.
  ensureStableCwd({ earningDir: config.earningDir });

  console.log(`[main] jinn-client starting on ${NETWORK_CHAIN}`);

  // Issue #420: initialise the rotating daemon file logger early so lifecycle
  // events (tapped in `observability/emit-event.ts`) accumulate durable,
  // pre-redacted log lines for the one-click debug report. Constructing the
  // singleton here also runs the startup age-based cleanup of stale rotations.
  getFileLogger();

  // ── Daemon API bearer token (jinn-mono-pr64 hardening; §14.2) ────────────
  //
  // Cost-mutating API routes (`POST /v1/artifacts/acquire`, `POST /artifacts`)
  // and the `POST /api/stop-hook` compat path require an
  // `Authorization: Bearer <token>` header. Read from env when operators
  // want a stable token (e.g. multi-process tools); otherwise resolve the
  // token persisted at `<earningDir>/daemon-api-token` (mode 0600),
  // generating it once on first boot. Persistence (not a fresh random value
  // per boot) is required so an externally-installed stop-hook — the only
  // production consumer of the bearer on the stop-hook route — has a stable
  // value it can resolve when `DAEMON_API_TOKEN` isn't already in its own
  // environment; see `jinn-stop-hook.ts`'s file-fallback. Logged only as an
  // 8-char prefix. The token is forwarded to the MCP subprocess via
  // `DAEMON_API_TOKEN` env so `acquire_artifact` and
  // `submit_restoration_result` can authenticate their calls back to the
  // daemon.
  const envToken = process.env['DAEMON_API_TOKEN']?.trim();
  const daemonApiTokenFilePath = daemonApiTokenPath(config.earningDir);
  let apiToken: string;
  if (envToken && envToken.length > 0) {
    apiToken = envToken;
  } else {
    const resolved = ensureDaemonApiToken(daemonApiTokenFilePath);
    apiToken = resolved.token;
    const verb = resolved.source === 'generated' ? 'Generated' : 'Loaded';
    console.log(`[main] ${verb} DAEMON_API_TOKEN at ${daemonApiTokenFilePath} (prefix=${apiToken.slice(0, 8)}...)`);
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

  // Boot-time RPC fallback-chain probe (issue #592, AC7 + AC9). Log-only —
  // per-slot 429s/5xx never gate startup. checkRpcNetwork above already
  // fail-loud on chain-id mismatch against the head provider.
  lastL2Probe = await probeFallbackChain(config.rpcUrls, config.network, 'L2');
  console.error(summarizeFallbackChain('L2', config.rpcUrls));

  // Pinned broadcast-target address-set digest (#2407, spec §5). Integrity
  // class — fail closed, never degrade-open: a resolved
  // {staking proxy, distributor, marketplace, router, OLAS token} set that
  // doesn't match the checked-in per-network digest means this daemon would
  // broadcast against unexpected contracts (deployment-artifact paths are
  // env-overridable; address fields are otherwise only presence-checked).
  if (isAddressDigestCheckOverridden()) {
    console.warn(
      '[main] JINN_ADDRESS_DIGEST_OVERRIDE is set — skipping the pinned broadcast-target ' +
        'address-set digest check. Only use this for a local Anvil fork or another deployment ' +
        'deliberately not matching the pinned production address set.',
    );
  } else {
    const addressSetCheck = verifyBroadcastTargetAddressSet({
      chainId: CHAIN_CONFIG.chainId,
      // #2407 L2: goes through the same helper the test suite calls against
      // getChainConfig(...) directly, rather than reconstructing the set
      // inline here — one place for the router fallback to live, so the
      // test suite's coverage is the production set, not a narrower stand-in.
      set: addressSetFromChainConfig(CHAIN_CONFIG),
    });
    if (!addressSetCheck.ok) {
      emitEnvelope({
        code: 'invalid_invocation',
        message: addressSetCheck.message,
        hint: 'Verify the resolved deployment-artifact paths (testnetL2DeploymentPath / testnetMechDeploymentPath / testnetStolasDeploymentPath / JINN_TESTNET_*_DEPLOYMENT), or set JINN_ADDRESS_DIGEST_OVERRIDE=1 for a deliberately non-production deployment (e.g. a local Anvil fork).',
        exampleCli: 'jinn doctor --human',
        details: { field: 'addressSetDigest', chainId: CHAIN_CONFIG.chainId, diverged: addressSetCheck.diverged },
      });
    }
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

  const preflightEarningStateStore = new FleetStateStore(config.earningDir);
  const archivedMismatchedState =
    await preflightEarningStateStore.archiveIfChainMismatch(NETWORK_CHAIN);
  if (archivedMismatchedState) {
    console.warn(
      `[main] Archived ${archivedMismatchedState.actualChain} earning state before starting ` +
        `${archivedMismatchedState.expectedChain}. ` +
        `Files: ${archivedMismatchedState.archivedPaths.join(', ')}`,
    );
  }

  // ── Setup-mode API server ────────────────────────────────────────────────
  // Start the operator-facing API early so the SPA can show bootstrap
  // progress while we may still be waiting on funding. The daemon loops are
  // gated until bootstrap completes — we just bring up the API + handshake +
  // /v1/bootstrap + /v1/events + /v1/status here. The same Store instance is
  // later passed into Daemon so we don't double-open the SQLite file.
  const sharedStore = new Store(config.dbPath);
  setDefaultTxSubmissionLedger(sharedStore);
  const capturesStore = new CapturesStore(sharedStore);
  let captureReceiver: Receiver | undefined;
  try {
    captureReceiver = await startReceiver({
      grpcPort: 4317,
      httpPort: 4318,
      processors: [
        new CredentialScrubProcessor(),
        new TranscriptContentScrubProcessor(),
        new IdentityScrubProcessor({
          username: userInfo().username,
          hostname: hostname(),
        }),
        new PathScrubProcessor({ home: homedir() }),
        new EnsurePendingCaptureProcessor(capturesStore),
        new SqliteExporterProcessor({ captures: capturesStore }),
      ],
    });
    console.log(
      `[main] Capture OTLP receiver listening on grpc=:${captureReceiver.grpcPort} http=:${captureReceiver.httpPort}`,
    );
  } catch (err) {
    console.warn(
      '[main] Capture OTLP receiver disabled; path-A telemetry capture unavailable: ' +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let transcriptWatcher: TranscriptWatcher | undefined;
  let pathBSyntheticSpanProvider: ReturnType<typeof startSyntheticSpanProvider> | undefined;

  const closePathBTranscriptWatcher = async () => {
    const watcher = transcriptWatcher;
    const provider = pathBSyntheticSpanProvider;
    transcriptWatcher = undefined;
    pathBSyntheticSpanProvider = undefined;
    await Promise.all([
      watcher?.shutdown().catch(() => undefined),
      provider?.shutdown().catch(() => undefined),
    ]);
  };

  const closeCaptureReceiver = async () => {
    await closePathBTranscriptWatcher();
    const receiver = captureReceiver;
    captureReceiver = undefined;
    await receiver?.shutdown().catch(() => undefined);
  };

  if (captureReceiver) {
    try {
      const watchDirectories = defaultTranscriptWatchDirectories();
      if (watchDirectories.length > 0) {
        pathBSyntheticSpanProvider = startSyntheticSpanProvider({
          otlpHttpEndpoint: `http://127.0.0.1:${captureReceiver.httpPort}/v1/traces`,
        });
        transcriptWatcher = await startTranscriptWatcher({
          directories: watchDirectories,
          onEvent: (envelope) => {
            ensurePendingCapture(capturesStore, {
              sessionId: envelope.sessionId,
              capturedAt: new Date().toISOString(),
              tool: envelope.tool,
              capturePath: 'B',
            });
            emitSyntheticSpan(pathBSyntheticSpanProvider!, envelope);
          },
        });
        console.log(
          '[main] Path-B transcript watcher started for ' +
            watchDirectories.map((d) => `${d.tool}@${d.directory}`).join(', '),
        );
      } else {
        console.log(
          '[main] Path-B transcript watcher skipped — no Codex/Claude session directories on disk yet',
        );
      }
    } catch (err) {
      await closePathBTranscriptWatcher();
      console.warn(
        '[main] Path-B transcript watcher disabled: ' +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const capturePublishRef: {
    current: ((sessionId: string) => Promise<{ envelopeCid: string }>) | undefined;
  } = { current: undefined };
  const earningStateStore = new FleetStateStore(config.earningDir);
  const initialFleet = await earningStateStore.tryLoadExisting();
  const initialServices = initialFleet?.services ?? [];
  const initialAllComplete =
    initialServices.length > 0 && initialServices.every((s) => isOperationalServiceStep(s.step));
  const setupController = createSetupModeController({
    keystoreExists: existsSync(masterKeystorePath),
    allComplete: initialAllComplete,
  });

  const uiRecord = ensureUiTokenRecord(defaultTokenPath(config.stateDir));
  const uiToken = uiRecord.token;
  const handshakeKey = cryptoRandomBytes(16).toString('hex');
  // §14.4: env override wins, else the config-file value, else loopback.
  // Previously this only ever read the env var, so `apiBindHost` written
  // into the config file was silently dead — the auth gate (§14.3) must be
  // unconditional BEFORE this activates, since a non-loopback bind now
  // actually exposes operator-class routes to the network (bearer/token-
  // gated, but reachable).
  const apiBindHost = resolveApiBindHost(config.apiBindHost);
  if (!isLoopbackBindHost(apiBindHost)) {
    console.warn(
      `[main] WARNING: apiBindHost is "${apiBindHost}" (non-loopback) — the daemon API ` +
      'is reachable from other hosts on the network, not just this machine. Operator-class ' +
      'routes are token-gated, but the bind host is your outer firewall — make sure this is intentional.',
    );
  }
  const operatorArtifactsConfig = {
    publicEndpoint: config.operator?.publicEndpoint ?? `http://localhost:${config.apiPort}`,
    defaultPriceUsdc: config.operator?.defaultPriceUsdc ?? '0',
    perArtifactTypePrice: config.operator?.perArtifactTypePrice ?? {},
    donation: {
      enabled: config.network === 'testnet' && config.operator?.donation?.enabled === true,
    },
  };
  let corpusForApi: ReturnType<typeof createCorpus> | undefined;

  const harnessReadinessRegistryHolder: {
    current: import('./harnesses/readiness-registry.js').HarnessReadinessRegistry | undefined;
  } = { current: undefined };

  // Wave-4 D4: archive/projector reads for task-post-counts and launcher
  // getTaskStatuses. Store already exists here, so the holder is populated
  // immediately; the holder shape matches pluginReader's eager-register pattern.
  const archiveReadsHolder: { current: ArchiveReads | undefined } = {
    current: createArchiveReadsFromStore(sharedStore),
  };

  // One-swap R3 (#2461): the plugin-publication reader backing the /build page's
  // plug-in routes, carved off `discovery/` onto the IdentityRegistry log source
  // so those routes survive the D-wave deletion. Populated post-bootstrap.
  const pluginReaderHolder: { current: PluginPublicationReader | undefined } = {
    current: undefined,
  };

  // #641: latest published `@jinn-network/operator` version, back-filled by the
  // start-time npm-registry check below. `/v1/status.latestVersion` reads this
  // via the `latestVersion` getter threaded into the ApiServer status config.
  const latestVersionHolder: { current: string | null } = { current: null };

  // #2405 (spec §4.1 intent-module law): `POST /api/admin/claim-rewards` is a
  // thin front-end over `claimRewardsIntent`, built from the daemon's OWN
  // signer/client objects — never re-derived from the keystore, never routed
  // through the CLI module. Those objects (`publicClient`, `masterWallet`,
  // `earningStore`) aren't constructed until after bootstrap completes, well
  // after `startApiServer` registers the route (same eager-register /
  // late-populate holder pattern used elsewhere in this file).
  const claimRewardsRouteHolder: {
    current: import('./api/admin-endpoint.js').ClaimRewardsRouteContext | undefined;
  } = { current: undefined };

  // hjex.6: retry signal for the bootstrap halt-and-resume loop.
  // When a SetupBootstrapHalted is caught (fatal non-funding error or funding
  // timeout), main() waits on this promise instead of returning, so the setup
  // API stays alive and the operator can click Retry in the SPA.
  // The retry endpoint resolves this promise to trigger a re-run.
  let retryBootstrapResolve: (() => void) | null = null;
  let retryBootstrapReject: ((err: unknown) => void) | null = null;

  let setupApiServer: ApiServer;
  try {
    setupApiServer = await startApiServer({
      port: config.apiPort,
      store: sharedStore,
      apiToken,
      bindHost: apiBindHost,
      apiInsecureRemote: config.apiInsecureRemote,
      apiCorsOrigins: config.apiCorsOrigins,
      apiTrustedProxies: config.apiTrustedProxies,
      corpus: () => corpusForApi,
      ui: { token: uiToken, handshakeKey, expiresAt: uiRecord.expiresAt },
      // GET /ready + GET /metrics (spec §5/§6.1–§6.2, issue #2404). Injected
      // (rather than server.ts importing daemon/loop-heartbeat.js directly)
      // per the api→daemon architecture boundary — see the field docstrings
      // on ApiServerConfig in server.ts.
      getDaemonReadiness,
      getLoopSnapshot: () => buildLoopMetricsSnapshot(sharedStore),
      hermesDoctor: {
        hermesPath: config.hermesPath,
        hermesDoctorTimeoutMs: config.hermesDoctorTimeoutMs,
      },
      codexDoctor: {
        codexPath: config.codexPath,
        codexDoctorTimeoutMs: config.codexDoctorTimeoutMs,
      },
      admin: {
        // jinn-mono #289: in interactive mode (the dashboard SPA case),
        // spawn a detached replacement before exiting so the panel reconnects
        // to a live daemon instead of seeing a 502 + terminal prompt. In
        // headless mode (`JINN_NO_UI=1`), exit without respawning so the
        // supervisor / systemd / docker entrypoint decides what to do.
        // Stop: pure exit, never respawn. The operator clicked Stop; they
        // want the daemon down until they explicitly start it again.
        onStopRequested: () => process.exit(0),
        onRestartRequested: (opts) =>
          requestDaemonRestart({
            forceRespawn: opts.forceRespawn,
            // jinn-mono #561: close the API + OTLP listeners before the
            // replacement spawns, so the child binds without an
            // EADDRINUSE race. Errors are swallowed inside
            // requestDaemonRestart so the operator is never stranded.
            preSpawnCleanup: async () => {
              await setupApiServer.close().catch(() => undefined);
              await closeCaptureReceiver();
            },
          }),
        claimRewards: { holder: claimRewardsRouteHolder },
      },
      harnessStatus: {
        getStatus: async () => {
          const mode = config.harness.mode;
          const defaultHarness = config.harnesses?.default ?? DEFAULT_HARNESS;
          const implStateDir = join(config.engine.implStateDirRoot, harnessStateDirName(defaultHarness));
          let codeDigest = '';
          try {
            // #2118: the status surface joins the harness's hash profile, so
            // the digest the operator reads is the digest the fence enforces
            // and the delivery envelope carries. Harnesses with no registered
            // public profile keep the historical unfiltered hash here.
            const profile = hashProfileForHarness(defaultHarness);
            codeDigest = await hashImplStateDir(implStateDir, profile ? { profile } : {});
          } catch {
            // implStateDir may not exist yet on first boot. Surface as empty
            // rather than 500ing — the panel renders "—" gracefully.
            codeDigest = '';
          }
          const persisted = readModeState();
          return {
            mode,
            codeDigest,
            ...(persisted ? { lastModeSwitchAt: persisted.switchedAt } : {}),
          };
        },
      },
      operatorArtifacts: {
        configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
        operatorConfig: operatorArtifactsConfig,
        onOperatorConfigUpdated: (operator) => {
          config.operator = operator;
        },
      },
      // Issue #420: one-click operator debug report. The bundle assembler
      // reads the live resolved `config` so the download reflects env
      // overrides + defaults, not just the on-disk config file.
      debugReport: {
        store: sharedStore,
        config,
        configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
      },
      stopHook: {
        onStopHook: async (payload) => {
          await ingestStopHookCapture(capturesStore, captureReceiver, payload);
        },
      },
      bootstrap: {
        earningDir: config.earningDir,
        configReader: () => ({
          rpcUrl: config.rpcUrl,
          defaultRpcUrl: CHAIN_CONFIG.rpcUrl,
          rpcUrls: config.rpcUrls,
          publicDefaults: RPC_PUBLIC_DEFAULTS,
          rpcSlotHealth: lastL2Probe.map((p) =>
            p.ok
              ? {
                ok: true as const,
                host: p.host,
                latencyMs: p.latencyMs,
                expectedChainId: p.expectedChainId,
                actualChainId: p.actualChainId,
                ...(p.localDev ? { localDev: true as const } : {}),
              }
              : {
                ok: false as const,
                host: p.host,
                code: p.code,
                reason: p.reason,
                expectedChainId: p.expectedChainId,
                actualChainId: p.actualChainId,
              },
          ),
          executionWiring: config.executionWiring,
          onboardingComplete: config.onboardingComplete,
        }),
      },
      // jinn-mono-u34i: same eager-register / late-populate pattern for the
      // harness readiness routes. Until main.ts sets the holder, requests
      // return 503 subsystem_not_ready (the panel handles that gracefully).
      harnessReadinessRegistry: { holder: harnessReadinessRegistryHolder },
      // Wave-4 D4: plugin-publication routes require pluginReader (no
      // DiscoveryAPI fallback). Archive reads back task-post-counts.
      pluginReader: { holder: pluginReaderHolder },
      archiveReads: { holder: archiveReadsHolder },
      // Agent-binding retry: re-run the ERC-1271 bind step from the SPA
      // without forcing a daemon restart. Constructs a fresh bootstrapper
      // per call so we don't tangle lifecycle with the long-running one.
      agentBinding: {
        listUnbound: async () => {
          const bs = new FleetBootstrapper({
            earningDir: config.earningDir,
            chain: NETWORK_CHAIN,
            rpcUrl: config.rpcUrl,
            stakingMode: config.stakingMode,
            targetServices: config.targetServices,
          });
          const state = await bs.loadState();
          return state.services
            .filter((s) => !s.safe_bound_to_agent && s.agent_id !== null)
            .map((s) => ({ serviceIndex: s.index }));
        },
        retryBind: async (serviceIndex: number) => {
          const bs = new FleetBootstrapper({
            earningDir: config.earningDir,
            chain: NETWORK_CHAIN,
            rpcUrl: config.rpcUrl,
            stakingMode: config.stakingMode,
            targetServices: config.targetServices,
            testnetL2DeploymentPath: config.testnetL2DeploymentPath,
            testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
            testnetMechDeploymentPath: config.testnetMechDeploymentPath,
            testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
          });
          try {
            const state = await bs.retryAgentBindingFor(serviceIndex, PASSWORD);
            const svc = state.services.find((s) => s.index === serviceIndex);
            return {
              serviceIndex,
              status: svc?.safe_bound_to_agent ? 'success' as const : 'reverted' as const,
              txHash: svc?.agent_registered_tx ?? undefined,
            };
          } catch (err) {
            return {
              serviceIndex,
              status: 'reverted' as const,
              detail: err instanceof Error ? err.message : String(err),
            };
          }
        },
      },
      setup: {
        earningDir: config.earningDir,
        chain: NETWORK_CHAIN,
        rpcUrl: config.rpcUrl,
        // Note: do NOT pass minEoaGasWei here. setup-endpoints.ts derives
        // its faucet target from stage1MinMasterEth(getChainConfig(chain),
        // targetServices) — the same helper the daemon's ensureStage1 gate
        // uses. Passing a computed value from here would re-introduce the
        // drift seam that hit operators in the 2026-05-18 canary
        // (jinn-mono-u34i): faucet dripped to one target while the daemon
        // waited for a different one. The override field remains for tests
        // that want a custom target.
        // targetServices DOES need to flow through so the faucet drips enough
        // ETH to cover ALL services for the operator's chosen targetServices.
        targetServices: config.targetServices,
        // Issue #560: batched daily-cap top-up knobs — single source of truth
        // in JinnConfig, surfaced to the SPA via GET /v1/setup/drip/quota.
        faucetDailyTopupCap: config.faucetDailyTopupCap,
        faucetTopupCooldownMs: config.faucetTopupCooldownMs,
        claudePath: activeClaudePath,
        getClaudePath: () => activeClaudePath,
        configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
        defaultRpcUrlForChain: () => CHAIN_CONFIG.rpcUrl,
        defaultRpcUrlsForChain: () => RPC_PUBLIC_DEFAULTS,
        onClaudePathSelected: selectClaudePath,
        // Issue #421 retired the legacy `solverNets` write target. Setup
        // endpoints no longer call back into the daemon to mutate operator
        // SolverNet config; the canonical join flow is
        // `POST /v1/operator/join/:cid`, which mutates
        // `config.joinedSolverNets` directly via its own write path.
        // The cache-invalidation hook is no longer needed here.
        onSolverNetsUpdated: () => {
          invalidatePredictionOperatorStatusCache(config);
        },
        // hjex.6: re-trigger the bootstrap state machine from the SPA Retry button.
        // Resolves the halt-and-resume promise; main() will loop back and call
        // bootstrap() again. Rejects if the daemon is not currently halted.
        retryBootstrap: () => {
          return new Promise<void>((resolve, reject) => {
            if (!retryBootstrapResolve) {
              reject(new Error('daemon_not_halted'));
              return;
            }
            const prevResolve = retryBootstrapResolve;
            // The resolve will unblock the main loop's await. When bootstrap
            // completes (success or new halt), the caller receives the result
            // via the /v1/bootstrap polling endpoint.
            prevResolve();
            resolve();
          });
        },
        // #983: mutate the in-memory config so GET /v1/bootstrap reflects the
        // completion flag live (the endpoint persists to disk; this keeps the
        // configReader's in-memory read consistent).
        // Cast: JinnConfig has the optional field.
        markOnboardingComplete: () => {
          (config as { onboardingComplete?: boolean }).onboardingComplete = true;
        },
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
        config,
        configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
        passwordRotation: {
          source: passwordResolution.source,
          filePath: passwordResolution.filePath,
        },
      },
    });
  } catch (error) {
    await closeCaptureReceiver();
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
  // is the whole point of starting the API early). Only on the first-ever
  // launch (tracked by a marker file) — otherwise every restart during a
  // dogfooding session opens a fresh browser tab and stale tabs accumulate
  // (issue #804). `jinn run --no-ui` / JINN_NO_UI=1 always suppresses;
  // `jinn run --ui` / JINN_FORCE_UI=1 forces a reopen even past first launch.
  const uiOpenedMarkerPath = join(config.earningDir, '.ui-opened');
  const noUi = process.env['JINN_NO_UI'] === '1';
  const forceUi = process.env['JINN_FORCE_UI'] === '1';
  const uiAutoOpenDecision = decideUiAutoOpen({
    noUi,
    forceUi,
    markerExists: existsSync(uiOpenedMarkerPath),
  });
  if (uiAutoOpenDecision.shouldOpen) {
    const consoleUrl = process.env['JINN_CONSOLE_URL'] ?? 'http://127.0.0.1:3000';
    openBrowser(consoleUrl);
  } else if (!noUi) {
    console.log(
      `[main] Operator console is a separate app (default http://127.0.0.1:3000). ` +
        `The daemon origin has no human surface. Run 'jinn ui' to open the console ` +
        `(auto-open suppressed after first launch; use --ui to force)`,
    );
  }
  if (uiAutoOpenDecision.shouldWriteMarker) {
    try {
      mkdirSync(dirname(uiOpenedMarkerPath), { recursive: true });
      writeFileSyncMain(uiOpenedMarkerPath, new Date().toISOString() + '\n');
    } catch (err) {
      console.warn(
        `[main] Failed to write UI-opened marker at ${uiOpenedMarkerPath}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  console.log(
    `[main] Setup-mode API up (mode=${setupController.mode()}). ` +
      `API: http://127.0.0.1:${setupApiServer.port} (no human surface)`,
  );

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
      await closeCaptureReceiver();
      sharedStore.close();
      process.exit(initExitCode);
    }
    emitStructured({ kind: 'system', message: 'wallet keystore ready' });
    // Refresh the controller so the panel's loading screen knows the
    // keystore is on disk and we're transitioning into bootstrap.
    setupController.refresh({ keystoreExists: true, allComplete: false });
  }

  // Deployment-readiness gate (#958). In a deployment context (JINN_STATE_DIR
  // set or a container/compose auth context) this fails loud and exits when a
  // hard check fails (writable-volume, state-on-volume, agent-cli-non-root,
  // credentials_valid for a required runtime). Outside a deployment context it
  // `jinn run` is NEVER newly gated here. Runs before the pidfile gate so an
  // unfit environment refuses before we touch the pidfile.
  //
  // #2407 B1: this and the pidfile block below used to run much later, right
  // before Daemon construction — AFTER the entire bootstrap retry loop and
  // any degrade-open recovery window. That left the whole degraded window
  // with no `daemon.pid` on disk, so `checkDaemonGuard` (cli/daemon-guard.ts)
  // reported `not-running` and a concurrent `jinn withdraw` / `jinn bootstrap`
  // / `jinn fleet scale` / `jinn solver-plugins publish` would race the
  // degraded recovery loops' signer, and a second `jinn run` would start a
  // second degraded set. Both gates now run here, before the retry loop and
  // any degraded loops can start.
  await applyDeploymentReadinessGate(
    {
      stateDir: config.stateDir,
      earningDir: config.earningDir,
      runtimeMode: config.runtimeMode,
      executionWiring: config.executionWiring,
      claudePath: config.claudePath,
      ...(config.hermesPath !== undefined ? { hermesPath: config.hermesPath } : {}),
      ...(config.hermesProvider !== undefined ? { hermesProvider: config.hermesProvider } : {}),
      ...(config.codexPath !== undefined ? { codexPath: config.codexPath } : {}),
    },
    {
      env: process.env,
      getuid: typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined,
      detectAuthContext,
    },
  );

  const pidPath = join(config.earningDir, 'daemon.pid');
  applyPidfileLivenessGate(pidPath);

  writeFileSyncMain(pidPath, String(process.pid) + '\n', 'utf-8');
  const removePidfile = () => {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', removePidfile);

  // #2407 R2: a SIGINT/SIGTERM delivered during the bootstrap retry loop or
  // the degrade-open window (before the full Daemon's own graceful
  // SIGINT/SIGTERM handlers exist, further down) hits Node's default signal
  // disposition, which terminates the process WITHOUT running
  // `process.on('exit', ...)` handlers — `exit` fires for a clean return or
  // `process.exit()`, not for a bare signal termination. Without this, a
  // stale `daemon.pid` survives the process: on a normal host it
  // self-heals (`checkPidfileLiveness`'s ESRCH branch), but in a container
  // the daemon is PID 1 and `checkDaemonGuard` deliberately treats a
  // pid-1 record as BLOCKING (preflight/pidfile-liveness.ts's
  // self-or-pid1-container inversion, cli/daemon-guard.ts's docstring) —
  // every CLI verb would refuse until a daemon happened to rewrite the
  // file. This minimal early handler is superseded by the real graceful
  // shutdown handlers once the full Daemon is constructed (see
  // `process.removeListener` calls right before those are installed,
  // further down) — it exists only to cover the window between here and
  // there.
  const removePidfileOnEarlySignal = (): void => {
    removePidfile();
    process.exit(0);
  };
  process.once('SIGINT', removePidfileOnEarlySignal);
  process.once('SIGTERM', removePidfileOnEarlySignal);

  // hjex.6: halt-and-resume loop for bootstrap retries, extracted into
  // `runBootstrapWithDegradeOpen` (earning/bootstrap-run.ts, #2407 M3) so its
  // ORDERING — degraded loops start before readiness flips 'degraded'; on
  // retry, degraded recovery's `stop()` is awaited to completion BEFORE the
  // next `runFleetBootstrap()` attempt; 'ready' flips only after a
  // successful attempt, i.e. before the full Daemon is constructed below —
  // is independently unit-tested rather than only reachable by spawning the
  // whole daemon (main.ts itself stays impractical to test directly).
  //
  // The master-EOA signer/client used by degraded recovery is derived once
  // here (cheap, no network calls) rather than per-halt: it's the same
  // every time, and deriving it eagerly keeps `startDegraded` below
  // synchronous, matching `runBootstrapWithDegradeOpen`'s sync
  // `startDegraded` contract without threading async through it.
  //
  // #2407 R8: this derivation (specifically `decryptMnemonic`, which throws
  // on a wrong JINN_PASSWORD) must stay INSIDE the try below — outside it,
  // a bad password would propagate past the setupApiServer/store teardown
  // this try's catch performs, leaving the listener bound and SQLite open.
  let bootstrapResult;
  try {
    const degradedMnemonic = await decryptMnemonic(
      await new FleetStateStore(config.earningDir).loadMnemonicKeystore(),
      PASSWORD,
    );
    const degradedMasterAccount = deriveMasterSigner(degradedMnemonic);
    const degradedPublicClient = createJinnPublicClient(config.rpcUrls, NETWORK_CHAIN);
    const degradedMasterWallet = createJinnWalletClient(config.rpcUrls, NETWORK_CHAIN, degradedMasterAccount);

    bootstrapResult = await runBootstrapWithDegradeOpen({
      runBootstrap: () => runFleetBootstrap({ config, password: PASSWORD, network: NETWORK_CHAIN, emitProgress }),
      setReadiness: setDaemonReadiness,
      // #2407 / spec §5: degrade-open boot. An economic-class halt (funding
      // shortfall, incomplete fleet, a recoverable on-chain error) must not
      // leave the daemon fully dark while the caller awaits the retry signal
      // — any part of the fleet that's ALREADY operational needs its
      // eviction/checkpoint/balance-topup/reward-claim loops to keep running
      // so a self-healing condition doesn't compound (ratifies
      // earning/bootstrap.ts's #773/#789/#917 decision: eviction recovery
      // belongs to the running eviction loop, never an inline boot-time
      // broadcast). Integrity-class halts (bootstrap-halt-classification.ts)
      // stay fail-closed — no degraded loops. Standalone-recovery-runner
      // variant, not the full `Daemon` class: `Daemon` needs
      // mechAddress/safeAddress/composition/adapter resolved from a
      // COMPLETED bootstrap, none of which exist mid-halt — see
      // degraded-recovery.ts's docstring.
      startDegraded: (envelope) => {
        if (!isEconomicBootstrapHalt(envelope)) {
          console.log('[main] Halt cause is integrity-class — staying fail-closed (no degraded recovery loops).');
          return null;
        }
        try {
          const handle = startDegradedRecoveryLoops({
            earningDir: config.earningDir,
            network: NETWORK_CHAIN,
            publicClient: degradedPublicClient,
            masterWallet: degradedMasterWallet,
            mnemonic: degradedMnemonic,
            rpcUrl: config.rpcUrl,
            chainConfig: CHAIN_CONFIG,
            intervals: {
              evictionCheckIntervalMs: config.evictionCheckIntervalMs,
              checkpointIntervalMs: config.checkpointIntervalMs,
              // #2407 B2: omit balance-topup while a master-EOA
              // funding_required halt is pending — it drains the exact
              // balance the funding poller below is waiting to see cross
              // the threshold (an absorbing state). See
              // isPendingMasterFundingHalt's docstring. This exact
              // predicate-to-interval-zero wiring join is inspection-covered,
              // not independently unit-tested: isPendingMasterFundingHalt
              // itself is tested (bootstrap-halt-classification.test.ts) and
              // startDegradedRecoveryLoops' 0-disables-the-loop behavior is
              // tested (degraded-recovery.test.ts) separately.
              balanceTopupIntervalMs: isPendingMasterFundingHalt(envelope) ? 0 : config.balanceTopupIntervalMs,
              rewardClaimIntervalMs: config.rewardClaimIntervalMs,
            },
            stakingMode: config.stakingMode,
            jinnStore: sharedStore,
          });
          console.log(
            '[main] Degraded readiness: recovery loops (eviction-check, checkpoint, ' +
              'balance-topup, reward-claim) running for the already-operational fleet ' +
              'while this halt is retried; claim/work path stays closed.' +
              (isPendingMasterFundingHalt(envelope) ? ' balance-topup omitted (pending master-EOA funding halt).' : ''),
          );
          return handle;
        } catch (degradedErr) {
          console.error(
            '[main] Failed to start degraded recovery loops (non-fatal — still waiting for retry):',
            degradedErr instanceof Error ? degradedErr.message : degradedErr,
          );
          return null;
        }
      },
      // hjex.6: Auto-resume funding poller. When the halt is a funding
      // shortfall, poll the master EOA balance every
      // JINN_FUNDING_POLL_INTERVAL_MS (default 15s). When the balance meets
      // or exceeds the required amount, auto-signal the retry loop. Only
      // runs while the halt signal is pending; stops on any signal.
      awaitRetry: async (envelope) => {
        // Install the retry signal so the endpoint can unblock us.
        const retrySignal = new Promise<void>((resolve, reject) => {
          retryBootstrapResolve = resolve;
          retryBootstrapReject = reject;
        });
        console.log('[main] Bootstrap halted. Waiting for retry signal from the dashboard...');

        let fundingPollHandle: ReturnType<typeof setTimeout> | null = null;
        const isHaltedOnFunding = envelope.code === 'funding_required';
        const haltDetails = envelope.details as Record<string, unknown> | undefined;
        const haltAddress = typeof haltDetails?.['address'] === 'string'
          ? haltDetails['address'] as `0x${string}`
          : null;
        const haltRequired = typeof haltDetails?.['requiredWei'] === 'string'
          ? BigInt(haltDetails['requiredWei'])
          : typeof haltDetails?.['needWei'] === 'string'
            ? BigInt(haltDetails['needWei'])
            : null;
        const fundingPollIntervalMs = (() => {
          const raw = process.env['JINN_FUNDING_POLL_INTERVAL_MS'];
          if (!raw) return 15_000;
          const n = Number.parseInt(raw, 10);
          return Number.isFinite(n) && n > 0 ? n : 15_000;
        })();
        if (isHaltedOnFunding && haltAddress && haltRequired !== null) {
          const publicClient = createJinnPublicClient(config.rpcUrls, NETWORK_CHAIN);
          const schedulePoll = (): void => {
            fundingPollHandle = setTimeout(async () => {
              // Guard: if the signal was already fired, stop polling.
              if (!retryBootstrapResolve) return;
              try {
                const balance = await publicClient.getBalance({ address: haltAddress });
                if (balance >= haltRequired) {
                  console.log(
                    `[main] Funding shortfall cleared (have ${balance}, required ${haltRequired}). ` +
                    `Auto-resuming bootstrap...`,
                  );
                  retryBootstrapResolve?.();
                  return; // don't schedule the next poll
                }
              } catch (pollErr) {
                // Balance read failed — not fatal, just skip this tick.
                const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
                console.log(`[main] Funding poller balance read failed (will retry): ${msg}`);
              }
              schedulePoll(); // reschedule
            }, fundingPollIntervalMs);
          };
          schedulePoll();
        }

        try {
          await retrySignal;
        } finally {
          retryBootstrapResolve = null;
          retryBootstrapReject = null;
          if (fundingPollHandle !== null) {
            clearTimeout(fundingPollHandle);
            fundingPollHandle = null;
          }
        }
        console.log('[main] Retry triggered — re-running bootstrap...');
      },
    });
  } catch (err) {
    // If bootstrap throws an unexpected error (vs. SetupBootstrapHalted),
    // tear down the API we just started so we don't leave a dangling listener.
    await setupApiServer.close().catch(() => undefined);
    await closeCaptureReceiver();
    sharedStore.close();
    throw err;
  }

  // Bootstrap completed — flip the controller into 'running' so any waiters
  // (future loops gated on this) unblock. `runBootstrapWithDegradeOpen`
  // already flipped readiness to 'ready' before returning — this is the
  // no-restart transition: the same process falls straight through to the
  // existing full-boot code below, no restart-daemon.ts invocation needed.
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
    await closeCaptureReceiver();
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
  const agentEoaAddress = privateKeyToAccount(agentPrivateKey).address as `0x${string}`;

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

  const runner = new ClaudeRunner({
    claudePath: activeClaudePath,
    model: config.claudeModel,
  });

  const earningStore = new FleetStateStore(config.earningDir);
  const mnemonicForMaster = await decryptMnemonic(
    await earningStore.loadMnemonicKeystore(),
    PASSWORD,
  );
  const masterAccount = deriveMasterSigner(mnemonicForMaster);
  const publicClient = createJinnPublicClient(config.rpcUrls, NETWORK_CHAIN);
  const masterWallet = createJinnWalletClient(config.rpcUrls, NETWORK_CHAIN, masterAccount);

  // #2405: populate the claim-rewards route holder now that the daemon's own
  // signer/client objects exist — reuses `sharedStore` (already open for the
  // daemon's lifetime) rather than opening a second handle onto the same
  // SQLite file the way a fresh CLI process would.
  claimRewardsRouteHolder.current = {
    publicClient,
    masterWallet,
    fleetStore: earningStore,
    chain: NETWORK_CHAIN,
    distributorAddress: CHAIN_CONFIG.distributorAddress,
    jinnStore: sharedStore,
  };

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

  const taskDiscoveryManifestCids = discoveryDigestsFromWiring(config.executionWiring);

  // One-swap R3 (#2461): populate the carved plugin-publication reader over the
  // IdentityRegistry log source. Reuses the already-built `publicClient` and the
  // fallback-chain RPC. Plugin routes 503 until this is set.
  if (identityRegistryAddress) {
    pluginReaderHolder.current = createPluginPublicationReader({
      logSource: createRpcPluginLogSource({
        publicClient,
        identityRegistry: identityRegistryAddress,
        chainId: config.network === 'testnet' ? 84532 : 8453,
      }),
    });
  }

  // #1037: the live task-discovery descriptor. Always present with a mutable
  // `solverNetManifestCids` array (`taskDiscoveryManifestCids` is a fresh
  // `.map` result, safe to push onto). The join applier holds this same object
  // reference and pushes a newly-joined cid onto it live.
  const taskDiscovery = {
    solverNetManifestCids: taskDiscoveryManifestCids,
    // No explicit `onchainFromBlock` by default — let `MechAdapter`'s
    // `DEFAULT_TASK_DISCOVERY_FROM_BLOCK` per-chain default flow through.
    ...(config.taskDiscoveryOnchainFromBlock !== undefined
      ? { onchainFromBlock: config.taskDiscoveryOnchainFromBlock }
      : {}),
    ...(config.taskDiscoveryAllowedTaskIds?.length
      ? { allowedTaskIds: config.taskDiscoveryAllowedTaskIds }
      : {}),
  };

  // Autopilot marketplace Tasks use GitHub only as the authenticated adoption
  // surface. Reads remain available for the public repository without a token;
  // an operator token raises rate limits and permits private-fork deployments.
  const autopilotGitHubRead = createJinnMonoGitHubAdoptionReadPort({
    token:
      process.env['JINN_AUTOPILOT_GITHUB_TOKEN']
      ?? process.env['GH_TOKEN']
      ?? process.env['GITHUB_TOKEN'],
  });
  const autopilotEvaluationContextResolver =
    createAutopilotEvaluationContextResolver({ github: autopilotGitHubRead });
  const autopilotAdoptionReceiptObserver =
    createAutopilotGitHubAdoptionReceiptObserver({ github: autopilotGitHubRead });

  const adapter = new MechAdapter({
    rpcUrl: config.rpcUrls,
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
    taskDiscovery,
    autopilotEvaluationContextResolver,
  }, sharedStore);

  // ── TaskEngine wiring ─────────────────────────────────────────────────

  // Build agent viem clients (same creds as MechAdapter uses internally).
  const viemChains = await import('viem/chains');
  const agentChain = config.network === 'testnet'
    ? viemChains.baseSepolia
    : viemChains.base;
  const agentClients = createClients(config.rpcUrls, agentPrivateKey, agentChain);

  // ── Harness registry ─────────────────────────────────────────────────────────

  const solverNetRegistry = await loadSolverNets(config);
  for (const net of solverNetRegistry.list()) {
    const plugins = net.runtimePlugins
      .map((plugin) => `${plugin.name}@${plugin.version}`)
      .join(', ');
    console.log(
      `[main] Loaded SolverNet: ${net.name} solverType=${net.solverType} harness=${net.harness} plugins=${plugins}`,
    );
  }

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
  const corpusChainId = config.network === 'testnet' ? 84532 : 8453;
  const corpusFromBlock = Number(DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[corpusChainId] ?? 0n);
  // The MCP subprocess reads JINN_DISCOVERY_URL.
  const corpusDiscoveryUrl = config.discovery?.url?.trim() || '';
  const corpusEnv: RunnerContext['corpusEnv'] | undefined =
    (corpusDiscoveryUrl || identityRegistryAddress)
      ? {
          ...(corpusDiscoveryUrl ? { discoveryUrl: corpusDiscoveryUrl } : {}),
          ipfsGatewayUrl: config.ipfsGatewayUrl,
          rpcUrl: config.rpcUrl,
          chainId: corpusChainId,
          ...(identityRegistryAddress ? { identityRegistryAddress } : {}),
          ...(corpusFromBlock > 0 ? { fromBlock: corpusFromBlock } : {}),
        }
      : undefined;

  // Explicit learner routing (product design §10). The learner no longer wraps
  // every SolverType by default. When the operator has not named an allowlist,
  // derive it from the SolverNets they joined — that is the routing they already
  // declared, so an existing deployment claims exactly what it joined rather
  // than either everything (the retired default) or nothing (a silent stall).
  const joinedSolverTypes = [
    ...new Set(
      (config.executionWiring ?? [])
        .map((entry) => contractRefFromWorkKind(entry.workKind))
        .filter((ref): ref is { id: string; version: string } => ref !== undefined)
        .map((ref) => `${ref.id}.${ref.version}`),
    ),
  ].sort();
  // The array is deliberately mutable and shared by reference: both
  // LearnerHarness instances hold this exact object, and `join-applier.ts`
  // pushes onto it so a hot join reaches routing without a restart (#1037).
  const operatorPinnedSolverTypes = config.harness.routing?.solverTypes;
  const learnerRoutingSolverTypes: string[] = [...(operatorPinnedSolverTypes ?? joinedSolverTypes)];
  const learnerRouting = {
    solverTypes: learnerRoutingSolverTypes,
    ...(config.harness.routing?.legacyDefaultRouting !== undefined
      ? { legacyDefaultRouting: config.harness.routing.legacyDefaultRouting }
      : {}),
  };
  console.log(
    `[main] learner routing: ${learnerRouting.solverTypes.length > 0
      ? learnerRouting.solverTypes.join(', ')
      : '(none — this learner claims no SolverType)'}`,
  );

  for (const impl of buildHarnesses({
    rpcUrl: config.rpcUrl,
    archiveRpcUrl: config.archiveRpcUrl,
    claudePath: activeClaudePath,
    claudeModel: config.claudeModel,
    pk: agentPrivateKey,
    safe: safeAddress,
    runner,
    storePath: config.dbPath,
    daemonApiUrl: `http://127.0.0.1:${config.apiPort}`,
    daemonApiToken: apiToken,
    implStateDirRoot: config.engine.implStateDirRoot,
    ipfsRegistryUrl: config.ipfsRegistryUrl,
    sweRebenchV2StateDir: config.sweRebenchV2StateDir,
    ...(process.env['JINN_POLYMARKET_GAMMA_BASE_URL']
      ? { polymarketGammaBaseUrl: process.env['JINN_POLYMARKET_GAMMA_BASE_URL'] }
      : {}),
    ...(process.env['JINN_POLYMARKET_CLOB_BASE_URL']
      ? { polymarketClobBaseUrl: process.env['JINN_POLYMARKET_CLOB_BASE_URL'] }
      : {}),
    externalImpls,
    disabledNames: config.harnesses?.disabled,
    learnerRouting,
    ...(config.harness.candidate ? { learnerCandidate: config.harness.candidate } : {}),
    corpusEnv,
    hermesPath: config.hermesPath,
    hermesModel: config.hermesModel,
    hermesProvider: config.hermesProvider,
    hermesBaseUrl: config.hermesBaseUrl,
    hermesDoctorTimeoutMs: config.hermesDoctorTimeoutMs,
    codexPath: config.codexPath,
    codexDoctorTimeoutMs: config.codexDoctorTimeoutMs,
    semanticEvaluatorRunnerResolver:
      makeConfiguredSemanticEvaluatorRunnerResolver({
        getExecutionWiring: () => config.executionWiring,
        getClaudePath: () => activeClaudePath,
      }),
    immutableMechanicalVerifier: makeDockerImmutableMechanicalVerifier(),
  })) {
    implRegistry.register(impl);
  }

  console.log(`[main] HarnessRegistry: ${implRegistry.list().map(i => i.name).join(', ')}`);

  // ── Harness readiness registry ─────────────────────────────────────────────
  // Composes per-harness isReady() probes into a cached snapshot consumed by
  // claim loops (A5) and /v1/harnesses/readiness (A3).
  //
  // The registry is constructed here, after buildHarnesses() has run, which
  // is necessarily after bootstrap (bootstrap needs the keystore). The HTTP
  // server was started before bootstrap so it could show setup progress — we
  // mount the readiness routes on the already-running app via setupApiServer.app
  // (same pattern used by registerSolverNetsEndpoints). Routes are registered
  // before the first operator request that cares about harness readiness.
  //
  // A2 carry-over: start() only schedules the 4s tick; refreshNow() is called
  // immediately so the snapshot is populated before the first claim-loop tick.
  const harnessReadinessRegistry = buildHarnessReadinessRegistry({
    harnesses: implRegistry.list(),
    config,
  });
  harnessReadinessRegistry.start();
  await harnessReadinessRegistry.refreshNow();
  // Routes were registered eagerly at startApiServer time via the holder
  // ref pattern (jinn-mono-u34i). Populate the holder now and the already-
  // mounted /v1/harnesses/readiness routes start returning real data.
  // Late-mounting via addHarnessReadinessRoutes(setupApiServer.app, ...)
  // is no longer needed and would throw on Hono's locked matcher.
  harnessReadinessRegistryHolder.current = harnessReadinessRegistry;
  console.log('[main] HarnessReadinessRegistry started; /v1/harnesses/readiness routes active.');

  // ── Engine deps ───────────────────────────────────────────────────────────────

  // Packaging deps: artifacts are always written to served_artifacts
  // (operator-local SQLite). In public-testnet donation mode, scrubbed artifact
  // bytes are also pinned to IPFS and advertised as signed donation sources;
  // that IPFS path is the canonical release path. The HTTP endpoint and price
  // fields are kept as compatibility/future data-market fallback plumbing.
  const operatorPublicEndpoint =
    config.operator?.publicEndpoint ?? `http://localhost:${config.apiPort}`;
  const operatorDefaultPrice = config.operator?.defaultPriceUsdc ?? '0';
  const operatorPerTypePrice = config.operator?.perArtifactTypePrice ?? {};
  const donationRequested = config.operator?.donation?.enabled === true;
  const donationEnabled = donationRequested && config.network === 'testnet';
  if (donationRequested && !donationEnabled) {
    console.warn('[main] operator.donation.enabled is testnet-only; donation disabled on mainnet.');
  }
  if (!config.operator?.publicEndpoint) {
    if (donationEnabled) {
      console.log(
        '[main] config.operator.publicEndpoint not set; using IPFS donation as the public artifact path. ' +
          'Direct HTTP artifact fallback will remain local-only.',
      );
    } else {
      console.warn(
        '[main] operator donation is disabled and config.operator.publicEndpoint is not set; ' +
          'new artifacts will remain local-only until donation mode is enabled.',
      );
    }
  }
  const packagingDeps = {
    operatorEndpoint: operatorPublicEndpoint,
    defaultPriceUsdc: operatorDefaultPrice,
    perArtifactTypePrice: operatorPerTypePrice,
    donation: {
      enabled: donationEnabled,
      ipfsRegistryUrl: config.ipfsRegistryUrl,
      scrub: {
        identity: {
          username: userInfo().username,
          hostname: hostname(),
        },
        path: { home: homedir() },
      },
    },
  };
  const operatorConfig = {
    publicEndpoint: operatorPublicEndpoint,
    defaultPriceUsdc: operatorDefaultPrice,
    perArtifactTypePrice: operatorPerTypePrice,
    donation: { enabled: donationEnabled },
    // Daemon-wide LLM model — stamped as executor.model fallback in envelopes
    // when a SolverNet does not specify its own model (jinn-mono-gbut, gh#191).
    claudeModel: config.claudeModel,
  };

  // Envelope assembly deps: sign envelopes with agent EOA private key
  const envelopeDeps = {
    ipfsRegistryUrl: config.ipfsRegistryUrl,
    agentEoaPrivateKey: agentPrivateKey,
    safeAddress,
  };

  // Delivery deps: deliver to marketplace + claimDelivery via JinnRouter.
  // `broadcaster` starts unset and is late-bound below, once the Stage-1 cutover composition
  // root (if any — testnet only) has built one (finding E16 / the C2 ruling: no process-global —
  // this daemon's one broadcaster is threaded explicitly to every legacy call site that needs it).
  const deliveryDeps: import('./harnesses/engine/delivery.js').DeliveryDeps = {
    publicClient: agentClients.publicClient,
    walletClient: agentClients.walletClient,
    safeAddress,
    mechContractAddress: mechAddress,
    routerAddress: ROUTER_ADDRESS,
    claimDeliveryVariant: CHAIN_CONFIG.routerClaimDeliveryVersion,
    evictionRecovery,
  };

  // ── Contribution reference queue (task-creator spec §10) ─────────────────
  //
  // ALWAYS constructed so legacy v1/v2 files migrate once to the reference-only
  // v3 schema. Stage 2 keeps every unpublished reference explicitly disabled;
  // canonical Episode persistence is owned by the harness layer.
  const { ContributionStore, resolveContributionStateDir } = await import('@jinn-network/core');
  const contributionStore = new ContributionStore({
    stateDir: resolveContributionStateDir(),
  });
  await contributionStore.disableUnpublished();
  console.log(
    '[main] contribution references: local eligibility queue — publication=parked',
  );

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

  // ── Seller-side scrub pipeline (publish-time) ─────────────────────────────
  // One pipeline shared by the task engine and the live capture publisher so
  // every published trajectory passes through the same maintained scrub stack
  // (structural key policy → owned detectors → secretlint/entropy → GLiNER ML
  // PII on by default). The OTLP receiver above runs best-effort ingest-time
  // scrubbers; this is the authoritative final gate before a trajectory becomes
  // public/sellable.
  const sellerPiiDetector = await maybeBuildPiiDetector(config.captures.piiDetection);
  const sellerScrubPipeline = buildScrubPipeline(
    sellerPiiDetector ? { piiDetector: sellerPiiDetector } : {},
  );

  const liveCapturePublisher = createLiveCapturePublisher({
    store: sharedStore,
    captures: capturesStore,
    ipfsRegistryUrl: config.ipfsRegistryUrl,
    operatorEndpoint: operatorPublicEndpoint,
    defaultPriceUsdc: operatorDefaultPrice,
    perArtifactTypePrice: operatorPerTypePrice,
    participant: { safeAddress, agentEoa: agentEoaAddress },
    signer: { address: agentEoaAddress, privateKey: agentPrivateKey },
    clientGitSha: buildInfo.clientGitSha,
    identityPublisher,
    // The capture envelope's `executor.mode` is the same two-valued protocol
    // field the delivery envelope carries; candidate mode reports frozen.
    harnessMode: protocolExecutorMode(config.harness.mode),
    scrubPipeline: sellerScrubPipeline,
  });
  capturePublishRef.current = liveCapturePublisher.publishCapture;

  // ── SolverNet subsystem (Task 11 of solvernet-creation-and-launch.md) ─────
  //
  // Loads owned launched records from `~/.jinn-client/solvernets/launched/`
  // and resumes any in-flight launches. Wave-4 D4 retired the ERC-8004
  // registry client and catalog refresher.
  let solverNetSubsystem: import('./solvernets/daemon-init.js').SolverNetSubsystem | undefined;
  if (agentId && identityRegistryAddress && config.network === 'testnet') {
    const {
      initSolverNetSubsystem,
      createIpfsClientAdapter,
      createMetadataPublisherFromViem,
    } = await import('./solvernets/daemon-init.js');
    const { createSolverNetStore } = await import('./solvernets/store.js');

    const solverNetStore = createSolverNetStore({ baseDir: config.earningDir });
    const solverNetIpfs = createIpfsClientAdapter({
      registryUrl: config.ipfsRegistryUrl,
      gatewayUrl: config.ipfsGatewayUrl,
    });
    const solverNetPublisher = createMetadataPublisherFromViem({
      identityRegistryAddress,
      walletClient: agentClients.walletClient,
      publicClient: agentClients.publicClient,
    });

    const launcherSigner: import('./solvernets/launch-publisher.js').SignerWithAgentEoa = {
      agentEoaAddress: privateKeyToAccount(agentPrivateKey).address as `0x${string}`,
      agentEoaPrivateKey: agentPrivateKey,
      agentId,
    };

    try {
      solverNetSubsystem = await initSolverNetSubsystem({
        store: solverNetStore,
        ipfs: solverNetIpfs,
        publisher: solverNetPublisher,
        resolveSigner: async () => launcherSigner,
        awaitTxConfirmation: async (txHash) => {
          const receipt = await agentClients.publicClient.waitForTransactionReceipt({ hash: txHash });
          return { blockNumber: Number(receipt.blockNumber) };
        },
      });
      console.log(
        `[main] SolverNet subsystem ready: ${solverNetSubsystem.records.length} owned record(s)`,
      );
    } catch (err) {
      console.warn(
        `[main] SolverNet subsystem init failed; continuing without it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.log(
      '[main] SolverNet subsystem: disabled ' +
        '(requires testnet + agent_id + identity_registry_address — Task 11 scaffolding)',
    );
  }
  // `initSolverNetSubsystem` still loads owned launched records; generators
  // retired with Wave-4 D3. The HTTP creation/launch surface retired in Stage 6.

  // ── Corpus (daemon-side, jinn-mono-vy37.1.6) ─────────────────────────────
  //
  // Built once per daemon lifetime; the agent EOA private key stays in this
  // process's memory and never crosses into the MCP subprocess. The MCP
  // tool `acquire_artifact` proxies to `POST /v1/artifacts/acquire` instead.
  // Wave-4 D4: envelope discovery goes through core's HTTP corpus port from
  // `config.discovery.url` (kept for R3b survivors). Falls back to the
  // on-chain identity-registry scan when no URL is set.
  const corpusHttpDiscovery = config.discovery?.url
    ? createHttpCorpusDiscovery({ url: config.discovery.url })
    : undefined;
  const corpusFactory = (corpusHttpDiscovery || identityRegistryAddress)
    ? (store: Store) =>
        (corpusForApi = createCorpus({
          ...(corpusHttpDiscovery ? { discovery: corpusHttpDiscovery } : {}),
          ipfsGatewayUrl: config.ipfsGatewayUrl,
          store,
          signer: { privateKey: agentPrivateKey },
          selfSafeAddress: safeAddress,
          ...(!corpusHttpDiscovery && identityRegistryAddress
            ? {
                onchain: {
                  rpcUrl: config.rpcUrl,
                  chainId: corpusChainId,
                  identityRegistryAddress,
                  ...(corpusFromBlock > 0 ? { fromBlock: corpusFromBlock } : {}),
                },
              }
            : {}),
        }))
    : undefined;
  if (!corpusFactory) {
    console.warn(
      '[main] Corpus disabled (no discovery.url or on-chain identity registry); ' +
        'MCP record lookup and artifact acquisition network branches will be unavailable.',
    );
  }

  const spendCap = buildSpendCapConfig(config, process.env);
  const aiUnits = buildAiUnitsConfig(config, process.env);
  if (aiUnits) {
    // Surface the resolved AI-units cap so an operator inspecting logs can
    // distinguish the baked-in default (100/2800) from a deliberate
    // `JINN_AI_UNITS_CEILING_OVERRIDE` raise (e.g. 10000/280000 in CI).
    // Source reflects the actual outcome: a malformed override falls back
    // to default and emits its own warn from resolveReferenceCeiling.
    const overrideSet =
      typeof process.env['JINN_AI_UNITS_CEILING_OVERRIDE'] === 'string' &&
      process.env['JINN_AI_UNITS_CEILING_OVERRIDE'].trim() !== '';
    const matchesDefault =
      aiUnits.capPerBlock === REFERENCE_CEILING.units_per_block &&
      aiUnits.capPerWeek === REFERENCE_CEILING.units_per_week;
    const source = overrideSet && !matchesDefault ? 'env' : 'default';
    console.log(
      `[ai-units] cap=${aiUnits.capPerBlock}/${aiUnits.capPerWeek} per (block, week) source=${source}`,
    );
  }

  let harvestLoopConfig: import('./daemon/harvest-loop.js').HarvestLoopConfig | undefined;
  const harvestMinesSessions = config.harvest.sources.includes('sessions');
  if (
    config.harvest.enabled &&
    config.harvest.intervalMs > 0 &&
    (config.harvest.repos.length > 0 || harvestMinesSessions)
  ) {
    const { resolveHarvestRepoConfigs } = await import('./daemon/harvest-loop.js');
    const harvestRepos = await resolveHarvestRepoConfigs(config.harvest.repos);
    // A sessions-only operator legitimately has zero repos. The loop remains
    // schedulable so it can report the explicit Stage 2 parked marker.
    if (harvestRepos.length > 0 || harvestMinesSessions) {
      const harvestStateDir = config.sweRebenchV2StateDir;
      const baseHarvestLoopConfig = {
        intervalMs: config.harvest.intervalMs,
        stateDir: harvestStateDir,
        repos: harvestRepos,
        limitPerRepo: config.harvest.limitPerRepo,
        limitPerTick: config.harvest.limitPerTick,
        publish: config.harvest.publish,
        minterSafe: safeAddress,
        sources: config.harvest.sources,
      };
      const hasCommitWork = config.harvest.sources.includes('commits') && harvestRepos.length > 0;
      if (!hasCommitWork) {
        harvestLoopConfig = baseHarvestLoopConfig;
        console.log(
          `[main] harvest loop enabled: 0 repo(s), sources=${config.harvest.sources.join(',')}, interval=${config.harvest.intervalMs}ms (sessions parked)`,
        );
      } else {
        const { readEnabledState, defaultSweRebenchV2EvaluatorImplStateDir } =
          await import('./harnesses/impls/swe-rebench-v2-evaluator/harness.js');
        const { existsSync } = await import('node:fs');
        const enabled = readEnabledState(defaultSweRebenchV2EvaluatorImplStateDir());
        if (!enabled || !existsSync(enabled.upstreamRepoDir)) {
          console.warn(
            '[main] harvest enabled but swe-rebench-v2 evaluator is not set up — run `jinn harnesses enable swe-rebench-v2-evaluator`',
          );
        } else {
          const { getSweRebenchV2ValidatedPoolStore } =
            await import('./solver-types/swe-rebench-v2.js');
          const { getDefaultMintedPoolStore } = await import('./solver-types/_swe-rebench-v2-minted-pool.js');
          const { HttpHfFetcher } = await import('./harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js');
          const { PythonEvalRunner } = await import('./harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js');
          const { createGitHubPublicRepoChecker } = await import('./solver-types/_swe-rebench-v2-guards.js');
          harvestLoopConfig = {
            ...baseHarvestLoopConfig,
            mintDeps: {
              stateDir: harvestStateDir,
              ipfsRegistryUrl: config.ipfsRegistryUrl,
              ipfsGatewayUrl: config.ipfsGatewayUrl,
              validatedStore: getSweRebenchV2ValidatedPoolStore(harvestStateDir),
              mintedStore: getDefaultMintedPoolStore(harvestStateDir),
              hfFetcher: new HttpHfFetcher(),
              runner: new PythonEvalRunner({ upstreamRepoDir: enabled.upstreamRepoDir }),
              upstreamRepoDir: enabled.upstreamRepoDir,
              publicRepoChecker: createGitHubPublicRepoChecker({
                token: process.env.GITHUB_TOKEN,
              }),
            },
          };
          console.log(
            `[main] harvest loop enabled: ${harvestRepos.length} repo(s), sources=${config.harvest.sources.join(',')}, interval=${config.harvest.intervalMs}ms`,
          );
        }
      }
    }
  }

  // ── Stage-1 cutover composition root (Task 12; loops started at close-out C8) ──────────────
  //
  // Testnet-only: `MarketplaceChainConfig` (TaskCoordinator/JinnRouterV3 addresses) is only
  // defined for Base Sepolia (`@jinn-network/marketplace-binding`'s `BASE_SEPOLIA_TODAY`) — no
  // equivalent contracts are deployed on Base mainnet yet (see CLAUDE.md's Phase 2 rollout).
  // `composition` stays `undefined` on mainnet; `DaemonConfig.composition` is optional and the
  // `work`/projector/evidence-driver config below is gated on it being defined.
  let composition: import('./daemon/composition-root.js').OperatorComposition | undefined;
  let workLoopConfig: Omit<import('./daemon/work-loop.js').WorkLoopConfig, 'composition' | 'store'> | undefined;
  // One-swap M4a (#2461): the native evaluator composition + loop. Built only in native mode when
  // the operator configured an evaluator; its resources (backend, evidence, discovery store) are
  // closed in `shutdown()` below, alongside the composition the daemon's evaluator loop drives.
  let fleetEvaluator: import('./daemon/native-fleet-evaluator.js').FleetNativeEvaluator | undefined;
  let evaluatorConfig: import('./daemon/daemon.js').DaemonConfig['evaluator'] | undefined;
  // One-swap M5d (#2461): the native posting loop config. Built only in native mode; the daemon's
  // `buildPostingLoop` gate then makes it inert unless `posting[]` is non-empty.
  let postingConfig: import('./daemon/daemon.js').DaemonConfig['posting'] | undefined;
  // One-swap M6 (#2461): the opt-in public record-discovery archive plane. A separate listener
  // over EVERY native signed source this operator owns — requester, solver and (when configured)
  // evaluator (#2519); closed in `shutdown()` below.
  let publicArchiveServer: import('./api/public-archive-server.js').PublicArchiveServer | undefined;
  // #2519 F1: the requester's serving plane, captured where the requester write path is built (it
  // needs the composition's venue, so it cannot be built at the archive mount) and mounted with
  // the other archives once every native leg exists.
  let fleetRequesterDiscovery:
    | import('./daemon/native-fleet-serving-plane.js').FleetServedSource
    | undefined;
  if (config.network === 'testnet') {
    const { buildOperatorComposition } = await import('./daemon/composition-root.js');
    const { BASE_SEPOLIA_TODAY } = await import('@jinn-network/marketplace-binding');
    // #2534 F3a: the registered documents and the claim allowlist are one list now, not two that
    // drift. `prediction-forecast/1.0` — the sole `PHASE_B_NATIVE_PROFILE_ALLOWLIST` entry, i.e.
    // the only profile a native operator may claim — was missing here, so every claimed
    // prediction task failed to resolve its own profile and went terminal.
    const { buildNativeProfileStore } = await import('./daemon/native-profile-documents.js');
    const nativeProfileStore = buildNativeProfileStore();
    // One-swap M2 (#2461): built ONLY when `compositionMode: "native"` selected it. The dynamic
    // import keeps the native runtime graph (trust catalog, record transport, Base Sepolia read
    // clients) off a legacy boot's module graph entirely — a default config loads none of it.
    const nativeRuntime = COMPOSITION_MODE === 'native'
      ? await (await import('./daemon/native-fleet-runtime.js')).buildFleetNativeRuntime({
          config,
          store: sharedStore,
          publicClient,
          safeAddress,
          stateRoot: join(config.earningDir, '..', 'native'),
          password: PASSWORD,
          workerOwnerId: cryptoRandomUUID(),
          logger: { warn: (message) => console.warn(message) },
        })
      : undefined;
    composition = await buildOperatorComposition({
      ...(nativeRuntime === undefined
        ? {
            mode: 'legacy' as const,
            // The bridge signer is explicitly legacy-only. Native delivery/discovery keys must come
            // from a persistent, effective-time-trusted RoleIdentitySet; native boot refuses without
            // it, and `buildOperatorComposition` refuses a native composition that receives one.
            legacyBridgeSigner: deriveLegacyBridgeSigner(agentPrivateKey),
          }
        : {
            mode: 'native' as const,
            nativeRoleIdentities: nativeRuntime.identities,
            nativeClaimRuntime: nativeRuntime.claimRuntime,
            nativeProjectorPorts: nativeRuntime.projectorPorts,
            nativeRequesterStateDir: nativeRuntime.nativeRequesterStateDir,
          }),
      config,
      publicClient,
      // Service Safe is owned by the agent EOA (index N), not the master (index 0).
      // Passing masterWallet here produces GS026 on every venue claim/Deliver/settle.
      walletClient: agentClients.walletClient,
      safeAddress,
      mechAddress,
      chain: BASE_SEPOLIA_TODAY,
      stateRoot: join(config.earningDir, '..', 'engine', 'backend'),
      evidenceRoot: join(config.earningDir, '..', 'evidence'),
      venueStateDbPath: join(config.earningDir, '..', 'venue', 'venue.db'),
      profileStore: nativeProfileStore,
      store: sharedStore,
      // Defect #45, same class as finding E39 below. `CompositionRootInput.logger` is optional and
      // this call site never supplied it, so `buildProjector` omitted it in turn and EVERY
      // `logger?.warn` inside `ProjectorLoop` and `createProjectorEnrich` was a no-op in
      // production — including the one that reports a failed announcement publication. A verdict
      // announcement could be suppressed on every single tick with nothing whatsoever in the
      // daemon log. Same console-based shape every other loop in this file wires up.
      logger: {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
      },
      ...(identityRegistryAddress ? { identityRegistryAddress } : {}),
    });

    // Finding E16 / the C2 ruling: no process-global broadcaster — this daemon's ONE Safe
    // broadcaster (built above, bound to `safeAddress`) is threaded explicitly to every legacy
    // `executeSafeTransaction` call site this daemon owns, before any loop can write. Must run
    // before `daemon.start()`; `adapter` / `deliveryDeps` are all
    // constructed earlier in this function (composition is built last because it needs
    // `identityRegistryAddress` etc. resolved first), so late-binding via setter/mutation is how
    // they pick up the one broadcaster rather than each racing to build their own against the
    // same Safe.
    adapter.setBroadcaster(composition.broadcaster);
    deliveryDeps.broadcaster = composition.broadcaster;

    // C8: the work loop's own config — `composition`/`store` are supplied by `Daemon` itself.
    // Finding E36 (ruled "build it"): `archive` is now fed from `composition.archive`, the real
    // `ArchiveSubscription` over the projector's durable observation stream
    // (`archive-subscription.js`). It stays empty in practice until the projector's own
    // `resolveSubmissionBytes` (composition-root.ts file header, gap a) actually admits/announces
    // a today-generation TaskCreated — a real, documented gap, not a stub this loop introduces.
    // `claimGate`/`ledger` reuse the SAME instances `verifySettlementGrade` already reads
    // (contract 2's dispatch-binding correlation).
    //
    // One-swap M3 (#2461): in native mode the SAME loop runs a different set of ports. Every
    // native port below is the instance the composition (or `buildFleetNativeRuntime`) already
    // returned — never a second construction — because program contract 2's dispatch-binding
    // correlation only holds when the coordinator that admitted the claim intent is the one the
    // loop drives, and `verifySettlementGrade` reads back through those same instances.
    //
    // `archive` is omitted and `acceptLegacyCards` is false: `WorkLoop`'s constructor refuses a
    // native composition that carries either, so the two shapes cannot be mixed by accident.
    const nativeWorkPorts = nativeRuntime === undefined ? undefined : {
      nativeDiscovery: nativeRuntime.discovery,
      nativeClaimCoordinator: composition.nativeClaimCoordinator!,
      nativeSolutionCoordinator: composition.nativeSolutionCoordinator!,
      nativeSolutionCorrections: composition.nativeSolutionCorrections!,
    };
    workLoopConfig = {
      ...(nativeWorkPorts === undefined
        ? { archive: composition.archive, acceptLegacyCards: true }
        : { ...nativeWorkPorts, acceptLegacyCards: false }),
      ledger: composition.engagementLedger,
      claimGate: composition.claimGate,
      estimateAiUnits: () => 0,
      readSealedDocuments: composition.readSealedDocuments,
      pollIntervalMs: config.pollIntervalMs,
      // Finding E39: without a logger, `WorkLoopConfig.logger` falls back to a silent no-op
      // (`work-loop.ts`'s `noopLogger`) and the per-tick outcome line (E39's fix) never reaches
      // an operator. Same console-based shape every other loop in this file wires up.
      logger: {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
      },
    };

    // One-swap M4a (#2461): mount the native evaluator loop alongside the WorkLoop. Native mode
    // only, and only when the operator configured an evaluator deployment + identity store — a
    // native solver-only operator constructs no evaluator composition. The dynamic import keeps the
    // evaluator graph off a legacy boot's module graph, exactly like `native-fleet-runtime`.
    if (nativeRuntime !== undefined) {
      const { buildFleetNativeEvaluator, fleetEvaluatorConfigured } =
        await import('./daemon/native-fleet-evaluator.js');
      if (fleetEvaluatorConfigured(config)) {
        // Reuse the ONE Safe's venue verdict ports rather than opening a second venue on the same
        // Safe (composition-root.ts's #525/#562/#897 nonce-race warning). `venue.verdict` is
        // present for the "today" (V3) generation `BASE_SEPOLIA_TODAY` runs against.
        const verdictPorts = composition.venue.verdict;
        if (verdictPorts === undefined) {
          throw new Error('native evaluator loop requires the composition venue to expose V3 verdict ports');
        }
        fleetEvaluator = await buildFleetNativeEvaluator({
          config,
          store: sharedStore,
          publicClient,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaAddress,
          trust: nativeRuntime.trust,
          records: nativeRuntime.records,
          agentIri: nativeRuntime.agentIri,
          verdictPorts,
          password: PASSWORD,
          stateRoot: join(config.earningDir, '..', 'native'),
        });
        // One-swap M4b (#2461): CLOSE FLIP-GATE 1. The projector was handed a late-bound
        // verdict-observation port that refuses fail-closed by default; now that the durable
        // evaluator `state` and the coordinator's own verification gate exist, install the REAL
        // adapter so the projector re-verifies this operator's own announced verdicts against
        // durable state instead of refusing them.
        const { buildNativeVerdictObservationAdapter, buildNativeEvaluationDeliveryRecordResolver } =
          await import('./daemon/native-verdict-observation.js');
        nativeRuntime.installVerdictObservation(buildNativeVerdictObservationAdapter({
          state: fleetEvaluator.state,
          verification: fleetEvaluator.composition.verification,
        }));
        // Defect #45. Same state, same moment, same reason: the today generation this fleet pins
        // carries no `evaluationDeliveryDigest` on `VerdictDeliveryClaimed`, so the announce leg's
        // `resolveRecord('evaluation-delivery')` reads the durable artifact by engagement — and the
        // gate installed just above is what then binds those bytes to exactly one durable row.
        nativeRuntime.installEvaluationDeliveryRecords(
          buildNativeEvaluationDeliveryRecordResolver(fleetEvaluator.state),
        );
        evaluatorConfig = {
          composition: fleetEvaluator.composition,
          pollIntervalMs: config.pollIntervalMs,
          logger: {
            info: (message) => console.log(message),
            warn: (message) => console.warn(message),
          },
        };
      }
    }

    // One-swap M5d (#2461): the native posting loop's host-wire. Native mode only, and same-instance
    // by construction — the ports read THIS operator's one service Safe + agent EOA balances through
    // the one `publicClient`, and `config.posting[]`. `buildFleetPostingRuntime` opens no store,
    // wallet, or discovery consumer (the M5d provenance ledger: it is not a `native_discovery_*`
    // consumer, so there is nothing to separate from the solver/evaluator queues). The daemon's
    // `buildPostingLoop` gate then makes the loop inert unless `posting[]` is non-empty.
    if (nativeRuntime !== undefined) {
      const { buildFleetPostingRuntime } = await import('./daemon/native-fleet-posting.js');
      // One-swap M5e (#2461): the requester WRITE port. Built only when the runtime produced the
      // requester write authority (admission custody configured). It reuses the composition's ONE
      // Safe broadcaster (`composition.venue.safe` — the SAME single-nonce authority the solver,
      // evaluator and verdict legs serialize through) plus that venue's posting WAL and scope store;
      // it opens NO second wallet or venue. When the authority is absent, `postTask` stays undefined
      // and the posting loop's `post` remains the M5d fail-closed seam.
      let fleetPostTask:
        | ((target: import('./daemon/posting-loop.js').PostingLoopTarget) => Promise<{ readonly taskId?: string }>)
        | undefined;
      // One-swap M5f (#2461): the requester's reconcile step, which recovers durable posting drafts
      // AND runs the G-loop adopt leg. Wired into the posting loop's reconcile port only on the write
      // path — a solver-only boot has no posted tasks to adopt.
      let fleetReconcile: (() => Promise<void>) | undefined;
      if (nativeRuntime.requesterWrite !== undefined) {
        const { buildFleetRequesterWrite } = await import('./daemon/native-fleet-requester-write.js');
        const { createFileAdoptionReceiptStore } = await import('./daemon/native-adoption-receipt-store.js');
        const { createRegistryPinPort } = await import('@jinn-network/marketplace-binding');
        const ipfsApiUrl = config.ipfs?.apiUrl;
        if (ipfsApiUrl === undefined) {
          throw new Error('native requester write path requires config.ipfs.apiUrl to pin the task document');
        }
        const requesterWrite = buildFleetRequesterWrite({
          ...nativeRuntime.requesterWrite,
          creatorSafe: safeAddress as `0x${string}`,
          safeBroadcast: composition.venue.safe,
          intents: composition.venue.intents,
          observe: composition.venue.observe,
          ipfsPin: createRegistryPinPort({
            registryUrl: ipfsApiUrl,
            fetchImpl: globalThis.fetch.bind(globalThis),
          }),
          // Durable adoption receipts live next to the requester's associations, under its state dir.
          adoptionReceipts: createFileAdoptionReceiptStore({
            dir: join(nativeRuntime.requesterWrite.requesterStateDir, 'adoptions'),
          }),
          // Defect #48: the SAME digest-verified record-plane reader the projector already holds,
          // so adoption can fetch the bytes of a delivery a SECOND operator produced and published
          // there. Not a second transport, and not trusted — the caller re-derives the digest.
          ...(nativeRuntime.projectorPorts.resolveDeliveryBytes === undefined
            ? {}
            : { recordPlaneBytes: nativeRuntime.projectorPorts.resolveDeliveryBytes }),
          logger: {
            info: (message) => console.log(message),
            warn: (message) => console.warn(message),
          },
        });
        fleetPostTask = (target) => requesterWrite.postTarget(target);
        fleetReconcile = () => requesterWrite.reconcile();
        // #2519 F1: the requester archive this operator must SERVE. Peers resolve the announced
        // Submission bytes from it, and this operator's own discovery consumer resolves its
        // `.well-known` introduction from it at boot.
        fleetRequesterDiscovery = requesterWrite.discovery;
      }
      const postingRuntime = buildFleetPostingRuntime({
        config,
        safeAddress: safeAddress as `0x${string}`,
        agentEoaAddress,
        readBalanceWei: (address) => publicClient.getBalance({ address }),
        logger: { warn: (message) => console.warn(message) },
        ...(fleetPostTask === undefined ? {} : { postTask: fleetPostTask }),
        ...(fleetReconcile === undefined ? {} : { reconcile: fleetReconcile }),
      });
      postingConfig = {
        compositionMode: COMPOSITION_MODE,
        postingEntryCount: postingRuntime.postingEntryCount,
        ports: postingRuntime.ports,
        intervalMs: config.pollIntervalMs,
        logger: {
          info: (message) => console.log(message),
          warn: (message) => console.warn(message),
        },
      };
    }

    // One-swap M6 (#2461), corrected by #2519: expose the native signed archives on their OWN
    // listener when the operator opts in (`publicArchive.enabled`; default off, loopback host).
    // Structural exposure scoping — the listener carries only archive handlers, never an operator
    // route (headless design §6). Legacy and default boots start nothing here.
    //
    // M6 mounted ONLY the solver publisher, which is what made a two-operator native loop
    // impossible: nothing served this operator's requester (or evaluator) archive, so no consumer
    // — including this operator's own, over its own requester source — could resolve those
    // introductions. It runs HERE, after the evaluator and requester-write legs exist, because
    // those two archives do not exist at composition time.
    //
    // That ordering is now safe rather than merely unavoidable: since #2521 nothing above resolves
    // a source. `buildFleetNativeRuntime` constructs its consumers with the endpoints deferred, so
    // this mount reliably precedes the first poll no matter how many statements sit between them,
    // and a PEER that is not up yet — which no reordering here could ever fix — is refused at that
    // poll instead of preventing this daemon from starting.
    //
    // ONE listener, not one port per role: every announcement's record locations are stamped
    // against the single `config.publicBaseUrl`, so all three archives must answer on one origin.
    // See `native-fleet-serving-plane.ts` for the full argument (and for the cold-start
    // introduction that breaks the "publish before you can boot" deadlock).
    if (COMPOSITION_MODE === 'native' && config.publicArchive.enabled) {
      const { buildFleetArchiveHandler, fleetServedSource } =
        await import('./daemon/native-fleet-serving-plane.js');
      const served = [
        ...(fleetRequesterDiscovery === undefined ? [] : [fleetRequesterDiscovery]),
        ...(composition.nativeSolutionPublisher === undefined
          ? []
          : [fleetServedSource(composition.nativeSolutionPublisher)]),
        ...(fleetEvaluator === undefined ? [] : [fleetServedSource(fleetEvaluator.composition.publisher)]),
      ];
      if (served.length === 0) {
        console.warn('[archive] publicArchive.enabled but this native boot owns no signed source — not serving.');
      } else {
        const { startPublicArchiveServer } = await import('./api/public-archive-server.js');
        publicArchiveServer = await startPublicArchiveServer({
          handler: buildFleetArchiveHandler(served),
          host: config.publicArchive.host,
          port: config.publicArchive.port,
        });
        console.log(
          `[archive] serving ${served.length} signed source(s): ${served.map(({ source }) => source.name).join(', ')}`,
        );
      }
    }
  }

  const daemon = new Daemon({
    adapter,
    runner,
    dbPath: config.dbPath,
    store: sharedStore,
    composition,
    work: workLoopConfig,
    evaluator: evaluatorConfig,
    posting: postingConfig,
    apiServer: setupApiServer,
    pollIntervalMs: config.pollIntervalMs,
    apiPort: config.apiPort,
    apiBindHost,
    apiToken,
    peers: config.peers.length > 0 ? config.peers : undefined,
    nodeEndpoint: config.nodeEndpoint,
    sweRebenchV2StateDir: config.sweRebenchV2StateDir,
    corpusFactory,
    status: {
      earningDir: config.earningDir,
      rpcUrl: config.rpcUrl,
      // stOLAS L2 distributor — mirrors `CHAIN_CONFIG.distributorAddress`
      // used to gate the EvictionLoop (issue #651). Threaded through so the
      // SPA's autoRestake predicate keys off the same on-chain artifact as
      // the daemon's `evictionCheck` predicate (~line 2520 below).
      stOlasDistributorAddress: CHAIN_CONFIG.distributorAddress,
      network: config.network,
      // #2380: clamped to what this legacy entry actually runs — see resolveMainEntryEffectiveMode.
      effectiveMode: reportedEffectiveMode,
      pollIntervalMs: config.pollIntervalMs,
      masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
      rewardClaimIntervalMs: config.rewardClaimIntervalMs,
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
      engine: config.engine,
      config,
      configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
      passwordRotation: {
        source: passwordResolution.source,
        filePath: passwordResolution.filePath,
      },
      // #641: back-fills /v1/status.latestVersion from the start-time
      // npm-registry check (populated after the daemon-running line below).
      latestVersion: () => latestVersionHolder.current,
      spendCaps: spendCap?.caps,
      aiUnits,
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
    // Eviction-check loop — only in standard staking mode (requires distributorAddress).
    // Running mode only: setup-halted daemons must not try to restake services that
    // haven't been staked yet (hjex.3).
    evictionCheck:
      config.evictionCheckIntervalMs > 0 &&
      config.stakingMode === 'standard' &&
      CHAIN_CONFIG.distributorAddress
        ? {
            intervalMs: config.evictionCheckIntervalMs,
            reStakeThrottleMs: config.checkpointIntervalMs,
            store: earningStore,
            chain: NETWORK_CHAIN,
            readContract: (opts) => publicClient.readContract(opts as Parameters<typeof publicClient.readContract>[0]) as Promise<bigint>,
            recoverEvictedService: async (svc) => {
              if (!svc.service_id || !svc.staking_address) return;
              await recoverEvictedServiceFn({
                serviceDisplayIndex: Math.max(0, svc.index - 1),
                serviceId: svc.service_id,
                stakingAddress: svc.staking_address,
                distributorAddress: CHAIN_CONFIG.distributorAddress!,
                rpcUrl: config.rpcUrl,
                chain: NETWORK_CHAIN,
                mnemonic: mnemonicForMaster,
              });
            },
          }
        : undefined,
    // Checkpoint loop — proactively advances `tsCheckpoint` on each staked
    // proxy so the activity-rate window stays narrow (issue #505).
    // `checkpoint()` is permissionless; master EOA pays gas. No-op for
    // non-standard staking modes.
    checkpoint:
      config.checkpointIntervalMs > 0 && config.stakingMode === 'standard'
        ? {
            intervalMs: config.checkpointIntervalMs,
            store: earningStore,
            chain: NETWORK_CHAIN,
            writeCheckpoint: async ({ stakingProxy }) => {
              const txHash = await withEoaBroadcastLock(masterAccount.address, () =>
                masterWallet.writeContract({
                  address: stakingProxy,
                  abi: [
                    {
                      type: 'function',
                      name: 'checkpoint',
                      stateMutability: 'nonpayable',
                      inputs: [],
                      outputs: [],
                    },
                  ] as const,
                  functionName: 'checkpoint',
                  account: masterAccount,
                  chain: null,
                }),
              );
              return { txHash };
            },
          }
        : undefined,
    harvest: harvestLoopConfig,
    // #1043 loop watchdog. Always constructed in production so a stale loop is
    // detected + surfaced; the process-exit recovery is flag-gated (default
    // OFF) by config.watchdogAutoRestart.
    watchdog: { autoRestart: config.watchdogAutoRestart },
  });

  if (config.watchdogAutoRestart) {
    console.log('[watchdog] auto-restart ENABLED (stale loop → non-zero exit)');
  }

  // #2407 B1: the deployment-readiness gate + pidfile acquisition used to live
  // here, AFTER the entire bootstrap retry loop — which left the whole
  // degrade-open window (part 2) with no pidfile on disk at all. During that
  // window `checkDaemonGuard` (cli/daemon-guard.ts) reads `daemon.pid` and
  // reports `not-running`, so a concurrent `jinn withdraw` / `jinn bootstrap`
  // / `jinn fleet scale` / `jinn solver-plugins publish` would proceed against
  // the same signer as the degraded recovery loops, and a second `jinn run`
  // would start a second degraded set entirely. Both gates now run near the
  // top of `main()`, immediately before the bootstrap retry loop (see
  // `setDaemonReadiness('bootstrapping')` above) — `pidPath` / `removePidfile`
  // stay in scope for the shutdown handler below unchanged.

  // Graceful shutdown — Daemon doesn't own the API server or Store in this
  // flow (they were created in setup-mode before bootstrap), so we close
  // them explicitly after Daemon.stop() completes.
  let shutdownPromise: Promise<void> | null = null;
  // #641: recurring npm-registry version check; cleared on shutdown.
  let versionCheckTimer: ReturnType<typeof setInterval> | null = null;
  const shutdown = async (signal: string) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let exitCode = 0;
      console.log(`\n[main] Received ${signal}, shutting down...`);
      try {
        if (versionCheckTimer) clearInterval(versionCheckTimer);
        harnessReadinessRegistry.stop();
        await daemon.stop();
        await setupApiServer.close().catch(() => undefined);
        // Close the evaluator composition's own resources (backend children, evidence runtime,
        // discovery store) after the loop that drives it has stopped.
        await fleetEvaluator?.close().catch(() => undefined);
        await publicArchiveServer?.close().catch(() => undefined);
        await closeCaptureReceiver();
      } catch (err) {
        exitCode = 1;
        console.error('[main] Shutdown failed:', err instanceof Error ? err.message : String(err));
      } finally {
        removePidfile();
        try {
          sharedStore.close();
        } catch {
          /* ignore */
        }
        // Issue #420: flush + close the rotating daemon file logger.
        closeFileLogger();
      }
      console.log('[main] Shutdown complete.');
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };

  // #2407 R2: the early signal handler installed right after the pidfile
  // write (bootstrap-retry-loop window) is superseded here — remove it
  // before installing the real graceful handlers so a signal from this
  // point on always drains through `shutdown()` (Daemon.stop(), file
  // logger flush, etc.) rather than racing an immediate `process.exit(0)`.
  process.removeListener('SIGINT', removePidfileOnEarlySignal);
  process.removeListener('SIGTERM', removePidfileOnEarlySignal);
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

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
  console.log(`[main] Daemon running. API: http://127.0.0.1:${config.apiPort} (no human surface)`);

  // #641: start-time (and recurring) npm-registry version check. Fire-and-forget
  // — never awaited, never rejects into boot. When a newer client is published
  // it logs one line and back-fills the dashboard's update_available banner via
  // `latestVersionHolder`. Opt out with JINN_VERSION_CHECK=0.
  if (isVersionCheckEnabled(process.env)) {
    const refreshVersionCheck = async (): Promise<void> => {
      try {
        const latest = await fetchLatestVersion();
        if (latest && isNewerVersion(getRunningVersion(), latest)) {
          // Only surface a value when the published latest is genuinely newer
          // than the running build. The dashboard banner derives directly from
          // a non-null `latestVersion`, so this keeps the log and the banner on
          // the same semver strictly-greater check.
          latestVersionHolder.current = latest;
          console.log(formatUpdateLogLine(latest));
        } else {
          // Not newer (equal, older, or unfetchable) — clear any prior value so
          // a stale tick can't linger as a false upgrade signal.
          latestVersionHolder.current = null;
        }
      } catch {
        // Advisory only — a registry hiccup must never disturb the daemon.
      }
    };
    void refreshVersionCheck();
    versionCheckTimer = setInterval(() => {
      void refreshVersionCheck();
    }, VERSION_CHECK_INTERVAL_MS);
    versionCheckTimer.unref();
  }

  return buildDaemonStartupInfo({
    pid: process.pid,
    network: config.network,
    apiPort: config.apiPort,
    masterAddress,
    safeAddress,
    mechAddress,
    serviceIndex,
    serviceId,
    // #2380: clamped to what this legacy entry actually runs — see resolveMainEntryEffectiveMode.
    effectiveMode: reportedEffectiveMode,
    implVersion: buildInfo.implVersion,
  });
}

// ── Harness readiness registry factory ───────────────────────────────────────
// Exported so tests can construct a registry without booting the full daemon.

/**
 * Builds a HarnessReadinessRegistry from the harness list returned by
 * buildHarnesses() and the operator's executionWiring.
 *
 * Per A2 carry-over: start() only schedules the background tick; callers that
 * need the snapshot populated immediately must call refreshNow() after start().
 */
export function buildHarnessReadinessRegistry(args: {
  harnesses: Harness[];
  config: Pick<JinnConfig, 'executionWiring'>;
}): HarnessReadinessRegistry {
  const harnessesByName: Record<string, Harness> = {};
  for (const h of args.harnesses) {
    harnessesByName[h.name] = h;
  }
  const joinedHarnessesByCid: Record<string, { harnessName: string; roles: Array<'solver' | 'evaluator'> }> = {};
  for (const entry of args.config.executionWiring ?? []) {
    if (entry.harness) {
      joinedHarnessesByCid[wiringParticipationKey(entry)] = {
        harnessName: entry.harness,
        roles: ['solver'],
      };
    }
  }
  return new HarnessReadinessRegistry({
    harnessesByName,
    joinedHarnessesByCid,
  });
}
