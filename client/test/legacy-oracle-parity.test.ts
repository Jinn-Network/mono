/**
 * Legacy behavior is pinned as kit fixtures, not ported as code (operator-daemon composition
 * design §6.6; program contract 12). This suite is the drift guard for the two oracles that still
 * live in this tree while the one-swap runs: the mech adapter's revert-classification table and
 * `tx-retry.ts`'s nonce/retry ladder.
 *
 * It exists because the kit's fixtures were derived from these files by reading them. A fixture
 * derived by reading can silently disagree with its oracle the moment someone edits one side. Once
 * the swap deletes the mech adapter's consumers, the venue kit becomes the sole record of these
 * rules — so the two must be proven equal *while both exist*, which is now.
 *
 * `client/src/adapters/mech/safe-revert.ts` is a keeper (Safe revert decoding is Safe semantics,
 * not broadcast policy — stage-1 plan). Its table therefore stays pinned and non-orphaned; what
 * this suite guards is that the binding's re-homed copy has not diverged from it.
 *
 * Delete this file when `client/src/tx-retry.ts` retires. Nothing else should depend on it.
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWN_INNER_ERRORS as BINDING_KNOWN_INNER_ERRORS,
  SafeInnerRevertError as BindingSafeInnerRevertError,
} from '@jinn-network/marketplace-binding';
import {
  BROADCAST_DEFAULTS,
  classifyBroadcastError,
} from '@jinn-network/marketplace-venue-base';
import { KNOWN_INNER_ERRORS as LEGACY_KNOWN_INNER_ERRORS } from '../src/adapters/mech/safe-revert.js';
import { TX_RETRY_DEFAULTS, isRecoverableTransactionError } from '../src/tx-retry.js';

/**
 * The only selectors the legacy table carries that the binding deliberately does not: JinnRouterV2
 * custom errors. V2 is not part of the revised contract generation the binding decodes, so these
 * are a scoped omission rather than drift. Any *other* divergence fails.
 */
const RETIRED_V2_ONLY_SELECTORS = ['0x1a387062', '0xa6f3b939', '0xc8426484'] as const;

function innerRevert(decodedName: string, selector: `0x${string}`): BindingSafeInnerRevertError {
  return new BindingSafeInnerRevertError(
    `Safe execTransaction inner revert: ${decodedName}`,
    selector,
    selector,
    decodedName,
    null,
    null,
  );
}

describe('legacy revert-classification table stays pinned to the binding copy', () => {
  it('the binding decodes every legacy selector except the three retired JinnRouterV2 errors', () => {
    const missing = Object.keys(LEGACY_KNOWN_INNER_ERRORS).filter(
      (selector) => BINDING_KNOWN_INNER_ERRORS[selector] === undefined,
    );
    expect(missing.sort()).toEqual([...RETIRED_V2_ONLY_SELECTORS].sort());
  });

  it('the binding introduces no selector the legacy table never carried', () => {
    const extra = Object.keys(BINDING_KNOWN_INNER_ERRORS).filter(
      (selector) => LEGACY_KNOWN_INNER_ERRORS[selector] === undefined,
    );
    expect(extra).toEqual([]);
  });

  it('every shared selector decodes to the same name and the same parameter signature', () => {
    for (const [selector, legacy] of Object.entries(LEGACY_KNOWN_INNER_ERRORS)) {
      const binding = BINDING_KNOWN_INNER_ERRORS[selector];
      if (binding === undefined) continue;
      expect(binding.name, selector).toBe(legacy.name);
      expect(binding.params, selector).toBe(legacy.params);
    }
  });
});

describe('the kit classifier agrees with the legacy classifier on every decodable inner revert', () => {
  for (const [selector, entry] of Object.entries(BINDING_KNOWN_INNER_ERRORS)) {
    it(`${entry.name} is retryable in both, or in neither`, () => {
      const error = innerRevert(entry.name, selector as `0x${string}`);
      // The kit refines legacy's single "non-recoverable" bucket into `permanent` and
      // `already-settled`. The retryable/not-retryable split is the part that must match exactly:
      // a disagreement there is either a burned retry budget or an infinite retry loop.
      expect(classifyBroadcastError(error) === 'retryable').toBe(
        isRecoverableTransactionError(error),
      );
    });
  }

  it('an undecoded but deterministic inner selector is terminal in both', () => {
    const undecoded = new BindingSafeInnerRevertError(
      'Safe execTransaction inner revert (undecoded selector 0x33f626d3)',
      '0x33f626d3',
      '0x33f626d3',
      null,
      null,
      null,
    );
    expect(classifyBroadcastError(undecoded)).toBe('permanent');
    expect(isRecoverableTransactionError(undecoded)).toBe(false);
  });
});

describe('the kit and legacy string ladders classify the same messages the same way', () => {
  const cases: readonly { readonly message: string; readonly retryable: boolean }[] = [
    { message: 'execution reverted: GS013', retryable: false },
    { message: 'execution reverted: GS026', retryable: false },
    { message: 'insufficient funds for gas * price + value', retryable: false },
    { message: 'User rejected the request', retryable: false },
    { message: 'nonce too low', retryable: true },
    { message: 'already known', retryable: true },
    { message: 'could not coalesce error', retryable: true },
    { message: 'replacement transaction underpriced', retryable: true },
    { message: 'replacement fee too low', retryable: true },
    { message: 'transaction underpriced', retryable: true },
    { message: 'fee cap less than block base fee', retryable: true },
    { message: 'max fee per gas less than block base fee', retryable: true },
    { message: 'read ECONNRESET', retryable: true },
    { message: 'connect ETIMEDOUT', retryable: true },
    { message: 'socket hang up', retryable: true },
    { message: 'fetch failed', retryable: true },
    { message: 'connection refused', retryable: true },
    { message: 'All RPC providers in the fallback chain failed', retryable: true },
    { message: 'The contract function "nonce" returned no data ("0x").', retryable: true },
    { message: 'Cannot decode zero data ("0x") with ABI parameters.', retryable: true },
    { message: 'The address is not a contract.', retryable: true },
    { message: 'HTTP 429 Too Many Requests', retryable: true },
    { message: 'Internal JSON-RPC error (-32603)', retryable: true },
    { message: 'limit exceeded (-32005)', retryable: true },
    { message: 'request timed out', retryable: true },
    { message: '502 Bad Gateway', retryable: true },
    { message: '503 Service Unavailable', retryable: true },
  ];

  for (const { message, retryable } of cases) {
    it(`"${message}" is ${retryable ? 'retryable' : 'terminal'} in both`, () => {
      const error = new Error(message);
      expect(classifyBroadcastError(error) === 'retryable', 'kit').toBe(retryable);
      expect(isRecoverableTransactionError(error), 'legacy').toBe(retryable);
    });
  }

  it('both flatten an error cause chain before matching', () => {
    const nested = new Error('broadcast failed', { cause: new Error('nonce too low') });
    expect(classifyBroadcastError(nested)).toBe('retryable');
    expect(isRecoverableTransactionError(nested)).toBe(true);
  });
});

describe('the venue broadcast ladder still matches the legacy nonce/retry ladder', () => {
  it('carries the same attempt budget, backoff bounds, fee bumps and stale-nonce window', () => {
    expect(BROADCAST_DEFAULTS.maxAttempts).toBe(TX_RETRY_DEFAULTS.maxAttempts);
    expect(BROADCAST_DEFAULTS.baseDelayMs).toBe(TX_RETRY_DEFAULTS.baseDelayMs);
    expect(BROADCAST_DEFAULTS.maxDelayMs).toBe(TX_RETRY_DEFAULTS.maxDelayMs);
    expect(BROADCAST_DEFAULTS.feeBumpBpsPerAttempt).toBe(TX_RETRY_DEFAULTS.feeBumpBpsPerAttempt);
    expect(BROADCAST_DEFAULTS.replacementBumpBps).toBe(TX_RETRY_DEFAULTS.replacementBumpBps);
    expect(BROADCAST_DEFAULTS.stuckNonceAfterMs).toBe(TX_RETRY_DEFAULTS.stuckNonceAfterMs);
  });

  it('adds only the lock lease, which legacy has no equivalent for (its lock is in-process)', () => {
    const legacyKeys = Object.keys(TX_RETRY_DEFAULTS).sort();
    const venueOnly = Object.keys(BROADCAST_DEFAULTS)
      .filter((key) => !legacyKeys.includes(key))
      .sort();
    expect(venueOnly).toEqual(['lockLeaseMs']);
  });
});
