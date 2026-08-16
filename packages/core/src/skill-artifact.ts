import { z } from 'zod/v3';

/**
 * jinn.skill.v1 — first-class skill artifact (issue #1394).
 *
 * A skill (SKILL.md + optional companion files + machine-readable
 * provenance) carried as one entry in the `jinn.execution.v1` wrapper
 * envelope's `artifacts[]`. Carrier invariant by provenance kind:
 * **imported** (seeds) publish ALONGSIDE the seeded layer-1 trace envelope
 * (never instead of it); **distilled** skills have no trace of their own —
 * their evidence is the referenced layer-1 envelopes in `sourceEnvelopeCids` —
 * so they publish as a skill-only wrapper (`publishSkill()`,
 * packages/layer/src/publish-skill.ts, DR-2026-07-06).
 * Access/pricing come from the enclosing Artifact
 * entry (operator/src/types/envelope.ts ArtifactSchema: sha256,
 * access.endpoint, access.priceUsdc, metadata.tags).
 *
 * Frozen-caps review (AC3, additive): this schema is a NEW artifact payload
 * type. It does not touch the frozen layer-1 evidence envelope
 * (jinn.trace-envelope.v0 — packages/core/src/envelope.ts,
 * caps in packages/layer/docs/envelope-v0.md) and requires no
 * change to the jinn.execution.v1 wrapper, whose artifacts[] already accepts
 * any artifactType string. Companion-file content lives here, free of the
 * trace envelope's 16 KiB step-attribute cap, under its own 1 MiB total cap.
 *
 * Precedent: operator/src/trajectory/harness-bundle-schema.ts.
 */
export const SKILL_ARTIFACT_TYPE = 'jinn.skill.v1' as const;

/** Max companion files per skill. */
export const MAX_SKILL_FILES = 64;
/** Max total decoded bytes (skillMd + all companion files): 1 MiB. */
export const MAX_SKILL_TOTAL_DECODED_BYTES = 1024 * 1024;

const HexAddressSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

/**
 * Relative, traversal-free POSIX path — this is written to disk on install.
 * Backslashes are rejected outright: on Windows `path.join` treats `\` as a
 * separator, so a `..\` segment would bypass the '/'-split traversal check.
 */
const CompanionPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.startsWith('/') &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split('/').includes('..') &&
      !p.split('/').includes(''),
    { message: 'companion file path must be a relative, traversal-free POSIX path' },
  );

export const SkillCompanionFileSchema = z.object({
  path: CompanionPathSchema,
  contentBase64: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const SkillProvenanceSchema = z.object({
  kind: z.enum(['imported', 'distilled']),
  /**
   * Envelope CIDs the skill was distilled from ([] for seed imports).
   * The "distilled from N traces" count is this array's length — never
   * stored separately (anti-drift).
   */
  sourceEnvelopeCids: z.array(z.string().min(1)),
  operator: z.object({ safeAddress: HexAddressSchema }),
  solverType: z.string().min(1).optional(),
  /** Seed attribution, mirroring the seeded trace's `seed.attribution`. */
  seed: z
    .object({
      skill: z.string().min(1),
      source: z.string().min(1),
      licence: z.string().nullable(),
    })
    .optional(),
  // --- distilled-skill fields (DR-2026-07-06, additive; producer is
  // publishSkill() in packages/layer/src/publish-skill.ts) ---
  /**
   * Success→strategic-pattern, failure→lesson, both-polarity→contrastive
   * (spec §7, D10 + v0.5), or cross-instance corroboration→cross-instance
   * (stage-2 meta-distill). `contrastive` and `cross-instance` are additive
   * enum values: strict consumers (`extractSkill`) reject them until upgraded
   * — acceptable at testnet volume, named in the spec.
   */
  skillKind: z.enum(['strategic-pattern', 'failure-lesson', 'contrastive', 'cross-instance']).optional(),
  /** SHA-256 of the exact distill prompt that produced the skill (auditability, D4). */
  distillPromptSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Task-distribution the skill targets (e.g. 'coding'). */
  distribution: z.string().min(1).optional(),
  /** Verifiability tier of the source evidence (e.g. 'evaluator-verified'). */
  verifiabilityTier: z.string().min(1).optional(),
  /**
   * The model that ran distillation (spec §5, v0.5). Distillation quality is
   * model-sensitive; recording it makes a skill's quality auditable.
   */
  distillModel: z.string().min(1).optional(),
  /**
   * Deterministic `ceil(utf8 chars / 4)` token estimates of the distiller
   * input and the emitted body (spec §5, v0.5). The pair records the
   * compression ratio (SkillRL operates at 10–20×); an auditable estimate
   * serves that purpose better than an unreproducible exact count (the LLM
   * port reports no usage).
   */
  evidenceTokens: z.number().int().nonnegative().optional(),
  skillTokens: z.number().int().nonnegative().optional(),
  // --- supersede lineage (issue #1462, additive) ---
  /**
   * Envelope/manifest CID of a prior skill record this one replaces — the same
   * identity space as `sourceEnvelopeCids` and a search-hit `ref`. Honored at
   * read time ONLY when this record's operator matches the superseded record's
   * operator (cross-operator supersedes are ignored); see the read-path head
   * resolver in packages/layer/src/consume.ts.
   */
  supersedes: z.string().min(1).optional(),
  /**
   * Pure retirement marker: retires this record's `supersedes` target with no
   * replacement and hides this record itself from discovery. A deprecation
   * record carries no successor skill content.
   */
  deprecates: z.boolean().optional(),
});

/** Decoded size of a base64 string without decoding it. */
function base64DecodedBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export const SkillArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(SKILL_ARTIFACT_TYPE),
    skill: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      skillMd: z.string().min(1),
    }),
    files: z.array(SkillCompanionFileSchema).max(MAX_SKILL_FILES),
    provenance: SkillProvenanceSchema,
  })
  .refine(
    (a) =>
      new TextEncoder().encode(a.skill.skillMd).length +
        a.files.reduce((n, f) => n + base64DecodedBytes(f.contentBase64), 0) <=
      MAX_SKILL_TOTAL_DECODED_BYTES,
    { message: 'skill artifact exceeds the 1 MiB total decoded-content cap' },
  );

export type SkillCompanionFile = z.infer<typeof SkillCompanionFileSchema>;
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;
export type SkillArtifactV1 = z.infer<typeof SkillArtifactV1Schema>;
