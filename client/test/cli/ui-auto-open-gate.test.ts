/**
 * First-launch UI auto-open gate (issue #804).
 *
 * `jinn run` used to call `openBrowser()` unconditionally on every launch,
 * so every restart during a dogfooding session opened a fresh browser tab
 * and stale tabs accumulated. `decideUiAutoOpen()` is the single source of
 * truth for whether main.ts should auto-open the browser and/or write the
 * "first launch happened" marker file this run.
 *
 * Rules:
 *  - `noUi` (JINN_NO_UI=1) wins outright: never open, never write the marker.
 *  - Otherwise open when forced (`--ui`) or when the marker doesn't exist yet
 *    (first-ever launch).
 *  - Write the marker whenever it didn't already exist (so the first launch
 *    is recorded even under a headless / no-ui run, and every later run sees
 *    an existing marker).
 */
import { describe, it, expect } from 'vitest';
import { decideUiAutoOpen } from '../../src/cli/ui-auto-open-gate.js';

describe('decideUiAutoOpen', () => {
  it('first-ever launch (no marker, no flags): opens and writes the marker', () => {
    expect(
      decideUiAutoOpen({ noUi: false, forceUi: false, markerExists: false }),
    ).toEqual({ shouldOpen: true, shouldWriteMarker: true });
  });

  it('subsequent launch (marker present, no flags): does NOT open — the bug fix', () => {
    expect(
      decideUiAutoOpen({ noUi: false, forceUi: false, markerExists: true }),
    ).toEqual({ shouldOpen: false, shouldWriteMarker: false });
  });

  it('--ui forces open even when the marker is present', () => {
    expect(
      decideUiAutoOpen({ noUi: false, forceUi: true, markerExists: true }),
    ).toEqual({ shouldOpen: true, shouldWriteMarker: false });
  });

  it('--ui on a first-ever launch still opens and writes the marker', () => {
    expect(
      decideUiAutoOpen({ noUi: false, forceUi: true, markerExists: false }),
    ).toEqual({ shouldOpen: true, shouldWriteMarker: true });
  });

  it('JINN_NO_UI=1 suppresses open on first-ever launch and does not write the marker', () => {
    expect(
      decideUiAutoOpen({ noUi: true, forceUi: false, markerExists: false }),
    ).toEqual({ shouldOpen: false, shouldWriteMarker: false });
  });

  it('JINN_NO_UI=1 suppresses open on a later launch too', () => {
    expect(
      decideUiAutoOpen({ noUi: true, forceUi: false, markerExists: true }),
    ).toEqual({ shouldOpen: false, shouldWriteMarker: false });
  });

  it('JINN_NO_UI=1 wins over --ui (no-ui overrides force-ui)', () => {
    expect(
      decideUiAutoOpen({ noUi: true, forceUi: true, markerExists: false }),
    ).toEqual({ shouldOpen: false, shouldWriteMarker: false });
    expect(
      decideUiAutoOpen({ noUi: true, forceUi: true, markerExists: true }),
    ).toEqual({ shouldOpen: false, shouldWriteMarker: false });
  });
});
