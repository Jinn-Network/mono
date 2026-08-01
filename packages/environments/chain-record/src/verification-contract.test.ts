import { describe, expect, test } from "vitest";

import { MINIMUM_VERIFICATION_RUNS, VerificationContractSchema } from "./verification-contract.js";

const contract = () => ({
  probeSuite: {
    descriptor: { name: "probes", digest: { sha256: "5".repeat(64) } },
    format: { id: "jinn.chain-probes", version: "1" },
  },
  observationSchema: { name: "observation.schema.json", digest: { sha256: "6".repeat(64) } },
  baselineObservationDigest: `sha256:${"7".repeat(64)}`,
  comparator: { id: "canonical-observation-eq", version: "1.0.0", digest: `sha256:${"8".repeat(64)}` },
  closureCheckRequired: true,
  resetRequirements: { freshInstancePerRun: true, minimumRuns: 5 },
  fixtureProbeCoverage: [
    { fixtureId: "accounts", probeIds: ["balances"] },
    { fixtureId: "rates", probeIds: ["rate-read", "rate-write"] },
  ],
  policyId: "jinn.chain-verification-policy/1",
});

const parse = (document: unknown) => VerificationContractSchema.safeParse(document);

describe("verification contract (§4.3, §5.1)", () => {
  test("accepts a contract at the K floor", () => {
    expect(parse(contract()).success).toBe(true);
  });

  test("K inherits the parent floor of five (E4)", () => {
    expect(MINIMUM_VERIFICATION_RUNS).toBe(5);
    expect(parse({ ...contract(), resetRequirements: { freshInstancePerRun: true, minimumRuns: 4 } }).success)
      .toBe(false);
    expect(parse({ ...contract(), resetRequirements: { freshInstancePerRun: true, minimumRuns: 9 } }).success)
      .toBe(true);
  });

  test("refuses a contract that would accept snapshot cycles as repetition", () => {
    expect(
      parse({ ...contract(), resetRequirements: { freshInstancePerRun: false, minimumRuns: 5 } }).success,
    ).toBe(false);
  });

  test("results never live in the record: an outcome field is refused", () => {
    expect(parse({ ...contract(), lastOutcome: "closed-reproducible" }).success).toBe(false);
  });

  test("refuses duplicate fixture ids in the probe-coverage declaration", () => {
    const document = contract();
    document.fixtureProbeCoverage.push({ fixtureId: "accounts", probeIds: ["again"] });
    expect(parse(document).success).toBe(false);
  });

  test("every declared fixture must name at least one probe", () => {
    const document = contract();
    document.fixtureProbeCoverage[0].probeIds = [];
    expect(parse(document).success).toBe(false);
  });

  test("the baseline observation digest is a record-body digest, not a bare DigestSet value", () => {
    expect(parse({ ...contract(), baselineObservationDigest: "7".repeat(64) }).success).toBe(false);
  });
});
