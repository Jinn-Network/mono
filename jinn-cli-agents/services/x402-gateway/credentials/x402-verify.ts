/**
 * x402 Payment Verification for Credential Bridge
 *
 * Verifies payment proofs using basic validation (amount, recipient, expiry, network)
 * and optionally cryptographic signature verification via CDP Facilitator.
 *
 * Modes:
 * - Dev mode (X402_DEV_MODE=true): Basic validation only, no CDP credentials needed
 * - Production (CDP_API_KEY_ID/SECRET set): Full verification via facilitator
 */

import { decodePayment } from 'x402/schemes';
import { useFacilitator } from 'x402/verify';
import { facilitator } from '@coinbase/x402';
import type { PaymentPayload, PaymentRequirements } from 'x402/types';

// USDC contract addresses (6 decimals)
const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

export type PaymentErrorCode =
  | 'INVALID_PAYMENT_FORMAT'
  | 'PAYMENT_AMOUNT_INSUFFICIENT'
  | 'PAYMENT_RECIPIENT_MISMATCH'
  | 'PAYMENT_NETWORK_MISMATCH'
  | 'PAYMENT_EXPIRED'
  | 'PAYMENT_SIGNATURE_INVALID'
  | 'FACILITATOR_UNAVAILABLE';

export interface VerifyResult {
  valid: boolean;
  payer?: string;
  error?: { code: PaymentErrorCode; message: string };
}

export interface VerifyPaymentOptions {
  paymentHeader: string;
  requiredAmount: string;
  resource: string;
  payTo: `0x${string}`;
  network: string;
}

/**
 * Verify an x402 payment proof
 *
 * Flow:
 * 1. Decode base64 JSON payment header
 * 2. Basic validation (recipient, amount, expiry, network)
 * 3. If CDP credentials available: full cryptographic verification via facilitator
 * 4. If dev mode: accept after basic validation
 */
export async function verifyPayment(opts: VerifyPaymentOptions): Promise<VerifyResult> {
  const { paymentHeader, requiredAmount, resource, payTo, network } = opts;

  // Step 1: Decode payment header (base64 JSON)
  let payload: PaymentPayload;
  try {
    payload = decodePayment(paymentHeader);
  } catch (err) {
    return {
      valid: false,
      error: {
        code: 'INVALID_PAYMENT_FORMAT',
        message: `Failed to decode payment header: ${err instanceof Error ? err.message : 'invalid format'}`,
      },
    };
  }

  // Step 2: Basic validation (before hitting facilitator)
  // Check this is an EVM payload with authorization
  if (!('authorization' in payload.payload)) {
    return {
      valid: false,
      error: {
        code: 'INVALID_PAYMENT_FORMAT',
        message: 'Expected EVM payment payload with authorization',
      },
    };
  }

  const auth = payload.payload.authorization;

  // Check recipient matches gateway address
  if (auth.to.toLowerCase() !== payTo.toLowerCase()) {
    return {
      valid: false,
      error: {
        code: 'PAYMENT_RECIPIENT_MISMATCH',
        message: `Payment to ${auth.to}, expected ${payTo}`,
      },
    };
  }

  // Check amount is sufficient
  if (BigInt(auth.value) < BigInt(requiredAmount)) {
    return {
      valid: false,
      error: {
        code: 'PAYMENT_AMOUNT_INSUFFICIENT',
        message: `Paid ${auth.value}, need ${requiredAmount}`,
      },
    };
  }

  // Check payment hasn't expired
  const now = Math.floor(Date.now() / 1000);
  const validBefore = parseInt(auth.validBefore, 10);
  if (validBefore < now) {
    return {
      valid: false,
      error: {
        code: 'PAYMENT_EXPIRED',
        message: `Payment expired at ${new Date(validBefore * 1000).toISOString()}`,
      },
    };
  }

  // Check network matches
  if (payload.network !== network) {
    return {
      valid: false,
      error: {
        code: 'PAYMENT_NETWORK_MISMATCH',
        message: `Payment on ${payload.network}, expected ${network}`,
      },
    };
  }

  // Step 3: Check if we should do full verification or accept basic validation
  const devMode = process.env.X402_DEV_MODE === 'true';
  const hasCdpCreds = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);

  if (!hasCdpCreds) {
    if (devMode) {
      console.warn('[x402] DEV MODE: skipping facilitator verification');
      return { valid: true, payer: auth.from };
    }
    return {
      valid: false,
      error: {
        code: 'FACILITATOR_UNAVAILABLE',
        message: 'CDP credentials not configured (set CDP_API_KEY_ID and CDP_API_KEY_SECRET, or enable X402_DEV_MODE)',
      },
    };
  }

  // Step 4: Full verification via CDP facilitator
  const { verify } = useFacilitator(facilitator);
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: network as PaymentRequirements['network'],
    maxAmountRequired: requiredAmount,
    resource,
    description: `Credential access: ${resource}`,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 300,
    asset: USDC_ADDRESSES[network] || USDC_ADDRESSES['base'],
  };

  try {
    const result = await verify(payload, requirements);
    if (!result.isValid) {
      return {
        valid: false,
        error: {
          code: 'PAYMENT_SIGNATURE_INVALID',
          message: `Facilitator rejected: ${result.invalidReason}`,
        },
      };
    }
    return { valid: true, payer: result.payer };
  } catch (err) {
    return {
      valid: false,
      error: {
        code: 'PAYMENT_SIGNATURE_INVALID',
        message: `Facilitator error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Create a mock payment payload for testing
 * Returns base64-encoded JSON that will pass basic validation
 *
 * Note: nonce must be 0x + 64 hex chars (32 bytes) per x402 schema
 */
export function createTestPaymentHeader(opts: {
  from: string;
  to: string;
  value: string;
  network: string;
  validBefore?: number;
}): string {
  // Generate a 32-byte nonce (64 hex chars)
  const nonceBytes = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const nonce = '0x' + nonceBytes.slice(0, 64);

  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: opts.network,
    payload: {
      signature: '0x' + '00'.repeat(65), // Dummy signature (65 bytes)
      authorization: {
        from: opts.from,
        to: opts.to,
        value: opts.value,
        validAfter: '0',
        validBefore: String(opts.validBefore ?? Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}
