import { flattenErrorMessage } from './tx-retry.js';
import { rpcHostForDisplay } from './preflight/rpc-network.js';

export interface RpcErrorContext {
  operation: string;
  rpcUrl?: string;
  chain?: 'base' | 'base-sepolia' | string;
  address?: string;
  contract?: string;
  fromBlock?: bigint | number | string;
  toBlock?: bigint | number | string;
}

function blockValue(value: bigint | number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value);
}

export function formatRpcError(error: unknown, context: RpcErrorContext): string {
  const parts = [`operation=${context.operation}`];
  if (context.chain) parts.push(`chain=${context.chain}`);
  if (context.rpcUrl) parts.push(`rpc=${rpcHostForDisplay(context.rpcUrl)}`);
  if (context.contract) parts.push(`contract=${context.contract}`);
  if (context.address) parts.push(`address=${context.address}`);
  const from = blockValue(context.fromBlock);
  const to = blockValue(context.toBlock);
  if (from !== undefined || to !== undefined) {
    parts.push(`blocks=${from ?? '?'}..${to ?? '?'}`);
  }
  parts.push(`cause=${flattenErrorMessage(error)}`);
  return parts.join(' ');
}
