import { z } from "zod";

import { topLevelRecordSchema } from "./extensions.js";
import { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND } from "./identifiers.js";
import {
  Count,
  DigestPinnedDescriptorSchema,
  ExactSemanticVersion,
  HttpOrigin,
  NonEmpty,
  PrefixedSha256,
  RecordKindUri,
} from "./primitives.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";

/**
 * A component world, referenced by digest (E11: first-class from day one, never inlined, so
 * there is no inline-match problem to enforce here).
 *
 * The `kind` is checked against the record-kind URI grammar rather than against a pinned
 * information-world constant: that constant belongs to the information-world package, and two
 * packages declaring one identifier is a drift surface. What this record needs is structural —
 * a component of a stated kind, pinned by digest — and that is what it validates.
 */
export const WorldReferenceSchema = z.strictObject({
  kind: RecordKindUri,
  record: DigestPinnedDescriptorSchema,
});

/**
 * An information world plus the stable local handle the composition block and the evaluation
 * family's `sourceValue` / `sourceConsulted` predicates address it by.
 */
export const InformationWorldReferenceSchema = z.strictObject({
  id: NonEmpty,
  kind: RecordKindUri,
  record: DigestPinnedDescriptorSchema,
});

/**
 * A pinned reusable component (a replay service, a browser). Runtimes upgrade without
 * pretending chain state changed — which is exactly why they live in the composite and not in
 * the chain record (§4.4).
 */
export const ServiceRuntimeSchema = z.strictObject({
  id: NonEmpty,
  family: NonEmpty,
  version: ExactSemanticVersion,
  image: z.strictObject({
    manifestDigest: PrefixedSha256,
    platform: z
      .string()
      .regex(/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/, "platform is os/arch[/variant]"),
  }),
});

/**
 * What only exists once worlds are combined (§4.4): origin routing with explicit precedence,
 * the composite miss policy, the reachable-endpoint allowlist, and the request budget.
 *
 * The miss policy has one mode on purpose. An uncaptured request returns the declared
 * response; it never reaches upstream. That is the exact analogue of an out-of-slice chain
 * read returning empty, and a second mode would be the place a live fetch got in.
 */
export const CompositionSchema = z.strictObject({
  originRouting: z.array(
    z.strictObject({
      origin: HttpOrigin,
      worldId: NonEmpty,
      /** Lower wins. Two worlds may share an origin only with distinct precedence. */
      precedence: Count,
    }),
  ),
  missPolicy: z.strictObject({
    mode: z.literal("declared-response"),
    status: z.number().int().min(100).max(599),
    body: DigestPinnedDescriptorSchema.optional(),
  }),
  endpointAllowlist: z.array(HttpOrigin),
  requestBudget: z.strictObject({
    maxRequests: Count,
    maxResponseBytes: Count,
  }),
});

/**
 * The composite a task references (E14). A chain-only world is a composite with an empty
 * `informationWorlds` list, so the common v1 case pays one indirection and nothing else.
 *
 * Components are sealed and verified independently and their attestations are reusable; the
 * composite is verified as a whole because routing collisions and whole-world closure only
 * exist in combination. Neither attestation substitutes for the other, and neither lives here.
 */
export const CryptoEnvironmentRecordSchema = topLevelRecordSchema({
  kind: z.literal(CRYPTO_ENVIRONMENT_KIND),
  chainWorld: WorldReferenceSchema,
  informationWorlds: z.array(InformationWorldReferenceSchema),
  serviceRuntimes: z.array(ServiceRuntimeSchema),
  composition: CompositionSchema,
  supersedes: DigestPinnedDescriptorSchema.optional(),
}).superRefine((record, ctx) => {
  if (record.chainWorld.kind !== CHAIN_ENVIRONMENT_KIND) {
    ctx.addIssue({
      code: "custom",
      path: ["chainWorld", "kind"],
      message: `chainWorld must reference ${CHAIN_ENVIRONMENT_KIND} (§4.4)`,
    });
  }

  const worldIds = new Set<string>();
  record.informationWorlds.forEach((world, index) => {
    if (world.kind === CHAIN_ENVIRONMENT_KIND) {
      ctx.addIssue({
        code: "custom",
        path: ["informationWorlds", index, "kind"],
        message: "an information world is not a chain world; a composite has exactly one chain world (§4.4)",
      });
    }
    if (worldIds.has(world.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["informationWorlds", index, "id"],
        message: `duplicate information-world id "${world.id}"; routing and predicates address worlds by id`,
      });
    }
    worldIds.add(world.id);
  });

  const runtimeIds = new Set<string>();
  record.serviceRuntimes.forEach((runtime, index) => {
    if (runtimeIds.has(runtime.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["serviceRuntimes", index, "id"],
        message: `duplicate service-runtime id "${runtime.id}"`,
      });
    }
    runtimeIds.add(runtime.id);
  });

  const allowlist = new Set(record.composition.endpointAllowlist);
  if (allowlist.size !== record.composition.endpointAllowlist.length) {
    ctx.addIssue({
      code: "custom",
      path: ["composition", "endpointAllowlist"],
      message: "duplicate origin on the reachable-endpoint allowlist",
    });
  }

  /** origin -> precedence values already claimed, and the worlds that claimed them. */
  const claimed = new Map<string, { precedences: Set<number>; worlds: Set<string> }>();
  record.composition.originRouting.forEach((route, index) => {
    if (!worldIds.has(route.worldId)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "worldId"],
        message: `route names "${route.worldId}", which is not a declared information world`,
      });
    }
    if (!allowlist.has(route.origin)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "origin"],
        message: `${route.origin} is routed but absent from the reachable-endpoint allowlist (§4.4)`,
      });
    }
    const entry = claimed.get(route.origin) ?? { precedences: new Set<number>(), worlds: new Set<string>() };
    if (entry.precedences.has(route.precedence)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "precedence"],
        message:
          `two information worlds claim ${route.origin} at precedence ${route.precedence}. Two `
          + "corpora on one origin is a reproducibility hazard, not a merge: declare distinct "
          + "precedence so resolution is total (§4.4)",
      });
    }
    entry.precedences.add(route.precedence);
    if (entry.worlds.has(route.worldId)) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting", index, "worldId"],
        message: `"${route.worldId}" is routed twice for ${route.origin}; one world serves an origin at one precedence`,
      });
    }
    entry.worlds.add(route.worldId);
    claimed.set(route.origin, entry);
  });

  // A chain-only composite must genuinely have no information plane, or the empty list is
  // decoration over a retrieval surface nothing describes.
  const budget = record.composition.requestBudget;
  if (record.informationWorlds.length === 0) {
    if (record.composition.originRouting.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "originRouting"],
        message: "a composite with no information worlds routes nothing (§4.4)",
      });
    }
    if (budget.maxRequests !== 0 || budget.maxResponseBytes !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["composition", "requestBudget"],
        message: "a composite with no information worlds has a zero request budget (§4.4)",
      });
    }
    return;
  }
  if (budget.maxRequests === 0 || budget.maxResponseBytes === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["composition", "requestBudget"],
      message: "composed information worlds need a positive request budget; retrieval is bounded like every other capability (§4.4)",
    });
  }
});

export type CryptoEnvironmentRecord = z.infer<typeof CryptoEnvironmentRecordSchema>;

/** Validate, then canonicalize once. Identity is `cryptoEnvironmentRecordDigest(bytes)`. */
export function sealCryptoEnvironmentRecord(record: unknown): Uint8Array {
  return sealWithSchema(CryptoEnvironmentRecordSchema, record);
}

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseCryptoEnvironmentRecord(bytes: Uint8Array): CryptoEnvironmentRecord {
  return parseExactWithSchema(CryptoEnvironmentRecordSchema, bytes);
}
