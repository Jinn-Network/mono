/**
 * Human-readable copy for the persistent lifecycle event stream.
 *
 * The daemon defines the canonical kind list in observability/emit-event.ts.
 * The SPA duplicates it to avoid importing daemon source into the Vite build;
 * event-kinds.test.ts keeps the two lists aligned.
 */
export const LIFECYCLE_KINDS = [
  'task_posted',
  'intent_registry_failed',
  'request_claimed',
  'delivery_submitted',
  'evaluation_submitted',
  'reward_claimed',
  'balance_topup',
  'jinn_claim_emitted',
  'jinn_claim_ticket_recorded',
  'jinn_claim_submitted',
  'jinn_claim_canonical_skip',
  'engine_transition',
  'tick_error',
  'startup',
  'shutdown',
] as const;

export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];
export type EventTone = 'info' | 'success' | 'reward' | 'error' | 'warning' | 'neutral';

export interface EventKindMeta {
  label: string;
  description: string;
  tone: EventTone;
}

export const EVENT_KIND_META: Record<LifecycleKind, EventKindMeta> = {
  task_posted: {
    label: 'Task posted',
    description: 'A new task intent was published on-chain.',
    tone: 'info',
  },
  intent_registry_failed: {
    label: 'Intent registry failed',
    description: 'Posting a task intent to the registry did not succeed.',
    tone: 'error',
  },
  request_claimed: {
    label: 'Request claimed',
    description: 'The solver claimed a task request to work on.',
    tone: 'info',
  },
  delivery_submitted: {
    label: 'Delivery submitted',
    description: 'A completed solution was delivered on-chain.',
    tone: 'success',
  },
  evaluation_submitted: {
    label: 'Evaluation submitted',
    description: 'An evaluation verdict was submitted for a delivery.',
    tone: 'success',
  },
  reward_claimed: {
    label: 'Reward claimed',
    description: "Staking rewards were claimed to the operator's safe.",
    tone: 'reward',
  },
  balance_topup: {
    label: 'Balance top-up',
    description: 'Gas balance was topped up from the faucet.',
    tone: 'info',
  },
  jinn_claim_emitted: {
    label: 'JINN claim emitted',
    description: 'A JINN earnings claim was emitted locally.',
    tone: 'info',
  },
  jinn_claim_ticket_recorded: {
    label: 'JINN ticket recorded',
    description: 'A JINN claim ticket was recorded for later submission.',
    tone: 'info',
  },
  jinn_claim_submitted: {
    label: 'JINN claim submitted',
    description: 'A JINN earnings claim was submitted on-chain.',
    tone: 'success',
  },
  jinn_claim_canonical_skip: {
    label: 'JINN claim skipped',
    description: 'A JINN claim was skipped as already canonical.',
    tone: 'neutral',
  },
  engine_transition: {
    label: 'Engine transition',
    description: 'A task run moved to a new lifecycle state.',
    tone: 'info',
  },
  tick_error: {
    label: 'Tick error',
    description: 'An error occurred during a daemon polling tick.',
    tone: 'error',
  },
  startup: {
    label: 'Daemon started',
    description: 'The jinn daemon process started.',
    tone: 'neutral',
  },
  shutdown: {
    label: 'Daemon stopped',
    description: 'The jinn daemon process shut down.',
    tone: 'neutral',
  },
};

function titleCase(kind: string): string {
  const words = kind.replace(/_/g, ' ').trim();
  if (words.length === 0) return 'Event';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function eventKindMeta(kind: string): EventKindMeta {
  const known = (EVENT_KIND_META as Record<string, EventKindMeta>)[kind];
  if (known) return known;
  return {
    label: titleCase(kind),
    description: 'A daemon lifecycle event.',
    tone: 'neutral',
  };
}

export function eventKindBadgeVariant(
  kind: string,
  outcome: string | null | undefined,
): 'default' | 'secondary' | 'destructive' | 'warning' | 'success' | 'outline' {
  if (outcome === 'failed') return 'destructive';
  if (outcome === 'warn') return 'warning';
  const tone = eventKindMeta(kind).tone;
  if (tone === 'error') return 'destructive';
  if (tone === 'warning') return 'warning';
  if (tone === 'success' || tone === 'reward') return 'success';
  if (tone === 'neutral') return 'secondary';
  return 'default';
}
