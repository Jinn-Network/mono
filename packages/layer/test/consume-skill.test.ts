import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  CorpusDiscoveryPort,
  EnvelopeRef,
} from '@jinn-network/core/corpus-read';
import type { SignedEnvelope } from '@jinn-network/core';
import { createHarnessLayer } from '../src/consume.js';
import { SqliteCorpusStore } from '../src/corpus-store.js';
import {
  SKILL_ARTIFACT_TYPE,
  type SkillArtifactV1,
} from '@jinn-network/core';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function envelope(opts: {
  solverType: string;
  role: 'capture';
  artifactType: string;
  participantSafe?: string;
  sha256?: string;
}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: opts.solverType,
    role: opts.role,
    generatedAt: 1745978400,
    // role=capture requires sessionProvenance and no `task` (envelope schema).
    sessionProvenance: {
      sessionId: `skill:${opts.solverType}`,
      capturedAt: '2026-07-06T00:00:00.000Z',
      originatingTool: { name: 'jinn-distiller', version: '0.1.0' },
      license: { operatorAssertion: 'unspecified' },
    },
    participant: { safeAddress: opts.participantSafe ?? '0x' + 'a'.repeat(40), agentEoa: '0x' + '2'.repeat(40) },
    window: { startTs: 0, endTs: 1000 },
    executor: {
      implName: 'test', implVersion: '0.1.0', clientGitSha: 'abc',
      codeDigest: 'sha256:' + 'c'.repeat(64), runtimeBundleDigest: 'sha256:' + 'd'.repeat(64),
      plugins: [], signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [{ artifactType: opts.artifactType, sha256: opts.sha256 ?? 'a'.repeat(64), access: { endpoint: 'https://e', priceUsdc: '0' } }],
    payload: {},
    signature: { algo: 'secp256k1', signer: '0x' + '2'.repeat(40), hash: '0x' + 'e'.repeat(64), sig: '0x' + 'f'.repeat(130) },
  } as SignedEnvelope;
}

/**
 * A skill-record fixture: an envelope carrying a jinn.skill.v1 artifact whose
 * sha256 matches the acquirable skill JSON body (mirrors consume.test.ts's
 * get() round-trip). Returns the pieces to wire into fetchFromIpfs/acquireFn.
 */
interface SkillSpec {
  cid: string;
  /** On-chain operator identity → `ref.operator.agentId`. The field head-resolution keys off. */
  op: string;
  name: string;
  supersedes?: string;
  deprecates?: boolean;
  /**
   * Envelope `participant.safeAddress` — free-form, forgeable content. Defaults
   * to `op`. Head-resolution must IGNORE it (a forged value must not grief).
   */
  participantSafe?: string;
  /**
   * Skill-BODY `provenance.operator.safeAddress`, set independently. Defaults to
   * `op`. Also forgeable content the supersede decision must ignore.
   */
  bodyOp?: string;
}

function skillFixture(spec: SkillSpec): { env: SignedEnvelope; sha: string; bytes: Buffer } {
  const skill: SkillArtifactV1 = {
    schemaVersion: SKILL_ARTIFACT_TYPE,
    skill: { name: spec.name, skillMd: `# ${spec.name}\n\nbody` },
    files: [],
    provenance: {
      kind: 'distilled',
      sourceEnvelopeCids: [],
      operator: { safeAddress: (spec.bodyOp ?? spec.op) as `0x${string}` },
      ...(spec.supersedes !== undefined ? { supersedes: spec.supersedes } : {}),
      ...(spec.deprecates !== undefined ? { deprecates: spec.deprecates } : {}),
    },
  };
  const bytes = Buffer.from(JSON.stringify(skill), 'utf-8');
  const sha = sha256(bytes);
  const env = envelope({
    solverType: 'distilled-skill',
    role: 'capture',
    artifactType: SKILL_ARTIFACT_TYPE,
    participantSafe: spec.participantSafe ?? spec.op,
    sha256: sha,
  });
  return { env, sha, bytes };
}

/** Build the discovery/fetchFromIpfs/acquireFn stubs from a set of skill specs. */
function wireSkills(specs: SkillSpec[], opts: { unfetchable?: Set<string> } = {}) {
  const byCid = new Map<string, SignedEnvelope>();
  const bySha = new Map<string, Buffer>();
  const refs: EnvelopeRef[] = [];
  for (const spec of specs) {
    const { env, sha, bytes } = skillFixture(spec);
    byCid.set(spec.cid, env);
    if (!opts.unfetchable?.has(spec.cid)) bySha.set(sha, bytes);
    refs.push(ref(spec.cid, spec.op));
  }
  const discovery = stubDiscovery(refs);
  const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
    const env = byCid.get(cid);
    if (!env) throw new Error(`unknown cid ${cid}`);
    return env;
  });
  const acquireFn = vi.fn(async (_endpoint: string, sha: string) => bySha.get(sha) ?? null);
  return { discovery, fetchFromIpfs, acquireFn };
}

function ref(manifestCid: string, agentId = '7'): EnvelopeRef {
  return { manifestCid, manifestHash: '0x' + 'a'.repeat(64), operator: { agentId, safeAddress: '' }, evidenceTier: 'self-signed', publishedAt: 1745978400 };
}

function stubDiscovery(refs: EnvelopeRef[]): CorpusDiscoveryPort {
  return { queryEnvelopes: vi.fn().mockResolvedValue(refs) };
}

describe('consume surfaces jinn.skill.v1', () => {
  let store: SqliteCorpusStore;
  beforeEach(() => { store = new SqliteCorpusStore(':memory:'); });
  afterEach(() => store.close());

  it('tags each hit with kind, and search({kind:"skill"}) returns only skills', async () => {
    const discovery = stubDiscovery([ref('bafySkill'), ref('bafyTrace')]);
    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === 'bafySkill') return envelope({ solverType: 'distilled-skill', role: 'capture', artifactType: SKILL_ARTIFACT_TYPE });
      if (cid === 'bafyTrace') return envelope({ solverType: 'capture', role: 'capture', artifactType: 'jinn.trace-envelope.v0' });
      throw new Error('unknown cid');
    });
    // Head-resolution body-fetches skill hits; return null so it stays hermetic
    // (no network) — an unfetchable body hides nothing, so the skill stays.
    const acquireFn = vi.fn(async () => null);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });

    const all = await layer.corpus.search('');
    const skillHit = all.find((h) => h.artifactTypes.includes(SKILL_ARTIFACT_TYPE));
    const traceHit = all.find((h) => h.ref === 'bafyTrace');
    expect(skillHit?.kind).toBe('skill');
    expect(traceHit?.kind).toBe('trace');

    const skillsOnly = await layer.corpus.search('', { kind: 'skill' });
    expect(skillsOnly.map((h) => h.ref)).toEqual(['bafySkill']);
    expect(skillsOnly.every((h) => h.kind === 'skill')).toBe(true);
  });
});

describe('supersede head resolution (#1462)', () => {
  let store: SqliteCorpusStore;
  beforeEach(() => { store = new SqliteCorpusStore(':memory:'); });
  afterEach(() => store.close());

  const OP1 = '0x' + '1'.repeat(40);
  const OP2 = '0x' + '2'.repeat(40);

  it('A <- B <- C, same operator: search returns only the head C', async () => {
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'A', op: OP1, name: 'skill-a' },
      { cid: 'B', op: OP1, name: 'skill-b', supersedes: 'A' },
      { cid: 'C', op: OP1, name: 'skill-c', supersedes: 'B' },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const hits = await layer.corpus.search('');
    expect(hits.map((h) => h.ref)).toEqual(['C']);
  });

  it('cross-operator supersede is ignored: both the target and successor stay visible', async () => {
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'T', op: OP1, name: 'skill-t' },
      { cid: 'S', op: OP2, name: 'skill-s', supersedes: 'T' },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref).sort();
    expect(refs).toEqual(['S', 'T']);
  });

  it('an unattributed hit (empty agentId) never supersedes — fail-safe', async () => {
    // Both records carry an empty on-chain agentId (a backend that does not
    // attribute the hit). The same-operator check requires both agentIds
    // non-empty, so it never fires: nothing is collapsed — even though the
    // forgeable participant/body content matches (both OP1). (participantSafe /
    // bodyOp are set to a valid address only so the envelope/body schema parse;
    // the gate keys off the empty agentId, not these fields.)
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'T', op: '', name: 'skill-t', participantSafe: OP1, bodyOp: OP1 },
      { cid: 'S', op: '', name: 'skill-s', supersedes: 'T', participantSafe: OP1, bodyOp: OP1 },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref).sort();
    expect(refs).toEqual(['S', 'T']);
  });

  it('a deprecation record retires its target and hides itself, leaving an unrelated skill', async () => {
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'X', op: OP1, name: 'skill-x' },
      { cid: 'D', op: OP1, name: 'skill-d', supersedes: 'X', deprecates: true },
      { cid: 'Y', op: OP1, name: 'skill-y' },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref);
    expect(refs).toEqual(['Y']);
  });

  it('includeSuperseded returns the full lineage (no head collapse)', async () => {
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'A', op: OP1, name: 'skill-a' },
      { cid: 'B', op: OP1, name: 'skill-b', supersedes: 'A' },
      { cid: 'C', op: OP1, name: 'skill-c', supersedes: 'B' },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('', { includeSuperseded: true })).map((h) => h.ref).sort();
    expect(refs).toEqual(['A', 'B', 'C']);
  });

  it('a body-fetch failure for the successor hides nothing (fail-safe)', async () => {
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills(
      [
        { cid: 'T', op: OP1, name: 'skill-t' },
        { cid: 'S', op: OP1, name: 'skill-s', supersedes: 'T' },
      ],
      { unfetchable: new Set(['S']) },
    );
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref).sort();
    expect(refs).toEqual(['S', 'T']);
  });

  it('a trace-kind hit passes through unchanged and is never body-fetched', async () => {
    const discovery = stubDiscovery([ref('bafyTrace')]);
    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === 'bafyTrace') return envelope({ solverType: 'capture', role: 'capture', artifactType: 'jinn.trace-envelope.v0' });
      throw new Error('unknown cid');
    });
    const acquireFn = vi.fn(async () => null);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const hits = await layer.corpus.search('');
    expect(hits.map((h) => h.ref)).toEqual(['bafyTrace']);
    expect(acquireFn).not.toHaveBeenCalled();
  });

  // Security pins: the same-operator supersede check keys off the on-chain
  // `ref.operator.agentId`, NOT the forgeable envelope `participant.safeAddress`
  // (nor the skill-body `provenance.operator`). These pin that source — and that
  // a forged participant.safeAddress cannot grief a victim's skill.
  it('same-operator supersede keys off the on-chain agentId, not the envelope participant', async () => {
    // agentIds MATCH (both OP1); participant.safeAddress DIFFERS (T=xxx, S=yyy)
    // and body provenance also differs. Keying off agentId fires the supersede
    // (T excluded). Keying off participant.safeAddress would NOT (xxx≠yyy).
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'T', op: OP1, name: 'skill-t', participantSafe: '0x' + 'c'.repeat(40), bodyOp: OP2 },
      { cid: 'S', op: OP1, name: 'skill-s', supersedes: 'T', participantSafe: '0x' + 'd'.repeat(40) },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref);
    expect(refs).toEqual(['S']);
  });

  it('a forged participant.safeAddress cannot retire a victim: differing agentId keeps both visible', async () => {
    // The grief attempt: attacker S is published under its OWN agentId (OP2) but
    // FORGES participant.safeAddress to the victim's (OP1) and points supersedes
    // at the victim's skill T (agentId OP1). Keying off agentId, OP2≠OP1, so the
    // supersede does NOT fire and T stays visible. Keying off participant.safeAddress
    // (the old, forgeable behavior) would have wrongly excluded T.
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'T', op: OP1, name: 'skill-t' },
      { cid: 'S', op: OP2, name: 'skill-s', supersedes: 'T', participantSafe: OP1 },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref).sort();
    expect(refs).toEqual(['S', 'T']);
  });

  it('deprecates:true with no supersedes self-hides and leaves unrelated skills untouched', async () => {
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'D', op: OP1, name: 'skill-d', deprecates: true },
      { cid: 'U', op: OP1, name: 'skill-u' },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref);
    expect(refs).toEqual(['U']);
  });

  it('supersedes pointing outside the fetched page throws nothing and keeps the successor', async () => {
    const { discovery, fetchFromIpfs, acquireFn } = wireSkills([
      { cid: 'S', op: OP1, name: 'skill-s', supersedes: 'not-in-this-page' },
      { cid: 'U', op: OP1, name: 'skill-u' },
    ]);
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs, acquireFn });
    const refs = (await layer.corpus.search('')).map((h) => h.ref).sort();
    expect(refs).toEqual(['S', 'U']);
  });
});
