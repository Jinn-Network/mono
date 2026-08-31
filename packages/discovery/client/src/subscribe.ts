import type { AnnouncementEntry, AnnouncementEvent, SourceCursor } from "@jinn-network/record-discovery-protocol";
import { announcementDedupeKey, compareCodeUnitStrings } from "@jinn-network/record-discovery-protocol";

import { isPrivateOrReservedHost } from "./origin-policy.js";
import type { StreamSubscription, StreamTransport, Transport } from "./ports.js";

// The §9 subscribe plane, client side: the five-case cursor contract
// (§9.3), the announcement dedupe key (§9.1, re-exported from protocol and
// wrapped here as a stateful cache), the two normative relay cross-check
// obligations (§9.5), the retrospective-withdrawal / `reorged` pruning
// obligations (§5.1/§6.2), consumer-side ping-flood debounce (§7.4), and
// the hostile-locator guards (§7/§14). Observation-stream pass-through
// needs no code here: a relay forwards TEP lifecycle observations
// unaltered (§9.1), so a subscribe client's observation handler is simply
// "the host's own callback, called with the raw event" -- there is
// nothing for this module to transform.

// ---------------------------------------------------------------------------
// The cursor contract (§9.3).
// ---------------------------------------------------------------------------

export type CursorBehavior = "live-tail-from-now" | "typed-error-close" | "replay-then-live" | "cursor-too-old" | "start-of-window";

export interface CursorClassification {
  behavior: CursorBehavior;
  detailCode?: string;
}

/**
 * Classifies a subscribe request's cursor into one of the five normative
 * cases (§9.3 table). `cursorPosition` is the cursor's offset into the
 * relay's replay window when known (negative = older than the window
 * start; `undefined` = the relay has no record of this cursor at all,
 * i.e. unknown-or-future -- never guessed).
 */
export function classifyCursor(
  cursor: string | undefined,
  replayWindowSize: number,
  cursorPosition?: number,
): CursorClassification {
  if (cursor === undefined) return { behavior: "live-tail-from-now" };
  if (cursor === "oldest") return { behavior: "start-of-window" };
  if (cursorPosition === undefined) return { behavior: "typed-error-close" };
  if (cursorPosition < 0) return { behavior: "cursor-too-old", detailCode: "cursor-too-old" };
  if (cursorPosition < replayWindowSize) return { behavior: "replay-then-live" };
  return { behavior: "typed-error-close" };
}

// ---------------------------------------------------------------------------
// Announcement dedupe (§9.1): `(source identity, entry digest, announcementId)`.
// ---------------------------------------------------------------------------

export interface AnnouncementDedupe {
  /** Returns true the first time this event's dedupe key is seen, false on every redelivery. */
  isNew(event: AnnouncementEvent): boolean;
}

export function createAnnouncementDedupe(): AnnouncementDedupe {
  const seen = new Set<string>();
  return {
    isNew(event: AnnouncementEvent): boolean {
      const key = announcementDedupeKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Relay cross-checks (§9.5): a subscription is an availability optimization
// only -- a malicious relay can delay, drop, or reorder, never forge.
// ---------------------------------------------------------------------------

/**
 * Obligation 1: periodic independent head-vs-delivered comparison. A
 * relay whose highest delivered sequence lags the independently observed
 * head (fetched via any mirror, never through the relay itself) is
 * withholding -- downgrade it (§13.4 ladder), never treat it as complete.
 */
export function shouldDowngradeRelay(relayDeliveredUpTo: SourceCursor, independentlyObservedHead: SourceCursor): boolean {
  return compareCodeUnitStrings(independentlyObservedHead.sequence, relayDeliveredUpTo.sequence) > 0;
}

export interface SpotCheckResult {
  caught: boolean;
  missingAnnouncementIds: string[];
}

/**
 * Obligation 2: entry-granular spot-check. A relay can deliver an entry's
 * OTHER items while dropping the one it wants to censor -- invisible to
 * sequence accounting alone. Retrieve the full entry again (by digest,
 * from any mirror) and diff its `announcements[]` against what the relay actually
 * delivered for it.
 */
export function spotCheckEntry(fullEntry: AnnouncementEntry, deliveredAnnouncementIds: ReadonlySet<string>): SpotCheckResult {
  const missingAnnouncementIds = fullEntry.announcements
    .map((announcement) => announcement.announcementId)
    .filter((id) => !deliveredAnnouncementIds.has(id));
  return { caught: missingAnnouncementIds.length > 0, missingAnnouncementIds };
}

// ---------------------------------------------------------------------------
// Retrospective-withdrawal pruning obligations (§5.1, §6.2).
// ---------------------------------------------------------------------------

export type WithdrawalReason = "delisted" | "superseded" | "reorged" | "error";

export interface WithdrawalClassification {
  /** Retrospective-kind items (evidence, evaluations, verifications, ...) are immune to pruning on withdrawal -- always false. */
  prune: boolean;
  /** `reorged` is the one reason code that must trigger consumer recompute (the substrate moved). */
  recompute: boolean;
}

export function classifyWithdrawal(reason: WithdrawalReason): WithdrawalClassification {
  return { prune: false, recompute: reason === "reorged" };
}

// ---------------------------------------------------------------------------
// Consumer-side ping-flood debounce (§7.4): a ping flood may cost the
// consumer at most its own configured pull rate, never a pull per ping.
// ---------------------------------------------------------------------------

export interface PullDebounce {
  /** Returns whether a pull should actually be issued for `headUrl` at `at`. */
  shouldPull(headUrl: string, at: Date): boolean;
}

export function createPullDebounce(windowMs: number): PullDebounce {
  const lastPulledAtMs = new Map<string, number>();
  return {
    shouldPull(headUrl: string, at: Date): boolean {
      const nowMs = at.getTime();
      const lastMs = lastPulledAtMs.get(headUrl);
      if (lastMs !== undefined && nowMs - lastMs < windowMs) return false;
      lastPulledAtMs.set(headUrl, nowMs);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Hostile-locator guards (§7, §14.1): `locations[].locator` is
// attacker-influenced by construction. Consumers apply size ceilings,
// content-type checks, and private-address/SSRF guards -- the digest
// re-hash (not this check) is the only accepted proof of content.
// ---------------------------------------------------------------------------

export interface LocatorCheckDeps {
  transport: Transport;
  maxBytes: number;
  /** Content types the fetched response may carry; anything else (e.g. an HTML error page) is rejected. Defaults to any `application/*` type. */
  acceptedContentTypePrefix?: string;
}

export interface LocatorCheckResult {
  rejected: boolean;
  reason?: "malformed" | "private-address" | "unreachable" | "oversize" | "wrong-content-type";
}

/**
 * Applies the location retrieval guards to one `{profile, locator}` pair
 * before its content is trusted for anything beyond a digest-verified
 * retrieval: a malformed or private/link-local locator is rejected before
 * any network call; an oversized or wrongly-typed response is rejected
 * after retrieval (the transport's own `declaredLength`/`contentType`,
 * checked ahead of trusting the body).
 */
export async function checkLocator(
  location: { profile: string; locator: string },
  deps: LocatorCheckDeps,
): Promise<LocatorCheckResult> {
  let url: URL;
  try {
    url = new URL(location.locator);
  } catch {
    return { rejected: true, reason: "malformed" };
  }
  if (isPrivateOrReservedHost(url.hostname)) {
    return { rejected: true, reason: "private-address" };
  }

  let response;
  try {
    response = await deps.transport.fetch(location.locator);
  } catch {
    return { rejected: true, reason: "unreachable" };
  }

  const declaredOrActualLength = response.declaredLength ?? response.bytes.length;
  if (declaredOrActualLength > deps.maxBytes) {
    return { rejected: true, reason: "oversize" };
  }

  const acceptedPrefix = deps.acceptedContentTypePrefix ?? "application/";
  if (response.contentType !== undefined && !response.contentType.startsWith(acceptedPrefix)) {
    return { rejected: true, reason: "wrong-content-type" };
  }

  return { rejected: false };
}

// ---------------------------------------------------------------------------
// The subscribe client itself (§9.1, §9.4): pull-tail is the normative HTTP
// profile (long-poll/WS/SSE via the injected StreamTransport, one
// normative HTTP profile fixed at implementation); optional push follows
// the same wire format with a WebSub-style challenge-echo handshake before
// any callback is honored, out of this reference client's scope to
// initiate (a push *sink* is a server role). Both stream families arrive
// as CloudEvents JSON on the wire (§9.1): announcement events are
// structurally distinguished from observation events by carrying the
// announce-plane's extension attributes; observation events are passed
// through to `onObservation` completely unaltered, per §9.1's "a relay
// adds nothing" rule.
// ---------------------------------------------------------------------------

function isAnnouncementEvent(value: unknown): value is AnnouncementEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["recordkind"] === "string" &&
    typeof record["sourceagent"] === "string" &&
    typeof record["sourcename"] === "string" &&
    typeof record["entrydigest"] === "string" &&
    typeof record["announcementid"] === "string"
  );
}

export interface SubscribeDeps {
  streamTransport: StreamTransport;
  url: string;
  onAnnouncement(event: AnnouncementEvent): void;
  /** Called with the raw, unaltered observation event (§9.1: a relay adds nothing). */
  onObservation(raw: unknown): void;
  onError?(error: unknown): void;
}

/**
 * Opens a pull-tail subscription and dispatches each delivered CloudEvent
 * to the appropriate handler, deduping redelivered announcements by
 * `(source identity, entry digest, announcementId)` (§9.1). Recovery never
 * needs the relay (§9.5): callers combine this with the two relay
 * cross-checks (`shouldDowngradeRelay`, `spotCheckEntry`) and fall back to
 * `sync.ts`'s chain walk on divergence.
 */
export function subscribe(deps: SubscribeDeps): StreamSubscription {
  const dedupe = createAnnouncementDedupe();
  return deps.streamTransport.connect(
    deps.url,
    (raw: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        deps.onError?.(error);
        return;
      }
      if (isAnnouncementEvent(parsed)) {
        if (dedupe.isNew(parsed)) deps.onAnnouncement(parsed);
        return;
      }
      deps.onObservation(parsed);
    },
    (error) => deps.onError?.(error),
  );
}
