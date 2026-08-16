import { describe, it, expect } from 'vitest';
import { TranscriptEventSchema, TranscriptEvent } from '../../../src/trajectory/transcript-parsers/types.js';

describe('TranscriptEvent', () => {
  it('parses user-message kind', () => {
    const event: unknown = { kind: 'user-message', timestamp: '2026-05-07T00:00:00.000Z', content: 'hi' };
    const result = TranscriptEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('parses assistant-message kind', () => {
    const event: unknown = { kind: 'assistant-message', timestamp: '2026-05-07T00:00:01.000Z', content: 'hello' };
    expect(TranscriptEventSchema.safeParse(event).success).toBe(true);
  });

  it('parses tool-call kind', () => {
    const event: unknown = {
      kind: 'tool-call',
      timestamp: '2026-05-07T00:00:02.000Z',
      name: 'Read',
      args: { path: 'x' },
    };
    expect(TranscriptEventSchema.safeParse(event).success).toBe(true);
  });

  it('parses tool-result kind (with optional isError)', () => {
    const ok: unknown = { kind: 'tool-result', timestamp: '2026-05-07T00:00:03.000Z', name: 'Read', content: '...' };
    const err: unknown = { kind: 'tool-result', timestamp: '2026-05-07T00:00:03.000Z', name: 'Read', content: 'oops', isError: true };
    expect(TranscriptEventSchema.safeParse(ok).success).toBe(true);
    expect(TranscriptEventSchema.safeParse(err).success).toBe(true);
  });

  it('parses edit kind', () => {
    const event: unknown = {
      kind: 'edit',
      timestamp: '2026-05-07T00:00:04.000Z',
      path: 'x.ts',
      diff: '@@ -1,1 +1,2 @@',
    };
    expect(TranscriptEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects invalid kind discriminator', () => {
    const event: unknown = { kind: 'unknown', timestamp: '2026-05-07T00:00:00.000Z' };
    expect(TranscriptEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects missing required fields per kind', () => {
    expect(TranscriptEventSchema.safeParse({ kind: 'user-message', timestamp: '2026-05-07T00:00:00.000Z' }).success).toBe(false);
    expect(TranscriptEventSchema.safeParse({ kind: 'tool-call', timestamp: '2026-05-07T00:00:00.000Z' }).success).toBe(false);
    expect(TranscriptEventSchema.safeParse({ kind: 'edit', timestamp: '2026-05-07T00:00:00.000Z', path: 'x' }).success).toBe(false);
  });

  it('TranscriptEvent type discriminated correctly', () => {
    // Compile-time discrimination check
    const e: TranscriptEvent = { kind: 'user-message', timestamp: '2026-05-07T00:00:00.000Z', content: 'x' };
    if (e.kind === 'tool-call') {
      const _name: string = e.name;
      const _args: Record<string, unknown> = e.args;
    } else if (e.kind === 'edit') {
      const _path: string = e.path;
      const _diff: string = e.diff;
    } else if (e.kind === 'tool-result') {
      const _content: string = e.content;
    } else if (e.kind === 'user-message' || e.kind === 'assistant-message') {
      const _content: string = e.content;
    }
    expect(true).toBe(true);
  });
});
