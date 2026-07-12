import { decodeEventLog, getAddress, type Hex, type TransactionReceipt } from 'viem';
import {
  EVENT_TOPICS,
  IDENTITY_REGISTRY_ABI,
  SERVICE_REGISTRY_L2_ABI,
} from '../contracts.js';

export async function parseServiceIdFromReceipt(
  receipt: TransactionReceipt,
  serviceRegistry: string,
): Promise<number | null> {
  const createServiceTopic = EVENT_TOPICS.CreateService;
  const serviceRegistryAddress = serviceRegistry.toLowerCase();

  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== serviceRegistryAddress ||
      log.topics[0] !== createServiceTopic
    ) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: SERVICE_REGISTRY_L2_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: false,
      });
      if (decoded.eventName === 'CreateService' && 'serviceId' in decoded.args) {
        return Number(decoded.args.serviceId);
      }
    } catch {
      // Not a matching event
    }
  }
  return null;
}

export function parseMultisigFromReceipt(receipt: TransactionReceipt): string | null {
  const topic = EVENT_TOPICS.CreateMultisigWithAgents;
  for (const log of receipt.logs) {
    const t0 = log.topics[0];
    if (t0 === topic && log.topics.length >= 3) {
      return getAddress(('0x' + log.topics[2]!.slice(26)) as Hex);
    }
  }
  return null;
}

/**
 * Extract `agentId` from an `IdentityRegistry.Registered` log emitted in
 * the receipt. Filters by `(address, topic[0])` first to avoid colliding
 * with any other contract that happens to share the event signature.
 *
 * Returns the agentId as a decimal string (uint256) so it round-trips
 * cleanly through JSON-persisted EarningState.
 */
export function parseAgentIdFromReceipt(
  receipt: TransactionReceipt,
  identityRegistry: string,
): string | null {
  const topic = EVENT_TOPICS.Registered;
  const target = identityRegistry.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== target) continue;
    if (log.topics[0] !== topic) continue;
    try {
      const decoded = decodeEventLog({
        abi: IDENTITY_REGISTRY_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: false,
      });
      if (decoded.eventName === 'Registered' && 'agentId' in decoded.args) {
        return (decoded.args.agentId as bigint).toString();
      }
    } catch {
      // Not a matching event
    }
  }
  return null;
}
