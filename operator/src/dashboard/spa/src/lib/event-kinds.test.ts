import { describe, expect, it } from 'vitest';
import {
  EVENT_KIND_META,
  LIFECYCLE_KINDS,
  eventKindBadgeVariant,
  eventKindMeta,
} from './event-kinds.js';
import { ALLOWED_LIFECYCLE_KINDS as DAEMON_LIFECYCLE_KINDS } from '../../../../observability/emit-event.js';

describe('event-kinds', () => {
  it('re-exports the one shared lifecycle-kind vocabulary (§8 artifact 6)', () => {
    // Compared against `observability/emit-event.ts`'s real daemon-side export — the actual
    // producer of the vocabulary — not the contract module's own copy of itself. Asserting
    // against the contract module would pass even if a *third*, re-forked copy of the array
    // existed somewhere and this file happened to import that one instead; asserting
    // referential identity against the daemon's own export is what actually catches a
    // re-forked daemon copy. `toBe` (not `toEqual`) checks the same array reference, not
    // just equal contents.
    expect(LIFECYCLE_KINDS).toBe(DAEMON_LIFECYCLE_KINDS);
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

  it('falls back gracefully for unknown future kinds with no wire override', () => {
    const meta = eventKindMeta('some_unknown_future_kind');
    expect(meta.label).toBe('Some unknown future kind');
    expect(meta.label).not.toContain('_');
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it('unknown-kind rule: renders server-supplied severity+title, never drops the event', () => {
    const meta = eventKindMeta('a_kind_this_build_has_never_heard_of', {
      severity: 'warning',
      title: 'A brand new thing happened',
    });
    expect(meta.label).toBe('A brand new thing happened');
    expect(meta.tone).toBe('warning');
    expect(
      eventKindBadgeVariant('a_kind_this_build_has_never_heard_of', undefined, {
        severity: 'warning',
        title: 'A brand new thing happened',
      }),
    ).toBe('warning');
  });

  it('maps explicit failure and warning outcomes to status badges', () => {
    expect(eventKindBadgeVariant('task_posted', 'failed')).toBe('destructive');
    expect(eventKindBadgeVariant('task_posted', 'warn')).toBe('warning');
  });
});
