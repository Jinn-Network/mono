/**
 * First-launch UI auto-open gate (issue #804).
 *
 * `jinn run` used to call `openBrowser()` unconditionally on every launch, so
 * every restart during a dogfooding session opened a fresh browser tab and
 * stale tabs accumulated. This predicate is the single source of truth for
 * whether main.ts should auto-open the browser and/or write the "first
 * launch happened" marker file this run.
 *
 * `noUi` (JINN_NO_UI=1 / `--no-ui`) wins outright over `forceUi` (JINN_FORCE_UI=1
 * / `--ui`): headless mode never opens a browser and never writes the marker.
 * Otherwise, open when forced or when the marker doesn't exist yet
 * (first-ever launch); write the marker whenever it didn't already exist.
 */
export function decideUiAutoOpen(opts: {
  noUi: boolean;
  forceUi: boolean;
  markerExists: boolean;
}): { shouldOpen: boolean; shouldWriteMarker: boolean } {
  if (opts.noUi) {
    return { shouldOpen: false, shouldWriteMarker: false };
  }
  return {
    shouldOpen: opts.forceUi || !opts.markerExists,
    shouldWriteMarker: !opts.markerExists,
  };
}
