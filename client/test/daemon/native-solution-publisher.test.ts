import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    verify: (_payload: Uint8Array, signature: Uint8Array) =>
      signature.length === 3 && signature[0] === 1 && signature[1] === 2 && signature[2] === 3,
  };
}

function realSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId: 'did:key:z6MkRealSolverDiscovery',
    sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, privateKey)),
    verify: (payload: Uint8Array, signature: Uint8Array) => cryptoVerify(null, payload, publicKey, signature),
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

  it('finishes an authenticated journal after the signed head advances before source state', async () => {
    const stateRoot = await root();
    let failed = false;
    const first = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
      faults: {
        afterHeadBeforeState: () => {
          if (!failed) {
            failed = true;
            throw new Error('injected crash after signed head');
          }
        },
      },
    });
    const firstValue = artifact(new TextEncoder().encode('{"delivery":1}'), 1);
    await expect(first.publish(firstValue)).rejects.toThrow(/injected crash/u);
    await first.close();

    const reopened = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => reopened.close());
    await expect(reopened.publish(firstValue)).resolves.toMatchObject({ sequence: '0000000000000001' });
    await expect(reopened.publish(artifact(new TextEncoder().encode('{"delivery":2}'), 2)))
      .resolves.toMatchObject({ sequence: '0000000000000002' });
  });

  it.each([
    'afterRecordBeforeJournal',
    'afterJournalBeforePage',
    'afterPageBeforeHead',
    'afterHeadBeforeState',
    'afterStateBeforeJournalClear',
  ] as const)('recovers without sequence reuse when a crash occurs at %s', async (boundary) => {
    const stateRoot = await root();
    let failed = false;
    const first = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
      faults: {
        [boundary]: () => {
          if (!failed) {
            failed = true;
            throw new Error(`crash:${boundary}`);
          }
        },
      },
    });
    const firstValue = artifact(new TextEncoder().encode('{"delivery":1}'), 1);
    await expect(first.publish(firstValue)).rejects.toThrow(`crash:${boundary}`);
    await first.close();
    const reopened = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => reopened.close());
    await expect(reopened.publish(firstValue)).resolves.toMatchObject({ sequence: '0000000000000001' });
    await expect(reopened.publish(artifact(new TextEncoder().encode('{"delivery":2}'), 2)))
      .resolves.toMatchObject({ sequence: '0000000000000002' });
  });

  it('takes over only an expired matching owner lease whose PID is dead', async () => {
    const stateRoot = await root();
    const source = { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' } as const;
    await writeFile(join(stateRoot, '.solution-publisher-owner'), `${JSON.stringify({
      version: 1,
      source,
      signerKeyId: signer().keyId,
      pid: 424242,
      token: 'a'.repeat(32),
      acquiredAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:01.000Z',
    })}\n`);

    const publisher = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source,
      signer: signer(),
      owner: {
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        isPidAlive: () => false,
      },
    });
    closers.push(() => publisher.close());
    await expect(publisher.publish(artifact(new TextEncoder().encode('{"delivery":1}'), 1)))
      .resolves.toMatchObject({ sequence: '0000000000000001' });
  });

  it('refuses an expired owner lease while its authenticated PID remains live', async () => {
    const stateRoot = await root();
    const source = { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' } as const;
    await writeFile(join(stateRoot, '.solution-publisher-owner'), `${JSON.stringify({
      version: 1,
      source,
      signerKeyId: signer().keyId,
      pid: 424242,
      token: 'b'.repeat(32),
      acquiredAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:01.000Z',
    })}\n`);

    await expect(openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source,
      signer: signer(),
      owner: {
        now: () => new Date('2026-08-02T00:00:00.000Z'),
        isPidAlive: () => true,
      },
    })).rejects.toThrow(/lifecycle owner/u);
  });

  it('does not unlink an owner lease whose random token changed before close', async () => {
    const stateRoot = await root();
    const source = { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' } as const;
    const publisher = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source,
      signer: signer(),
    });
    const ownerPath = join(stateRoot, '.solution-publisher-owner');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>;
    await writeFile(ownerPath, `${JSON.stringify({ ...owner, token: 'f'.repeat(32) })}\n`);
    await publisher.close();
    await expect(stat(ownerPath)).resolves.toBeDefined();
  });

  it('migrates a v1 source state only after authenticating its signed archive and head', async () => {
    const stateRoot = await root();
    const first = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    await first.publish(artifact(new TextEncoder().encode('{"delivery":1}'), 1));
    await first.close();
    const statePath = join(stateRoot, 'source-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    delete state.signerKeyId;
    state.version = 1;
    await writeFile(statePath, `${JSON.stringify(state)}\n`);

    const reopened = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => reopened.close());
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      version: 2,
      signerKeyId: signer().keyId,
    });
  });

  it.each([
    { boundary: 'afterJournalBeforePage', target: 'journal' },
    { boundary: 'afterPageBeforeHead', target: 'page' },
    { boundary: 'afterHeadBeforeState', target: 'head' },
    { boundary: 'afterJournalBeforePage', target: 'record' },
  ] as const)('fails closed on cryptographic $target tampering during journal recovery', async ({ boundary, target }) => {
    const stateRoot = await root();
    const signing = realSigner();
    const first = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signing,
      faults: { [boundary]: () => { throw new Error(`crash:${boundary}`); } },
    });
    const firstValue = artifact(new TextEncoder().encode('{"delivery":1}'), 1);
    await expect(first.publish(firstValue)).rejects.toThrow(`crash:${boundary}`);
    await first.close();

    const sequence = '0000000000000001';
    const targetPath = target === 'journal'
      ? join(stateRoot, 'append-journal.json')
      : target === 'page'
        ? join(stateRoot, 'public', 'sources', 'solver-records', 'entries', sequence)
        : target === 'head'
          ? join(stateRoot, 'public', 'sources', 'solver-records', 'head')
          : join(stateRoot, 'public', 'records', firstValue.artifact.digest.slice(7));
    if (target === 'journal') {
      const journal = JSON.parse(await readFile(targetPath, 'utf8')) as Record<string, unknown>;
      await writeFile(targetPath, `${JSON.stringify({ ...journal, signerKeyId: 'did:key:attacker' })}\n`);
    } else {
      const bytes = new Uint8Array(await readFile(targetPath));
      bytes[Math.max(0, bytes.length - 2)] ^= 1;
      await writeFile(targetPath, bytes);
    }

    await expect(openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signing,
    })).rejects.toThrow(/journal|archive|head|record|signature|conflict|JSON/u);
  });
});
