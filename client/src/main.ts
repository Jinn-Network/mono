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
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, getConfigPathFromArgs, DEFAULT_CONFIG_PATH, DEFAULT_TESTNET_RPC_URLS } from './config.js';
import { Store } from './store/store.js';
import { startApiServer, isEmbeddedAgentEnabled, type ApiServer } from './api/server.js';
import { setDefaultTxSubmissionLedger, withEoaBroadcastLock } from './tx-retry.js';
// addHarnessReadinessRoutes is wired through startApiServer's holder ref now
// (jinn-mono-u34i). No direct import needed.
import { CapturePublishUnavailableError } from './api/captures.js';
import { invalidatePredictionOperatorStatusCache } from './api/gather-status.js';
import type { LauncherGeneratorStateSnapshot } from './api/launcher-status.js';
import { ensureUiToken } from './api/ui-token.js';
import { decideUiAutoOpen } from './cli/ui-auto-open-gate.js';
import { getFileLogger, closeFileLogger } from './observability/file-logger.js';
import { emitProgress } from './observability/progress.js';
import { hashImplStateDir } from './harnesses/freeze.js';
import { readModeState } from './harnesses/mode-state.js';
import { attachAgentWs, updateAgentClaudePath } from './agent/agent-ws.js';
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
import { runFleetBootstrap, SetupBootstrapHalted } from './earning/bootstrap-run.js';
import { applyChainGasOverrides, getChainConfig } from './earning/contracts.js';
import { getJinnRouterAddress } from './contracts/addresses.js';
import { FleetStateStore } from './earning/store.js';
import { isOperationalServiceStep } from './earning/types.js';
import { decryptMnemonic, deriveMasterSigner } from './earning/wallet.js';
import { MechAdapter } from './adapters/mech/adapter.js';
import { ClaudeRunner } from './runner/claude.js';
import type { RunnerContext } from './runner/runner.js';
import { Daemon } from './daemon/daemon.js';
import { buildSpendCapConfig } from './spend/daemon-config.js';
import { buildAiUnitsConfig } from './spend/ai-units-config.js';
import { REFERENCE_CEILING } from './spend/ai-units.js';
import { createJinnPublicClient, createJinnWalletClient } from './earning/viem-clients.js';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address } from 'viem';
import {
  DEFAULT_DISABLED_HARNESSES,
  DEFAULT_HARNESS,
  HarnessRegistry,
} from './harnesses/engine/registry.js';
import { createMutableJoinedSolverNetsView } from './harnesses/engine/engine.js';
import { createAutopilotEvaluationContextResolver } from './autopilot/autopilot-evaluation-context-resolver.js';
import { createAutopilotGitHubAdoptionReceiptObserver } from './autopilot/github-adoption-receipt-observer.js';
import { createJinnMonoGitHubAdoptionReadPort } from './autopilot/github-rest-adoption-read.js';
import { createJoinApplier } from './daemon/join-applier.js';
import { buildHarnesses } from './harnesses/impls/index.js';
import {
  makeConfiguredSemanticEvaluatorRunnerResolver,
} from './harnesses/impls/jinn-repo-evaluator/semantic-runner-resolver.js';
import {
  makeDockerImmutableMechanicalVerifier,
} from './harnesses/impls/jinn-repo-evaluator/docker-immutable-verifier.js';
import { loadExternalImpl } from './harnesses/external-impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, HERMES_AGENT_HARNESS, harnessStateDirName } from './harnesses/names.js';
import { resolveContractFromSolverNetId } from './solvernets/launched-record-dispatcher.js';
import type { Harness } from './harnesses/types.js';
import { HarnessReadinessRegistry } from './harnesses/readiness-registry.js';
import type { JinnConfig } from './config.js';
import { createClients, type VenueBroadcaster } from './adapters/mech/safe.js';
import {
  findJoinedByName,
  loadSolverNets,
  solverTypeFromJoinedContract,
} from './solver-nets/registry.js';
import { createCorpus } from './corpus/index.js';
import { DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK } from './corpus/onchain-query.js';
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
import { BASE_FEEDS } from './venues/chainlink/feeds.js';
import { GeneratedTaskSource, StaticConfiguredTaskSource, filterBindableTasks } from './tasks/sources.js';
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
if (config.network === 'mainnet' && process.env['JINN_ENABLE_MAINNET'] !== '1') {
  console.warn('[main] Mainnet is disabled before launch; using testnet defaults.');
  config.network = 'testnet';
  config.rpcUrl = 'https://base-sepolia-rpc.publicnode.com';
}
// Issue #326: the embedded Claude agent chat surface (right rail + onboarding
// "Ask Claude" panel + /api/agent/ws bridge) is hidden by default while its
// action-authority / plugin-scope shape is still in design. Set
// `JINN_ENABLE_EMBEDDED_AGENT=1` to re-enable it for development. This does
// NOT affect Claude-Code-as-a-solver-harness — that path is independent.
//
// Issue #367: the SPA reads this flag via the injected `window.__JINN_FEATURES__`
// (`resolveFeatureFlags` in api/server.ts) like every other operator-app flag.
// This `embeddedAgentEnabled` const is the daemon-side consumer only — it gates
// whether the `/api/agent/ws` bridge is mounted below.
const embeddedAgentEnabled = isEmbeddedAgentEnabled();

let activeClaudePath = config.claudePath ?? 'claude';
const selectClaudePath = (claudePath: string): void => {
  activeClaudePath = claudePath;
  config.claudePath = claudePath;
  // Harmless no-op when the embedded agent is disabled
  // (`embeddedAgentEnabled` is false at this point): the agent surface
  // that consumes this path isn't mounted, so the update has nothing to
  // propagate to. Called unconditionally to keep the path in sync
  // whenever the agent IS enabled.
  updateAgentClaudePath(claudePath);
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
  const filePath = configPath ?? join(process.env['HOME'] ?? '', '.jinn-client', 'config.json');
  if (!filePath || !existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return !!raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
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

  // Boot-time RPC fallback-chain probe (issue #592, AC7 + AC9). Log-only —
  // per-slot 429s/5xx never gate startup. checkRpcNetwork above already
  // fail-loud on chain-id mismatch against the head provider.
  lastL2Probe = await probeFallbackChain(config.rpcUrls, config.network, 'L2');
  console.error(summarizeFallbackChain('L2', config.rpcUrls));

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

  const uiToken = ensureUiToken();
  const handshakeKey = cryptoRandomBytes(16).toString('hex');
  const apiBindHost = process.env['JINN_API_BIND_HOST'] ?? '127.0.0.1';
  const operatorArtifactsConfig = {
    publicEndpoint: config.operator?.publicEndpoint ?? `http://localhost:${config.apiPort}`,
    defaultPriceUsdc: config.operator?.defaultPriceUsdc ?? '0',
    perArtifactTypePrice: config.operator?.perArtifactTypePrice ?? {},
    donation: {
      enabled: config.network === 'testnet' && config.operator?.donation?.enabled === true,
    },
  };
  let corpusForApi: ReturnType<typeof createCorpus> | undefined;
  // Launcher mode wiring (Task 6 of spec/2026-05-05-launcher-role-and-mode.md).
  // The API server is constructed before bootstrap finishes, so the operator's
  // Safe address and the prediction.v1 generator are not yet known at start-up.
  // We capture both into closures here and let `addLauncherRoutes` read them
  // lazily — by the time `/v1/launcher/status` is hit, both are populated.
  let predictionGeneratorRef:
    | { getState(): import('./solver-types/prediction-v1-auto.js').PredictionV1GeneratorStateSnapshot }
    | undefined;
  const launchedGeneratorStateBySolverType = new Map<
    string,
    () => LauncherGeneratorStateSnapshot | undefined
  >();
  let safeAddressForLauncher: `0x${string}` | undefined;
  let publicClientForLauncher: ReturnType<typeof createJinnPublicClient> | undefined;

  // jinn-mono-hqz0: holder for SolverNet creation/launch endpoint deps.
  // The routes register eagerly in startApiServer (Hono freezes its matcher
  // on first request); subsystem init below populates `holder.current` and
  // the route handlers dereference it per-request.
  const solverNetEndpointsDepsHolder: {
    current: import('./api/solvernets-endpoints.js').SolverNetsEndpointsDeps | undefined;
  } = { current: undefined };

  // jinn-mono-u34i: same pattern for the harness readiness registry. The
  // registry is built post-bootstrap (depends on the keystore being
  // available), but the routes must be registered at server start to land in
  // Hono's matcher before the panel's first poll. Late-mounting via
  // `addHarnessReadinessRoutes(setupApiServer.app, ...)` after the panel had
  // been polling for minutes threw "Can not add a route since the matcher is
  // already built" and crashed the daemon on the running-mode transition.
  const harnessReadinessRegistryHolder: {
    current: import('./harnesses/readiness-registry.js').HarnessReadinessRegistry | undefined;
  } = { current: undefined };

  // jinn-mono-u34i: same eager-register / late-populate pattern for the
  // DiscoveryAPI. Pre-fix, /v1/discovery/* routes only mounted when
  // `config.discovery` was set at startApiServer time — but main.ts builds
  // `sharedDiscoveryApi` post-bootstrap, so the routes were never registered
  // and the panel's /build page got a permanent 404 on plugin-publications +
  // builder-artifacts. Holder ref lets the routes register eagerly and
  // start returning real data the moment main.ts assigns holder.current.
  const discoveryApiHolder: {
    current: import('./discovery/types.js').DiscoveryAPI | undefined;
  } = { current: undefined };

  // #1037: same eager-register / late-populate pattern for the join applier.
  // The join endpoint registers eagerly inside startApiServer; the applier is
  // built only after the latest join-consuming subsystem (the engine view,
  // wired in the Daemon ctor). The endpoint tolerates an empty holder in the
  // gap between server-start and populate by falling back to
  // restartRequired:true.
  const joinApplierHolder: {
    current: import('./daemon/join-applier.js').JoinApplier | undefined;
  } = { current: undefined };

  // #641: latest published `@jinn-network/client` version, back-filled by the
  // start-time npm-registry check below. `/v1/status.latestVersion` reads this
  // via the `latestVersion` getter threaded into the ApiServer status config.
  const latestVersionHolder: { current: string | null } = { current: null };

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
      corpus: () => corpusForApi,
      ui: { token: uiToken, handshakeKey },
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
      },
      harnessStatus: {
        getStatus: async () => {
          const mode = config.harness.mode;
          const defaultHarness = config.harnesses?.default ?? DEFAULT_HARNESS;
          const implStateDir = join(config.engine.implStateDirRoot, harnessStateDirName(defaultHarness));
          let codeDigest = '';
          try {
            codeDigest = await hashImplStateDir(implStateDir);
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
      captures: {
        captures: capturesStore,
        publishCapture: async (sessionId) => {
          const publish = capturePublishRef.current;
          if (!publish) {
            throw new CapturePublishUnavailableError(
              'Capture publisher is waiting for bootstrap to finish.',
            );
          }
          return publish(sessionId);
        },
        setTrustedRepo: (repoRemoteUrl, trusted) => {
          console.log(`[main] captures trust-repo ${trusted ? 'enabled' : 'disabled'} for ${repoRemoteUrl}`);
        },
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
          joinedSolverNets: config.joinedSolverNets as Record<string, unknown> | undefined,
          onboardingComplete: config.onboardingComplete,
        }),
      },
      // SolverNet catalog. Stubbed to the bundled `prediction` net for v1.
      // Once the daemon's harness/plugin registry is loaded, swap this for a
      // real registry adapter (separate task in the page-split plan).
      solverNets: {
        registry: {
          list: () => [
            {
              name: 'prediction',
              description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
              contract: { id: 'prediction', version: 'v1' },
              state: 'live' as const,
              supportedRoles: ['solving' as const, 'evaluating' as const],
              compatibleHarnesses: [
                { name: CLAUDE_CODE_HARNESS, version: '0.1.0', supportsRoles: ['solving' as const] },
              ],
              compatiblePlugins: [
                { name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' },
              ],
            },
            {
              name: 'swe-rebench-v2',
              description: 'Code-issue benchmark tasks from SWE-rebench v2. Solvers submit unified-diff patches; evaluators run the per-instance Docker harness.',
              contract: { id: 'swe-rebench-v2', version: 'v1' },
              state: 'live' as const,
              supportedRoles: ['solving' as const, 'evaluating' as const],
              // Order matters: the dashboard pre-selects compatibleHarnesses[0]
              // as the default solver harness. Hermes Agent is the SWE-rebench v2
              // default per the 2026-05-12 decision (jinn-mono-8psp.2 / spec §10);
              // operators may switch to Claude Code or Codex.
              compatibleHarnesses: [
                { name: HERMES_AGENT_HARNESS, version: '0.1.0', supportsRoles: ['solving' as const] },
                { name: CLAUDE_CODE_HARNESS, version: '0.1.0', supportsRoles: ['solving' as const] },
                { name: CODEX_HARNESS, version: '0.1.0', supportsRoles: ['solving' as const] },
                { name: 'swe-rebench-v2-evaluator', version: '0.1.0', supportsRoles: ['evaluating' as const] },
              ],
              compatiblePlugins: [
                { name: 'swe-rebench-v2-runtime', version: '0.1.0', source: 'bundled' },
              ],
            },
          ],
        },
      },
      // jinn-mono-hqz0: SolverNet creation/launch endpoints. Routes register
      // eagerly here; deps are populated by main.ts post-bootstrap via the
      // holder, and each route handler reads `holder.current` per-request.
      solverNetsLauncher: { holder: solverNetEndpointsDepsHolder },
      // jinn-mono-u34i: same eager-register / late-populate pattern for the
      // harness readiness routes. Until main.ts sets the holder, requests
      // return 503 subsystem_not_ready (the panel handles that gracefully).
      harnessReadinessRegistry: { holder: harnessReadinessRegistryHolder },
      // jinn-mono-u34i: see discoveryApiHolder comment above.
      discovery: { holder: discoveryApiHolder },
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
        // #1037: hot-apply a join to the running daemon. Populated after the
        // join-consuming subsystems are built (see joinApplierHolder). Empty
        // until then → the endpoint returns restartRequired:true.
        joinApplier: joinApplierHolder,
        // #983: mutate the in-memory config so GET /v1/bootstrap reflects the
        // completion flag live (the endpoint persists to disk; this keeps the
        // configReader's in-memory read consistent — same pattern as the
        // join-applier's config write). Cast: JinnConfig has the optional field.
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
      // Launcher mode (Tasks 6 + 7). Deps are resolved lazily because the
      // generator and Safe address are constructed after bootstrap, after
      // this `startApiServer` call. By the time the SPA hits the route,
      // bootstrap has completed and both refs are populated.
      //
      // Open-task-count is now real: it counts posted Tasks recorded against
      // the creator Safe with the SolverNet's solver_type. The result is a
      // strict superset of the in-flight count (we don't yet drop settled or
      // failed Tasks; that lifecycle tracking lands with the router-watcher
      // hardening lane, jinn-mono-l2zl.12). Safe balance is read live through
      // the daemon's viem public client once bootstrap has created it.
      // Reserved-budget remains unavailable until per-Task payment lifecycle
      // state is persisted; return an empty string rather than a fake zero so
      // the UI does not project runway from placeholder data.
      //
      // TODO(jinn-mono-l2zl.12): once Task lifecycle events are persisted,
      // narrow `getOpenTaskCount` to states in
      // ('open', 'claims-in-flight', 'fully-claimed') so the operator's
      // "open Tasks" stat doesn't drift upward across the daemon's lifetime.
      // TODO(jinn-mono launcher Task 8): real `getReservedBudgetWei`
      // (sum of unconsumed claim payments across open Tasks).
      launcher: {
        getConfig: () => ({ joinedSolverNets: config.joinedSolverNets }),
        configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
        // Issue #421 retired the legacy `solverNets` write target. The hook
        // only needs to invalidate the prediction-operator status cache when
        // operator mode mutates joinedSolverNets via setup endpoints.
        onSolverNetsUpdated: () => {
          invalidatePredictionOperatorStatusCache(config);
        },
        getGeneratorState: (netName) => {
          if (netName === 'prediction') {
            return predictionGeneratorRef?.getState();
          }
          const joined = findJoinedByName(config.joinedSolverNets, netName);
          const solverType = joined ? solverTypeFromJoinedContract(joined) : undefined;
          if (!solverType) return undefined;
          return launchedGeneratorStateBySolverType.get(solverType)?.();
        },
        getOpenTaskCount: (netName) => {
          if (!safeAddressForLauncher) return 0;
          const joined = findJoinedByName(config.joinedSolverNets, netName);
          const solverType = joined ? solverTypeFromJoinedContract(joined) : undefined;
          if (!solverType) return 0;
          return sharedStore.countPostedTasksByCreatorAndSolverType({
            creatorSafeAddress: safeAddressForLauncher,
            solverType,
          });
        },
        getReservedBudgetWei: () => '',
        getSafeBalanceWei: async () => {
          const safeAddress = safeAddressForLauncher;
          const publicClient = publicClientForLauncher;
          if (!safeAddress || !publicClient) return '';
          try {
            return (await publicClient.getBalance({
              address: getAddress(safeAddress) as Address,
            })).toString();
          } catch (err) {
            console.warn(
              `[main] launcher status Safe balance read failed for ${safeAddress}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return '';
          }
        },
        safeAddress: () =>
          safeAddressForLauncher ?? '0x0000000000000000000000000000000000000000',
        tasksDeps: {
          // Resolved per-request for the same reason `safeAddress` is a
          // closure — `safeAddressForLauncher` is undefined until bootstrap
          // finishes. Before that, the response is an empty list, which is
          // accurate (no posts can have happened pre-bootstrap).
          get creatorAddress() {
            return safeAddressForLauncher ?? '0x0000000000000000000000000000000000000000';
          },
          fetchPostedTasks: ({ creatorAddress, limit, before }) => {
            // No-op when bootstrap hasn't resolved a Safe yet.
            if (creatorAddress === '0x0000000000000000000000000000000000000000') {
              return [];
            }
            const opts: { creatorSafeAddress: string; limit: number; before?: string } = {
              creatorSafeAddress: creatorAddress,
              limit,
            };
            if (before) opts.before = before;
            const rows = sharedStore.listPostedTasksByCreator(opts);
            return rows.map((r) => ({
              taskId: r.taskId,
              // On-chain decimal id (#579) — the launcher status chip keys its
              // indexer lookup on this, not the off-chain display taskId. Empty
              // string (no on-chain id recorded) maps to undefined so the
              // gatherer falls back to taskId.
              ...(r.protocolTaskId ? { protocolTaskId: r.protocolTaskId } : {}),
              taskCid: r.taskCid,
              solverType: r.solverType ?? undefined,
              postedAt: r.postedAt,
              ...(r.state ? { state: r.state } : {}),
              ...(r.claims ? { claims: r.claims } : {}),
            }));
          },
          // #579: on-chain finalized/open/expired status for the Recent posted
          // Tasks chip. discoveryApiHolder is populated post-bootstrap; before
          // that (or with no discovery API) we return an empty Map → all chips
          // render 'unknown', the safe degraded default.
          fetchTaskStatuses: async (manifestCid: string) => {
            const api = discoveryApiHolder.current;
            if (!api) return new Map();
            return api.getTaskStatuses({ manifestCid });
          },
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
    openBrowser(process.env['JINN_UI_HANDSHAKE_URL']!);
  } else if (!noUi) {
    console.log(
      `[main] Dashboard ready at http://127.0.0.1:${setupApiServer.port} — ` +
        `run 'jinn ui' to open it (auto-open suppressed after first launch; use --ui to force)`,
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
      `Dashboard: http://127.0.0.1:${setupApiServer.port}`,
  );

  // ── Operator agent WebSocket bridge ──────────────────────────────────────
  // Mount /api/agent/ws on the same HTTP server so the SPA's xterm.js panel
  // can attach to a long-lived embedded `claude` subprocess. The embedded
  // session reads MCP config we materialise to disk so it can reach the
  // operator MCP server (`jinn mcp`) for tool calls.
  //
  // Issue #326: the embedded agent chat surface is hidden by default. The WS
  // bridge mounts only when `JINN_ENABLE_EMBEDDED_AGENT=1` so the dev-time
  // path stays end-to-end; with the flag off there is no /api/agent/ws route
  // and the SPA never renders the chat panel. Claude-Code-as-solver-harness
  // is independent of this bridge and unaffected.
  if (embeddedAgentEnabled) {
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
      claudePath: activeClaudePath,
      cwd: process.cwd(),
      mcpConfigPath: operatorMcpConfigPath,
    });
    console.log(
      `[main] Agent WS bridge mounted at ws://127.0.0.1:${setupApiServer.port}/api/agent/ws`,
    );
  } else {
    console.log(
      '[main] Embedded agent surface disabled (set JINN_ENABLE_EMBEDDED_AGENT=1 to enable).',
    );
  }

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

  // hjex.6: halt-and-resume loop for bootstrap retries.
  // When failBootstrap() throws SetupBootstrapHalted, we wait for the operator
  // to click Retry in the SPA (which resolves retryBootstrapResolve) rather
  // than returning and exiting. On each retry, we loop back and call bootstrap()
  // again. bootstrap() is idempotent — completed steps are no-ops.
  let bootstrapResult;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      bootstrapResult = await runFleetBootstrap({ config, password: PASSWORD, network: NETWORK_CHAIN, emitProgress });
      break; // success — exit the retry loop
    } catch (err) {
      if (err instanceof SetupBootstrapHalted) {
        // Install the retry signal so the endpoint can unblock us.
        const retrySignal = new Promise<void>((resolve, reject) => {
          retryBootstrapResolve = resolve;
          retryBootstrapReject = reject;
        });
        console.log('[main] Bootstrap halted. Waiting for retry signal from the dashboard...');

        // hjex.6: Auto-resume funding poller.
        // When the halt is a funding shortfall, poll the master EOA balance
        // every JINN_FUNDING_POLL_INTERVAL_MS (default 15s). When the balance
        // meets or exceeds the required amount, auto-signal the retry loop.
        // Only runs while the halt signal is pending; stops on any signal.
        let fundingPollHandle: ReturnType<typeof setTimeout> | null = null;
        const isHaltedOnFunding = err.envelope.code === 'funding_required';
        const haltDetails = err.envelope.details as Record<string, unknown> | undefined;
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
        continue; // loop back to the bootstrap() call
      }
      // If bootstrap throws an unexpected error (vs. SetupBootstrapHalted),
      // tear down the API we just started so we don't leave a dangling listener.
      await setupApiServer.close().catch(() => undefined);
      await closeCaptureReceiver();
      sharedStore.close();
      throw err;
    }
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
  // Now that bootstrap has resolved a Safe, expose it to the Launcher
  // mode endpoint so `/v1/launcher/status.budget.safeAddress` is accurate
  // on the very first SPA poll. (Task 6 of the launcher plan.)
  safeAddressForLauncher = safeAddress;
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
  publicClientForLauncher = publicClient;
  const masterWallet = createJinnWalletClient(config.rpcUrls, NETWORK_CHAIN, masterAccount);

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

  const taskDiscoveryManifestCids = Object.values(config.joinedSolverNets ?? {})
    .filter((entry) => entry.roles.includes('solver'))
    .map((entry) => entry.manifestCid);

  // #547: only scan/ingest evaluation opportunities when this operator holds the
  // evaluator role in at least one joined SolverNet. The join applier flips this
  // on live via adapter.setEvaluatorEnabled(true).
  const evaluatorEnabled = Object.values(config.joinedSolverNets ?? {})
    .some((entry) => entry.roles.includes('evaluator'));

  // ── DiscoveryAPI construction ─────────────────────────────────────────────
  // Build the shared DiscoveryAPI used by MechAdapter (task discovery),
  // the SolverNet registry client (lifecycle status), and the corpus library
  // (envelope discovery). See spec/2026-05-11-discovery-api-and-shared-indexer.md §9.
  let sharedDiscoveryApi: import('./discovery/types.js').DiscoveryAPI | undefined;
  {
    const onchainFloorOpts = {
      rpcUrl: config.rpcUrl,
      chainId: config.network === 'testnet' ? 84532 : 8453,
      routerAddress: ROUTER_ADDRESS,
      identityRegistryAddress: identityRegistryAddress ?? undefined,
      safeAddress,
      mechAddress: mechAddress ?? undefined,
      taskDiscoveryFromBlock: config.network === 'testnet' ? 41_153_291 : 25_000_000,
    } as const;
    async function buildOnchainFloor(): Promise<import('./discovery/types.js').DiscoveryAPI> {
      const { createOnchainDiscoveryAPI } = await import('./discovery/onchain.js');
      return createOnchainDiscoveryAPI(onchainFloorOpts);
    }

    const discoveryConfig = config.discovery;
    if (discoveryConfig) {
      // A discovery block was explicitly set.
      try {
        const { createDiscoveryAPI } = await import('./discovery/factory.js');
        sharedDiscoveryApi = createDiscoveryAPI(discoveryConfig, { ...onchainFloorOpts });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[main] DiscoveryAPI construction failed: ${msg} — falling back to onchain discovery`);
        sharedDiscoveryApi = await buildOnchainFloor();
      }
    } else {
      // No discovery config (mainnet without an explicit discovery block) —
      // default to the always-live onchain floor.
      sharedDiscoveryApi = await buildOnchainFloor();
    }
  }

  // jinn-mono-u34i: populate the holder so the /v1/discovery/* routes
  // registered eagerly at server-start time start returning real data on
  // the panel's next refetch. Before this, the routes 404'd forever and
  // the /build page rendered "Discovery unavailable" permanently.
  discoveryApiHolder.current = sharedDiscoveryApi;

  // #1037: the live task-discovery descriptor. Always present with a mutable
  // `solverNetManifestCids` array (`taskDiscoveryManifestCids` is a fresh
  // `.map` result, safe to push onto). The join applier holds this same object
  // reference and pushes a newly-joined cid onto it live.
  const taskDiscovery = {
    discoveryApi: sharedDiscoveryApi,
    solverNetManifestCids: taskDiscoveryManifestCids,
    // No explicit `onchainFromBlock` by default — let `MechAdapter`'s
    // `DEFAULT_TASK_DISCOVERY_FROM_BLOCK` per-chain default flow through.
    // Hardcoding here shadowed the adapter's default and re-introduced the
    // ghost-task floor every release; removing the shadow makes `adapter.ts`
    // the single source of truth. See gh #300. An operator MAY opt in to a
    // recent floor via `taskDiscoveryOnchainFromBlock` to bound the canonical
    // getLogs scan (which otherwise parses a large history on the main thread
    // and can stall the loop) and lean on the indexer DiscoveryAPI.
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
    evaluatorEnabled,
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
        getJoinedSolverNets: () => config.joinedSolverNets,
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

  // #1037: always construct the engine eligibility view (mutable) so a
  // hot-applied join can inject its cid live. Previously this was wired only
  // when config.joinedSolverNets was truthy; a zero-join daemon then ran the
  // legacy solverType gate. With an always-present empty view, a zero-join
  // daemon rejects cid-bearing tasks (its discovery cid set is empty so it
  // discovers none) and still passes legacy no-cid tasks. See plan §behaviour-change.
  const joinedSolverNetsView = createMutableJoinedSolverNetsView(config.joinedSolverNets);

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
    harnessMode: config.harness.mode,
    scrubPipeline: sellerScrubPipeline,
  });
  capturePublishRef.current = liveCapturePublisher.publishCapture;

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
  //      parent manifest's evidenceHash via the shared `DiscoveryAPI`. When
  //      no DiscoveryAPI is available the resolver returns null cleanly and
  //      the hook becomes a no-op (defensive: feedback is non-fatal).
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
      reputationFeedback = {
        client: reputationClient,
        resolveAgentId: (manifestHash) =>
          resolveAgentIdForManifest({ manifestHash, discoveryApi: sharedDiscoveryApi }),
      };
      console.log(
        `[main] ReputationFeedback: registry=${reputationRegistryAddress}${sharedDiscoveryApi ? ' discoveryApi=active' : ' (no discoveryApi — resolver always null)'}`,
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

  // ── SolverNet subsystem (Task 11 of solvernet-creation-and-launch.md) ─────
  //
  // Loads owned launched records from `~/.jinn-client/solvernets/launched/`,
  // resumes any in-flight launch / lifecycle transitions, and starts the
  // operator catalog refresher. Generator construction per launched record
  // lands in Task 12; until then we expose `pendingGenerators` so the
  // upcoming wiring has a clean handoff point.
  //
  // The launch state machine resumes correctly through the receipt-confirmation
  // path; discovery is now exclusively via DiscoveryAPI (280n.6).
  let solverNetSubsystem: import('./solvernets/daemon-init.js').SolverNetSubsystem | undefined;
  // Hoisted so the engine wiring below can pick the registry client up as
  // its `manifestResolver` (Task 27 of the SolverNet creation-and-launch
  // spec — task validation goes manifest → contract → schemas).
  let solverNetRegistryClientForEngine:
    | import('./solvernets/registry-client.js').SolverNetRegistryClient
    | undefined;
  if (agentId && identityRegistryAddress && config.network === 'testnet') {
    const {
      initSolverNetSubsystem,
      createIpfsClientAdapter,
      createMetadataPublisherFromViem,
      createDefaultRegistryClient,
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
    const solverNetRegistryClient = createDefaultRegistryClient({
      ipfs: solverNetIpfs,
      publisher: solverNetPublisher,
      discoveryApi: sharedDiscoveryApi,
      network: 'base-sepolia',
    });
    solverNetRegistryClientForEngine = solverNetRegistryClient;

    const launcherSigner: import('./solvernets/registry-client.js').SignerWithAgentEoa = {
      agentEoaAddress: privateKeyToAccount(agentPrivateKey).address as `0x${string}`,
      agentEoaPrivateKey: agentPrivateKey,
      agentId,
    };

    try {
      solverNetSubsystem = await initSolverNetSubsystem({
        store: solverNetStore,
        ipfs: solverNetIpfs,
        publisher: solverNetPublisher,
        registryClient: solverNetRegistryClient,
        network: 'base-sepolia',
        resolveSigner: async () => launcherSigner,
        lifecycleSigner: launcherSigner,
        awaitTxConfirmation: async (txHash) => {
          const receipt = await agentClients.publicClient.waitForTransactionReceipt({ hash: txHash });
          return { blockNumber: Number(receipt.blockNumber) };
        },
      });
      console.log(
        `[main] SolverNet subsystem ready: ${solverNetSubsystem.records.length} owned record(s), ` +
          `${solverNetSubsystem.pendingGenerators.length} ready for spawn (Task 12)`,
      );

      // jinn-mono-hqz0: populate the launcher endpoints' deps holder. The
      // routes themselves were registered eagerly inside startApiServer
      // (Hono's matcher freezes before the holder is filled, so handlers
      // dereference holder.current per-request). Without this the SPA's
      // /launcher list page 404s on /v1/solvernets/launched.
      if (solverNetEndpointsDepsHolder) {
        const { LaunchAction } = await import('./solvernets/launch-state-machine.js');
        const { LifecycleTransition } = await import('./solvernets/lifecycle-transitions.js');
        const awaitLauncherTxConfirmation = async (txHash: `0x${string}`) => {
          const receipt = await agentClients.publicClient.waitForTransactionReceipt({ hash: txHash });
          return { blockNumber: Number(receipt.blockNumber) };
        };
        const pendingGeneratorsRef = { current: solverNetSubsystem.pendingGenerators };
        // Noop subgraph for launch/lifecycle state-machine mempool-drop recovery.
        // Real subgraph extension lands in Task 25 (jinn-mono-280n).
        const noopSubgraph = {
          async fetchSetMetadataEvents() { return []; },
          async fetchSetMetadataEventsForCid() { return []; },
        };
        const launchAction = new LaunchAction({
          store: solverNetStore,
          ipfs: solverNetIpfs,
          publisher: solverNetPublisher,
          subgraph: noopSubgraph,
          spawnGenerator: async () => {
            /* Generators are spawned by main.ts post-launch loop;
             * the launcher endpoint just persists the record here. */
          },
          awaitTxConfirmation: awaitLauncherTxConfirmation,
        });
        const lifecycleTransition = new LifecycleTransition({
          store: solverNetStore,
          registry: solverNetRegistryClient,
          signer: launcherSigner,
          subgraph: noopSubgraph,
          awaitTxConfirmation: awaitLauncherTxConfirmation,
        });
        if (!safeAddressForLauncher) {
          throw new Error('[main] safeAddressForLauncher missing at SolverNet endpoints registration');
        }
        const getGeneratorState = (
          solverNetId: string,
        ): LauncherGeneratorStateSnapshot | undefined => {
          const entry = pendingGeneratorsRef.current.find(
            (g) => g.recordRef.current.solverNetId === solverNetId,
          );
          const resolved = resolveContractFromSolverNetId(
            entry?.recordRef.current.solverNetId ?? solverNetId,
          );
          if (!resolved) return undefined;
          return launchedGeneratorStateBySolverType.get(resolved.solverType)?.();
        };
        solverNetEndpointsDepsHolder.current = {
          store: solverNetStore,
          launch: {
            launchAction,
            lifecycleTransition,
            getGeneratorState,
            pendingGenerators: pendingGeneratorsRef,
            signer: launcherSigner,
            network: 'base-sepolia',
            launcher: {
              safeAddress: safeAddressForLauncher,
              agentEoa: launcherSigner.agentEoaAddress,
              agentId: launcherSigner.agentId,
            },
          },
          catalog: solverNetSubsystem.catalog,
          registry: solverNetRegistryClient,
        };
        console.log('[main] SolverNet endpoints deps populated (jinn-mono-hqz0)');
      }
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
  // The catalog cache will be consumed by the API server in Tasks 14/15.
  // The `pendingGenerators` set is iterated below to wire generators per
  // launched record (Task 12).

  // ── Auto Task generators (launched-record-driven) ────────────────────────
  //
  // Per spec/2026-05-05-solvernet-creation-and-launch.md §11 + Task 22 of the
  // implementation plan, generator construction is wholly driven by the
  // SolverNet launched-record subsystem. The legacy
  // `collectTestnetAutoTaskGenerators` path (config-block-keyed Polymarket
  // generator + role-based hot-spawn gate) is retired — SolverNet ownership
  // is determined by which launched records the daemon owns, not by the
  // operator-config role enum.
  const autoTasksDisabled = process.env['JINN_DISABLE_AUTO_TASKS'] === '1';
  // ── SolverNet launched-record generators (Task 12 of
  //     spec/2026-05-05-solvernet-creation-and-launch.md §11) ────────────────
  //
  // For each owned launched record where `status === 'launched'` and
  // `generatorEnabled === true`, construct a prediction.v1 Polymarket
  // generator wired to the live `recordRef` and `configRef` exposed by
  // `initSolverNetSubsystem`. Lifecycle transitions (pause/resume/retire)
  // and the SolverNet config API endpoint (Task 14) mutate these refs at
  // runtime; the per-tick gate inside the generator picks the change up
  // within one cadence — no daemon restart, no recreation.
  const launchedRecordGenerators: Array<{
    solverType: string;
    generator: import('./tasks/sources.js').TaskGenerator;
  }> = [];
  if (solverNetSubsystem && !autoTasksDisabled) {
    const { wireLaunchedRecordGenerators } = await import(
      './solvernets/launched-record-dispatcher.js'
    );
    const wired = await wireLaunchedRecordGenerators({
      pendingGenerators: solverNetSubsystem.pendingGenerators,
      launchedDir: join(config.earningDir, 'solvernets', 'launched'),
      staticConfig: {
        agentEoa: agentEoaAddress,
        safeAddress,
        agentPrivateKey,
        ipfsGatewayUrl: config.ipfsGatewayUrl,
        stateDir: config.sweRebenchV2StateDir,
        ...(sharedDiscoveryApi ? { discoveryApi: sharedDiscoveryApi } : {}),
      },
      logger: {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
      },
    });
    launchedRecordGenerators.push(...wired.generators);
    for (const [solverType, getState] of wired.generatorStatesBySolverType) {
      launchedGeneratorStateBySolverType.set(solverType, getState);
    }
    if (!predictionGeneratorRef && wired.predictionGeneratorRef) {
      predictionGeneratorRef =
        wired.predictionGeneratorRef as unknown as typeof predictionGeneratorRef;
    }
  }
  if (config.network === 'mainnet' && !autoTasksDisabled && BASE_FEEDS['ETH / USD']) {
    // Mainnet auto-task opt-in only; default is OFF. Reserved for a future flag.
  }

  // filterBindableTasks (issue #415): drop config-level tasks[] entries without
  // solverNetManifestCid before they enter the creator loop. Such entries would
  // throw a PermanentError on every attempt and retry every 30 min indefinitely.
  const bindableConfigTasks = filterBindableTasks(config.tasks);
  const taskSources = [
    new StaticConfiguredTaskSource(bindableConfigTasks),
    ...launchedRecordGenerators.map(({ solverType, generator }, idx) =>
      new GeneratedTaskSource(`launched:${solverType}:${idx}`, generator, {
        bucketKeyForTask: (task) => {
          if (task.solverType === 'swe-rebench-v2.v1') {
            const instanceId = task.spec?.['instance_id'];
            const postedCount = task.eligibility?.['posted_count_after_record'];
            if (typeof instanceId !== 'string' || typeof postedCount !== 'number') return undefined;
            return `swe-rebench-v2:${instanceId}:${postedCount}`;
          }
          // Issue #1893: jinn-repo.v1 live-issue tasks bucket on
          // <issueNumber>:<snapshotHash> (carried on `eligibility` by
          // `jinn-repo-live-auto.ts`) rather than the default window-based
          // key — the window's startTs/endTs changes every tick, which would
          // defeat once-per-bucket dedup for a generator whose own re-post
          // signal is a material issue edit, not the passage of time.
          if (task.solverType === 'jinn-repo.v1' && task.spec?.['source'] === 'live-issue') {
            const issueNumber = task.eligibility?.['issue_number'];
            const snapshotHash = task.eligibility?.['snapshot_hash'];
            if (typeof issueNumber !== 'number' || typeof snapshotHash !== 'string') return undefined;
            return `jinn-repo-live:${issueNumber}:${snapshotHash}`;
          }
          return undefined;
        },
      }),
    ),
  ];

  // ── Corpus (daemon-side, jinn-mono-vy37.1.6) ─────────────────────────────
  //
  // Built once per daemon lifetime; the agent EOA private key stays in this
  // process's memory and never crosses into the MCP subprocess. The MCP
  // tool `acquire_artifact` proxies to `POST /v1/artifacts/acquire` instead.
  // Always enabled when a DiscoveryAPI is available (which is always true after
  // 280n.3 — the onchain floor is always constructed). Falls back to disabled
  // when no discovery is available and no identity registry is set.
  const corpusFactory = (sharedDiscoveryApi || identityRegistryAddress)
    ? (store: Store) =>
        (corpusForApi = createCorpus({
          ...(sharedDiscoveryApi ? { discovery: sharedDiscoveryApi } : {}),
          ipfsGatewayUrl: config.ipfsGatewayUrl,
          store,
          signer: { privateKey: agentPrivateKey },
          selfSafeAddress: safeAddress,
          ...(!sharedDiscoveryApi && identityRegistryAddress
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
      '[main] Corpus disabled (no DiscoveryAPI or on-chain identity registry); ' +
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
  if (config.network === 'testnet') {
    const { buildOperatorComposition } = await import('./daemon/composition-root.js');
    const { BASE_SEPOLIA_TODAY } = await import('@jinn-network/marketplace-binding');
    const { buildRepositoryWorkProfile, buildEvaluationTaskProfile, sealTaskProfile } =
      await import('@jinn-network/task-execution-profiles');
    const profileDocuments = [buildRepositoryWorkProfile(), buildEvaluationTaskProfile()];
    const profilesByDigest = new Map(
      profileDocuments.map((doc) => [sealTaskProfile(doc).digest, doc]),
    );
    composition = await buildOperatorComposition({
      config,
      publicClient,
      walletClient: masterWallet,
      safeAddress,
      mechAddress,
      chain: BASE_SEPOLIA_TODAY,
      stateRoot: join(config.earningDir, '..', 'engine', 'backend'),
      evidenceRoot: join(config.earningDir, '..', 'evidence'),
      venueStateDbPath: join(config.earningDir, '..', 'venue', 'venue.db'),
      profileStore: { get: (digest) => profilesByDigest.get(digest) },
      store: sharedStore,
      ...(identityRegistryAddress ? { identityRegistryAddress } : {}),
    });

    // Finding E16 / the C2 ruling: no process-global broadcaster — this daemon's ONE Safe
    // broadcaster (built above, bound to `safeAddress`) is threaded explicitly to every legacy
    // `executeSafeTransaction` call site this daemon owns, before any loop can write. Must run
    // before `daemon.start()`; `adapter` / `deliveryDeps` / `reputationFeedback.client` are all
    // constructed earlier in this function (composition is built last because it needs
    // `identityRegistryAddress` etc. resolved first), so late-binding via setter/mutation is how
    // they pick up the one broadcaster rather than each racing to build their own against the
    // same Safe.
    adapter.setBroadcaster(composition.broadcaster);
    deliveryDeps.broadcaster = composition.broadcaster;
    reputationFeedback?.client.setBroadcaster(composition.broadcaster);

    // C8: the work loop's own config — `composition`/`store` are supplied by `Daemon` itself.
    // Finding E36 (ruled "build it"): `archive` is now fed from `composition.archive`, the real
    // `ArchiveSubscription` over the projector's durable observation stream
    // (`archive-subscription.js`). It stays empty in practice until the projector's own
    // `resolveSubmissionBytes` (composition-root.ts file header, gap a) actually admits/announces
    // a today-generation TaskCreated — a real, documented gap, not a stub this loop introduces.
    // `claimGate`/`ledger` reuse the SAME instances `verifySettlementGrade` already reads
    // (contract 2's dispatch-binding correlation).
    workLoopConfig = {
      archive: composition.archive,
      ledger: composition.engagementLedger,
      claimGate: composition.claimGate,
      estimateAiUnits: () => 0,
      readSealedDocuments: composition.readSealedDocuments,
      pollIntervalMs: config.pollIntervalMs,
      acceptLegacyCards: true,
    };
  }

  const daemon = new Daemon({
    adapter,
    runner,
    taskSources,
    dbPath: config.dbPath,
    store: sharedStore,
    composition,
    work: workLoopConfig,
    apiServer: setupApiServer,
    pollIntervalMs: config.pollIntervalMs,
    apiPort: config.apiPort,
    apiBindHost,
    apiToken,
    peers: config.peers.length > 0 ? config.peers : undefined,
    nodeEndpoint: config.nodeEndpoint,
    creatorSafeAddress: safeAddress,
    sweRebenchV2StateDir: config.sweRebenchV2StateDir,
    corpusFactory,
    harnessReadinessRegistry,
    spendCap,
    aiUnits,
    status: {
      earningDir: config.earningDir,
      rpcUrl: config.rpcUrl,
      // stOLAS L2 distributor — mirrors `CHAIN_CONFIG.distributorAddress`
      // used to gate the EvictionLoop (issue #651). Threaded through so the
      // SPA's autoRestake predicate keys off the same on-chain artifact as
      // the daemon's `evictionCheck` predicate (~line 2520 below).
      stOlasDistributorAddress: CHAIN_CONFIG.distributorAddress,
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
    restorationEngine: {
      paths: {
        workingDirRoot: config.engine.workingDirRoot,
        implStateDirRoot: config.engine.implStateDirRoot,
      },
      packagingDeps,
      envelopeDeps,
      deliveryDeps,
      adoptionReceiptObserver: autopilotAdoptionReceiptObserver,
      implRegistry,
      solverNetRegistry,
      // #1827: resolves envelope.task.createdAt at claim() time. getBlock
      // errors propagate deliberately — engine.ts retries a bounded number of
      // times and keeps/fails the task before signing rather than emitting a
      // provenance tuple without its authoritative creation timestamp.
      blockTimestamp: {
        getBlockTimestamp: async (blockNumber: number): Promise<number | undefined> => {
          const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
          return Number(block.timestamp);
        },
        configuredRpcUrls: config.rpcUrls,
      },
      // Spec §14, Task 28: per-launch claim eligibility filter. Operators
      // populate `joinedSolverNets[<manifestCid>]` via the SPA's join flow;
      // the engine refuses tasks whose `manifestDigest = keccak256(cid)`
      // doesn't match a joined entry (plus a role gate). Absent when the
      // operator hasn't joined any nets yet — the engine then falls back to
      // the legacy solverType-keyed gate.
      // #1037: always wire the (mutable) view so a hot-applied join is live.
      joinedSolverNets: joinedSolverNetsView,
      // Spec §14: task validation resolves manifest → contract → schemas.
      // Threaded only when the SolverNet registry client was constructed
      // (testnet branch above). The engine treats absence as "schema
      // validation skipped" — production callers always have it.
      ...(solverNetRegistryClientForEngine
        ? { manifestResolver: solverNetRegistryClientForEngine }
        : {}),
      identityPublisher,
      reputationFeedback,
      operatorConfig,
      operatorSafeAddress: safeAddress,
      harnessMode: config.harness.mode,
      // #1393: corpus knowledge autoload — operator opt-out flag. The corpus
      // instance itself is injected by the Daemon (built from corpusFactory).
      knowledge: { enabled: config.engine.knowledgeAutoload },
      // Share the one maintained scrub pipeline (incl. optional ML PII) so task
      // trajectories and captures are scrubbed by the same stack before publish.
      scrubPipeline: sellerScrubPipeline,
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

  // #1037: populate the join applier now that all four join-consuming
  // subsystems exist — the live task-discovery descriptor (`taskDiscovery`),
  // the mutable engine view (`joinedSolverNetsView`), the readiness registry,
  // and the SolverNet registry. The join endpoint registered eagerly at
  // server-start; before this point it returns restartRequired:true.
  joinApplierHolder.current = createJoinApplier({
    taskDiscovery,
    view: joinedSolverNetsView,
    readiness: harnessReadinessRegistry,
    registry: solverNetRegistry,
    config,
    enableEvaluator: () => adapter.setEvaluatorEnabled(true),
  });

  if (config.watchdogAutoRestart) {
    console.log('[watchdog] auto-restart ENABLED (stale loop → non-zero exit)');
  }

  // Write pidfile so `jinn stop` can find us. First, refuse the run if another
  // daemon already owns this earning directory — see issue #649. The gate
  // handles all three branches (refuse-and-exit, unlink-stale-and-continue,
  // proceed); the writeFileSync below MUST stay outside the helper so the
  // "// DO NOT add store mutations above this line — see #649" invariant is
  // visible right here at the call site.
  // Deployment-readiness gate (#958). In a deployment context (JINN_STATE_DIR
  // set or a container/compose auth context) this fails loud and exits when a
  // hard check fails (writable-volume, state-on-volume, agent-cli-non-root).
  // Outside a deployment context it only logs advisories — a plain local
  // `jinn run` is NEVER newly gated here. Runs before the pidfile gate so an
  // unfit environment refuses before we touch the pidfile.
  await applyDeploymentReadinessGate(
    {
      stateDir: config.stateDir,
      earningDir: config.earningDir,
      runtimeMode: config.runtimeMode,
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
  console.log(`[main] Daemon running. Dashboard: http://127.0.0.1:${config.apiPort}`);

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

// ── Harness readiness registry factory ───────────────────────────────────────
// Exported so tests can construct a registry without booting the full daemon.

/**
 * Builds a HarnessReadinessRegistry from the harness list returned by
 * buildHarnesses() and the operator's joinedSolverNets config block.
 *
 * Per A2 carry-over: start() only schedules the background tick; callers that
 * need the snapshot populated immediately must call refreshNow() after start().
 */
export function buildHarnessReadinessRegistry(args: {
  harnesses: Harness[];
  config: Pick<JinnConfig, 'joinedSolverNets'>;
}): HarnessReadinessRegistry {
  const harnessesByName: Record<string, Harness> = {};
  for (const h of args.harnesses) {
    harnessesByName[h.name] = h;
  }
  const joinedHarnessesByCid: Record<string, { harnessName: string; roles: Array<'solver' | 'evaluator'> }> = {};
  for (const [cid, entry] of Object.entries(args.config.joinedSolverNets ?? {})) {
    if (entry.harness) {
      joinedHarnessesByCid[cid] = {
        harnessName: entry.harness,
        roles: entry.roles,
      };
    }
  }
  return new HarnessReadinessRegistry({
    harnessesByName,
    joinedHarnessesByCid,
  });
}
