import { createHash } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  linkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeEvidencePortContract } from '@jinn-network/plugin/testing';
import { EPISODE_SCHEMA_VERSION, EpisodeV1Schema, type EpisodeV1 } from '@jinn-network/plugin';
import type { CapturedTask } from '../src/captured-task.js';
import {
  capturedTaskToEpisode,
  createEvidenceAdapter,
  episodeFileName,
} from '../src/evidence-adapter.js';

/** A sample EpisodeV1 the byte-exact round-trip is checked against. */
function makeSampleEpisode(overrides: Partial<EpisodeV1> = {}): EpisodeV1 {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: 'episode-fixture-1',
    retrievalVisible: false,
    session: {
      sessionId: 'sess-fixture-1',
      capturedAt: '2026-07-14T00:00:00.000Z',
      kind: 'user',
      ...overrides.session,
    },
    origin: { writer: 'hermes', build: '0.1.0' },
    task: { summary: 'Fix a failing test', distributionTags: ['coding'] },
    trajectory: [
      {
        spanId: 'span-turn-1',
        parentSpanId: null,
        kind: 'jinn.agent_turn',
        name: 'turn',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1000000000',
        attributes: { role: 'user', content: 'help' },
        redactedKeys: [],
      },
      {
        spanId: 'span-tool-1',
        parentSpanId: null,
        kind: 'jinn.tool_call',
        name: 'bash',
        startTimeUnixNano: '3000000000',
        endTimeUnixNano: '4000000000',
        attributes: { args: 'ls', result: 'ok' },
        redactedKeys: [],
      },
    ],
    environment: {
      harness: { name: 'hermes', version: '0.1.0' },
      model: 'claude-test',
      tools: ['bash'],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'user-accepted' },
    cost: { durationMs: 1000 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
    ...overrides,
    session: {
      sessionId: 'sess-fixture-1',
      capturedAt: '2026-07-14T00:00:00.000Z',
      kind: 'user',
      ...overrides.session,
    },
    origin: overrides.origin ?? { writer: 'hermes', build: '0.1.0' },
  };
}

/** A valid legacy CapturedTask (the pre-EpisodeV1 on-disk shape). */
function makeLegacyCapturedTask(overrides: Partial<CapturedTask> = {}): CapturedTask {
  return {
    session: { sessionId: 'legacy-sess-1', capturedAt: '2026-07-13T00:00:00.000Z' },
    task: { summary: 'A legacy captured task', distributionTags: ['coding', 'python'] },
    environment: {
      harness: { name: 'claude-code', version: '2.0.0' },
      model: 'claude-haiku',
      tools: ['bash', 'read'],
    },
    steps: [
      {
        spanId: 'legacy-turn-1',
        parentSpanId: null,
        name: 'jinn.transcript.user-message',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1500000000',
        attributes: { 'jinn.capture.event.kind': 'user-message', 'message.content': 'do the thing' },
        redactedKeys: [],
      },
      {
        spanId: 'legacy-tool-1',
        parentSpanId: null,
        name: 'bash',
        startTimeUnixNano: '2000000000',
        endTimeUnixNano: '2500000000',
        attributes: { command: 'ls' },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 4200 },
    provenance: 'contributed',
    ...overrides,
  };
}

function makeAdapter() {
  const capturesDir = mkdtempSync(join(tmpdir(), 'ev-'));
  return createEvidenceAdapter({ capturesDir });
}

describeEvidencePortContract(makeAdapter, makeSampleEpisode());

describe('EvidenceAdapter — AC2 legacy read', () => {
  it('up-maps a legacy CapturedTask to a valid EpisodeV1 in list()', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-legacy-'));
    const legacy = makeLegacyCapturedTask();
    writeFileSync(join(capturesDir, 'legacy-1.json'), JSON.stringify(legacy));

    const adapter = createEvidenceAdapter({ capturesDir });
    const result = await adapter.list();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const episode = result.value.find((e) => e.episodeId === legacy.session.sessionId);
    expect(episode).toBeDefined();
    if (!episode) return;
    // Fail-closed: the up-map must parse under the strict schema.
    expect(() => EpisodeV1Schema.parse(episode)).not.toThrow();
    expect(episode.schemaVersion).toBe(EPISODE_SCHEMA_VERSION);
    expect(episode.episodeId).toBe('legacy-sess-1');
    expect(episode.environment.skillsLoadout).toEqual([]);
    expect(episode.retention.policy).toBe('local-private');
    expect(episode.task.distributionTags).toEqual(['coding', 'python']);
    // Each step carries a valid discriminated `kind`.
    expect(episode.trajectory.map((s) => s.kind)).toEqual(['jinn.agent_turn', 'jinn.tool_call']);
  });

  it('preserves canonical tuple, environment, grouping, and explicit step-kind facts', () => {
    const legacy = makeLegacyCapturedTask({
      session: {
        sessionId: 'legacy-sess-enriched',
        capturedAt: '2026-07-13T00:00:00.000Z',
        kind: 'host-internal',
        parentSessionId: 'parent-session',
      },
      task: {
        summary: 'An enriched captured task',
        distributionTags: ['coding'],
        repositorySlug: 'django/django',
        baseCommit: 'a'.repeat(40),
        createdAt: 1_752_000_000,
        instanceId: 'django__django-12345',
      },
      environment: {
        harness: { name: 'execution-ledger', version: '0.1.0' },
        model: 'claude-sonnet-4-6',
        tools: ['bash'],
        skillsLoadout: ['tdd'],
        generatorModel: {
          id: 'claude-sonnet-4-6',
          provider: 'anthropic',
          openWeights: false,
          source: 'stream',
        },
        distributionClass: 'restricted-tos',
        verifier: {
          type: 'f2p-p2p',
          failToPass: ['tests/test_fix.py::test_regression'],
          passToPass: ['tests/test_existing.py::test_stable'],
          evalSemanticsVersion: 'swe-rebench-v2.1',
        },
      },
      steps: [{
        spanId: 'explicit-kind',
        parentSpanId: null,
        name: 'bash',
        kind: 'jinn.agent_turn',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1500000000',
        attributes: {},
        redactedKeys: [],
      }],
      attemptGroup: {
        groupId: 'django__django-12345',
        attemptId: '0xattempt',
        relatedAttemptRefs: ['bafy-pass', 'bafy-fail'],
        groupSize: 2,
        nPass: 1,
        nFail: 1,
      },
    });

    const episode = capturedTaskToEpisode(legacy, {
      policy: 'contribution-eligible',
      maxEpisodes: 200,
    });

    expect(episode).toMatchObject({
      session: {
        kind: 'host-internal',
        parentSessionId: 'parent-session',
      },
      task: {
        repositorySlug: 'django/django',
        baseCommit: 'a'.repeat(40),
        createdAt: 1_752_000_000,
        instanceId: 'django__django-12345',
      },
      trajectory: [{ kind: 'jinn.agent_turn' }],
      environment: {
        skillsLoadout: ['tdd'],
        generatorModel: {
          id: 'claude-sonnet-4-6',
          provider: 'anthropic',
          openWeights: false,
          source: 'stream',
        },
        distributionClass: 'restricted-tos',
        verifier: {
          type: 'f2p-p2p',
          failToPass: ['tests/test_fix.py::test_regression'],
          passToPass: ['tests/test_existing.py::test_stable'],
          evalSemanticsVersion: 'swe-rebench-v2.1',
        },
      },
      attemptGroup: {
        groupId: 'django__django-12345',
        attemptId: '0xattempt',
        relatedAttemptRefs: ['bafy-pass', 'bafy-fail'],
        groupSize: 2,
        nPass: 1,
        nFail: 1,
      },
    });
  });

  it('returns valid records with an explicit degraded count when files are unreadable', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-unreadable-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const episode = makeSampleEpisode({ episodeId: 'readable' });
    expect((await adapter.put(episode)).status).toBe('ok');
    writeFileSync(join(capturesDir, 'broken.episode.json'), '{"privatePrompt":');
    writeFileSync(join(capturesDir, 'broken-legacy.json'), '{}');

    const result = await adapter.list();

    expect(result).toEqual({
      status: 'degraded',
      reason: 'evidence list skipped 2 unreadable record(s)',
      value: [episode],
    });
  });

  it('counts and identifies an episode whose present activity facts are malformed', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-malformed-activity-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const episode = makeSampleEpisode({ episodeId: 'readable' });
    expect((await adapter.put(episode)).status).toBe('ok');
    writeFileSync(
      join(capturesDir, 'malformed-activity.episode.json'),
      JSON.stringify({
        ...makeSampleEpisode({ episodeId: 'malformed-activity' }),
        activity: { searchedTerms: { wrong: 'container' } },
      }),
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await adapter.list();

      expect(result).toEqual({
        status: 'degraded',
        reason: 'evidence list skipped 1 unreadable record(s)',
        value: [episode],
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('malformed-activity.episode.json'),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('rejects unstamped legacy-shaped values on put while retaining tolerant reads', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-writer-stamp-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const episode = makeSampleEpisode({ episodeId: 'unstamped' });
    const unstamped = {
      ...episode,
      session: {
        sessionId: episode.session.sessionId,
        capturedAt: episode.session.capturedAt,
      },
      origin: undefined,
    } as unknown as EpisodeV1;

    expect((await adapter.put(unstamped)).status).toBe('unavailable');
    writeFileSync(join(capturesDir, 'legacy-on-disk.episode.json'), JSON.stringify(unstamped));
    const listed = await adapter.list();
    expect(listed.status).toBe('ok');
    if (listed.status === 'ok') {
      expect(listed.value[0]?.session.kind).toBe('user');
      expect(listed.value[0]?.origin).toBe('legacy-unstamped');
    }
  });
});

describe('EvidenceAdapter — AC2 byte-exact round-trip', () => {
  it('keeps literal and hashed filename namespaces disjoint and within NAME_MAX', () => {
    const unsafeId = '../evil';
    const unsafeName = episodeFileName(unsafeId);
    const oldCollisionId = unsafeName.slice(0, -'.episode.json'.length);

    expect(episodeFileName(oldCollisionId)).not.toBe(unsafeName);
    expect(Buffer.byteLength(episodeFileName('x'.repeat(300)), 'utf8')).toBeLessThanOrEqual(255);
  });

  it('keeps the canonical write available when index refresh fails', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-index-failure-'));
    const onStoreChanged = vi.fn(() => {
      throw new Error('index unavailable');
    });
    const adapter = createEvidenceAdapter({ capturesDir, onStoreChanged });

    const result = await adapter.put(makeSampleEpisode({ episodeId: 'index-failure' }));

    expect(result.status).toBe('ok');
    expect(onStoreChanged).toHaveBeenCalledOnce();
    expect(existsSync(join(capturesDir, 'index-failure.episode.json'))).toBe(true);
  });

  it('keeps current writes strict when an optional field is literal null', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-strict-write-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const invalid = {
      ...makeSampleEpisode({ episodeId: 'strict-null' }),
      outcome: {
        ...makeSampleEpisode().outcome,
        summary: null,
      },
    } as unknown as EpisodeV1;

    const result = await adapter.put(invalid);

    expect(result.status).toBe('unavailable');
    expect(existsSync(join(capturesDir, 'strict-null.episode.json'))).toBe(false);
  });

  it('put(episode) then get(id) deep-equals the put episode', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-rt-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const episode = makeSampleEpisode({ episodeId: 'rt-1' });
    const putResult = await adapter.put(episode);
    expect(putResult).toEqual({ status: 'ok', value: { episodeId: 'rt-1' } });
    const getResult = await adapter.get('rt-1');
    expect(getResult).toEqual({ status: 'ok', value: episode });
  });

  it('written EpisodeV1 files do not collide with legacy .json captures', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-mix-'));
    // A legacy capture AND a put episode share the dir; neither corrupts the other.
    writeFileSync(join(capturesDir, 'legacy-2.json'), JSON.stringify(makeLegacyCapturedTask()));
    const adapter = createEvidenceAdapter({ capturesDir });
    await adapter.put(makeSampleEpisode({ episodeId: 'ep-mix-1' }));
    expect(existsSync(join(capturesDir, 'ep-mix-1.episode.json'))).toBe(true);

    const list = await adapter.list();
    expect(list.status).toBe('ok');
    if (list.status !== 'ok') return;
    const ids = list.value.map((e) => e.episodeId).sort();
    expect(ids).toEqual(['ep-mix-1', 'legacy-sess-1']);
  });

  it('get() on an unknown id returns ok(null)', async () => {
    const adapter = makeAdapter();
    const result = await adapter.get('never-put');
    expect(result).toEqual({ status: 'ok', value: null });
  });

  it('encodes a traversal-shaped episodeId without escaping capturesDir (#1660)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ev-trav-'));
    const capturesDir = join(parent, 'captures');
    const adapter = createEvidenceAdapter({ capturesDir });

    // A sentinel just outside capturesDir a traversal write would clobber.
    const escapeTarget = join(parent, 'evil.episode.json');

    const putResult = await adapter.put(makeSampleEpisode({ episodeId: '../evil' }));
    expect(putResult).toEqual({ status: 'ok', value: { episodeId: '../evil' } });
    expect(existsSync(escapeTarget)).toBe(false);
    const digest = createHash('sha256').update('../evil').digest('hex');
    expect(existsSync(join(capturesDir, `episode-${digest}.episode.json`))).toBe(true);
    expect(await adapter.get('../evil')).toMatchObject({
      status: 'ok',
      value: { episodeId: '../evil' },
    });

    const getResult = await adapter.get('../../etc/whatever');
    expect(getResult).toEqual({ status: 'ok', value: null });
    expect(existsSync(join(parent, 'etc'))).toBe(false);
  });

  it('uses canonical filenames and private permissions for safe and unsafe ids', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ev-names-'));
    const capturesDir = join(parent, 'evidence');
    const adapter = createEvidenceAdapter({ capturesDir });
    const unsafeId = 'host/session:1';
    const unsafeDigest = createHash('sha256').update(unsafeId).digest('hex');

    await adapter.put(makeSampleEpisode({ episodeId: 'safe-id_1' }));
    await adapter.put(makeSampleEpisode({ episodeId: unsafeId }));

    const safePath = join(capturesDir, 'safe-id_1.episode.json');
    const unsafePath = join(capturesDir, `episode-${unsafeDigest}.episode.json`);
    expect(existsSync(safePath)).toBe(true);
    expect(existsSync(unsafePath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(capturesDir).mode & 0o777).toBe(0o700);
      expect(statSync(safePath).mode & 0o777).toBe(0o600);
      expect(statSync(unsafePath).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(capturesDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('is idempotent for schema-canonical identical content without rewriting the file', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-idempotent-'));
    const episode = makeSampleEpisode({ episodeId: 'same-episode' });
    const path = join(capturesDir, 'same-episode.episode.json');
    const preexistingBytes = `${JSON.stringify(episode, null, 2)}\n`;
    writeFileSync(path, preexistingBytes, 'utf8');
    const adapter = createEvidenceAdapter({ capturesDir });

    const result = await adapter.put(episode);

    expect(result).toEqual({ status: 'ok', value: { episodeId: 'same-episode' } });
    expect(readFileSync(path, 'utf8')).toBe(preexistingBytes);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked evidence directory before writing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ev-symlinked-store-'));
    const realDir = join(root, 'real');
    const capturesDir = join(root, 'linked');
    mkdirSync(realDir);
    symlinkSync(realDir, capturesDir);

    const result = await createEvidenceAdapter({ capturesDir }).put(
      makeSampleEpisode({ episodeId: 'must-not-write' }),
    );

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.reason).toMatch(/directory|symlink/i);
    expect(existsSync(join(realDir, 'must-not-write.episode.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a hardlinked existing episode without chmodding its alias', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-hardlinked-existing-'));
    const episode = makeSampleEpisode({ episodeId: 'hardlinked' });
    const path = join(capturesDir, 'hardlinked.episode.json');
    const aliasPath = join(capturesDir, 'hardlinked-alias');
    writeFileSync(path, JSON.stringify(episode), { mode: 0o644 });
    linkSync(path, aliasPath);
    chmodSync(path, 0o644);

    const result = await createEvidenceAdapter({ capturesDir }).put(episode);

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.reason).toMatch(/hardlink|collision/i);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(aliasPath).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('recovers a writer temp alias left after canonical publication', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-publication-recovery-'));
    const episode = makeSampleEpisode({ episodeId: 'recovered-write' });
    const path = join(capturesDir, 'recovered-write.episode.json');
    const orphan = join(
      capturesDir,
      '.recovered-write.episode.json.123.00000000-0000-4000-8000-000000000000.tmp',
    );
    writeFileSync(orphan, JSON.stringify(episode), { mode: 0o600 });
    linkSync(orphan, path);

    const result = await createEvidenceAdapter({ capturesDir }).put(episode);

    expect(result).toEqual({ status: 'ok', value: { episodeId: 'recovered-write' } });
    expect(existsSync(orphan)).toBe(false);
    expect(statSync(path).nlink).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(episode);
  });

  it('rejects an episodeId collision without changing the first episode', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-collision-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const first = makeSampleEpisode({ episodeId: 'collision-id' });
    const second = makeSampleEpisode({
      episodeId: 'collision-id',
      task: { summary: 'different content', distributionTags: [] },
    });

    expect((await adapter.put(first)).status).toBe('ok');
    const path = join(capturesDir, 'collision-id.episode.json');
    if (process.platform !== 'win32') chmodSync(path, 0o644);
    const collision = await adapter.put(second);

    expect(collision.status).toBe('unavailable');
    if (collision.status === 'unavailable') expect(collision.reason).toContain('collision');
    expect(await adapter.get('collision-id')).toEqual({ status: 'ok', value: first });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('handles concurrent identical puts idempotently', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-concurrent-same-'));
    const episode = makeSampleEpisode({ episodeId: 'concurrent-same' });
    const adapters = Array.from({ length: 16 }, () => createEvidenceAdapter({ capturesDir }));

    const results = await Promise.all(adapters.map((adapter) => adapter.put(episode)));

    expect(results.every((result) => result.status === 'ok')).toBe(true);
    expect(readdirSync(capturesDir).filter((name) => name.endsWith('.episode.json')))
      .toEqual(['concurrent-same.episode.json']);
    expect(readdirSync(capturesDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('allows exactly one winner for concurrent different content with the same id', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-concurrent-collision-'));
    mkdirSync(capturesDir, { recursive: true });
    const first = makeSampleEpisode({ episodeId: 'concurrent-collision' });
    const second = makeSampleEpisode({
      episodeId: 'concurrent-collision',
      task: { summary: 'other content', distributionTags: [] },
    });

    const results = await Promise.all([
      createEvidenceAdapter({ capturesDir }).put(first),
      createEvidenceAdapter({ capturesDir }).put(second),
    ]);

    expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'unavailable')).toHaveLength(1);
    const stored = await createEvidenceAdapter({ capturesDir }).get('concurrent-collision');
    expect(stored.status).toBe('ok');
    if (stored.status === 'ok') expect([first, second]).toContainEqual(stored.value);
    expect(readdirSync(capturesDir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

describe('EvidenceAdapter — episode retention (#1772 rider: declared maxEpisodes now enforced)', () => {
  it('prunes to the newest maxEpisodes by session.capturedAt, deleting the oldest', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-retention-'));
    const adapter = createEvidenceAdapter({ capturesDir, retention: { policy: 'local-private', maxEpisodes: 3 } });

    const oldest = makeSampleEpisode({ episodeId: 'ep-oldest', session: { sessionId: 's1', capturedAt: '2026-07-01T00:00:00.000Z' } });
    const older = makeSampleEpisode({ episodeId: 'ep-older', session: { sessionId: 's2', capturedAt: '2026-07-02T00:00:00.000Z' } });
    const mid = makeSampleEpisode({ episodeId: 'ep-mid', session: { sessionId: 's3', capturedAt: '2026-07-03T00:00:00.000Z' } });
    const newer = makeSampleEpisode({ episodeId: 'ep-newer', session: { sessionId: 's4', capturedAt: '2026-07-04T00:00:00.000Z' } });
    const newest = makeSampleEpisode({ episodeId: 'ep-newest', session: { sessionId: 's5', capturedAt: '2026-07-05T00:00:00.000Z' } });

    for (const episode of [oldest, older, mid, newer, newest]) {
      expect((await adapter.put(episode)).status).toBe('ok');
    }

    const remaining = readdirSync(capturesDir).filter((name) => name.endsWith('.episode.json')).sort();
    expect(remaining).toEqual(['ep-mid.episode.json', 'ep-newer.episode.json', 'ep-newest.episode.json']);
    expect(await adapter.get('ep-oldest')).toEqual({ status: 'ok', value: null });
    expect(await adapter.get('ep-older')).toEqual({ status: 'ok', value: null });
    expect((await adapter.get('ep-newest')).status).toBe('ok');
  });

  it('breaks equal capturedAt ties deterministically by filename', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-retention-tie-'));
    const adapter = createEvidenceAdapter({ capturesDir, retention: { policy: 'local-private', maxEpisodes: 2 } });
    const capturedAt = '2026-07-01T00:00:00.000Z';

    for (const episodeId of ['ep-c', 'ep-a', 'ep-b']) {
      expect((await adapter.put(makeSampleEpisode({
        episodeId,
        session: { sessionId: episodeId, capturedAt },
      }))).status).toBe('ok');
    }

    expect(readdirSync(capturesDir).filter((name) => name.endsWith('.episode.json')).sort())
      .toEqual(['ep-a.episode.json', 'ep-b.episode.json']);
  });

  it('is a no-op at or under the cap', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-retention-noop-'));
    const adapter = createEvidenceAdapter({ capturesDir, retention: { policy: 'local-private', maxEpisodes: 5 } });

    await adapter.put(makeSampleEpisode({ episodeId: 'ep-a', session: { sessionId: 's1', capturedAt: '2026-07-01T00:00:00.000Z' } }));
    await adapter.put(makeSampleEpisode({ episodeId: 'ep-b', session: { sessionId: 's2', capturedAt: '2026-07-02T00:00:00.000Z' } }));

    expect(readdirSync(capturesDir).filter((name) => name.endsWith('.episode.json'))).toHaveLength(2);
  });

  it('defaults to the declared 200-episode cap when no override is supplied', async () => {
    const capturesDir = mkdtempSync(join(tmpdir(), 'ev-retention-default-'));
    const adapter = createEvidenceAdapter({ capturesDir });
    const retention = await adapter.retention();
    expect(retention).toEqual({ status: 'ok', value: { policy: 'local-private', maxEpisodes: 200 } });
  });
});
