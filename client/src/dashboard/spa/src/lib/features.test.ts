/**
 * @vitest-environment jsdom
 *
 * `getFeatures` reads `window`; the shared vitest config only maps `.test.tsx`
 * to jsdom, so this `.test.ts` file opts in explicitly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getFeatures } from './features.js';

afterEach(() => {
  delete (window as { __JINN_FEATURES__?: unknown }).__JINN_FEATURES__;
});

describe('getFeatures', () => {
  it('defaults every flag off when window.__JINN_FEATURES__ is absent', () => {
    expect(getFeatures()).toEqual({ pluginBuilderUi: false });
  });

  it('reads pluginBuilderUi true when injected as true', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: true };
    expect(getFeatures().pluginBuilderUi).toBe(true);
  });

  it('treats pluginBuilderUi false as off', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: false };
    expect(getFeatures().pluginBuilderUi).toBe(false);
  });

  it('coerces non-boolean values to off (never enables by accident)', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: 'true' as unknown };
    expect(getFeatures().pluginBuilderUi).toBe(false);
  });

  it('treats a missing key as off', () => {
    window.__JINN_FEATURES__ = {};
    expect(getFeatures().pluginBuilderUi).toBe(false);
  });

  it('treats a non-object injection as all-off', () => {
    window.__JINN_FEATURES__ = 'enabled' as unknown as Record<string, unknown>;
    expect(getFeatures()).toEqual({ pluginBuilderUi: false });
  });
});
