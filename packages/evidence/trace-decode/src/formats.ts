// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical native-trace format identities.
 *
 * Three namings for the same thing exist in the tree today, and none of them meet:
 *
 * - the local backend's launchers declare a bare `ResultContract.envelopeFormat` string
 *   (`packages/task-execution/backend-local/launchers/src/contract.ts:34`);
 * - the frozen transcript parsers declare a bare `sourceFormat` string, which does not
 *   always agree with the launcher's (`hermes-json` versus `hermes-session-json`);
 * - `NativeTraceCapture.format.entityId` is an absolute IRI, but the assembly join
 *   hardcodes it to the supervisor-facts format for every harness
 *   (`packages/task-execution/backend-local/assembly/src/evidence-join.ts:180`), so no
 *   attached harness trace carries a harness format IRI at all.
 *
 * This table is the single mapping. Decoders key on `formatIri` and on nothing else; the
 * bare strings are inputs to translation, never selection keys.
 */

/** `https://jinn.network/formats/<slug>/v<major>` — the grammar already in the tree. */
export const FORMAT_IRI_PATTERN =
  /^https:\/\/jinn\.network\/formats\/[a-z][a-z0-9-]*\/v[1-9]\d*$/;

export interface FormatIdentity {
  /** The canonical, versioned identity every decoder keys on. */
  readonly formatIri: string;
  /** The launcher's `ResultContract.envelopeFormat` string for this format. */
  readonly envelopeFormat: string;
  /** `sourceFormat` names the frozen parsers use for the same bytes. */
  readonly legacySourceFormats: readonly string[];
  readonly mediaType: string;
  /**
   * Whether these bytes are a harness's own execution trace. `false` marks formats that
   * ride the same native-trace slot without describing harness work.
   */
  readonly harnessTrace: boolean;
  readonly description: string;
}

const IDENTITIES: readonly FormatIdentity[] = Object.freeze([
  Object.freeze({
    formatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
    envelopeFormat: "claude-code-stream-json",
    legacySourceFormats: Object.freeze(["claude-code-stream-json"]),
    mediaType: "application/x-ndjson",
    harnessTrace: true,
    description:
      "Newline-delimited JSON stream events emitted by the Claude Code CLI under --output-format stream-json.",
  }),
  Object.freeze({
    formatIri: "https://jinn.network/formats/hermes-json/v1",
    envelopeFormat: "hermes-json",
    legacySourceFormats: Object.freeze(["hermes-session-json"]),
    mediaType: "application/json",
    harnessTrace: true,
    description:
      "The Hermes agent's JSON session snapshot. Off by default host-side and carrying neither per-message timestamps nor token counts; no decoder ships for it here.",
  }),
  Object.freeze({
    formatIri: "https://jinn.network/formats/codex-exec-json/v1",
    envelopeFormat: "codex-exec-json",
    legacySourceFormats: Object.freeze(["codex-exec-json"]),
    mediaType: "application/x-ndjson",
    harnessTrace: true,
    description: "Newline-delimited JSON events emitted by codex exec --json.",
  }),
  Object.freeze({
    formatIri: "https://jinn.network/formats/cursor-agent-json/v1",
    envelopeFormat: "cursor-agent-json",
    legacySourceFormats: Object.freeze([]),
    mediaType: "application/json",
    harnessTrace: true,
    description:
      "The cursor-agent JSON envelope. No parser exists in the tree, frozen or otherwise.",
  }),
  Object.freeze({
    formatIri: "https://jinn.network/formats/backend-local-supervisor-facts/v1",
    envelopeFormat: "backend-local-supervisor-facts",
    legacySourceFormats: Object.freeze([]),
    mediaType: "application/json",
    harnessTrace: false,
    description:
      "The local backend supervisor's own outcome-and-outputs blob. Present in the native-trace slot today for every harness; it describes the supervisor, not the agent, and is never decodable to trajectory spans.",
  }),
]);

export const FORMAT_IDENTITIES = IDENTITIES;

const BY_IRI = new Map(IDENTITIES.map((entry) => [entry.formatIri, entry]));
const BY_ENVELOPE_FORMAT = new Map(
  IDENTITIES.map((entry) => [entry.envelopeFormat, entry]),
);
const BY_LEGACY_SOURCE_FORMAT = new Map(
  IDENTITIES.flatMap((entry) =>
    entry.legacySourceFormats.map((name) => [name, entry] as const),
  ),
);

export function formatIdentity(formatIri: string): FormatIdentity | undefined {
  return BY_IRI.get(formatIri);
}

/** Translate a launcher's declared `envelopeFormat` into the canonical IRI. */
export function formatIriForEnvelopeFormat(
  envelopeFormat: string,
): string | undefined {
  return BY_ENVELOPE_FORMAT.get(envelopeFormat)?.formatIri;
}

/** Translate a frozen parser's `sourceFormat` into the canonical IRI. */
export function formatIriForLegacySourceFormat(
  sourceFormat: string,
): string | undefined {
  return BY_LEGACY_SOURCE_FORMAT.get(sourceFormat)?.formatIri;
}
