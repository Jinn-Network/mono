#!/usr/bin/env tsx
/**
 * Query on-chain details for Service #149
 * 
 * This script queries the OLAS ServiceRegistry and ServiceStaking contracts
 * to retrieve the complete configuration of service #149.
 */

import { ethers } from "ethers";
import "dotenv/config";

const SERVICE_REGISTRY_ADDRESS = "0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE"; // Base
const SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS = "0x3d77596beb0f130a4415df3D2D8232B3d3D31e44"; // Base
const STAKING_CONTRACT_ADDRESS = "0x2585e63df7BD9De8e058884D496658a030b5c6ce"; // AgentsFun1

const SERVICE_ID = 149;

// ABI fragments (corrected based on actual contract)
const SERVICE_REGISTRY_ABI = [
  "function mapServices(uint256 serviceId) view returns (tuple(address securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state, uint32[] agentIds))",
  "function getAgentParams(uint256 serviceId) view returns (uint32 numAgentIds, tuple(uint32 slots, uint96 bond)[] agentParams)",
  "function getInstancesForAgentId(uint256 serviceId, uint256 agentId) view returns (address[])",
  "function exists(uint256 serviceId) view returns (bool)",
];

const SERVICE_REGISTRY_TOKEN_UTILITY_ABI = [
  "function mapServiceIdTokenDeposit(uint256 serviceId) view returns (address, uint96)",
  "function getOperatorBalance(address operator, uint256 serviceId) view returns (uint96)",
];

const STAKING_CONTRACT_ABI = [
  "function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256 nonce, uint256 tsStart, uint256 reward, uint256 inactivity) sInfo)",
  "function getStakingState(uint256 serviceId) view returns (uint8)",
];

async function queryServiceDetails() {
  const rpcUrl = process.env.BASE_LEDGER_RPC || "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  console.log("🔍 Querying Service #149 Details from Base Mainnet");
  console.log("=" .repeat(80));
  console.log();

  // Connect to contracts
  const serviceRegistry = new ethers.Contract(
    SERVICE_REGISTRY_ADDRESS,
    SERVICE_REGISTRY_ABI,
    provider
  );

  const tokenUtility = new ethers.Contract(
    SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS,
    SERVICE_REGISTRY_TOKEN_UTILITY_ABI,
    provider
  );

  const stakingContract = new ethers.Contract(
    STAKING_CONTRACT_ADDRESS,
    STAKING_CONTRACT_ABI,
    provider
  );

  try {
    // 1. Get service state and configuration
    console.log("📋 Service Registry Information:");
    console.log("-".repeat(80));
    
    const serviceData = await serviceRegistry.mapServices(SERVICE_ID);
    console.log(`Security Deposit: ${serviceData.securityDeposit}`);
    console.log(`Multisig (Safe): ${serviceData.multisig}`);
    console.log(`Config Hash: ${serviceData.configHash}`);
    console.log(`Threshold: ${serviceData.threshold}`);
    console.log(`Max Agent Instances: ${serviceData.maxNumAgentInstances}`);
    console.log(`Current Agent Instances: ${serviceData.numAgentInstances}`);
    console.log(`Service State: ${serviceData.state} (4 = DEPLOYED_AND_STAKED)`);
    console.log(`Agent IDs: ${serviceData.agentIds.map((id: bigint) => id.toString())}`);
    console.log();

    // 2. Get agent parameters
    console.log("🤖 Agent Configuration:");
    console.log("-".repeat(80));
    
    const agentParams = await serviceRegistry.getAgentParams(SERVICE_ID);
    console.log(`Number of Agent Types: ${agentParams.numAgentIds}`);
    for (let i = 0; i < agentParams.agentParams.length; i++) {
      const param = agentParams.agentParams[i];
      console.log(`  Agent ${serviceData.agentIds[i]}:`);
      console.log(`    Slots: ${param.slots}`);
      console.log(`    Bond: ${ethers.formatEther(param.bond)} OLAS`);
    }
    console.log();

    // 3. Get agent instances (the actual agent addresses)
    console.log("🔑 Agent Instance Addresses:");
    console.log("-".repeat(80));
    
    for (let i = 0; i < serviceData.agentIds.length; i++) {
      const agentId = serviceData.agentIds[i];
      const instances = await serviceRegistry.getInstancesForAgentId(SERVICE_ID, agentId);
      console.log(`Agent ${agentId} instances: ${instances.join(", ")}`);
    }
    console.log();

    // 4. Get token deposit information
    console.log("💰 Token Deposit Information:");
    console.log("-".repeat(80));
    
    const depositInfo = await tokenUtility.mapServiceIdTokenDeposit(SERVICE_ID);
    console.log(`Token Address: ${depositInfo[0]}`);
    console.log(`Deposit Amount: ${ethers.formatEther(depositInfo[1])} OLAS`);
    console.log();

    // 5. Get operator balance (bond)
    console.log("🔐 Operator Balance:");
    console.log("-".repeat(80));
    
    const operatorBalance = await tokenUtility.getOperatorBalance(
      serviceData.multisig,
      SERVICE_ID
    );
    console.log(`Bond Amount: ${ethers.formatEther(operatorBalance)} OLAS`);
    console.log();

    // 6. Get staking information
    console.log("🎯 Staking Information:");
    console.log("-".repeat(80));
    
    const stakingInfo = await stakingContract.getServiceInfo(SERVICE_ID);
    const stakingState = await stakingContract.getStakingState(SERVICE_ID);
    
    console.log(`Staking Multisig: ${stakingInfo.multisig}`);
    console.log(`Owner: ${stakingInfo.owner}`);
    console.log(`Nonce: ${stakingInfo.nonce}`);
    console.log(`Staking Start Time: ${new Date(Number(stakingInfo.tsStart) * 1000).toISOString()}`);
    console.log(`Accumulated Reward: ${ethers.formatEther(stakingInfo.reward)} OLAS`);
    console.log(`Inactivity: ${stakingInfo.inactivity}`);
    console.log(`Staking State: ${stakingState} (1 = STAKED)`);
    console.log();

    // 7. Generate middleware config structure
    console.log("⚙️  Middleware Config Structure:");
    console.log("-".repeat(80));
    
    const config = {
      service_id: SERVICE_ID,
      safe_address: serviceData.multisig,
      agent_addresses: [],
      token: SERVICE_ID,
      state: "deployed_and_staked",
      staking_program: "agents_fun_1",
      staking_contract: STAKING_CONTRACT_ADDRESS,
      bond_amount: ethers.formatEther(operatorBalance),
      deposit_amount: ethers.formatEther(depositInfo[1]),
      agent_ids: serviceData.agentIds.map((id: bigint) => id.toString()),
    };

    console.log(JSON.stringify(config, null, 2));
    console.log();

    // 8. Identify which agent key from /.operate/keys/ was used
    console.log("🔎 Next Steps:");
    console.log("-".repeat(80));
    console.log("To find the agent key used for this service:");
    console.log("1. The agent instance addresses above are in /.operate/keys/");
    console.log("2. Check: ls -la olas-operate-middleware/.operate/keys/");
    console.log("3. Match the instance address to a key file");
    console.log();
    console.log("To recreate the middleware config:");
    console.log("1. Create a new service directory: sc-service-149-recovered");
    console.log("2. Copy a template config.json from another service");
    console.log("3. Update it with the values above");
    console.log("4. Ensure the agent_addresses field contains the instance address");

  } catch (error) {
    console.error("❌ Error querying service details:");
    console.error(error);
    process.exit(1);
  }
}

queryServiceDetails();
