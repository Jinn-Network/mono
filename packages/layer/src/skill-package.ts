/**
 * The layer-2 consumable package builder: renders/parses a `jinn.skill.v1`
 * conformant Agent-Skill package (spec/2026-07-06-distillation-v1.md §5,
 * reconciled 2026-07-07 with the shipped #1394 substrate).
 *
 * A skill is a `<name>/SKILL.md` package — standard skills.sh / Vercel shape —
 * so it is drop-in installable by the wider `skills` ecosystem.
 *
 * Division of labour after the #1394 reconciliation:
 *   - `operator/src/types/skill-artifact.ts` (#1394, shipped) owns the CANONICAL
 *     stored form: `SkillArtifactV1` with structured `SkillProvenanceSchema`.
 *   - `./skill.ts` (shipped) owns consume-side recognition (`extractSkill`).
 *   - THIS module is the distiller-side package builder/renderer: the
 *     `SkillPackage` shape the distiller produces, and SKILL.md
 *     rendering/parsing. `buildSkillMarkdown` embeds the `metadata.jinn`
 *     provenance block only in EXPORT mode (default) — when a package is
 *     written to disk as a standalone SKILL.md. The stored `skill.skillMd`
 *     inside a `SkillArtifactV1` is rendered WITHOUT the provenance block
 *     (`embedProvenance: false`) so provenance lives in exactly one canonical
 *     place (the structured object) and cannot drift.
 */
import { parse as parseYaml, Scalar, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { SKILL_ARTIFACT_TYPE } from '@jinn-network/core';

export { SKILL_ARTIFACT_TYPE };

/** skills.sh rule: name is lowercase letters/digits/hyphens and equals the dir. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The distiller-side provenance meta carried on a `SkillPackage` (and embedded
 * as `metadata.jinn` frontmatter in EXPORT renders). The canonical stored form
 * is `SkillProvenanceSchema` in `operator/src/types/skill-artifact.ts`;
 * `publishSkill()` maps this onto it (`provenance` → `sourceEnvelopeCids`,
 * `distilledFrom` is derived as its length there and not stored twice).
 */
export const SkillPackageMetaSchema = z
  .strictObject({
    schema: z.literal(SKILL_ARTIFACT_TYPE),
    distribution: z.string().min(1),
    verifiabilityTier: z.string().min(1),
    distilledFrom: z.number().int().nonnegative(),
    provenance: z.array(z.string().min(1)),
    distillPromptSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    distilledAt: z.string().optional(),
    seedSource: z.string().optional(),
    skillKind: z.enum(['strategic-pattern', 'failure-lesson', 'contrastive', 'cross-instance']).optional(),
    status: z.enum(['experimental', 'stable', 'deprecated']).optional(),
    evidenceTier: z
      .enum(['single-example', 'recurring-pattern', 'contrastive', 'user-confirmed', 'stable', 'deprecated'])
      .optional(),
    sourceTools: z.array(z.string().min(1)).optional(),
    targetTools: z.array(z.string().min(1)).optional(),
    uses: z.number().int().nonnegative().optional(),
    positiveFeedback: z.number().int().nonnegative().optional(),
    negativeFeedback: z.number().int().nonnegative().optional(),
    // Auditability (spec §5, v0.5): the distilling model + a deterministic
    // ceil(chars/4) token estimate of input vs body (the compression ratio).
    distillModel: z.string().min(1).optional(),
    evidenceTokens: z.number().int().nonnegative().optional(),
    skillTokens: z.number().int().nonnegative().optional(),
  })
  // Corroboration vs audit: `distilledFrom` is the DISTINCT-INSTANCE
  // corroboration count (§6 — retries at one problem are one unit, not N),
  // while `provenance` anchors EVERY audited source trace. Under group
  // retention (#1478) one instance can contribute many traces, so
  // `distilledFrom <= provenance.length` (a skill cannot corroborate across
  // more distinct instances than it has traces), and is ≥1 whenever any trace
  // is anchored. This keeps the ecosystem-facing "distilled from N" claim
  // honest as a breadth signal instead of inflating with retry count.
  .refine((m) => m.distilledFrom <= m.provenance.length && (m.provenance.length === 0 || m.distilledFrom >= 1), {
    message: 'distilledFrom must be between 1 and provenance.length (distinct-instance corroboration ≤ audited traces)',
  });
export type SkillPackageMeta = z.infer<typeof SkillPackageMetaSchema>;

export interface SkillPackage {
  name: string;
  description: string;
  license: string | null;
  jinn: SkillPackageMeta;
  body: string;
}

export function assertConformantName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `skill name "${name}" is not conformant (lowercase letters/digits/hyphens only)`,
    );
  }
}

function quotedYamlString(value: string): Scalar<string> {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function renderableJinnMeta(jinn: SkillPackageMeta): Record<string, unknown> {
  return {
    ...jinn,
    ...(jinn.distilledAt ? { distilledAt: quotedYamlString(jinn.distilledAt) } : {}),
  };
}

function normalizeParsedJinnMeta(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (record.distilledAt instanceof Date) {
    record.distilledAt = record.distilledAt.toISOString();
  }
  return record;
}

/**
 * Emit a conformant SKILL.md: YAML frontmatter then the markdown body verbatim.
 *
 * Default (EXPORT mode) embeds the `metadata.jinn` provenance block so a
 * standalone SKILL.md written to disk carries its provenance. Pass
 * `{ embedProvenance: false }` when rendering the `skill.skillMd` stored inside
 * a `SkillArtifactV1` — there the structured provenance object is canonical and
 * embedding a second copy would create drift.
 */
export function buildSkillMarkdown(
  pkg: SkillPackage,
  opts: { embedProvenance?: boolean } = {},
): string {
  assertConformantName(pkg.name);
  const jinn = SkillPackageMetaSchema.parse(pkg.jinn);
  const embed = opts.embedProvenance ?? true;
  const frontmatter = stringifyYaml({
    name: pkg.name,
    description: pkg.description,
    license: pkg.license,
    ...(embed ? { metadata: { jinn: renderableJinnMeta(jinn) } } : {}),
  });
  return `---\n${frontmatter}---\n${pkg.body}`;
}

/** Inverse of buildSkillMarkdown (EXPORT mode); throws on a non-conformant package. */
export function parseSkillMarkdown(md: string): SkillPackage {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error('skill markdown is missing a YAML frontmatter block');
  const doc = parseYaml(m[1]!) as Record<string, unknown> | null;
  if (doc === null || typeof doc !== 'object') {
    throw new Error('skill frontmatter did not parse to an object');
  }
  const name = String(doc.name ?? '');
  assertConformantName(name);
  if (typeof doc.description !== 'string' || doc.description.length === 0) {
    throw new Error('skill frontmatter is missing a description');
  }
  const metadata = doc.metadata as { jinn?: unknown } | undefined;
  const jinn = SkillPackageMetaSchema.parse(normalizeParsedJinnMeta(metadata?.jinn));
  return {
    name,
    description: doc.description,
    license: doc.license == null ? null : String(doc.license),
    jinn,
    body: m[2] ?? '',
  };
}
