import { describe, expect, it } from 'vitest';
import {
  EVENT_KIND_META,
  LIFECYCLE_KINDS,
  eventKindBadgeVariant,
  eventKindMeta,
} from './event-kinds.js';

const EXPECTED_DAEMON_KINDS = [
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
];

describe('event-kinds', () => {
  it('exposes exactly the daemon lifecycle kinds', () => {
    expect([...LIFECYCLE_KINDS].sort()).toEqual([...EXPECTED_DAEMON_KINDS].sort());
  });

  it('every lifecycle kind has non-empty human-readable copy', () => {
    for (const kind of LIFECYCLE_KINDS) {
      const meta = EVENT_KIND_META[kind];
      expect(meta, `meta missing for ${kind}`).toBeTruthy();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.label).not.toContain('_');
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('falls back gracefully for unknown future kinds', () => {
    const meta = eventKindMeta('some_unknown_future_kind');
    expect(meta.label).toBe('Some unknown future kind');
    expect(meta.label).not.toContain('_');
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it('maps explicit failure and warning outcomes to status badges', () => {
    expect(eventKindBadgeVariant('task_posted', 'failed')).toBe('destructive');
    expect(eventKindBadgeVariant('task_posted', 'warn')).toBe('warning');
  });
});
