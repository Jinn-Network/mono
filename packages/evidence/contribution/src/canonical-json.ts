// SPDX-License-Identifier: Apache-2.0
import canonicalize from "canonicalize";

import { EvidenceContributionError } from "./errors.js";
import { snapshotInertJsonValue } from "./validation.js";

const encoder = new TextEncoder();

/**
 * Serialize `value` to exact, private operational canonical JSON bytes.
 *
 * `value` is first snapshotted into inert JSON-compatible data (rejecting
 * proxies, accessors, symbols, cycles, sparse arrays, and unbounded depth),
 * then serialized with `canonicalize` (RFC 8785 JCS: sorted object keys,
 * compact separators, no trailing newline), then UTF-8 encoded. The result
 * is rejected if it exceeds `maxBytes`.
 *
 * This is Contribution's own private operational serialization -- it is
 * never used to produce Evidence Protocol canonical bytes, which remain
 * owned by `evidence-protocol` / the Publication and Derivation packages.
 */
export function canonicalJsonBytes(value: unknown, maxBytes: number): Uint8Array {
  const snapshot = snapshotInertJsonValue(value);
  let text: string;
  try {
    text = canonicalize(snapshot) ?? "null";
  } catch {
    throw new EvidenceContributionError("INVALID_INPUT");
  }
  const bytes = encoder.encode(text);
  if (bytes.byteLength > maxBytes) {
    throw new EvidenceContributionError("RESOURCE_LIMIT_EXCEEDED");
  }
  return bytes;
}
