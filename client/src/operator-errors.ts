/**
 * User-facing error formatting for operators.
 * Full stack traces and raw RPC errors are reserved for JINN_DEBUG mode.
 */

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
}

/**
 * Map common Safe / RPC failures to short messages. Falls back to a trimmed raw line.
 */
export function formatBootstrapOperatorMessage(error: unknown): OperatorErrorParts {
  const msg = stringifyUnknown(error);
  const lower = msg.toLowerCase();

  if (msg.includes('GS013')) {
    return {
      summary:
        'Gnosis Safe could not execute or estimate this transaction (GS013: inner call may have reverted or gas estimation failed).',
      hint: 'Retry after a few blocks, switch RPC, or run with JINN_DEBUG=1 for the full error.',
    };
  }

  if (msg.includes('GS026')) {
    return {
      summary:
        'Gnosis Safe rejected the transaction (GS026: invalid owner address or signature).',
      hint: 'Confirm the signing key is a Safe owner and the Safe address matches your fleet state.',
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
    };
  }

  if (
    lower.includes('insufficient funds') ||
    msg.includes('INSUFFICIENT_FUNDS') ||
    lower.includes('exceeds the balance of the account')
  ) {
    return {
      summary: 'Not enough ETH on the paying account to cover gas (and value, if any).',
      hint: 'Send ETH to the master wallet, agent EOA, or Safe depending on which step failed.',
    };
  }

  const firstLine = msg.split('\n')[0]?.trim() ?? msg;
  if (firstLine.length > 220) {
    return {
      summary: `${firstLine.slice(0, 220)}…`,
      hint: 'Run with JINN_DEBUG=1 for the full error.',
    };
  }

  return { summary: firstLine };
}
