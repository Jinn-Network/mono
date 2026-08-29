import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
  assert.match(result.stderr, /Exit 0: valid bundle; 1: invalid bundle; 2: usage or operational failure/);
  assert.match(result.stderr, /Identifiers inside record files are internal names/);
  // DR-2026-08-17-c Decision 5: `npx` help is a named first-cut surface and must state that
  // protocol identifiers name `https://spec.jinn.network/…` and that origin is not hosted yet.
  // #3022 AC-1 scopes its removal to default stdout; usage() is stderr on exit 2, so both hold.
  assert.match(result.stderr, /https:\/\/spec\.jinn\.network\/\u2026/);
  assert.match(result.stderr, /not hosted yet/);
  assert.match(result.stderr, /fetches nothing from the web/);
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
  assert.match(output, /^Checked: 6 of 6 checks passed/m);
  const orderedChecks = ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"];
  for (const check of orderedChecks) {
    assert.match(output, new RegExp(`${check}\\s+passed`));
  }
  assert.deepEqual(orderedChecks.map((check) => output.indexOf(check)), [...orderedChecks.map((check) => output.indexOf(check))].sort((a, b) => a - b));
  assert.match(output, /Format: benchmark-product-public-bundle\/4/);
  assert.match(output, /does not prove that the\s+producing machine was honest/);
  assert.match(output, /uploads nothing/);
});

test("the verdict word does not overclaim and the caveat block carries no unhosted origin", async () => {
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
  assert.doesNotMatch(output, /Verified/);
  assert.doesNotMatch(output, /spec\.jinn\.network/);
  assert.doesNotMatch(output, /not hosted/);
});

test("every named check prints a plain-language gloss beside its result", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const checks = [
    "manifest",
    "evidence-closure",
    "trust",
    "matrix-rederivation",
    "report-verification",
    "claim-consistency",
    "integrity-anchors",
  ];
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/6",
    identity: "a".repeat(64),
    checks,
    ...V6_IDENTITIES,
  });
  for (const check of checks) {
    const line = output.split("\n").find((candidate) => candidate.startsWith(check));
    assert.ok(line !== undefined, `${check} is missing from the human output`);
    assert.match(line, new RegExp(`^${check}\\s+passed \\u2014 \\S`));
  }
  // Pinned, not merely non-empty: a gloss states what a check proved, so its wording is the
  // claim. On the legacy formats `verifyReport` really does recompute and compare.
  assert.match(output, /report-verification\s+passed \u2014 the report's numbers recompute from that sealed matrix$/mu);
});

test("the evidence-native v5 pair prints glosses too", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const checks = [
    "manifest",
    "evidence-closure",
    "artifact-integrity",
    "signature-validity",
    "matrix-rederivation",
    "report-verification",
    "claim-consistency",
  ];
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/5",
    identity: "a".repeat(64),
    checks,
    ...V6_IDENTITIES,
  });
  for (const check of checks) {
    const line = output.split("\n").find((candidate) => candidate.startsWith(check));
    assert.ok(line !== undefined, `${check} is missing from the human output`);
    assert.match(line, new RegExp(`^${check}\\s+passed \\u2014 \\S`));
  }
  // The v5 report path parses the DSSE envelope, checks the payload type, and asserts the report
  // subjects the exact sealed matrix bytes. It consults no method registry and recomputes
  // nothing, so the legacy sentence must not appear here.
  assert.match(output, /report-verification\s+passed \u2014 the sealed report is signed and bound to that sealed matrix$/mu);
  assert.doesNotMatch(output, /numbers recompute from that sealed matrix/u);
  // HumanLabelResolution records are accepted on `signatures.some(Boolean)`, so the gloss states
  // no per-signature quantifier.
  assert.match(output, /signature-validity\s+passed \u2014 the signatures verify against the keys their records name$/mu);
});

test("an unrecognised check name still renders its result rather than failing", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/2",
    identity: "a".repeat(64),
    checks: ["manifest", "not-a-known-check", "toString"],
    benchmarkSha256: "b".repeat(64), runSha256: "c".repeat(64), matrixSha256: "d".repeat(64),
    reportSha256: "e".repeat(64), reportEnvelopeSha256: "f".repeat(64),
  });
  assert.match(output, /^not-a-known-check\s+passed$/m);
  // An inherited `Object.prototype` member is a miss, not a gloss.
  assert.match(output, /^toString\s+passed$/m);
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
  assert.match(output, /^Checked: 1 of 6 checks passed/m);
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
  assert.match(output, /^Checked: 7 of 7 checks passed/m);
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
  assert.match(output, /lock: declared-but-absent — this run declared .*rfc3161-tsa\/v1 and the bundle carries no matching anchor/);
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
  });
  assert.match(output, /^Checked: 7 of 7 checks passed/m);
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
  assert.match(output, /^Checked: 7 of 7 checks passed/m);
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
