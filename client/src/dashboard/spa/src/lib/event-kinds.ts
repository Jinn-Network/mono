/**
 * Human-readable copy for the persistent lifecycle event stream.
 *
 * `LIFECYCLE_KINDS` is the one exported vocabulary, sourced from the zod-free
 * `client/src/api/contract/lifecycle-kinds.const.ts`
 * (spec/2026-08-04-headless-operator-rederivation-design.md §8 artifact 6) rather than its
 * `lifecycle-kind.ts` sibling — value-importing anything from `lifecycle-kind.ts` pulls
 * zod/v4 into this bundle, since ES module evaluation runs that module's whole top level
 * (its `z.enum(...)`/`z.looseObject(...)` schema construction) the moment any one export is
 * used. `EventSeverity` is `import type`-only, which `tsc`/`vite` erase regardless of
 * source module, so it's fine to still take from `lifecycle-kind.ts`.
 *
 * This file used to hand-copy its own 12-entry list (4 short of the daemon's 16) under a
 * comment claiming `event-kinds.test.ts` kept the two lists aligned; that test in fact
 * compared the local list against its own second hand-copy, never against the daemon's
 * real `ALLOWED_LIFECYCLE_KINDS` in `observability/emit-event.ts`, so the fork was free to
 * drift silently. Importing the shared vocabulary here removes the second copy.
 */
import { LIFECYCLE_KINDS, type LifecycleKind } from '../../../../api/contract/lifecycle-kinds.const.js';
import type { EventSeverity } from '../../../../api/contract/lifecycle-kind.js';

export { LIFECYCLE_KINDS };
export type { LifecycleKind, EventSeverity };
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
    description: 'OLAS rewards were collected to your wallet.',
    tone: 'reward',
  },
  balance_topup: {
    label: 'Balance top-up',
    description: 'Gas balance was topped up from the faucet.',
    tone: 'info',
  },
  engine_transition: {
    label: 'Engine transition',
    description: 'A task run moved to a new lifecycle state.',
    tone: 'info',
  },
  corpus_knowledge: {
    label: 'Corpus knowledge',
    description: 'A solution or verdict was recorded to the knowledge corpus.',
    tone: 'info',
  },
  spend_cap_reached: {
    label: 'Spend cap reached',
    description: 'A credential hit its configured daily USD spend cap.',
    tone: 'neutral',
  },
  ai_units_cap_reached: {
    label: 'AI-units cap reached',
    description: 'A credential hit its configured AI-units cap.',
    tone: 'neutral',
  },
  harvest_admitted: {
    label: 'Harvest admitted',
    description: 'A harvested result was admitted into the corpus.',
    tone: 'info',
  },
  tick_error: {
    label: 'Tick error',
    description: 'An error occurred during a daemon polling tick.',
    tone: 'error',
  },
  race_lost: {
    label: 'Race lost',
    description: 'A claim or evaluation lost the on-chain race (task already filled or evaluation deadline passed); no action needed.',
    tone: 'neutral',
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

/**
 * Wire fields carrying the unknown-kind rendering rule (§8 artifact 6): a `kind` this
 * build doesn't recognize still renders legibly via server-supplied `severity`/`title`
 * rather than being dropped or crashing the row.
 */
export interface EventWireOverride {
  severity?: EventSeverity;
  title?: string;
}

export function eventKindMeta(kind: string, wire?: EventWireOverride): EventKindMeta {
  const known = (EVENT_KIND_META as Record<string, EventKindMeta>)[kind];
  if (known) return known;
  // Unknown kind: prefer the server's own framing over the generic fallback when the
  // payload carries it — this is what makes adding a new kind genuinely additive against
  // a fleet running stale SPA builds (§8).
  if (wire?.title) {
    return {
      label: wire.title,
      description: 'A daemon lifecycle event.',
      tone: wire.severity ?? 'neutral',
    };
  }
  return {
    label: titleCase(kind),
    description: 'A daemon lifecycle event.',
    tone: 'neutral',
  };
}

export function eventKindBadgeVariant(
  kind: string,
  outcome: string | null | undefined,
  wire?: EventWireOverride,
): 'default' | 'secondary' | 'destructive' | 'warning' | 'success' | 'outline' {
  if (outcome === 'failed') return 'destructive';
  if (outcome === 'warn') return 'warning';
  const tone = eventKindMeta(kind, wire).tone;
  if (tone === 'error') return 'destructive';
  if (tone === 'warning') return 'warning';
  if (tone === 'success' || tone === 'reward') return 'success';
  if (tone === 'neutral') return 'secondary';
  return 'default';
}
