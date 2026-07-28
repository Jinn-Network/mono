import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildSolutionOutput } from '@jinn-network/sdk/solvernets/prediction-v1';
import {
  AutopilotMutationDeliveryResultSchema,
  JinnRepoAutopilotSessionTaskSchema,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import type { Role } from '../../../types/envelope.js';
import { SOLVER_TYPE_PAYLOADS, validatePayload } from '../../../types/payloads/index.js';
import type { OutputArtifact } from '../../../types/portfolio.js';
import type { Task } from '../../../types/task.js';
import type { Solution } from '../../types.js';
import { stripTestPathHunks } from './restoration-patch.js';

// Async execFile — see #778. Replaces execFileSync at the two harvest /
// restoration-patch git invocations that previously blocked the daemon's
// main event loop when `git diff` hung. The 60s timeout below surfaces a
// hang as a clean throw so the harness can mark the task FAILED instead of
// wedging every other daemon loop (claims, deliveries, jinn-claim emissions,
// etc.). Co-located with #398 which fixed the sibling problem on the
// canAcceptTask hot path; this issue (#778) reaches the wedge path #398 did
// not.
const execFileAsync = promisify(execFile);
const GIT_DIFF_TIMEOUT_MS = 60_000;

const PHASE_ORDER = [
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
] as const;

type Phase = (typeof PHASE_ORDER)[number];

const PHASE_PRIMARY_ARTIFACT: Record<Phase, string> = {
  orient: 'summary.json',
  strategize: 'strategy.json',
  plan: 'plan.json',
  execute: 'summary.json',
  debrief: 'analysis.json',
  improve: 'summary.json',
  'memory-consolidation': 'consolidation_record.json',
};

type PhaseRange = 'full' | 'pre-execute' | 'post-execute' | 'solve-only';

export interface AutopilotHarvestIdentity {
  readonly taskId?: string;
  readonly attemptIndex?: number;
  readonly requestId?: string;
}

function hasAutopilotRuntimeAttemptIdentity(
  identity?: AutopilotHarvestIdentity,
): identity is Required<AutopilotHarvestIdentity> {
  return (
    typeof identity?.taskId === 'string'
    && identity.taskId.trim().length > 0
    && typeof identity.attemptIndex === 'number'
    && Number.isInteger(identity.attemptIndex)
    && identity.attemptIndex >= 0
    && typeof identity.requestId === 'string'
    && /^0x[0-9a-fA-F]{64}$/.test(identity.requestId)
  );
}

function assertAutopilotHarvestIdentity(
  task?: Task,
  identity?: AutopilotHarvestIdentity,
): boolean {
  if (task?.spec?.['source'] !== 'autopilot-session') return false;
  const parsedTask = JinnRepoAutopilotSessionTaskSchema.safeParse(task.spec);
  if (!parsedTask.success || !hasAutopilotRuntimeAttemptIdentity(identity)) {
    throw new Error(
      '[claude-code-learner] harvestOutput: Autopilot runtime attempt identity or source Task is invalid.',
    );
  }
  return true;
}

const REQUIRED_PHASES: Record<PhaseRange, Phase[]> = {
  full: [...PHASE_ORDER],
  'pre-execute': ['orient', 'strategize', 'plan'],
  'post-execute': ['debrief', 'improve', 'memory-consolidation'],
  // Frozen-mode solve: the learning phases (improve, memory-consolidation) are
  // intentionally skipped, so NO phase artifact is required. The swe-rebench
  // patch is still harvested via the typed-payload / repo-diff path.
  'solve-only': [],
};

const OPTIONAL_LEARNER_ARTIFACTS = [
  {
    path: '.execute/prediction-corpus-retrieval.json',
    artifactType: 'prediction_corpus_retrieval',
    schema: 'jinn.prediction_corpus_retrieval.v1',
    tags: ['learner-feedback', 'prediction', 'corpus-retrieval'],
  },
  {
    path: 'prediction-corpus-retrieval.json',
    artifactType: 'prediction_corpus_retrieval',
    schema: 'jinn.prediction_corpus_retrieval.v1',
    tags: ['learner-feedback', 'prediction', 'corpus-retrieval'],
  },
  {
    path: '.debrief/learner-feedback.json',
    artifactType: 'learner_feedback',
    schema: 'jinn.learner_feedback.v1',
    tags: ['learner-feedback', 'prediction'],
  },
  {
    path: 'learner-feedback.json',
    artifactType: 'learner_feedback',
    schema: 'jinn.learner_feedback.v1',
    tags: ['learner-feedback', 'prediction'],
  },
] as const;

const PREDICTION_V1_SOLUTION_PATHS = [
  '.execute/prediction-v1-solution.json',
  'prediction-v1-solution.json',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const INTERMEDIATE_FAILURE_DIFFS_FILE = 'intermediate-failure-diffs.json';

/** Best-effort read of hook-emitted §10 field 4. Omit when absent/empty/malformed. */
export function readIntermediateFailureDiffs(workingDir: string): string[] | undefined {
  const path = join(workingDir, '.execute', INTERMEDIATE_FAILURE_DIFFS_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return undefined;
    const diffs = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return diffs.length > 0 ? diffs : undefined;
  } catch {
    return undefined;
  }
}

function withIntermediateFailureDiffs<T extends Solution>(
  solution: T,
  workingDir: string,
): T {
  const diffs = readIntermediateFailureDiffs(workingDir);
  if (!diffs) return solution;
  return { ...solution, intermediateFailureDiffs: diffs };
}

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTypedPayloadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(
      `[claude-code-learner] harvestOutput: invalid JSON in typed payload ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `[claude-code-learner] harvestOutput: typed payload ${path} must contain a JSON object`,
    );
  }
  return parsed;
}

function decimalProbability(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0 && value <= 100) {
      return (value > 1 ? value / 100 : value).toFixed(4);
    }
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const percent = trimmed.endsWith('%');
  const numeric = Number(percent ? trimmed.slice(0, -1).trim() : trimmed);
  if (!Number.isFinite(numeric)) return undefined;
  const probability = percent || numeric > 1 ? numeric / 100 : numeric;
  if (probability < 0 || probability > 1) return undefined;
  return probability.toFixed(4);
}

function isoDateTime(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function confidence(value: unknown): 'low' | 'medium' | 'high' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function predictionSourceUrl(task?: Task): string | undefined {
  const source = task?.spec && typeof task.spec === 'object'
    ? (task.spec as Record<string, unknown>)['source']
    : undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const url = (source as Record<string, unknown>)['url'];
  return typeof url === 'string' && url.startsWith('http') ? url : undefined;
}

function normalizeSourceRefs(value: unknown): Array<{ title: string; url: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const title = typeof record['title'] === 'string' && record['title'].trim()
      ? record['title'].trim()
      : undefined;
    const url = typeof record['url'] === 'string' && record['url'].startsWith('http')
      ? record['url']
      : undefined;
    return title && url ? [{ title, url }] : [];
  });
  return refs.length > 0 ? refs : undefined;
}

function findPredictionV1Solution(workingDir: string): { path: string; payload: Record<string, unknown> } | null {
  for (const relPath of PREDICTION_V1_SOLUTION_PATHS) {
    const payload = safeReadJson(join(workingDir, relPath));
    if (payload) return { path: relPath, payload };
  }
  return null;
}

async function maybeMaterializeSweRebenchPatchPayload(
  workingDir: string,
  task?: Task,
): Promise<Record<string, unknown> | null> {
  if (task?.solverType !== 'swe-rebench-v2.v1' || task.role === 'evaluation') {
    return null;
  }
  const repoDir = join(workingDir, 'repo');
  if (!existsSync(join(repoDir, '.git'))) {
    return null;
  }

  let rawPatch = '';
  try {
    // Async + bounded timeout (#778). A hang here used to wedge the entire
    // daemon — every loop ran on the same blocked main thread. The 60s
    // timeout is well above any realistic `git diff` on a SWE-rebench-v2
    // checkout (single-package repos, normally <1s); if it ever trips, the
    // task fails fast and the daemon keeps ticking.
    const { stdout } = await execFileAsync('git', ['-C', repoDir, 'diff', '--binary'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: GIT_DIFF_TIMEOUT_MS,
    });
    rawPatch = stdout;
  } catch (err) {
    console.warn(
      `[claude-code-learner] harvestOutput: unable to derive swe-rebench-v2 patch from git diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!rawPatch.trim()) {
    return null;
  }
  // Drop the model's own test-file edits: the upstream eval applies the gold
  // `test_patch` after the model patch with `set -e`, so model test changes
  // either collide (3-way conflict → eval aborts) or pollute the test set. The
  // restorer never sees the gold test_patch, so we strip on the producer side
  // (matches standard SWE-bench, which resets test files before grading). See
  // jinn-mono-uy6v.8.
  const patch = stripTestPathHunks(rawPatch);
  if (!patch.trim()) {
    console.warn(
      '[claude-code-learner] harvestOutput: swe-rebench-v2 git diff contained only test-file changes; no source patch to submit.',
    );
    return null;
  }

  const payload = {
    schemaVersion: 'swe-rebench-v2-solution.v1',
    patch,
  };
  const executeDir = join(workingDir, '.execute');
  mkdirSync(executeDir, { recursive: true });
  writeFileSync(
    join(executeDir, 'solution-payload.json'),
    JSON.stringify(payload, null, 2),
  );
  return payload;
}

async function maybeMaterializeJinnRepoPatchPayload(
  workingDir: string,
  task?: Task,
  identity?: AutopilotHarvestIdentity,
): Promise<Record<string, unknown> | null> {
  if (task?.solverType !== 'jinn-repo.v1' || task.role === 'evaluation') {
    return null;
  }
  const repoDir = join(workingDir, 'repo');
  if (!existsSync(join(repoDir, '.git'))) {
    return null;
  }

  let rawPatch = '';
  try {
    // Async + bounded timeout, matching the swe-rebench materializer above.
    const { stdout } = await execFileAsync('git', ['-C', repoDir, 'diff', '--binary'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: GIT_DIFF_TIMEOUT_MS,
    });
    rawPatch = stdout;
  } catch (err) {
    console.warn(
      `[claude-code-learner] harvestOutput: unable to derive jinn-repo patch from git diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!rawPatch.trim()) {
    return null;
  }
  // Strip the solver's own test-file edits: the gold tests are held out from the
  // solverView, so a solver can only satisfy them by editing source. Stripping
  // test hunks on the producer side prevents a solver from passing the held-out
  // gold tests by editing them. Mirrors the swe-rebench materializer.
  const patch = stripTestPathHunks(rawPatch);
  if (!patch.trim()) {
    console.warn(
      '[claude-code-learner] harvestOutput: jinn-repo git diff contained only test-file changes; no source patch to submit.',
    );
    return null;
  }

  if (task.spec?.['source'] === 'autopilot-session') {
    const parsedTask = JinnRepoAutopilotSessionTaskSchema.safeParse(task.spec);
    if (!parsedTask.success || !hasAutopilotRuntimeAttemptIdentity(identity)) {
      throw new Error(
        '[claude-code-learner] harvestOutput: Autopilot runtime attempt identity or source Task is invalid.',
      );
    }

    const session = parsedTask.data.session;
    const payload = AutopilotMutationDeliveryResultSchema.parse({
      schemaVersion: 'jinn-autopilot-mutation-result.v1',
      outcome: 'mutation-complete',
      correlation: {
        taskId: identity.taskId,
        attemptIndex: identity.attemptIndex,
        requestId: identity.requestId,
        v2AttemptId: session.v2AttemptId,
        claimOid: session.claimOid,
        prNumber: session.prNumber,
        expectedHead: session.expectedHead,
      },
      patch,
      summary: `Completed ${session.workflow} workflow for PR #${session.prNumber}.`,
      evidence: {
        commands: [],
        tests: [],
        notes: ['Patch harvested from the completed repository worktree.'],
      },
    });
    const executeDir = join(workingDir, '.execute');
    mkdirSync(executeDir, { recursive: true });
    writeFileSync(
      join(executeDir, 'solution-payload.json'),
      JSON.stringify(payload, null, 2),
    );
    return payload;
  }

  const payload = {
    schemaVersion: 'jinn-repo-solution.v1',
    patch,
  };
  const executeDir = join(workingDir, '.execute');
  mkdirSync(executeDir, { recursive: true });
  writeFileSync(
    join(executeDir, 'solution-payload.json'),
    JSON.stringify(payload, null, 2),
  );
  return payload;
}

function payloadRole(task?: Task): Role {
  return task?.role === 'evaluation' ? 'verdict' : 'solution';
}

function normalizeTypedPayload(
  raw: Record<string, unknown>,
  task: Task | undefined,
  typedPayloadPath: string,
): Record<string, unknown> {
  const solverType = typeof task?.solverType === 'string' ? task.solverType : undefined;
  const role = payloadRole(task);
  let payload = raw;

  if (
    solverType === 'swe-rebench-v2.v1' &&
    role === 'solution' &&
    raw['schemaVersion'] === undefined &&
    typeof raw['patch'] === 'string' &&
    raw['patch'].trim()
  ) {
    // Strip the model's own test-file edits regardless of whether the patch
    // arrived hand-authored or was derived from `git diff` (idempotent on the
    // latter). See jinn-mono-uy6v.8 / restoration-patch.ts.
    const strippedPatch = stripTestPathHunks(raw['patch'] as string);
    payload = {
      ...raw,
      patch: strippedPatch,
      schemaVersion: 'swe-rebench-v2-solution.v1',
    };
    writeFileSync(typedPayloadPath, JSON.stringify(payload, null, 2));
  }

  if (solverType && SOLVER_TYPE_PAYLOADS[solverType]?.[role]) {
    try {
      validatePayload(solverType, role, payload);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[claude-code-learner] harvestOutput: typed payload ${typedPayloadPath} failed ${solverType}/${role} validation. Use submit_typed_payload or write the exact schema shape. ${detail}`,
      );
    }
  }

  return payload;
}

function normalizePredictionV1SolutionPayload(
  raw: Record<string, unknown>,
  task?: Task,
): Record<string, unknown> {
  const probabilityYes = decimalProbability(raw['probabilityYes']);
  if (!probabilityYes) {
    throw new Error(
      'prediction.v1 learner output is missing a valid decimal probabilityYes in .execute/prediction-v1-solution.json',
    );
  }

  const sourceRefs = normalizeSourceRefs(raw['sourceRefs']);
  const taskSourceUrl = predictionSourceUrl(task);
  const fallbackSourceRefs = taskSourceUrl
    ? [{ title: 'Polymarket market', url: taskSourceUrl }]
    : undefined;

  const normalizedConfidence = confidence(raw['confidence']);

  return {
    probabilityYes,
    submittedAt: isoDateTime(raw['submittedAt']),
    format: 'decimal',
    modelId: typeof raw['modelId'] === 'string' && raw['modelId'].trim()
      ? raw['modelId'].trim()
      : 'claude-code-learner/prediction-v1',
    ...(normalizedConfidence ? { confidence: normalizedConfidence } : {}),
    ...(typeof raw['methodology'] === 'string' && raw['methodology'].trim()
      ? { methodology: raw['methodology'].trim() }
      : {}),
    ...(sourceRefs ?? fallbackSourceRefs ? { sourceRefs: sourceRefs ?? fallbackSourceRefs } : {}),
  };
}

function predictionInformationalFromTask(task?: Task): Record<string, unknown> {
  if (!task?.spec || typeof task.spec !== 'object') return {};
  const spec = task.spec as Record<string, unknown>;
  const informational: Record<string, unknown> = {};
  if (spec['source'] !== undefined) informational.source = spec['source'];
  if (spec['consensusSnapshot'] !== undefined) informational.consensusSnapshot = spec['consensusSnapshot'];
  return informational;
}

/**
 * Like safeReadJson but throws on missing file or invalid JSON.
 * Used for required phase artifacts where a silent failure would allow an
 * empty-looking success to propagate through the engine.
 */
export function requiredReadJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Required artifact missing: ${path}`);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Cannot read required artifact ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `Required artifact contains invalid JSON: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readOptionalLearnerArtifact(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      console.warn(`[claude-code-learner] harvestOutput: learner artifact skipped; expected JSON object — ${path}`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(
      `[claude-code-learner] harvestOutput: learner artifact skipped; invalid JSON — ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function detectCompletedPhases(workingDir: string): string[] {
  const completed: string[] = [];
  for (const phase of PHASE_ORDER) {
    const dir = join(workingDir, `.${phase}`);
    if (!existsSync(dir)) continue;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      const entries = readdirSync(dir);
      if (entries.length > 0) completed.push(phase);
    } catch {
      // Best-effort; ignore permission / IO errors.
    }
  }
  return completed;
}

function resolvePhaseRange(override?: string): PhaseRange {
  const raw = override ?? process.env.LEARNER_PHASE_RANGE ?? 'full';
  if (raw === 'pre-execute' || raw === 'post-execute' || raw === 'solve-only') return raw;
  return 'full';
}

function lengthOf(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function summarizeLearnerArtifact(payload: Record<string, unknown>): Record<string, unknown> {
  const records = nestedRecord(payload, 'records');
  const retrieval = nestedRecord(payload, 'retrieval');
  const inspectedRefs = payload['inspectedRefs'] ?? records?.['inspected'] ?? retrieval?.['inspectedRefs'];
  const acquiredArtifacts = payload['acquiredArtifacts'] ?? retrieval?.['acquiredArtifacts'];
  const selfAssessment = nestedRecord(payload, 'selfAssessment');
  const verdictFeedback = payload['verdictFeedback'] ?? payload['postVerdict'] ?? payload['outcome'];
  const summary: Record<string, unknown> = {};

  const queries = lengthOf(payload['queries'] ?? payload['searchIntents'] ?? retrieval?.['queries']);
  if (queries !== undefined) summary.queries = queries;

  const considered = lengthOf(payload['recordsConsidered'] ?? records?.['considered'] ?? retrieval?.['recordsConsidered']);
  if (considered !== undefined) summary.recordsConsidered = considered;

  const cited = lengthOf(payload['recordsCited'] ?? records?.['cited'] ?? retrieval?.['recordsCited']);
  if (cited !== undefined) summary.recordsCited = cited;

  const used = lengthOf(payload['recordsUsed'] ?? records?.['used'] ?? retrieval?.['recordsUsed']);
  if (used !== undefined) summary.recordsUsed = used;

  const inspected = lengthOf(inspectedRefs);
  if (inspected !== undefined) summary.inspectedRefs = inspected;

  const acquired = lengthOf(acquiredArtifacts);
  if (acquired !== undefined) summary.acquiredArtifacts = acquired;

  if (typeof payload['retrievalUsed'] === 'boolean') summary.retrievalUsed = payload['retrievalUsed'];
  if (typeof selfAssessment?.['affectedForecast'] === 'boolean') {
    summary.affectedForecast = selfAssessment['affectedForecast'];
  }
  if (verdictFeedback !== undefined) summary.hasVerdictFeedback = true;

  return summary;
}

function collectLearnerArtifacts(workingDir: string): OutputArtifact[] {
  const artifacts: OutputArtifact[] = [];
  const seen = new Set<string>();

  for (const candidate of OPTIONAL_LEARNER_ARTIFACTS) {
    if (seen.has(candidate.path)) continue;
    const fullPath = join(workingDir, candidate.path);
    const payload = readOptionalLearnerArtifact(fullPath);
    if (!payload) continue;
    seen.add(candidate.path);

    artifacts.push({
      path: candidate.path,
      artifactType: candidate.artifactType,
      tags: [...candidate.tags],
      metadata: {
        schema: candidate.schema,
        source: 'agent-authored',
        ...summarizeLearnerArtifact(payload),
      },
      access: { priceUsdc: '0' },
    });
  }

  return artifacts;
}

/**
 * Construct Solution from the plugin's per-phase artifacts.
 *
 * Phase range (from phaseRange arg, LEARNER_PHASE_RANGE env, or 'full'):
 *   full         — all 7 phases required
 *   pre-execute  — orient, strategize, plan required (phases 1–3)
 *   post-execute — debrief, improve, memory-consolidation required (phases 5–7)
 *   solve-only   — no phase artifacts required (frozen mode skips the learning
 *                  phases; the patch still harvests via the typed-payload path)
 *
 * Required phase artifacts: hard-fail (throw) if missing or corrupt JSON.
 * Optional phase artifacts (outside the required range): safeReadJson + warn on null.
 */
export async function harvestOutput(
  workingDir: string,
  phaseRange?: string,
  task?: Task,
  identity?: AutopilotHarvestIdentity,
): Promise<Solution> {
  const range = resolvePhaseRange(phaseRange);
  const requiredPhases = new Set<Phase>(REQUIRED_PHASES[range]);
  const typedPayloadPath = join(workingDir, '.execute', 'solution-payload.json');
  // Declared Autopilot sessions must derive their result from the daemon's
  // worktree harvest. Validate their signed session and persisted runtime
  // identity before any early return or typed-file fallback can authorize an
  // agent-authored correlation.
  const isAutopilotSession = assertAutopilotHarvestIdentity(task, identity);
  // For swe-rebench-v2 restoration the `git diff` over the task checkout is the
  // authoritative patch (always well-formed; agent-authored diffs are not).
  // maybeMaterialize* returns null for any other case, so the agent-authored
  // .execute/solution-payload.json path is preserved everywhere else.
  const rawTypedPayload =
    (await maybeMaterializeSweRebenchPatchPayload(workingDir, task)) ??
    (await maybeMaterializeJinnRepoPatchPayload(workingDir, task, identity)) ??
    (isAutopilotSession ? null : readTypedPayloadJson(typedPayloadPath));
  const typedPayload = rawTypedPayload
    ? normalizeTypedPayload(rawTypedPayload, task, typedPayloadPath)
    : null;

  // Hard-fail on missing or corrupt primary artifacts for all required phases
  // unless a typed SolverNet payload is already present. In the typed-payload
  // path, phase artifacts are useful learner telemetry, but the payload is the
  // delivery contract the engine needs to package and settle.
  const phasesCompleted = detectCompletedPhases(workingDir);

  // No solution payload AND no phase artifacts at all: the run produced nothing.
  // Fail on the real cause (the missing deliverable) rather than naming a phase
  // telemetry file (e.g. .orient/summary.json), which is a misleading symptom.
  if (!typedPayload && phasesCompleted.length === 0 && requiredPhases.size > 0) {
    throw new Error(
      'harness produced no solution payload and no phase artifacts; the run appears empty (did the harness execute?)',
    );
  }

  const validated = new Map<Phase, Record<string, unknown>>();
  for (const phase of REQUIRED_PHASES[range]) {
    const path = join(workingDir, `.${phase}`, PHASE_PRIMARY_ARTIFACT[phase]);
    if (!typedPayload) {
      validated.set(phase, requiredReadJson(path));
      continue;
    }
    const artifact = safeReadJson(path);
    if (artifact) validated.set(phase, artifact);
  }

  const gating: Record<string, unknown> = { phasesCompleted };

  // Read a phase's primary artifact for optional gating-field extraction.
  // Required phases: use the already-validated result (no second read).
  // Optional phases: safeReadJson + warn on null.
  function readForGating(phase: Phase): Record<string, unknown> | null {
    if (requiredPhases.has(phase)) {
      return validated.get(phase) ?? null;
    }
    const path = join(workingDir, `.${phase}`, PHASE_PRIMARY_ARTIFACT[phase]);
    const data = safeReadJson(path);
    if (data === null) {
      console.warn(
        `[claude-code-learner] harvestOutput: optional artifact absent or corrupt — ${path}`,
      );
    }
    return data;
  }

  const strategy = readForGating('strategize');
  if (strategy && typeof strategy.timingPosture === 'string') {
    gating.timingPosture = strategy.timingPosture;
  }

  const exec = readForGating('execute');
  if (exec) {
    if (typeof exec.returnReason === 'string') gating.executeReturnReason = exec.returnReason;
    if (Array.isArray(exec.stepsCompleted)) gating.executeStepsCompleted = exec.stepsCompleted.length;
    if (Array.isArray(exec.stepsFailed)) gating.executeStepsFailed = exec.stepsFailed.length;
    if (typeof exec.elapsedMs === 'number') gating.executeElapsedMs = exec.elapsedMs;
  }

  const debrief = readForGating('debrief');
  if (debrief && typeof debrief.successCriteriaMet === 'string') {
    gating.debriefVerdict = debrief.successCriteriaMet;
  }

  const learnerArtifacts = collectLearnerArtifacts(workingDir);
  const artifacts = [...learnerArtifacts];
  const solverType = typeof task?.solverType === 'string' ? task.solverType : undefined;

  // Prediction.v1 path — reads .execute/prediction-v1-solution.json
  // directly (predates the submit_typed_payload MCP tool). To be migrated to
  // the generic path below in a follow-up; until then, prediction.v1 keeps
  // its rich gating/informational shape via buildSolutionOutput.
  //
  // Migration scope: once jinn-prediction-plugin gets a submission-shape
  // skill teaching the agent to write .execute/solution-payload.json (matching
  // PredictionV1SolutionPayloadSchema), this whole branch + the
  // prediction.v1 blocklist in learner/harness.ts:42 can be deleted, and the
  // specialist harnesses (PredictionV1BaselineImpl, ClaudeMcpPredictionImpl)
  // should be updated to write the generic file path too.
  //
  // Related: jinn-mono-kzlj (deferred — Prediction frozen per
  // DR-2026-05-11-a). Reopen kzlj when the freeze lifts.
  if (solverType === 'prediction.v1') {
    const predictionSolution = findPredictionV1Solution(workingDir);
    if (!predictionSolution) {
      throw new Error(
        `Required prediction.v1 learner solution missing: ${join(workingDir, '.execute', 'prediction-v1-solution.json')}`,
      );
    }
    const payload = normalizePredictionV1SolutionPayload(predictionSolution.payload, task);
    artifacts.push({
      path: predictionSolution.path,
      artifactType: 'prediction_v1_solution',
      tags: ['prediction', 'solution', 'learner-output'],
      metadata: {
        schema: 'jinn.prediction_v1_restoration_payload.v1',
        source: 'agent-authored',
      },
      access: { priceUsdc: '0' },
    });
    return withIntermediateFailureDiffs(
      buildSolutionOutput({
        solverType: 'prediction.v1',
        venueName: 'claude-code-learner',
        payload,
        gating: {
          ...gating,
          probabilityYes: payload.probabilityYes,
          submittedAt: payload.submittedAt,
          modelId: payload.modelId,
        },
        informational: {
          ...predictionInformationalFromTask(task),
          ...(learnerArtifacts.length > 0
            ? {
                learnerFeedbackArtifacts: learnerArtifacts.map((artifact) => ({
                  path: artifact.path,
                  artifactType: artifact.artifactType,
                  metadata: artifact.metadata,
                })),
              }
            : {}),
        },
        artifacts,
      }) as Solution,
      workingDir,
    );
  }

  // Generic typed-payload path. The agent calls the MCP tool
  // `submit_typed_payload` which validates against the active SolverNet's
  // schema and persists to .execute/solution-payload.json. Harvest reads it
  // back generically — no per-solverType branching here.
  const informationalEntries: Record<string, unknown> = {};
  if (learnerArtifacts.length > 0) {
    informationalEntries['learnerFeedbackArtifacts'] = learnerArtifacts.map((artifact) => ({
      path: artifact.path,
      artifactType: artifact.artifactType,
      metadata: artifact.metadata,
    }));
  }

  if (typedPayload) {
    const role = task?.role === 'evaluation' ? 'verdict' : 'solution';
    const artifactType = solverType
      ? `${solverType.replace(/\./g, '_')}_${role}`
      : `learner_${role}`;
    artifacts.push({
      path: '.execute/solution-payload.json',
      artifactType,
      tags: [role, 'learner-output'],
      metadata: {
        schemaVersion:
          typeof typedPayload['schemaVersion'] === 'string'
            ? typedPayload['schemaVersion']
            : undefined,
        source: 'agent-authored',
        solverType,
      },
      access: { priceUsdc: '0' },
    });
    return withIntermediateFailureDiffs(
      {
        venueRef: { name: 'claude-code-learner' },
        gating,
        ...(Object.keys(informationalEntries).length > 0
          ? { informational: informationalEntries }
          : {}),
        [role === 'verdict' ? 'verdictPayload' : 'solutionPayload']: typedPayload,
        artifacts,
      } as Solution,
      workingDir,
    );
  }

  // No typed payload submitted — fall through to the phase-artifact-only shape.
  // Tasks without a typed payload schema (or where the model didn't call
  // submit_typed_payload) still return the gating-only Solution.
  return withIntermediateFailureDiffs(
    {
      venueRef: { name: 'claude-code-learner' },
      gating,
      ...(Object.keys(informationalEntries).length > 0
        ? { informational: informationalEntries }
        : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    },
    workingDir,
  );
}
