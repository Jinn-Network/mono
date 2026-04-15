// @ts-nocheck
import 'dotenv/config';
import { Web3 } from 'web3';
import safeAbi from '@jinn-network/mech-client-ts/dist/abis/GnosisSafe_v1.3.0.json' assert { type: 'json' };
import { getServiceSafeAddress, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';

async function main() {
  const rpc = process.env.RPC_URL || process.env.MECHX_CHAIN_RPC || process.env.MECH_RPC_HTTP_URL;
  const safe = getServiceSafeAddress();
  const pkRaw = getServicePrivateKey();
  if (!rpc || !safe) {
    console.error('Missing RPC_URL (or MECHX_CHAIN_RPC/MECH_RPC_HTTP_URL) or safe address from .operate profile');
    process.exit(1);
  }
  const pk = pkRaw && (pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`);
  const web3 = new Web3(rpc);
  const signer = pk ? web3.eth.accounts.privateKeyToAccount(pk).address : undefined;

  const contract = new web3.eth.Contract(safeAbi as any, safe);
  const [owners, threshold] = await Promise.all([
    contract.methods.getOwners().call(),
    contract.methods.getThreshold().call(),
  ]);

  const isOwner = signer ? owners.map((o: string) => o.toLowerCase()).includes(signer.toLowerCase()) : undefined;
  
  const sanitize = (v: any) => (typeof v === 'bigint' ? v.toString() : v);
  const out = {
    rpc,
    safe,
    signer,
    owners: owners.map((o: any) => sanitize(o)),
    threshold: sanitize(threshold),
    isOwner,
  } as any;
  console.log(JSON.stringify(out, null, 2));

}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
