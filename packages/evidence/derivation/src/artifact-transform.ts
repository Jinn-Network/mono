// SPDX-License-Identifier: Apache-2.0

import { copyBytes, sha256Digest } from "./bytes.js";
import { transformJsonBytes } from "./codecs/json.js";
import { transformJsonlBytes } from "./codecs/jsonl.js";
import { transformTextBytes } from "./codecs/text.js";
import type { SurfaceDispositionResult } from "./disposition.js";
import type { ValidatedDerivationSource } from "./source.js";
import type { SurfaceExtraction } from "./surfaces.js";
import type {
  ArtifactCodec,
  DerivationBindingImpact,
  DerivationHoldReason,
  DerivationPolicy,
  DerivationSha256Digest,
  DispositionCount,
  PublishableArtifact,
} from "./types.js";
import { compareCodeUnitStrings } from "./order.js";

export interface DerivedArtifact {
  readonly sourceEntityId: string;
  readonly sourceDigest: DerivationSha256Digest;
  readonly entityId: string;
  readonly digest: DerivationSha256Digest;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface WithheldArtifact {
  readonly entityId: string;
  readonly digest: DerivationSha256Digest;
  readonly reason: string;
}

export type ArtifactTransformationSet =
  | {
      readonly status: "transformed";
      readonly retained: readonly PublishableArtifact[];
      readonly derived: readonly DerivedArtifact[];
      readonly withheld: readonly WithheldArtifact[];
      readonly counts: readonly DispositionCount[];
      readonly bindingImpact: DerivationBindingImpact;
    }
  | { readonly status: "review-required" }
  | {
      readonly status: "withhold-record";
      readonly reasons: readonly DerivationHoldReason[];
    };

function ruleFor(
  policy: DerivationPolicy,
  mediaType: string,
  role: string,
): DerivationPolicy["artifactRules"][number] | undefined {
  return policy.artifactRules.find(
    (candidate) =>
      candidate.roles.includes(role as never) &&
      (candidate.mediaType === mediaType ||
        (candidate.mediaType.endsWith("/*") &&
          mediaType.startsWith(candidate.mediaType.slice(0, -1)))),
  );
}

function combineCounts(
  values: readonly DispositionCount[],
): readonly DispositionCount[] {
  const grouped = new Map<string, DispositionCount>();
  for (const value of values) {
    const key = `${value.class}\u0000${value.disposition}`;
    grouped.set(key, {
      ...value,
      count: (grouped.get(key)?.count ?? 0) + value.count,
    });
  }
  return Object.freeze(
    [...grouped.values()].sort(
      (left, right) =>
        compareCodeUnitStrings(left.class, right.class) ||
        compareCodeUnitStrings(left.disposition, right.disposition),
    ),
  );
}

export function transformSourceArtifacts(
  source: ValidatedDerivationSource,
  extraction: SurfaceExtraction,
  results: ReadonlyMap<string, SurfaceDispositionResult>,
  policy: DerivationPolicy,
): ArtifactTransformationSet {
  const retained: PublishableArtifact[] = [];
  const derived: DerivedArtifact[] = [];
  const withheld: WithheldArtifact[] = [];
  const allCounts: DispositionCount[] = [];
  let taskDerived = false;
  let resultDerived = false;

  for (const entityId of [...source.roles.keys()].sort()) {
    const entity = source.entities.get(entityId);
    const sha = typeof entity?.sha256 === "string" ? entity.sha256 : "";
    const sourceDigest = `sha256:${sha}` as DerivationSha256Digest;
    const mediaType =
      typeof entity?.encodingFormat === "string"
        ? entity.encodingFormat
        : "application/octet-stream";
    const role = source.roles.get(entityId) ?? "other";
    const rule = ruleFor(policy, mediaType, role);
    const codec: ArtifactCodec | undefined = rule?.codec;
    const sourceBytes = source.artifacts.get(entityId);
    if (!sourceBytes) {
      if (
        rule?.unavailable === "withhold-record" ||
        (!rule && policy.defaultArtifactDisposition === "withhold-record")
      ) {
        return {
          status: "withhold-record",
          reasons: [{ code: "unavailable-artifact" }],
        };
      }
      withheld.push({
        entityId,
        digest: sourceDigest,
        reason: "unavailable",
      });
      continue;
    }
    const surfaces = extraction.surfaces.filter(
      (surface) =>
        surface.sourceEntityId === entityId &&
        surface.surfaceId.startsWith("artifact:"),
    );
    const surfaceResults = surfaces.map((surface) => ({
      surface,
      result: results.get(surface.surfaceId),
    }));
    if (
      surfaceResults.some(({ result }) => result?.status === "review-required")
    ) {
      return { status: "review-required" };
    }
    const recordHold = surfaceResults.find(
      ({ result }) => result?.status === "withhold-record",
    )?.result;
    if (recordHold?.status === "withhold-record") return recordHold;
    const artifactHold = surfaceResults.some(
      ({ result }) => result?.status === "withhold-artifact",
    );
    for (const { result } of surfaceResults) {
      if (
        result &&
        (result.status === "retained" ||
          result.status === "redacted" ||
          result.status === "withhold-artifact")
      ) {
        allCounts.push(...result.counts);
      }
    }
    if (artifactHold) {
      withheld.push({
        entityId,
        digest: sourceDigest,
        reason: "policy-withheld",
      });
      continue;
    }
    if (!codec) {
      if (policy.defaultArtifactDisposition === "withhold-record") {
        return {
          status: "withhold-record",
          reasons: [{ code: "unsupported-artifact" }],
        };
      }
      withheld.push({
        entityId,
        digest: sourceDigest,
        reason: "policy-withheld",
      });
      continue;
    }
    const replacements = new Map(
      surfaceResults.flatMap(({ surface, result }) =>
        result?.status === "redacted"
          ? [[surface.location, result.text] as const]
          : [],
      ),
    );
    let bytes: Uint8Array;
    if (codec === "text") {
      const replacement = surfaceResults.find(
        ({ result }) => result?.status === "redacted",
      )?.result;
      bytes = transformTextBytes(
        sourceBytes,
        replacement?.status === "redacted" ? replacement.text : undefined,
      );
    } else if (codec === "json") {
      bytes = transformJsonBytes(sourceBytes, replacements);
    } else if (codec === "jsonl") {
      bytes = transformJsonlBytes(sourceBytes, replacements);
    } else {
      bytes = copyBytes(sourceBytes);
    }
    const digest = sha256Digest(bytes);
    if (digest === sourceDigest) {
      retained.push({ entityId, digest, bytes, kind: "retained" });
      continue;
    }
    if (role === "result" && policy.resultTransform === "withhold-record") {
      return {
        status: "withhold-record",
        reasons: [{ code: "result-transform-withheld" }],
      };
    }
    const entityIdDerived = `derived/${sourceDigest.slice(7)}/${digest.slice(7)}`;
    derived.push({
      sourceEntityId: entityId,
      sourceDigest,
      entityId: entityIdDerived,
      digest,
      mediaType,
      bytes,
    });
    if (role === "task") taskDerived = true;
    if (role === "result") resultDerived = true;
  }
  retained.sort((left, right) => compareCodeUnitStrings(left.entityId, right.entityId));
  derived.sort(
    (left, right) =>
      compareCodeUnitStrings(left.sourceEntityId, right.sourceEntityId) ||
      compareCodeUnitStrings(left.digest, right.digest),
  );
  withheld.sort((left, right) => compareCodeUnitStrings(left.entityId, right.entityId));
  return {
    status: "transformed",
    retained: Object.freeze(retained),
    derived: Object.freeze(derived),
    withheld: Object.freeze(withheld),
    counts: combineCounts(allCounts),
    bindingImpact: {
      executionVerification: "not-transferred-to-derived-record",
      resultEvaluation:
        taskDerived || resultDerived
          ? "not-transferable-to-derived-subject"
          : "preserved-for-exact-subjects",
      taskDerived,
      resultDerived,
    },
  };
}
