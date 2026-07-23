/**
 * User-facing error formatting for operators.
 * Full stack traces and raw RPC errors are reserved for JINN_DEBUG mode.
 */

import { isUnauthorizedAccountError } from './errors/unauthorized-account.js';

function envDebugTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** True when JINN_DEBUG is set (also mirrored in loadConfig as `debug`). */
export function isJinnDebug(): boolean {
  return envDebugTruthy(process.env['JINN_DEBUG']);
}

function stringifyUnknown(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    let s = error.message;
    const withCause = error as Error & { cause?: unknown };
    if (withCause.cause !== undefined && withCause.cause !== null) {
      s += ' | ' + stringifyUnknown(withCause.cause);
    }
    return s;
  }
  if (typeof error === 'object') {
    const o = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.shortMessage === 'string') parts.push(o.shortMessage);
    if (typeof o.details === 'string') parts.push(o.details);
    if (typeof o.message === 'string' && !parts.includes(o.message)) parts.push(o.message);
    if (parts.length > 0) return parts.join(' | ');
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export interface OperatorErrorParts {
  /** Primary operator-facing line */
  summary: string;
  /** Optional follow-up guidance */
  hint?: string;
  /**
   * The raw underlying error message, preserved verbatim so callers can
   * include it in error envelopes / debug logs. The formatter's `summary`
   * is a heuristic interpretation; when the heuristic is wrong, operators
   * (and maintainers reading bootstrap-error.json post-mortem) need the
   * untouched message to diagnose. Always populated.
   */
  rawMessage: string;
  /**
   * Structured category for the error type when it can be determined with
   * confidence. Absent for unclassified errors. Consumers can use this to
   * render structured UI (e.g. "insufficient_funds" → show address + amount)
   * rather than relying on prose parsing. jinn-mono-hjex.6
   */
  category?: 'insufficient_funds' | 'gas_too_low' | 'nonce_conflict';
}

/**
 * Map common Safe / RPC failures to short messages. Falls back to a trimmed raw line.
 *
 * The summary is a best-effort diagnosis. Always keep `rawMessage` in the
 * caller's envelope so a wrong diagnosis can be debugged instead of
 * masquerading as the truth (cf. jinn-mono-jz9f: a gas-limit shortage was
 * misclassified as an insufficient-funds error and sent operators chasing
 * a funding fix that did not exist).
 */
export function formatBootstrapOperatorMessage(error: unknown): OperatorErrorParts {
  const msg = stringifyUnknown(error);
  const lower = msg.toLowerCase();

  if (isUnauthorizedAccountError(msg) || msg.includes('not authorized to reStake')) {
    // Surfaces from `recoverEvictedService` when distributor.reStake reverts
    // because the current master EOA is not the recorded service operator on
    // the stOLAS ExternalStakingDistributor. Keep the full actionable message.
    return {
      summary: msg.split('reStake revert:')[0]?.trim() ?? msg,
      hint: 'Verify JINN_EARNING_DIR and JINN_PASSWORD derive the original master EOA for this service. Otherwise request owner / managing-agent recovery or abandon-and-rebootstrap.',
      rawMessage: msg,
    };
  }

  if (msg.includes('GS013')) {
    return {
      summary:
        'Gnosis Safe could not execute or estimate this transaction (GS013: inner call may have reverted or gas estimation failed).',
      hint: 'Retry after a few blocks or switch RPC. Full cause chain is in the error envelope details.',
      rawMessage: msg,
    };
  }

  if (msg.includes('GS026')) {
    return {
      summary:
        'Gnosis Safe rejected the transaction (GS026: invalid owner address or signature).',
      hint: 'Repair the Safe owner set on chain, or set JINN_EARNING_DIR to the fleet directory whose master_keystore.json derives the agent address recorded for this Safe in earning_state.json.',
      rawMessage: msg,
    };
  }

  if (
    lower.includes('replacement transaction underpriced') ||
    lower.includes('replacement fee too low') ||
    lower.includes('fee cap less than block base fee')
  ) {
    return {
      summary: 'A transaction with the same nonce is already pending, and the new gas price is too low.',
      hint: 'Wait for confirmation, cancel/replace with a higher maxFeePerGas, or clear the stuck nonce.',
      rawMessage: msg,
      category: 'nonce_conflict',
    };
  }

  // Geth-specific: `gas required exceeds allowance (0)` from eth_estimateGas
  // means sender balance ÷ gasPrice rounded to zero — i.e. the account cannot
  // pay for even 1 wei of gas. That's an insufficient-balance error, not an
  // OOG. Must come before the broader OOG matcher below so it doesn't fall
  // through. See jinn-mono-u34i.
  //
  // jinn-mono-hjex.6 review: this branch is semantically the same shortfall
  // as the explicit "insufficient funds for gas" branch below (zero spendable
  // balance vs gas), so it must classify as `insufficient_funds` — NOT
  // `gas_too_low` — so the SPA renders the funding-shortfall UI (send ETH to
  // address X) instead of a misleading "re-run, the daemon will retry gas".
  if (lower.includes('gas required exceeds allowance (0)')) {
    return {
      summary: 'Not enough ETH on the paying account to cover gas (and value, if any).',
      hint: 'Send ETH to the master wallet, agent EOA, or Safe depending on which step failed.',
      rawMessage: msg,
      category: 'insufficient_funds',
    };
  }

  // Gas-supply shortage (gas limit < execution gas, intrinsic floor, etc.).
  // Match before the funds branch so OOG errors that incidentally mention
  // "insufficient" do not get mislabeled as a balance problem.
  if (
    lower.includes('out of gas') ||
    lower.includes('intrinsic gas too low') ||
    lower.includes('gas required exceeds allowance') || // (N>0) — true gas-limit shortfall; the (0) case is handled above
    lower.includes('contract creation code storage out of gas') ||
    lower.includes('exceeds block gas limit')
  ) {
    return {
      summary:
        'Transaction ran out of gas — the Safe wrapper or inner contract call needed more gas than the supplied limit.',
      hint: 'Re-run; the daemon estimates gas dynamically and a transient RPC failure may have forced a fallback. If it persists, the gas requirement of the underlying step has likely drifted past the safe-adapter fallback floor.',
      rawMessage: msg,
      category: 'gas_too_low',
    };
  }

  // Genuine insufficient-funds. The substring `insufficient funds` alone is
  // too loose — vendor RPC errors can wrap OOG / revert text using "insufficient
  // gas" or similar phrasing that contains the substring. Match the specific
  // viem / EVM phrasings that mean balance < gas*price + value.
  if (
    lower.includes('insufficient funds for gas') ||
    lower.includes('insufficient funds for transfer') ||
    lower.includes('exceeds the balance of the account') ||
    msg.includes('INSUFFICIENT_FUNDS')
  ) {
    return {
      summary: 'Not enough ETH on the paying account to cover gas (and value, if any).',
      // The structured envelope (jinn-mono-hjex.6) surfaces the specific address
      // and amounts; this hint is the fallback for non-SPA consumers.
      hint: 'Check the bootstrap error details for the specific address and required amount.',
      rawMessage: msg,
      category: 'insufficient_funds',
    };
  }

  const firstLine = msg.split('\n')[0]?.trim() ?? msg;
  if (firstLine.length > 220) {
    return { summary: `${firstLine.slice(0, 220)}…`, rawMessage: msg };
  }

  return { summary: firstLine, rawMessage: msg };
}
