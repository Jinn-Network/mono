import { describe, expect, it } from 'vitest';

import { parsePinShape, validateBaseUrl } from '../../scripts/skills-bench/render-report.js';
import type { SkillPin } from '../../src/skills-bench/skill-pin.js';

// ---------------------------------------------------------------------------
// parsePinShape (D1 I4) — `loadPin` previously cast straight to `SkillPin`
// after checking only two of eight fields (`name`/`commit`), so a pin.json
// predating a field (e.g. `repoLicense`, added after
// bench/skills-under-test/tdd/pin.json was written) silently carried
// `undefined` where the type declares `string | null`.
// ---------------------------------------------------------------------------

function validRaw(): Record<string, unknown> {
  return {
    name: 'tdd',
    source: 'https://github.com/org/skills-repo',
    commit: 'b'.repeat(40),
    skillPath: 'skills/tdd',
    sha256: 'c'.repeat(64),
    fetchedAt: '2026-08-01T00:00:00.000Z',
    license: 'MIT',
    repoLicense: 'MIT License',
  };
}

describe('parsePinShape (D1 I4)', () => {
  it('accepts a fully-populated pin.json unchanged', () => {
    const pin = parsePinShape(validRaw() as Partial<SkillPin>, '/x/pin.json');
    expect(pin).toEqual(validRaw());
  });

  it('normalizes a missing repoLicense to null rather than leaking undefined', () => {
    const raw = validRaw();
    delete raw.repoLicense;
    const pin = parsePinShape(raw as Partial<SkillPin>, '/x/pin.json');
    expect(pin.repoLicense).toBeNull();
    expect('repoLicense' in pin).toBe(true);
  });

  it('normalizes a missing license to null', () => {
    const raw = validRaw();
    delete raw.license;
    const pin = parsePinShape(raw as Partial<SkillPin>, '/x/pin.json');
    expect(pin.license).toBeNull();
  });

  it.each(['name', 'source', 'commit', 'skillPath', 'sha256', 'fetchedAt'])(
    'throws naming the missing required field "%s"',
    (field) => {
      const raw = validRaw();
      delete raw[field];
      expect(() => parsePinShape(raw as Partial<SkillPin>, '/x/pin.json')).toThrow(
        new RegExp(`missing "${field}"`),
      );
    },
  );

  it('throws when license is present but not a string or null', () => {
    const raw = { ...validRaw(), license: 42 };
    expect(() => parsePinShape(raw as unknown as Partial<SkillPin>, '/x/pin.json')).toThrow(
      /"license" must be a string or null/,
    );
  });

  it('throws when repoLicense is present but not a string or null', () => {
    const raw = { ...validRaw(), repoLicense: 42 };
    expect(() => parsePinShape(raw as unknown as Partial<SkillPin>, '/x/pin.json')).toThrow(
      /"repoLicense" must be a string or null/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateBaseUrl (D1 I6) — the previously-documented example
// (`https://github.com/.../blob/main`) produces `embed.md` image links that
// GitHub serves as an HTML page, not the SVG bytes, so every embedded
// badge/card in a reader's README was broken.
// ---------------------------------------------------------------------------

describe('validateBaseUrl (D1 I6)', () => {
  it('accepts a raw.githubusercontent.com base', () => {
    expect(() => validateBaseUrl('https://raw.githubusercontent.com/org/repo/main')).not.toThrow();
  });

  it('accepts a GitHub Pages base', () => {
    expect(() => validateBaseUrl('https://org.github.io/repo')).not.toThrow();
  });

  it('accepts a non-GitHub host containing "blob" elsewhere in the path', () => {
    expect(() => validateBaseUrl('https://example.com/blob-store/reports')).not.toThrow();
  });

  it('refuses a github.com "blob" base — it serves HTML, not raw bytes', () => {
    expect(() => validateBaseUrl('https://github.com/Jinn-Network/skills-eval/blob/main')).toThrow(
      /GitHub "blob" URL/,
    );
  });
});
