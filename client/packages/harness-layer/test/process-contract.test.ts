import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '@jinn-network/plugin/testing';
import {
  unavailable,
  type ContributionCandidateV1,
  type EpisodeV1,
  type JinnPluginDeps,
} from '@jinn-network/plugin';
import { runJinnLayerCli } from '../src/cli.js';
import { ContributionStore } from '@jinn-network/core';
import { buildSkillMarkdown } from '../src/skill-package.js';
import {
  MineableTraceStore,
  resolveMineableStateDir,
} from '../../../src/solver-types/_swe-rebench-v2-mineable-store.js';

function capture() {
  let output = '';
  return {
    writer: { write(value: string) { output += value; return true; } },
    output: () => output,
  };
}

function episode(): EpisodeV1 {
  return {
    schemaVersion: 'jinn.episode.v1',
    episodeId: 'episode-host-1',
    session: {
      sessionId: 'session-host-1',
      capturedAt: '2026-07-15T12:00:00.000Z',
      kind: 'user',
    },
    origin: { writer: 'hermes', build: '0.18.0' },
    task: {
      summary: 'Fix the session bridge',
      distributionTags: ['oss'],
      repositorySlug: 'Jinn-Network/mono',
    },
    trajectory: [{
      spanId: 'turn-1',
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn:user',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '1000000000',
      attributes: { role: 'user', content: 'fix it' },
      redactedKeys: [],
    }],
    environment: {
      harness: { name: 'hermes', version: '0.18.0' },
      model: 'test-model',
      tools: ['terminal'],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 50 },
    retention: { policy: 'contribution-eligible' },
    provenance: 'contributed',
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    episode: episode(),
    activity: {
      retrievalFired: true,
      eligibleRefs: ['knowledge/ref-1'],
      deliveredRefs: ['knowledge/ref-1'],
      deliveryMode: 'delivered',
      surfacedRefs: ['knowledge/ref-1'],
      fetchedRefs: ['knowledge/ref-1'],
      installedSkillRefs: [],
      searchedTerms: ['session bridge'],
      providedRefs: ['knowledge/ref-1'],
    },
    eligibilityInputs: { acceptedDiff: true },
    contributionCandidate: {
      schemaVersion: 'jinn.contribution-candidate.v1',
      sourceId: 'episode-host-1',
      repositorySlug: 'Jinn-Network/mono',
      baseCommit: '0123456789abcdef',
      acceptedDiff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
      testRuns: [{ command: 'yarn test', exitCode: 0, at: '2026-07-15T12:01:00.000Z' }],
      intermediateFailureDiffs: [],
      skillEvents: [],
      publishMinedTasksConsent: false,
      createdAt: '2026-07-15T12:02:00.000Z',
    },
    contributionVetoed: false,
    ...overrides,
  };
}

function memoryDeps(overrides: Partial<JinnPluginDeps> = {}): JinnPluginDeps {
  return {
    corpus: new InMemoryCorpusPort([]),
    evidence: new InMemoryEvidencePort(),
    contribution: new InMemoryContributionPort(),
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
    ...overrides,
  };
}

describe('jinn-layer process contract v1', () => {
  it('publishes the exact contract version without initializing product ports', async () => {
    const out = capture();
    expect(await runJinnLayerCli(['contract', '--json'], { writer: out.writer })).toBe(0);
    expect(JSON.parse(out.output())).toEqual({ contractVersion: 1 });
  });

  it.each([
    ['contract', ['contract', 'unexpected']],
    ['session pickup', ['session', 'pickup', '--unexpected']],
    ['session end', ['session', 'end', '--unexpected']],
    ['history', ['history', '--unexpected']],
    ['contribution ledger', ['contribution', 'ledger', '--unexpected']],
  ])('rejects extra arguments on the %s interface', async (_label, argv) => {
    const out = capture();
    expect(await runJinnLayerCli(argv, {
      writer: out.writer,
      reader: async () => JSON.stringify(request()),
      pluginOverrides: memoryDeps(),
    })).toBe(2);
    expect(out.output()).toMatch(/usage|invalid/i);
  });

  it('accepts a complete host episode without changing identity or timestamps', async () => {
    const evidence = new InMemoryEvidencePort();
    const contribution = new InMemoryContributionPort();
    const out = capture();
    const input = request();
    const code = await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(input),
      pluginOverrides: memoryDeps({ evidence, contribution }),
    });

    expect(code).toBe(0);
    const envelope = JSON.parse(out.output());
    expect(envelope.contractVersion).toBe(1);
    expect(envelope.status).toBe('ok');
    expect(envelope.value.episodeRef).toBe('episode-host-1');
    expect(envelope.value.persistence).toEqual({ status: 'ok', value: { episodeId: 'episode-host-1' } });
    const stored = await evidence.get('episode-host-1');
    expect(stored.status).toBe('ok');
    if (stored.status === 'ok') {
      expect(stored.value?.session).toEqual(episode().session);
      expect(stored.value?.trajectory).toEqual(episode().trajectory);
      expect(stored.value?.provenance).toBe(episode().provenance);
    }
    expect((await contribution.ledger()).status).toBe('ok');
  });

  it('returns the explicit veto receipt produced by the shared session completion path', async () => {
    const out = capture();

    expect(await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(request({ contributionVetoed: true })),
      pluginOverrides: memoryDeps(),
    })).toBe(0);

    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'ok',
      value: {
        contribution: {
          status: 'ok',
          value: {
            recordId: expect.any(String),
            publicationState: 'vetoed',
            status: 'vetoed',
          },
        },
      },
    });
  });

  it('keeps the session pickup verb versioned and structured (additive v1 shape, rescope R2 #1772)', async () => {
    const out = capture();
    expect(await runJinnLayerCli(['session', 'pickup'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pickup-1',
          taskSummary: 'ordinary OSS work',
          harness: { name: 'host', version: '1' },
          model: 'test',
          tools: [],
        },
        firstMessage: 'fix the retry tests',
      }),
      pluginOverrides: memoryDeps(),
    })).toBe(0);
    const reply = JSON.parse(out.output());
    expect(reply).toMatchObject({ contractVersion: 1, status: 'ok' });
    // Empty corpus: nothing to provide, but the response is still the
    // additive shape (contextBlock/packets/searchedTerms), not the retired
    // suggestions/markers shape.
    expect(reply.value.contextBlock).toBeNull();
    expect(reply.value.packets).toEqual([]);
    expect(Array.isArray(reply.value.searchedTerms)).toBe(true);
    expect(reply.value).not.toHaveProperty('suggestions');
    expect(reply.value).not.toHaveProperty('markers');
  });

  it('provides real evidence content end to end through the process contract (additive shape, rescope R2 #1772)', async () => {
    const corpus = new InMemoryCorpusPort([{
      ref: 'bafySourceEpisode',
      kind: 'trace',
      task: { summary: 'Fix the dashboard version-status flake', repositorySlug: 'Jinn-Network/mono' },
      outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
      steps: [{
        name: 'run tests',
        attributes: { 'tool.args': 'yarn test', 'tool.result': 'FAIL version-status', 'tool.exitCode': 1 },
      }],
      tags: ['mono', 'dashboard', 'vitest', 'version-status', 'async', 'flake'],
      provenance: 'imported',
      origin: 'seed:mono-dashboard-flake',
      capturedAt: '2026-07-04T00:00:00.000Z',
      tier: 'tests-passed',
    }]);
    const out = capture();
    expect(await runJinnLayerCli(['session', 'pickup'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pickup-evidence',
          taskSummary: 'ordinary OSS work',
          harness: { name: 'host', version: '1' },
          model: 'test',
          tools: [],
          repositorySlug: 'Jinn-Network/mono',
        },
        firstMessage: 'the dashboard version-status test is flaking on vitest',
      }),
      pluginOverrides: memoryDeps({ corpus }),
    })).toBe(0);

    const reply = JSON.parse(out.output());
    expect(reply).toMatchObject({ contractVersion: 1, status: 'ok' });
    expect(reply.value.packets).toHaveLength(1);
    expect(reply.value.packets[0]).toMatchObject({
      schemaVersion: 'jinn.knowledge-packet.v1',
      ref: 'bafySourceEpisode',
    });
    expect(reply.value.contextBlock).toContain('[jinn corpus] Prior evidence relevant to this task:');
    expect(reply.value.contextBlock).toContain('FAIL version-status');
    expect(reply.value.searchedTerms.length).toBeGreaterThan(0);
  });

  it('acknowledges the first sanitized contribution preview through a production command', async () => {
    const contribution = new InMemoryContributionPort();
    await contribution.recordMineable({
      ...(request().contributionCandidate as never),
      publishMinedTasksConsent: true,
    });
    const out = capture();

    expect(await runJinnLayerCli(['contribution', 'preview', '--ack', '--json'], {
      writer: out.writer,
      pluginOverrides: memoryDeps({ contribution }),
    })).toBe(0);

    const reply = JSON.parse(out.output());
    expect(reply).toMatchObject({
      contractVersion: 1,
      status: 'ok',
      value: {
        repositorySlug: 'Jinn-Network/mono',
        baseCommit: '0123456789abcdef',
        publicationState: 'queued',
        acknowledged: true,
      },
    });
    expect(out.output()).not.toMatch(/diff --git|acceptedDiff|trajectory/);
  });

  it('disables every unpublished authorization when the sharing preference is revoked', async () => {
    const contribution = new InMemoryContributionPort();
    const recorded = await contribution.recordMineable({
      ...(request().contributionCandidate as never),
      publishMinedTasksConsent: true,
    });
    if (recorded.status !== 'ok') throw new Error('record failed');
    await contribution.authorize(recorded.value.recordId);
    const out = capture();

    expect(await runJinnLayerCli(['contribution', 'disable', '--json'], {
      writer: out.writer,
      pluginOverrides: memoryDeps({ contribution }),
    })).toBe(0);

    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'ok',
      value: { recordIds: [recorded.value.recordId] },
    });
    expect(await contribution.mintStatus(recorded.value.recordId)).toMatchObject({
      status: 'ok',
      value: { publicationState: 'disabled' },
    });
  });

  it('reports pickup corpus unavailability without making the command fail', async () => {
    const corpus = {
      async search() { return unavailable('corpus offline'); },
      async get() { return unavailable('corpus offline'); },
    };
    const out = capture();
    expect(await runJinnLayerCli(['session', 'pickup'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pickup-2',
          taskSummary: 'ordinary OSS work',
          harness: { name: 'host', version: '1' },
          model: 'test',
          tools: [],
        },
        firstMessage: 'fix the retry tests',
      }),
      pluginOverrides: memoryDeps({ corpus }),
    })).toBe(0);
    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'unavailable',
      value: { contextBlock: null, packets: [] },
      reason: 'corpus offline',
    });
  });

  it('never touches the skills port from pickup, and a skill-kind hit never surfaces (rescope R1 closes #1729)', async () => {
    const hit = {
      ref: 'ipfs://retry-skill',
      kind: 'skill' as const,
      title: 'retry-skill',
      task: { summary: 'verified retry workflow' },
      outcome: { status: 'completed' as const, verifiabilityTier: 'evaluator-verified' as const },
      steps: [],
      tags: ['retry', 'workflow'],
      provenance: 'imported' as const,
      origin: 'seed:retry-skill',
      capturedAt: '2026-07-10T00:00:00.000Z',
      tier: 'evaluator-verified' as const,
      payloadKind: 'skill' as const,
    };
    // A skills port that throws on every call — pickup must never reach it
    // now that the adopt/suggest/install path is deleted from pickup
    // entirely (the port stays wired into JinnPluginDeps for the local-distill
    // install path, just unreachable from firstTurnPickup).
    const skills = {
      async list(): Promise<never> { throw new Error('skills port must not be called from pickup'); },
      async install(): Promise<never> { throw new Error('skills port must not be called from pickup'); },
      async uninstall(): Promise<never> { throw new Error('skills port must not be called from pickup'); },
    };
    const out = capture();

    expect(await runJinnLayerCli(['session', 'pickup'], {
      writer: out.writer,
      reader: async () => JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pickup-skills-untouched',
          taskSummary: 'ordinary OSS work',
          harness: { name: 'host', version: '1' },
          model: 'test',
          tools: [],
        },
        firstMessage: 'fix the retry workflow',
      }),
      pluginOverrides: memoryDeps({ corpus: new InMemoryCorpusPort([hit]), skills }),
    })).toBe(0);

    const reply = JSON.parse(out.output());
    expect(reply).toMatchObject({ contractVersion: 1, status: 'ok' });
    expect(reply.value.packets).toEqual([]);
    expect(reply.value.contextBlock).toBeNull();
    expect(JSON.stringify(reply)).not.toContain('skills install');
    expect(JSON.stringify(reply)).not.toMatch(/installed skill|Adopted automatically/);
  });

  it('returns degraded when contribution is unavailable but evidence persisted', async () => {
    const base = new InMemoryContributionPort();
    const contribution = {
      ...base,
      async recordMineable() { return unavailable('sidecar absent'); },
    } as JinnPluginDeps['contribution'];
    const out = capture();
    const code = await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(request()),
      pluginOverrides: memoryDeps({ contribution }),
    });
    expect(code).toBe(0);
    const envelope = JSON.parse(out.output());
    expect(envelope.status).toBe('degraded');
    expect(envelope.value.persistence.status).toBe('ok');
    expect(envelope.value.contribution.status).toBe('unavailable');
  });

  it('writes one canonical episode and a candidate the daemon reads from the same store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-process-contract-'));
    const episodes = join(root, 'episodes');
    const mineable = join(root, 'mineable');
    const previousEpisodes = process.env['JINN_LAYER_EPISODES_DIR'];
    const previousMineable = process.env['JINN_MINEABLE_STATE_DIR'];
    const previousSkills = process.env['JINN_LAYER_SKILLS_INSTALL_DIR'];
    process.env['JINN_LAYER_EPISODES_DIR'] = episodes;
    process.env['JINN_MINEABLE_STATE_DIR'] = mineable;
    process.env['JINN_LAYER_SKILLS_INSTALL_DIR'] = join(root, 'skills');
    try {
      const out = capture();
      expect(await runJinnLayerCli(['session', 'end'], {
        writer: out.writer,
        reader: async () => JSON.stringify(request()),
        pluginOverrides: {
          corpus: new InMemoryCorpusPort([]),
          localLearning: new InMemoryLocalLearningPort(),
          skills: new InMemorySkillsPort(),
        },
      })).toBe(0);
      expect(JSON.parse(out.output())).toMatchObject({
        contractVersion: 1,
        status: 'ok',
        value: {
          persistence: { status: 'ok', value: { episodeId: 'episode-host-1' } },
          contribution: {
            status: 'ok',
            value: {
              localState: 'recorded',
              publicationState: 'disabled',
              status: 'recorded',
            },
          },
          summary: {
            searchedTerms: ['session bridge'],
            providedPackets: [{
              ref: 'knowledge/ref-1',
              title: 'knowledge/ref-1',
            }],
            nothingFound: false,
          },
        },
      });

      const persisted = JSON.parse(readFileSync(join(episodes, 'episode-host-1.episode.json'), 'utf8'));
      expect(persisted.episodeId).toBe('episode-host-1');
      expect(persisted.session).toEqual(episode().session);
      expect(persisted.trajectory).toEqual(episode().trajectory);

      expect(resolveMineableStateDir()).toBe(mineable);
      const daemonStore = new MineableTraceStore({ stateDir: resolveMineableStateDir() });
      const records = await daemonStore.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        recordId: 'episode-host-1',
        localState: 'recorded',
        publicationState: 'disabled',
        candidate: { sourceId: 'episode-host-1' },
      });

      const ledgerOut = capture();
      expect(await runJinnLayerCli(['contribution', 'ledger', '--json'], {
        writer: ledgerOut.writer,
        pluginOverrides: {
          corpus: new InMemoryCorpusPort([]),
          localLearning: new InMemoryLocalLearningPort(),
          skills: new InMemorySkillsPort(),
        },
      })).toBe(0);
      expect(JSON.parse(ledgerOut.output())).toEqual({
        contractVersion: 1,
        status: 'ok',
        value: {
          rows: [{
            time: '07-15 12:02',
            task: 'Jinn-Network/mono @ 01234567',
            env: null,
            anchor: null,
            tier: 'tests-passed',
            state: 'recorded',
          }],
        },
      });
      expect(ledgerOut.output()).not.toMatch(/episode-host-1|acceptedDiff|diff --git|skillEvents/);

      const skillDir = join(root, 'skills', 'session-bridge-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), buildSkillMarkdown({
        name: 'session-bridge-skill',
        description: 'Use for session bridge work. Not for: unrelated tasks.',
        license: null,
        jinn: {
          schema: 'jinn.skill.v1',
          distribution: 'coding',
          verifiabilityTier: 'tests-passed',
          distilledFrom: 1,
          provenance: ['local-capture:session-host-1'],
          distilledAt: '2026-07-15T12:03:00.000Z',
        },
        body: '## When to use\nBridge work.\n\n## Strategy\nReuse evidence.\n\n## Steps\n1. Verify.\n\n## Pitfalls\nKeep facts local.\n\n## Verify\nRun tests.',
      }));
      const historyOut = capture();
      expect(await runJinnLayerCli(['history', '--json'], {
        writer: historyOut.writer,
        pluginOverrides: {
          corpus: new InMemoryCorpusPort([]),
          skills: new InMemorySkillsPort(),
        },
      })).toBe(0);
      expect(JSON.parse(historyOut.output())).toMatchObject({
        contractVersion: 1,
        status: 'ok',
        value: {
          entries: [{
            sessionId: 'session-host-1',
            knowledgeSurfaced: 1,
            knowledgeUsed: 1,
            contributionState: { status: 'recorded' },
            distilledSkills: [{
              ref: 'local-skill:session-bridge-skill',
              state: 'installed',
            }],
          }],
        },
      });
    } finally {
      if (previousEpisodes === undefined) delete process.env['JINN_LAYER_EPISODES_DIR'];
      else process.env['JINN_LAYER_EPISODES_DIR'] = previousEpisodes;
      if (previousMineable === undefined) delete process.env['JINN_MINEABLE_STATE_DIR'];
      else process.env['JINN_MINEABLE_STATE_DIR'] = previousMineable;
      if (previousSkills === undefined) delete process.env['JINN_LAYER_SKILLS_INSTALL_DIR'];
      else process.env['JINN_LAYER_SKILLS_INSTALL_DIR'] = previousSkills;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects every real contribution-store transition without requiring a sidecar', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-contribution-ledger-'));
    const previousMineable = process.env['JINN_MINEABLE_STATE_DIR'];
    process.env['JINN_MINEABLE_STATE_DIR'] = root;
    const base = request().contributionCandidate as ContributionCandidateV1;
    const candidate = (
      sourceId: string,
      publishMinedTasksConsent: boolean,
      minute: string,
    ): ContributionCandidateV1 => ({
      ...base,
      sourceId,
      publishMinedTasksConsent,
      createdAt: `2026-07-15T12:${minute}:00.000Z`,
    });
    try {
      const store = new ContributionStore({ stateDir: root });
      await store.record(candidate('recorded-local-id', false, '01'));
      await store.record(candidate('minted-local-id', false, '02'));
      await store.markMinted('minted-local-id', 'mint:local-only');
      await store.record(candidate('preview-local-id', true, '03'));

      const previewOut = capture();
      expect(await runJinnLayerCli(['contribution', 'ledger', '--json'], {
        writer: previewOut.writer,
        pluginOverrides: {
          corpus: new InMemoryCorpusPort([]),
          localLearning: new InMemoryLocalLearningPort(),
          skills: new InMemorySkillsPort(),
        },
      })).toBe(0);
      expect(JSON.parse(previewOut.output()).value.rows.map((row: { state: string }) => row.state))
        .toEqual(['recorded', 'minted', 'preview-required']);

      await store.authorize('preview-local-id', '2026-07-15T12:04:00.000Z');
      await store.record(candidate('queued-local-id', true, '04'));
      await store.record(candidate('published-local-id', true, '05'));
      await store.markMinted('published-local-id', 'mint:published');
      await store.markPublished('published-local-id', 'ipfs://published');
      await store.record(candidate('vetoed-local-id', true, '06'), undefined, {
        publicationState: 'vetoed',
      });
      await store.record(candidate('rejected-local-id', false, '07'));
      await store.markRejected('rejected-local-id', 'not reproducible');

      const out = capture();
      expect(await runJinnLayerCli(['contribution', 'ledger', '--json'], {
        writer: out.writer,
        pluginOverrides: {
          corpus: new InMemoryCorpusPort([]),
          localLearning: new InMemoryLocalLearningPort(),
          skills: new InMemorySkillsPort(),
        },
      })).toBe(0);

      const reply = JSON.parse(out.output());
      expect(reply.status).toBe('ok');
      expect(reply.value.rows.map((row: { state: string }) => row.state)).toEqual([
        'recorded',
        'minted',
        'queued',
        'queued',
        'published',
        'vetoed',
        'rejected',
      ]);
      expect(reply.value.rows[4]).toMatchObject({
        env: 'mint:published',
        anchor: 'ipfs://published',
        state: 'published',
      });
      expect(out.output()).not.toMatch(/-local-id|acceptedDiff|diff --git|skillEvents/);
    } finally {
      if (previousMineable === undefined) delete process.env['JINN_MINEABLE_STATE_DIR'];
      else process.env['JINN_MINEABLE_STATE_DIR'] = previousMineable;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an unavailable contribution store as product state, not a command failure', async () => {
    const base = new InMemoryContributionPort();
    const contribution = {
      ...base,
      async ledger() { return unavailable('contribution store offline'); },
    } as JinnPluginDeps['contribution'];
    const out = capture();

    expect(await runJinnLayerCli(['contribution', 'ledger', '--json'], {
      writer: out.writer,
      pluginOverrides: memoryDeps({ contribution }),
    })).toBe(0);
    expect(JSON.parse(out.output())).toEqual({
      contractVersion: 1,
      status: 'unavailable',
      reason: 'contribution store offline',
    });
  });

  it('returns derived session history through the versioned process contract', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put({
      ...episode(),
      activity: {
        surfacedRefs: ['knowledge/ref-1'],
        fetchedRefs: ['knowledge/ref-1'],
        installedSkillRefs: [],
      },
      eligibility: {
        eligible: true,
        reason: 'accepted diff on a public repository',
        checkedAt: '2026-07-15T12:02:00.000Z',
      },
    });
    const learning = new InMemoryLocalLearningPort();
    learning.recordSkill({
      ref: 'local-skill:retry-budget',
      sourceSessionIds: ['session-host-1'],
      state: 'installed',
    });
    const out = capture();

    expect(await runJinnLayerCli(['history', '--json'], {
      writer: out.writer,
      pluginOverrides: memoryDeps({ evidence, localLearning: learning }),
    })).toBe(0);

    expect(JSON.parse(out.output())).toEqual({
      contractVersion: 1,
      status: 'ok',
      value: {
        entries: [{
          sessionId: 'session-host-1',
          capturedAt: '2026-07-15T12:00:00.000Z',
          taskSummary: 'Fix the session bridge',
          knowledgeSurfaced: 1,
          knowledgeUsed: 1,
          captureStatus: 'captured',
          eligibility: {
            eligible: true,
            reason: 'accepted diff on a public repository',
            checkedAt: '2026-07-15T12:02:00.000Z',
          },
          contributionState: { status: 'none' },
          distilledSkills: [{ ref: 'local-skill:retry-budget', state: 'installed' }],
        }],
      },
    });
  });

  it('keeps history rows useful when contribution state is unavailable', async () => {
    const evidence = new InMemoryEvidencePort();
    await evidence.put({
      ...episode(),
      activity: { surfacedRefs: [], fetchedRefs: [], installedSkillRefs: [] },
      eligibility: {
        eligible: false,
        reason: 'no accepted diff',
        checkedAt: '2026-07-15T12:02:00.000Z',
      },
    });
    const contribution = {
      ...new InMemoryContributionPort(),
      async ledger() { return unavailable('contribution store offline'); },
    } as JinnPluginDeps['contribution'];
    const out = capture();

    expect(await runJinnLayerCli(['history', '--json'], {
      writer: out.writer,
      pluginOverrides: memoryDeps({ evidence, contribution }),
    })).toBe(0);
    expect(JSON.parse(out.output())).toMatchObject({
      contractVersion: 1,
      status: 'degraded',
      reason: 'contribution: contribution store offline',
      value: {
        entries: [{ contributionState: { status: 'unavailable' } }],
      },
    });
  });

  it('returns unavailable with the typed persistence result when evidence did not persist', async () => {
    const evidence = {
      async put() { return unavailable('disk offline'); },
      async get() { return { status: 'ok' as const, value: null }; },
      async list() { return { status: 'ok' as const, value: [] }; },
      async retention() {
        return { status: 'ok' as const, value: { policy: 'local-private' as const, maxEpisodes: 200 } };
      },
    };
    const out = capture();
    expect(await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => JSON.stringify(request()),
      pluginOverrides: memoryDeps({ evidence }),
    })).toBe(0);
    const envelope = JSON.parse(out.output());
    expect(envelope.status).toBe('unavailable');
    expect(envelope.value.persistence).toEqual({ status: 'unavailable', reason: 'disk offline' });
  });

  it.each([
    ['not-json', 'not JSON'],
    ['wrong version', JSON.stringify(request({ contractVersion: 2 }))],
    ['unknown field', JSON.stringify(request({ unexpected: true }))],
  ])('treats %s as a command interface error', async (_label, input) => {
    const out = capture();
    expect(await runJinnLayerCli(['session', 'end'], {
      writer: out.writer,
      reader: async () => input,
      pluginOverrides: memoryDeps(),
    })).toBe(2);
    expect(out.output()).toMatch(/error/i);
  });
});
