#!/usr/bin/env tsx
/**
 * Generate calldata for veOLAS staking votes on VoteWeighting contract.
 * Two transactions:
 *   1. Remove weight from old Jinn v1 contract
 *   2. Allocate weight to new Jinn v2 contract
 */
import { ethers } from "ethers";

const VOTE_WEIGHTING = "0x95418b46d5566D3d1ea62C12Aea91227E566c5c1";
const BASE_CHAIN_ID = 8453;

const OLD_STAKING = "0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139"; // v1, nominee #25
const NEW_STAKING = "0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488"; // v2, nominee #60

// Address -> bytes32 (left-padded)
function addressToBytes32(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

function main() {
  const iface = new ethers.Interface([
    "function voteForNomineeWeights(bytes32 account, uint256 chainId, uint256 weight)",
  ]);

  const oldBytes32 = addressToBytes32(OLD_STAKING);
  const newBytes32 = addressToBytes32(NEW_STAKING);

  // TX 1: Remove weight from old contract (weight = 0)
  const calldata1 = iface.encodeFunctionData("voteForNomineeWeights", [
    oldBytes32, BASE_CHAIN_ID, 0,
  ]);

  // TX 2: Allocate 100% to new contract (weight = 10000 = 100%)
  const calldata2 = iface.encodeFunctionData("voteForNomineeWeights", [
    newBytes32, BASE_CHAIN_ID, 10000,
  ]);

  console.log("VoteWeighting Contract: " + VOTE_WEIGHTING);
  console.log("Chain: Ethereum mainnet (1)");
  console.log("");

  console.log("== TX 1: Remove weight from old Jinn v1 ==");
  console.log("To: " + VOTE_WEIGHTING);
  console.log("Value: 0");
  console.log("Data: " + calldata1);
  console.log("");

  console.log("== TX 2: Allocate 100% to new Jinn v2 ==");
  console.log("To: " + VOTE_WEIGHTING);
  console.log("Value: 0");
  console.log("Data: " + calldata2);
  console.log("");

  console.log("Submit both from your veOLAS wallet on Ethereum mainnet.");
  console.log("You can use Etherscan Write Contract or a Safe Transaction Builder.");
  console.log("");
  console.log("Etherscan: https://etherscan.io/address/" + VOTE_WEIGHTING + "#writeContract");
}

main();
