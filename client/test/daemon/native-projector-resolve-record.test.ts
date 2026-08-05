import { describe, expect, it, vi } from 'vitest';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import type { ObservationMarketplaceEvent } from '@jinn-network/marketplace-projector';
import { buildNativeResolveRecord } from '../../src/daemon/composition-root.js';

const TASK_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SUBMISSION = new TextEncoder().encode('{"protocol":"https://spec.jinn.network/profiles/task-execution/v1"}');

function event(): ObservationMarketplaceEvent {
  return {
    event: 'TaskCreated',
    facts: { taskId: 9n },
    derivation: { chainId: 84532 },
    projection: {
      taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      taskDigest: TASK_DIGEST,
    },
  } as ObservationMarketplaceEvent;
}

describe('native projector submission resolution', () => {
  it('uses only the exact canonical association lookup for submission records', async () => {
    const lookup = vi.fn(async () => SUBMISSION);
    const resolveRecord = buildNativeResolveRecord(BASE_SEPOLIA_TODAY, lookup);

    await expect(resolveRecord(event(), 'submission')).resolves.toEqual({
      kind: 'https://spec.jinn.network/records/submission/v1',
      bytes: SUBMISSION,
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith({
      chainId: 84532,
      coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      taskId: 9n,
      taskDigest: TASK_DIGEST,
    });
  });

  it('rejects other roles and mismatched native projection coordinates rather than falling back', async () => {
    const lookup = vi.fn(async () => SUBMISSION);
    const resolveRecord = buildNativeResolveRecord(BASE_SEPOLIA_TODAY, lookup);

    await expect(resolveRecord(event(), 'delivery')).rejects.toThrow(/no production implementation/i);
    await expect(resolveRecord({
      ...event(),
      projection: { ...event().projection, taskCoordinator: '0x1111111111111111111111111111111111111111' },
    }, 'submission')).rejects.toThrow(/canonical Base Sepolia coordinator/i);
    expect(lookup).toHaveBeenCalledTimes(0);
  });
});
