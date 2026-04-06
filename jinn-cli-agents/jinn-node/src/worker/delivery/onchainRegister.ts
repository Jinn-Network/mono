/**
 * ERC-8004 On-Chain Registration
 *
 * After delivery succeeds, register each artifact's Registration File
 * on the ERC-8004 Identity Registry. This makes documents discoverable
 * by any third-party indexer.
 *
 * Registration is best-effort — failures don't affect delivery.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { secrets, createRpcProvider } from '../../config/index.js';
import { getServicePrivateKey } from '../../env/operate-profile.js';

const log = workerLogger.child({ component: 'ONCHAIN_REGISTER' });

const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

const IDENTITY_REGISTRY_ABI = [
  'function register(string tokenUri) returns (uint256 agentId)',
];

interface ArtifactForRegistration {
  cid: string;          // Registration File CID
  contentCid?: string;  // Raw content CID
  documentType?: string;
}

/**
 * Register artifacts on the ERC-8004 Identity Registry.
 * Best-effort: logs errors but never throws.
 */
export async function registerArtifactsOnChain(
  artifacts: ArtifactForRegistration[],
): Promise<void> {
  const registrable = artifacts.filter((a) => a.documentType && a.cid);
  if (registrable.length === 0) return;

  const privateKey = getServicePrivateKey();
  if (!privateKey) {
    log.debug('No private key available — skipping on-chain registration');
    return;
  }

  const rpcUrl = secrets.rpcUrl;
  if (!rpcUrl) {
    log.debug('No RPC URL available — skipping on-chain registration');
    return;
  }

  const provider = createRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const identityRegistry = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ABI, wallet);

  for (const artifact of registrable) {
    try {
      const tokenUri = `ipfs://${artifact.cid}`;

      log.info({ cid: artifact.cid, documentType: artifact.documentType }, 'Registering artifact on Identity Registry');

      const tx = await identityRegistry.register(tokenUri);
      const receipt = await tx.wait();

      log.info(
        { cid: artifact.cid, txHash: receipt.hash, blockNumber: receipt.blockNumber },
        'Artifact registered on-chain'
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ cid: artifact.cid, error: message }, 'Failed to register artifact on-chain (non-fatal)');
    }
  }
}
