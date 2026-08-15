/**
 * API wallet management for claude-mcp-hyperliquid — §8.1.
 *
 * Architecture decision (v0):
 *   Option (b): fresh keypair generated on first use, persisted in implStateDir.
 *   This provides blast-radius isolation — a compromised API wallet does not
 *   expose other keys held by the operator.
 *
 * HL "approve agent" flow (v0 operator prerequisite):
 *   The approve-agent authorization (linking the API wallet to the master account)
 *   is an OPERATOR PREREQUISITE for v0. The operator must manually approve the API
 *   wallet via the Hyperliquid UI (Settings → API Wallets → Add) or via the HL
 *   L2 action `approveAgent` BEFORE the impl can place trades.
 *
 *   Steps:
 *     1. Run any `jinn` command or let the daemon boot once — the API wallet
 *        keypair is generated and persisted to <implStateDir>/api-wallet.json.
 *     2. Run `jinn portfolio api-wallet` (or inspect the file) to get the address.
 *     3. Approve that address as an API wallet on your HL master account.
 *     4. Set `approved: true` in <implStateDir>/api-wallet.json  OR  call
 *        `markApiWalletApproved(implStateDir)` from the CLI.
 *
 *   This impl checks `state.approved` in `canAttempt()` and returns an
 *   informative error including the wallet address if not approved.
 *
 *   Programmatic approval is a §8.5 future item.
 *
 * State file: <implStateDir>/api-wallet.json  (mode 0o600)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ApiWalletState {
  /** 0x-prefixed hex private key */
  privateKey: string;
  /** Derived Ethereum address */
  address: string;
  /** Whether the operator has approved this wallet as an HL agent */
  approved: boolean;
  /** Epoch ms when the wallet was created */
  createdAt: number;
  /** Epoch ms when approved flag was last set */
  approvedAt?: number;
  /**
   * The HL master that approved this agent, captured during the operator's
   * approve-agent setup. When present, the impl cross-checks this against
   * the task's `spec.account.masterAddress` on every run — if they
   * disagree, it aborts with `E_MASTER_MISMATCH` rather than silently
   * routing trades to the wrong master.
   */
  masterAddress?: string;
}

// ── File path ──────────────────────────────────────────────────────────────────

export function walletStatePath(implStateDir: string): string {
  return join(implStateDir, 'api-wallet.json');
}

// ── Load / save ────────────────────────────────────────────────────────────────

export function loadApiWalletState(implStateDir: string): ApiWalletState | null {
  const path = walletStatePath(implStateDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as ApiWalletState;
  } catch {
    return null;
  }
}

export function saveApiWalletState(implStateDir: string, state: ApiWalletState): void {
  const path = walletStatePath(implStateDir);
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// ── Provision ──────────────────────────────────────────────────────────────────

/**
 * Ensure an API wallet exists in implStateDir. Creates one if absent.
 * Returns the current state (approved or not).
 *
 * Synchronous — safe to call at impl startup.
 */
export function provisionApiWallet(implStateDir: string): ApiWalletState {
  const existing = loadApiWalletState(implStateDir);
  if (existing) return existing;

  // Generate a fresh 32-byte private key
  const privateKeyBytes = randomBytes(32);
  const privateKey = `0x${privateKeyBytes.toString('hex')}` as `0x${string}`;

  const account = privateKeyToAccount(privateKey);

  const state: ApiWalletState = {
    privateKey,
    address: account.address,
    approved: false,
    createdAt: Date.now(),
  };

  saveApiWalletState(implStateDir, state);
  return state;
}

/**
 * Mark the API wallet as approved by the operator.
 * Call this after the operator completes the HL approve-agent flow.
 */
export function markApiWalletApproved(implStateDir: string): ApiWalletState {
  const existing = loadApiWalletState(implStateDir);
  if (!existing) {
    throw new Error('api-wallet: no wallet found in implStateDir — call provisionApiWallet first');
  }

  const updated: ApiWalletState = {
    ...existing,
    approved: true,
    approvedAt: Date.now(),
  };

  saveApiWalletState(implStateDir, updated);
  return updated;
}
