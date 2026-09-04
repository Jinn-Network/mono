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
  assert.match(result.stderr, /Exit 0: valid bundle; 1: invalid bundle, or a freeze repository that drifted/);
  // A bundle that cannot be rendered as a freeze repository is not an invalid bundle, and the
  // usage text has to say which exit code that is.
  assert.match(result.stderr, /could not be\n {5}rendered from the bundle/);
  assert.match(result.stderr, /spec\.jinn\.network/);
  assert.match(result.stderr, /not hosted/);
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
  assert.match(output, /^Recomputed: 6 of 6 checks passed/m);
  const orderedChecks = ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"];
  for (const check of orderedChecks) {
    assert.match(output, new RegExp(`${check}\\s+passed`));
  }
  // Ordering is asserted over the per-check list, not the whole report: the caveat above it now
  // names what each check recomputed ("signing trust", issue #3691), so a whole-output `indexOf`
  // would find prose rather than the list row it means to order.
  const checkList = output.slice(output.indexOf("\nmanifest  "));
  assert.deepEqual(
    orderedChecks.map((check) => checkList.indexOf(check)),
    [...orderedChecks.map((check) => checkList.indexOf(check))].sort((a, b) => a - b),
  );
  assert.match(output, /Format: benchmark-product-public-bundle\/4/);
  assert.match(output, /Not checked by this tool: whether the machine that produced this bundle was/);
  assert.match(output, /No files were uploaded/);
  assert.match(output, /spec\.jinn\.network/);
  assert.match(output, /not hosted/);
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
  assert.match(output, /^Recomputed: 1 of 6 checks passed/m);
  assert.match(output, /Format: benchmark-product-public-bundle\/2/);
});

test("the verdict names the operation and its limits print directly under it (issue #2982)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  // The two shapes whose rendering genuinely differs, not two check counts of one shape: the
  // complete six-check `/4` closure, and the `/5` metadata-first bundle, which is the only shape
  // `summarizeVerificationOutcome` defers a check for and so the only one that also emits the
  // `Artifact content` block and its limit paragraph. The caveats are unconditional, so neither may
  // render a verdict without them immediately beneath it (issue #3690).
  const shapes = [
    {
      format: "benchmark-product-public-bundle/4",
      identity: "a".repeat(64),
      checks: [
        "manifest", "evidence-closure", "trust", "matrix-rederivation",
        "report-verification", "claim-consistency",
      ],
      benchmarkSha256: "b".repeat(64), runSha256: "c".repeat(64), matrixSha256: "d".repeat(64),
      reportSha256: "e".repeat(64), reportEnvelopeSha256: "f".repeat(64),
    },
    {
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
      evidenceRecords: 12,
      artifacts: 5,
      verifiedSignerKeyIds: [],
      profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
      artifactContent: {
        status: "not-fetched", verified: 2, notFetched: 3,
        notFetchedDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
      },
    },
  ];
  for (const shape of shapes) {
    const output = renderVerifiedBundle(shape);
    const [verdict, ...rest] = output.split("\n");
    assert.match(verdict, /^Recomputed: \d+ of \d+ checks passed/);
    assert.doesNotMatch(verdict, /verified|certified|validated|audited/i);
    // Directly under the verdict: only the bundle identity header separates them, and the caveats
    // precede the per-check list rather than trailing it.
    const caveatIndex = output.indexOf("Not checked by this tool:");
    assert.ok(caveatIndex > 0, "caveats must render");
    assert.ok(caveatIndex < output.indexOf("manifest"), "caveats must precede the check list");
    assert.equal(rest.slice(0, 2).filter((line) => line.startsWith("Bundle:") || line.startsWith("Format:")).length, 2);
  }
  // The second shape really is the deferred one, so the loop above is not two spellings of the
  // same rendering.
  assert.match(renderVerifiedBundle(shapes[1]), /artifact-integrity\s+not fetched/);
  assert.doesNotMatch(renderVerifiedBundle(shapes[0]), /not fetched/);
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
  assert.match(output, /^Recomputed: 7 of 7 checks passed/m);
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
        return { verification: { format: "benchmark-product-public-bundle/6", identity: "a".repeat(64), checks: V6_CHECKS, ...V6_IDENTITIES } };
      },
    },
  );
  assert.equal(ok.exitCode, 0);
  // The seam returns the verification AND the snapshot the freeze check renders from, so the
  // reported body must still be the verification. A stub returning the bare verification spreads
  // to nothing rather than throwing, which would empty this body with nothing said.
  assert.equal(JSON.parse(ok.stdout).identity, "a".repeat(64));
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
      return { verification: { format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES } };
    },
  });
  assert.equal(bare.exitCode, 0);
  assert.deepEqual(JSON.parse(bare.stdout).checks, ["manifest"]);
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
      return { verification: { format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES } };
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
  assert.match(output, /^Recomputed: 7 of 7 checks passed/m);
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
  assert.match(output, /^Recomputed: 7 of 7 checks passed/m);
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
  // The publisher line now carries the bare key fingerprint (issue #2983): with no binding supplied
  // that digest is the only name this key has, and printing nothing would read as nothing to say.
  assert.match(
    human.stdout,
    /\nSigned by\n {2}publisher · 1 key\n {4}key sha256:[a-f0-9]{64} — no domain bound\n {2}automated grader — same operator · 1 key\n/,
  );

  const json = await invoke([golden, "--json"]);
  assert.equal(json.code, undefined);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.signers, [
    {
      role: "publisher",
      identity: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX",
      keyId: "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX",
      custody: "same-operator",
      // The digest of the key the did:key carries, so a reader can name the publisher without the
      // identifier (issue #2983).
      keyFingerprint: "sha256:d0aa1595b43cf61e9dfafa456d0b81b92a5aaf53de3627139ca1ab016a9ccda4",
    },
    {
      // The verdict key's identifier is not a did:key, so it carries no key material to digest and
      // gets no fingerprint rather than a fabricated one.
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
  assert.match(output, /^Recomputed: 7 of 7 checks passed$/m);
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
  assert.match(output, /^Recomputed: 6 of 7 checks passed, 1 not fetched$/m);
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

// ---------------------------------------------------------------------------
// Reader-legible publisher identity (issue #2983)
// ---------------------------------------------------------------------------

const { generateKeyPairSync, sign: edSign } = await import("node:crypto");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btc(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let digits = "";
  while (value > 0n) {
    digits = BASE58[Number(value % 58n)] + digits;
    value /= 58n;
  }
  let leading = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading += "1";
  }
  return leading + digits;
}

/** A real key, its did:key, and a signed binding document for it. */
async function mintDomainBinding(domain = "example.com", mechanism = "dns-txt") {
  const { canonicalJsonBytes } = await import("@jinn-network/trust-core");
  const { domainBindingStatementBytes } = await import("../dist/index.js");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = `did:key:z${base58btc(Uint8Array.from([0xed, 0x01, ...raw]))}`;
  const statement = {
    format: "colophon-domain-binding/1",
    domain,
    keyId,
    mechanism,
    statedAt: "2026-09-02T00:00:00.000Z",
  };
  const signature = Buffer.from(
    edSign(null, Buffer.from(domainBindingStatementBytes(statement)), privateKey),
  ).toString("base64");
  return { keyId, bytes: canonicalJsonBytes({ ...statement, signature }) };
}

const { keyFingerprintFromDidKey } = await import("../dist/index.js");

function publisherResult(keyId) {
  return {
    format: "benchmark-product-public-bundle/6",
    identity: "a".repeat(64),
    checks: V6_CHECKS,
    ...V6_IDENTITIES,
    signers: [{
      role: "publisher",
      identity: "urn:jinn:agent:alpha",
      keyId,
      custody: "same-operator",
      keyFingerprint: keyFingerprintFromDidKey(keyId),
    }],
  };
}

test("usage documents the identity-binding flag", async () => {
  const result = await invoke([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--identity-binding/);
  assert.match(result.stderr, /the lookup at the domain itself stays yours/);
});

test("a verified binding renders the domain and names the proof mechanism plainly", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId, bytes } = await mintDomainBinding();
  const result = await runVerifierCli(["bundle", "--identity-binding", "binding.json"], {
    readFile: () => bytes,
    verify: async () => ({ verification: publisherResult(keyId) }),
  });
  assert.equal(result.exitCode, 0);
  // Attributive, not assertive: only the key's signature was checked, so the line says so where a
  // reader sees it rather than four lines below in the limits paragraph.
  assert.match(result.stdout, /claims publication by example\.com — unconfirmed here; check the DNS TXT record at _colophon\.example\.com/);
  assert.doesNotMatch(result.stdout, /published by example\.com/);
  // The key's own established name is still there for a reader who declines to make the lookup.
  assert.match(result.stdout, /key sha256:[a-f0-9]{64}/);
  // The limits paragraph names the remaining step and what trusting its answer rests on.
  assert.match(result.stdout, /DNS resolution/);
  assert.match(result.stdout, /registrar/);
  // #3024 keeps identifiers off the human surface because they are noise a reader has to decode.
  // Here the identifier is the literal string to look for in the record, so it earns its place --
  // and only there: it appears exactly once, inside the value to publish.
  assert.equal(result.stdout.match(/did:key:/g).length, 1);
  // Unwrapped and on its own line, because a reader compares it byte for byte.
  assert.match(result.stdout, new RegExp(`\n {4}expect: colophon-domain-binding=1; key=${keyId}\n`));
});

test("without a binding the publisher is named by its bare key fingerprint", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(["bundle"], { verify: async () => ({ verification: publisherResult(keyId) }) });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /key sha256:[a-f0-9]{64} — no domain bound/);
  assert.doesNotMatch(result.stdout, /claims publication/);
  // No binding, no paragraph about what a binding would mean.
  assert.doesNotMatch(result.stdout, /registrar/);
});

test("a binding for a key that did not sign the bundle exits 2 and is not rendered", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { bytes } = await mintDomainBinding();
  const other = await mintDomainBinding();
  const result = await runVerifierCli(["bundle", "--identity-binding", "binding.json"], {
    readFile: () => bytes,
    verify: async () => ({ verification: publisherResult(other.keyId) }),
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /domain binding not applied/);
  assert.match(result.stderr, /did not sign this bundle/);
  // The bundle's own verdict is still reported, exactly as it is for a freeze-repo failure.
  assert.match(result.stdout, /Recomputed: /);
  assert.doesNotMatch(result.stdout, /published by/);
});

test("--json carries the verified binding, and the failure in its place", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId, bytes } = await mintDomainBinding("example.org", "well-known-url");
  const ok = await runVerifierCli(["bundle", "--json", "--identity-binding", "b.json"], {
    readFile: () => bytes,
    verify: async () => ({ verification: publisherResult(keyId) }),
  });
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.identityBinding.ok, true);
  assert.equal(parsed.identityBinding.domain, "example.org");
  assert.equal(parsed.identityBinding.confirmation, "key-signature-only");
  assert.equal(parsed.identityBinding.proof.location, "https://example.org/.well-known/colophon-domain-binding.txt");
  // The bundle's own digest is untouched: a binding must never shadow the value a consumer pins by.
  assert.equal(parsed.identity, "a".repeat(64));

  const bad = await runVerifierCli(["bundle", "--json", "--identity-binding", "b.json"], {
    readFile: () => new TextEncoder().encode("{"),
    verify: async () => ({ verification: publisherResult(keyId) }),
  });
  const parsedBad = JSON.parse(bad.stdout);
  assert.equal(parsedBad.ok, false);
  assert.equal(parsedBad.identityBinding.ok, false);
  assert.equal(parsedBad.identityBinding.code, "validation");
  assert.equal(parsedBad.identity, "a".repeat(64));
});

test("--identity-binding requires a value and may be supplied only once", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const args of [["bundle", "--identity-binding"], ["bundle", "--identity-binding", "a", "--identity-binding", "b"]]) {
    const result = await runVerifierCli(args, { verify: async () => { throw new Error("must not be reached"); } });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Usage: colophon-verify/);
  }
});

test("a binding for a grader key never becomes the publisher's identity", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const publisher = await mintDomainBinding();
  const grader = await mintDomainBinding("grader.example");
  const result = await runVerifierCli(["bundle", "--identity-binding", "binding.json"], {
    readFile: () => grader.bytes,
    verify: async () => ({
      verification: {
        format: "benchmark-product-public-bundle/6",
        identity: "a".repeat(64),
        checks: V6_CHECKS,
        ...V6_IDENTITIES,
        signers: [
          { role: "publisher", identity: "urn:jinn:agent:alpha", keyId: publisher.keyId, custody: "same-operator", keyFingerprint: keyFingerprintFromDidKey(publisher.keyId) },
          { role: "automated-grader", identity: "urn:jinn:agent:beta", keyId: grader.keyId, custody: "same-operator", keyFingerprint: keyFingerprintFromDidKey(grader.keyId) },
        ],
      },
    }),
  });
  assert.equal(result.exitCode, 2);
  assert.doesNotMatch(result.stdout, /grader\.example/);
  // The real publisher is still named by its own fingerprint rather than suppressed.
  assert.match(result.stdout, new RegExp(`key ${keyFingerprintFromDidKey(publisher.keyId)} — no domain bound`));
});

test("with no single publisher there is no identity to qualify, so neither line nor paragraph prints", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId, bytes } = await mintDomainBinding();
  const second = await mintDomainBinding();
  const result = await runVerifierCli(["bundle", "--identity-binding", "binding.json"], {
    readFile: () => bytes,
    verify: async () => ({
      verification: {
        format: "benchmark-product-public-bundle/6",
        identity: "a".repeat(64),
        checks: V6_CHECKS,
        ...V6_IDENTITIES,
        signers: [
          { role: "publisher", identity: "urn:jinn:agent:alpha", keyId, custody: "same-operator" },
          { role: "publisher", identity: "urn:jinn:agent:beta", keyId: second.keyId, custody: "same-operator" },
        ],
      },
    }),
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /2 publisher keys/);
  assert.doesNotMatch(result.stdout, /claims publication/);
  // The limits paragraph must not qualify a name the report never showed.
  assert.doesNotMatch(result.stdout, /registrar/);
});

test("a drifted freeze repository still exits 1 when an unrelated binding also failed", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(
    ["bundle", "--freeze-repo", "repo", "--identity-binding", "binding.json"],
    {
      readFile: () => new TextEncoder().encode("{"),
      verify: async () => ({ verification: publisherResult(keyId) }),
      freezeRepo: async () => ({ ok: false, commitId: "c".repeat(40), fileCount: 3, executableBitChecked: true, differences: [{ kind: "changed", path: "README.md" }] }),
    },
  );
  assert.equal(result.exitCode, 1);
  // Both flags reported, neither swallowed.
  assert.match(result.stdout, /freeze repository: DOES NOT match this bundle/);
  assert.match(result.stderr, /domain binding not applied/);
});

// ── The promoted caveat's enumeration (issue #3691) ─────────────────────────────────────────────
//
// The sentence beneath the verdict says what was recomputed. It used to hand-list the v2/v4
// closure — and not even all of it: `trust` was missing — so an anchored or disclosed bundle
// printed `of 7` or `of 8` above a sentence that accounted for five checks.

const V8_CHECKS = [...V6_CHECKS, "disclosure-specification"];

function caveatOf(output) {
  const start = output.indexOf("Not checked by this tool:");
  assert.ok(start >= 0, "caveats must render");
  const end = output.indexOf("\n\n", start);
  return output.slice(start, end === -1 ? undefined : end).replace(/\n/g, " ");
}

test("the caveat enumerates the anchored closure's seventh check (issue #3691)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/6",
    identity: "a".repeat(64),
    checks: V6_CHECKS,
    ...V6_IDENTITIES,
    anchors: { anchors: [], subjects: [], invalid: [] },
  });
  assert.match(output, /^Recomputed: 7 of 7 checks passed$/m);
  const caveat = caveatOf(output);
  assert.match(caveat, /anchor well-formedness/);
  // The check the pre-#3691 hand-list dropped.
  assert.match(caveat, /signing trust/);
  assert.doesNotMatch(caveat, /undefined/);
});

test("the caveat enumerates the disclosed closure's eighth check (issue #3691)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/8",
    identity: "a".repeat(64),
    checks: V8_CHECKS,
    ...V6_IDENTITIES,
    anchors: { anchors: [], subjects: [], invalid: [] },
  });
  assert.match(output, /^Recomputed: 8 of 8 checks passed$/m);
  const caveat = caveatOf(output);
  assert.match(caveat, /the disclosure specification/);
  assert.match(caveat, /anchor well-formedness/);
  assert.doesNotMatch(caveat, /undefined/);
});

test("the caveat never claims a deferred check was recomputed (issue #3691)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
    artifactContent: {
      status: "not-fetched", verified: 2, notFetched: 3,
      notFetchedDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    },
  });
  const caveat = caveatOf(output);
  assert.doesNotMatch(caveat, /artifact integrity/);
  assert.match(caveat, /signature validity/);
  // The deferral is still disclosed, in the block that exists to disclose it.
  assert.match(output, /artifact-integrity\s+not fetched/);
});

test("every closure's checks have a caveat phrase (issue #3691)", async () => {
  const { describeRecomputedChecks } = await import("../dist/index.js");
  const closures = [
    ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
    V6_CHECKS,
    V8_CHECKS,
    V5_CHECKS,
  ];
  for (const checks of closures) {
    const sentence = describeRecomputedChecks({
      outcomes: checks.map((check) => ({ check, state: "passed" })),
      passed: checks.length,
      notFetched: 0,
      total: checks.length,
    });
    assert.doesNotMatch(sentence, /undefined/, `no phrase for a check in ${checks.join(", ")}`);
    // One phrase per check: phrases carry no commas, so the joined sentence splits cleanly.
    assert.equal(sentence.split(", ").length, checks.length);
  }
});

test("the usage block and the verdict agree on what this tool does to the npm bytes (issue #3675)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const sentence = "Checks run against the exact platform bytes installed from npm.";
  const result = await invoke([]);
  assert.equal(result.code, 2);
  // The pre-#3675 usage sentence was "Verification uses exact platform bytes from npm." -- the
  // noun #2982 ruled overclaims, surviving on the one surface #2982 did not rewrite.
  assert.doesNotMatch(result.stderr, /Verification uses/);
  assert.ok(result.stderr.includes(sentence), "usage must state the platform-bytes sentence");
  const verdict = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/4",
    identity: "a".repeat(64),
    checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
    benchmarkSha256: "b".repeat(64), runSha256: "c".repeat(64), matrixSha256: "d".repeat(64),
    reportSha256: "e".repeat(64), reportEnvelopeSha256: "f".repeat(64),
  });
  assert.ok(verdict.includes(sentence), "the verdict must state the same sentence");
});

// ── The check-name gloss column (issue #3861, reader-facing-vocabulary spec §4.2) ───────────────
//
// The check names are contract — sealed into `claim-package.json`'s `verification.checks` and
// asserted by the external verification path — so the spec rules them *keep + gloss*: the plain
// words go beside the name, never in place of it. These tests hold both halves of that ruling.

const V5_METADATA_FIRST = {
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
  evidenceRecords: 12,
  artifacts: 5,
  verifiedSignerKeyIds: [],
  profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
  artifactContent: {
    status: "not-fetched", verified: 2, notFetched: 3,
    notFetchedDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
  },
};

const V8_SHAPE = {
  format: "benchmark-product-public-bundle/8",
  identity: "a".repeat(64),
  checks: V8_CHECKS,
  ...V6_IDENTITIES,
  anchors: { anchors: [], subjects: [], invalid: [] },
};

/** The rendered check rows: every line that begins with one of the checks the shape declares. */
function checkRows(output, checks) {
  return checks.map((check) => {
    const row = output.split("\n").find((line) => line.startsWith(`${check} `) || line === check);
    assert.ok(row !== undefined, `no rendered row for ${check}`);
    return { check, row };
  });
}

test("every printed check name carries its plain-language gloss (issue #3861)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  // Two shapes cover all ten check names in the union: the disclosed `/8` closure carries `trust`,
  // `integrity-anchors`, and `disclosure-specification`; the evidence-native `/5` carries
  // `artifact-integrity` and `signature-validity`.
  const glosses = {
    "manifest": "every listed file is here, unaltered",
    "evidence-closure": "every run's evidence is carried here",
    "trust": "the signing keys match the identities",
    "matrix-rederivation": "the run tally follows from the evidence",
    "report-verification": "the result follows from the runs",
    "claim-consistency": "the claim agrees with the records here",
    "integrity-anchors": "the timestamp proofs are well formed",
    "disclosure-specification": "what was pinned is recorded and matches",
    "artifact-integrity": "each artifact matches its fingerprint",
    "signature-validity": "each signature matches its key",
  };
  const seen = new Set();
  for (const shape of [V8_SHAPE, V5_METADATA_FIRST]) {
    const output = renderVerifiedBundle(shape);
    for (const { check, row } of checkRows(output, shape.checks)) {
      seen.add(check);
      // Name verbatim, then a state, then the gloss — the gloss never replaces the sealed name.
      assert.match(
        row,
        new RegExp(`^${check} {2,}(passed|not fetched) +${glosses[check].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        `wrong gloss row for ${check}: ${JSON.stringify(row)}`,
      );
    }
  }
  // The two shapes together must cover every check any supported closure can emit, so this test
  // cannot drift narrower than the product. The exhaustiveness of the gloss map itself is a type
  // obligation -- it is keyed by the check union, the same discipline `CHECK_SUBJECTS` uses.
  const { PUBLIC_BUNDLE_VERIFICATION_CHECKS, PUBLIC_BUNDLE_V6_CHECKS, PUBLIC_BUNDLE_V7_CHECKS, PUBLIC_BUNDLE_V8_CHECKS } =
    await import("../dist/index.js");
  const { EVIDENCE_NATIVE_BUNDLE_V5_CHECKS } = await import("@jinn-network/benchmarking-evidence");
  const everyCheck = new Set([
    ...PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    ...PUBLIC_BUNDLE_V6_CHECKS,
    ...PUBLIC_BUNDLE_V7_CHECKS,
    ...PUBLIC_BUNDLE_V8_CHECKS,
    ...EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
  ]);
  assert.deepEqual([...seen].sort(), [...everyCheck].sort(), "both shapes must cover every check a closure can emit");
  assert.deepEqual(Object.keys(glosses).sort(), [...everyCheck].sort(), "every emittable check needs a gloss");
});

test("the deferred check's gloss states what was not established, not that it held (issue #3861)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle(V5_METADATA_FIRST);
  // The one row that prints a state other than `passed`. Its gloss is present-tense, so the line
  // reads as the proposition this bundle did not establish — a past-tense gloss beside
  // `not fetched` would assert exactly what the deferral denies.
  assert.match(output, /^artifact-integrity {2,}not fetched {2,}each artifact matches its fingerprint$/m);
});

test("the gloss column is aligned and the rows stay inside 80 columns (issue #3861)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  for (const shape of [V8_SHAPE, V5_METADATA_FIRST]) {
    const output = renderVerifiedBundle(shape);
    const rows = checkRows(output, shape.checks).map(({ row }) => row);
    const offsets = new Set(rows.map((row) => row.indexOf(row.trimEnd().split(/ {2,}/).at(-1))));
    assert.equal(offsets.size, 1, `gloss column is ragged: ${JSON.stringify(rows)}`);
    for (const row of rows) assert.ok(row.length <= 80, `row exceeds 80 columns: ${JSON.stringify(row)}`);
  }
});

test("no check name is renamed by the gloss (issue #3861)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  for (const shape of [V8_SHAPE, V5_METADATA_FIRST]) {
    const output = renderVerifiedBundle(shape);
    for (const check of shape.checks) {
      assert.match(output, new RegExp(`^${check} `, "m"), `${check} must print verbatim at the start of its row`);
    }
  }
});
