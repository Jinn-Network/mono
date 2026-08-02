import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import {
  ConsumerState,
  ConsumerStateError,
} from '../fixtures/native-vertical-consumer/src/state.js';

const roots: string[] = [];
const SOURCE = { agent: 'did:web:requester.example', name: 'requester' } as const;
const ENTRY = `sha256:${'1'.repeat(64)}` as const;

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'jinn-native-consumer-state-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('independent native consumer state', () => {
  it('persists an atomic source checkpoint, exact entries, and duplicate no-op across restart', async () => {
    const stateRoot = await root();
    const state = await ConsumerState.open(stateRoot);
    const batch = {
      source: SOURCE,
      head: {
        sequence: '0000000000000001', entry: ENTRY,
        issuedAt: '2026-08-02T12:00:00.000Z', refreshBy: '2026-08-03T12:00:00.000Z',
        envelope: '{"signed":"head"}',
      },
      entries: [{
        sequence: '0000000000000001', digest: ENTRY,
        entryJson: '{"entry":1}', signatureJson: '{"signature":1}',
      }],
    } as const;

    expect(state.commitSource(batch)).toEqual({ accepted: 1, duplicate: 0 });
    expect(state.commitSource(batch)).toEqual({ accepted: 0, duplicate: 1 });
    state.close();

    const reopened = await ConsumerState.open(stateRoot);
    expect(reopened.checkpoint(SOURCE)).toMatchObject({ sequence: '0000000000000001', entry: ENTRY });
    expect(reopened.entries(SOURCE)).toEqual([expect.objectContaining({ digest: ENTRY, active: true })]);
    reopened.close();
  });

  it('caches advertised exact bytes by digest outside producer roots and rejects content mismatch', async () => {
    const stateRoot = await root();
    const state = await ConsumerState.open(stateRoot);
    const bytes = new TextEncoder().encode('{"public":"record"}');
    const digest = documentDigest(bytes);

    await expect(state.putRecord({ digest, bytes, mediaType: 'application/json' })).resolves.toEqual({ stored: true });
    await expect(state.putRecord({ digest, bytes, mediaType: 'application/json' })).resolves.toEqual({ stored: false });
    expect(state.record(digest)).toEqual(bytes);
    const cachePath = state.recordPath(digest);
    expect(cachePath.startsWith(stateRoot)).toBe(true);
    expect(new Uint8Array(await readFile(cachePath))).toEqual(bytes);

    await expect(state.putRecord({
      digest,
      bytes: new TextEncoder().encode('{"tampered":true}'),
      mediaType: 'application/json',
    })).rejects.toMatchObject<Partial<ConsumerStateError>>({ reason: 'record-digest-mismatch' });
    state.close();
  });
});
