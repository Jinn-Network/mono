/**
 * The distillation step — evidence clusters → layer-2 skills
 * (spec/2026-07-06-distillation-v1.md §7, D4/D10).
 *
 * Scripted, single-shot, flat (recursion/hierarchy are v3). Three modes keyed to
 * the cluster's tier (§7): pattern → strategic-pattern skill; lesson →
 * failure-lesson skill (diagnosis, not prescription); contrastive → one skill
 * from both polarities of an instance. Each skill is:
 *   1. distilled by an injected LLM port (`deps.distill`) using
 *      `jinn-skill-distill-prompt-v1` (the port owns the model call);
 *   2. **secret-scrubbed fail-closed** — the body is run through the layer-2
 *      pipeline; if the scrub would change anything (a secret was present), the
 *      skill is DROPPED, not published (so published bodies are provably clean
 *      AND never re-defaced, §7 step 4 / §10);
 *   3. **contamination-scanned** against the held-out slate (§12 axis 3) — a
 *      body naming a slate instance/repo/PR is dropped;
 *   4. **structurally gated** (§7 step 6, v0.5) — the fixed skeleton (five
 *      non-empty sections), the description anti-trigger ("Not for:"), and (for
 *      lessons) the imperative-counterfactual guard, all DETERMINISTIC (a deep
 *      quality judge is deferred admission-checking, §13);
 *   5. published via `publishSkill()` with provenance back-links, the prompt
 *      SHA, and the auditability fields (distill model + token estimates, §5).
 *
 * Clustering is upstream (human-curated for v1, §7) — this consumes pre-formed
 * clusters of eligible evidence.
 */

import { buildLayer2ScrubPipeline } from '../../../src/trajectory/scrub/layer2.js';
import type { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';
import {
  assertConformantName,
  type SkillPackage,
} from './skill-package.js';
import { JINN_SKILL_DISTILL_PROMPT_V1_SHA256 } from './distill-prompt.js';

export interface DistillCluster {
  clusterId: string;
  /**
   * `pattern` (successes), `lesson` (evaluator-confirmed failures), or
   * `contrastive` (both polarities for one instance — the pass↔fail delta,
   * §7 v0.5). A contrastive cluster carries evidence refs from BOTH polarities.
   */
  tier: 'pattern' | 'lesson' | 'contrastive';
  /** Source evidence envelope refs → `metadata.jinn.provenance`. */
  evidenceRefs: string[];
  /** The distinct instance ids in the cluster (audit / dedup upstream). */
  instanceIds: string[];
  /** Opaque payload handed to the LLM port (the cluster's evidence). */
  input: unknown;
}

export interface DistillLLMOutput {
  name: string;
  description: string;
  body: string;
}

export interface DistillDeps {
  /** The LLM port: runs jinn-skill-distill-prompt-v1 over the cluster. */
  distill: (cluster: DistillCluster) => Promise<DistillLLMOutput>;
  /** Publish a skill package as a corpus record (Plan A `publishSkill`). */
  publishSkill: (pkg: SkillPackage) => Promise<{ envelopeRef: string; anchorTx: string | null }>;
  /** The held-out slate for the contamination scan (§12). */
  slate: { instanceIds: Set<string>; repos?: Set<string> };
  distribution?: string;
  /** The model that ran distillation — recorded in provenance (§5 auditability). */
  distillModel?: string;
  scrubPipeline?: ScrubPipeline;
  now?: () => Date;
}

export type SkillKind = 'strategic-pattern' | 'failure-lesson' | 'contrastive';

export interface DistillResult {
  published: Array<{ clusterId: string; skillKind: SkillKind; envelopeRef: string }>;
  rejected: Array<{ clusterId: string; reason: string }>;
  errors: Array<{ clusterId: string; error: string }>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive held-out slate tokens from SWE-bench `instance_id`s (`owner__repo-<pr#>`)
 * and any explicit repos, split by match strategy:
 *
 * - **substrings** — delimiter-bearing tokens with a low false-positive rate
 *   (the full `owner__repo-n` instance id, `owner/repo`, `#pr`). Matched by
 *   plain `includes`.
 * - **words** — bare identifiers (the repo name alone, e.g. `flask`, `go`,
 *   `requests`) that recur inside ordinary prose. Matched on `\b`-word
 *   boundaries so "we are **go**ing" / "handle **requests**" do NOT trip the
 *   scan, while a body literally naming the held-out repo as a word does.
 *
 * Local to the distiller (cap-v0 will carry repos explicitly, retiring this)
 * so the module does not couple to the bridge branch.
 */
function slateTokens(slate: { instanceIds: Set<string>; repos?: Set<string> }): { substrings: string[]; words: string[] } {
  const substrings = new Set<string>();
  const words = new Set<string>();
  for (const id of slate.instanceIds) {
    substrings.add(id.toLowerCase()); // full instance id (carries `__` and `-`)
    const m = /^(.+)__(.+)-(\d+)$/.exec(id);
    if (m) {
      substrings.add(`${m[1]}/${m[2]}`.toLowerCase()); // owner/repo (carries `/`)
      substrings.add(`#${m[3]}`); // #pr (carries `#`)
      words.add(m[2]!.toLowerCase()); // bare repo → word-boundary match
    }
  }
  for (const repo of slate.repos ?? []) words.add(repo.toLowerCase());
  return { substrings: [...substrings], words: [...words] };
}

/**
 * Scan a distilled body for held-out slate tokens (instance id / repo / PR#).
 * Delimiter-bearing tokens match as substrings; bare repo names match only on
 * word boundaries, so a common-word repo does not silently drop a clean skill.
 */
export function lexicalContaminationScan(
  body: string,
  slate: { instanceIds: Set<string>; repos?: Set<string> },
): { contaminated: boolean; hits: string[] } {
  const lower = body.toLowerCase();
  const { substrings, words } = slateTokens(slate);
  const hits: string[] = [];
  for (const t of substrings) if (t && lower.includes(t)) hits.push(t);
  for (const w of words) {
    if (w && new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lower)) hits.push(w);
  }
  return { contaminated: hits.length > 0, hits };
}

function sanitizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The fixed distilled-skill skeleton (§5, v0.5): each section must be non-empty. */
const REQUIRED_SECTIONS = ['When to use', 'Strategy', 'Steps', 'Pitfalls', 'Verify'] as const;

/**
 * Extract the trimmed content under a `## <title>` heading (case-insensitive),
 * up to the next `## ` heading or EOF. Returns null when the heading is absent.
 * `### ` and deeper subheadings are content, not section boundaries.
 */
function sectionContent(md: string, title: string): string | null {
  let capturing = false;
  const captured: string[] = [];
  for (const line of md.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (capturing) break; // next section heading ends this one
      if (h[1]!.trim().toLowerCase() === title.toLowerCase()) capturing = true;
      continue;
    }
    if (capturing) captured.push(line);
  }
  return capturing ? captured.join('\n').trim() : null;
}

/**
 * Lexical markers of an IMPERATIVE counterfactual in a failure-lesson body
 * (spec §7 v0.5 verified-counterfactual rule). Deliberately SHALLOW — a deep
 * semantic judge of lesson quality is admission-checking, deferred (§13). The
 * evidence verifies THAT an attempt failed; a lesson states diagnosis, and
 * stating a prescription ("do X instead") as fact overstates that evidence.
 */
const LESSON_IMPERATIVE_COUNTERFACTUAL: RegExp[] = [
  /\binstead[,:]?\s+(do|use|run|call|apply|prefer|switch|add|set|replace|write)\b/i,
  /\bthe (correct|right)\s+\w+\s+is\b/i,
];

/**
 * Deterministic structural conformance gate (spec §7 step 6, v0.5). Returns a
 * rejection reason, or null when the output conforms:
 *  - fixed skeleton: all five sections present and non-empty;
 *  - description anti-trigger: a "Not for:" clause is present;
 *  - (lesson tier only) no imperative counterfactual.
 */
function structuralRejection(out: DistillLLMOutput, tier: DistillCluster['tier']): string | null {
  for (const title of REQUIRED_SECTIONS) {
    const content = sectionContent(out.body, title);
    if (content === null) return `skeleton: missing section "## ${title}"`;
    if (content.length === 0) return `skeleton: empty section "## ${title}"`;
  }
  if (!/\bNot for\b/i.test(out.description)) {
    return 'description missing "Not for:" anti-trigger clause';
  }
  if (tier === 'lesson' && LESSON_IMPERATIVE_COUNTERFACTUAL.some((re) => re.test(out.body))) {
    return 'lesson counterfactual: unverified prescription (diagnosis only unless contrastive)';
  }
  return null;
}

/** Deterministic token estimate: ceil(utf8 bytes / 4) — the §5 compression metric. */
function estimateTokens(s: string): number {
  return Math.ceil(new TextEncoder().encode(s).length / 4);
}

const SKILL_KIND_BY_TIER: Record<DistillCluster['tier'], SkillKind> = {
  pattern: 'strategic-pattern',
  lesson: 'failure-lesson',
  contrastive: 'contrastive',
};

export async function distillClusters(
  clusters: DistillCluster[],
  deps: DistillDeps,
): Promise<DistillResult> {
  const pipeline = deps.scrubPipeline ?? buildLayer2ScrubPipeline();
  const distribution = deps.distribution ?? 'coding';
  const now = deps.now?.() ?? new Date();
  const result: DistillResult = { published: [], rejected: [], errors: [] };

  for (const cluster of clusters) {
    try {
      const out = await deps.distill(cluster);

      // (2) fail-closed output secret scrub: publish only bodies that scrub to a
      // no-op — so a published skill is provably secret-free and never re-defaced.
      const scrubbed = await pipeline.run({ 'skill.md': out.body });
      if (scrubbed.redactions.length > 0 || String(scrubbed.attributes['skill.md']) !== out.body) {
        // Name WHAT tripped the scrub: check-mode rejection is deterministic
        // (the same body re-rejects on every re-distill), so the operator needs
        // the stage/detail to fix the prompt or the evidence — not a blind retry.
        const hits = [...new Set(scrubbed.redactions.map((r) => `${r.stage}/${r.detail ?? r.kind}`))];
        const detail = hits.length > 0 ? hits.join(', ') : 'body altered by scrub';
        result.rejected.push({
          clusterId: cluster.clusterId,
          reason: `secret-in-output (dropped, fail-closed): ${detail}`,
        });
        continue;
      }

      // (3) contamination scan against the held-out slate.
      const scan = lexicalContaminationScan(out.body, deps.slate);
      if (scan.contaminated) {
        result.rejected.push({ clusterId: cluster.clusterId, reason: `contamination: ${scan.hits.join(', ')}` });
        continue;
      }

      // (4) deterministic structural conformance gate (§7 step 6, v0.5).
      const structuralReason = structuralRejection(out, cluster.tier);
      if (structuralReason) {
        result.rejected.push({ clusterId: cluster.clusterId, reason: structuralReason });
        continue;
      }

      const name = sanitizeName(out.name);
      if (!name) {
        // An empty/all-symbol LLM name is a rejection (bad output), not an error.
        result.rejected.push({ clusterId: cluster.clusterId, reason: `non-conformant skill name from distiller: ${JSON.stringify(out.name)}` });
        continue;
      }
      assertConformantName(name); // defensive; sanitizeName should already conform
      const skillKind = SKILL_KIND_BY_TIER[cluster.tier];
      const pkg: SkillPackage = {
        name,
        description: out.description,
        license: null,
        jinn: {
          schema: 'jinn.skill.v1',
          distribution,
          verifiabilityTier: 'evaluator-verified',
          distilledFrom: cluster.evidenceRefs.length,
          provenance: cluster.evidenceRefs,
          distillPromptSha256: JINN_SKILL_DISTILL_PROMPT_V1_SHA256,
          distilledAt: now.toISOString(),
          skillKind,
          ...(deps.distillModel ? { distillModel: deps.distillModel } : {}),
          evidenceTokens: estimateTokens(JSON.stringify(cluster.input ?? '')),
          skillTokens: estimateTokens(out.body),
        },
        body: out.body,
      };
      const pub = await deps.publishSkill(pkg);
      result.published.push({ clusterId: cluster.clusterId, skillKind, envelopeRef: pub.envelopeRef });
    } catch (err) {
      result.errors.push({ clusterId: cluster.clusterId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
