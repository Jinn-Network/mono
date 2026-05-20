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
import { z } from 'zod';
import { stage1MinMasterEth } from '../earning/bootstrap.js';
import { getChainConfig } from '../earning/contracts.js';
import { FleetStateStore } from '../earning/store.js';
import { decryptMnemonic, encryptMnemonic } from '../earning/wallet.js';
import {
  DEFAULT_FAUCET_LOOP_TIMEOUT_MS,
  computeFaucetDripCap,
  requestTestnetFunding,
} from '../earning/faucet.js';
import { createJinnPublicClient, type JinnOnchainNetwork } from '../earning/viem-clients.js';
import { detectAuthContext, probeClaudeAuth } from '../preflight/claude-auth.js';
import { checkClaudeBinary, type ClaudeBinaryCheckResult } from '../preflight/claude-binary.js';
import { triggerAgentSpawn } from '../agent/agent-ws.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_SOLVER_NETS, persistTopLevelConfigValue } from '../config.js';
import { canonicalHarnessName } from '../harnesses/names.js';
import {
  installClaudeCodeLocally,
  type ExecFileAsync,
} from '../setup/claude-code-install.js';
import { addSetupRetryEndpoint } from './setup-retry-endpoint.js';

const ChangePasswordSchema = z.object({
  current: z.string().min(1),
  next: z.string().min(8),
});

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
  maxFaucetIters?: number;
  interDripPauseMs?: number;
  /** Wall-clock cutoff for the drip loop; reaching target/rate-limit still wins first. */
  faucetLoopTimeoutMs?: number;
  /** Now-source override for deterministic faucet-loop tests. */
  now?: () => number;
  /** Returns the chain default RPC URL — used by POST /v1/setup/network when
   *  the operator clears the field to revert to the default. */
  defaultRpcUrlForChain?: () => string;
  /**
   * When set, POST /v1/setup/restake/:serviceId is enabled.
   * Calls the provided function to re-stake an evicted service on demand
   * (the "Re-stake now" dashboard CTA). jinn-mono-hjex.3
   */
  restake?: (serviceId: number) => Promise<{ ok: boolean; error?: string }>;
  /**
   * When set, POST /v1/setup/bootstrap/retry is enabled.
   * Re-enters the bootstrap state machine in-process — no daemon restart
   * required. The closure signals main()'s halt-and-resume loop to call
   * bootstrap() again. jinn-mono-hjex.6
   */
  retryBootstrap?: () => Promise<void>;
}

export function addSetupRoutes(app: Hono, config: SetupRoutesConfig = {}): void {
  const checkBinary = config.checkClaudeBinary ?? checkClaudeBinary;
  const probeAuth = config.probeClaudeAuth ?? probeClaudeAuth;
  const persistConfigValue = config.persistConfigValue ?? persistTopLevelConfigValue;
  const currentClaudePath = (): string => config.getClaudePath?.() ?? config.claudePath ?? 'claude';
  let installInFlight: Promise<InstallClaudeCodeResponse> | null = null;

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
    const earningDir =
      config.earningDir ??
      process.env['JINN_EARNING_DIR'] ??
      join(process.env['HOME'] ?? homedir(), '.jinn-client', 'earning');
    const statePath = join(earningDir, 'earning_state.json');
    if (!existsSync(statePath)) {
      return c.json({ ok: false, reason: 'fleet_state_missing' }, 404);
    }
    let parsed: { master_address?: string; chain?: string };
    try {
      parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as {
        master_address?: string;
        chain?: string;
      };
    } catch {
      return c.json({ ok: false, reason: 'fleet_state_unreadable' }, 500);
    }
    const address = parsed.master_address;
    if (!address) {
      return c.json({ ok: false, reason: 'master_address_missing' }, 404);
    }
    const chain = config.chain ?? parsed.chain;
    if (chain !== 'base-sepolia') {
      return c.json(
        { ok: false, reason: 'drip_only_on_base_sepolia', chain: chain ?? parsed.chain },
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

    const getBalance = async (): Promise<bigint | null> => {
      if (!publicClient) return null;
      return publicClient.getBalance({ address: address as `0x${string}` });
    };
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
              attempts: 0,
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

      const maxFaucetIters = computeFaucetDripCap({
        override: config.maxFaucetIters,
        targetWei,
        balanceWei,
      });
      const deadline = now() + faucetLoopTimeoutMs;
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
        if (i < maxFaucetIters - 1) {
          await new Promise((r) => setTimeout(r, interDripPauseMs));
        }
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
          reason: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  // Edit a single SolverNet's enabled flag and/or solverType from the SPA.
  // The operator click that triggers this is the in-app replacement for
  // hand-editing config.json; the daemon does not hot-reload, so callers
  // must follow up with /api/admin/restart (the existing "Restart Node"
  // affordance) for the change to take effect. See jinn-mono-* (config-UX).
  app.post('/v1/setup/solvernets/:name', async (c) => {
    const name = c.req.param('name');
    if (!name) return c.json({ error: 'invalid_invocation', detail: 'missing solvernet name' }, 400);

    let body: {
      enabled?: unknown;
      solverType?: unknown; // deprecated; accepted for one release cycle
      role?: unknown;       // legacy singular form, accepted for one release cycle
      roles?: unknown;
      harness?: unknown;
      model?: unknown;
      plugins?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', detail: 'expected JSON body' }, 400);
    }

    const editableFields: Array<keyof typeof body> = [
      'enabled', 'solverType', 'role', 'roles', 'harness', 'model', 'plugins',
    ];
    if (!editableFields.some((f) => body[f] !== undefined)) {
      return c.json({ error: 'invalid_body', detail: 'must include at least one editable field' }, 400);
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return c.json({ error: 'invalid_body', detail: '`enabled` must be a boolean' }, 400);
    }
    const KNOWN_SOLVER_TYPES = ['prediction.v0', 'prediction.v1'];
    if (body.solverType !== undefined && (typeof body.solverType !== 'string' || !KNOWN_SOLVER_TYPES.includes(body.solverType))) {
      return c.json({
        error: 'invalid_body',
        detail: `\`solverType\` must be one of ${KNOWN_SOLVER_TYPES.join(', ')}`,
      }, 400);
    }
    const KNOWN_ROLES = ['solving', 'evaluating'];
    let normalizedRoles: string[] | undefined;
    if (body.roles !== undefined) {
      if (
        !Array.isArray(body.roles) ||
        body.roles.length === 0 ||
        !body.roles.every((r): r is string => typeof r === 'string' && KNOWN_ROLES.includes(r))
      ) {
        return c.json({
          error: 'invalid_body',
          detail: '`roles` must be a non-empty array of `solving` and/or `evaluating`',
        }, 400);
      }
      // Deduplicate so the persisted shape is canonical even if the SPA double-includes a value.
      normalizedRoles = Array.from(new Set(body.roles as string[]));
    } else if (body.role !== undefined) {
      // Legacy singular form. Accept it (operators on older config tooling),
      // promote to the canonical roles array.
      if (typeof body.role !== 'string' || !KNOWN_ROLES.includes(body.role)) {
        return c.json({ error: 'invalid_body', detail: '`role` must be `solving` or `evaluating`' }, 400);
      }
      normalizedRoles = [body.role];
    }
    if (body.harness !== undefined && typeof body.harness !== 'string') {
      return c.json({ error: 'invalid_body', detail: '`harness` must be a string' }, 400);
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      return c.json({ error: 'invalid_body', detail: '`model` must be a string' }, 400);
    }
    if (body.plugins !== undefined) {
      if (!Array.isArray(body.plugins) || !body.plugins.every((p): p is string => typeof p === 'string')) {
        return c.json({ error: 'invalid_body', detail: '`plugins` must be an array of plugin names' }, 400);
      }
    }

    const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;
    let current: Record<string, unknown> = {};
    try {
      if (existsSync(cfgPath)) {
        current = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (err) {
      return c.json({
        error: 'config_unreadable',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    const rawSolverNets = isRecord(current.solverNets) ? current.solverNets : {};
    const solverNets: Record<string, Record<string, unknown>> = {};
    for (const [netName, netConfig] of Object.entries(rawSolverNets)) {
      if (isRecord(netConfig)) solverNets[netName] = { ...netConfig };
    }
    const defaultNet = DEFAULT_SOLVER_NETS[name];
    const existing = solverNets[name] ?? (isRecord(defaultNet) ? cloneRecord(defaultNet) : undefined);
    if (!existing) {
      const available = [...new Set([...Object.keys(DEFAULT_SOLVER_NETS), ...Object.keys(solverNets)])];
      return c.json({ error: 'solvernet_not_found', name, available }, 404);
    }

    if (body.enabled !== undefined) existing.enabled = body.enabled;
    if (body.solverType !== undefined) existing.solverType = body.solverType;
    if (normalizedRoles !== undefined) {
      // Operator-mode patch overwrites the role array. Task 22 of
      // spec/2026-05-05-solvernet-creation-and-launch.md retired the
      // operator-config `'launching'` role; the previous "preserve
      // non-operator roles" pass is no longer needed because every valid
      // operator role is in `KNOWN_ROLES`.
      existing.roles = Array.from(new Set(normalizedRoles));
      // Strip any legacy singular `role` so the persisted shape is canonical.
      // Eliminates ambiguity if a third-party tool reads the file and prefers
      // `role` over `roles`.
      delete existing['role'];
    }
    if (body.harness !== undefined) existing.harness = canonicalHarnessName(body.harness);
    if (body.model !== undefined) existing.model = body.model;
    if (body.plugins !== undefined) existing.plugins = body.plugins;
    solverNets[name] = existing;

    try {
      persistConfigValue('solverNets', solverNets, cfgPath);
      config.onSolverNetsUpdated?.(solverNets);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    return c.json({
      ok: true,
      restartRequired: true,
      name,
      config: existing,
    });
  });

  // POST /v1/operator/join/:cid — operator joins a launched SolverNet.
  //
  // Writes a manifest-keyed entry to `config.joinedSolverNets[<cid>]` with
  // the operator's chosen roles + (for solver role) harness/model/plugins.
  // The entry is keyed by `manifestCid` rather than the SolverNet's short
  // name — multiple launchers can launch a SolverNet with the same name on
  // the same network, and the manifestCid is the only stable identifier
  // that maps back to a launched-instance authority.
  //
  // Spec: spec/2026-05-05-solvernet-creation-and-launch.md §12.
  //
  // Note (Task 21 / Task 22 transition): the spec example shows
  // `solverNets[<cid>]` directly, but the legacy `solverNets` zod entry has
  // required `solverType` + role enum that conflicts with the new shape, and
  // many daemon-side consumers read those fields without narrowing. Keeping
  // the new shape under a structurally-separate `joinedSolverNets` block
  // avoids touching every consumer; Task 22 collapses both into a single
  // manifest-keyed shape once the legacy block is fully drained.
  //
  // The daemon does not hot-reload SolverNet config; the operator must follow
  // up with /api/admin/restart for the change to take effect (same posture as
  // /v1/setup/solvernets/:name).
  app.post('/v1/operator/join/:cid', async (c) => {
    const cid = c.req.param('cid');
    if (!cid) {
      return c.json({ error: 'invalid_invocation', detail: 'missing manifest cid' }, 400);
    }

    let body: {
      name?: unknown;
      roles?: unknown;
      harness?: unknown;
      model?: unknown;
      plugins?: unknown;
      disabledDefaultPlugins?: unknown;
      contract?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', detail: 'expected JSON body' }, 400);
    }

    const KNOWN_ROLES = ['solver', 'evaluator'];
    if (!Array.isArray(body.roles) || body.roles.length === 0) {
      return c.json({
        error: 'invalid_body',
        detail: '`roles` must be a non-empty array',
      }, 400);
    }
    if (!body.roles.every((r): r is string => typeof r === 'string' && KNOWN_ROLES.includes(r))) {
      return c.json({
        error: 'invalid_body',
        detail: '`roles` entries must each be `solver` or `evaluator`',
      }, 400);
    }
    const roles = Array.from(new Set(body.roles as string[]));

    if (body.name !== undefined && typeof body.name !== 'string') {
      return c.json({ error: 'invalid_body', detail: '`name` must be a string' }, 400);
    }
    if (body.harness !== undefined && typeof body.harness !== 'string') {
      return c.json({ error: 'invalid_body', detail: '`harness` must be a string' }, 400);
    }
    if (body.model !== undefined && typeof body.model !== 'string') {
      return c.json({ error: 'invalid_body', detail: '`model` must be a string' }, 400);
    }
    let contract: { id: string; version: string } | undefined;
    if (body.contract !== undefined) {
      if (
        !isRecord(body.contract) ||
        typeof body.contract['id'] !== 'string' ||
        typeof body.contract['version'] !== 'string'
      ) {
        return c.json({
          error: 'invalid_body',
          detail: '`contract` must be an object with string id and version',
        }, 400);
      }
      contract = {
        id: body.contract['id'],
        version: body.contract['version'],
      };
    }
    if (body.plugins !== undefined) {
      if (!Array.isArray(body.plugins) || !body.plugins.every((p): p is string => typeof p === 'string')) {
        return c.json({
          error: 'invalid_body',
          detail: '`plugins` must be an array of plugin names',
        }, 400);
      }
    }
    if (body.disabledDefaultPlugins !== undefined) {
      if (
        !Array.isArray(body.disabledDefaultPlugins) ||
        !body.disabledDefaultPlugins.every((p): p is string => typeof p === 'string')
      ) {
        return c.json({
          error: 'invalid_body',
          detail: '`disabledDefaultPlugins` must be an array of plugin names',
        }, 400);
      }
    }

    const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;
    let current: Record<string, unknown> = {};
    try {
      if (existsSync(cfgPath)) {
        current = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (err) {
      return c.json({
        error: 'config_unreadable',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    const rawJoined = isRecord(current.joinedSolverNets) ? current.joinedSolverNets : {};
    const joinedSolverNets: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(rawJoined)) {
      if (!isRecord(v)) continue;
      const entry = { ...v };
      if (typeof entry['harness'] === 'string') {
        entry['harness'] = canonicalHarnessName(entry['harness']);
      }
      joinedSolverNets[k] = entry;
    }

    const previous = joinedSolverNets[cid];
    const previousContractRecord = isRecord(previous?.['contract'])
      ? previous?.['contract']
      : undefined;
    const previousContract =
      previousContractRecord &&
      typeof previousContractRecord['id'] === 'string' &&
      typeof previousContractRecord['version'] === 'string'
        ? {
            id: previousContractRecord['id'],
            version: previousContractRecord['version'],
          }
        : undefined;

    const entry: Record<string, unknown> = {
      manifestCid: cid,
      roles,
    };
    if (typeof body.name === 'string') entry['name'] = body.name;
    if (contract ?? previousContract) entry['contract'] = contract ?? previousContract;
    // `harness` / `model` / `plugins` are solver-side. Persist whatever the
    // SPA sent; the daemon-side runtime ignores them when only the
    // `evaluator` role is selected (evaluator harness comes from
    // `manifest.contract.evaluationFunction.implementation`).
    if (typeof body.harness === 'string') entry['harness'] = canonicalHarnessName(body.harness);
    if (typeof body.model === 'string') entry['model'] = body.model;
    if (Array.isArray(body.plugins)) entry['plugins'] = body.plugins;
    if (Array.isArray(body.disabledDefaultPlugins)) {
      entry['disabledDefaultPlugins'] = Array.from(new Set(body.disabledDefaultPlugins));
    }

    joinedSolverNets[cid] = entry;

    try {
      persistConfigValue('joinedSolverNets', joinedSolverNets, cfgPath);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    return c.json({
      ok: true,
      restartRequired: true,
      manifestCid: cid,
      config: entry,
    });
  });

  // DELETE /v1/operator/join/:cid — operator leaves a joined SolverNet.
  // Removes the manifest-keyed entry from `config.joinedSolverNets`. Returns
  // 404 if no such entry exists so the SPA can distinguish "I left
  // successfully" from "this entry was already gone" — useful for stale-tab
  // detection.
  app.delete('/v1/operator/join/:cid', async (c) => {
    const cid = c.req.param('cid');
    if (!cid) {
      return c.json({ error: 'invalid_invocation', detail: 'missing manifest cid' }, 400);
    }

    const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;
    let current: Record<string, unknown> = {};
    try {
      if (existsSync(cfgPath)) {
        current = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (err) {
      return c.json({
        error: 'config_unreadable',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    const rawJoined = isRecord(current.joinedSolverNets) ? current.joinedSolverNets : {};
    if (!isRecord(rawJoined[cid])) {
      return c.json({ error: 'join_not_found', manifestCid: cid }, 404);
    }
    const joinedSolverNets: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(rawJoined)) {
      if (k === cid) continue;
      if (isRecord(v)) joinedSolverNets[k] = { ...v };
    }

    try {
      persistConfigValue('joinedSolverNets', joinedSolverNets, cfgPath);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    return c.json({ ok: true, restartRequired: true, manifestCid: cid });
  });

  // GET /v1/operator/joined — list the operator's joined SolverNets.
  //
  // Returns the manifest-keyed `joinedSolverNets` dict from the operator
  // config so the SPA's catalog cards (RegistryCatalog) can render a
  // "JOINED" indicator alongside the Join CTA. Without this the SPA cannot
  // distinguish a joined SolverNet from one the operator hasn't joined yet
  // and operators see a stale "Join" CTA even after a successful join.
  // (jinn-mono follow-up to dogfood walk.)
  app.get('/v1/operator/joined', async (c) => {
    const cfgPath = config.configPath ?? DEFAULT_CONFIG_PATH;
    let current: Record<string, unknown> = {};
    try {
      if (existsSync(cfgPath)) {
        current = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (err) {
      return c.json({
        error: 'config_unreadable',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }
    const rawJoined = isRecord(current.joinedSolverNets) ? current.joinedSolverNets : {};
    const joinedSolverNets: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(rawJoined)) {
      if (isRecord(v)) joinedSolverNets[k] = { ...v };
    }
    return c.json({ joinedSolverNets });
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

    let nextRpcUrl: string;
    if (body.rpcUrl === null || body.rpcUrl === '') {
      nextRpcUrl =
        config.defaultRpcUrlForChain?.() ??
        'https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu';
    } else if (typeof body.rpcUrl === 'string') {
      try {
        const parsed = new URL(body.rpcUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return c.json({ error: 'invalid_body', detail: '`rpcUrl` must use http or https' }, 400);
        }
        nextRpcUrl = body.rpcUrl;
      } catch {
        return c.json({ error: 'invalid_body', detail: '`rpcUrl` is not a valid URL' }, 400);
      }
    } else {
      return c.json({ error: 'invalid_body', detail: '`rpcUrl` must be a string or null' }, 400);
    }

    try {
      persistConfigValue('rpcUrl', nextRpcUrl, cfgPath);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    return c.json({
      ok: true,
      restartRequired: true,
      rpcUrl: nextRpcUrl,
    });
  });

  // POST /v1/setup/bootstrap/retry — re-enter the bootstrap state machine
  // in-process. jinn-mono-hjex.6
  if (config.retryBootstrap) {
    addSetupRetryEndpoint(app, { retryBootstrap: config.retryBootstrap });
  }

  // POST /v1/setup/restake/:serviceId — operator-triggered re-stake for an
  // evicted service. Backs the "Re-stake now" dashboard CTA. jinn-mono-hjex.3
  app.post('/v1/setup/restake/:serviceId', async (c) => {
    if (!config.restake) {
      return c.json({ error: 'restake_not_configured' }, 503);
    }
    const raw = c.req.param('serviceId');
    const serviceId = Number.parseInt(raw, 10);
    if (!Number.isFinite(serviceId) || serviceId <= 0) {
      return c.json({ error: 'invalid_service_id' }, 400);
    }
    try {
      const result = await config.restake(serviceId);
      if (!result.ok) {
        return c.json({ ok: false, error: result.error ?? 'restake_failed' }, 500);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

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
          message: err instanceof Error ? err.message : String(err),
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
        detail: `Claude Code is on PATH, but Jinn could not save that setting: ${err instanceof Error ? err.message : String(err)}`,
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
      detail: `Claude Code installed, but Jinn could not save that setting: ${err instanceof Error ? err.message : String(err)}`,
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
