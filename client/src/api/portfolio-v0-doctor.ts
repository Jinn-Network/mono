/**
 * portfolio.v0 doctor checks (§10 step 8 of spec/2026-04-17-portfolio-v0-design.md).
 *
 * Returns structured check results without hitting the network — all checks are
 * local filesystem reads. Each check is safe to call independently.
 *
 * Note: The HL master account deposit check (verifying on-chain deposit via HL
 * API) is intentionally skipped in v0 — it would require an external network
 * call with no existing client dependency. Operators should verify the deposit
 * manually via the Hyperliquid UI.
 */

import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { loadApiWalletState } from '../harnesses/impls/claude-mcp-hyperliquid/api-wallet.js';

export interface DoctorCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

// ── Checks ────────────────────────────────────────────────────────────────────

/**
 * Check that the implStateDir for the HL impl is accessible and looks healthy.
 *
 * @param implStateDir - path to the impl state directory (e.g. ~/.jinn-client/impl/claude-mcp-hyperliquid)
 */
export function checkImplStateDir(implStateDir: string | undefined): DoctorCheckResult {
  if (!implStateDir) {
    return {
      name: 'portfolio_impl_state_dir',
      ok: false,
      detail: 'implStateDir not configured',
      remedy: 'Set implStateDir in your config or pass --impl-state-dir to the daemon.',
    };
  }

  if (!existsSync(implStateDir)) {
    return {
      name: 'portfolio_impl_state_dir',
      ok: false,
      detail: `directory does not exist: ${implStateDir}`,
      remedy: 'Run the daemon at least once to initialise the impl state directory.',
    };
  }

  try {
    const stat = statSync(implStateDir);
    if (!stat.isDirectory()) {
      return {
        name: 'portfolio_impl_state_dir',
        ok: false,
        detail: `path exists but is not a directory: ${implStateDir}`,
        remedy: 'Remove the file at that path and let the daemon recreate the directory.',
      };
    }
    accessSync(implStateDir, constants.R_OK);
  } catch (e) {
    return {
      name: 'portfolio_impl_state_dir',
      ok: false,
      detail: `directory not readable: ${e instanceof Error ? e.message : String(e)}`,
      remedy: 'Check filesystem permissions on the impl state directory.',
    };
  }

  return {
    name: 'portfolio_impl_state_dir',
    ok: true,
    detail: `directory present and readable: ${implStateDir}`,
  };
}

/**
 * Check that an HL API wallet is present in implStateDir and whether it has
 * been approved by the operator.
 *
 * Returns ok=true even when not yet approved (that is an operator action, not
 * a system error) — the detail string makes the status clear.
 */
export function checkHlApiWallet(implStateDir: string | undefined): DoctorCheckResult {
  if (!implStateDir) {
    return {
      name: 'hl_api_wallet',
      ok: false,
      detail: 'implStateDir not configured — cannot locate API wallet',
      remedy: 'Configure implStateDir and run the daemon at least once.',
    };
  }

  const walletPath = join(implStateDir, 'api-wallet.json');
  if (!existsSync(walletPath)) {
    return {
      name: 'hl_api_wallet',
      ok: false,
      detail: 'api-wallet.json not found in implStateDir',
      remedy: 'Run the daemon at least once so the API wallet is generated, then approve it via the HL UI.',
    };
  }

  const state = loadApiWalletState(implStateDir);
  if (!state) {
    return {
      name: 'hl_api_wallet',
      ok: false,
      detail: 'api-wallet.json exists but could not be parsed',
      remedy: 'Inspect the file for corruption, or delete it and let the daemon regenerate it.',
    };
  }

  if (!state.approved) {
    return {
      name: 'hl_api_wallet',
      ok: false,
      detail: `API wallet present but not approved — address: ${state.address}`,
      remedy: 'Approve this address as an API wallet on your HL master account (Settings → API Wallets → Add).',
    };
  }

  return {
    name: 'hl_api_wallet',
    ok: true,
    detail: `API wallet present and approved — address: ${state.address}`,
  };
}

/**
 * Run all portfolio.v0 doctor checks given an optional implStateDir.
 * Safe to call even when HL impl is not configured — checks gracefully handle
 * the undefined case.
 */
export function runPortfolioV0DoctorChecks(implStateDir: string | undefined): DoctorCheckResult[] {
  return [
    checkImplStateDir(implStateDir),
    checkHlApiWallet(implStateDir),
  ];
}
