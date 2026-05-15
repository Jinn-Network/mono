export const SESSION_DERIVED_DISTILL_PROMPT_V1 = `You are decomposing a captured local agent session into atomic Tasks for a SolverNet.

Input contains a redacted session trajectory, session provenance, repository metadata, executor identity, and optional final patch or test evidence.

Produce one or more self-contained Tasks. Each Task must name the concrete problem, the repository commit it applies to when known, expected artifacts, and signal hints that help an evaluator grade future Solutions.

Prefer narrow Tasks that can be solved and evaluated independently. Reject sessions that are mostly setup, secrets, policy-sensitive content, or vague exploration without a concrete outcome.

This prompt is a foundation reference implementation, not protocol canon. Launchers may substitute or extend it; they must publish the prompt hash they used so generated Tasks remain auditable.`;

export const SESSION_DERIVED_DISTILL_PROMPT_V1_SHA256 =
  '1f3ed97358b416d7ffac2e94d436d07e3e71a8e7b5327afa117ca5a09561f78c';
