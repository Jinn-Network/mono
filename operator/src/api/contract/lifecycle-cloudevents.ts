/**
 * Operator-lifecycle CloudEvents (spec/2026-08-04-headless-operator-rederivation-design.md §6.4).
 *
 * Types are minted from the sole `LIFECYCLE_KINDS` list (`lifecycle-kinds.const.ts`) via an
 * explicit snake→kebab table. Envelope field names follow TEP's observation profile
 * (`specversion`, `datacontenttype` required) without importing TEP's 11 task-execution types.
 *
 * Unknown kinds still produce a CloudEvent: `data.title` is always populated so a stale
 * console can render from envelope fields (the unknown-kind rule).
 */
import { z } from 'zod/v4';
import { LIFECYCLE_KINDS, type LifecycleKind } from './lifecycle-kinds.const.js';
import { eventSeveritySchema } from './lifecycle-kind.js';

/** Explicit snake→kebab map for every known kind. New kinds must add a row here. */
export const LIFECYCLE_KIND_TO_KEBAB: { readonly [K in LifecycleKind]: string } = {
  task_posted: 'task-posted',
  intent_registry_failed: 'intent-registry-failed',
  request_claimed: 'request-claimed',
  delivery_submitted: 'delivery-submitted',
  evaluation_submitted: 'evaluation-submitted',
  reward_claimed: 'reward-claimed',
  balance_topup: 'balance-topup',
  engine_transition: 'engine-transition',
  corpus_knowledge: 'corpus-knowledge',
  tick_error: 'tick-error',
  race_lost: 'race-lost',
  spend_cap_reached: 'spend-cap-reached',
  ai_units_cap_reached: 'ai-units-cap-reached',
  startup: 'startup',
  shutdown: 'shutdown',
  harvest_admitted: 'harvest-admitted',
};

const KNOWN_KIND_SET = new Set<string>(LIFECYCLE_KINDS);

export function lifecycleKindToKebab(kind: string): string {
  if (KNOWN_KIND_SET.has(kind)) {
    return LIFECYCLE_KIND_TO_KEBAB[kind as LifecycleKind];
  }
  return kind.replace(/_/g, '-');
}

export function lifecycleCloudEventType(
  kind: string,
): `network.jinn.operator-lifecycle.${string}.v1` {
  return `network.jinn.operator-lifecycle.${lifecycleKindToKebab(kind)}.v1`;
}

const cloudEventSeveritySchema = z.enum(['info', 'success', 'warning', 'error', 'neutral']);
export type CloudEventSeverity = z.infer<typeof cloudEventSeveritySchema>;

export const operatorLifecycleCloudEventDataSchema = z.looseObject({
  kind: z.string(),
  title: z.string().min(1),
  severity: cloudEventSeveritySchema,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const operatorLifecycleCloudEventSchema = z.looseObject({
  specversion: z.literal('1.0'),
  id: z.string(),
  source: z.string(),
  subject: z.string(),
  time: z.string(),
  datacontenttype: z.literal('application/json'),
  type: z.string(),
  data: operatorLifecycleCloudEventDataSchema,
});

export type OperatorLifecycleCloudEvent = z.infer<typeof operatorLifecycleCloudEventSchema>;

export interface LifecycleCloudEventSource {
  source: string;
  subject: string;
}

/** Minimal activity-row fields the envelope needs — wider than LifecycleKind so unknown kinds pass. */
export interface LifecycleCloudEventInput {
  id: number;
  ts: string | null;
  kind: string;
  requestId?: string | null;
  serviceIndex?: number | null;
  txHash?: string | null;
  solverType?: string | null;
  outcome?: string | null;
  detail?: string | null;
  title?: string;
  severity?: z.infer<typeof eventSeveritySchema> | CloudEventSeverity;
}

function titleFromKind(kind: string): string {
  return kind
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function severityFromOutcome(
  outcome: string | null | undefined,
  explicit?: CloudEventSeverity | z.infer<typeof eventSeveritySchema>,
): CloudEventSeverity {
  if (explicit) return explicit;
  if (outcome === 'failed') return 'error';
  if (outcome === 'warn' || outcome === 'paused') return 'warning';
  if (outcome === 'ok') return 'success';
  return 'info';
}

export function activityRowToCloudEvent(
  row: LifecycleCloudEventInput,
  uris: LifecycleCloudEventSource,
): OperatorLifecycleCloudEvent {
  const title = (row.title && row.title.length > 0) ? row.title : titleFromKind(row.kind);
  const message = row.detail && row.detail.length > 0 ? row.detail : title;
  const detail: Record<string, unknown> = {};
  if (row.requestId) detail['requestId'] = row.requestId;
  if (row.serviceIndex !== null && row.serviceIndex !== undefined) {
    detail['serviceIndex'] = row.serviceIndex;
  }
  if (row.txHash) detail['txHash'] = row.txHash;
  if (row.solverType) detail['solverType'] = row.solverType;
  if (row.outcome) detail['outcome'] = row.outcome;

  return {
    specversion: '1.0',
    id: String(row.id),
    source: uris.source,
    subject: uris.subject,
    time: row.ts ?? new Date(0).toISOString(),
    datacontenttype: 'application/json',
    type: lifecycleCloudEventType(row.kind),
    data: {
      kind: row.kind,
      title,
      severity: severityFromOutcome(row.outcome, row.severity),
      message,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    },
  };
}
