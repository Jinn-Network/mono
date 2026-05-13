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
import { loadConfig, getConfigPathFromArgs, DEFAULT_CONFIG_PATH } from './config.js';
import { Store } from './store/store.js';
import { startApiServer, type ApiServer } from './api/server.js';
import { CapturePublishUnavailableError } from './api/captures.js';
import { invalidatePredictionOperatorStatusCache } from './api/gather-status.js';
import { ensureUiToken } from './api/ui-token.js';
import { hashImplStateDir } from './harnesses/freeze.js';
import { readModeState } from './harnesses/mode-state.js';
import { attachAgentWs, updateAgentClaudePath } from './agent/agent-ws.js';
import { createSetupModeController } from './setup-mode.js';
import { formatBootstrapOperatorMessage } from './operator-errors.js';
import { buildEnvelope, emitEnvelope, type ErrorCode, type ErrorEnvelope } from './errors/envelope.js';
import {
  clearBootstrapError,
  persistBootstrapError,
} from './errors/persisted-bootstrap-error.js';
import { emitStructured } from './events/emitter.js';
import { checkClaudeBinary } from './preflight/claude-binary.js';
import { emitClaudeBinaryPreflightFailure } from './preflight/claude-invocation-envelope.js';
import { detectAuthContext, probeClaudeAuth } from './preflight/claude-auth.js';
import { configRequiresClaudeAuth } from './preflight/claude-required.js';
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
import { getAddress, type Address } from 'viem';
import {
  DEFAULT_DISABLED_HARNESSES,
  DEFAULT_HARNESS,
  HarnessRegistry,
} from './harnesses/engine/registry.js';
import { joinedSolverNetsViewFromConfig } from './harnesses/engine/engine.js';
import { buildHarnesses } from './harnesses/impls/index.js';
import { loadExternalImpl } from './harnesses/external-impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, harnessStateDirName } from './harnesses/names.js';
import type { Harness } from './harnesses/types.js';
import { createClients } from './adapters/mech/safe.js';
import { loadSolverNets } from './solver-nets/registry.js';
import { createCorpus } from './corpus/index.js';
import { DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK } from './corpus/onchain-query.js';
import { CapturesStore } from './store/captures.js';
import { createLiveCapturePublisher } from './captures/live-publisher.js';
import { startReceiver, type Receiver } from './trajectory/receiver.js';
import { startSyntheticSpanProvider, emitSyntheticSpan } from './trajectory/synthetic-span-builder.js';
import { CredentialScrubProcessor } from './trajectory/processors/credential-scrub.js';
import { TranscriptContentScrubProcessor } from './trajectory/processors/transcript-content-scrub.js';
import { IdentityScrubProcessor } from './trajectory/processors/identity-scrub.js';
import { PathScrubProcessor } from './trajectory/processors/path-scrub.js';
import { SqliteExporterProcessor } from './trajectory/processors/sqlite-exporter.js';
import { ClaudeCodeJsonlParser } from './trajectory/transcript-parsers/claude-code-jsonl.js';
import { CodexSessionParser } from './trajectory/transcript-parsers/codex-session.js';
import { GeminiSessionParser } from './trajectory/transcript-parsers/gemini-session.js';
import { CursorSqliteParser } from './trajectory/transcript-parsers/cursor-sqlite.js';
import type { TranscriptParser } from './trajectory/transcript-parsers/types.js';
import type { StopHookPayload, StopHookTool } from './api/stop-hook.js';
import { buildInfo } from './build-info.js';
import { BASE_FEEDS } from './venues/chainlink/feeds.js';
import { GeneratedTaskSource, StaticConfiguredTaskSource } from './tasks/sources.js';
import { checkRpcNetwork, logRpcLocalDevToStderr, rpcNetworkFailureHint } from './preflight/rpc-network.js';
import { apiPortFailureMessage, checkApiPortAvailable } from './preflight/api-port.js';
import { openBrowser } from './cli/open-browser.js';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

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
  config.rpcUrl = 'https://sepolia.base.org';
}
let activeClaudePath = config.claudePath ?? 'claude';
const selectClaudePath = (claudePath: string): void => {
  activeClaudePath = claudePath;
  config.claudePath = claudePath;
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

class EnsurePendingCaptureProcessor implements SpanProcessor {
  constructor(private readonly captures: CapturesStore) {}

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const sessionId = stringAttribute(span.attributes['jinn.session.id']);
    if (!sessionId || this.captures.getBySession(sessionId)) return;

    try {
      this.captures.savePending({
        sessionId,
        capturedAt: hrTimeToIso(span.startTime),
        originatingTool: { name: inferCaptureTool(span) },
        capturePath: 'A',
        status: 'pending',
        spanCount: 0,
        durationMs: 0,
        redactedSpanCount: 0,
        ...repoMetadataFromSpan(span),
      });
    } catch (err) {
      if (!this.captures.getBySession(sessionId)) throw err;
    }
  }
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function hrTimeToIso(time: ReadableSpan['startTime']): string {
  const millis = (time[0] * 1000) + Math.floor(time[1] / 1_000_000);
  return new Date(millis).toISOString();
}

function inferCaptureTool(span: ReadableSpan): string {
  return stringAttribute(span.attributes['transcript.tool'])
    ?? stringAttribute(span.resource.attributes['service.name'])
    ?? 'otel';
}

function repoMetadataFromSpan(span: ReadableSpan): { repoRemoteUrl?: string; repoCommitHash?: string } {
  const attrs = span.attributes;
  const repoRemoteUrl = stringAttribute(attrs['repo.remote_url'])
    ?? stringAttribute(attrs['vcs.repository.url'])
    ?? stringAttribute(attrs['git.remote_url']);
  const repoCommitHash = stringAttribute(attrs['repo.commit_hash'])
    ?? stringAttribute(attrs['vcs.ref.head.revision'])
    ?? stringAttribute(attrs['git.commit']);
  return {
    ...(repoRemoteUrl ? { repoRemoteUrl } : {}),
    ...(repoCommitHash ? { repoCommitHash } : {}),
  };
}

function parserForStopHookTool(tool: StopHookTool): TranscriptParser {
  switch (tool) {
    case 'claude-code':
      return new ClaudeCodeJsonlParser();
    case 'codex':
      return new CodexSessionParser();
    case 'gemini-cli':
      return new GeminiSessionParser();
    case 'cursor':
      return new CursorSqliteParser();
    default: {
      const exhaustive: never = tool;
      throw new Error(`No transcript parser for stop-hook tool: ${String(exhaustive)}`);
    }
  }
}

function ensurePendingStopHookCapture(
  captures: CapturesStore,
  payload: StopHookPayload,
): void {
  if (captures.getBySession(payload.sessionId)) return;
  try {
    captures.savePending({
      sessionId: payload.sessionId,
      capturedAt: payload.stoppedAt,
      originatingTool: { name: payload.tool },
      capturePath: 'D',
      status: 'pending',
      spanCount: 0,
      durationMs: 0,
      redactedSpanCount: 0,
    });
  } catch (err) {
    if (!captures.getBySession(payload.sessionId)) throw err;
  }
}

async function ingestStopHookCapture(
  captures: CapturesStore,
  receiver: Receiver | undefined,
  payload: StopHookPayload,
): Promise<void> {
  ensurePendingStopHookCapture(captures, payload);
  if (!payload.transcriptPath) return;
  if (!receiver) {
    console.warn('[main] stop-hook capture received but OTLP receiver is unavailable; pending capture has no transcript spans.');
    return;
  }

  const parser = parserForStopHookTool(payload.tool);
  let events;
  try {
    events = await parser.parseFull({ sessionId: payload.sessionId, path: payload.transcriptPath });
  } catch (err) {
    console.warn(
      `[main] stop-hook transcript import failed for ${payload.transcriptPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (events.length === 0) return;

  const provider = startSyntheticSpanProvider({
    otlpHttpEndpoint: `http://127.0.0.1:${receiver.httpPort}/v1/traces`,
  });
  try {
    for (const event of events) {
      emitSyntheticSpan(provider, { tool: parser.tool, sessionId: payload.sessionId, event });
    }
    await provider.flush();
  } finally {
    await provider.shutdown();
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
      details: {
        cause: result.message,
        // Preserve the raw underlying error so a misclassified summary can
        // be diagnosed without re-running with JINN_DEBUG. See jinn-mono-jz9f.
        ...(result.rawErrorMessage && result.rawErrorMessage !== result.message
          ? { rawErrorMessage: result.rawErrorMessage }
          : {}),
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

class SetupBootstrapHalted extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'SetupBootstrapHalted';
  }
}

const keepSetupUiOnBootstrapError = (): boolean =>
  process.env['JINN_NO_UI'] !== '1' && process.env['JINN_NO_DAEMON'] !== '1';

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

export async function main(): Promise<DaemonStartupInfo | SetupHaltedInfo | void> {
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
  const closeCaptureReceiver = async () => {
    const receiver = captureReceiver;
    captureReceiver = undefined;
    await receiver?.shutdown().catch(() => undefined);
  };
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
    () => import('./api/launcher-status.js').LauncherGeneratorStateSnapshot | undefined
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

  let setupApiServer: ApiServer;
  try {
    setupApiServer = await startApiServer({
      port: config.apiPort,
      store: sharedStore,
      apiToken,
      bindHost: apiBindHost,
      corpus: () => corpusForApi,
      ui: { token: uiToken, handshakeKey },
      admin: {
        onRestartRequested: () => {
          console.log('[main] Restart requested via operator MCP. Exiting...');
          process.exit(0);
        },
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
          solverNets: config.solverNets as Record<string, unknown> | undefined,
          joinedSolverNets: config.joinedSolverNets as Record<string, unknown> | undefined,
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
              compatibleHarnesses: [
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
        minEoaGasWei: (CHAIN_CONFIG.minEoaGasEth * 2n).toString(),
        claudePath: activeClaudePath,
        getClaudePath: () => activeClaudePath,
        configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
        defaultRpcUrlForChain: () => CHAIN_CONFIG.rpcUrl,
        onClaudePathSelected: selectClaudePath,
        onSolverNetsUpdated: (solverNets) => {
          config.solverNets = solverNets as typeof config.solverNets;
          // The prediction operator status is memoised per-`JinnConfig`
          // reference; mutating in place leaves the cache pointing at the
          // pre-edit snapshot. Drop the entry so the next /v1/status read
          // (and thus Overview's `solverNet.enabled` gating) reflects the
          // toggle immediately. (jinn-mono-l2zl.15.4.12)
          invalidatePredictionOperatorStatusCache(config);
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
        getConfig: () => ({ solverNets: config.solverNets }),
        configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
        // Cache-invalidation hook retained for the operator-mode
        // setup-endpoints flow; the launcher-mode PATCH route was retired
        // by Task 22, so this currently fires only when operator mode
        // mutates `solverNets`.
        onSolverNetsUpdated: (solverNets) => {
          config.solverNets = solverNets as typeof config.solverNets;
          invalidatePredictionOperatorStatusCache(config);
        },
        getGeneratorState: (netName) => {
          if (netName === 'prediction') {
            return predictionGeneratorRef?.getState();
          }
          const solverType = config.solverNets?.[netName]?.solverType;
          if (!solverType) return undefined;
          return launchedGeneratorStateBySolverType.get(solverType)?.();
        },
        getOpenTaskCount: (netName) => {
          const net = config.solverNets?.[netName];
          const solverType = net?.solverType;
          if (!solverType || !safeAddressForLauncher) return 0;
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
              taskCid: r.taskCid,
              solverType: r.solverType ?? undefined,
              postedAt: r.postedAt,
              ...(r.state ? { state: r.state } : {}),
              ...(r.claims ? { claims: r.claims } : {}),
            }));
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
    claudePath: activeClaudePath,
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
      await closeCaptureReceiver();
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
    if (err instanceof SetupBootstrapHalted) {
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        kind: 'setup_halted',
        pid: process.pid,
        network: config.network,
        phase: config.network === 'testnet' ? 'phase-1b' : 'phase-0',
        apiPort: setupApiServer.port,
        dashboardUrl: `http://127.0.0.1:${setupApiServer.port}`,
        error: err.envelope,
      };
    }
    // If bootstrap throws (vs. emitEnvelope-exits), tear down the API we
    // just started so we don't leave a dangling listener on the port.
    await setupApiServer.close().catch(() => undefined);
    await closeCaptureReceiver();
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

  const claudeAuthRequired = configRequiresClaudeAuth(config);
  if (claudeAuthRequired) {
    const preflight = await checkClaudeBinary(activeClaudePath);
    if (!preflight.ok) {
      emitClaudeBinaryPreflightFailure(preflight.detail, activeClaudePath);
    }

    const authContext = detectAuthContext({ cwd: process.cwd(), configuredMode: config.runtimeMode });
    const authProbe = probeClaudeAuth({
      context: authContext,
      cwd: process.cwd(),
      claudePath: activeClaudePath,
    });
    if (!authProbe.authenticated) {
      emitEnvelope({
        code: 'invalid_invocation',
        message: 'Claude is not authenticated. Complete Claude setup in the operator app, then restart the daemon.',
        hint: `Detected context: ${authContext}. Run \`jinn run\` to open the app-guided setup flow.`,
        exampleCli: 'jinn run',
        details: {
          field: 'claude_auth',
          context: authContext,
          authenticated: false,
        },
      });
    }
  } else {
    console.log('[main] Claude auth preflight skipped; Claude-backed harnesses are disabled.');
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
  const publicClient = createJinnPublicClient(config.rpcUrl, NETWORK_CHAIN);
  publicClientForLauncher = publicClient;
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

  const taskDiscoveryManifestCids = Object.values(config.joinedSolverNets ?? {})
    .filter((entry) => entry.roles.includes('solver'))
    .map((entry) => entry.manifestCid);

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
    taskDiscovery: taskDiscoveryManifestCids.length > 0
      ? {
          discoveryApi: sharedDiscoveryApi,
          solverNetManifestCids: taskDiscoveryManifestCids,
          onchainFromBlock: config.network === 'testnet' ? 41_153_291 : 25_000_000,
          ...(config.taskDiscoveryAllowedTaskIds?.length
            ? { allowedTaskIds: config.taskDiscoveryAllowedTaskIds }
            : {}),
        }
      : undefined,
  }, sharedStore);

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
    ...(process.env['JINN_POLYMARKET_GAMMA_BASE_URL']
      ? { polymarketGammaBaseUrl: process.env['JINN_POLYMARKET_GAMMA_BASE_URL'] }
      : {}),
    ...(process.env['JINN_POLYMARKET_CLOB_BASE_URL']
      ? { polymarketClobBaseUrl: process.env['JINN_POLYMARKET_CLOB_BASE_URL'] }
      : {}),
    externalImpls,
    disabledNames: config.harnesses?.disabled,
    corpusEnv,
  })) {
    implRegistry.register(impl);
  }

  console.log(`[main] HarnessRegistry: ${implRegistry.list().map(i => i.name).join(', ')}`);

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
        solverNetEndpointsDepsHolder.current = {
          store: solverNetStore,
          launch: {
            launchAction,
            lifecycleTransition,
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

  const taskSources = [
    new StaticConfiguredTaskSource(config.tasks),
    ...launchedRecordGenerators.map(({ solverType, generator }, idx) =>
      new GeneratedTaskSource(`launched:${solverType}:${idx}`, generator),
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
      config,
      configPath: CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
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
      // Spec §14, Task 28: per-launch claim eligibility filter. Operators
      // populate `joinedSolverNets[<manifestCid>]` via the SPA's join flow;
      // the engine refuses tasks whose `manifestDigest = keccak256(cid)`
      // doesn't match a joined entry (plus a role gate). Absent when the
      // operator hasn't joined any nets yet — the engine then falls back to
      // the legacy solverType-keyed gate.
      ...(config.joinedSolverNets
        ? { joinedSolverNets: joinedSolverNetsViewFromConfig(config.joinedSolverNets) }
        : {}),
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
      harnessMode: config.harness.mode,
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

  // Graceful shutdown — Daemon doesn't own the API server or Store in this
  // flow (they were created in setup-mode before bootstrap), so we close
  // them explicitly after Daemon.stop() completes.
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (signal: string) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let exitCode = 0;
      console.log(`\n[main] Received ${signal}, shutting down...`);
      try {
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
