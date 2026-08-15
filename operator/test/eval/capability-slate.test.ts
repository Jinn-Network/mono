import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCapabilitySlate,
  hashCapabilitySlate,
  assertSlateDisjoint,
  loadCapabilitySlateRepos,
  CAPABILITY_SLATE_SCHEMA_VERSION,
  type CapabilitySlateArtifact,
} from '../../src/eval/capability-slate.js';

const valid: CapabilitySlateArtifact = {
  schemaVersion: CAPABILITY_SLATE_SCHEMA_VERSION,
  solverType: 'swe-rebench-v2.v1',
  version: 'cap-v0',
  generatedAt: '2026-07-06T00:00:00.000Z',
  evalSemanticsVersion: '4',
  instances: [
    {
      instance_id: 'astropy__astropy-19438',
      repo: 'astropy',
      rowHash: 'sha256:aa',
      imageDigest: 'sha256:bb',
      stockPassRate: 0.33,
      screening: { agentSha: 'deadbeef', emptyLoadout: true, noCorpusTools: true, hostSkillDirHash: 'sha256:empty' },
    },
  ],
  construction: 'contested-band[0.15,0.85], stock=haiku, R=3, repo-stratified',
  corpusSnapshotCid: 'ipfs://root',
  corpusDerivedIndexCid: 'ipfs://index',
  loadoutFrozenBeforeSlate: true,
  disjointness: {
    instance: { verdict: 'pass', flaggedPairs: [] },
    repo: { verdict: 'pass', flaggedPairs: [] },
    lexical: { verdict: 'pass', flaggedPairs: [], attestation: 'self-attested' },
    semantic: { verdict: 'n/a-v0', model: null, threshold: null, flaggedPairs: [] },
  },
};

describe('capability slate artifact', () => {
  it('round-trips a valid artifact through parse', () => {
    expect(parseCapabilitySlate(valid)).toEqual(valid);
  });

  it('hash is stable under instance reordering (canonical, sorted)', () => {
    const reordered: CapabilitySlateArtifact = {
      ...valid,
      instances: [
        { ...valid.instances[0]!, instance_id: 'zzz__z-1', repo: 'zzz' },
        valid.instances[0]!,
      ],
    };
    // same set of instances, different order → same hash
    const a = hashCapabilitySlate(valid);
    const b = hashCapabilitySlate({ ...valid, instances: [...valid.instances] });
    expect(a).toBe(b);
    expect(hashCapabilitySlate(reordered)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() => parseCapabilitySlate({ ...valid, schemaVersion: 'nope' })).toThrow(/schemaVersion/);
  });

  it('rejects an instance missing rowHash', () => {
    const bad = { ...valid, instances: [{ ...valid.instances[0]!, rowHash: undefined }] };
    expect(() => parseCapabilitySlate(bad)).toThrow(/rowHash/);
  });

  it('rejects a disjointness axis with a bad verdict', () => {
    const bad = { ...valid, disjointness: { ...valid.disjointness, instance: { verdict: 'maybe', flaggedPairs: [] } } };
    expect(() => parseCapabilitySlate(bad)).toThrow(/verdict/);
  });

  it('rejects a missing disjointness object', () => {
    const bad = { ...valid, disjointness: undefined };
    expect(() => parseCapabilitySlate(bad)).toThrow(/disjointness/);
  });

  it('rejects a lexical axis missing the self-attested attestation', () => {
    const bad = { ...valid, disjointness: { ...valid.disjointness, lexical: { verdict: 'pass', flaggedPairs: [] } } };
    expect(() => parseCapabilitySlate(bad)).toThrow(/attestation/);
  });

  it('assertSlateDisjoint refuses a slate whose disjointness axis self-declares verdict:"fail"', () => {
    const contaminated = parseCapabilitySlate({
      ...valid,
      disjointness: {
        ...valid.disjointness,
        repo: { verdict: 'fail', flaggedPairs: [['astropy__astropy-19438', 'seed-42']] },
      },
    });
    expect(() => assertSlateDisjoint(contaminated)).toThrow(/fail|contaminated/i);
  });

  it('assertSlateDisjoint passes a clean slate (all axes pass or n/a-v0)', () => {
    expect(() => assertSlateDisjoint(valid)).not.toThrow();
  });
});

describe('loadCapabilitySlateRepos', () => {
  it('returns the empty set when the slate directory has no frozen cap-v0 artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-slate-empty-'));
    try {
      expect(loadCapabilitySlateRepos(dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to the shipped slates dir, which has no frozen cap-v0 artifact yet', () => {
    expect(loadCapabilitySlateRepos().size).toBe(0);
  });
});
