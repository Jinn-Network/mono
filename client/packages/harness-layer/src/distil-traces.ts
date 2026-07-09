import type { CapturedTask } from './capture.js';

export type TraceReadMode = 'summary' | 'events' | 'tool_calls' | 'transcript_excerpt' | 'full_transcript';
export type EstimatedDistillCost = 'low' | 'medium' | 'high';
export type EvidenceTierEstimate = 'single-example' | 'recurring-pattern' | 'contrastive';

export interface LocalTraceCard {
  traceId: string;
  sessionId: string;
  sourceTool: string;
  repo?: string;
  startedAt: string;
  durationMs: number;
  summary: string;
  tools: string[];
  commands: string[];
  filesTouched: string[];
  errorSnippets: string[];
  outcome: CapturedTask['outcome']['status'];
  skillsUsed: string[];
  redactionFlags: string[];
}

export interface TraceEventView {
  spanId: string;
  kind: string;
  name: string;
  text?: string;
  toolName?: string;
  attributes?: Record<string, unknown>;
}

export interface TraceReadResult {
  mode: TraceReadMode;
  traceId: string;
  summary: string;
  events?: TraceEventView[];
  toolCalls?: TraceEventView[];
}

export interface TraceSearchQuery {
  query?: string;
  command?: string;
  file?: string;
  error?: string;
  tool?: string;
  outcome?: CapturedTask['outcome']['status'];
  limit?: number;
}

export interface TraceCandidate {
  candidateId: string;
  title: string;
  traceIds: string[];
  repeatedSignals: {
    commands?: string[];
    errors?: string[];
    files?: string[];
  };
  evidenceTierEstimate: EvidenceTierEstimate;
  estimatedSourceTokens: number;
  estimatedDistillCost: EstimatedDistillCost;
  privacyFlags: string[];
}

type TraceCandidateDraft = Omit<TraceCandidate, 'candidateId'> & { priority: number };

function uniq(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
}

function oneLine(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function commandFromStep(step: CapturedTask['steps'][number]): string | undefined {
  const args = parseJsonObject(step.attributes['tool.args']);
  return oneLine(args?.['command'] ?? args?.['cmd'] ?? step.attributes['command']);
}

function fileFromStep(step: CapturedTask['steps'][number]): string | undefined {
  const args = parseJsonObject(step.attributes['tool.args']);
  return oneLine(step.attributes['file.path'] ?? args?.['path'] ?? args?.['file']);
}

function eventKind(step: CapturedTask['steps'][number]): string {
  return typeof step.attributes['jinn.capture.event.kind'] === 'string'
    ? step.attributes['jinn.capture.event.kind']
    : step.name;
}

function eventText(step: CapturedTask['steps'][number]): string | undefined {
  return oneLine(
    step.attributes['message.content'] ??
      step.attributes['tool.result'] ??
      step.attributes['file.diff'] ??
      commandFromStep(step) ??
      fileFromStep(step),
  );
}

function toolName(step: CapturedTask['steps'][number]): string | undefined {
  return oneLine(step.attributes['tool.name']);
}

function traceId(task: CapturedTask): string {
  return `local-capture:${task.session.sessionId}`;
}

export function traceCardFromCapture(task: CapturedTask): LocalTraceCard {
  const commands = uniq(task.steps.map(commandFromStep));
  const filesTouched = uniq(task.steps.map(fileFromStep));
  const errorSnippets = uniq(task.steps.map((step) => {
    const isError = step.attributes['tool.is_error'] === true || step.attributes['tool.is_error'] === 'true';
    return isError ? oneLine(step.attributes['tool.result']) : undefined;
  }));
  const toolNames = uniq([
    ...task.environment.tools,
    ...task.steps.map(toolName),
  ]);
  const redactionFlags = task.steps.some((step) => step.redactedKeys.length > 0) ? ['redacted'] : [];
  return {
    traceId: traceId(task),
    sessionId: task.session.sessionId,
    sourceTool: task.environment.harness.name,
    startedAt: task.session.capturedAt,
    durationMs: task.cost.durationMs,
    summary: task.task.summary,
    tools: toolNames,
    commands,
    filesTouched,
    errorSnippets,
    outcome: task.outcome.status,
    skillsUsed: [],
    redactionFlags,
  };
}

function eventView(step: CapturedTask['steps'][number], includeAttributes = false): TraceEventView {
  const out: TraceEventView = {
    spanId: step.spanId,
    kind: eventKind(step),
    name: step.name,
  };
  const text = eventText(step);
  const tool = toolName(step);
  if (text) out.text = text;
  if (tool) out.toolName = tool;
  if (includeAttributes) out.attributes = step.attributes;
  return out;
}

export function readTrace(
  task: CapturedTask,
  opts: { mode: TraceReadMode; query?: string; limit?: number; allowFullTranscript?: boolean },
): TraceReadResult {
  const base = { mode: opts.mode, traceId: traceId(task), summary: task.task.summary };
  if (opts.mode === 'summary') return base;
  if (opts.mode === 'full_transcript' && !opts.allowFullTranscript) {
    throw new Error('full transcript reads require explicit allowFullTranscript=true');
  }
  const events = task.steps.map((step) => eventView(step, opts.mode === 'full_transcript'));
  if (opts.mode === 'events' || opts.mode === 'full_transcript') return { ...base, events };
  if (opts.mode === 'tool_calls') {
    return {
      ...base,
      toolCalls: events.filter((event) => event.kind === 'tool-call' || event.toolName !== undefined),
    };
  }
  const q = opts.query?.toLowerCase();
  const filtered = q
    ? events.filter((event) => JSON.stringify(event).toLowerCase().includes(q))
    : events;
  return { ...base, events: filtered.slice(0, opts.limit ?? 20) };
}

function cardText(card: LocalTraceCard): string {
  return [
    card.summary,
    ...card.tools,
    ...card.commands,
    ...card.filesTouched,
    ...card.errorSnippets,
    card.outcome,
  ].join('\n').toLowerCase();
}

export function searchTraceCards(cards: LocalTraceCard[], query: TraceSearchQuery): LocalTraceCard[] {
  const matches = cards.filter((card) => {
    if (query.query && !cardText(card).includes(query.query.toLowerCase())) return false;
    if (query.command && !card.commands.some((c) => c.toLowerCase().includes(query.command!.toLowerCase()))) return false;
    if (query.file && !card.filesTouched.some((f) => f.toLowerCase().includes(query.file!.toLowerCase()))) return false;
    if (query.error && !card.errorSnippets.some((e) => e.toLowerCase().includes(query.error!.toLowerCase()))) return false;
    if (query.tool && !card.tools.some((t) => t.toLowerCase().includes(query.tool!.toLowerCase()))) return false;
    if (query.outcome && card.outcome !== query.outcome) return false;
    return true;
  });
  return matches
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, query.limit ?? matches.length);
}

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

function costFor(tokens: number): EstimatedDistillCost {
  if (tokens < 20_000) return 'low';
  if (tokens < 80_000) return 'medium';
  return 'high';
}

function grouped(cards: LocalTraceCard[], key: 'errorSnippets' | 'commands' | 'filesTouched'): Map<string, LocalTraceCard[]> {
  const out = new Map<string, LocalTraceCard[]>();
  for (const card of cards) {
    for (const value of card[key]) {
      const normalized = value.toLowerCase();
      const group = out.get(normalized) ?? [];
      group.push(card);
      out.set(normalized, group);
    }
  }
  return out;
}

export function clusterTraceCards(cards: LocalTraceCard[]): TraceCandidate[] {
  const candidates: TraceCandidateDraft[] = [];
  const addGroups = (
    label: string,
    key: 'errors' | 'commands' | 'files',
    groups: Map<string, LocalTraceCard[]>,
    priority: number,
  ) => {
    for (const [signal, group] of groups) {
      if (group.length < 2) continue;
      const tokenEstimate = estimateTokens(JSON.stringify(group));
      candidates.push({
        title: `${label}: ${group[0]?.[key === 'errors' ? 'errorSnippets' : key === 'commands' ? 'commands' : 'filesTouched']
          .find((v) => v.toLowerCase() === signal) ?? signal}`,
        traceIds: group.map((card) => card.traceId),
        repeatedSignals: { [key]: [signal] },
        evidenceTierEstimate: 'recurring-pattern',
        estimatedSourceTokens: tokenEstimate,
        estimatedDistillCost: costFor(tokenEstimate),
        privacyFlags: uniq(group.flatMap((card) => card.redactionFlags)),
        priority,
      });
    }
  };
  addGroups('Repeated error', 'errors', grouped(cards, 'errorSnippets'), 0);
  addGroups('Repeated command', 'commands', grouped(cards, 'commands'), 1);
  addGroups('Repeated file', 'files', grouped(cards, 'filesTouched'), 2);

  if (candidates.length === 0 && cards.length === 1) {
    const tokenEstimate = estimateTokens(JSON.stringify(cards[0]));
    candidates.push({
      title: cards[0]!.summary,
      traceIds: [cards[0]!.traceId],
      repeatedSignals: {},
      evidenceTierEstimate: 'single-example',
      estimatedSourceTokens: tokenEstimate,
      estimatedDistillCost: costFor(tokenEstimate),
      privacyFlags: cards[0]!.redactionFlags,
      priority: 3,
    });
  }

  return candidates
    .sort((a, b) => b.traceIds.length - a.traceIds.length || a.priority - b.priority || a.title.localeCompare(b.title))
    .map(({ priority, ...candidate }, index) => ({
      candidateId: `local-candidate-${String(index + 1).padStart(3, '0')}`,
      ...candidate,
    }));
}
