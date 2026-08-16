import {
  SESSION_DERIVED_DISTILL_PROMPT_V1,
  SESSION_DERIVED_DISTILL_PROMPT_V1_SHA256,
} from '@jinn-network/sdk';
import type { SignedEnvelope } from '../types/envelope.js';
import type { Task } from '../types/task.js';

export interface SessionDerivedDraft {
  problemStatement: string;
  expectedArtifacts?: Record<string, unknown>;
  signalHints?: string[];
}

export interface SessionDerivedDistillInput {
  envelope: SignedEnvelope;
  sourceCaptureCid: string;
  trajectoryText: string;
  model: string;
  solverNetManifestCid?: string;
  now?: Date;
  distill: (input: {
    prompt: string;
    envelope: SignedEnvelope;
    trajectoryText: string;
  }) => Promise<SessionDerivedDraft[]>;
}

export interface SessionDerivedDistillResult {
  accepted: Task[];
  rejected: Array<{ reason: string; draft: SessionDerivedDraft }>;
}

export async function distillCaptureToTasks(input: SessionDerivedDistillInput): Promise<SessionDerivedDistillResult> {
  const drafts = await input.distill({
    prompt: SESSION_DERIVED_DISTILL_PROMPT_V1,
    envelope: input.envelope,
    trajectoryText: input.trajectoryText,
  });
  const accepted: Task[] = [];
  const rejected: Array<{ reason: string; draft: SessionDerivedDraft }> = [];
  const now = input.now ?? new Date();
  const startTs = Math.floor(now.getTime() / 1000);

  for (const [index, draft] of drafts.entries()) {
    const problem = draft.problemStatement.trim();
    if (problem.length < 20) {
      rejected.push({ reason: 'problem_statement_too_short', draft });
      continue;
    }
    const id = `session-derived-${input.sourceCaptureCid.slice(0, 16)}-${index + 1}`;
    accepted.push({
      id,
      description: problem,
      solverType: 'session-derived.v1',
      contractId: 'session-derived',
      contractVersion: 'v1',
      solverNetManifestCid: input.solverNetManifestCid,
      window: { startTs, endTs: startTs + 4 * 60 * 60 },
      claimPolicy: {
        mode: 'parallel',
        maxClaims: 50,
        maxClaimsPerOperator: 5,
        claimLeaseTtlSeconds: 4 * 60 * 60,
      },
      spec: {
        schemaVersion: 'session-derived-task.v1',
        sourceCaptureCid: input.sourceCaptureCid,
        sourceCaptureSha256: input.envelope.signature.hash.replace(/^0x/, '').padStart(64, '0').slice(0, 64),
        repo: input.envelope.sessionProvenance?.repo,
        problemStatement: problem,
        expectedArtifacts: draft.expectedArtifacts ?? {},
        signalHints: draft.signalHints ?? [],
        distillation: {
          promptSha256: SESSION_DERIVED_DISTILL_PROMPT_V1_SHA256,
          model: input.model,
          distilledAt: now.toISOString(),
        },
      },
      eligibility: { sourceCaptureCid: input.sourceCaptureCid },
    });
  }

  return { accepted, rejected };
}
