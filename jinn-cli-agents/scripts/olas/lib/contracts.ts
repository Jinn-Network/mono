import { ethers } from 'ethers';
import { MAINNET, RPC } from './addresses.js';

const mainnetProvider = new ethers.JsonRpcProvider(RPC.mainnet);

export function getVoteWeighting() {
  return new ethers.Contract(
    MAINNET.voteWeighting,
    [
      'function getWeightsSum() view returns (uint256)',
      'function getNomineeWeight(bytes32 account, uint256 chainId) view returns (uint256)',
      'function nomineeRelativeWeightWrite(bytes32 account, uint256 chainId, uint256 time) returns (uint256 relativeWeight, uint256 totalSum)',
      'function getAllNominees() view returns (tuple(bytes32 account, uint256 chainId)[])',
      'function voteUserPower(address) view returns (uint256)',
    ],
    mainnetProvider
  );
}

export function getVeOLAS() {
  return new ethers.Contract(
    MAINNET.veOLAS,
    [
      // balanceOf returns effective veOLAS (time-decayed)
      // Note: locked() has non-standard Vyper ABI - avoid using it
      'function balanceOf(address) view returns (uint256)',
    ],
    mainnetProvider
  );
}

export function getTokenomics() {
  return new ethers.Contract(
    MAINNET.tokenomics,
    [
      'function epochCounter() view returns (uint32)',
      'function epochLen() view returns (uint32)',
      'function inflationPerSecond() view returns (uint96)',
      // Returns: [stakingAmount, maxStakingIncentive, minStakingWeight, ...]
      // Note: field names in contract don't match intuitive names - use positional access
      'function mapEpochStakingPoints(uint256 epoch) view returns (uint256, uint256, uint256, uint256)',
    ],
    mainnetProvider
  );
}

export function getDispenser() {
  return new ethers.Contract(
    MAINNET.dispenser,
    [
      'function mapLastClaimedStakingEpochs(bytes32 nomineeHash) view returns (uint256)',
    ],
    mainnetProvider
  );
}
