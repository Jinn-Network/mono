/**
 * x402 artifact acquisition — fetches remote content with payment.
 *
 * Post jinn-mono-vy37.1.2: keys artifacts by sha256 (not IPFS CID). The
 * server returns raw bytes; the consumer hashes them locally to verify
 * integrity against the envelope's `artifact.sha256` field.
 */

type Hex = `0x${string}`;

export function buildAcquisitionUrl(endpoint: string, sha256: string): string {
  return `${endpoint.replace(/\/$/, '')}/v1/artifacts/${sha256}/content`;
}

export async function acquireArtifactWithPayment(
  endpoint: string,
  sha256: string,
  privateKey: string,
): Promise<Buffer | null> {
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
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    return buf;
  } catch (err) {
    console.error(`[x402] Failed to acquire artifact ${sha256}:`, err);
    return null;
  }
}
