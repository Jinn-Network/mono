import { describe, expect, it } from 'vitest';
import {
  EVENT_KIND_META,
  LIFECYCLE_KINDS,
  eventKindBadgeVariant,
  eventKindMeta,
} from './event-kinds.js';
import { LIFECYCLE_KINDS as DAEMON_LIFECYCLE_KINDS } from '../../../../api/contract/lifecycle-kind.js';

describe('event-kinds', () => {
  it('re-exports the one shared lifecycle-kind vocabulary (§8 artifact 6)', () => {
    // Both `LIFECYCLE_KINDS` here and `DAEMON_LIFECYCLE_KINDS` are re-exports of the same
    // array from `client/src/api/contract/lifecycle-kind.ts` — same reference, not just
    // equal contents, which is what actually rules out a second hand-copy drifting back in.
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
