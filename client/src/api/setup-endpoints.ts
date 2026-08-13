/**
 * Panel-driven setup endpoints.
 *
 *   GET  /v1/auth/claude            — probe whether the user's claude binary is
 *                                      authenticated. Wraps the existing preflight.
 *   POST /v1/setup/change-password  — rotate the keystore password and update the
 *                                      persisted password file.
 *
 * Mounted under requireUiToken; localhost binding + token preserves the
 * never-leaves-localhost contract.
 *
 * Note 1: keystore creation is owned by the daemon (main.ts auto-generates
 * a password and runs `jinn init` if no keystore is found). The panel
 * observes that flow via /v1/bootstrap; it does not drive it.
 *
 * Note 2: there is no `/v1/auth/claude/login` endpoint. claude sign-in
 * happens automatically through the embedded agent session — the wizard
 * is auto-dismissed and the OAuth URL is opened in a new tab via the
 * agent WS bridge (see agent-ws.ts). The operator just completes sign-in
 * in the tab that opens.
 */
import type { Hono } from 'hono';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod/v3';
import { stage1MinMasterEth } from '../earning/bootstrap.js';
import { getChainConfig } from '../earning/contracts.js';
import { FleetStateStore } from '../earning/store.js';
import { decryptMnemonic, encryptMnemonic } from '../earning/wallet.js';
import {
  DEFAULT_FAUCET_LOOP_TIMEOUT_MS,
  computeFaucetDripCap,
  requestTestnetFunding,
} from '../earning/faucet.js';
import {
  computeTopupQuota,
  readFaucetTopupState,
  writeFaucetTopupRecord,
} from '../earning/faucet-topup-store.js';
import { createJinnPublicClient, type JinnOnchainNetwork } from '../earning/viem-clients.js';
import { detectAuthContext, probeClaudeAuth } from '../preflight/claude-auth.js';
import { checkClaudeBinary, type ClaudeBinaryCheckResult } from '../preflight/claude-binary.js';
import { triggerAgentSpawn } from '../agent/agent-ws.js';
import { DEFAULT_CONFIG_PATH, persistTopLevelConfigValue } from '../config.js';
import { canonicalHarnessName } from '../harnesses/names.js';
import {
  installClaudeCodeLocally,
  type ExecFileAsync,
} from '../setup/claude-code-install.js';
import { addSetupRetryEndpoint } from './setup-retry-endpoint.js';
import { onboardingCompleteIntent } from '../intents/onboarding-complete.js';
import { maskUrlsInMessage } from '../rpc/transport.js';
import { markRestartRequired } from './restart-required-state.js';

const ChangePasswordSchema = z.object({
  current: z.string().min(1),
  next: z.string().min(8),
});

/**
 * Turn a caught error into a string, masking any embedded RPC URL (spec
 * §14.2 item 2, issue #2402). Applied uniformly across this file's catch
 * blocks — most aren't RPC-derived (config read/write, keystore ops, Claude
 * binary checks), but masking is a safe no-op when there's no URL to find,
 * and `/v1/setup/drip`'s catch (this file's one genuinely RPC-adjacent site,
 * downstream of `publicClient.getBalance()`) needs it for real.
 */
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error); // lint:no-error-leak-allow — sole raw-message read; masked on the next line
  return maskUrlsInMessage(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export interface SetupRoutesConfig {
  earningDir?: string;
  chain?: JinnOnchainNetwork;
  rpcUrl?: string;
  minEoaGasWei?: string;
  /**
   * Pass through from JinnConfig.targetServices so the faucet drip target
   * scales with multi-service deployments. Defaults to 1 (testnet operators).
   */
  targetServices?: number;
  claudePath?: string;
  getClaudePath?: () => string;
  runtimeMode?: 'bare' | 'docker-compose' | 'container';
  configPath?: string;
  claudeInstallRoot?: string;
  checkClaudeBinary?: typeof checkClaudeBinary;
  probeClaudeAuth?: typeof probeClaudeAuth;
  execFileAsync?: ExecFileAsync;
  persistConfigValue?: typeof persistTopLevelConfigValue;
  onClaudePathSelected?: (claudePath: string) => void;
  onSolverNetsUpdated?: (solverNets: Record<string, Record<string, unknown>>) => void;
  requestFunding?: typeof requestTestnetFunding;
  /**
   * Injectable balance reader — defaults to a live `publicClient.getBalance`
   * closure. Tests pass a spy/stub to drive the drip loop without an RPC and
   * to assert the read cadence (issue #984 work unit 1).
   */
  getBalance?: () => Promise<bigint | null>;
  maxFaucetIters?: number;
  interDripPauseMs?: number;
  /**
   * Issue #560 — batched daily-cap top-up. `faucetDailyTopupCap` is how many
   * faucet drips one operator "Top up from faucet" click may issue in a batch
   * (and the per-24h ceiling per wallet); `faucetTopupCooldownMs` is how long
   * the action stays disabled after the cap is reached. Defaults applied in the
   * handler (10 / 24h) so existing callers / tests need not set them.
   */
  faucetDailyTopupCap?: number;
  faucetTopupCooldownMs?: number;
  /**
   * Backoff before retrying a transient CDP faucet 429 (issue #984). Defaults
   * to RATE_LIMIT_BACKOFF_MS (15000 ms); tests pass 0 to skip the sleep.
   * Independent of `interDripPauseMs` — mirrors `bootstrap.ts`'s
   * `faucetRateLimitBackoffMs`.
   */
  faucetRateLimitBackoffMs?: number;
  /** Wall-clock cutoff for the drip loop; reaching target/rate-limit still wins first. */
  faucetLoopTimeoutMs?: number;
  /** Now-source override for deterministic faucet-loop tests. */
  now?: () => number;
  /** Returns the chain default RPC URL — used by POST /v1/setup/network when
   *  the operator clears the field to revert to the default. */
  defaultRpcUrlForChain?: () => string;
  /** #913: returns the chain's bundled public RPC fallback chain. The network
   *  endpoint persists `[primary, ...defaults]` (or `[...defaults]` when the
   *  primary is cleared) so the operator never loses the public backup chain. */
  defaultRpcUrlsForChain?: () => readonly string[];
  /**
   * When set, POST /v1/setup/bootstrap/retry is enabled.
   * Re-enters the bootstrap state machine in-process — no daemon restart
   * required. The closure signals main()'s halt-and-resume loop to call
   * bootstrap() again. jinn-mono-hjex.6
   */
  retryBootstrap?: () => Promise<void>;
  /**
   * #983: called after POST /v1/operator/onboarding-complete persists the flag
   * to disk, so the daemon's in-memory config reflects it and GET /v1/bootstrap
   * (which reads the in-memory config) returns onboardingComplete:true without
   * a restart.
   */
  markOnboardingComplete?: () => void;
}

export function addSetupRoutes(app: Hono, config: SetupRoutesConfig = {}): void {
  const checkBinary = config.checkClaudeBinary ?? checkClaudeBinary;
  const probeAuth = config.probeClaudeAuth ?? probeClaudeAuth;
  const persistConfigValue = config.persistConfigValue ?? persistTopLevelConfigValue;
  const currentClaudePath = (): string => config.getClaudePath?.() ?? config.claudePath ?? 'claude';
  let installInFlight: Promise<InstallClaudeCodeResponse> | null = null;
  // Issue #560 H1: per-address guard so two concurrent batch POSTs for the
  // same wallet can't both read `callsRemaining` before either persists and
  // run up to 2 × dailyCap drips. Mirrors the `installInFlight` dedupe idiom.
  const batchDripInFlight = new Set<string>();

  const resolveEarningDir = (): string =>
    config.earningDir ??
    process.env['JINN_EARNING_DIR'] ??
    join(process.env['HOME'] ?? homedir(), '.jinn-client', 'earning');

  // Issue #560 batched-topup defaults. Resolved once so the POST /drip batch
  // branch and GET /drip/quota route can't drift. Production callers always
  // pass these (JinnConfig schema defaults); the `??` covers tests that build
  // addSetupRoutes directly.
  const faucetDailyTopupCap = config.faucetDailyTopupCap ?? 10;
  const faucetTopupCooldownMs = config.faucetTopupCooldownMs ?? 24 * 60 * 60 * 1000;

  /**
   * Shared master-address + chain resolution for the faucet drip + quota
   * routes. Returns either the resolved address/earningDir/chain or a ready
   * `{ error, status }` envelope for the caller to return verbatim.
   */
  const resolveFaucetTarget = ():
    | { ok: true; address: string; earningDir: string; chain: string | undefined }
    | { ok: false; body: Record<string, unknown>; status: 404 | 500 } => {
    const earningDir = resolveEarningDir();
    const statePath = join(earningDir, 'earning_state.json');
    if (!existsSync(statePath)) {
      return { ok: false, body: { ok: false, reason: 'fleet_state_missing' }, status: 404 };
    }
    let parsed: { master_address?: string; chain?: string };
    try {
      parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as {
        master_address?: string;
        chain?: string;
      };
    } catch {
      return { ok: false, body: { ok: false, reason: 'fleet_state_unreadable' }, status: 500 };
    }
    const address = parsed.master_address;
    if (!address) {
      return { ok: false, body: { ok: false, reason: 'master_address_missing' }, status: 404 };
    }
    return { ok: true, address, earningDir, chain: config.chain ?? parsed.chain };
  };

  app.get('/v1/auth/claude', async (c) => {
    const cwd = process.cwd();
    const context = detectAuthContext({ cwd, configuredMode: config.runtimeMode });
    const claudePath = currentClaudePath();
    const binary = await checkBinary(claudePath);
    if (!binary.ok) {
      return c.json({
        schemaVersion: 1,
        authenticated: false,
        context,
        detail: binary.detail,
        binary,
      });
    }
    const probe = probeAuth({ context, cwd, claudePath });
    return c.json({
      schemaVersion: 1,
      authenticated: probe.authenticated,
      context,
      detail: probe.detail,
      binary,
      ...(probe.email !== undefined ? { email: probe.email } : {}),
    });
  });

  // POST /v1/auth/claude/spawn — operator clicked Phase 1 Sign-in. Allows
  // the daemon to spawn its embedded claude session (which then auto-walks
  // the wizard and emits an auth_url WS frame to the SPA). For returning
  // operators the daemon already detects auth at startup and pre-allows
  // spawn; this endpoint is the manual gate-opener for fresh installs.
  app.post('/v1/auth/claude/spawn', async (c) => {
    const result = await triggerAgentSpawn();
    return c.json(result, result.ok ? 202 : 500);
  });

  app.post('/v1/setup/claude/install', async (c) => {
    if (!installInFlight) {
      installInFlight = installClaudeCodeForOperator({
        configuredClaudePath: currentClaudePath(),
        configPath: config.configPath,
        installRoot: config.claudeInstallRoot,
        checkBinary,
        execFileAsync: config.execFileAsync,
        persistConfigValue,
        onClaudePathSelected: config.onClaudePathSelected,
      }).finally(() => {
        installInFlight = null;
      });
    }
    const result = await installInFlight;
    return c.json(result, result.ok ? 202 : 500);
  });

  // POST /v1/setup/drip — user-triggered Base Sepolia faucet funding for the
  // master EOA. By default ("?singleDrip" absent) one click drains the tiny
  // CDP drip repeatedly until the wallet reaches the bootstrap floor, the
  // faucet rate-limits, or the safety cap is hit — this is the bootstrap
  // funding gate (AwaitingFundingCard). With `?singleDrip=true` the endpoint
  // fires the faucet EXACTLY ONCE and returns immediately with txHash +
  // deltaWei — this is the running-mode Dashboard "Top up" button, which must
  // require an explicit click and never auto-fire (jinn-mono #336). Mainnet
  // rejects.
  app.post('/v1/setup/drip', async (c) => {
    const singleDrip = c.req.query('singleDrip') === 'true';
    // Issue #560: `?batch=true` issues drips up to the daily cap in one click.
    // If both batch and singleDrip are present, singleDrip wins (decided).
    const batch = c.req.query('batch') === 'true' && !singleDrip;
    const resolved = resolveFaucetTarget();
    if (!resolved.ok) {
      return c.json(resolved.body, resolved.status);
    }
    const { address, earningDir, chain } = resolved;
    if (chain !== 'base-sepolia') {
      return c.json(
        { ok: false, reason: 'drip_only_on_base_sepolia', chain },
        409,
      );
    }

    const requestFunding = config.requestFunding ?? requestTestnetFunding;
    const interDripPauseMs = config.interDripPauseMs ?? 1_000;
    // Faucet drip target. Single source of truth: stage1MinMasterEth(chain
    // config, targetServices), which is also what FleetBootstrapper.ensureStage1
    // gates on (jinn-mono-u34i). The faucet drips master ETH until it can
    // complete the ENTIRE bootstrap — operator gets one drip session, not one
    // per stage. The optional `config.minEoaGasWei` override is for tests
    // that want a custom target; production callers should NOT pass it.
    // `config.targetServices` is also for tests / multi-service deployments;
    // defaults to 1 (the testnet faucet's audience).
    const targetWei = config.minEoaGasWei
      ? BigInt(config.minEoaGasWei)
      : stage1MinMasterEth(getChainConfig(chain), config.targetServices ?? 1);
    const publicClient = config.rpcUrl
      ? createJinnPublicClient(config.rpcUrl, 'base-sepolia')
      : null;
    const now = config.now ?? Date.now;
    const faucetLoopTimeoutMs = config.faucetLoopTimeoutMs ?? DEFAULT_FAUCET_LOOP_TIMEOUT_MS;

    const getBalance =
      config.getBalance ??
      (async (): Promise<bigint | null> => {
        if (!publicClient) return null;
        return publicClient.getBalance({ address: address as `0x${string}` });
      });
    const persistFundingGate = (balanceWei: bigint | null): void => {
      if (targetWei === null || balanceWei === null) return;
      const requiredWei = balanceWei >= targetWei ? 0n : targetWei - balanceWei;
      writeFileSync(
        join(earningDir, 'bootstrap-funding.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          master_address: address,
          eth_required: requiredWei.toString(),
          eth_balance: balanceWei.toString(),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
    };

    try {
      const txHashes: string[] = [];
      let balanceWei = await getBalance();
      persistFundingGate(balanceWei);
      if (targetWei !== null && balanceWei !== null && balanceWei >= targetWei) {
        return c.json({
          ok: true,
          address,
          txHashes,
          attempts: 0,
          balanceWei: balanceWei.toString(),
          targetWei: targetWei.toString(),
        });
      }

      // Single-drip mode (jinn-mono #336): the running-mode Dashboard "Top up"
      // button must fire the faucet EXACTLY ONCE per click — never loop. The
      // multi-drip loop below is for the one-time bootstrap funding gate
      // (AwaitingFundingCard), where the wallet has to clear the entire
      // bootstrap floor. On the running dashboard the operator just wants a
      // single, explicit top-up they can see confirmed (amount + tx hash).
      if (singleDrip) {
        const balanceBefore = balanceWei;
        const result = await requestFunding(address, 'base-sepolia');
        if (!result.ok) {
          return c.json(
            {
              ok: false,
              address,
              txHashes,
              // One funding attempt was made (requestFunding ran once above),
              // even though it failed — report 1 to stay consistent with the
              // success path's `attempts: txHashes.length`.
              attempts: 1,
              balanceWei: balanceWei?.toString(),
              targetWei: targetWei?.toString(),
              reason: result.reason,
              rateLimited: result.rateLimited,
            },
            200,
          );
        }
        if (result.txHash) txHashes.push(result.txHash);
        balanceWei = await getBalance();
        persistFundingGate(balanceWei);
        const deltaWei =
          balanceBefore !== null && balanceWei !== null && balanceWei > balanceBefore
            ? balanceWei - balanceBefore
            : null;
        return c.json(
          {
            ok: txHashes.length > 0,
            address,
            txHash: result.txHash,
            txHashes,
            attempts: txHashes.length,
            balanceWei: balanceWei?.toString(),
            targetWei: targetWei?.toString(),
            deltaWei: deltaWei !== null ? deltaWei.toString() : undefined,
            reason: txHashes.length > 0 ? undefined : 'faucet_did_not_send',
          },
          txHashes.length > 0 ? 202 : 200,
        );
      }

      // Batched daily-cap top-up (issue #560). The running-mode Dashboard "Top
      // up from faucet" button issues drips up to the per-wallet daily cap in
      // ONE click, then disables itself until a cooldown elapses since the
      // first call of that batch. State persists per master address so the cap
      // survives a restart. Distinct from the bootstrap loop below (which
      // chases the Stage-1 ETH target); this branch caps by COUNT, not balance.
      if (batch) {
        const lockKey = address.toLowerCase();
        // H1: reject a concurrent batch for the same wallet rather than letting
        // both read `callsRemaining` and double-spend the cap. The lock is
        // released in the `finally` below.
        if (batchDripInFlight.has(lockKey)) {
          return c.json({ ok: false, address, reason: 'batch_in_progress' }, 409);
        }
        batchDripInFlight.add(lockKey);
        try {
          const dailyCap = faucetDailyTopupCap;
          const cooldownMs = faucetTopupCooldownMs;
          const nowMs = now();
          const existing = readFaucetTopupState(earningDir).byAddress[address.toLowerCase()];
          const quota = computeTopupQuota({ record: existing, dailyCap, cooldownMs, now: nowMs });

          // Cap reached and the window is still active → cooldown; do not call
          // the faucet.
          if (quota.callsRemaining === 0) {
            return c.json(
              {
                ok: false,
                address,
                reason: 'topup_cooldown',
                dailyCap,
                callsRemaining: 0,
                cooldownExpiresAt: quota.cooldownExpiresAt,
              },
              200,
            );
          }

          // Window elapsed (or no record) → fresh batch starting now. Otherwise
          // continue the active batch from its recorded start.
          const startingFresh = !quota.windowActive;
          let callsToday = startingFresh ? 0 : existing?.callsToday ?? 0;
          const batchStartedAt = startingFresh ? nowMs : existing?.batchStartedAt ?? nowMs;

          let rateLimited = false;
          for (let i = 0; i < quota.callsRemaining; i++) {
            const result = await requestFunding(address, 'base-sepolia');
            if (!result.ok) {
              // A rate-limit stops the batch but is not an error (operator can
              // retry after the CDP per-address window). Any other failure also
              // stops the batch and surfaces its reason.
              if (result.rateLimited) rateLimited = true;
              if (txHashes.length === 0) {
                return c.json(
                  {
                    ok: false,
                    address,
                    txHashes,
                    attempts: 0,
                    dailyCap,
                    callsRemaining: dailyCap - callsToday,
                    cooldownExpiresAt: batchStartedAt + cooldownMs,
                    reason: result.reason,
                    rateLimited: result.rateLimited,
                  },
                  200,
                );
              }
              break;
            }
            if (result.txHash) txHashes.push(result.txHash);
            callsToday += 1;
            // Persist write-through after each success so a crash mid-batch does
            // not re-grant the whole cap.
            writeFaucetTopupRecord(earningDir, address, { callsToday, batchStartedAt });
          }

          return c.json(
            {
              ok: txHashes.length > 0,
              address,
              txHashes,
              attempts: txHashes.length,
              dailyCap,
              callsRemaining: Math.max(0, dailyCap - callsToday),
              cooldownExpiresAt: batchStartedAt + cooldownMs,
              ...(rateLimited ? { rateLimited: true } : {}),
            },
            txHashes.length > 0 ? 202 : 200,
          );
        } finally {
          batchDripInFlight.delete(lockKey);
        }
      }

      const maxFaucetIters = computeFaucetDripCap({
        override: config.maxFaucetIters,
        targetWei,
        balanceWei,
      });
      const deadline = now() + faucetLoopTimeoutMs;
      // requestFunding returns synchronously with a txHash and there is no
      // on-chain confirmation to wait for between drips, so the happy path
      // carries NO fixed inter-drip sleep (issue #984 work unit 1). A transient
      // CDP 429 backs off and retries within the session instead of ending it
      // on the first throttle; the wall-clock deadline stays the safety rail.
      // Backoff is skippable in tests by passing faucetRateLimitBackoffMs: 0.
      const MAX_RATE_LIMIT_RETRIES = 3;
      const RATE_LIMIT_BACKOFF_MS = 15_000;
      const rateLimitBackoffMs = config.faucetRateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS;
      let rateLimitRetries = 0;
      for (let i = 0; i < maxFaucetIters; i++) {
        if (now() >= deadline) {
          return c.json(
            {
              ok: txHashes.length > 0,
              address,
              txHash: txHashes.at(-1),
              txHashes,
              attempts: i,
              balanceWei: balanceWei?.toString(),
              targetWei: targetWei?.toString(),
              reason: 'faucet_loop_timeout',
            },
            txHashes.length > 0 ? 202 : 200,
          );
        }
        const result = await requestFunding(address, 'base-sepolia');
        if (!result.ok) {
          if (result.rateLimited && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
            rateLimitRetries++;
            await new Promise((r) => setTimeout(r, rateLimitBackoffMs));
            continue;
          }
          return c.json(
            {
              ok: false,
              address,
              txHash: txHashes.at(-1),
              txHashes,
              attempts: i,
              balanceWei: balanceWei?.toString(),
              targetWei: targetWei?.toString(),
              reason: result.reason,
              rateLimited: result.rateLimited,
            },
            200,
          );
        }
        if (result.txHash) txHashes.push(result.txHash);
        // Balance is no longer read once per drip — only every 5th drip and on
        // the final iteration. Target/early-exit is only checked on iterations
        // where balance was just refreshed.
        const refreshBalance = (i + 1) % 5 === 0 || i === maxFaucetIters - 1;
        if (refreshBalance) {
          balanceWei = await getBalance();
          persistFundingGate(balanceWei);
          if (targetWei !== null && balanceWei !== null && balanceWei >= targetWei) {
            return c.json(
              {
                ok: true,
                address,
                txHash: result.txHash,
                txHashes,
                attempts: i + 1,
                balanceWei: balanceWei.toString(),
                targetWei: targetWei.toString(),
              },
              202,
            );
          }
        }
      }

      return c.json(
        {
          ok: txHashes.length > 0,
          address,
          txHash: txHashes.at(-1),
          txHashes,
          attempts: txHashes.length,
          balanceWei: balanceWei?.toString(),
          targetWei: targetWei?.toString(),
          reason: txHashes.length > 0 ? undefined : 'faucet_did_not_send',
        },
        txHashes.length > 0 ? 202 : 200,
      );
    } catch (err) {
      return c.json(
        {
          ok: false,
          reason: errorMessage(err),
        },
        500,
      );
    }
  });

  // GET /v1/setup/drip/quota — issue #560. Reports the operator's remaining
  // batched top-up quota for today and the cooldown expiry, so the WalletCard
  // can render "{n} of {cap} top-ups left today" and disable the button when
  // the cap is reached. Soft-renders the full cap when no fleet state exists
  // yet (pre-bootstrap SPA) so the card still has something to show.
  app.get('/v1/setup/drip/quota', async (c) => {
    const dailyCap = faucetDailyTopupCap;
    const cooldownMs = faucetTopupCooldownMs;
    const now = config.now ?? Date.now;

    const resolved = resolveFaucetTarget();
    if (!resolved.ok) {
      // Pre-bootstrap (no fleet state / no master address): soft-render the
      // full cap so the SPA can render the card before the wallet exists.
      return c.json({ ok: true, dailyCap, callsRemaining: dailyCap, cooldownExpiresAt: null });
    }
    const { address, earningDir, chain } = resolved;
    if (chain !== 'base-sepolia') {
      return c.json({ ok: false, reason: 'drip_only_on_base_sepolia', chain }, 409);
    }

    const record = readFaucetTopupState(earningDir).byAddress[address.toLowerCase()];
    const quota = computeTopupQuota({ record, dailyCap, cooldownMs, now: now() });
    return c.json({
      ok: true,
      address,
      dailyCap,
      callsRemaining: quota.callsRemaining,
      cooldownExpiresAt: quota.cooldownExpiresAt,
    });
  });

  // POST /v1/operator/onboarding-complete — #983. The operator clicked
  // "Enter dashboard" at the end of the guided onboarding takeover (gated SPA-
  // side on ≥1 join AND a ready solver harness AND a selected model). Persists
  // the flag to disk and mutates the in-memory config so GET /v1/bootstrap
  // reflects it live; App.tsx then drops the takeover for <Operating>.
  //
  // Thin front-end over `intents/onboarding-complete.ts` per spec §4.1/§11 —
  // the CLI verb (`cli/commands/onboarding-complete.ts`) is the other
  // front-end, running the same intent standalone (see that module's
  // docstring for why it can, unlike bootstrap-retry).
  app.post('/v1/operator/onboarding-complete', async (c) => {
    const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;
    const result = await onboardingCompleteIntent({
      configPath: cfgPath,
      persistConfigValue,
      markOnboardingComplete: config.markOnboardingComplete,
    });
    if (!result.ok) {
      // errorMessage() keeps #2402's masking on this path across the intent
      // refactor — the intent's error string is produced outside this file's
      // choke point.
      return c.json({ error: 'config_write_failed', detail: errorMessage(result.error) }, 500);
    }
    return c.json({ ok: true, onboardingComplete: true });
  });

  // Edit the chain's RPC URL from the SPA's Configuration > Network section.
  // Chain itself is read-only here; switching chains is a separate flow.
  // Empty / null rpcUrl reverts to the chain's bundled default.
  app.post('/v1/setup/network', async (c) => {
    let body: { rpcUrl?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', detail: 'expected JSON body' }, 400);
    }

    // `persistConfigValue` (calling `persistTopLevelConfigValue` in
    // config.ts) creates the parent dir + file when missing — same pattern
    // as every other write path in this module. The pre-u34i version 404'd
    // here on missing config.json, which broke fresh operators (who don't
    // have config.json yet, since the daemon happily runs with defaults)
    // from changing their RPC via the panel: the only operator-app affordance
    // for switching off a rate-limited public RPC. Operator-never-leaves-the-app
    // principle. See jinn-mono-u34i.
    const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;

    const publicDefaults: readonly string[] =
      config.defaultRpcUrlsForChain?.() ??
      (config.defaultRpcUrlForChain
        ? [config.defaultRpcUrlForChain()]
        : ['https://base-sepolia.publicnode.com', 'https://sepolia.base.org']);

    let nextRpcUrls: string[];
    if (body.rpcUrl === null || body.rpcUrl === '') {
      nextRpcUrls = [...publicDefaults];
    } else if (typeof body.rpcUrl === 'string') {
      try {
        const parsed = new URL(body.rpcUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return c.json({ error: 'invalid_body', detail: '`rpcUrl` must use http or https' }, 400);
        }
      } catch {
        return c.json({ error: 'invalid_body', detail: '`rpcUrl` is not a valid URL' }, 400);
      }
      // De-dupe: if the operator pastes a URL that is already the first public
      // default, don't double it — the input drives a single Primary slot.
      nextRpcUrls = publicDefaults[0] === body.rpcUrl
        ? [...publicDefaults]
        : [body.rpcUrl, ...publicDefaults];
    } else {
      return c.json({ error: 'invalid_body', detail: '`rpcUrl` must be a string or null' }, 400);
    }

    try {
      persistConfigValue('rpcUrl', nextRpcUrls, cfgPath);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: errorMessage(err),
      }, 500);
    }

    // No hot-apply path for the RPC URL — always restart-required. See
    // restart-required-state.ts (issue #2408 review F1).
    markRestartRequired();
    return c.json({
      ok: true,
      restartRequired: true,
      rpcUrl: nextRpcUrls,
    });
  });

  // POST /v1/setup/bootstrap/retry — re-enter the bootstrap state machine
  // in-process. jinn-mono-hjex.6
  if (config.retryBootstrap) {
    addSetupRetryEndpoint(app, { retryBootstrap: config.retryBootstrap });
  }

  app.post('/v1/setup/change-password', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid_request', details: parsed.error.format() },
        400,
      );
    }

    const earningDir =
      process.env['JINN_EARNING_DIR'] ??
      join(process.env['HOME'] ?? homedir(), '.jinn-client', 'earning');
    const store = new FleetStateStore(earningDir);

    if (!store.hasMnemonicKeystore() && !store.hasLegacyKeystore()) {
      return c.json({ error: 'no_keystore' }, 404);
    }

    let mnemonic: string;
    try {
      const ks = await store.loadMnemonicKeystore();
      mnemonic = await decryptMnemonic(ks, parsed.data.current);
    } catch {
      return c.json({ error: 'invalid_current_password' }, 401);
    }

    try {
      const reencrypted = await encryptMnemonic(mnemonic, parsed.data.next);
      await store.saveMnemonicKeystore(reencrypted);

      // Also update the persisted password file so subsequent `jinn run`
      // invocations pick up the new password seamlessly.
      const home = process.env['HOME'] ?? homedir();
      const pwFilePath = join(home, '.jinn-client', 'keystore-password');
      mkdirSync(dirname(pwFilePath), { recursive: true, mode: 0o700 });
      writeFileSync(pwFilePath, parsed.data.next + '\n', { mode: 0o600 });

      // Mirror into env so the running daemon's in-memory PASSWORD stays valid
      // for the rest of this process lifetime (relevant for sub-command spawns).
      process.env['JINN_PASSWORD'] = parsed.data.next;

      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        {
          error: 'change_failed',
          message: errorMessage(err),
        },
        500,
      );
    }
  });
}

export interface InstallClaudeCodeResponse {
  ok: boolean;
  status: 'already_present' | 'installed' | 'install_failed';
  detail: string;
  binary?: ClaudeBinaryCheckResult;
}

interface InstallClaudeCodeForOperatorOptions {
  configuredClaudePath: string;
  configPath?: string;
  installRoot?: string;
  checkBinary: typeof checkClaudeBinary;
  execFileAsync?: ExecFileAsync;
  persistConfigValue: typeof persistTopLevelConfigValue;
  onClaudePathSelected?: (claudePath: string) => void;
}

async function persistSelectedClaudePath(
  claudePath: string,
  opts: Pick<InstallClaudeCodeForOperatorOptions, 'configPath' | 'persistConfigValue' | 'onClaudePathSelected'>,
): Promise<void> {
  opts.persistConfigValue('claudePath', claudePath, opts.configPath ?? DEFAULT_CONFIG_PATH);
  opts.onClaudePathSelected?.(claudePath);
}

async function installClaudeCodeForOperator(
  opts: InstallClaudeCodeForOperatorOptions,
): Promise<InstallClaudeCodeResponse> {
  const configured = await opts.checkBinary(opts.configuredClaudePath);
  if (configured.ok) {
    return {
      ok: true,
      status: 'already_present',
      detail: 'Claude Code is already available',
      binary: configured,
    };
  }

  const onPath = opts.configuredClaudePath === 'claude'
    ? configured
    : await opts.checkBinary('claude');
  if (onPath.ok) {
    try {
      await persistSelectedClaudePath('claude', opts);
    } catch (err) {
      return {
        ok: false,
        status: 'install_failed',
        detail: `Claude Code is on PATH, but Jinn could not save that setting: ${errorMessage(err)}`,
        binary: onPath,
      };
    }
    return {
      ok: true,
      status: 'already_present',
      detail: 'Claude Code is already available on PATH',
      binary: onPath,
    };
  }

  const installed = await installClaudeCodeLocally({
    installRoot: opts.installRoot,
    execFileAsync: opts.execFileAsync,
  });
  if (!installed.ok || !installed.claudePath) {
    return { ok: false, status: 'install_failed', detail: installed.detail };
  }

  const binary = await opts.checkBinary(installed.claudePath);
  if (!binary.ok) {
    return {
      ok: false,
      status: 'install_failed',
      detail: binary.detail,
      binary,
    };
  }

  try {
    await persistSelectedClaudePath(installed.claudePath, opts);
  } catch (err) {
    return {
      ok: false,
      status: 'install_failed',
      detail: `Claude Code installed, but Jinn could not save that setting: ${errorMessage(err)}`,
      binary,
    };
  }

  return {
    ok: true,
    status: 'installed',
    detail: 'Claude Code installed',
    binary,
  };
}
