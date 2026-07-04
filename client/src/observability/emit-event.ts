import type { Store } from '../store/store.js';
import { getFileLogger } from './file-logger.js';

export const ALLOWED_LIFECYCLE_KINDS = [
  'task_posted',
  'intent_registry_failed',
  'request_claimed',
  'delivery_submitted',
  'evaluation_submitted',
  'reward_claimed',
  'balance_topup',
  'engine_transition',
  'corpus_knowledge',
  'tick_error',
  'race_lost',
  'spend_cap_reached',
  'ai_units_cap_reached',
  'startup',
  'shutdown',
  'harvest_admitted',
] as const;

export type LifecycleKind = (typeof ALLOWED_LIFECYCLE_KINDS)[number];

export interface LifecycleEvent {
  kind: LifecycleKind;
  requestId?: string;
  serviceIndex?: number;
  txHash?: string;
  solverType?: string;
  outcome?: 'ok' | 'failed' | 'warn' | 'paused';
  detail?: string;
  /**
   * Optional: when set, written to the row's `credential_id` column. The
   * AI-units cap-reached event uses this so cross-restart memo hydration
   * can query by credential (issue #815).
   */
  credentialId?: string;
}

export function emitEvent(
  store: Store,
  event: LifecycleEvent,
  component = 'lifecycle',
): void {
  const ts = new Date().toISOString();
  store.recordActivityEvent({
    ts,
    kind: event.kind,
    requestId: event.requestId ?? null,
    serviceIndex: event.serviceIndex ?? null,
    txHash: event.txHash ?? null,
    solverType: event.solverType ?? null,
    outcome: event.outcome ?? null,
    detail: event.detail ?? null,
    credentialId: event.credentialId ?? null,
  });

  const payload = {
    ts,
    level: event.outcome === 'failed' ? 'error'
      : (event.outcome === 'warn' || event.outcome === 'paused') ? 'warn'
      : 'info',
    component,
    msg: event.detail ?? event.kind,
    requestId: event.requestId ?? null,
    txHash: event.txHash ?? null,
    serviceIndex: event.serviceIndex ?? null,
    solverType: event.solverType ?? null,
    outcome: event.outcome ?? 'ok',
    kind: event.kind,
  };
  const line = JSON.stringify(payload);
  process.stderr.write(`${line}\n`);

  // Issue #420: tee every lifecycle event into the rotating daemon file
  // logger so the one-click debug report has durable, pre-redacted logs.
  // Best-effort — a logging failure must never affect event emission.
  try {
    getFileLogger().write(line);
  } catch {
    /* ignore */
  }
}
