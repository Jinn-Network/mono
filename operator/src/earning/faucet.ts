/**
 * Coinbase CDP faucet integration for automatic Base Sepolia testnet funding.
 *
 * SECURITY: The shipped default API key grants testnet faucet access ONLY.
 * No mainnet access, no wallet control, no financial risk.
 *
 * KEY ROTATION: Change the constants below and publish a new npm version.
 */

// Jinn project CDP secret API key pair — testnet faucet access only
const JINN_DEFAULT_CDP_API_KEY_ID = 'b743bfce-7f46-4e8e-ba04-0993b2c4908e';
const JINN_DEFAULT_CDP_API_KEY_SECRET = 'lrGwqLwt3tX8/UIPHK4/AlM7TtqyGYXypXs/HqA3ORDCBgjLemJHhA40gmBNj0uK9PCAKaXlbhgFKuxAT/MfVw==';

const MANUAL_FAUCET_URL = 'https://portal.cdp.coinbase.com/products/faucet';

export interface FaucetResult {
  ok: boolean;
  txHash?: string;
  reason?: string;
  rateLimited?: boolean;
}

/**
 * Conservative estimate for one CDP drip (~0.0001 ETH). Used to size the drip
 * loop cap so it can actually reach the bootstrap target.
 */
export const ESTIMATED_DRIP_WEI = 100_000_000_000_000n;

/**
 * Default wall-clock safety cutoff for faucet drip loops. Real loops should
 * exit on success, rate-limit, or this deadline, whichever comes first.
 */
export const DEFAULT_FAUCET_LOOP_TIMEOUT_MS = 5 * 60 * 1000;

export interface ComputeFaucetDripCapInput {
  /** Bootstrap target (wei) the drip loop is trying to reach. */
  targetWei?: bigint | null;
  /** Current balance (wei) at the start of the loop. */
  balanceWei?: bigint | null;
  /** Explicit override; bypasses the calculation entirely when provided. */
  override?: number;
  /** Lower bound: preserves the historical 60-drip cap for callers without a target. */
  floor?: number;
  /** Upper bound: prevents runaway loops if estimates are wrong. */
  ceiling?: number;
}

/**
 * Compute the maximum number of faucet drip iterations needed to clear
 * `targetWei` from `balanceWei`, given a conservative per-drip estimate.
 *
 * The cap is a safety bound, not the target. The loop still exits when the
 * balance reaches the target, the faucet rate-limits, or the wall-clock
 * deadline elapses.
 */
export function computeFaucetDripCap(input: ComputeFaucetDripCapInput): number {
  const floor = input.floor ?? 60;
  const ceiling = input.ceiling ?? 500;
  if (typeof input.override === 'number') {
    return Math.max(0, Math.floor(input.override));
  }
  const target = input.targetWei ?? null;
  if (target === null || target <= 0n) {
    return floor;
  }
  const balance = input.balanceWei ?? 0n;
  const remaining = target - balance;
  if (remaining <= 0n) {
    return floor;
  }
  const estimatedDrips = remaining / ESTIMATED_DRIP_WEI;
  const computed = Number(estimatedDrips * 2n) + 20;
  return Math.max(floor, Math.min(ceiling, computed));
}

export async function requestTestnetFunding(
  address: string,
  network: 'base-sepolia',
  token: 'eth' | 'usdc' = 'eth',
): Promise<FaucetResult> {
  const envApiKeyId = process.env['CDP_API_KEY_ID'];
  const envApiKeySecret = process.env['CDP_API_KEY_SECRET'];
  const hasEnvPair = Boolean(envApiKeyId && envApiKeySecret);

  // Resolve credential pair: complete env override > shipped default pair
  const apiKeyId = hasEnvPair ? envApiKeyId! : JINN_DEFAULT_CDP_API_KEY_ID;
  const apiKeySecret = hasEnvPair ? envApiKeySecret! : JINN_DEFAULT_CDP_API_KEY_SECRET;

  // Warn on partial override
  if ((envApiKeyId && !envApiKeySecret) || (!envApiKeyId && envApiKeySecret)) {
    console.error('[faucet] Warning: Only one of CDP_API_KEY_ID/CDP_API_KEY_SECRET is set. Using shipped defaults.');
  }

  // Dynamic import — SDK is optional
  let CdpClient: any;
  try {
    const mod = await import('@coinbase/cdp-sdk');
    CdpClient = mod.CdpClient;
  } catch {
    return {
      ok: false,
      reason: `Coinbase CDP SDK not installed. Install with: npm install @coinbase/cdp-sdk\nOr fund manually: ${MANUAL_FAUCET_URL}`,
    };
  }

  try {
    const clientOpts: Record<string, string> = { apiKeyId, apiKeySecret };
    const cdp = new CdpClient(clientOpts);
    const result = await cdp.evm.requestFaucet({
      address,
      network,
      token,
    });
    return { ok: true, txHash: result.transactionHash ?? String(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isRateLimit = message.toLowerCase().includes('rate limit') ||
                        message.toLowerCase().includes('already claimed') ||
                        message.includes('429');
    if (isRateLimit) {
      return {
        ok: false,
        rateLimited: true,
        reason: `Faucet rate limited (1 claim per 24 hours per address). Fund manually: ${MANUAL_FAUCET_URL}`,
      };
    }
    return {
      ok: false,
      reason: `Faucet error: ${message}. Fund manually: ${MANUAL_FAUCET_URL}`,
    };
  }
}
