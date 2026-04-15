import 'dotenv/config';
import { Web3 } from 'web3';
import agentMechAbi from '@jinn-network/mech-client-ts/dist/abis/AgentMech.json' assert { type: 'json' };
import { getMechAddress, getServiceSafeAddress } from 'jinn-node/env/operate-profile.js';

async function main() {
  const rpc = process.env.RPC_URL || process.env.MECHX_CHAIN_RPC || process.env.MECH_RPC_HTTP_URL;
  const mech = getMechAddress();
  const safe = getServiceSafeAddress();
  if (!rpc || !mech) {
    console.error('Missing RPC_URL (or MECHX_CHAIN_RPC/MECH_RPC_HTTP_URL) or mech address from .operate profile');
    process.exit(1);
  }
  const web3 = new Web3(rpc);
  const code = await web3.eth.getCode(mech);
  const isContract = code && code !== '0x' && code !== '0x0';

  let hasDeliverInAbi = false;
  try {
    hasDeliverInAbi = Array.isArray(agentMechAbi) && agentMechAbi.some((e: any) => e.type === 'function' && e.name === 'deliverToMarketplace');
  } catch {}

  let callResult: string | undefined;
  let callError: string | undefined;
  if (isContract && hasDeliverInAbi) {
    try {
      const c = new web3.eth.Contract(agentMechAbi as any, mech);
      // Static call with empty arrays just to test selector reachability (will likely revert)
      callResult = await c.methods.deliverToMarketplace([], []).call({ from: safe || undefined });
    } catch (e: any) {
      callError = e?.message || String(e);
    }
  }

  console.log(JSON.stringify({ rpc, mech, safe, isContract, hasDeliverInAbi, callResult, callErrorPreview: callError?.slice(0, 200) }, null, 2));
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
