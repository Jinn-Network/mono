import { z } from "zod";

/**
 * Every digest in a record *body* is `sha256:`-prefixed lowercase hex (§4.1). In-toto
 * DigestSet values, by contrast, are bare hex — see `BareSha256Hex` below and the
 * `bareHexDigest` / `prefixedDigest` pair in hashing.ts.
 */
export const PrefixedSha256 = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "record-body digests are sha256:<64 lowercase hex> (§4.1)");

export const BareSha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "in-toto DigestSet values are 64 lowercase hexadecimal digits");

export const NonEmpty = z.string().min(1);

/**
 * A 32-byte EVM word — state root, block hash, genesis hash, `prevrandao`, or a
 * materializer's state commitment — as `0x` + 64 **lowercase** hex digits. Lowercase only:
 * two spellings of one word would seal to two different byte strings and therefore to two
 * different records.
 */
export const Bytes32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "expected 0x followed by 64 lowercase hexadecimal digits");

/**
 * An EVM address as `0x` + 40 lowercase hex digits. An EIP-55 checksummed spelling is refused
 * for the same reason `Bytes32` refuses mixed case: the sealed bytes admit exactly one
 * spelling of any value.
 */
export const Address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "addresses are 0x followed by 40 lowercase hexadecimal digits");

/**
 * An unsigned 256-bit quantity as a decimal string with no leading zeros. Wei and gas
 * quantities exceed `Number.MAX_SAFE_INTEGER` (one ether is 10^18 wei) and the sealed document
 * admits only exact I-JSON integers, so every such field is a string.
 */
export const Quantity = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "quantities are unsigned decimal strings with no leading zeros");

/** CAIP-2 chain identity, e.g. `eip155:1` (§10, adopted directly). */
export const Caip2ChainId = z
  .string()
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "expected a CAIP-2 chain id, e.g. eip155:1");

/** RFC 3339 timestamp in UTC, `Z`-terminated. */
export const Rfc3339Utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "expected an RFC 3339 UTC timestamp");

/** A non-negative exact I-JSON integer. */
export const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * An exact semantic version. `latest`, a range, and a two-part version are all refused: §4.3
 * requires the runtime version to be exact, and any change to it is a new record.
 */
export const ExactSemanticVersion = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "expected an exact semantic version; `latest` and ranges are refused (§4.3)",
  );

/** The house record-kind URI grammar, mirrored (this package has no discovery dependency). */
export const RecordKindUri = z
  .string()
  .regex(
    // DUAL-ACCEPT (DR-2026-08-04 transition window): canonical
    // `https://spec.jinn.network/records/<segment>/v<major>` and the legacy
    // `https://spec.jinn.network/records/<segment>/<major>.<minor>` this constant still
    // spells. Reference implementation: packages/discovery/protocol/src/origins.ts.
    // Component C2 narrows this to the canonical arm once the re-seal has landed.
    /^https:\/\/(?:spec\.)?jinn\.network\/records\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:v[1-9]\d*|\d+\.\d+)$/,
    "expected https://spec.jinn.network/records/<segment>/v<major> (or the legacy https://spec.jinn.network/records/<segment>/<major>.<minor>)",
  );

/**
 * An HTTP origin in canonical form: scheme, lowercase host, optional port — no path, no
 * trailing slash, no query. Routing collisions are decided by string equality on this value
 * (§4.4), so two spellings of one origin would silently defeat the precedence rule.
 */
export const HttpOrigin = z
  .string()
  .regex(
    /^https?:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/,
    "expected a canonical origin: scheme + lowercase host + optional port, no path",
  );

/**
 * in-toto v1 ResourceDescriptor shape, structurally mirrored (no cross-package import), and
 * open on purpose: in-toto declares this object extensible, so a bare member here is a
 * descriptor field this mirror does not name, not a smuggled core field. Every top-level
 * record key still obeys the namespacing rule.
 *
 * Note the digest spelling: DigestSet values are **bare** hex here, while scalar digest fields
 * elsewhere in a record body are `sha256:`-prefixed. That is the seam `bareHexDigest` and
 * `prefixedDigest` exist to cross, and the adversarial corpus pins both directions.
 */
export const ResourceDescriptorSchema = z
  .looseObject({
    name: NonEmpty.optional(),
    uri: NonEmpty.optional(),
    digest: z.record(z.string(), BareSha256Hex).optional(),
    mediaType: NonEmpty.optional(),
    downloadLocation: NonEmpty.optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (descriptor) =>
      descriptor.uri !== undefined
      || (descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0),
    { message: "a ResourceDescriptor requires at least one of uri/digest" },
  );

/**
 * A reference whose bytes are part of the world: `digest.sha256` is mandatory, because for
 * these references the digest is identity and the URI is only a locator (§4.1). Every
 * byte-bearing dependency of a chain record uses this, never the bare descriptor.
 */
export const DigestPinnedDescriptorSchema = ResourceDescriptorSchema.refine(
  (descriptor) => typeof descriptor.digest?.sha256 === "string",
  { message: "this reference is digest-pinned: digest.sha256 is required, a uri is not enough" },
);
