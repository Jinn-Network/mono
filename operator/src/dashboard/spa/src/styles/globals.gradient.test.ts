import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for issue #519: BRAND.md / CLAUDE.md §Design System forbid
// decorative gradients ("Never use gradients as decoration" — protection
// gradients over imagery are the only exception). The dashboard rework had
// introduced a decorative gold linear-gradient wash on the active Onboarding
// phase row. This test pins that no decoratively-used gradient re-enters the
// SPA globals.css.
const globalsCss = readFileSync(
  fileURLToPath(new URL('./globals.css', import.meta.url)),
  'utf8',
);

describe('globals.css brand non-negotiables', () => {
  it('contains no decorative linear/radial gradient', () => {
    expect(globalsCss).not.toMatch(/linear-gradient|radial-gradient/i);
  });
});
