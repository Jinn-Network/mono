/**
 * Deterministic Staking Checkpoint Caller
 *
 * Periodically checks if the staking epoch is overdue and calls checkpoint()
 * on the staking contract. checkpoint() is permissionless — any EOA with gas
 * can trigger it. It allocates rewards to eligible services for the past epoch.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getServicePrivateKey } from '../../env/operate-profile.js';
import { config, secrets, createRpcProvider } from '../../config/index.js';

const log = workerLogger.child({ component: 'CHECKPOINT' });

const STAKING_ABI = [
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function checkpoint() external returns (uint256[] memory, uint256[][] memory, uint256[] memory, uint256[] memory, uint256[] memory)',
];

/**
 * Check if checkpoint is overdue and call it if so.
 * Safe to call frequently — it's a no-op if the epoch hasn't ended.
 */
export async function maybeCallCheckpoint(stakingContract: string): Promise<void> {
  const provider = createRpcProvider(secrets.rpcUrl);

  const contract = new ethers.Contract(stakingContract, STAKING_ABI, provider);

  const nextCheckpoint = Number(await contract.getNextRewardCheckpointTimestamp());
  const now = Math.floor(Date.now() / 1000);

  if (now < nextCheckpoint) {
    const remainingSeconds = nextCheckpoint - now;
    log.info({ nextCheckpoint: new Date(nextCheckpoint * 1000).toISOString(), remainingSeconds }, 'Epoch not yet ended, skipping checkpoint');
    return;
  }

  const overdueSeconds = now - nextCheckpoint;
  log.info({ overdueSeconds, nextCheckpoint: new Date(nextCheckpoint * 1000).toISOString() }, 'Epoch overdue, calling checkpoint()');

  const privateKey = getServicePrivateKey();
  if (!privateKey) {
    log.warn('No service private key available, cannot call checkpoint');
    return;
  }

  const wallet = new ethers.Wallet(privateKey, provider);
  const balance = await provider.getBalance(wallet.address);

  if (balance < ethers.parseEther('0.0001')) {
    log.warn({ address: wallet.address, balance: ethers.formatEther(balance) }, 'Insufficient gas balance for checkpoint');
    return;
  }

  const signedContract = contract.connect(wallet) as ethers.Contract;

  const tx = await signedContract.checkpoint();
  log.info({ txHash: tx.hash, caller: wallet.address }, 'Checkpoint transaction sent');

  const receipt = await tx.wait(1);
  if (receipt?.status === 1) {
    log.info({ txHash: tx.hash, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber }, 'Checkpoint successful');
  } else {
    log.error({ txHash: tx.hash }, 'Checkpoint transaction reverted');
  }
}
