import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import { openNativeSolutionPublisher } from '../../src/daemon/native-solution-publisher.js';
import { publicationKey } from '../../src/daemon/native-operation-identity.js';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'jinn-solution-publisher-'));
  roots.push(value);
  return value;
}

function signer() {
  return {
    keyId: 'did:key:z6MksolverDiscovery',
    sign: (_bytes: Uint8Array) => new Uint8Array([1, 2, 3]),
  };
}

function artifact(bytes: Uint8Array, sequence = 1) {
  const digest = documentDigest(bytes);
  const engagementId = `sha256:${'a'.repeat(64)}` as const;
  const sourceId = 'urn:jinn:operator:solver-a/solver-records';
  return {
    publication: {
      publicationKey: publicationKey({ sourceId, role: 'delivery', recordDigest: digest, availabilityState: 'available' }),
      engagementId,
      sourceId,
      role: 'delivery' as const,
      recordDigest: digest,
      availability: 'available',
      status: 'intent' as const,
      detail: {},
      createdAt: `2026-08-02T00:00:0${sequence}.000Z`,
      updatedAt: `2026-08-02T00:00:0${sequence}.000Z`,
    },
    artifact: {
      engagementId,
      role: 'delivery' as const,
      family: 'delivery',
      name: null,
      digest,
      bytes,
      createdAt: `2026-08-02T00:00:0${sequence}.000Z`,
    },
    bytes,
  };
}

describe('native solution public source', () => {
  it('serves exact records and advances one signed append-only solver-records source', async () => {
    const stateRoot = await root();
    const publisher = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => publisher.close());
    const firstBytes = new TextEncoder().encode('{"delivery":1}');
    const secondBytes = new TextEncoder().encode('{"delivery":2}');

    const first = await publisher.publish(artifact(firstBytes, 1));
    const second = await publisher.publish(artifact(secondBytes, 2));

    expect(first.sequence).toBe('0000000000000001');
    expect(second.sequence).toBe('0000000000000002');
    expect(first.location).toBe(`https://operator.example/native/records/${documentDigest(firstBytes).slice(7)}`);
    const response = await publisher.handler(new Request(
      `https://operator.example/native/records/${documentDigest(firstBytes).slice(7)}`,
    ));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(firstBytes);
  });

  it('refuses a second lifecycle owner for the same source state path', async () => {
    const stateRoot = await root();
    const first = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => first.close());

    await expect(openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    })).rejects.toThrow(/already has a lifecycle owner/u);
  });

  it('resumes at the exact next sequence only after the prior owner closes', async () => {
    const stateRoot = await root();
    const first = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    await first.publish(artifact(new TextEncoder().encode('{"delivery":1}'), 1));
    await first.close();

    const reopened = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => reopened.close());
    await expect(reopened.publish(artifact(new TextEncoder().encode('{"delivery":2}'), 2)))
      .resolves.toMatchObject({ sequence: '0000000000000002' });
  });
});
