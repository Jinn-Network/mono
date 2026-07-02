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
} {
  const published: Array<{ artifactType: string; payload: unknown }> = [];
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
    publishEnvelope: async () => ({
      cid: `bafy-envelope-${published.length}`,
      sha256: 'b'.repeat(64),
    }),
    anchorEnvelope: async () => ({ txHash: `0x${'cd'.repeat(32)}` as `0x${string}`, blockNumber: 7 }),
  };
  return { deps, published };
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

    expect(published).toHaveLength(1);
    expect(published[0]!.artifactType).toBe(TRACE_ENVELOPE_ARTIFACT_TYPE);
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
    });
    expect(code).toBe(0);
    expect(published).toHaveLength(1);
    expect(sink.output()).toContain('bafy-envelope');
  });
});

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf-8');
}
