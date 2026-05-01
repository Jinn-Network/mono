/**
 * Hook-slot contract test. Asserts the JSON schema's `event` enum
 * matches the documented set so a future schema bump that drops or adds
 * an event triggers a clear test failure (and a coordinator-skill update).
 *
 * See plan
 * docs/superpowers/plans/2026-04-30-plug-in-surface-path-1-mechanism.md
 * Task 12.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('hook slot contract', () => {
  it('schema lists session-start, pre-phase, post-phase, session-end events', () => {
    const expected = [
      'session-start',
      'pre-phase',
      'post-phase',
      'session-end',
    ];
    const schemaPath = join(
      process.cwd(),
      'schemas',
      'jinn-plugin-v1.json',
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      $defs: { hook: { properties: { event: { enum: string[] } } } };
    };
    const events = schema.$defs.hook.properties.event.enum;
    expect(events).toEqual(expected);
  });
});
