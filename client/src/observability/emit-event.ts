import type { Store } from '../store/store.js';

export type LifecycleKind =
  | 'intent_posted'
  | 'intent_registry_failed'
  | 'envelope_registry_failed'
  | 'request_claimed'
  | 'delivery_submitted'
  | 'evaluation_submitted'
  | 'reward_claimed'
  | 'balance_topup'
  | 'engine_transition'
  | 'tick_error'
  | 'startup'
  | 'shutdown';

export interface LifecycleEvent {
  kind: LifecycleKind;
  requestId?: string;
  serviceIndex?: number;
  txHash?: string;
  specKind?: string;
  outcome?: 'ok' | 'failed' | 'warn';
  detail?: string;
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
    specKind: event.specKind ?? null,
    outcome: event.outcome ?? null,
    detail: event.detail ?? null,
  });

  const payload = {
    ts,
    level: event.outcome === 'failed' ? 'error' : event.outcome === 'warn' ? 'warn' : 'info',
    component,
    msg: event.detail ?? event.kind,
    requestId: event.requestId ?? null,
    txHash: event.txHash ?? null,
    serviceIndex: event.serviceIndex ?? null,
    specKind: event.specKind ?? null,
    outcome: event.outcome ?? 'ok',
    kind: event.kind,
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
