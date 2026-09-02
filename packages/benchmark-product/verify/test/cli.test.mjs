import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function invoke(args) {
  try {
    return await exec(process.execPath, [bin, ...args]);
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

test("usage exits 2 and states the exit contract", async () => {
  const result = await invoke([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Exit 0: valid bundle; 1: invalid bundle, or a freeze repository that drifted/);
  // A bundle that cannot be rendered as a freeze repository is not an invalid bundle, and the
  // usage text has to say which exit code that is.
  assert.match(result.stderr, /could not be\n {5}rendered from the bundle/);
  // Issue #2981: the disclosure survives, the unresolvable origin does not. A reader is still
  // told the identifiers are not fetched, without being handed a host to try.
  assert.match(result.stderr, /Protocol identifiers are names, not addresses/);
  assert.match(result.stderr, /platform bytes installed from npm/);
  assert.doesNotMatch(result.stderr, /jinn\.network/);
  assert.doesNotMatch(result.stderr, /not hosted/);
});

test("a missing bundle exits 1 with machine-readable invalid-bundle output", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "colophon-verify-")), "missing");
  const result = await invoke([missing, "--json"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    verifierVersion: "0.2.1",
    supportedFormats: [
      "benchmark-product-public-bundle/2",
      "benchmark-product-public-bundle/4",
      "benchmark-product-public-bundle/5",
      "benchmark-product-public-bundle/6",
      "benchmark-product-public-bundle/7",
      "benchmark-product-public-bundle/8",
    ],
    code: "record-integrity",
    message: "bundle directory is missing",
  });
});

test("human success names all six checks and states the verification limit", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/4",
    identity: "a".repeat(64),
    checks: [
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ],
    benchmarkSha256: "b".repeat(64),
    runSha256: "c".repeat(64),
    matrixSha256: "d".repeat(64),
    reportSha256: "e".repeat(64),
    reportEnvelopeSha256: "f".repeat(64),
  });
  assert.match(output, /^Verified: 6 of 6 checks passed/m);
  const orderedChecks = ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"];
  for (const check of orderedChecks) {
    assert.match(output, new RegExp(`${check}\\s+passed`));
  }
  assert.deepEqual(orderedChecks.map((check) => output.indexOf(check)), [...orderedChecks.map((check) => output.indexOf(check))].sort((a, b) => a - b));
  assert.match(output, /Format: benchmark-product-public-bundle\/4/);
  assert.match(output, /does not prove that the machine that produced the/);
  assert.match(output, /No files were uploaded/);
  assert.match(output, /Protocol identifiers are names, not addresses/);
  assert.match(output, /platform bytes installed from npm/);
  assert.doesNotMatch(output, /jinn\.network/);
  assert.doesNotMatch(output, /not hosted/);
});

test("human summary reports the actual passed count against the fixed six-check catalog", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/2",
    identity: "a".repeat(64),
    checks: ["manifest"],
    benchmarkSha256: "b".repeat(64), runSha256: "c".repeat(64), matrixSha256: "d".repeat(64),
    reportSha256: "e".repeat(64), reportEnvelopeSha256: "f".repeat(64),
  });
  assert.match(output, /^Verified: 1 of 6 checks passed/m);
  assert.match(output, /Format: benchmark-product-public-bundle\/2/);
});

const V6_IDENTITIES = {
  benchmarkSha256: "b".repeat(64),
  runSha256: "c".repeat(64),
  matrixSha256: "d".repeat(64),
  reportSha256: "e".repeat(64),
  reportEnvelopeSha256: "f".repeat(64),
};
const V6_CHECKS = [
  "manifest", "evidence-closure", "trust", "matrix-rederivation",
  "report-verification", "claim-consistency", "integrity-anchors",
];

test("the default human surface discloses every carried anchor and every subject outcome", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/6",
    identity: "a".repeat(64),
    checks: V6_CHECKS,
    ...V6_IDENTITIES,
    anchors: {
      anchors: [
        {
          recordSha256: "1".repeat(64),
          status: "present",
          provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
          subject: "lock",
          timeBasis: "authority-time",
          facts: { genTime: "2026-01-01T12:00:00Z", policyOid: "2.999.1", serialNumber: "0a", signerCertificateSha256: "9".repeat(64) },
          trustMaterial: "none",
        },
        {
          recordSha256: "2".repeat(64),
          status: "verified",
          provider: "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1",
          subject: "matrix",
          timeBasis: "chain-time",
          time: "2026-08-17T12:00:00Z",
          facts: { blockHeight: 880017 },
          trustMaterial: "supplied",
        },
        // Material was supplied for this profile and still did not carry the anchor to `verified`
        // — a root that does not chain, say. Disclosing "no trust material supplied" here would
        // state the opposite of what this reader did.
        {
          recordSha256: "4".repeat(64),
          status: "present",
          provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
          subject: "lock",
          timeBasis: "authority-time",
          facts: { genTime: "2026-02-02T12:00:00Z", policyOid: "2.999.1", serialNumber: "0b", signerCertificateSha256: "8".repeat(64) },
          trustMaterial: "supplied",
        },
      ],
      subjects: [
        { subject: "lock", outcome: "anchored" },
        { subject: "matrix", outcome: "anchored" },
      ],
      invalid: [],
    },
  });
  assert.match(output, /^Verified: 7 of 7 checks passed/m);
  assert.match(output, /integrity-anchors\s+passed/);
  // Each carried anchor: subject, time basis, status, and its byte-embedded time or height.
  assert.match(output, /lock anchor · authority-time · present · 2026-01-01T12:00:00Z/);
  assert.match(output, /time basis not evaluated: no trust material supplied/);
  // Supplied-but-unverifying is disclosed as itself, never as "no trust material supplied".
  assert.match(output, /lock anchor · authority-time · present · 2026-02-02T12:00:00Z/);
  assert.match(output, /time basis not evaluated: the trust material you supplied does not verify this anchor/);
  assert.match(output, /matrix anchor · chain-time · verified · block 880017/);
  assert.match(output, /time basis evaluated against trust material you supplied — 2026-08-17T12:00:00Z/);
  // An authority-time proof whose evaluated instant is the genTime already on the head line does
  // not repeat it.
  assert.doesNotMatch(output, /supplied — 2026-01-01T12:00:00Z/);
  assert.match(output, new RegExp(`record ${"1".repeat(64)}`));
  assert.match(output, /Anchor subjects\n {2}lock: anchored\n {2}matrix: anchored/);
  assert.match(output, /An anchor dates the bytes it covers and says nothing/);
  assert.match(output, /not\s+that results were produced after it/);
});

test("the default human surface names an absent and a declared-but-absent subject explicitly", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/6",
    identity: "a".repeat(64),
    checks: V6_CHECKS,
    ...V6_IDENTITIES,
    anchors: {
      anchors: [],
      subjects: [
        {
          subject: "lock",
          outcome: "declared-but-absent",
          declaredProfiles: ["https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1"],
        },
        { subject: "matrix", outcome: "absent" },
      ],
      invalid: [],
    },
  });
  assert.match(output, /no anchor records carried/);
  // Exact, not `.*`-absorbed: the profile is rendered by its own path with the namespace host
  // dropped, so a regression in `anchorProfileName` has to fail here (issue #3723).
  assert.match(output, /lock: declared-but-absent — this run declared rfc3161-tsa\/v1 and the bundle carries no matching anchor/);
  assert.doesNotMatch(output, /jinn\.network/);
  assert.match(output, /matrix: absent — no anchor was carried and none was declared/);
});

test("a pending anchor prints its own status and reason, never a completed one's", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/6",
    identity: "a".repeat(64),
    checks: V6_CHECKS,
    ...V6_IDENTITIES,
    anchors: {
      anchors: [{
        recordSha256: "3".repeat(64),
        status: "pending",
        provider: "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1",
        subject: "lock",
        timeBasis: "chain-time",
        reason: "the proof carries only calendar promises",
        trustMaterial: "none",
      }],
      subjects: [{ subject: "lock", outcome: "anchored" }, { subject: "matrix", outcome: "absent" }],
      invalid: [],
    },
  });
  assert.match(output, /lock anchor · chain-time · pending\n/);
  assert.match(output, /the proof carries only calendar promises/);
  assert.doesNotMatch(output, /block \d/);
});

test("an unanchored bundle's human surface is unchanged — no anchor section at all", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/2",
    identity: "a".repeat(64),
    checks: ["manifest"],
    ...V6_IDENTITIES,
  });
  assert.doesNotMatch(output, /Anchors/);
  assert.doesNotMatch(output, /Anchor subjects/);
  assert.doesNotMatch(output, /An anchor dates the bytes/);
});

test("usage documents the trust-material flags and that none ships", async () => {
  const result = await invoke([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--tsa-root/);
  assert.match(result.stderr, /--ots-headers/);
  assert.match(result.stderr, /none ships with this tool/);
});

test("the trust-material flags reach the verifier; a malformed header file exits 2", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const encoder = new TextEncoder();
  const files = new Map([
    ["root.der", Uint8Array.of(0x30, 0x82, 0x01, 0x02)],
    ["headers.txt", encoder.encode("# comment\n880017:" + "ab".repeat(80) + "\n")],
    ["broken.txt", encoder.encode("not-a-header\n")],
  ]);
  let seen;
  const ok = await runVerifierCli(
    ["bundle", "--json", "--tsa-root", "root.der", "--ots-headers", "headers.txt"],
    {
      readFile: (path) => files.get(path),
      verify: async (_dir, options) => {
        seen = options;
        return { format: "benchmark-product-public-bundle/6", identity: "a".repeat(64), checks: V6_CHECKS, ...V6_IDENTITIES };
      },
    },
  );
  assert.equal(ok.exitCode, 0);
  assert.equal(seen.anchorTrust.rfc3161.trustAnchorsDer.length, 1);
  assert.deepEqual([...seen.anchorTrust.opentimestamps.blockHeaders].map((entry) => entry.height), [880017]);
  assert.equal(seen.anchorTrust.opentimestamps.blockHeaders[0].header.length, 80);

  const broken = await runVerifierCli(["bundle", "--ots-headers", "broken.txt"], {
    readFile: (path) => files.get(path),
    verify: async () => { throw new Error("must not be reached"); },
  });
  assert.equal(broken.exitCode, 2);
  assert.match(broken.stderr, /expected "<height>:<160 hex characters>"/);

  // No flags means no material, and the verifier is told so by omission rather than by an empty set.
  const bare = await runVerifierCli(["bundle", "--json"], {
    readFile: () => { throw new Error("must not be reached"); },
    verify: async (_dir, options) => {
      seen = options;
      return { format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES };
    },
  });
  assert.equal(bare.exitCode, 0);
  assert.deepEqual(seen, {});
});

test("a PEM trust anchor file is decoded into one DER root per block", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const der = Buffer.from([0x30, 0x82, 0x01, 0x02, 0x03, 0x04]);
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`;
  let seen;
  const result = await runVerifierCli(["bundle", "--json", "--tsa-root", "roots.pem"], {
    readFile: () => new TextEncoder().encode(pem + pem),
    verify: async (_dir, options) => {
      seen = options;
      return { format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(seen.anchorTrust.rfc3161.trustAnchorsDer.length, 2);
  assert.deepEqual(Buffer.from(seen.anchorTrust.rfc3161.trustAnchorsDer[0]), der);
});

test("a flag missing its value exits 2 with usage", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const args of [["bundle", "--tsa-root"], ["bundle", "--ots-headers", "--json"], ["bundle", "--unknown"]]) {
    const result = await runVerifierCli(args, { verify: async () => { throw new Error("must not be reached"); } });
    assert.equal(result.exitCode, 2, args.join(" "));
    assert.match(result.stderr, /Usage: colophon-verify/);
  }
});

test("human summary names all seven evidence-native checks for bundle v5", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/5",
    identity: `sha256:${"a".repeat(64)}`,
    checks: [
      "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
      "matrix-rederivation", "report-verification", "claim-consistency",
    ],
    benchmarkDigest: `sha256:${"b".repeat(64)}`,
    manifestDigest: `sha256:${"c".repeat(64)}`,
    cohortDigest: `sha256:${"d".repeat(64)}`,
    matrixDigest: `sha256:${"e".repeat(64)}`,
    reportDigest: `sha256:${"f".repeat(64)}`,
    evidenceRecords: 336,
    artifacts: 300,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    artifactContent: { status: "verified", verified: 300, notFetched: 0, notFetchedDigests: [] },
  });
  assert.match(output, /^Verified: 7 of 7 checks passed/m);
  assert.match(output, new RegExp(`Bundle: sha256:${"a".repeat(64)}`));
  assert.doesNotMatch(output, /sha256:sha256:/);
});

test("the anchored qualification closure counts its seven checks, not the unanchored six (#3205)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/7",
    identity: "a".repeat(64),
    checks: V6_CHECKS,
    ...V6_IDENTITIES,
    qualification: {
      publicationGrade: false,
      truthAdmission: "operator-only",
      candidateClasses: ["factuality"],
      strata: ["core"],
      armCount: 4,
      itemCount: 12,
      exclusionCount: 0,
    },
    anchors: {
      anchors: [{
        recordSha256: "1".repeat(64),
        status: "present",
        provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
        subject: "lock",
        timeBasis: "authority-time",
        facts: { genTime: "2026-01-01T12:00:00Z", policyOid: "2.999.1", serialNumber: "0a", signerCertificateSha256: "9".repeat(64) },
        trustMaterial: "none",
      }],
      subjects: [{ subject: "lock", outcome: "anchored" }, { subject: "matrix", outcome: "absent" }],
      invalid: [],
    },
  });
  assert.match(output, /^Verified: 7 of 7 checks passed/m);
  assert.match(output, /^Format: benchmark-product-public-bundle\/7$/m);
  assert.match(output, /integrity-anchors\s+passed/);
  assert.match(output, /lock anchor · authority-time · present · 2026-01-01T12:00:00Z/);
});

const SIGNERS = [
  { role: "publisher", identity: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX", keyId: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX", custody: "same-operator" },
  { role: "automated-grader", identity: "urn:jinn:benchmark-product:local-venue:evaluator-1", keyId: "benchmark-product-verdict-dc8dbb6d84571890", custody: "same-operator" },
  { role: "automated-grader", identity: "urn:jinn:benchmark-product:local-venue:evaluator-2", keyId: "benchmark-product-verdict-0f2ac1bb9e334410", custody: "same-operator" },
  { role: "human-reviewer", identity: "urn:evaluator:reviewer-1", keyId: "benchmark-product-verdict-77aa11bb22cc33dd", custody: "same-operator" },
  { role: "label-admission", identity: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX", keyId: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX", custody: "same-operator" },
];

test("the human surface names signer roles in plain words and prints no raw identifier", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/4",
    identity: "a".repeat(64),
    checks: ["manifest"],
    ...V6_IDENTITIES,
    signers: SIGNERS,
  });
  assert.match(output, /\nSigned by\n/);
  assert.match(output, /^ {2}publisher · 1 key$/m);
  assert.match(output, /^ {2}automated grader — same operator · 2 keys$/m);
  assert.match(output, /^ {2}human reviewer — same operator · 1 key$/m);
  assert.match(output, /^ {2}label admission — same operator · 1 key$/m);
  assert.doesNotMatch(output, /urn:/);
  assert.doesNotMatch(output, /did:key/);
  // The publisher is the operator; "same operator" would say nothing about it.
  assert.doesNotMatch(output, /publisher — same operator/);
});

test("an undeclared-custody signer set prints the role alone", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/5",
    identity: `sha256:${"a".repeat(64)}`,
    checks: ["manifest"],
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    artifactContent: { status: "verified", verified: 0, notFetched: 0, notFetchedDigests: [] },
    signers: [
      { role: "publisher", identity: "urn:report:1", keyId: "k1", custody: "undeclared" },
      { role: "automated-grader", identity: "urn:evaluator:1", keyId: "k2", custody: "undeclared" },
    ],
  });
  assert.match(output, /^ {2}automated grader — custody not declared · 1 key$/m);
  // The publisher is the operator the others are measured against, so it takes no custody suffix.
  assert.match(output, /^ {2}publisher · 1 key$/m);
  assert.doesNotMatch(output, /same operator/);
  assert.doesNotMatch(output, /urn:/);
});

test("a result without signers keeps the previous human surface", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/2",
    identity: "a".repeat(64),
    checks: ["manifest"],
    ...V6_IDENTITIES,
  });
  assert.doesNotMatch(output, /Signed by/);
});

test("the golden bundle's default output carries no identifier while --json carries every one", async () => {
  const golden = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1/golden", import.meta.url));
  const human = await invoke([golden]);
  assert.equal(human.code, undefined);
  assert.doesNotMatch(human.stdout, /urn:/);
  assert.doesNotMatch(human.stdout, /did:key/);
  assert.match(human.stdout, /\nSigned by\n {2}publisher · 1 key\n {2}automated grader — same operator · 1 key\n/);

  const json = await invoke([golden, "--json"]);
  assert.equal(json.code, undefined);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.signers, [
    {
      role: "publisher",
      identity: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX",
      keyId: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX",
      custody: "same-operator",
    },
    {
      role: "automated-grader",
      identity: "urn:jinn:benchmark-product:local-venue:evaluator-1",
      keyId: "benchmark-product-verdict-dc8dbb6d84571890",
      custody: "same-operator",
    },
  ]);
});

test("a refusal says what failed without printing the identifier it refused", async () => {
  const tampered = fileURLToPath(
    new URL("../fixtures/public-bundle-conformance-v1/tampered/report-payload-edited", import.meta.url),
  );
  const human = await invoke([tampered]);
  assert.equal(human.code, 1);
  assert.match(human.stderr, /report-authenticity: no valid signer binds to author\/scope\/time/);
  assert.match(human.stderr, /envelope-signature-invalid/);
  assert.match(human.stderr, /<identifier: see --json>/);
  assert.doesNotMatch(human.stderr, /did:key/);
  assert.doesNotMatch(human.stderr, /urn:/);

  const json = await invoke([tampered, "--json"]);
  assert.equal(json.code, 1);
  assert.match(JSON.parse(json.stdout).message, /did:key:z[1-9A-HJ-NP-Za-km-z]+:envelope-signature-invalid/);
});

const V5_CHECKS = [
  "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
  "matrix-rederivation", "report-verification", "claim-consistency",
];

const V5_RESULT = {
  format: "benchmark-product-public-bundle/5",
  identity: `sha256:${"a".repeat(64)}`,
  checks: V5_CHECKS,
  benchmarkDigest: `sha256:${"b".repeat(64)}`,
  manifestDigest: `sha256:${"c".repeat(64)}`,
  cohortDigest: `sha256:${"d".repeat(64)}`,
  matrixDigest: `sha256:${"e".repeat(64)}`,
  reportDigest: `sha256:${"f".repeat(64)}`,
  evidenceRecords: 12,
  artifacts: 5,
  verifiedSignerKeyIds: [],
};

test("a full-evidence v5 bundle prints all seven checks as passed", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    artifactContent: { status: "verified", verified: 5, notFetched: 0, notFetchedDigests: [] },
  });
  assert.match(output, /^Verified: 7 of 7 checks passed$/m);
  for (const check of V5_CHECKS) assert.match(output, new RegExp(`${check}\\s+passed`));
  assert.doesNotMatch(output, /not fetched/);
  assert.doesNotMatch(output, /Artifact content/);
});

test("a metadata-first v5 bundle discloses artifact-integrity as not fetched", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
    artifactContent: {
      status: "not-fetched",
      verified: 2,
      notFetched: 3,
      notFetchedDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    },
  });
  // The deferred check is never printed as a pass and never folded into the passed total.
  assert.match(output, /^Verified: 6 of 7 checks passed, 1 not fetched$/m);
  assert.match(output, /artifact-integrity\s+not fetched/);
  for (const check of V5_CHECKS.filter((check) => check !== "artifact-integrity")) {
    assert.match(output, new RegExp(`${check}\\s+passed`));
  }
  assert.match(output, /Artifact content/);
  assert.match(output, /3 artifact bodies were not fetched/);
  // Naming the digests is what makes the deferred check completable.
  assert.match(output, new RegExp(`sha256:${"1".repeat(64)}`));
  assert.match(output, new RegExp(`sha256:${"3".repeat(64)}`));
  // Adding a body to the directory breaks the manifest closure, so it must not be advised.
  assert.doesNotMatch(output, /Fetch each one into/);
  assert.match(output, /verify the\s*\n\s*full-evidence bundle/);
  assert.match(output, /artifact\s*\ncontents themselves were not read/);
});

test("a metadata-first bundle with one deferred body says body, not bodies", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
    artifactContent: {
      status: "not-fetched",
      verified: 2,
      notFetched: 1,
      notFetchedDigests: ["1".repeat(64)],
    },
  });
  assert.match(output, /1 artifact body was not fetched/);
});

/**
 * Issue #2981. The internal protocol namespaces a reader cannot resolve: the record/profile `$id`
 * host, the named-method registry, and the extension-key namespace. Kept here rather than imported
 * so the guard is written from the reader's side and cannot drift with the constant it guards.
 */
const INTERNAL_NAMESPACE = /jinn\.network|jinn\.benchmarking\.|urn:|did:key/;

test("the golden bundle's human surface names no internal protocol namespace", async () => {
  const golden = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1/golden", import.meta.url));
  const human = await invoke([golden]);
  assert.equal(human.code, undefined);
  assert.doesNotMatch(human.stdout, INTERNAL_NAMESPACE);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);
});

test("no tampered variant's refusal names an internal protocol namespace", async () => {
  // The injected refusal below proves the alias; this proves the coverage. Every refusal the
  // conformance corpus can actually produce goes through the human surface, so a message that
  // starts naming a `$id`, a `urn:`, or a method id fails here rather than in a reader's terminal.
  const tamperedDir = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1/tampered", import.meta.url));
  // Directories only: a stray file dropped into the corpus is not a variant, and walking it would
  // satisfy the refusal assertion without covering anything (issue #3723).
  const variants = (await readdir(tamperedDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(variants.length > 0, "the tampered corpus is empty");
  for (const variant of variants) {
    const refused = await invoke([join(tamperedDir, variant)]);
    assert.notEqual(refused.code, undefined, `${variant} was not refused`);
    assert.doesNotMatch(refused.stderr, INTERNAL_NAMESPACE, `${variant} stderr`);
    assert.doesNotMatch(refused.stdout, INTERNAL_NAMESPACE, `${variant} stdout`);
  }
});

test("a refusal naming a record kind aliases it on the human surface and keeps it in --json", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  // The real shape of `profile/disclosure.ts` and `anchor/check.ts` refusals: the message names the
  // record kind, which is a `spec.jinn.network` URI. Injected through the CLI's own verify seam so
  // the assertion runs over the string the reader actually receives.
  const kind = "https://spec.jinn.network/records/benchmark-matrix/v1";
  const deps = {
    verify: () => {
      const error = new Error(`disclosure-specification: the record's subject kind must be ${kind}`);
      error.code = "record-integrity";
      return Promise.reject(error);
    },
  };

  const human = await runVerifierCli(["bundle"], deps);
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /the record's subject kind must be/);
  assert.match(human.stderr, /<identifier: see --json>/);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);

  const json = await runVerifierCli(["bundle", "--json"], deps);
  assert.equal(json.exitCode, 1);
  assert.equal(JSON.parse(json.stdout).message, `disclosure-specification: the record's subject kind must be ${kind}`);
});

test("a kind-mismatch refusal still reads as a contrast after aliasing", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  // `anchor/check.ts`'s kind-mismatch refusal is the one message whose whole content is the
  // CONTRAST between two values. Rendering both as `spec.jinn.network` kinds made the human
  // surface print the same alias twice and assert that they differ (issue #3723), so the resolved
  // side is a plain noun the sanitizer never touches.
  const declared = "https://spec.jinn.network/records/benchmark-matrix/v1";
  const deps = {
    verify: () => {
      const error = new Error(
        "carried anchor is invalid: subject.kind is "
        + `${declared}, but its digest resolves to this bundle's sealed Run`,
      );
      error.code = "record-integrity";
      return Promise.reject(error);
    },
  };

  const human = await runVerifierCli(["bundle"], deps);
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /but its digest resolves to this bundle's sealed Run/);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);
  // Exactly one alias: the refused value. A second one would mean the contrast was erased.
  assert.equal(human.stderr.match(/<identifier: see --json>/gu)?.length, 1);

  const json = await runVerifierCli(["bundle", "--json"], deps);
  assert.match(JSON.parse(json.stdout).message, new RegExp(declared.replaceAll(".", "\\.")));
});

test("a freeze-repo failure keeps its message verbatim in --json and aliases it on stderr", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  // The alias exists so a reader is not handed an address; inside `--json` it would be
  // self-referential, and the identifier would be recoverable from no surface at all (issue #3723).
  const kind = "https://spec.jinn.network/records/benchmark-matrix/v1";
  const deps = {
    verify: () => Promise.resolve({
      format: "benchmark-product-public-bundle/2",
      identity: "a".repeat(64),
      checks: ["manifest"],
    }),
    verifyFreezeRepo: () => {
      const error = new Error(`freeze-repo-render: no licence declared for ${kind}`);
      error.code = "freeze-repo-render";
      return Promise.reject(error);
    },
  };

  const json = await runVerifierCli(["bundle", "--json", "--freeze-repo", "repo"], deps);
  assert.equal(json.exitCode, 2);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.freezeRepo.ok, false);
  assert.equal(payload.freezeRepo.message, `freeze-repo-render: no licence declared for ${kind}`);

  const human = await runVerifierCli(["bundle", "--freeze-repo", "repo"], deps);
  assert.equal(human.exitCode, 2);
  assert.match(human.stderr, /freeze repository not checked: /);
  assert.match(human.stderr, /<identifier: see --json>/);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);
});

test("a URL a reader can actually open survives the human surface", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  // Only our own unresolvable origins are aliased. An anchoring calendar or a licence URL is
  // something a reader can act on, so aliasing it would remove the only actionable thing in the line.
  const calendar = "https://alice.btc.calendar.opentimestamps.org/";
  const human = await runVerifierCli(["bundle"], {
    verify: () => {
      const error = new Error(`integrity-anchors: the calendar at ${calendar} did not answer`);
      error.code = "environment";
      return Promise.reject(error);
    },
  });
  assert.equal(human.exitCode, 2);
  assert.match(human.stderr, new RegExp(calendar.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(human.stderr, /<identifier: see --json>/);
});
