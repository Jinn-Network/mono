import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const provider = new ethers.JsonRpcProvider(RPC_URL);

const SERVICE_ID = 165;
const CONTRACTS = {
  SERVICE_REGISTRY: '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE',
  SERVICE_REGISTRY_TOKEN_UTILITY: '0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5',
  OLAS_TOKEN: '0x54330d28ca3357F294334BDC454a032e7f353416',
  AGENTSFUN1: '0x2585e63df7BD9De8e058884D496658a030b5c6ce',
  JINN: '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139',
  MASTER_SAFE: '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645',
  MASTER_EOA: '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2',
};

const SERVICE_REGISTRY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getService(uint256 serviceId) view returns (tuple(uint96 securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state))',
];

const TOKEN_UTILITY_ABI = [
  'function mapServiceIdTokenDeposit(uint256 serviceId) view returns (uint256 securityDeposit, address token)',
];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
];

const STAKING_ABI = [
  'function getServiceIds() view returns (uint256[])',
  'function minStakingDeposit() view returns (uint256)',
];

async function check() {
  console.log('=== Post-Unstake Status Check ===\n');

  const registry = new ethers.Contract(CONTRACTS.SERVICE_REGISTRY, SERVICE_REGISTRY_ABI, provider);
  const tokenUtility = new ethers.Contract(CONTRACTS.SERVICE_REGISTRY_TOKEN_UTILITY, TOKEN_UTILITY_ABI, provider);
  const olas = new ethers.Contract(CONTRACTS.OLAS_TOKEN, ERC20_ABI, provider);
  const agentsfun = new ethers.Contract(CONTRACTS.AGENTSFUN1, STAKING_ABI, provider);
  const jinn = new ethers.Contract(CONTRACTS.JINN, STAKING_ABI, provider);

  // NFT Owner
  const owner = await registry.ownerOf(SERVICE_ID);
  console.log('NFT Owner:', owner);
  console.log('  Is Master Safe:', owner.toLowerCase() === CONTRACTS.MASTER_SAFE.toLowerCase());

  // Service state
  try {
    const service = await registry.getService(SERVICE_ID);
    console.log('\nService Info:');
    console.log('  State:', service.state, '(1=PreReg 2=ActiveReg 3=FinishedReg 4=Deployed 5=TerminatedBonded)');
    console.log('  Security Deposit:', ethers.formatEther(service.securityDeposit), 'OLAS');
    console.log('  Multisig:', service.multisig);
    console.log('  Threshold:', service.threshold.toString());
    console.log('  Num Agents:', service.numAgentInstances.toString(), '/', service.maxNumAgentInstances.toString());
  } catch (e: any) {
    console.log('\nService Info: failed -', e.message?.slice(0, 100));
  }

  // Token utility bond
  try {
    const [bond, token] = await tokenUtility.mapServiceIdTokenDeposit(SERVICE_ID);
    console.log('\nToken Utility Bond:', ethers.formatEther(bond), 'OLAS');
    console.log('  Token:', token);
  } catch (e: any) {
    console.log('\nToken Utility Bond: failed -', e.message?.slice(0, 100));
  }

  // OLAS balances
  const safeBal = await olas.balanceOf(CONTRACTS.MASTER_SAFE);
  const eoaBal = await olas.balanceOf(CONTRACTS.MASTER_EOA);
  console.log('\nOLAS Balances:');
  console.log('  Master Safe:', ethers.formatEther(safeBal));
  console.log('  Master EOA:', ethers.formatEther(eoaBal));

  // ETH balances
  const safeEth = await provider.getBalance(CONTRACTS.MASTER_SAFE);
  const eoaEth = await provider.getBalance(CONTRACTS.MASTER_EOA);
  console.log('\nETH Balances:');
  console.log('  Master Safe:', ethers.formatEther(safeEth));
  console.log('  Master EOA:', ethers.formatEther(eoaEth));

  // Staking status
  const agentsfunIds = await agentsfun.getServiceIds();
  const jinnIds = await jinn.getServiceIds();
  console.log('\nStaking:');
  console.log('  AgentsFun1:', agentsfunIds.map((id: bigint) => id.toString()).join(', '));
  console.log('  Jinn:', jinnIds.map((id: bigint) => id.toString()).join(', ') || '(empty)');
  console.log('  In AgentsFun1:', agentsfunIds.includes(BigInt(SERVICE_ID)));
  console.log('  In Jinn:', jinnIds.includes(BigInt(SERVICE_ID)));

  // Jinn min stake
  const jinnMin = await jinn.minStakingDeposit();
  console.log('\nJinn Min Stake:', ethers.formatEther(jinnMin));
}

check().catch(e => { console.error('Error:', e.message); process.exit(1); });
