import { describe, it, expect } from 'vitest';
import {
  IntentMetadataSchema,
  EnvelopeMetadataSchema,
  SourceBundleMetadataSchema,
  ArtifactMetadataSchema,
  metadataToTuple,
  tupleToMetadata,
} from '../../src/discovery/metadata-schemas.js';

describe('IntentMetadataSchema', () => {
  const valid = {
    documentType: 'adw:Intent' as const,
    kind: 'portfolio.v0',
    creator: '0x1111111111111111111111111111111111111111',
    createdAt: 1700000000000,
    requestId: '0x' + 'ab'.repeat(32),
  };

  it('accepts a well-formed intent metadata', () => {
    expect(() => IntentMetadataSchema.parse(valid)).not.toThrow();
  });

  it('rejects wrong documentType', () => {
    expect(() =>
      IntentMetadataSchema.parse({ ...valid, documentType: 'adw:AgentCard' }),
    ).toThrow();
  });

  it('rejects missing kind', () => {
    const { kind: _k, ...bad } = valid;
    expect(() => IntentMetadataSchema.parse(bad)).toThrow();
  });
});

describe('EnvelopeMetadataSchema', () => {
  const valid = {
    documentType: 'adw:ExecutionEnvelope' as const,
    kind: 'portfolio.v0',
    role: 'restoration' as const,
    evidenceTier: 'self-signed' as const,
    intentCid: 'bafy-intent',
    participant: '0x1111111111111111111111111111111111111111',
    generatedAt: 1700000000000,
  };

  it('accepts a well-formed envelope metadata', () => {
    expect(() => EnvelopeMetadataSchema.parse(valid)).not.toThrow();
  });

  it('accepts optional parentEnvelopeCid for verdict envelopes', () => {
    const verdict = { ...valid, role: 'verdict' as const, parentEnvelopeCid: 'bafy-restore' };
    expect(() => EnvelopeMetadataSchema.parse(verdict)).not.toThrow();
  });

  it('accepts optional measurement for attested tier', () => {
    const attested = {
      ...valid,
      evidenceTier: 'attested' as const,
      measurement: '0x' + 'cc'.repeat(48),
    };
    expect(() => EnvelopeMetadataSchema.parse(attested)).not.toThrow();
  });

  it('rejects invalid role', () => {
    expect(() =>
      EnvelopeMetadataSchema.parse({ ...valid, role: 'witness' }),
    ).toThrow();
  });
});

describe('SourceBundleMetadataSchema', () => {
  const valid = {
    documentType: 'adw:SourceBundle' as const,
    measurement: '0x' + 'dd'.repeat(48),
    buildRecipeKind: 'dockerfile' as const,
    publishedBy: '0x1111111111111111111111111111111111111111',
    humanUrl: 'https://github.com/jinn/client-1.0.0',
  };

  it('accepts a well-formed source bundle metadata', () => {
    expect(() => SourceBundleMetadataSchema.parse(valid)).not.toThrow();
  });

  it('accepts with humanUrl omitted', () => {
    const { humanUrl: _h, ...noUrl } = valid;
    expect(() => SourceBundleMetadataSchema.parse(noUrl)).not.toThrow();
  });

  it('rejects invalid buildRecipeKind', () => {
    expect(() =>
      SourceBundleMetadataSchema.parse({ ...valid, buildRecipeKind: 'makefile' }),
    ).toThrow();
  });
});

describe('ArtifactMetadataSchema (extended with parentEnvelopeCid)', () => {
  const valid = {
    documentType: 'adw:Artifact' as const,
    artifactId: 'bafy-art',
    title: 'trajectory',
    tags: ['portfolio.v0'],
    outcome: 'PASS',
    endpoint: 'ipfs://bafy-art',
    parentEnvelopeCid: 'bafy-env',
  };

  it('accepts with parentEnvelopeCid', () => {
    expect(() => ArtifactMetadataSchema.parse(valid)).not.toThrow();
  });

  it('accepts without parentEnvelopeCid (back-compat for legacy artifacts)', () => {
    const { parentEnvelopeCid: _p, ...legacy } = valid;
    expect(() => ArtifactMetadataSchema.parse(legacy)).not.toThrow();
  });
});

describe('metadataToTuple / tupleToMetadata round-trip', () => {
  it('round-trips an intent metadata object through tuple form', () => {
    const original = {
      documentType: 'adw:Intent' as const,
      kind: 'portfolio.v0',
      creator: '0x1111111111111111111111111111111111111111',
      createdAt: 1700000000000,
      requestId: '0x' + 'ab'.repeat(32),
    };
    const tuple = metadataToTuple(original);
    const roundTripped = tupleToMetadata(tuple, IntentMetadataSchema);
    expect(roundTripped).toEqual(original);
  });
});
