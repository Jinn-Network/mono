/**
 * BroadcastEvent — the normalised shape every source produces. The composer
 * receives this and returns prose; the poster posts that prose.
 *
 * `payload` carries only fields the composer is allowed to reference. Sources
 * are responsible for stripping anything outside that fact set before handing
 * the event over — the prompt is constrained to "use only what's in payload",
 * so payload defines the editorial surface.
 */
export type EventType =
  | 'release'
  | 'pr'
  | 'discussion'
  | 'solvernet-manifest'
  | 'plugin';

export interface BroadcastEvent {
  type: EventType;
  /** Stable identifier used for deduplication. Source-specific. */
  dedupeKey: string;
  /** Canonical URL posted with the tweet. */
  link: string;
  /** Source watermark candidate — newest event in a poll advances state. */
  timestamp: string;
  /** Facts the composer may reference. Must be a flat string-keyed object. */
  payload: Record<string, string | number>;
}

export interface ComposedPost {
  event: BroadcastEvent;
  text: string;
}
