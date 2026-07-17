/**
 * Seed-import tests (plan Task 6, issue #1313 — APPROVAL GATE).
 *
 * The three automated-verification nets from the plan:
 *  - licence mapping: MIT/Apache-2.0 ⇒ import with attribution; no licence /
 *    incompatible ⇒ skip with reason;
 *  - zero-write plan: `plan()` performs no publish/anchor/ledger writes;
 *  - provenance tag: every imported entry publishes with
 *    `provenance: 'imported'` + attribution metadata.
 *
 * All sources and publish deps are mocked — nothing reaches GitHub, IPFS or
 * chain from CI. `execute()` against the real testnet is the human-gated
 * step: Oak approves the exact plan report first.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import { SKILL_ARTIFACT_TYPE, SkillArtifactV1Schema } from '../../../src/types/skill-artifact.js';
import { parseTraceEnvelopeV0 } from '../src/envelope.js';
import { createMemoryLedger } from '../src/ledger.js';
import type { HarnessPublishDeps } from '../src/publish.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from '../src/publish.js';
import { checkLicence, IMPORT_LICENCE_ALLOWLIST } from '../src/seed-import/licence.js';
import {
  parseImportReport,
  type ImportReport,
} from '../src/seed-import/report.js';
import { plan } from '../src/seed-import/plan.js';
import { execute } from '../src/seed-import/execute.js';
import type { SeedSkill, SeedSource } from '../src/seed-import/fetch.js';
import { createMemorySeedImportState, hashSeedContent } from '../src/seed-import/state.js';
import { runJinnLayerCli } from '../src/cli.js';

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

function skill(overrides: Partial<SeedSkill> = {}): SeedSkill {
  return {
    skill: 'acme/skills/write-tests',
    source: 'https://github.com/acme/skills',
    licence: 'MIT',
    description: 'Write tests before code',
    skillMd: '# write-tests\n\nAlways write a failing test first.',
    ...overrides,
  };
}

function mockSource(skills: SeedSkill[]): SeedSource & { listCalls: number } {
  const source = {
    name: 'mock-registry',
    listCalls: 0,
    async list() {
      source.listCalls += 1;
      return skills;
    },
  };
  return source;
}

function mockPublishDeps(): {
  deps: HarnessPublishDeps;
  published: Array<{ artifactType: string; payload: unknown }>;
  envelopes: SignedEnvelope[];
} {
  const published: Array<{ artifactType: string; payload: unknown }> = [];
  const envelopes: SignedEnvelope[] = [];
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async (input) => {
      published.push(input);
      return { cid: `bafy-artifact-${published.length}`, sha256: 'a'.repeat(64) };
    },
    publishEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return { cid: `bafy-envelope-${envelopes.length}`, sha256: 'b'.repeat(64) };
    },
    anchorEnvelope: async () => ({ txHash: `0x${'cd'.repeat(32)}` as `0x${string}`, blockNumber: 7 }),
  };
  return { deps, published, envelopes };
}

describe('licence checker', () => {
  it('maps permissive licences to import', () => {
    for (const spdx of ['MIT', 'Apache-2.0']) {
      const verdict = checkLicence(spdx);
      expect(verdict.verdict).toBe('import');
    }
  });

  it('skips missing licences with a reason', () => {
    const verdict = checkLicence(null);
    expect(verdict.verdict).toBe('skip');
    expect(verdict.reason.toLowerCase()).toContain('licence');
  });

  it('skips incompatible licences with the licence named in the reason', () => {
    for (const spdx of ['GPL-3.0-only', 'AGPL-3.0-only', 'LicenseRef-proprietary']) {
      const verdict = checkLicence(spdx);
      expect(verdict.verdict).toBe('skip');
      expect(verdict.reason).toContain(spdx);
    }
  });

  it('the allowlist is bounded and disclosed', () => {
    expect(IMPORT_LICENCE_ALLOWLIST).toContain('MIT');
    expect(IMPORT_LICENCE_ALLOWLIST).toContain('Apache-2.0');
    expect(IMPORT_LICENCE_ALLOWLIST).not.toContain('GPL-3.0-only');
  });
});

describe('plan()', () => {
  it('produces one report row per skill with licence verdicts', async () => {
    const source = mockSource([
      skill(),
      skill({ skill: 'acme/skills/no-licence', licence: null }),
      skill({ skill: 'acme/skills/gpl', licence: 'GPL-3.0-only' }),
    ]);
    const report = await plan(source);
    expect(report).toHaveLength(3);
    expect(report[0]).toMatchObject({ skill: 'acme/skills/write-tests', verdict: 'import' });
    expect(report[1]).toMatchObject({ verdict: 'skip' });
    expect(report[2]).toMatchObject({ verdict: 'skip' });
    for (const row of report) {
      expect(row.source).toBeTruthy();
      expect(row.reason).toBeTruthy();
    }
  });

  it('performs zero writes — no publish dep is even accepted', async () => {
    // The type-level guarantee: plan(source) takes no publish deps at all.
    const source = mockSource([skill()]);
    const report = await plan(source);
    expect(source.listCalls).toBe(1);
    expect(parseImportReport(report)).toEqual(report);
  });
});

describe('execute()', () => {
  it('publishes only verdict=import rows, each with provenance imported + attribution', async () => {
    const skills = [
      skill(),
      skill({ skill: 'acme/skills/gpl', licence: 'GPL-3.0-only' }),
    ];
    const source = mockSource(skills);
    const report = await plan(source);
    const { deps, published } = mockPublishDeps();
    const result = await execute(report, source, deps);

    expect(published.map((p) => p.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    expect(envelope.provenance).toBe('imported');
    const attrs = envelope.steps[0]!.attributes as Record<string, unknown>;
    expect(attrs['seed.attribution']).toMatchObject({
      source: 'https://github.com/acme/skills',
      licence: 'MIT',
    });
    expect(String(attrs['skill.md'])).toContain('failing test first');

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({
      skill: 'acme/skills/write-tests',
      envelopeRef: expect.stringContaining('bafy-envelope'),
    });
    expect(result.skipped).toHaveLength(1);
  });

  it('refuses a report row whose verdict was edited to import but whose licence still fails', async () => {
    const source = mockSource([skill({ skill: 'acme/skills/gpl', licence: 'GPL-3.0-only' })]);
    const report = await plan(source);
    const forced: ImportReport = report.map((r) => ({ ...r, verdict: 'import' as const }));
    const { deps, published } = mockPublishDeps();
    const result = await execute(forced, source, deps);
    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain('GPL-3.0-only');
  });

  it('ledger records every import', async () => {
    const source = mockSource([skill()]);
    const report = await plan(source);
    const { deps } = mockPublishDeps();
    await execute(report, source, deps);
    const entries = deps.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('published');
  });

  // ── Tagging (#1343) — tags freeze into published envelopes ────────────────

  it('tags carry the skill slug, not just the repo', async () => {
    const source = mockSource([skill({ skill: 'acme/skills/write-tests' })]);
    const { deps, published } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    expect(envelope.task.distributionTags).toContain('write-tests');
    expect(envelope.task.distributionTags).toContain('seed-import');
    expect(envelope.task.distributionTags).toContain('skills');
  });

  it('a SKILL.md frontmatter name becomes a tag', async () => {
    const source = mockSource([
      skill({
        skill: 'acme/skills/tdd-dir',
        skillMd: '---\nname: test-driven-development\ndescription: Red, green, refactor.\n---\n\n# TDD\n',
      }),
    ]);
    const { deps, published } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    expect(envelope.task.distributionTags).toContain('test-driven-development');
    expect(envelope.task.distributionTags).toContain('tdd-dir');
  });

  it('frontmatter name matching the slug does not duplicate; quoted names unquote', async () => {
    const source = mockSource([
      skill({
        skill: 'acme/skills/tdd',
        skillMd: '---\nname: "tdd"\n---\n# tdd\n',
      }),
    ]);
    const { deps, published } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    const tags = envelope.task.distributionTags;
    expect(tags.filter((t) => t === 'tdd')).toHaveLength(1);
  });

  it('tags respect the frozen schema caps (64 chars each, 16 max) with no frontmatter', async () => {
    const longName = 'x'.repeat(80);
    const source = mockSource([
      skill({
        skill: `acme/skills/${longName}`,
        skillMd: `---\nname: ${longName}\n---\n# long\n`,
      }),
    ]);
    const { deps, published } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    for (const tag of envelope.task.distributionTags) {
      expect(tag.length).toBeLessThanOrEqual(64);
    }
    expect(envelope.task.distributionTags.length).toBeLessThanOrEqual(16);
  });

  // ── First-class skill artifact (#1394) — dual-carriage ────────────────────

  it('attaches a jinn.skill.v1 artifact to the SAME wrapper envelope as the trace', async () => {
    const source = mockSource([skill()]);
    const { deps, published, envelopes } = mockPublishDeps();
    await execute(await plan(source), source, deps);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.artifacts.map((a) => a.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);

    const skillPayload = SkillArtifactV1Schema.parse(
      published.find((p) => p.artifactType === SKILL_ARTIFACT_TYPE)!.payload,
    );
    expect(skillPayload.skill.skillMd).toContain('failing test first');
    expect(skillPayload.skill.name).toBe('write-tests'); // slug (no frontmatter name)
    expect(skillPayload.files).toEqual([]); // companion fetch is #1381's work
    expect(skillPayload.provenance).toMatchObject({
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress: TEST_SAFE },
      seed: {
        skill: 'acme/skills/write-tests',
        source: 'https://github.com/acme/skills',
        licence: 'MIT',
      },
    });
  });

  it('a frontmatter name wins over the slug for the skill artifact name', async () => {
    const source = mockSource([
      skill({
        skill: 'acme/skills/tdd-dir',
        skillMd: '---\nname: test-driven-development\n---\n\n# TDD\n',
      }),
    ]);
    const { deps, published } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const payload = SkillArtifactV1Schema.parse(
      published.find((p) => p.artifactType === SKILL_ARTIFACT_TYPE)!.payload,
    );
    expect(payload.skill.name).toBe('test-driven-development');
  });

  it('the skill Artifact entry mirrors distribution tags into metadata.tags', async () => {
    const source = mockSource([skill()]);
    const { deps, envelopes } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const entry = envelopes[0]!.artifacts.find((a) => a.artifactType === SKILL_ARTIFACT_TYPE)!;
    expect(entry.metadata?.tags).toContain('seed-import');
    expect(entry.metadata?.tags).toContain('write-tests');
  });

  // ── Idempotency + supersedes (issue #1771, folding the #1772 AC) ──────────

  describe('idempotency + supersedes', () => {
    it('re-running execute() with the same state store over unchanged content publishes nothing new', async () => {
      const source = mockSource([skill()]);
      const report = await plan(source);
      const { deps, published } = mockPublishDeps();
      const state = createMemorySeedImportState();

      const first = await execute(report, source, deps, { state });
      expect(first.imported).toHaveLength(1);
      expect(published).toHaveLength(2); // trace + skill artifact

      const second = await execute(report, source, deps, { state });
      expect(second.imported).toHaveLength(0);
      expect(second.skipped).toHaveLength(1);
      expect(second.skipped[0]).toMatchObject({ skill: 'acme/skills/write-tests' });
      expect(second.skipped[0]!.reason).toContain(first.imported[0]!.envelopeRef);
      // No new publish calls on the second run.
      expect(published).toHaveLength(2);
    });

    it('re-running execute() over CHANGED content republishes and sets provenance.supersedes to the prior ref', async () => {
      const source1 = mockSource([skill({ skillMd: '# write-tests\n\nVersion one.' })]);
      const { deps, published } = mockPublishDeps();
      const state = createMemorySeedImportState();

      const first = await execute(await plan(source1), source1, deps, { state });
      expect(first.imported).toHaveLength(1);
      const firstRef = first.imported[0]!.envelopeRef;

      const source2 = mockSource([skill({ skillMd: '# write-tests\n\nVersion two — changed.' })]);
      const second = await execute(await plan(source2), source2, deps, { state });
      expect(second.imported).toHaveLength(1);
      expect(second.imported[0]!.envelopeRef).not.toBe(firstRef);

      const secondSkillPayload = SkillArtifactV1Schema.parse(
        published.filter((p) => p.artifactType === SKILL_ARTIFACT_TYPE)[1]!.payload,
      );
      expect(secondSkillPayload.provenance.supersedes).toBe(firstRef);
    });

    it('without an injected state store, each execute() call starts fresh — no cross-call idempotency', async () => {
      const source = mockSource([skill()]);
      const report = await plan(source);
      const { deps, published } = mockPublishDeps();

      const first = await execute(report, source, deps);
      const second = await execute(report, source, deps);
      expect(first.imported).toHaveLength(1);
      expect(second.imported).toHaveLength(1); // no skip: the default state is fresh per call
      expect(second.imported[0]!.envelopeRef).not.toBe(first.imported[0]!.envelopeRef);
      expect(published).toHaveLength(4); // two full publishes (trace + skill each)
    });

    it('hashSeedContent is a pure function of its input', () => {
      const value = { a: 1, b: ['x', 'y'], c: { nested: true } };
      expect(hashSeedContent(value)).toBe(hashSeedContent(value));
      expect(hashSeedContent(value)).not.toBe(hashSeedContent({ ...value, a: 2 }));
      // Key order must not affect the hash (canonical JSON).
      expect(hashSeedContent({ b: value.b, a: value.a, c: value.c })).toBe(hashSeedContent(value));
    });
  });

  it('stops the batch after post-publication state persistence fails', async () => {
    const source = mockSource([
      skill({ skill: 'acme/skills/first' }),
      skill({ skill: 'acme/skills/second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    const state = {
      get: () => undefined,
      set: () => {
        throw new Error('synthetic state disk full');
      },
    };

    const result = await execute(await plan(source), source, deps, { state });

    expect(published).toHaveLength(2); // first row's trace + skill only
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({
      skill: 'acme/skills/first',
      stateWarning: expect.stringMatching(/recovery required/i),
    });
    expect(result.errors).toEqual([]);
  });

  it('stops the batch after state lookup fails and never publishes later rows', async () => {
    const source = mockSource([
      skill({ skill: 'acme/skills/first' }),
      skill({ skill: 'acme/skills/second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    let getCalls = 0;
    const state = {
      get: () => {
        getCalls += 1;
        if (getCalls === 1) throw new Error('synthetic state read failure');
        return undefined;
      },
      set: () => undefined,
    };

    const result = await execute(await plan(source), source, deps, { state });

    expect(getCalls).toBe(1);
    expect(published).toHaveLength(0);
    expect(result.imported).toEqual([]);
    expect(result.errors).toEqual([
      {
        skill: 'acme/skills/first',
        error: 'synthetic state read failure',
      },
    ]);
  });

  it('persists the published ref, exposes a ledger warning, and stops the batch after ledger append fails', async () => {
    const source = mockSource([
      skill({ skill: 'acme/skills/first' }),
      skill({ skill: 'acme/skills/second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    deps.ledger = {
      append: () => {
        throw new Error('synthetic ledger disk full');
      },
      list: () => [],
    };
    const records: Array<{ identity: string; envelopeRef: string }> = [];
    const state = {
      get: () => undefined,
      set: (identity: string, record: { envelopeRef: string }) => {
        records.push({ identity, envelopeRef: record.envelopeRef });
      },
    };

    const result = await execute(await plan(source), source, deps, { state });

    expect(published).toHaveLength(2); // first row's trace + skill only
    expect(records).toEqual([
      { identity: 'skill:acme/skills/first', envelopeRef: expect.stringContaining('bafy-envelope') },
    ]);
    expect(result.imported).toEqual([
      expect.objectContaining({
        skill: 'acme/skills/first',
        ledgerWarning: expect.stringMatching(/anchored.*ledger/i),
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  it('halts after an ambiguous publication error and never publishes later rows', async () => {
    const source = mockSource([
      skill({ skill: 'acme/skills/first' }),
      skill({ skill: 'acme/skills/second' }),
    ]);
    const { deps, published } = mockPublishDeps();
    let envelopeCalls = 0;
    deps.publishEnvelope = async () => {
      envelopeCalls += 1;
      throw new Error('synthetic transport timeout');
    };

    const result = await execute(await plan(source), source, deps);

    expect(envelopeCalls).toBe(1);
    expect(published).toHaveLength(2); // first row's trace + skill artifacts
    expect(result.imported).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        skill: 'acme/skills/first',
        error: expect.stringMatching(/publication outcome unknown; do not auto-retry/i),
      }),
    ]);
  });
});

describe('jinn-layer seed CLI', () => {
  function writerSink(): { write: (s: string) => boolean; output: () => string } {
    let buf = '';
    return {
      write(s: string) {
        buf += s;
        return true;
      },
      output: () => buf,
    };
  }

  it('seed plan renders the full report table and writes the report file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-'));
    const out = join(dir, 'report.json');
    const source = mockSource([skill(), skill({ skill: 'acme/skills/gpl', licence: 'GPL-3.0-only' })]);
    const sink = writerSink();
    const code = await runJinnLayerCli(['seed', 'plan', '--out', out], {
      writer: sink,
      seedSource: source,
    });
    expect(code).toBe(0);
    const rendered = sink.output();
    expect(rendered).toContain('acme/skills/write-tests');
    expect(rendered).toContain('import');
    expect(rendered).toContain('GPL-3.0-only');
    const report = parseImportReport(JSON.parse(readFileSyncUtf8(out)));
    expect(report).toHaveLength(2);
  });

  it('seed execute <report-file> publishes the approved import rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-'));
    const reportFile = join(dir, 'report.json');
    const source = mockSource([skill()]);
    const report = await plan(source);
    writeFileSync(reportFile, JSON.stringify(report));
    const { deps, published } = mockPublishDeps();
    const sink = writerSink();
    const code = await runJinnLayerCli(['seed', 'execute', reportFile], {
      writer: sink,
      seedSource: source,
      publishDeps: deps,
      // In-memory idempotency state: the CLI default is file-backed
      // (~/.jinn-client/harness-layer/seed-import-state.json, #1771) so a
      // real operator run persists across invocations — a test must not
      // touch that path.
      seedImportState: createMemorySeedImportState(),
    });
    expect(code).toBe(0);
    expect(published.map((p) => p.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    expect(sink.output()).toContain('bafy-envelope');
  });

  it('returns the published skill ref with a recovery warning and nonzero exit when state persistence fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-'));
    const reportFile = join(dir, 'report.json');
    const source = mockSource([skill()]);
    writeFileSync(reportFile, JSON.stringify(await plan(source)));
    const { deps, published } = mockPublishDeps();
    const sink = writerSink();

    const code = await runJinnLayerCli(['seed', 'execute', reportFile, '--json'], {
      writer: sink,
      seedSource: source,
      publishDeps: deps,
      seedImportState: {
        get: () => undefined,
        set: () => {
          throw new Error('synthetic disk full');
        },
      },
    });

    expect(code).toBe(1);
    expect(published).toHaveLength(2);
    const payload = JSON.parse(sink.output()) as {
      imported: Array<{ envelopeRef: string; stateWarning?: string }>;
      errors: unknown[];
    };
    expect(payload.errors).toEqual([]);
    expect(payload.imported).toEqual([
      expect.objectContaining({
        envelopeRef: expect.stringContaining('bafy-envelope'),
        stateWarning: expect.stringMatching(/published.*state.*recovery/i),
      }),
    ]);
  });
});

// ── Seed-profile scrub (#1409) — regression: seeds anchored but defaced ─────

describe('execute() seed-profile scrub (#1409)', () => {
  // The three observed entropy-fallback false positives plus the openredaction
  // trigger-word shapes (#1372/#1391) in one synthetic SKILL.md. AC1: the
  // published envelope carries this byte-identical.
  const SEED_SKILL_MD = [
    '---',
    'name: backend-refactor-helper',
    'license: MIT',
    '---',
    '# backend-refactor-helper',
    '',
    'Use this skill before touching the backend. It reads user intent first.',
    '',
    'Run export PLAN_ID=2026-01-10-backend-refactor to pin the plan.',
    'Set PublicNetworkAccessDisabled on the account.',
    'Check the IPv4StandardSkuPublicIpAddresses quota.',
  ].join('\n');

  const report: ImportReport = [
    {
      skill: 'acme/skills/backend-refactor-helper',
      source: 'https://github.com/acme/skills',
      licence: 'MIT',
      verdict: 'import',
      reason: 'licence MIT is allowlisted',
    },
  ];

  it('publishes seed SKILL.md prose byte-identical — no placeholder substitution (AC1)', async () => {
    const source = mockSource([
      skill({ skill: 'acme/skills/backend-refactor-helper', skillMd: SEED_SKILL_MD }),
    ]);
    const { deps, published } = mockPublishDeps();
    const result = await execute(report, source, deps);

    expect(result.errors).toEqual([]);
    expect(result.imported).toHaveLength(1);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    const attrs = envelope.steps[0]!.attributes as Record<string, unknown>;
    expect(attrs['skill.md']).toBe(SEED_SKILL_MD);
  });

  it('still redacts a genuine secret in a seed — GitHub PAT and email (AC2)', async () => {
    const pat = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';
    const leaky = `# leaky\n\nUse token ${pat} and mail alice@example.com.`;
    const leakyReport: ImportReport = [
      {
        skill: 'acme/skills/leaky',
        source: 'https://github.com/acme/skills',
        licence: 'MIT',
        verdict: 'import',
        reason: 'licence MIT is allowlisted',
      },
    ];
    const source = mockSource([skill({ skill: 'acme/skills/leaky', skillMd: leaky })]);
    const { deps, published } = mockPublishDeps();
    const result = await execute(leakyReport, source, deps);

    expect(result.errors).toEqual([]);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    const text = String((envelope.steps[0]!.attributes as Record<string, unknown>)['skill.md']);
    expect(text).not.toContain(pat);
    expect(text).not.toContain('alice@example.com');
    expect(text).toContain('[SECRET:');
  });
});

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf-8');
}
