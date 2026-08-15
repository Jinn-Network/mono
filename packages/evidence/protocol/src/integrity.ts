import { recordDigest, sha256Hex } from "./hashing.js";
import type { ExecutionEvidenceDocument } from "./schemas.js";
import type {
  ArtifactIntegrityEntry,
  ArtifactIntegrityReport,
} from "./types.js";
import { compareCodeUnitStrings } from "./order.js";

const SHA256 = /^[a-f0-9]{64}$/;

export function checkArtifactIntegrity(
  document: ExecutionEvidenceDocument,
  availableArtifacts: ReadonlyMap<string, Uint8Array>,
): ArtifactIntegrityReport {
  const artifacts: ArtifactIntegrityEntry[] = document["@graph"]
    .filter(
      (entity) =>
        typeof entity.sha256 === "string" && SHA256.test(entity.sha256),
    )
    .map((entity) => {
      const expectedDigest = `sha256:${entity.sha256}` as const;
      const bytes = availableArtifacts.get(entity["@id"]);
      if (!bytes) {
        return {
          entityId: entity["@id"],
          expectedDigest,
          status: "unavailable" as const,
        };
      }
      const actualHex = sha256Hex(bytes);
      const actualDigest = recordDigest(bytes);
      return {
        entityId: entity["@id"],
        expectedDigest,
        status:
          actualHex === entity.sha256
            ? ("verified" as const)
            : ("mismatch" as const),
        actualDigest,
      };
    })
    .sort((left, right) => compareCodeUnitStrings(left.entityId, right.entityId));

  return {
    artifacts,
    verified: artifacts.filter(({ status }) => status === "verified").length,
    mismatched: artifacts.filter(({ status }) => status === "mismatch").length,
    unavailable: artifacts.filter(({ status }) => status === "unavailable")
      .length,
  };
}
