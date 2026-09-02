import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RECORD_KINDS, headPath, recordDigest } from '@jinn-network/record-discovery-protocol';
import { openNativeSignedSource } from '../../src/daemon/native-signed-source.js';

// #3481: PR #3473 made a head's `issuedAt` load-bearing for acceptance, but the source
// writer took it from the caller's timestamp unbounded. A host with a fast clock would
// therefore mint, sign and publish heads that every consumer -- including this repo's own
// verifier -- permanently refuses `head-issued-ahead`, learning of it only from peer logs.
// The daemon now hands the writer its own clock, so the refusal happens at publish time.

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'jinn-signed-source-clock-'));
  roots.push(value);
  return value;
}

const SOURCE = { agent: 'urn:jinn:operator:solver-a', name: 'solver-records' } as const;

function signer() {
  return {
    keyId: 'did:key:z6MkSignedSourceClock',
    sign: (_payload: Uint8Array) => new Uint8Array([1, 2, 3]),
    verify: (_payload: Uint8Array, signature: Uint8Array) =>
      signature.length === 3 && signature[0] === 1 && signature[1] === 2 && signature[2] === 3,
  };
}

async function open(rootDir: string, now: () => Date) {
  const source = await openNativeSignedSource({
    rootDir,
    publicBaseUrl: 'https://operator.example/native',
    source: SOURCE,
    signer: signer(),
    ownerFile: '.signed-source-clock-owner',
    ownershipError: (message) => new Error(message),
    now,
  });
  closers.push(() => source.close());
  return source;
}

function publication(timestamp: string) {
  const bytes = new TextEncoder().encode('{"delivery":1}');
  const digest = recordDigest(bytes);
  return {
    publicationKey: `publication:${timestamp}`,
    sourceId: 'urn:jinn:operator:solver-a/solver-records',
    recordDigest: digest,
    bytes,
    mediaType: 'application/json',
    timestamp,
    makeAnnouncement: ({ location }: { readonly location: string }) => ({
      announcementId: `publication:${timestamp}`,
      action: 'available' as const,
      record: { kind: RECORD_KINDS.delivery, digest, mediaType: 'application/json' },
      locations: [{ profile: 'https', locator: location }],
    }),
  };
}

describe('native signed source clock bound', () => {
  it('refuses to publish a head issued further ahead of its own clock than the freshness window', async () => {
    const rootDir = await root();
    const source = await open(rootDir, () => new Date('2026-08-01T12:00:00.000Z'));

    await expect(source.publish(publication('2026-08-03T12:00:00.000Z')))
      .rejects.toThrow(/clock/);
  });

  it('publishes no head when the clock bound refuses the append', async () => {
    const rootDir = await root();
    const source = await open(rootDir, () => new Date('2026-08-01T12:00:00.000Z'));

    await expect(source.publish(publication('2026-08-03T12:00:00.000Z'))).rejects.toThrow();

    const publicDir = join(rootDir, 'public');
    const entries = await readdir(publicDir, { recursive: true }).catch(() => [] as string[]);
    expect(entries.some((entry) => join('/', entry) === headPath(SOURCE.name))).toBe(false);
  });

  it('publishes normally when the timestamp is within one freshness window of the clock', async () => {
    const rootDir = await root();
    const source = await open(rootDir, () => new Date('2026-08-03T12:00:00.000Z'));

    await expect(source.publish(publication('2026-08-03T12:00:00.000Z')))
      .resolves.toMatchObject({ sequence: '0000000000000001' });
  });
});
