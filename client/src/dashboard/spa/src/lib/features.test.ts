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
    expect(getFeatures()).toEqual({ pluginBuilderUi: false, embeddedAgent: false });
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
    expect(getFeatures()).toEqual({ pluginBuilderUi: false, embeddedAgent: false });
  });

  // Issue #367: the embedded-agent flag converged onto this same channel.
  it('reads embeddedAgent true when injected as true', () => {
    window.__JINN_FEATURES__ = { embeddedAgent: true };
    expect(getFeatures().embeddedAgent).toBe(true);
  });

  it('treats embeddedAgent false as off', () => {
    window.__JINN_FEATURES__ = { embeddedAgent: false };
    expect(getFeatures().embeddedAgent).toBe(false);
  });

  it('coerces a non-boolean embeddedAgent to off', () => {
    window.__JINN_FEATURES__ = { embeddedAgent: 'true' as unknown };
    expect(getFeatures().embeddedAgent).toBe(false);
  });

  it('treats a missing embeddedAgent key as off', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: true };
    expect(getFeatures().embeddedAgent).toBe(false);
  });

  it('reads both flags independently', () => {
    window.__JINN_FEATURES__ = { pluginBuilderUi: true, embeddedAgent: true };
    expect(getFeatures()).toEqual({ pluginBuilderUi: true, embeddedAgent: true });
  });
});
