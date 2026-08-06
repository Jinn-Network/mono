import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileAdoptionReceiptStore } from '../../src/daemon/native-adoption-receipt-store.js';
import type { AdoptionDecision } from '../../src/native-requester/work-client/index.js';

const DECISION: AdoptionDecision = {
  attempt: 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  taskId: '42',
  disposition: 'accepted',
  deliveryDigest: `sha256:${'a'.repeat(64)}`,
  decidedAt: '2026-08-06T12:00:00.000Z',
};

describe('createFileAdoptionReceiptStore', () => {
  it('persists a decision and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-adopt-receipt-'));
    try {
      const store = createFileAdoptionReceiptStore({ dir });
      expect(await store.has('42')).toBe(false);
      await store.publish(DECISION);
      expect(await store.has('42')).toBe(true);
      expect(await store.read('42')).toEqual(DECISION);
      expect(await store.all()).toEqual([DECISION]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent for the same delivery digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-adopt-receipt-idem-'));
    try {
      const store = createFileAdoptionReceiptStore({ dir });
      await store.publish(DECISION);
      await expect(store.publish(DECISION)).resolves.toBeUndefined();
      expect(await store.all()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a task with a divergent delivery digest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-adopt-receipt-divergent-'));
    try {
      const store = createFileAdoptionReceiptStore({ dir });
      await store.publish(DECISION);
      await expect(store.publish({ ...DECISION, deliveryDigest: `sha256:${'b'.repeat(64)}` }))
        .rejects.toThrow(/already records delivery/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-decimal taskId (path-safety)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-adopt-receipt-path-'));
    try {
      const store = createFileAdoptionReceiptStore({ dir });
      await expect(store.publish({ ...DECISION, taskId: '../escape' })).rejects.toThrow(/decimal string/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] before any receipt directory exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-adopt-receipt-empty-'));
    try {
      const store = createFileAdoptionReceiptStore({ dir: join(dir, 'nope') });
      expect(await store.all()).toEqual([]);
      expect(await store.has('1')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
