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
import { FleetStateStore } from '../earning/store.js';
import { decryptMnemonic, encryptMnemonic } from '../earning/wallet.js';
import { requestTestnetFunding } from '../earning/faucet.js';
import { createJinnPublicClient, type JinnOnchainNetwork } from '../earning/viem-clients.js';
import { detectAuthContext, probeClaudeAuth } from '../preflight/claude-auth.js';
import { triggerAgentSpawn } from '../agent/agent-ws.js';

const ChangePasswordSchema = z.object({
  current: z.string().min(1),
  next: z.string().min(8),
});

export interface SetupRoutesConfig {
  earningDir?: string;
  chain?: JinnOnchainNetwork;
  rpcUrl?: string;
  minEoaGasWei?: string;
  requestFunding?: typeof requestTestnetFunding;
  maxFaucetIters?: number;
  interDripPauseMs?: number;
}

export function addSetupRoutes(app: Hono, config: SetupRoutesConfig = {}): void {
  app.get('/v1/auth/claude', (c) => {
    const cwd = process.cwd();
    const context = detectAuthContext({ cwd });
    const probe = probeClaudeAuth({ context, cwd });
    return c.json({
      schemaVersion: 1,
      authenticated: probe.authenticated,
      context,
      detail: probe.detail,
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

  // POST /v1/setup/drip — user-triggered Base Sepolia faucet funding for the
  // master EOA. One click drains the tiny CDP drip repeatedly until the wallet
  // reaches the bootstrap floor, the faucet rate-limits, or the safety cap is
  // hit. Mainnet rejects.
  app.post('/v1/setup/drip', async (c) => {
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
    const maxFaucetIters = config.maxFaucetIters ?? 60;
    const interDripPauseMs = config.interDripPauseMs ?? 1_000;
    const targetWei = config.minEoaGasWei ? BigInt(config.minEoaGasWei) : null;
    const publicClient = config.rpcUrl
      ? createJinnPublicClient(config.rpcUrl, 'base-sepolia')
      : null;

    const getBalance = async (): Promise<bigint | null> => {
      if (!publicClient) return null;
      return publicClient.getBalance({ address: address as `0x${string}` });
    };

    try {
      const txHashes: string[] = [];
      let balanceWei = await getBalance();
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

      for (let i = 0; i < maxFaucetIters; i++) {
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
