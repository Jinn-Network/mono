import {
  encodeFunctionData,
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Log,
} from 'viem';
import { MECH_MARKETPLACE_ABI, MECH_ABI, NATIVE_PAYMENT_TYPE } from './types.js';
import { executeSafeTransaction } from './safe.js';

export async function submitMarketplaceRequest(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  marketplaceAddress: Address,
  mechAddress: Address,
  requestDataHex: Hex,
  priceWei: bigint,
  responseTimeout: bigint,
): Promise<string[]> {
  const calldata = encodeFunctionData({
    abi: MECH_MARKETPLACE_ABI,
    functionName: 'request',
    args: [requestDataHex, priceWei, NATIVE_PAYMENT_TYPE, mechAddress, responseTimeout, '0x' as Hex],
  });

  const txHash = await executeSafeTransaction(publicClient, walletClient, {
    safeAddress,
    to: marketplaceAddress,
    value: priceWei,
    data: calldata,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const requestIds: string[] = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: MECH_MARKETPLACE_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'MarketplaceRequest') {
        const ids = (decoded.args as { requestIds: readonly Hex[] }).requestIds;
        requestIds.push(...ids.map(String));
      }
    } catch {
      // Not our event
    }
  }

  return requestIds;
}

export async function getMechDeliveryRate(
  publicClient: PublicClient,
  mechAddress: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: mechAddress,
    abi: MECH_ABI,
    functionName: 'maxDeliveryRate',
  }) as Promise<bigint>;
}

export async function getTimeoutBounds(
  publicClient: PublicClient,
  marketplaceAddress: Address,
): Promise<{ min: bigint; max: bigint }> {
  const [min, max] = await Promise.all([
    publicClient.readContract({
      address: marketplaceAddress,
      abi: MECH_MARKETPLACE_ABI,
      functionName: 'minResponseTimeout',
    }) as Promise<bigint>,
    publicClient.readContract({
      address: marketplaceAddress,
      abi: MECH_MARKETPLACE_ABI,
      functionName: 'maxResponseTimeout',
    }) as Promise<bigint>,
  ]);
  return { min, max };
}

export async function pollDeliverEvents(
  publicClient: PublicClient,
  mechAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  return publicClient.getLogs({
    address: mechAddress,
    fromBlock,
    toBlock,
  });
}

// ── Event decoding helpers ───────────────────────────────────────────────────

export interface DecodedMarketplaceRequest {
  requestId: string;
  requestDataHex: string;
}

export function decodeMarketplaceRequestLogs(logs: Log[]): DecodedMarketplaceRequest[] {
  const results: DecodedMarketplaceRequest[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: MECH_MARKETPLACE_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'MarketplaceRequest') {
        const args = decoded.args as {
          requestIds: readonly Hex[];
          requestDatas: readonly Hex[];
        };
        for (let i = 0; i < args.requestIds.length; i++) {
          results.push({
            requestId: String(args.requestIds[i]),
            requestDataHex: String(args.requestDatas[i]),
          });
        }
      }
    } catch {
      // Not a MarketplaceRequest event — skip
    }
  }
  return results;
}

export interface DecodedDeliverEvent {
  requestId: string;
  deliveryDataHex: string;
  mechAddress: string;
}

export function decodeDeliverLogs(logs: Log[]): DecodedDeliverEvent[] {
  const results: DecodedDeliverEvent[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: MECH_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'Deliver') {
        const args = decoded.args as {
          mech: Address;
          mechServiceMultisig: Address;
          requestId: Hex;
          deliveryRate: bigint;
          data: Hex;
        };
        results.push({
          requestId: String(args.requestId),
          deliveryDataHex: String(args.data),
          mechAddress: String(args.mechServiceMultisig),
        });
      }
    } catch {
      // Not a Deliver event — skip
    }
  }
  return results;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export async function callDeliverToMarketplace(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  mechContractAddress: Address,
  requestIds: Hex[],
  datas: Hex[],
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: MECH_ABI,
    functionName: 'deliverToMarketplace',
    args: [requestIds, datas],
  });

  return executeSafeTransaction(publicClient, walletClient, {
    safeAddress,
    to: mechContractAddress,
    value: 0n,
    data: calldata,
  });
}
