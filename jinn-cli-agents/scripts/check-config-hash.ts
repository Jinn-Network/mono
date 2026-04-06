#!/usr/bin/env tsx
import { keccak256, AbiCoder } from "ethers";

async function main() {
  const coder = AbiCoder.defaultAbiCoder();
  const bond = BigInt("5000000000000000000000"); // 5000 OLAS

  // configHash = keccak256(abi.encode(uint32[] agentIds, AgentParams[] agentParams))
  // where AgentParams = (uint32 slots, uint96 bond)
  const encoded = coder.encode(
    ["uint32[]", "tuple(uint32,uint96)[]"],
    [[103], [[1, bond]]]
  );
  const hash = keccak256(encoded);
  console.log("configHash for agent 103, 1 slot, 5000 OLAS bond:");
  console.log(hash);
}

main().catch(e => { console.error(e); process.exit(1); });
