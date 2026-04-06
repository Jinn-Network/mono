/**
 * Tenderly API client - Re-export from jinn-node
 *
 * This module re-exports the Tenderly client from jinn-node for backwards compatibility.
 * The actual implementation is in jinn-node/src/lib/tenderly.ts
 */

export {
  TenderlyClient,
  MockTenderlyClient,
  createTenderlyClient,
  loadTenderlyConfig,
  ethToWei,
  weiToEth,
  type VnetResult,
} from 'jinn-node/lib/tenderly.js';
