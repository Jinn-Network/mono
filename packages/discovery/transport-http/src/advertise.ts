import type { WellKnownDocument, WellKnownSourceEntry } from "@jinn-network/record-discovery-serve";

import { archiveTailPath } from "./paths.js";
import type { ReplayWindowState } from "./tail.js";

// "Each source advertises its bounded replay window in the well-known
// discovery document" (composition design §7.3, discovery §9.3's
// non-archival relay rule). `serve`'s `WellKnownSourceEntry` has no
// typed slot for this (Finding F3), and its zod schema is a
// `z.looseObject`, so the field rides discovery §15's additive-unknown-
// fields rule: producers that do not advertise a window are unchanged,
// consumers that do not understand the field ignore it, and this package
// owns the type until a second producer justifies promoting it into
// `serve`.
//
// `cursorScope: "relay-local"` is the §9.3 declaration obligation made
// machine-readable: a relay's cursor numbering is its own, never the
// source chain's sequence.

export interface ReplayWindowAdvertisement {
  /** Where the tail is served, relative to the serving root. */
  tailPath: string;
  /** §9.3: relay cursors are relay-local and MUST be declared as such. */
  cursorScope: "relay-local";
  /** The bounded window's capacity in events. */
  capacity: number;
}

export type AdvertisedSourceEntry = WellKnownSourceEntry & { replayWindow: ReplayWindowAdvertisement };

export function advertiseReplayWindow(sourceName: string, window: ReplayWindowState): ReplayWindowAdvertisement {
  return {
    tailPath: archiveTailPath(sourceName),
    cursorScope: "relay-local",
    capacity: window.capacity,
  };
}

/**
 * Returns a copy of `document` in which every source named in `windows`
 * carries its `replayWindow` advertisement. Sources absent from `windows`
 * are copied through unchanged -- a static mirror serving the same
 * document offers no tail and advertises none.
 */
export function withReplayWindowAdvertisements(
  document: WellKnownDocument,
  windows: Record<string, ReplayWindowState>,
): WellKnownDocument {
  return {
    ...document,
    sources: document.sources.map((source) => {
      const window = windows[source.name];
      if (window === undefined) return { ...source };
      const advertised: AdvertisedSourceEntry = {
        ...source,
        replayWindow: advertiseReplayWindow(source.name, window),
      };
      return advertised;
    }),
  };
}
