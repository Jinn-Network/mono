// SPDX-License-Identifier: Apache-2.0

import { IN_TOTO_STATEMENT_TYPE, type Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } from "./identifiers.js";
import {
  attestationMatchesRecord,
  buildChainEnvironmentVerificationStatement,
  buildCryptoEnvironmentVerificationStatement,
  parseChainEnvironmentVerificationStatement,
  requiresComponentAttestations,
} from "./statement.js";
import { buildChainEnvironmentVerificationSubjects } from "./subject.js";
// `closedPredicate()` and `compositePredicate()` are local builders in this file; they mirror
// the T5 fixture rather than importing it.
import { closedPredicate, compositePredicate } from "./statement.fixtures.js";

const RECORD = `sha256:${"1".repeat(64)}` as Sha256Digest;
const ARTIFACT = `sha256:${"2".repeat(64)}` as Sha256Digest;
const COMPOSITE = `sha256:${"3".repeat(64)}` as Sha256Digest;
const CHAIN_WORLD = `sha256:${"4".repeat(64)}` as Sha256Digest;

describe("subjects", () => {
  it("emits bare-hex DigestSet values in a fixed order", () => {
    const subjects = buildChainEnvironmentVerificationSubjects({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
    });
    expect(subjects).toEqual([
      { name: "environment", digest: { sha256: "1".repeat(64) } },
      { name: "state-artifact", digest: { sha256: "2".repeat(64) } },
    ]);
  });

  it("drops the artifact subject when the record commits no state artifact", () => {
    const subjects = buildChainEnvironmentVerificationSubjects({ recordDigest: RECORD });
    expect(subjects).toEqual([{ name: "environment", digest: { sha256: "1".repeat(64) } }]);
  });

  it("refuses a prefixed digest in a DigestSet position", () => {
    expect(() => buildChainEnvironmentVerificationSubjects({
      recordDigest: "1".repeat(64) as Sha256Digest,
    })).toThrow(ChainVerificationError);
  });
});

describe("statement", () => {
  it("assembles a component statement", () => {
    const statement = buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
      predicate: closedPredicate(),
    });
    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE);
    expect(statement.predicate.scope).toBe("component");
    expect(parseChainEnvironmentVerificationStatement(statement)).toEqual(statement);
  });

  it("refuses a component statement whose predicate claims composite scope", () => {
    expect(() => buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
      predicate: compositePredicate({ chainWorld: CHAIN_WORLD }),
    })).toThrow(ChainVerificationError);
  });

  it("matches only the record subject, never the artifact subject", () => {
    const statement = buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
      predicate: closedPredicate(),
    });
    expect(attestationMatchesRecord(statement, RECORD)).toBe(true);
    // Two records can share one state artifact. Any-subject matching would extend a narrow
    // claim to a record this attestation never covered.
    expect(attestationMatchesRecord(statement, ARTIFACT)).toBe(false);
  });

  it("assembles a composite statement whose subjects cannot satisfy a component match", () => {
    const statement = buildCryptoEnvironmentVerificationStatement({
      compositeDigest: COMPOSITE,
      chainWorldDigest: CHAIN_WORLD,
      predicate: compositePredicate({ chainWorld: CHAIN_WORLD }),
    });
    expect(statement.subject.map((subject) => subject.name))
      .toEqual(["crypto-environment", "chain-world"]);
    expect(attestationMatchesRecord(statement, COMPOSITE)).toBe(true);
    // The never-substitutes rule (design §5.1 step 6), mechanically.
    expect(attestationMatchesRecord(statement, CHAIN_WORLD)).toBe(false);
  });

  it("lists the component records whose own attestations a consumer must still obtain", () => {
    const statement = buildCryptoEnvironmentVerificationStatement({
      compositeDigest: COMPOSITE,
      chainWorldDigest: CHAIN_WORLD,
      predicate: compositePredicate({ chainWorld: CHAIN_WORLD }),
    });
    expect(requiresComponentAttestations(statement)).toEqual([CHAIN_WORLD]);
    // A component statement requires nothing further of the consumer.
    expect(requiresComponentAttestations(buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      predicate: closedPredicate(),
    }))).toEqual([]);
  });
});
