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

export async function requestTestnetFunding(
  address: string,
  network: 'base-sepolia',
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
      token: 'eth',
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
