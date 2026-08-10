/**
 * The product lifecycle state machine (spec §4.1).
 *
 * One product state machine, named states:
 *
 *   draft → (preview*) → quoted → locked → running → closed → reported →
 *   published-bundle
 *
 * `preview` is a repeatable, NON-advancing event (assumption A5): it is legal in
 * `draft` and `quoted` and always returns the state it was called in unchanged. It
 * is modeled here as an ordinary event in the transition table — not as a separate
 * "preview state" — because a preview never persists as product state; it only ever
 * produces a preview artifact (spec §7.2) alongside the draft or quote it left
 * untouched.
 *
 * `edit` on a `quoted` draft returns the subject to `draft` (assumption A2): any
 * mutation of a quoted draft's content invalidates the quote, because a quote
 * always describes the exact draft it priced.
 *
 * `cancel` is modeled here as a legal event on `running`, landing on `closed` —
 * the same terminal state `close-boundary` reaches. This packet only wires the
 * state transition; the full accounting semantics (`runOutcome: cancelled`, the
 * matrix still assembling with exactly one entry per expected cell, spec §4.1)
 * belong to later packets that build the Official Run and Matrix operations. The
 * machine must already admit the event so those packets aren't blocked on a
 * lifecycle change.
 *
 * There is no product-level "failed" state (spec §4.1): a failed *operation*
 * (illegal event, invalid input) returns a typed error and leaves the lifecycle
 * state unchanged; per-cell and per-run outcomes are accounted in the Matrix, not
 * modeled as lifecycle states.
 */

import { z } from "zod";
import type { ProductErrorEnvelope } from "../errors.js";

export const LIFECYCLE_STATES = [
  "draft",
  "quoted",
  "locked",
  "running",
  "closed",
  "reported",
  "published-bundle",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LifecycleStateSchema = z.enum(LIFECYCLE_STATES);

export const LIFECYCLE_EVENTS = [
  "edit",
  "preview",
  "quote",
  "lock",
  "launch",
  "watch",
  "resume",
  "cancel",
  "close-boundary",
  "report",
  "publish",
] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export type TransitionResult =
  | { readonly ok: true; readonly state: LifecycleState }
  | { readonly ok: false; readonly error: ProductErrorEnvelope };

/**
 * The complete legal transition table (spec §4.1). Every `(state, event)` pair not
 * present here is illegal and `transition` refuses it.
 */
const TRANSITIONS: Readonly<Record<LifecycleState, Readonly<Partial<Record<LifecycleEvent, LifecycleState>>>>> = {
  draft: {
    edit: "draft",
    preview: "draft",
    quote: "quoted",
  },
  quoted: {
    preview: "quoted",
    edit: "draft",
    lock: "locked",
  },
  locked: {
    launch: "running",
  },
  running: {
    watch: "running",
    resume: "running",
    cancel: "closed",
    "close-boundary": "closed",
  },
  closed: {
    report: "reported",
  },
  reported: {
    publish: "published-bundle",
  },
  "published-bundle": {},
};

/**
 * Applies `event` to `state`. Returns the next state on a legal transition, or a
 * typed `illegal-transition` error (naming both the state and the event) when the
 * pair is not in the table. Never throws — callers branch on `result.ok`.
 */
export function transition(state: LifecycleState, event: LifecycleEvent): TransitionResult {
  const next = TRANSITIONS[state][event];
  if (next === undefined) {
    return {
      ok: false,
      error: {
        code: "illegal-transition",
        detail: `event "${event}" is not legal in state "${state}"`,
      },
    };
  }
  return { ok: true, state: next };
}

/** True only for "draft" and "quoted" — locked and later states forbid draft mutation. */
export function isDraftMutable(state: LifecycleState): boolean {
  return state === "draft" || state === "quoted";
}
