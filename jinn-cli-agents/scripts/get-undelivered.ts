import 'dotenv/config';
import { Web3 } from 'web3';
import artifact from '@jinn-network/mech-client-ts/dist/abis/AgentMech.json' assert { type: 'json' };
import { getMechAddress } from 'jinn-node/env/operate-profile.js';

async function main() {
  const rpc = process.env.RPC_URL || process.env.MECHX_CHAIN_RPC || process.env.MECH_RPC_HTTP_URL;
  const mech = getMechAddress();
  if (!rpc || !mech) {
    console.error('Missing RPC_URL (or MECHX_CHAIN_RPC/MECH_RPC_HTTP_URL) or mech address from .operate profile');
    process.exit(1);
  }
  const abi = (artifact as any).abi || (artifact as any);
  const web3 = new Web3(rpc);
  const c = new web3.eth.Contract(abi as any, mech);
  const size = parseInt(process.env.UND_SIZE || '25', 10);
  const offset = parseInt(process.env.UND_OFFSET || '0', 10);
  const ids: string[] = await c.methods.getUndeliveredRequestIds(size, offset).call();
  // normalize to 0x hex strings
  const out = ids.map((id: any) => (typeof id === 'string' ? id : web3.utils.bytesToHex(id)));
  console.log(JSON.stringify({ count: out.length, requestIds: out }, null, 2));
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
