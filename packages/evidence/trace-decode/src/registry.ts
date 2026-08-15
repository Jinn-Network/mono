// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "@jinn-network/evidence-trace";

import { DecoderContractError, UnsupportedFormatError } from "./contract.js";
import type { TraceDecoder } from "./contract.js";
import { FORMAT_IRI_PATTERN } from "./formats.js";

/** Matches the record schema's `derivation.decoderId` rule. */
const DECODER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Semver core; decoder versions are boring on purpose. */
const DECODER_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface DecoderRegistry {
  /** Every format this registry can decode, ordered so the listing is reproducible. */
  readonly formats: readonly string[];
  /** Non-throwing lookup, for consumers whose decode is best-effort. */
  get(formatIri: string): TraceDecoder | undefined;
  /** Fail-closed lookup, for callers that must not proceed without a decoder. */
  require(formatIri: string): TraceDecoder;
}

export function createDecoderRegistry(
  decoders: readonly TraceDecoder[],
): DecoderRegistry {
  const violations: string[] = [];
  const byFormat = new Map<string, TraceDecoder>();

  for (const decoder of decoders) {
    if (!FORMAT_IRI_PATTERN.test(decoder.formatIri)) {
      violations.push(`format IRI ${decoder.formatIri} is not canonical`);
    }
    if (!DECODER_ID_PATTERN.test(decoder.decoderId)) {
      violations.push(`decoder id ${decoder.decoderId} is not a lowercase slug`);
    }
    if (!DECODER_VERSION_PATTERN.test(decoder.decoderVersion)) {
      violations.push(`decoder version ${decoder.decoderVersion} is not semver`);
    }
    if (byFormat.has(decoder.formatIri)) {
      violations.push(`two decoders claim format ${decoder.formatIri}`);
    }
    byFormat.set(decoder.formatIri, decoder);
  }

  if (violations.length > 0) throw new DecoderContractError(violations);

  const formats = Object.freeze(
    [...byFormat.keys()].sort(compareCodeUnitStrings),
  );

  return {
    formats,
    get: (formatIri) => byFormat.get(formatIri),
    require: (formatIri) => {
      const decoder = byFormat.get(formatIri);
      if (decoder === undefined) throw new UnsupportedFormatError(formatIri);
      return decoder;
    },
  };
}
