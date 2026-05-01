/**
 * x402 artifact acquisition — fetches remote content with payment.
 *
 * Post jinn-mono-vy37.1.2: keys artifacts by sha256 (not IPFS CID). The
 * server returns raw bytes; the consumer hashes them locally to verify
 * integrity against the envelope's `artifact.sha256` field.
 */

type Hex = `0x${string}`;

export type AcquireWithPaymentResult =
  | { ok: true; content: Buffer }
  | { ok: false; reason: 'not_found' | 'payment_failed' | 'network_error'; message?: string };

export function buildAcquisitionUrl(endpoint: string, sha256: string): string {
  return `${endpoint.replace(/\/$/, '')}/v1/artifacts/${sha256}/content`;
}

export async function acquireArtifactWithPayment(
  endpoint: string,
  sha256: string,
  privateKey: string,
): Promise<AcquireWithPaymentResult> {
  const url = buildAcquisitionUrl(endpoint, sha256);
  try {
    const { wrapFetchWithPayment, x402Client } = await import('@x402/fetch');
    const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
    const { toClientEvmSigner } = await import('@x402/evm');
    const { privateKeyToAccount } = await import('viem/accounts');

    const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
    const account = privateKeyToAccount(pk);
    const signer = toClientEvmSigner({ ...account, address: account.address as `0x${string}` });

    const client = new x402Client();
    registerExactEvmScheme(client, { signer });

    const payFetch = wrapFetchWithPayment(globalThis.fetch, client);
    const response = await payFetch(url);
    if (!response.ok) {
      // 402 / 403 → payment-related; 404 → missing; everything else → network.
      if (response.status === 404) {
        return { ok: false, reason: 'not_found', message: `HTTP 404 for ${url}` };
      }
      if (response.status === 402 || response.status === 403) {
        return { ok: false, reason: 'payment_failed', message: `HTTP ${response.status} for ${url}` };
      }
      return { ok: false, reason: 'network_error', message: `HTTP ${response.status} for ${url}` };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    return { ok: true, content: buf };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[x402] Failed to acquire artifact ${sha256}:`, err);
    // x402-fetch throws on payment-required loops it can't satisfy; we treat
    // those as payment_failed so the caller can surface a structured error.
    if (/payment|x402|insufficient/i.test(message)) {
      return { ok: false, reason: 'payment_failed', message };
    }
    return { ok: false, reason: 'network_error', message };
  }
}
