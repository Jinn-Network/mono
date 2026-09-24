/**
 * Corpus cache is not a public helper surface.
 *
 * The corpus library reuses the existing `network_artifacts` and `served_artifacts`
 * tables on the daemon's `Store`. There is no separate corpus cache API —
 * `acquireArtifactContent` is the only writer/reader, and it digest-checks cached
 * rows before serving them. Do not reintroduce `getCachedArtifact` /
 * `hasCachedArtifact`: they returned unverified `network_artifacts` rows and
 * would reopen the byte-admission gap #4359 closed (#4500).
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §2.4 (caching semantics).
 */
export {};
