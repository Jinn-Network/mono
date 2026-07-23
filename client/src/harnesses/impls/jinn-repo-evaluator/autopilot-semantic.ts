import {
  AutopilotReviewResultSchema,
  autopilotCorrelationMatches,
  type AutopilotEvaluationContext,
  type AutopilotReviewResult,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import { VerdictCode, type VerdictCode as RouterVerdictCode } from '../../../adapters/mech/verdict-code.js';

export type AutopilotMechanicalResult =
  | {
      kind: 'passed';
      checkoutDir: string;
      changedFiles: string[];
      checks: string[];
      cleanup(): Promise<void>;
    }
  | {
      kind: 'failed';
      checkoutDir: string;
      changedFiles: string[];
      check: string;
      detail: string;
      cleanup(): Promise<void>;
    }
  | {
      kind: 'unscorable';
      detail: string;
    };

export interface AutopilotMechanicalRunner {
  run(context: AutopilotEvaluationContext): Promise<AutopilotMechanicalResult>;
}

export interface SemanticAgentRunnerInput {
  prompt: string;
  cwd: string;
  model?: string;
  abort: AbortSignal;
}

/** Typed injection boundary for the configured generic semantic agent runtime. */
export interface SemanticAgentRunner {
  run(input: SemanticAgentRunnerInput): Promise<string>;
}

export interface AutopilotSemanticReviewResult {
  review: AutopilotReviewResult;
  gating: {
    passed: boolean;
    verdict: 'PASS' | 'FAIL' | 'UNRESOLVED';
    verdictCode: RouterVerdictCode;
  };
  mechanical: {
    kind: AutopilotMechanicalResult['kind'];
    changedFiles?: string[];
    checks?: string[];
  };
}

interface FullFollowUp {
  type: 'feat' | 'chore' | 'fix' | 'refactor';
  title: string;
  body: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  priority: 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
}

const FOLLOW_UP_TYPES = new Set(['feat', 'chore', 'fix', 'refactor']);
const FOLLOW_UP_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const FOLLOW_UP_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3', 'p4']);

function completeFollowUps(value: unknown): FullFollowUp[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 5) return undefined;
  const result: FullFollowUp[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !['type', 'title', 'body', 'effort', 'priority'].includes(key))
      || !FOLLOW_UP_TYPES.has(String(record['type']))
      || typeof record['title'] !== 'string'
      || record['title'].length === 0
      || typeof record['body'] !== 'string'
      || record['body'].length === 0
      || !FOLLOW_UP_EFFORTS.has(String(record['effort']))
      || !FOLLOW_UP_PRIORITIES.has(String(record['priority']))
    ) {
      return undefined;
    }
    result.push(record as unknown as FullFollowUp);
  }
  return result;
}

function humanResult(
  context: AutopilotEvaluationContext,
  code: string,
  detail: string,
): AutopilotReviewResult {
  return {
    schemaVersion: 'jinn-autopilot-review-result.v1',
    outcome: 'human',
    correlation: context.correlation,
    reason: { code, detail },
  };
}

/**
 * Router mapping for semantic evaluation:
 *   approve -> Pass(1)
 *   request-changes -> Fail(2)
 *   Human or evaluator-infrastructure ambiguity -> Unresolved(4)
 *
 * Invalid(3) remains reserved for the absence of an explicit typed evaluator
 * result. This runner always emits a strict result, converting malformed agent
 * text into an explicit Human result instead of disguising it as ordinary FAIL.
 */
export function semanticReviewGating(
  review: AutopilotReviewResult,
): AutopilotSemanticReviewResult['gating'] {
  switch (review.outcome) {
    case 'approve':
      return { passed: true, verdict: 'PASS', verdictCode: VerdictCode.Pass };
    case 'request-changes':
      return { passed: false, verdict: 'FAIL', verdictCode: VerdictCode.Fail };
    case 'human':
      return { passed: false, verdict: 'UNRESOLVED', verdictCode: VerdictCode.Unresolved };
  }
}

export function buildAutopilotReviewPrompt(
  context: AutopilotEvaluationContext,
  changedFiles: readonly string[],
): string {
  return [
    'Execute the repository review methodology from the existing `review-pr` contract.',
    'This is a marketplace evaluator: do not mutate GitHub, branches, labels, issues, reviews, or Autopilot session state.',
    `Review the complete effective PR diff at exact head ${context.reviewTarget.resultingHead}, not only the latest Solution patch.`,
    `The checkout cwd is detached at that exact head. Compare ${context.reviewTarget.baseOid}...${context.reviewTarget.resultingHead}.`,
    'Treat the supplied accepted Solution adoption receipt and full correlation tuple as immutable authority.',
    'If intent is undeterminable or a Human/CODEOWNER boundary applies, return the human outcome.',
    '',
    `Changed files in the complete effective PR diff:\n${changedFiles.map((file) => `- ${file}`).join('\n') || '- (none)'}`,
    '',
    `Exact evaluation input:\n${JSON.stringify(context, null, 2)}`,
    '',
    'Return only strict jinn-autopilot-review-result.v1 JSON. No markdown fences, commentary, or tool transcript.',
    'Copy the supplied correlation object exactly, including task/request/envelope/session and reviewedHead/reviewGeneration/reviewRefOid fields.',
    'Allowed shapes:',
    '{"schemaVersion":"jinn-autopilot-review-result.v1","outcome":"approve","correlation":{...exact supplied correlation...},"body":"...","followUps":[{"type":"feat | chore | fix | refactor","title":"...","body":"...","effort":"low | medium | high | xhigh | max","priority":"p0 | p1 | p2 | p3 | p4"}]}',
    '{"schemaVersion":"jinn-autopilot-review-result.v1","outcome":"request-changes","correlation":{...exact supplied correlation...},"findings":[{"title":"...","body":"...","path":"optional","line":1}]}',
    '{"schemaVersion":"jinn-autopilot-review-result.v1","outcome":"human","correlation":{...exact supplied correlation...},"reason":{"code":"...","detail":"..."}}',
    'Approve followUps are optional, non-blocking, triage-complete, and bounded to at most 5.',
    'Every follow-up must include "type": "feat | chore | fix | refactor".',
    'Every follow-up must include "effort": "low | medium | high | xhigh | max".',
    'Every follow-up must include "priority": "p0 | p1 | p2 | p3 | p4".',
  ].join('\n');
}

function parseAgentReview(
  output: string,
  context: AutopilotEvaluationContext,
): AutopilotReviewResult {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch (error) {
    return humanResult(
      context,
      'semantic-output-invalid',
      `Semantic agent did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rawRecord = raw !== null && typeof raw === 'object'
    ? raw as Record<string, unknown>
    : null;
  const rawFollowUps = rawRecord?.['outcome'] === 'approve'
    ? rawRecord['followUps']
    : undefined;
  const fullFollowUps = completeFollowUps(rawFollowUps);
  let parsed = AutopilotReviewResultSchema.safeParse(raw);
  // Compatibility only for the pre-tightening SDK reader: it rejected the
  // newly-required triage fields as unknown. The current SDK accepts `raw`
  // directly, so this path disappears after integration.
  if (
    !parsed.success
    && rawRecord?.['outcome'] === 'approve'
    && rawFollowUps !== undefined
    && fullFollowUps !== undefined
  ) {
    parsed = AutopilotReviewResultSchema.safeParse({
      ...rawRecord,
      followUps: fullFollowUps.map(({ title, body }) => ({ title, body })),
    });
  }
  if (!parsed.success) {
    return humanResult(
      context,
      'semantic-output-invalid',
      `Semantic agent output failed the strict review-result schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (!autopilotCorrelationMatches(context.correlation, parsed.data.correlation)) {
    return humanResult(
      context,
      'semantic-correlation-mismatch',
      'Semantic agent result did not copy the exact supplied review correlation.',
    );
  }

  if (parsed.data.outcome === 'approve') {
    if (rawFollowUps !== undefined && fullFollowUps === undefined) {
      return humanResult(
        context,
        'semantic-output-invalid',
        'Approve followUps must be bounded triage-complete entries with type, title, body, effort, and priority.',
      );
    }
    // Preserve the full follow-up contract even when running against an older
    // SDK reader that accepted only title/body. The current strict SDK schema
    // validates these fields directly; this compatibility spread is additive.
    return {
      ...parsed.data,
      ...(fullFollowUps !== undefined ? { followUps: fullFollowUps } : {}),
    } as AutopilotReviewResult;
  }
  return parsed.data;
}

export async function runAutopilotSemanticReview(args: {
  context: AutopilotEvaluationContext;
  mechanicalRunner: AutopilotMechanicalRunner;
  agentRunner: SemanticAgentRunner;
  model?: string;
  abort: AbortSignal;
}): Promise<AutopilotSemanticReviewResult> {
  let mechanical: AutopilotMechanicalResult;
  try {
    mechanical = await args.mechanicalRunner.run(args.context);
  } catch (error) {
    const review = humanResult(
      args.context,
      'mechanical-runner-failed',
      error instanceof Error ? error.message : String(error),
    );
    return {
      review,
      gating: semanticReviewGating(review),
      mechanical: { kind: 'unscorable' },
    };
  }
  if (mechanical.kind === 'unscorable') {
    const review = humanResult(
      args.context,
      'mechanical-check-unscorable',
      mechanical.detail,
    );
    return {
      review,
      gating: semanticReviewGating(review),
      mechanical: { kind: mechanical.kind },
    };
  }

  try {
    if (mechanical.kind === 'failed') {
      const review: AutopilotReviewResult = {
        schemaVersion: 'jinn-autopilot-review-result.v1',
        outcome: 'request-changes',
        correlation: args.context.correlation,
        findings: [{
          title: `Deterministic ${mechanical.check} check failed`,
          body: mechanical.detail,
        }],
      };
      return {
        review,
        gating: semanticReviewGating(review),
        mechanical: {
          kind: mechanical.kind,
          changedFiles: mechanical.changedFiles,
        },
      };
    }

    let review: AutopilotReviewResult;
    try {
      const output = await args.agentRunner.run({
        prompt: buildAutopilotReviewPrompt(args.context, mechanical.changedFiles),
        cwd: mechanical.checkoutDir,
        model: args.model,
        abort: args.abort,
      });
      review = parseAgentReview(output, args.context);
    } catch (error) {
      review = humanResult(
        args.context,
        'semantic-runner-failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      review,
      gating: semanticReviewGating(review),
      mechanical: {
        kind: mechanical.kind,
        changedFiles: mechanical.changedFiles,
        checks: mechanical.checks,
      },
    };
  } finally {
    await mechanical.cleanup();
  }
}
