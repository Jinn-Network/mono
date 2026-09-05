import {
  BUNDLE_FORMAT,
  BUNDLE_V4_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_CHECKS,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
} from "./legacy-closures.js";
import { BUNDLE_V5_FORMAT, BUNDLE_V8_FORMAT, BUNDLE_V9_FORMAT } from "./manifest.js";

/**
 * The exact producer-side release inside the `/5` line, for byte-for-byte reproduction.
 *
 * **No `/5` bundle carries this line** (issue #3941), and `/5` is the only format of which that is
 * true. Every other format's claim states its exact release; claim-package/3 has a single `command`
 * field and no compatible-line field, so a `/5` producer writes the compatible major line —
 * `PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND` — into it and states nothing else. Read that
 * constant, not this one, when the question is "which line does a `/5` bundle pin".
 */
export const PUBLIC_BUNDLE_V5_VERIFICATION_COMMAND = PUBLIC_BUNDLE_VERIFICATION_COMMAND;

/** The one line a `/5` claim states. See the asymmetry documented above. */
export const PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND =
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND;

/**
 * The disclosed closure's check list (disclosure-specification-record design §7, issue #2839): v7's
 * seven plus `disclosure-specification`, **last**. It runs after `claim-consistency` because the
 * claim's `disclosure` section is among the things it compares, and it is **always present** on this
 * format — a disclosed bundle whose record was stripped is a closure failure, not a shorter list.
 * `/8` is not one of the frozen legacy closures, so it composes here rather than living in
 * `legacy-closures.ts`.
 */
export const PUBLIC_BUNDLE_V8_CHECKS = [
  ...PUBLIC_BUNDLE_V7_CHECKS,
  "disclosure-specification",
] as const;

/**
 * Like v7 and for the same reason: no released reader before 0.2.1 understands
 * `benchmark-product-public-bundle/8`, and a claim naming a reader that cannot read it would be an
 * instruction to fail. The disclosed closure ships in the same unpublished 0.2.1 line as v7, so it
 * pins that line rather than minting a third.
 */
export const PUBLIC_BUNDLE_V8_VERIFICATION_COMMAND = PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND;
export const PUBLIC_BUNDLE_V8_COMPATIBLE_VERIFICATION_COMMAND =
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND;

/**
 * `/9` is `/6`'s closure with a different page, so it runs `/6`'s list unchanged: the denominator
 * pair is a projection of two already-sealed integers, and nothing about it is a thing to check.
 * A presentation allocation that grew a check would be claiming the render proves something the
 * records did not already prove.
 */
export const PUBLIC_BUNDLE_V9_CHECKS = PUBLIC_BUNDLE_V6_CHECKS;

/**
 * The first line that cannot be an earlier one. `/7` and `/8` pin `@0.2.1`, which is published and
 * reads `/2` through `/8`; it has never heard of `/9`, and a claim naming a reader that cannot read
 * its own bundle is an instruction to fail. `/9` therefore pins the next line — the one this
 * verifier source becomes — exactly as `/7` pinned `@0.2.1` before that release existed. Publishing
 * it is the release train's own step, not this allocation's.
 */
export const PUBLIC_BUNDLE_V9_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.3.0 <bundle-dir>" as const;
export const PUBLIC_BUNDLE_V9_COMPATIBLE_VERIFICATION_COMMAND =
  "npx @colophon-claims/verify@0.3 <bundle-dir>" as const;

/**
 * Spans every lineage, so it is composed here rather than frozen in `legacy-closures.ts`: the four
 * legacy rows come from the frozen closures, the `/5` row is the evidence-native line, the `/8` row
 * is the disclosed closure, and the `/9` row is the denominator-pair page. Every format through v6 stamps the same first public 0.1 line; v7
 * is the first that cannot, v8 pins the same 0.2.1 line as v7, and v9 is the first to pin the 0.3
 * line.
 *
 * `command` is the exact producer-side release and `compatibleCommand` the compatible major line.
 * On every row but `/5` the claim states both. The `/5` row is asymmetric (issue #3941): its
 * claim-package/3 states only `compatibleCommand`, so its `command` reproduces the producer and is
 * not a line any `/5` bundle carries. A consumer asking "which line does this format pin" reads
 * `compatibleCommand` for `/5` and `command` everywhere else.
 */
export const PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS = {
  [BUNDLE_FORMAT]: {
    command: PUBLIC_BUNDLE_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V4_FORMAT]: {
    command: PUBLIC_BUNDLE_V4_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V5_FORMAT]: {
    command: PUBLIC_BUNDLE_V5_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V6_FORMAT]: {
    command: PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V7_FORMAT]: {
    command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V8_FORMAT]: {
    command: PUBLIC_BUNDLE_V8_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V8_COMPATIBLE_VERIFICATION_COMMAND,
  },
  [BUNDLE_V9_FORMAT]: {
    command: PUBLIC_BUNDLE_V9_VERIFICATION_COMMAND,
    compatibleCommand: PUBLIC_BUNDLE_V9_COMPATIBLE_VERIFICATION_COMMAND,
  },
} as const;
