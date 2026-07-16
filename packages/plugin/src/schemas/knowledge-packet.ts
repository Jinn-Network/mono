/**
 * `jinn.knowledge-packet.v1` — the unit of evidence supplied to the agent
 * (rescope design §3.2). A versioned, pure, deterministic projection of a
 * `CorpusRecord`: presentation-only, re-derivable at any time, never stored
 * as new truth.
 */
import { z } from 'zod';
import { TIER_ORDER } from './pickup-config.js';
import type { CorpusRecord, CorpusRecordStep } from '../ports/corpus-port.js';

export const KNOWLEDGE_PACKET_SCHEMA_VERSION = 'jinn.knowledge-packet.v1' as const;

export const KnowledgePacketExcerptSchema = z.strictObject({
  label: z.enum(['failure', 'fix', 'command', 'diff', 'note']),
  text: z.string().min(1),
});

export const KnowledgePacketSchema = z.strictObject({
  schemaVersion: z.literal(KNOWLEDGE_PACKET_SCHEMA_VERSION),
  ref: z.string().min(1),
  task: z.strictObject({
    summary: z.string().min(1),
    repositorySlug: z.string().min(1).optional(),
  }),
  outcome: z.strictObject({
    status: z.enum(['completed', 'failed', 'abandoned']),
    verifiabilityTier: z.enum(TIER_ORDER),
  }),
  /** The record's own synthesis, when the record carries one. Never generated here. */
  synthesis: z.string().min(1).optional(),
  excerpts: z.array(KnowledgePacketExcerptSchema),
  attribution: z.strictObject({
    provenance: z.enum(['imported', 'contributed']),
    capturedAt: z.iso.datetime(),
    origin: z.string().min(1),
  }),
});

export type KnowledgePacket = z.infer<typeof KnowledgePacketSchema>;
export type KnowledgePacketExcerpt = z.infer<typeof KnowledgePacketExcerptSchema>;

export const DEFAULT_PACKET_CHAR_BUDGET = 3_500;

export interface KnowledgePacketBudget {
  /** Max combined chars across synthesis + excerpt text. Default 3,500 (rescope §3.5). */
  maxChars?: number;
}

interface ExcerptCandidate {
  label: KnowledgePacketExcerpt['label'];
  text: string;
}

/**
 * Read a well-known string-shaped step attribute. Steps follow the existing
 * capture convention seen throughout this codebase's episode/trace fixtures:
 * `tool.args` (command invoked) / `tool.result` (output) / `tool.exitCode`
 * (numeric exit status) / `diff` (a unified-diff excerpt) / `note` or
 * `turn.text` (free-form remark, mirroring the episode `jinn.agent_turn`
 * attribute convention).
 */
function attrString(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stepCommand(step: CorpusRecordStep): string | undefined {
  return attrString(step.attributes, 'tool.args') ?? attrString(step.attributes, 'command');
}

function stepOutput(step: CorpusRecordStep): string | undefined {
  return attrString(step.attributes, 'tool.result') ?? attrString(step.attributes, 'result');
}

function stepExitCode(step: CorpusRecordStep): number | undefined {
  const value = step.attributes['tool.exitCode'] ?? step.attributes['exitCode'];
  return typeof value === 'number' ? value : undefined;
}

function stepDiff(step: CorpusRecordStep): string | undefined {
  return attrString(step.attributes, 'diff');
}

function stepNote(step: CorpusRecordStep): string | undefined {
  return attrString(step.attributes, 'note') ?? attrString(step.attributes, 'turn.text');
}

/**
 * Deterministic excerpt selection over a record's steps, in step order:
 * the first failing command with its output, the next command after it that
 * is not itself a failure (the correction), the last passing command overall
 * (the final backstop), and a diff step when present. Falls back to a single
 * free-form note when nothing command-shaped is found. Selects only — never
 * paraphrases.
 */
function selectExcerpts(steps: CorpusRecordStep[]): ExcerptCandidate[] {
  const excerpts: ExcerptCandidate[] = [];

  let failureIndex = -1;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const command = stepCommand(step);
    const exitCode = stepExitCode(step);
    if (command !== undefined && exitCode !== undefined && exitCode !== 0) {
      const output = stepOutput(step);
      excerpts.push({ label: 'failure', text: output ? `${command}\n${output}` : command });
      failureIndex = i;
      break;
    }
  }

  if (failureIndex >= 0) {
    for (let i = failureIndex + 1; i < steps.length; i++) {
      const step = steps[i]!;
      const command = stepCommand(step);
      const exitCode = stepExitCode(step);
      if (command !== undefined && exitCode !== undefined && exitCode === 0) {
        excerpts.push({ label: 'fix', text: command });
        break;
      }
    }
  }

  let lastPassing: string | undefined;
  for (const step of steps) {
    const command = stepCommand(step);
    const exitCode = stepExitCode(step);
    if (command !== undefined && exitCode === 0) lastPassing = command;
  }
  if (lastPassing !== undefined) excerpts.push({ label: 'command', text: lastPassing });

  const diffStep = steps.find((step) => stepDiff(step) !== undefined);
  if (diffStep !== undefined) excerpts.push({ label: 'diff', text: stepDiff(diffStep)! });

  if (excerpts.length === 0) {
    const noteStep = steps.find((step) => stepNote(step) !== undefined);
    if (noteStep !== undefined) excerpts.push({ label: 'note', text: stepNote(noteStep)! });
  }

  return excerpts;
}

/** Line-boundary-aware truncation ending with an explicit, pointer-bearing tail. */
export function truncateLineBoundary(text: string, maxChars: number, ref: string): string {
  if (text.length <= maxChars) return text;
  const tail = `\n[truncated — full episode: corpus_fetch ${ref}]`;
  const budget = Math.max(0, maxChars - tail.length);
  let cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  return `${cut}${tail}`;
}

/**
 * Pure deterministic projection of a `CorpusRecord` into a `KnowledgePacket`
 * (rescope §3.2). Selects and truncates; never paraphrases. Enforces the
 * combined synthesis+excerpts char budget (default 3,500 — two packets at the
 * default budget total 7,000, satisfying §3.5's combined ceiling).
 */
export function projectKnowledgePacket(
  record: CorpusRecord,
  budget: KnowledgePacketBudget = {},
): KnowledgePacket {
  const maxChars = budget.maxChars ?? DEFAULT_PACKET_CHAR_BUDGET;

  let synthesis = record.synthesis;
  if (synthesis !== undefined && synthesis.length > maxChars) {
    synthesis = truncateLineBoundary(synthesis, maxChars, record.ref);
  }

  const candidates = selectExcerpts(record.steps);
  const excerpts: KnowledgePacketExcerpt[] = [];
  let used = synthesis?.length ?? 0;
  for (const candidate of candidates) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (candidate.text.length <= remaining) {
      excerpts.push(candidate);
      used += candidate.text.length;
    } else {
      excerpts.push({
        label: candidate.label,
        text: truncateLineBoundary(candidate.text, remaining, record.ref),
      });
      break;
    }
  }

  return KnowledgePacketSchema.parse({
    schemaVersion: KNOWLEDGE_PACKET_SCHEMA_VERSION,
    ref: record.ref,
    task: {
      summary: record.task.summary,
      ...(record.task.repositorySlug ? { repositorySlug: record.task.repositorySlug } : {}),
    },
    outcome: {
      status: record.outcome.status,
      verifiabilityTier: record.outcome.verifiabilityTier,
    },
    ...(synthesis ? { synthesis } : {}),
    excerpts,
    attribution: {
      provenance: record.provenance,
      capturedAt: record.capturedAt,
      origin: record.origin,
    },
  });
}
