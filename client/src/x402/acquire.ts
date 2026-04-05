/**
 * x402 artifact acquisition — fetches remote content with payment.
 * Ported from protocol/src/discovery/acquire.ts.
 */

type Hex = `0x${string}`;

export function buildAcquisitionUrl(endpoint: string, artifactId: string): string {
  return `${endpoint.replace(/\/$/, '')}/x402/artifacts/${artifactId}/content`;
}

export async function acquireArtifactWithPayment(
  endpoint: string,
  artifactId: string,
  privateKey: string,
): Promise<string | null> {
  const url = buildAcquisitionUrl(endpoint, artifactId);
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
    const body = (await response.json()) as { content?: string };
    return body.content ?? null;
  } catch (err) {
    console.error(`[x402] Failed to acquire artifact ${artifactId}:`, err);
    return null;
  }
}
