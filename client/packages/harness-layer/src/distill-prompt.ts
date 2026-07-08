/**
 * `jinn-skill-distill-prompt-v1` — the layer-1-evidence → layer-2-skill
 * distillation prompt (spec/2026-07-06-distillation-v1.md §7, D4/D10 + v0.5).
 *
 * Three modes keyed to the cluster's tier (§7), following the SkillRL
 * decomposition (arXiv 2602.08234, §2.4) plus the ExpeL contrastive axis:
 * successes → strategic patterns; evaluator-confirmed failures → failure
 * lessons stated as DIAGNOSIS, not prescription (the verified-counterfactual
 * rule — the evidence verifies THAT an attempt failed, not the fix); and
 * both-polarity instances → one contrastive skill whose counterfactual IS the
 * verified pass. Every mode emits the fixed skeleton and a trigger/anti-trigger
 * description. Single-shot and flat for v1 (recursion/hierarchy are v3).
 *
 * Like `SESSION_DERIVED_DISTILL_PROMPT_V1`, this is a foundation reference
 * implementation, not protocol canon: a later network-task version may
 * substitute it, and the SHA-256 below is published on every distilled skill
 * (`metadata.jinn.distillPromptSha256`) so generated skills stay auditable.
 */

export const JINN_SKILL_DISTILL_PROMPT_V1 = `You distil verified agent evidence into ONE reusable Agent-Skill (a SKILL.md package).

Input: a cluster of evaluator-verified traces for one coding sub-problem, and a MODE.

MODE = strategic-pattern (the traces are SUCCESSES):
- Extract the critical decision points and the generalizable behavior that made the solve work — the strategy a future agent should reuse, not the specific diff.

MODE = failure-lesson (the traces are evaluator-confirmed FAILURES):
- The evidence verifies THAT this approach failed — it does NOT verify what would have worked. State the DIAGNOSIS: the failure point and WHY the approach fails ("this fails because …"). Do NOT prescribe a fix as fact. You MAY offer a hypothesis, but it must be explicitly marked as one ("likely …", "consider …") — never an imperative "instead, do X" or "the correct fix is X". A verified counterfactual is only available in contrastive mode.

MODE = contrastive (the traces are BOTH a verified PASS and a confirmed FAIL of the SAME problem):
- The delta between the pass and the fail is the signal — extract the causal decision that separates success from failure (what the passing attempt did that the failing one did not). Here the counterfactual IS verified (the pass really worked), so you MAY state it as fact.

Every skill (all modes):
- Produce a name (lowercase-hyphen), a description, and a markdown body.
- The description is the retrieval surface and MUST carry BOTH a trigger and an anti-trigger: "Use when … Not for: …". The anti-trigger names the nearby-but-situationally-wrong case the skill must NOT fire on. For a failure-lesson the trigger is the RISKY situation and the anti-trigger the safe lookalike.
- The body MUST use EXACTLY these five sections, each non-empty, in this order:
  ## When to use
  ## Strategy
  ## Steps
  ## Pitfalls
  ## Verify
- Generalize: name the transferable rule, not the instance. Do NOT copy verbatim diff hunks, file paths, symbol names, instance ids, or PR numbers — those are contamination and are rejected downstream.
- Never include secrets, keys, tokens, or credentials. A skill has no legitimate need to carry raw key material.
- Use placeholder paths (/path/to/project) and invented example identifiers. Never real home directories (/Users/<name>, /home/<name>), real email addresses, or machine-specific paths — the output scrub redacts those shapes, and ANY redaction drops the whole skill (fail-closed), deterministically, on every retry.
- Be concise. A skill that restates the raw trace has not earned its place over just retrieving the trace.`;

// sha256(JINN_SKILL_DISTILL_PROMPT_V1), verified in distill.test.ts. Recomputed
// on every prompt edit (v0.5: three modes + verified-counterfactual + skeleton).
export const JINN_SKILL_DISTILL_PROMPT_V1_SHA256 =
  '44bf8cad03c6d3c17dd726e0f0b9a3375703028bc4be08d15804442626c6c195';
