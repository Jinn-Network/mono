import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DELIVERY_MEDIA_TYPE, documentDigest } from '@jinn-network/task-execution-protocol';
import { archivePagePath } from '@jinn-network/record-discovery-protocol';
import { openNativeSolutionPublisher as openNativeSolutionPublisherImpl } from '../../src/daemon/native-solution-publisher.js';
import { publicationKey } from '../../src/daemon/native-operation-identity.js';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
const SETTLEMENT_DECLARATION_KEY = 'did:key:z6MkSolverSettlement';
const openNativeSolutionPublisher = (
  input: Omit<Parameters<typeof openNativeSolutionPublisherImpl>[0], 'settlementDeclarationKey'>,
) => openNativeSolutionPublisherImpl({ ...input, settlementDeclarationKey: SETTLEMENT_DECLARATION_KEY });

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
      mediaType: DELIVERY_MEDIA_TYPE,
      name: null,
      digest,
      bytes,
      createdAt: `2026-08-02T00:00:0${sequence}.000Z`,
    },
    bytes,
  };
}

describe('native solution public source', () => {
  it('preserves the frozen pre-C6 signed page and head byte digests', async () => {
    const stateRoot = await root();
    const publisher = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => publisher.close());
    const published = await publisher.publish(artifact(new TextEncoder().encode('{"delivery":1}'), 1));
    const pageBytes = await readFile(join(
      stateRoot,
      'public',
      'sources',
      'solver-records',
      'entries',
      published.sequence,
    ));
    const headBytes = await readFile(join(stateRoot, 'public', 'sources', 'solver-records', 'head'));

    expect({
      page: createHash('sha256').update(pageBytes).digest('hex'),
      head: createHash('sha256').update(headBytes).digest('hex'),
    }).toEqual({
      page: '2f7ef852c2dc1b8332c74bccbbcd8fe0e2a4e992bc8582d8c9aa756aab17e016',
      head: '3cc9dcd7f620b93a79da52ddd1e2ceb12ddea61a315a38e931ca204980d8a1ba',
    });
  });

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
    expect(response.headers.get('content-type')).toBe(DELIVERY_MEDIA_TYPE);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(firstBytes);
  });

  it('appends a signed reorg withdrawal without rewriting the available announcement', async () => {
    const stateRoot = await root();
    const publisher = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => publisher.close());
    const value = artifact(new TextEncoder().encode('{"delivery":1}'), 1);
    const available = await publisher.publish(value);
    const withdrawn = await publisher.withdraw({
      withdrawalKey: publicationKey({
        sourceId: publisher.sourceId,
        role: 'delivery',
        recordDigest: value.artifact.digest,
        availabilityState: 'withdrawn',
      }),
      targetAnnouncementId: value.publication.publicationKey,
      recordDigest: value.artifact.digest,
      bytes: value.bytes,
      mediaType: value.artifact.mediaType,
      timestamp: '2026-08-02T00:00:02.000Z',
      reason: 'reorged',
    });

    expect(available.sequence).toBe('0000000000000001');
    expect(withdrawn.sequence).toBe('0000000000000002');
    const response = await publisher.handler(new Request(
      `https://operator.example/native${archivePagePath('solver-records', withdrawn.sequence)}`,
    ));
    const page = JSON.parse(await response.text()) as {
      entries: Array<{ entry: { announcements: unknown[] } }>;
    };
    expect(page.entries[0]!.entry.announcements).toEqual([expect.objectContaining({
      action: 'withdrawn',
      retracts: value.publication.publicationKey,
      reason: 'reorged',
    })]);
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

  it('adapts the pre-C6 v1 append journal without changing its frozen signed bytes', async () => {
    const stateRoot = await root();
    const first = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
      faults: { afterJournalBeforePage: () => { throw new Error('legacy-journal-fixture'); } },
    });
    const firstValue = artifact(new TextEncoder().encode('{"delivery":1}'), 1);
    await expect(first.publish(firstValue)).rejects.toThrow('legacy-journal-fixture');
    await first.close();

    const journalPath = join(stateRoot, 'append-journal.json');
    const current = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
    const { intent: _intent, ...legacyMirror } = current;
    await writeFile(journalPath, `${JSON.stringify({ ...legacyMirror, version: 1 })}\n`);

    const reopened = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => reopened.close());
    await expect(reopened.publish(firstValue)).resolves.toMatchObject({ sequence: '0000000000000001' });

    const pageBytes = await readFile(join(
      stateRoot,
      'public',
      'sources',
      'solver-records',
      'entries',
      '0000000000000001',
    ));
    expect(createHash('sha256').update(pageBytes).digest('hex'))
      .toBe('2f7ef852c2dc1b8332c74bccbbcd8fe0e2a4e992bc8582d8c9aa756aab17e016');
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

  it('relays a live announcement to a tail subscriber (one-swap M6)', async () => {
    const stateRoot = await root();
    const publisher = await openNativeSolutionPublisher({
      rootDir: stateRoot,
      publicBaseUrl: 'http://127.0.0.1',
      source: { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' },
      signer: signer(),
    });
    closers.push(() => publisher.close());

    // Relays are live-from-now (§9.3): open the tail BEFORE publishing.
    const tailRes = await publisher.handler(
      new Request('http://127.0.0.1/sources/solver-records/tail'),
    );
    expect(tailRes.status).toBe(200);
    expect(tailRes.headers.get('content-type') ?? '').toContain('text/event-stream');
    const reader = tailRes.body!.getReader();

    await publisher.publish(artifact(new TextEncoder().encode('{"delivery":1}'), 1));

    const decoder = new TextDecoder();
    let buffer = '';
    let announcement = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !announcement) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: announcement')) announcement = true;
    }
    await reader.cancel();
    expect(announcement).toBe(true);
    // The relayed frame is the CloudEvents announcement envelope naming the record.
    expect(buffer).toContain('network.jinn.record-discovery.announcement');
  });
});
