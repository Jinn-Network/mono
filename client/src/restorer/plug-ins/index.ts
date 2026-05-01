/**
 * Path 1 plug-in surface — loader, registry, and manifest types.
 *
 * Spec: spec/2026-04-30-plug-in-surface.md §4.
 * Plan: docs/superpowers/plans/2026-04-30-plug-in-surface-path-1-mechanism.md.
 */

export { loadPlugInManifest } from './manifest.js';
export { loadPlugIns } from './loader.js';
export { emptyRegistry } from './registry.js';
export { serialiseRegistry } from './serialise.js';
export type { LoadPlugInsArgs, LoadPlugInsResult } from './loader.js';
export type { SlotRegistry, RegistrySlot } from './registry.js';
export type { SerialisedRegistry } from './serialise.js';
export type * from './types.js';
