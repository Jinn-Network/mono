/**
 * SPA feature flags.
 *
 * The daemon injects `window.__JINN_FEATURES__` into the served `index.html`
 * (see `client/src/api/server.ts` → `injectFeatureFlags`). The shape is a flat
 * record of booleans; the daemon derives each flag from a `JINN_ENABLE_*`
 * environment variable.
 *
 * Default is all-off — when the script is absent (older daemon, dev build
 * served without injection, unit test) every surface gated by a flag stays
 * hidden. Callers must treat `undefined`/missing as `false`.
 *
 * Issue #327: `pluginBuilderUi` gates the operator-app builder surfaces
 * (the `/build` route + the Build top-tab). The plug-in substrate (CLI verbs,
 * indexer, Discovery API, `client/docs/build/` tree) stays live regardless —
 * only the operator-app promotion of `/build` is hidden until the
 * first-run UX is solid. Set `JINN_ENABLE_PLUGIN_BUILDER_UI=1` on the daemon
 * to re-enable the full surface for development and design work.
 */
export interface JinnFeatures {
  /** Builder UI surfaces: the `/build` route + the Build top-tab. */
  pluginBuilderUi: boolean;
}

const DEFAULT_FEATURES: JinnFeatures = {
  pluginBuilderUi: false,
};

declare global {
  interface Window {
    __JINN_FEATURES__?: Partial<Record<string, unknown>>;
  }
}

/**
 * Read the injected feature flags, falling back to all-off defaults.
 *
 * Only known keys are read, and each is coerced to a strict boolean — a
 * malformed or partial `window.__JINN_FEATURES__` can never enable a surface
 * by accident.
 */
export function getFeatures(): JinnFeatures {
  const injected = typeof window === 'undefined' ? undefined : window.__JINN_FEATURES__;
  if (!injected || typeof injected !== 'object') {
    return DEFAULT_FEATURES;
  }
  return {
    pluginBuilderUi: injected['pluginBuilderUi'] === true,
  };
}
