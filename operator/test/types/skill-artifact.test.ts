import { describe, it, expect } from 'vitest';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  MAX_SKILL_TOTAL_DECODED_BYTES,
} from '../../src/types/skill-artifact.js';

const SAFE = '0x1111111111111111111111111111111111111111';

function valid() {
  return {
    schemaVersion: 'jinn.skill.v1',
    skill: {
      name: 'write-tests',
      description: 'Write tests before code',
      skillMd: '# write-tests\n\nAlways write a failing test first.',
    },
    files: [
      {
        path: 'reference/EXAMPLES.md',
        contentBase64: Buffer.from('# examples').toString('base64'),
        sha256: 'a'.repeat(64),
      },
    ],
    provenance: {
      kind: 'distilled',
      sourceEnvelopeCids: ['bafySrc1', 'bafySrc2'],
      operator: { safeAddress: SAFE },
      solverType: 'skill-distiller.v0',
    },
  };
}

describe('SkillArtifactV1Schema', () => {
  it('the artifact type constant is the schemaVersion literal', () => {
    expect(SKILL_ARTIFACT_TYPE).toBe('jinn.skill.v1');
  });

  it('parses a valid distilled skill with companion files', () => {
    const parsed = SkillArtifactV1Schema.parse(valid());
    expect(parsed.skill.name).toBe('write-tests');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.provenance.kind).toBe('distilled');
  });

  it('parses an imported seed skill with empty files and seed attribution', () => {
    const parsed = SkillArtifactV1Schema.parse({
      ...valid(),
      files: [],
      provenance: {
        kind: 'imported',
        sourceEnvelopeCids: [],
        operator: { safeAddress: SAFE },
        seed: {
          skill: 'acme/skills/write-tests',
          source: 'https://github.com/acme/skills',
          licence: 'MIT',
        },
      },
    });
    expect(parsed.files).toEqual([]);
    expect(parsed.provenance.seed?.licence).toBe('MIT');
  });

  it('seed licence may be null (repo declares none)', () => {
    const input = valid();
    input.provenance = {
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress: SAFE },
      seed: { skill: 'a/b/c', source: 'https://example.com', licence: null },
    } as never;
    expect(() => SkillArtifactV1Schema.parse(input)).not.toThrow();
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() =>
      SkillArtifactV1Schema.parse({ ...valid(), schemaVersion: 'jinn.skill.v2' }),
    ).toThrow();
  });

  it('rejects absolute and traversal companion paths', () => {
    for (const path of ['/etc/passwd', '../escape.md', 'a/../../b.md', 'C:/windows']) {
      const input = valid();
      input.files[0]!.path = path;
      expect(() => SkillArtifactV1Schema.parse(input)).toThrow();
    }
  });

  it('rejects backslash companion paths (POSIX-only relative paths)', () => {
    // On Windows path.join treats `\` as a separator, so a backslash segment
    // would bypass the '/'-split traversal refine.
    for (const path of ['..\\escape.md', 'a\\..\\..\\b.md', 'reference\\EXAMPLES.md']) {
      const input = valid();
      input.files[0]!.path = path;
      expect(() => SkillArtifactV1Schema.parse(input)).toThrow();
    }
  });

  it('rejects when total decoded content exceeds the 1 MiB cap', () => {
    const input = valid();
    const big = Buffer.alloc(MAX_SKILL_TOTAL_DECODED_BYTES + 1, 'x').toString('base64');
    input.files[0]!.contentBase64 = big;
    expect(() => SkillArtifactV1Schema.parse(input)).toThrow(/1 MiB|cap/i);
  });

  // --- supersede lineage (issue #1462, additive) ---

  it('back-compat: an existing no-lineage fixture parses with supersedes/deprecates undefined', () => {
    const parsed = SkillArtifactV1Schema.parse(valid());
    expect(parsed.provenance.supersedes).toBeUndefined();
    expect(parsed.provenance.deprecates).toBeUndefined();
  });

  it('accepts and round-trips a supersedes CID', () => {
    const input = valid();
    input.provenance.supersedes = 'bafyPrev';
    const parsed = SkillArtifactV1Schema.parse(input);
    expect(parsed.provenance.supersedes).toBe('bafyPrev');
  });

  it('accepts deprecates alongside supersedes (a retirement record)', () => {
    const input = valid();
    input.provenance.supersedes = 'bafyPrev';
    input.provenance.deprecates = true;
    const parsed = SkillArtifactV1Schema.parse(input);
    expect(parsed.provenance.supersedes).toBe('bafyPrev');
    expect(parsed.provenance.deprecates).toBe(true);
  });

  it('rejects an empty supersedes CID (.min(1))', () => {
    const input = valid();
    input.provenance.supersedes = '';
    expect(() => SkillArtifactV1Schema.parse(input)).toThrow();
  });
});
