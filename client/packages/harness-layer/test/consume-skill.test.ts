import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import type { DiscoveryAPI } from '../../../src/discovery/types.js';
import type { EnvelopeRef } from '../../../src/corpus/types.js';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import { createHarnessLayer } from '../src/consume.js';
import { SKILL_ARTIFACT_TYPE } from '../../../src/types/skill-artifact.js';

function envelope(opts: { solverType: string; role: 'capture'; artifactType: string }): SignedEnvelope {
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
    participant: { safeAddress: '0x' + 'a'.repeat(40), agentEoa: '0x' + '2'.repeat(40) },
    window: { startTs: 0, endTs: 1000 },
    executor: {
      implName: 'test', implVersion: '0.1.0', clientGitSha: 'abc',
      codeDigest: 'sha256:' + 'c'.repeat(64), runtimeBundleDigest: 'sha256:' + 'd'.repeat(64),
      plugins: [], signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [{ artifactType: opts.artifactType, sha256: 'a'.repeat(64), access: { endpoint: 'https://e', priceUsdc: '0' } }],
    payload: {},
    signature: { algo: 'secp256k1', signer: '0x' + '2'.repeat(40), hash: '0x' + 'e'.repeat(64), sig: '0x' + 'f'.repeat(130) },
  } as SignedEnvelope;
}

function ref(manifestCid: string): EnvelopeRef {
  return { manifestCid, manifestHash: '0x' + 'a'.repeat(64), operator: { agentId: '7', safeAddress: '' }, evidenceTier: 'self-signed', publishedAt: 1745978400 };
}

function stubDiscovery(refs: EnvelopeRef[]): DiscoveryAPI {
  return { queryEnvelopes: vi.fn().mockResolvedValue(refs) } as unknown as DiscoveryAPI;
}

describe('consume surfaces jinn.skill.v1', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => store.close());

  it('tags each hit with kind, and search({kind:"skill"}) returns only skills', async () => {
    const discovery = stubDiscovery([ref('bafySkill'), ref('bafyTrace')]);
    const fetchFromIpfs = vi.fn(async (_g: string, cid: string) => {
      if (cid === 'bafySkill') return envelope({ solverType: 'distilled-skill', role: 'capture', artifactType: SKILL_ARTIFACT_TYPE });
      if (cid === 'bafyTrace') return envelope({ solverType: 'capture', role: 'capture', artifactType: 'jinn.trace-envelope.v0' });
      throw new Error('unknown cid');
    });
    const layer = createHarnessLayer({ store, discovery, fetchFromIpfs });

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
