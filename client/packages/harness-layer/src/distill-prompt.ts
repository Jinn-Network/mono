/**
 * `jinn-skill-distill-prompt-v1` — the layer-1-evidence → layer-2-skill
 * distillation prompt (spec/2026-07-06-distillation-v1.md §7, D4/D10).
 *
 * Two modes keyed to the cluster's promotion tier (§6), following the SkillRL
 * decomposition (arXiv 2602.08234, §2.4): successes → strategic patterns,
 * evaluator-confirmed failures → concise failure lessons. Single-shot and flat
 * for v1 — no recursion, no General/Task-Specific hierarchy (that is v3).
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
- The description must say WHEN to reach for this ("Use when …"), so retrieval fires on the right situation.

MODE = failure-lesson (the traces are evaluator-confirmed FAILURES):
- Identify the failure point and the correct counterfactual action — what went wrong and what to do instead.
- The description must fire on the RISKY situation ("Use when about to …"), so the agent is warned before repeating the mistake.

Both modes:
- Produce a name (lowercase-hyphen), a description (the retrieval surface), and a markdown body.
- Generalize: name the transferable rule, not the instance. Do NOT copy verbatim diff hunks, file paths, symbol names, instance ids, or PR numbers — those are contamination and are rejected downstream.
- Never include secrets, keys, tokens, or credentials. A skill has no legitimate need to carry raw key material.
- Use placeholder paths (/path/to/project) and invented example identifiers. Never real home directories (/Users/<name>, /home/<name>), real email addresses, or machine-specific paths — the output scrub redacts those shapes, and ANY redaction drops the whole skill (fail-closed), deterministically, on every retry.
- Be concise. A skill that restates the raw trace has not earned its place over just retrieving the trace.`;

// sha256(JINN_SKILL_DISTILL_PROMPT_V1), verified in distill-prompt.test.ts.
export const JINN_SKILL_DISTILL_PROMPT_V1_SHA256 =
  '339923fd9bbda6ed6a470e0c5c073928c90926dc213c473b69618d9508814918';
