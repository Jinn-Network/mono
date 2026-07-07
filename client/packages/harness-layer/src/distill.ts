/**
 * The distillation step — evidence clusters → layer-2 skills
 * (spec/2026-07-06-distillation-v1.md §7, D4/D10).
 *
 * Scripted, single-shot, flat (recursion/hierarchy are v3). Two modes keyed to
 * the cluster's tier (§6): pattern-eligible → strategic-pattern skill;
 * lesson-eligible → failure-lesson skill. Each skill is:
 *   1. distilled by an injected LLM port (`deps.distill`) using
 *      `jinn-skill-distill-prompt-v1` (the port owns the model call);
 *   2. **secret-scrubbed fail-closed** — the body is run through the layer-2
 *      pipeline; if the scrub would change anything (a secret was present), the
 *      skill is DROPPED, not published (so published bodies are provably clean
 *      AND never re-defaced, §7 step 4 / §10);
 *   3. **contamination-scanned** against the held-out slate (§12 axis 3) — a
 *      body naming a slate instance/repo/PR is dropped;
 *   4. published via `publishSkill()` with provenance back-links + the prompt SHA.
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
  /** `pattern` (successes) or `lesson` (evaluator-confirmed failures). */
  tier: 'pattern' | 'lesson';
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
  scrubPipeline?: ScrubPipeline;
  now?: () => Date;
}

export interface DistillResult {
  published: Array<{ clusterId: string; skillKind: 'strategic-pattern' | 'failure-lesson'; envelopeRef: string }>;
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

      const name = sanitizeName(out.name);
      if (!name) {
        // An empty/all-symbol LLM name is a rejection (bad output), not an error.
        result.rejected.push({ clusterId: cluster.clusterId, reason: `non-conformant skill name from distiller: ${JSON.stringify(out.name)}` });
        continue;
      }
      assertConformantName(name); // defensive; sanitizeName should already conform
      const skillKind = cluster.tier === 'pattern' ? 'strategic-pattern' : 'failure-lesson';
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
