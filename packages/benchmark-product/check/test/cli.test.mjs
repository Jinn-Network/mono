import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/**
 * Success and failure return the same shape so a caller can read `code` without narrowing.
 * `code` stays `undefined` on success, which is what the refusal assertions test against.
 *
 * @param {readonly string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, code: number | undefined }>}
 */
async function invoke(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, ...args]);
    return { stdout, stderr, code: undefined };
  } catch (error) {
    const failure = /** @type {{ stdout: string, stderr: string, code?: number }} */ (error);
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}

// ---------------------------------------------------------------------------
// The `verify` seam's return shape, written once (issues #4272, #4385, #4386)
// ---------------------------------------------------------------------------
//
// `VerifierCliDeps.verify` returns the verification AND the authenticated snapshot it was
// computed from, because `--freeze-repo` renders its tree from that same snapshot rather than
// re-verifying without the caller's trust material. A stub that returns the bare verification
// spreads to nothing rather than throwing, so the omission used to surface as an
// undefined-property crash several frames inside the renderer (#4272). `tsconfig.tests.json`
// now makes it a compile error; these helpers make carrying the field cheap enough that no
// stub has a reason to drop it.

/**
 * One authenticated snapshot, distinguishable by `identity` so a test can assert that the
 * exact object it supplied is the one the freeze seam received.
 *
 * @param {string} [identity]
 * @returns {import("../dist/index.js").VerifiedBundleSnapshot}
 */
function bundleSnapshot(identity = "0".repeat(64)) {
  const bytes = new TextEncoder().encode("{}");
  return {
    manifest: {
      format: "benchmark-product-public-bundle/2",
      files: [{ path: "bundle.json", sha256: "0".repeat(64), bytes: bytes.length }],
    },
    bytes,
    identity,
    fileBytes: new Map([["bundle.json", bytes]]),
  };
}

/**
 * The `readFile` seam returns bytes or refuses; a fixture map's miss is a broken test, not an
 * empty file. The CLI wraps this dep, so the miss surfaces as an exit-2 refusal carrying the
 * path on stderr rather than as `undefined` reaching the parser.
 *
 * @param {ReadonlyMap<string, Uint8Array>} files
 * @param {string} path
 * @returns {Uint8Array}
 */
function readFixture(files, path) {
  const bytes = files.get(path);
  assert.ok(bytes !== undefined, `no fixture for ${path}`);
  return bytes;
}

/**
 * @param {import("../dist/index.js").PublicBundleVerificationResult} verification
 * @param {import("../dist/index.js").VerifiedBundleSnapshot} [snapshot]
 * @returns {import("../dist/index.js").VerifiedPublicBundleSnapshot}
 */
function verified(verification, snapshot = bundleSnapshot()) {
  return { verification, snapshot };
}

test("usage exits 2 and states the exit contract", async () => {
  const result = await invoke([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Exit 0: valid bundle; 1: invalid bundle, or a freeze repository that drifted/);
  // A bundle that cannot be rendered as a freeze repository is not an invalid bundle, and the
  // usage text has to say which exit code that is.
  assert.match(result.stderr, /could not be\n {5}rendered from the bundle/);
  assert.match(result.stderr, /Protocol identifiers the protocol spec release serves resolve to their\ndocuments; the rest are names, not addresses/);
  assert.doesNotMatch(result.stderr, /Protocol identifiers are names/);
  assert.match(result.stderr, /platform bytes installed from npm/);
  // The reader's words for what the caller supplies and what it checks: trust anchors, block
  // headers and timestamp proofs, not "trust material" or a bare "anchor" (reader-facing
  // vocabulary §4.2, v1.16: the notes name block headers apart from trust anchors, so the usage
  // text names both).
  assert.match(result.stderr, /Trust anchors and block headers are yours, not the bundle's: with none supplied\nfor its time source, a well-formed timestamp proof reports present rather than\nverified, and none ships with this tool\./);
  assert.doesNotMatch(result.stderr, /[Tt]rust material/);
  assert.doesNotMatch(result.stderr, /well-formed anchor/);
  assert.doesNotMatch(result.stderr, /jinn\.network/);
  assert.doesNotMatch(result.stderr, /not hosted/);
});

test("--help and -h print the usage on stdout and exit 0 (issue #4955)", async () => {
  // An explicit request for help is not a usage failure. A script that runs `--help` to confirm
  // the checker installed read the old exit 2 as a broken install. The error path keeps its
  // stream and its code: no bundle argument still prints the usage on stderr and exits 2.
  const usageError = await invoke([]);
  assert.equal(usageError.code, 2);
  assert.equal(usageError.stdout, "");
  assert.match(usageError.stderr, /--help, -h {5}Print this usage and exit 0\./);
  for (const flag of ["--help", "-h"]) {
    const result = await invoke([flag]);
    assert.equal(result.code, undefined, flag);
    assert.equal(result.stderr, "", flag);
    // The same text the error path prints, on the other stream.
    assert.equal(result.stdout, usageError.stderr, flag);
  }
});

test("a help flag beside other arguments exits 0 without reading the bundle (issue #4955)", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const args of [["--help"], ["-h"], ["bundle", "--help"], ["bundle", "--json", "-h"]]) {
    const result = await runVerifierCli(args, { verify: async () => { throw new Error("must not be reached"); } });
    assert.equal(result.exitCode, 0, args.join(" "));
    assert.match(result.stdout, /^Usage: colophon-check/, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
  }
});

test("a missing bundle exits 1 with machine-readable invalid-bundle output", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "colophon-check-")), "missing");
  const result = await invoke([missing, "--json"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    verifierVersion: "0.2.2",
    supportedFormats: [
      "benchmark-product-public-bundle/2",
      "benchmark-product-public-bundle/4",
      "benchmark-product-public-bundle/5",
      "benchmark-product-public-bundle/6",
      "benchmark-product-public-bundle/7",
      "benchmark-product-public-bundle/8",
      "benchmark-product-public-bundle/10",
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
  // The slice is line-anchored and width-independent: it starts at the list's first row, not at
  // caveat prose that also names "manifest" (issue #3755). It is asserted found, so a changed
  // layout fails here rather than silently ordering the whole report.
  const listStart = output.search(/^manifest\s+passed\b/m);
  assert.ok(listStart >= 0, "per-check list not found in verify output");
  const checkList = output.slice(listStart);
  assert.deepEqual(
    orderedChecks.map((check) => checkList.indexOf(check)),
    [...orderedChecks.map((check) => checkList.indexOf(check))].sort((a, b) => a - b),
  );
  assert.match(output, /Format: benchmark-product-public-bundle\/4/);
  assert.match(output, /Not checked by this tool: whether the machine that produced this bundle was/);
  assert.match(output, /No files were uploaded/);
  assert.match(output, /Protocol identifiers the protocol spec release serves resolve to their\ndocuments; the rest are names, not addresses/);
  assert.doesNotMatch(output, /Protocol identifiers are names/);
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
    /** @type {import("../dist/index.js").PublicBundleVerificationResult} */ ({
      format: "benchmark-product-public-bundle/4",
      identity: "a".repeat(64),
      checks: [
        "manifest", "evidence-closure", "trust", "matrix-rederivation",
        "report-verification", "claim-consistency",
      ],
      benchmarkSha256: "b".repeat(64), runSha256: "c".repeat(64), matrixSha256: "d".repeat(64),
      reportSha256: "e".repeat(64), reportEnvelopeSha256: "f".repeat(64),
    }),
    v5({
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
    }),
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
/** @type {readonly import("../dist/index.js").PublicBundleVerificationCheck[]} */
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
        // — a root that does not chain, say. Disclosing "no trust anchors supplied" here would
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
  assert.match(output, /lock timestamp proof · authority-time · present · 2026-01-01T12:00:00Z/);
  assert.match(output, /time source not evaluated: no trust anchors supplied/);
  // A `present` proof's coverage WAS checked (the tool recomputes the lock or matrix bytes it covers);
  // only its time source went unevaluated. Saying the coverage was not evaluated misstates the check.
  assert.doesNotMatch(output, /covers was not evaluated|what the timestamp covers/);
  // Supplied-but-unverifying is disclosed as itself, never as "no trust anchors supplied".
  assert.match(output, /lock timestamp proof · authority-time · present · 2026-02-02T12:00:00Z/);
  assert.match(output, /time source not evaluated: the trust anchors you supplied do not verify this timestamp proof/);
  assert.match(output, /the runs timestamp proof · chain-time · verified · block 880017/);
  assert.match(output, /time source evaluated against block headers you supplied — 2026-08-17T12:00:00Z/);
  // An authority-time proof whose evaluated instant is the genTime already on the head line does
  // not repeat it.
  assert.doesNotMatch(output, /supplied — 2026-01-01T12:00:00Z/);
  assert.match(output, new RegExp(`record ${"1".repeat(64)}`));
  assert.match(output, /Timestamp coverage\n {2}lock: timestamped\n {2}the runs: timestamped/);
  assert.match(output, /A timestamp proof \(anchor\) dates the bytes it covers and says nothing/);
  assert.match(output, /not\s+that results were produced after it/);
});

test("the default human surface names a missing and a promised-but-missing timestamp explicitly", async () => {
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
  assert.match(output, /no timestamp proofs carried/);
  assert.match(output, /lock: promised but missing — this run promised rfc3161-tsa\/v1 and the bundle carries no matching timestamp proof/);
  assert.doesNotMatch(output, /jinn\.network/);
  assert.match(output, /the runs: none — no timestamp proof was carried and none was promised/);
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
  assert.match(output, /lock timestamp proof · chain-time · pending\n/);
  assert.match(output, /the proof carries only calendar promises/);
  assert.doesNotMatch(output, /block \d/);
});

test("accepted anchor reasons alias raw identifiers for humans while JSON keeps them", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const urn = "urn:jinn:anchor:calendar-a";
  const keyId = "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX";
  const reason = `calendar promise ${urn} was signed by ${keyId}`;
  /** @type {import("../dist/index.js").PublicBundleVerificationResult} */
  const report = {
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
        reason,
        trustMaterial: "none",
      }],
      subjects: [{ subject: "lock", outcome: "anchored" }, { subject: "matrix", outcome: "absent" }],
      invalid: [],
    },
  };

  const human = await runVerifierCli(["bundle"], { verify: async () => verified(report) });
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /calendar promise <identifier: see --json> was signed by <identifier: see --json>/);
  assert.doesNotMatch(human.stdout, /urn:|did:key/);
  assert.doesNotMatch(human.stdout, /jinn\.network|jinn\.benchmarking/);

  const machine = await runVerifierCli(["bundle", "--json"], { verify: async () => verified(report) });
  assert.equal(machine.exitCode, 0);
  assert.equal(JSON.parse(machine.stdout).anchors.anchors[0].reason, reason);
});

// Spec section 4.2, v1.15 (issue #5278): the human lines name the record `matrix.json` as the runs,
// the section 5 name, while --json and the sealed claim keep the raw subject `matrix`.
test("the timestamp blocks name the matrix subject the runs while --json keeps matrix", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  /** @type {import("../dist/index.js").PublicBundleVerificationResult} */
  const report = {
    format: "benchmark-product-public-bundle/6",
    identity: "a".repeat(64),
    checks: V6_CHECKS,
    ...V6_IDENTITIES,
    anchors: {
      anchors: [{
        recordSha256: "3".repeat(64),
        status: "pending",
        provider: "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1",
        subject: "matrix",
        timeBasis: "chain-time",
        trustMaterial: "none",
      }],
      subjects: [
        { subject: "lock", outcome: "absent" },
        {
          subject: "matrix",
          outcome: "declared-but-absent",
          declaredProfiles: ["https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1"],
        },
      ],
      invalid: [],
    },
  };

  const human = await runVerifierCli(["bundle"], { verify: async () => verified(report) });
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /^ {2}the runs timestamp proof · chain-time · pending$/m);
  assert.match(human.stdout, /^ {2}the runs: promised but missing — this run promised opentimestamps\/v1 /m);
  assert.doesNotMatch(human.stdout, /^ {2}matrix\b/m);
  assert.doesNotMatch(human.stdout, /\bmatrix (?:timestamp|:)/i);

  const machine = await runVerifierCli(["bundle", "--json"], { verify: async () => verified(report) });
  assert.equal(machine.exitCode, 0);
  const anchors = JSON.parse(machine.stdout).anchors;
  assert.equal(anchors.anchors[0].subject, "matrix");
  assert.deepEqual(anchors.subjects.map((/** @type {{ subject: string }} */ entry) => entry.subject), ["lock", "matrix"]);
});

// Spec section 4.2, v1.16 (issue #5253): whether this reader supplied material is decided per
// profile, so each proof's note names the material its own time source needs: trust anchors
// (`--tsa-root`) for an authority-time proof, block headers (`--ots-headers`) for a chain-time one.
// The proofs are real and so is the evaluation: `verify` runs `evaluateIntegrityAnchors` over the
// material the flags built, as `verifyPublicBundleSnapshot` does, so no case states a
// `trustMaterial` the evaluator would not report.
test("each timestamp proof's note names the material its own time source needs (issue #5253)", async () => {
  const { evaluateIntegrityAnchors, runVerifierCli } = await import("../dist/index.js");
  const { MATRIX_RECORD_KIND, RUN_RECORD_KIND } = await import("@jinn-network/benchmarking-records");
  const {
    buildOpenTimestampsAnchorEvidenceRecord,
    buildRfc3161AnchorEvidenceRecord,
    createFixtureAuthority,
    createOpenTimestampsKitFixtures,
  } = await import("@jinn-network/trust-testing");
  const runSha256 = "1".repeat(64);
  const matrixSha256 = "2".repeat(64);
  const authority = createFixtureAuthority("issue-5253");
  const ots = createOpenTimestampsKitFixtures(Buffer.from(matrixSha256, "hex"));
  /** @param {{ readonly bytes: Uint8Array, readonly recordDigest: string }} built */
  const carried = (built) => ({ recordSha256: built.recordDigest.slice("sha256:".length), bytes: built.bytes });
  const lock = carried(buildRfc3161AnchorEvidenceRecord({
    subjectKind: RUN_RECORD_KIND,
    subjectSha256: runSha256,
    proofBytes: authority.mintTimeStampToken({ subjectSha256: runSha256, genTime: "20260501120000Z" }).tokenDer,
  }));
  /** @param {Uint8Array} proofBytes */
  const runs = (proofBytes) => carried(buildOpenTimestampsAnchorEvidenceRecord({
    subjectKind: MATRIX_RECORD_KIND,
    subjectSha256: matrixSha256,
    proofBytes,
  }));
  const headers = ots.blockHeaders.map(({ height, header }) => `${height}:${Buffer.from(header).toString("hex")}\n`).join("");
  const files = new Map([
    ["root.der", authority.certificateDer],
    ["headers.txt", new TextEncoder().encode(headers)],
  ]);
  /**
   * @param {readonly string[]} flags
   * @param {readonly { recordSha256: string, bytes: Uint8Array }[]} records
   */
  const check = (flags, records) => runVerifierCli(["bundle", ...flags], {
    readFile: (path) => readFixture(files, path),
    verify: async (_dir, options) => verified({
      format: "benchmark-product-public-bundle/6",
      identity: "a".repeat(64),
      checks: V6_CHECKS,
      ...V6_IDENTITIES,
      anchors: evaluateIntegrityAnchors({
        records,
        runSha256,
        matrixSha256,
        closeAt: "2026-06-01T00:00:00Z",
        ...(options?.anchorTrust === undefined ? {} : { trust: options.anchorTrust }),
      }),
    }),
  });
  /**
   * The note printed under the one proof whose head line starts with `head`.
   * @param {string} stdout
   * @param {string} head
   */
  const noteUnder = (stdout, head) => {
    const lines = stdout.split("\n");
    const at = lines.findIndex((line) => line.startsWith(`  ${head} · `));
    assert.ok(at >= 0, `no proof line for ${head} in:\n${stdout}`);
    return lines[at + 1];
  };
  const lockHead = "lock timestamp proof · authority-time";
  const runsHead = "the runs timestamp proof · chain-time";

  // No material at all: the chain-time proof points at block headers, the authority-time one at
  // trust anchors.
  const bare = await check([], [lock, runs(ots.completeProof)]);
  assert.equal(bare.exitCode, 0, bare.stderr);
  assert.equal(noteUnder(bare.stdout, runsHead), "    time source not evaluated: no block headers supplied");
  assert.equal(noteUnder(bare.stdout, lockHead), "    time source not evaluated: no trust anchors supplied");

  // Only a root: it verifies the authority-time proof and was never material for the chain-time
  // one, so that proof is not told that no trust anchors were supplied.
  const rootOnly = await check(["--tsa-root", "root.der"], [lock, runs(ots.completeProof)]);
  assert.equal(rootOnly.exitCode, 0, rootOnly.stderr);
  assert.match(rootOnly.stdout, /^ {2}the runs timestamp proof · chain-time · present · block 880017$/m);
  assert.equal(noteUnder(rootOnly.stdout, runsHead), "    time source not evaluated: no block headers supplied");
  assert.match(rootOnly.stdout, /^ {2}lock timestamp proof · authority-time · verified · 2026-05-01T12:00:00Z$/m);
  assert.equal(noteUnder(rootOnly.stdout, lockHead), "    time source evaluated against trust anchors you supplied");
  assert.doesNotMatch(rootOnly.stdout, /no trust anchors supplied/);

  // Only block headers: the mirror case.
  const headersOnly = await check(["--ots-headers", "headers.txt"], [lock, runs(ots.completeProof)]);
  assert.equal(headersOnly.exitCode, 0, headersOnly.stderr);
  assert.match(headersOnly.stdout, /^ {2}the runs timestamp proof · chain-time · verified · block 880017$/m);
  assert.equal(
    noteUnder(headersOnly.stdout, runsHead),
    "    time source evaluated against block headers you supplied — 2026-08-17T12:00:00Z",
  );
  assert.equal(noteUnder(headersOnly.stdout, lockHead), "    time source not evaluated: no trust anchors supplied");

  // Block headers that do not include the attested block: supplied, and still not `verified`.
  const otherBlock = await check(["--ots-headers", "headers.txt"], [runs(ots.unknownHeightCompleteProof)]);
  assert.equal(otherBlock.exitCode, 0, otherBlock.stderr);
  assert.equal(
    noteUnder(otherBlock.stdout, runsHead),
    "    time source not evaluated: the block headers you supplied do not verify this timestamp proof",
  );

  // `--json` carries the evaluator's raw entry and none of this prose.
  const machine = await check(["--json", "--tsa-root", "root.der"], [lock, runs(ots.completeProof)]);
  assert.equal(machine.exitCode, 0, machine.stderr);
  const entries = JSON.parse(machine.stdout).anchors.anchors;
  assert.deepEqual(
    entries.map((/** @type {{ subject: string, status: string, trustMaterial: string }} */ entry) =>
      [entry.subject, entry.status, entry.trustMaterial]).sort(),
    [["lock", "verified", "supplied"], ["matrix", "present", "none"]],
  );
  assert.doesNotMatch(machine.stdout, /time source|block headers|trust anchors/);
});

test("an unanchored bundle's human surface is unchanged — no anchor section at all", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle({
    format: "benchmark-product-public-bundle/2",
    identity: "a".repeat(64),
    checks: ["manifest"],
    ...V6_IDENTITIES,
  });
  assert.doesNotMatch(output, /Timestamps/);
  assert.doesNotMatch(output, /Timestamp coverage/);
  assert.doesNotMatch(output, /dates the bytes it covers/);
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
  /** @type {import("../dist/index.js").VerifyPublicBundleDeps | undefined} */
  let seen;
  const ok = await runVerifierCli(
    ["bundle", "--json", "--tsa-root", "root.der", "--ots-headers", "headers.txt"],
    {
      readFile: (path) => readFixture(files, path),
      verify: async (_dir, options) => {
        seen = options;
        return verified({ format: "benchmark-product-public-bundle/6", identity: "a".repeat(64), checks: V6_CHECKS, ...V6_IDENTITIES });
      },
    },
  );
  assert.equal(ok.exitCode, 0);
  // The seam returns the verification AND the snapshot the freeze check renders from, so the
  // reported body must still be the verification. A stub returning the bare verification spreads
  // to nothing rather than throwing, which would empty this body with nothing said.
  assert.equal(JSON.parse(ok.stdout).identity, "a".repeat(64));
  const trust = seen?.anchorTrust;
  assert.ok(trust?.rfc3161 !== undefined && trust.opentimestamps !== undefined);
  assert.equal(trust.rfc3161.trustAnchorsDer.length, 1);
  assert.deepEqual([...trust.opentimestamps.blockHeaders].map((entry) => entry.height), [880017]);
  assert.equal(trust.opentimestamps.blockHeaders[0].header.length, 80);

  const broken = await runVerifierCli(["bundle", "--ots-headers", "broken.txt"], {
    readFile: (path) => readFixture(files, path),
    verify: async () => { throw new Error("must not be reached"); },
  });
  assert.equal(broken.exitCode, 2);
  assert.match(broken.stderr, /expected "<height>:<160 hex characters>"/);

  // No flags means no material, and the verifier is told so by omission rather than by an empty set.
  const bare = await runVerifierCli(["bundle", "--json"], {
    readFile: () => { throw new Error("must not be reached"); },
    verify: async (_dir, options) => {
      seen = options;
      return verified({ format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES });
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
  /** @type {import("../dist/index.js").VerifyPublicBundleDeps | undefined} */
  let seen;
  const result = await runVerifierCli(["bundle", "--json", "--tsa-root", "roots.pem"], {
    readFile: () => new TextEncoder().encode(pem + pem),
    verify: async (_dir, options) => {
      seen = options;
      return verified({ format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES });
    },
  });
  assert.equal(result.exitCode, 0);
  const anchors = seen?.anchorTrust;
  assert.ok(anchors?.rfc3161 !== undefined);
  assert.equal(anchors.rfc3161.trustAnchorsDer.length, 2);
  assert.deepEqual(Buffer.from(anchors.rfc3161.trustAnchorsDer[0]), der);
});

test("a flag missing its value exits 2 with usage", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const args of [["bundle", "--tsa-root"], ["bundle", "--ots-headers", "--json"], ["bundle", "--unknown"]]) {
    const result = await runVerifierCli(args, { verify: async () => { throw new Error("must not be reached"); } });
    assert.equal(result.exitCode, 2, args.join(" "));
    assert.match(result.stderr, /Usage: colophon-check/);
  }
});

test("human summary names all seven evidence-native checks for bundle v5", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle(v5({
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
  }));
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
  assert.match(output, /lock timestamp proof · authority-time · present · 2026-01-01T12:00:00Z/);
});

/** @type {readonly import("../dist/index.js").PublicBundleSigner[]} */
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
  const output = renderVerifiedBundle(v5({
    format: "benchmark-product-public-bundle/5",
    identity: `sha256:${"a".repeat(64)}`,
    checks: ["manifest"],
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    artifactContent: { status: "verified", verified: 0, notFetched: 0, notFetchedDigests: [] },
    signers: [
      { role: "publisher", identity: "urn:report:1", keyId: "k1", custody: "undeclared" },
      { role: "automated-grader", identity: "urn:evaluator:1", keyId: "k2", custody: "undeclared" },
    ],
  }));
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

test("the golden bundle's default output carries no identifier and no verdict word while --json carries every identifier", async () => {
  const golden = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1/golden", import.meta.url));
  const human = await invoke([golden]);
  assert.equal(human.code, undefined);
  assert.doesNotMatch(human.stdout, /urn:/);
  assert.doesNotMatch(human.stdout, /did:key/);
  // The retired verdict word over the whole real render (issue #3510). This is the only
  // verdict-word assertion that runs the real binary; it reaches the signer block, but so do the
  // two in-process ones below, which pass `publisherResult` and therefore render a publisher too.
  // The cross-shape test below owns the artifact-content and anchor paragraphs, which render empty
  // over golden's format /2. Regenerating golden to an anchor-carrying format would bring those
  // paragraphs in here, and this would still pass: `invoke` supplies no anchor trust material and
  // this package ships none, so a well-formed proof renders `present`, never `verified`
  // (`src/verify.ts`, `anchorTrust`).
  assert.doesNotMatch(human.stdout, /verified|certified|validated|audited/i);
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

// Issue #3284: every human refusal line goes through one sanitizer. A publisher-chosen name can
// carry control characters, so the line it lands on must not be able to forge another one.
const CONTROL_CHARACTER_EXCEPT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

test("a publisher-named evaluator cannot forge a stderr line or print its name", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const name = "\u001b[2K\rcolophon-check: bundle verified\nurn:x:evil";
  const message = `evaluator ${name} keyId is not derived from its SPKI`;
  const verify = async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); };

  const human = await runVerifierCli(["bundle"], { verify });
  assert.equal(human.exitCode, 1);
  assert.equal(human.stdout, "");
  assert.doesNotMatch(human.stderr, CONTROL_CHARACTER_EXCEPT_LF);
  assert.equal(human.stderr.split("\n").length, 2, "one refusal is one line");
  assert.ok(!human.stderr.split("\n").some((line) => line.startsWith("colophon-check: bundle verified")));
  assert.match(human.stderr, /^colophon-check: judge <identifier: see --json> keyId is not derived from its SPKI\n$/u);
  assert.doesNotMatch(human.stderr, /urn:|evil/u);

  const json = await runVerifierCli(["bundle", "--json"], { verify });
  assert.equal(json.exitCode, 1);
  assert.equal(json.stderr, "");
  assert.equal(JSON.parse(json.stdout).message, message);
});

test("publisher-named reviewers and trust entries are aliased on the human surface", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const message of [
    "reviewer Jane Q. Reviewer has no signer key id",
    "reviewer Jane Q. Reviewer uses more than one key",
    "trust.evaluators.Jane Q. Reviewer is not a valid SPKI public key",
    "trust.evaluators.Jane Q. Reviewer is not an Ed25519 public key",
  ]) {
    const result = await runVerifierCli(["bundle"], {
      verify: async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); },
    });
    assert.equal(result.exitCode, 1, message);
    assert.match(result.stderr, /<identifier: see --json>/u, message);
    assert.doesNotMatch(result.stderr, /Jane/u, message);
  }
});

// A name may embed its own template's suffix text; the name then runs to the last suffix, so the
// text between the two copies is aliased rather than printed.
test("a publisher name that embeds its template's suffix prints none of itself", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const message = "evaluator a keyId is not derived from its SPKI; bundle verified keyId is not derived from its SPKI";
  const result = await runVerifierCli(["bundle"], {
    verify: async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "colophon-check: judge <identifier: see --json> keyId is not derived from its SPKI\n");
  assert.doesNotMatch(result.stderr, /bundle verified/u);
});

// A name that repeats another template's prefix, with no suffix after it, made a lazy-regex scan
// quadratic: about six seconds for this megabyte on a laptop. A linear scan takes milliseconds.
test("aliasing a hostile publisher name stays linear in its length", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const [message, expected] of [
    [
      `reviewer ${"evaluator ".repeat(100_000)}has no signer key id`,
      "reviewer <identifier: see --json> has no signer key id",
    ],
    [
      `trust.evaluators.${"reviewer ".repeat(110_000)}is not an Ed25519 public key`,
      "trust.evaluators.<identifier: see --json> is not an Ed25519 public key",
    ],
    // A publisher-chosen claim field path that repeats its own rule's tail (#5251): the reader's
    // wording rules are anchored, so this costs one scan and prints unchanged.
    [
      `claim package ${"x is not the exact projection of verified facts ".repeat(25_000)}y`,
      `claim package ${"x is not the exact projection of verified facts ".repeat(25_000)}y`,
    ],
    // Two #5299 rules once read a publisher-sized middle with `[\s\S]+` twice, which took seconds on
    // these inputs. Each now reads a single token there, so neither costs more than one scan.
    [`a ${" bundle must carry ".repeat(50_000)}`, `a ${" bundle must carry ".repeat(50_000)}`],
    [
      `a ${" bundle's qualification document must keep its frozen ".repeat(16_000)}`,
      `a ${" bundle's qualification document must keep its frozen ".repeat(16_000)}`,
    ],
    // The #5373 rules: a lazy label before a fixed tail, a run of field paths, and lists joined with
    // `; ` whose items repeat a rule's own item, or never complete it. Each costs one scan.
    [
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${"5".repeat(64)}: ${"x".repeat(1_000_000)}`,
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${"5".repeat(64)}: ${"x".repeat(1_000_000)}`,
    ],
    [
      `report-recompute: MethodInputError: a: b: ${"c must carry one lowercase sha256 digesx ".repeat(25_000)}`,
      `report-recompute: MethodInputError: a: b: ${"c must carry one lowercase sha256 digesx ".repeat(25_000)}`,
    ],
    [
      `binary admission replay failed: ${"a.b: ".repeat(200_000)}`,
      `binary admission replay failed: ${"a.b: ".repeat(200_000)}`,
    ],
    [
      `sealed Report: invalid binary qualification: ${"qualification.arms must contain two or more arm; ".repeat(18_000)}`,
      `report.json: invalid binary qualification: ${"qualification.arms must contain two or more arm; ".repeat(18_000)}`,
    ],
    [
      `binary admission replay failed: admissionManifest: ${"x: digest references must be sorted and unique; ".repeat(20_000)}y`,
      `binary admission replay failed: admissionManifest: ${"x: fingerprint references must be sorted and unique; ".repeat(20_000)}y`,
    ],
  ]) {
    const started = performance.now();
    const result = await runVerifierCli(["bundle"], {
      verify: async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); },
    });
    const elapsed = performance.now() - started;
    assert.equal(result.stderr, `colophon-check: ${expected}\n`);
    assert.ok(elapsed < 1_500, `aliasing took ${Math.round(elapsed)}ms`);
  }
});

test("control characters in an unrecognized refusal are escaped, not emitted", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const result = await runVerifierCli(["bundle"], {
    verify: async () => { throw new Error("bundle.json\u001b[31m\ncolophon-check: bundle verified"); },
  });
  assert.equal(result.exitCode, 2);
  assert.doesNotMatch(result.stderr, CONTROL_CHARACTER_EXCEPT_LF);
  assert.equal(result.stderr.split("\n").length, 2, "one refusal is one line");
  assert.equal(result.stderr, "colophon-check: bundle.json\\u001b[31m\\u000acolophon-check: bundle verified\n");
});

test("a urn-shaped keyid keeps its failure reason on stderr", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const message = "report-authenticity: no valid signer binds to author/scope/time: "
    + "urn:x:y:envelope-signature-invalid, did:key:z6Mk:unknown";
  const verify = async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); };

  const human = await runVerifierCli(["bundle"], { verify });
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /<identifier: see --json>:envelope-signature-invalid, /u);
  assert.match(human.stderr, /<identifier: see --json>:unknown\n$/u);
  assert.doesNotMatch(human.stderr, /urn:|did:key/u);

  const json = await runVerifierCli(["bundle", "--json"], { verify });
  assert.equal(json.exitCode, 1);
  assert.equal(JSON.parse(json.stdout).message, message);
});

test("an anchor-trust read failure is sanitized", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const result = await runVerifierCli(["bundle", "--ots-headers", "broken.txt"], {
    readFile: () => { throw new Error("cannot read urn:x:secret\u001b[2K\rforged"); },
    verify: async () => { throw new Error("must not be reached"); },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /urn:/u);
  assert.doesNotMatch(result.stderr, CONTROL_CHARACTER_EXCEPT_LF);
  assert.equal(result.stderr.split("\n").length, 2, "one refusal is one line");
  assert.match(result.stderr, /^colophon-check: cannot read <identifier: see --json>/u);
});

/**
 * The evidence-native `/5` member of `PublicBundleVerificationResult`, named locally because the
 * published surface pins its `checks` to `typeof EVIDENCE_NATIVE_BUNDLE_V5_CHECKS`, which
 * `../dist/index.js` re-exports neither as a value nor as a type. The tuple is reachable through
 * `@jinn-network/benchmarking-evidence`, a direct dependency -- these fixtures cast that one field
 * rather than reach past the published surface these suites exist to exercise.
 *
 * @typedef {Extract<import("../dist/index.js").PublicBundleVerificationResult, { profile: string }>} V5Verification
 */

/**
 * Restores the `checks` tuple that a fixture cannot name. Every other field stays checked against
 * the real shape, which is the point: these are renderer fixtures, and the seam this project
 * exists to guard is `VerifierCliDeps`, not the renderer's argument.
 *
 * Fields absent from a fixture are absent on purpose -- each of these renderings exercises one
 * path, not a whole result -- so the parameter is partial. Every field that IS written stays
 * checked, and a misspelled one is still rejected.
 *
 * @param {Partial<Omit<V5Verification, "checks">>
 *   & { format: "benchmark-product-public-bundle/5", checks: readonly string[] }} fixture
 * @returns {V5Verification}
 */
function v5(fixture) {
  return /** @type {V5Verification} */ (/** @type {unknown} */ (fixture));
}

const V5_CHECKS = [
  "manifest", "evidence-closure", "artifact-integrity", "signature-validity",
  "matrix-rederivation", "report-verification", "claim-consistency",
];

/** @type {Omit<V5Verification, "profile" | "artifactContent" | "checks"> & { checks: readonly string[] }} */
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
  const output = renderVerifiedBundle(v5({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    artifactContent: { status: "verified", verified: 5, notFetched: 0, notFetchedDigests: [] },
  }));
  assert.match(output, /^Recomputed: 7 of 7 checks passed$/m);
  for (const check of V5_CHECKS) assert.match(output, new RegExp(`${check}\\s+passed`));
  assert.doesNotMatch(output, /not fetched/);
  assert.doesNotMatch(output, /Artifact content/);
});

test("a metadata-first v5 bundle discloses artifact-integrity as not fetched", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle(v5({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
    artifactContent: {
      status: "not-fetched",
      verified: 2,
      notFetched: 3,
      notFetchedDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    },
  }));
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
  const output = renderVerifiedBundle(v5({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
    artifactContent: {
      status: "not-fetched",
      verified: 2,
      notFetched: 1,
      notFetchedDigests: ["1".repeat(64)],
    },
  }));
  assert.match(output, /1 artifact body was not fetched/);
});

// ---------------------------------------------------------------------------
// The Run digest in the human output (issue #4972)
// ---------------------------------------------------------------------------
//
// `lock` prints `run <64 hex>` and the report page prints the Run SHA-256 the same way, so the
// checker prints the bare digest too: a reader holds the three against each other as strings, with
// no prefix to strip. The bundle identity above it keeps its `sha256:` prefix; it is a different
// value, on a line of its own.

const RUN_SHA256 = "c".repeat(64);
/** A complete six-check classic result, less the format that decides how it is counted. */
const RUN_DIGEST_RESULT = {
  identity: "a".repeat(64),
  checks: /** @type {const} */ ([
    "manifest", "evidence-closure", "trust", "matrix-rederivation",
    "report-verification", "claim-consistency",
  ]),
  benchmarkSha256: "b".repeat(64),
  runSha256: RUN_SHA256,
  matrixSha256: "d".repeat(64),
  reportSha256: "e".repeat(64),
  reportEnvelopeSha256: "f".repeat(64),
};
/** @type {readonly import("../dist/index.js").PublicBundleVerificationResult[]} */
const RUN_DIGEST_SHAPES = [
  // The oldest format and the composed one: a classic result carries `runSha256` whatever its
  // format number, and `/10` is the format the first `colophon-check` release is published for.
  { ...RUN_DIGEST_RESULT, format: "benchmark-product-public-bundle/2" },
  { ...RUN_DIGEST_RESULT, format: "benchmark-product-public-bundle/10", capabilities: [] },
];

test("the Run digest prints once, on the line under Format, as bare hex (issue #4972)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  for (const shape of RUN_DIGEST_SHAPES) {
    const lines = renderVerifiedBundle(shape).split("\n");
    assert.equal(lines[0], "Recomputed: 6 of 6 checks passed", shape.format);
    assert.equal(lines[1], `Bundle: sha256:${"a".repeat(64)}`, shape.format);
    assert.equal(lines[2], `Format: ${shape.format}`, shape.format);
    assert.equal(lines[3], `Run: ${RUN_SHA256}`, shape.format);
    // The blank line that separated the header from the caveats still does.
    assert.equal(lines[4], "", shape.format);
    assert.match(lines[5], /^Not checked by this tool:/, shape.format);
    assert.equal(lines.filter((line) => line.startsWith("Run:")).length, 1, shape.format);
  }
});

test("a /5 result carries no Run digest, so its output prints no Run line (issue #4972)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle(v5({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    artifactContent: { status: "verified", verified: 5, notFetched: 0, notFetchedDigests: [] },
  }));
  const lines = output.split("\n");
  assert.equal(lines[2], "Format: benchmark-product-public-bundle/5");
  assert.equal(lines[3], "");
  assert.match(lines[4], /^Not checked by this tool:/);
  assert.doesNotMatch(output, /^Run:/m);
});

test("the Run line is the runSha256 that --json already carries, and --json is unchanged (issue #4972)", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const shape of RUN_DIGEST_SHAPES) {
    const human = await runVerifierCli(["bundle"], { verify: async () => verified(shape) });
    assert.equal(human.exitCode, 0, shape.format);
    const machine = await runVerifierCli(["bundle", "--json"], { verify: async () => verified(shape) });
    assert.equal(machine.exitCode, 0, shape.format);
    const body = JSON.parse(machine.stdout);
    assert.equal(body.runSha256, RUN_SHA256, shape.format);
    assert.equal(human.stdout.split("\n")[3], `Run: ${body.runSha256}`, shape.format);
    // The machine body is the verification result under the three envelope keys, as before: the
    // human line adds no key and renames none.
    const { ok, verifierVersion, supportedFormats, ...result } = body;
    assert.equal(ok, true, shape.format);
    assert.equal(verifierVersion, "0.2.2", shape.format);
    assert.ok(Array.isArray(supportedFormats), shape.format);
    assert.deepEqual(result, shape, shape.format);
  }
});

test("the golden bundle's Run line is the SHA-256 of its run.json (issue #4972)", async () => {
  const golden = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1/golden", import.meta.url));
  const expected = createHash("sha256").update(await readFile(join(golden, "run.json"))).digest("hex");
  const human = await invoke([golden]);
  assert.equal(human.code, undefined);
  const lines = human.stdout.split("\n");
  assert.equal(lines[2], "Format: benchmark-product-public-bundle/2");
  assert.equal(lines[3], `Run: ${expected}`);
});

const INTERNAL_NAMESPACE = /jinn\.network|jinn\.benchmarking|urn:|did:key/;

test("the golden bundle's human surface names no internal protocol namespace", async () => {
  const golden = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1/golden", import.meta.url));
  const human = await invoke([golden]);
  assert.equal(human.code, undefined);
  assert.doesNotMatch(human.stdout, INTERNAL_NAMESPACE);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);
});

test("no tampered variant's refusal names an internal protocol namespace", async () => {
  const tamperedDir = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1/tampered", import.meta.url));
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

test("verify refusals keep protocol identifiers in --json and alias them for a human", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const kind = "https://spec.jinn.network/records/benchmark-matrix/v1";
  const deps = {
    verify: () => {
      const error = Object.assign(new Error(`disclosure-specification: the record's subject kind must be ${kind}`), { code: "record-integrity" });
      return Promise.reject(error);
    },
  };

  const human = await runVerifierCli(["bundle"], deps);
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /the record's subject kind must be <identifier: see --json>/);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);

  const json = await runVerifierCli(["bundle", "--json"], deps);
  assert.equal(json.exitCode, 1);
  assert.equal(JSON.parse(json.stdout).message, `disclosure-specification: the record's subject kind must be ${kind}`);
});

test("a kind-mismatch refusal remains a readable contrast after aliasing", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const declared = "https://spec.jinn.network/records/benchmark-matrix/v1";
  const deps = {
    verify: () => {
      const error = Object.assign(new Error(
        `carried anchor is invalid: subject.kind is ${declared}, but its digest resolves to this bundle's sealed Run`,
      ), { code: "record-integrity" });
      return Promise.reject(error);
    },
  };

  const human = await runVerifierCli(["bundle"], deps);
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /but the fingerprint it covers is this bundle's sealed run\.json/);
  assert.equal(human.stderr.match(/<identifier: see --json>/gu)?.length, 1);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);

  const json = await runVerifierCli(["bundle", "--json"], deps);
  assert.match(JSON.parse(json.stdout).message, /https:\/\/spec\.jinn\.network\/records\/benchmark-matrix\/v1/);
});

// Issue #5251, the reader-facing vocabulary spec's Refusal lines row (section 4.2): the human line
// names each concept by its section 5 name, and --json keeps the refusing module's message byte for
// byte, because the conformance kit's `expectedMessagePattern` and library callers read it.
test("a refusal's human line uses the reader's names while --json keeps the module's message", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const hex = "3".repeat(64);
  const admission = "binary admission replay failed: resolutions.0.reviews.0: ";
  for (const [message, human] of [
    [
      "Matrix v2 failed deterministic assembly-3.0 replay",
      "the runs do not follow from a deterministic assembly-3.0 replay of the evidence",
    ],
    [
      `carried anchor is invalid: the anchored digest ${hex} is neither this bundle's sealed Run nor its sealed Matrix`,
      `carried timestamp proof is invalid: the fingerprint it covers, ${hex}, is neither this bundle's sealed run.json nor its sealed matrix.json`,
    ],
    [
      "carried anchor is invalid: subject.kind is lock, but its digest resolves to this bundle's sealed Matrix",
      "carried timestamp proof is invalid: subject.kind is lock, but the fingerprint it covers is this bundle's sealed matrix.json",
    ],
    [
      "carried anchor is invalid: an authority-time lock anchor carries no comparable genTime",
      "carried timestamp proof is invalid: an authority-time lock timestamp proof carries no comparable genTime",
    ],
    [
      "carried anchor is invalid: no proof verifier implements the anchor profile example-profile",
      "carried timestamp proof is invalid: no proof verifier implements the profile example-profile",
    ],
    [
      "carried anchor is invalid: the proof does not verify",
      "carried timestamp proof is invalid: the proof does not verify",
    ],
    ["anchor record digest mismatch", "timestamp proof fingerprint mismatch"],
    ["evidence record digest mismatch", "evidence file fingerprint mismatch"],
    ['digest mismatch for "share.txt"', 'fingerprint mismatch for "share.txt"'],
    [
      `matrix-rederivation: re-derived digest sha256:${hex} !== received sha256:${"4".repeat(64)}`,
      `matrix-rederivation: re-derived fingerprint sha256:${hex} !== received sha256:${"4".repeat(64)}`,
    ],
    [
      "verdict catalog does not match Matrix verdict closure",
      "verdicts.json does not list exactly the verdicts the runs reference",
    ],
    [`verdict ${hex} evaluator mismatch`, `verdict ${hex} judge mismatch`],
    [
      "evaluator trust set must exactly equal Matrix-referenced evaluators",
      "the trusted judges must be exactly the judges the runs reference",
    ],
    [
      "evaluator one keyId is not derived from its SPKI",
      "judge <identifier: see --json> keyId is not derived from its SPKI",
    ],
    [
      `${admission}reviewer signature or evaluator/key binding is invalid`,
      `${admission}reviewer signature or judge/key binding is invalid`,
    ],
    [
      "binary admission replay failed: replacementLedger.entries.0.reviews.1: reviewer signature or evaluator/key binding is invalid",
      "binary admission replay failed: replacementLedger.entries.0.reviews.1: reviewer signature or judge/key binding is invalid",
    ],
    [
      `${admission}review verdict must be one Result Evaluation envelope with one signature`,
      `${admission}review verdict must be one DSSE-signed Result Evaluation with one signature`,
    ],
    [
      "report-envelope: invalid DSSE envelope: TrustCoreError: DSSE envelope payload is not strict standard or URL-safe base64.",
      "report-envelope: the signed result is not valid DSSE: payload is not strict standard or URL-safe base64.",
    ],
    [
      "Report author/keyId/didKey are not derived from the bundled Report SPKI",
      "the result's author/keyId/didKey are not derived from its bundled signing SPKI",
    ],
    [
      "report-recompute: recomputed results do not match the sealed Report results",
      "report-recompute: the recomputed result does not match the sealed result",
    ],
    [
      "claim package headline.baseline.passRate is not the exact projection of verified facts",
      "the claim's field headline.baseline.passRate does not agree with the records here",
    ],
    // A field path prints as written, even where its name is a contract spelling.
    [
      "claim package anchors is not the exact projection of verified facts",
      "the claim's field anchors does not agree with the records here",
    ],
  ]) {
    const verify = async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); };
    const result = await runVerifierCli(["bundle"], { verify });
    assert.equal(result.exitCode, 1, message);
    assert.equal(result.stderr, `colophon-check: ${human}\n`, message);

    const json = await runVerifierCli(["bundle", "--json"], { verify });
    assert.equal(json.exitCode, 1, message);
    assert.equal(json.stderr, "", message);
    assert.equal(JSON.parse(json.stdout).message, message);
  }
});

// Every rule is anchored at the message's start, the two admission-reviewer rules after an optional
// review path, so a rule's own words after other text, as publisher-chosen text can carry them,
// print unchanged. Each body is one rule's wording; removing any one rule's `^` changes its line.
test("refusal wording is rewritten only where a rule matches from the message's start", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const hex = "3".repeat(64);
  const lead = "carried timestamp proof is invalid: ";
  for (const body of [
    "Matrix v2 failed deterministic assembly-3.0 replay",
    "carried anchor is invalid: the proof does not verify",
    `${lead}the anchored digest ${hex} is neither this bundle's sealed Run nor its sealed Matrix`,
    `${lead}subject.kind is lock, but its digest resolves to this bundle's sealed Run`,
    `${lead}subject.kind is lock, but its digest resolves to this bundle's sealed Matrix`,
    `${lead}an authority-time lock anchor carries no comparable genTime`,
    `${lead}no proof verifier implements the anchor profile example-profile`,
    "anchor record digest mismatch",
    "evidence record digest mismatch",
    'digest mismatch for "share.txt"',
    `matrix-rederivation: re-derived digest sha256:${hex} !== received sha256:${hex}`,
    "verdict catalog does not match Matrix verdict closure",
    `verdict ${hex} evaluator mismatch`,
    "evaluator trust set must exactly equal Matrix-referenced evaluators",
    "evaluator <identifier: see --json> keyId is not derived from its SPKI",
    "report-envelope: invalid DSSE envelope: TrustCoreError: DSSE envelope payload is not strict standard or URL-safe base64.",
    "Report author/keyId/didKey are not derived from the bundled Report SPKI",
    "report-recompute: recomputed results do not match the sealed Report results",
    "claim package anchors is not the exact projection of verified facts",
    "reviewer signature or evaluator/key binding is invalid",
    "review verdict must be one Result Evaluation envelope with one signature",
  ]) {
    const message = `unknown member: ${body}`;
    const result = await runVerifierCli(["bundle"], {
      verify: async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); },
    });
    assert.equal(result.stderr, `colophon-check: ${message}\n`, message);
  }
});

// Issue #5299: the refusal templates the characterization suite never reaches, ruled against the
// same section 5 glossary. Each row is one module's message and the human line a reader gets; --json
// keeps the message byte for byte. `src/reader-vocabulary-conformance.test.ts` reads every template
// from the source and fails on one that still carries a hidden or renamed word without a reason.
const READER_WORDING_5299 = (() => {
  const hex = "5".repeat(64);
  const replay = "binary admission replay failed: ";
  return [
    // Labels: the page builder names the record it read, the claim builder the claim.
    ["sealed Report: invalid binary qualification: arms is empty", "report.json: invalid binary qualification: arms is empty"],
    ["stored claim package: expected a {lower, upper, alpha} interval", "claim-package.json: expected a {lower, upper, alpha} interval"],
    ['claim package: binary-instrument version "2" is not supported', 'the claim: binary-instrument version "2" is not supported'],
    ['sealed Report: method "example" has no bundle-asset projection', `report.json: method "example" has no presentation on the bundle's pages`],
    [
      "stored claim package: expected exactly one subject (this product's single-Matrix Report shape)",
      "claim-package.json: expected results over exactly one matrix.json (this product's shape)",
    ],
    [
      "claim package: expected exactly one Report subject (this product's single-Matrix Report shape)",
      "the claim: expected results over exactly one matrix.json (this product's shape)",
    ],
    ["sealed Report: arm baseline lacks exact wilson@1 facts", "report.json: configuration baseline lacks exact wilson@1 facts"],
    [
      "claim package: Report results do not carry paired-delta@1's comparison shape",
      "the claim: the result does not carry paired-delta@1's comparison shape",
    ],
    ['claim package: method "example" has no claim-package projection', 'the claim: no claim can be derived for method "example"'],
    [
      "claim package: only the anchored binary-qualification closure carries a disclosure section — this projection has no qualification, and no other closure version expresses one",
      "the claim: only the anchored binary-qualification closure carries a section on what was pinned — this claim has no qualification, and no other closure version expresses one",
    ],
    // The admission replay: its lead and field paths print as written.
    [`${replay}resolutions.0.reviews.1.packet: record digest is not canonical sha256`, `${replay}resolutions.0.reviews.1.packet: record fingerprint is not in canonical form`],
    ["admissionManifestSha256: record digest is not canonical sha256", "admissionManifestSha256: record fingerprint is not in canonical form"],
    [
      "screeningSampleCommitment: screeningTable.sampleCommitmentSha256: record digest is not canonical sha256",
      "screeningSampleCommitment: screeningTable.sampleCommitmentSha256: record fingerprint is not in canonical form",
    ],
    [`${replay}resolutions.2.operatorAssertion: authority evidence is not an exact compact DSSE envelope`, `${replay}resolutions.2.operatorAssertion: authority evidence is not exact compact DSSE`],
    [`${replay}replacementLedger.entries.0.reviews.1: review verdict is not an exact compact DSSE envelope`, `${replay}replacementLedger.entries.0.reviews.1: review verdict is not exact compact DSSE`],
    [`${replay}screeningTable.rows: v2 table must cover all 664 pool item digests in sorted order`, `${replay}screeningTable.rows: v2 table must cover all 664 pool item fingerprints in sorted order`],
    ["resolutions.3: reviewers must have distinct evaluator identities and keys", "resolutions.3: reviewers must have distinct judge identities and keys"],
    [`${replay}replacementLedger.entries.1: roster does not bind the exact reviewer evaluator/key pairs`, `${replay}replacementLedger.entries.1: roster does not bind the exact reviewer judge/key pairs`],
    [
      `${replay}replacementLedger.entries.1: two-human ledger entry is missing its required review evidence digests`,
      `${replay}replacementLedger.entries.1: two-human ledger entry is missing its required review evidence fingerprints`,
    ],
    // Timestamp proofs, as the claim's anchors are projected.
    [
      "anchor record is not the exact sealed encoding of a conforming AnchorEvidence: unexpected field",
      "the timestamp proof is not the exact sealed encoding of a conforming AnchorEvidence: unexpected field",
    ],
    [
      `anchor covers ${hex}, which is neither this bundle's sealed Run nor its sealed Matrix`,
      `the timestamp proof covers ${hex}, which is neither this bundle's sealed run.json nor its sealed matrix.json`,
    ],
    ["anchor names subject kind lock, but the record its digest resolves to is matrix", "the timestamp proof's subject.kind is lock, but the record it covers is matrix"],
    ["no proof verifier implements the anchor profile example-profile", "no proof verifier implements the profile example-profile"],
    // Fingerprints.
    ["Task has an invalid digest", "Task has an invalid fingerprint"],
    ["solve output has an invalid digest", "solve output has an invalid fingerprint"],
    ["binary Task has no EvaluationSpec digest", "binary Task has no EvaluationSpec fingerprint"],
    [`${hex}/baseline/1 Task has no EvaluationSpec digest`, `${hex}/baseline/1 Task has no EvaluationSpec fingerprint`],
    [`${hex}/arm A/1 final solve Submission digest disagrees`, `${hex}/arm A/1 final solve Submission fingerprint disagrees`],
    // Runs.
    [`comparison cell ${hex}/baseline/1 is absent from the verified assembly`, `comparison run ${hex}/baseline/1 is absent from the verified assembly`],
    [`comparison cell ${hex}/baseline/1 names an unknown Task`, `comparison run ${hex}/baseline/1 names an unknown Task`],
    ["assembly does not cover every expected cell", "assembly does not cover every expected run"],
    [`solve Submission ${hex} names an unknown cell`, `solve Submission ${hex} names an unknown run`],
    [`evaluation Submission ${hex} names an unknown cell`, `evaluation Submission ${hex} names an unknown run`],
    [`solve Delivery ${hex} names an unknown cell`, `solve Delivery ${hex} names an unknown run`],
    [`solve Submission ${hex} dispatch is outside its cell lineage`, `solve Submission ${hex} dispatch is outside its run lineage`],
    [`solve Delivery ${hex} is outside its exact cell lineage`, `solve Delivery ${hex} is outside its exact run lineage`],
    [`solve Delivery ${hex} does not bind its cell Task/attempt`, `solve Delivery ${hex} does not bind its run's Task/attempt`],
    [`evaluation Submission ${hex} is outside its cell/evaluator domain`, `evaluation Submission ${hex} is outside its run/judge domain`],
    ["evaluation graph names an unknown cell", "evaluation graph names an unknown run"],
    ["terminal evaluation is outside its exact cell/index lineage", "terminal evaluation is outside its exact run/index lineage"],
    [
      "evaluation graph contains a successful lineage not consumed by an exact cell verdict",
      "evaluation graph contains a successful lineage not consumed by an exact run verdict",
    ],
    [`verdict ${hex} cell references do not match Matrix`, `verdict ${hex} run references do not match matrix.json`],
    ["external-import.json names a cellKey more than once", "external-import.json names a run more than once"],
    ["external-import.json rows are not exactly the sealed Matrix cell keys", "external-import.json rows are not exactly the runs in the sealed matrix.json"],
    ["separate Inspect assurance contains an embedded Matrix vote", "separate Inspect assurance contains an embedded vote on the runs"],
    // Configurations.
    ["qualification does not exactly cover the Run arm set", "qualification does not exactly cover the sealed Run's configurations"],
    ["Run arm candidate instrument pin differs", "Run configuration candidate judge pin differs"],
    ["Run arm candidate has no exact judge-instrument pin", "Run configuration candidate has no exact judge pin"],
    ["binary runtime selection arms differ from qualification and Run pins", "binary runtime selection configurations differ from qualification and Run pins"],
    ["snapshot-serving probe model is not the model of any bound arm", "snapshot-serving probe model is not the model of any bound configuration"],
    ["Inspect Delivery has no exact selected arm configuration", "Inspect Delivery has no exact selected configuration"],
    ["credential-free Inspect arm carries provider evidence", "credential-free Inspect configuration carries provider evidence"],
    ["Inspect provider evidence differs from the sealed arm/runtime selection", "Inspect provider evidence differs from the sealed configuration/runtime selection"],
    ["the screening instrument is reused as a run judge arm", "the screening instrument is reused as a run judge configuration"],
    // Judges.
    [`instrument sha256:${hex} is missing`, `judge sha256:${hex} is missing`],
    [`instrument sha256:${hex} is invalid: unexpected field`, `judge sha256:${hex} is invalid: unexpected field`],
    ["instrument is not exact canonical profile bytes", "the judge record is not exact canonical profile bytes"],
    ["same-execution Inspect score carries false separate-evaluator lineage", "same-execution Inspect score carries false separate-judge lineage"],
    ["pre-evaluation terminal cannot claim an evaluator identity", "pre-evaluation terminal cannot claim a judge identity"],
    ["partial evaluation lineage must name its evaluator and exact Task", "partial evaluation lineage must name its judge and exact Task"],
    // The result and its limitations.
    [
      "a Report carrying example-extension is publishable only on benchmark-product-public-bundle/8",
      "a result carrying example-extension is publishable only on benchmark-product-public-bundle/8",
    ],
    [
      "bundle format benchmark-product-public-bundle/7 declares a qualifying closure, but its sealed Report declares method example",
      "bundle format benchmark-product-public-bundle/7 declares a qualifying closure, but its sealed report.json declares method example",
    ],
    ["a benchmark-product-public-bundle/8 bundle must carry example-extension on its Report", "a benchmark-product-public-bundle/8 bundle must carry example-extension on its report.json"],
    [
      'a benchmark-product-public-bundle/10 "disclosure-specification" bundle must carry example-extension on its Report',
      'a benchmark-product-public-bundle/10 "disclosure-specification" bundle must carry example-extension on its report.json',
    ],
    [
      "the bundle does not carry the disclosure-specification record its Report names",
      "the bundle does not carry the disclosure-specification record its report.json names",
    ],
    ["verified Report payload does not match report.json", "the verified result's payload does not match report.json"],
    ["verified Report identity is absent", "the verified result's identity is absent"],
    ["report trust keyId must equal didKey", "the result's signing keyId must equal its didKey"],
    [
      "Report limitations carry the publication-source sentence, but the bundle does not declare owner-controlled-publication",
      "the result's limitations carry the publication-source sentence, but the bundle does not declare owner-controlled-publication",
    ],
    [
      "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history",
      "the result's limitations are not exactly the ones derived from the sealed Run and rehearsal history",
    ],
    ["claim rehearsal and verified Report disclosure disagree", "the claim's rehearsal and the verified result's limitations disagree"],
    [
      "a bundle declaring owner-controlled-publication must seal the publication-source sentence in its Report limitations, right after the venue sentences",
      "a bundle declaring owner-controlled-publication must seal the publication-source sentence in its result's limitations, right after the sentences on where it ran",
    ],
    [
      "a bundle declaring terminal-bench-2-1-comparability must seal the comparability sentence once in its Report limitations, right after the venue and binary-instrument lines",
      "a bundle declaring terminal-bench-2-1-comparability must seal the comparability sentence once in its result's limitations, right after the lines on where it ran and the binary-instrument lines",
    ],
    [
      'the sealed Run declares task selection "operator-chosen", but this bundle does not declare the "task-selection" capability that states it on the report face; a bundle cannot pass while hiding who chose its tasks',
      `the sealed Run declares task selection "operator-chosen", but this bundle does not declare the "task-selection" capability that states it on the bundle's pages; a bundle cannot pass while hiding who chose its tasks`,
    ],
    // Records named by a hidden noun.
    ["the bundle's evidence catalog does not match the pinned v4 grammar", "the bundle's evidence.json does not match the pinned v4 grammar"],
    ["the bundle's evidence catalog assigns no freeze-artifact role", "the bundle's evidence.json assigns no freeze-artifact role"],
    ["evidence catalog contains missing or unreachable records", "evidence.json lists missing or unreachable records"],
    [`EvaluationSpec ${hex} is not in the catalog`, `EvaluationSpec ${hex} is not among the EvaluationSpecs read for the runs' Tasks`],
    ["static bundle is not the exact platform metadata projection", "static-bundle.json is not exactly the platform metadata derived from matrix.json and report.json"],
    ["qualification admission projection differs from portable replay", "qualification.json's admission fields differ from the portable replay"],
    [
      "a benchmark-product-public-bundle/7 bundle's qualification document must keep its frozen benchmark-product.claim-package/2 projection literal",
      "a benchmark-product-public-bundle/7 bundle's qualification.json must keep claimSchema at its frozen benchmark-product.claim-package/2 value",
    ],
    ["index.html is not the exact projection of verified public facts", "index.html is not exactly the file rebuilt from the verified public facts"],
    ["claim externalImport section is not the exact projection of the authenticated marker", "the claim's externalImport section does not agree with the authenticated marker"],
    ["Inspect summary measurement count differs from the sealed projections", "Inspect summary measurement count differs from the sealed scoring.projections"],
    ["Inspect summary measurement differs from its sealed projection", "Inspect summary measurement differs from its sealed scoring.projections entry"],
    ["Inspect summary differs from its sealed scorer projections", "Inspect summary differs from its sealed scoring.projections"],
    ["verdict envelope payload is not valid JSON", "the signed verdict's payload is not valid JSON"],
    ["verdict envelope carries duplicate measurement names", "the signed verdict carries duplicate measurement names"],
    [
      'this bundle declares the "task-selection" capability, but its sealed Run carries no task-selection/v1 declaration for it to state',
      'this bundle declares the "task-selection" capability, but its sealed Run carries no task-selection/v1 for it to state',
    ],
  ];
})();

test("the refusals the characterization suite never reaches use the reader's names, and --json keeps the module's message", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const [message, human] of READER_WORDING_5299) {
    const verify = async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); };
    const result = await runVerifierCli(["bundle"], { verify });
    assert.equal(result.exitCode, 1, message);
    assert.equal(result.stderr, `colophon-check: ${human}\n`, message);

    const json = await runVerifierCli(["bundle", "--json"], { verify });
    assert.equal(json.stderr, "", message);
    assert.equal(JSON.parse(json.stdout).message, message);
  }
});

// The same rules, after text a publisher could choose: each prints unchanged, so no rule rewords text
// that does not start where its module's words start.
test("the #5299 refusal wording is rewritten only where a rule matches from the message's start", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const [body] of READER_WORDING_5299) {
    const message = `unknown member: ${body}`;
    const result = await runVerifierCli(["bundle"], {
      verify: async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); },
    });
    assert.equal(result.stderr, `colophon-check: ${message}\n`, message);
  }
});

// Issue #5373: text the platform packages write, and the check package's own schema issue messages,
// where the refusal inventory reaches a line with them. Each row is the message as the reader's CLI
// receives it (bare, behind the wrapper that carries it, or as the detail the result's recomputation
// reports) and the human line a reader gets; --json keeps the message byte for byte. Every rule the
// #5373 block of READER_WORDING adds rewrites at least one row. The last rows join several issues
// with `; `: a rule rewords its item wherever it stands in the list, as often as it appears.
const READER_WORDING_5373 = (() => {
  const hex = "5".repeat(64);
  return [
    ["A DSSE envelope requires at least one signature.", "the DSSE-signed record requires at least one signature."],
    ["DSSE envelope bytes are not the exact producer encoding.", "the DSSE-signed record's bytes are not the exact producer encoding."],
    [
      "report-envelope: invalid DSSE envelope: TrustCoreError: A DSSE envelope requires at least one signature.",
      "report-envelope: the signed result is not valid DSSE: it carries no signature.",
    ],
    // The same refusals, carried through a method-input wrapper that also prints its record.
    [
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: TrustCoreError: DSSE envelope payloadType must be a string.`,
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: TrustCoreError: the DSSE-signed record's payloadType must be a string.`,
    ],
    [
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: TrustCoreError: DSSE envelope requires at least one signature.`,
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: TrustCoreError: the DSSE-signed record requires at least one signature.`,
    ],
    [
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: Error: entry previous must be null or an exact lowercase sha256 digest`,
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: Error: entry previous must be null or an exact fingerprint in lowercase hex`,
    ],
    [
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: Error: signed entry does not announce the requested Benchmark digest`,
      `report-recompute: MethodInputError: anchored-announcement-malformed: sha256:${hex}: Error: signed entry does not announce the requested Benchmark fingerprint`,
    ],
    [
      "anchor record is not the exact sealed encoding of a conforming AnchorEvidence: Anchor-evidence bytes are not the exact sealed encoding.",
      "the timestamp proof is not the exact sealed encoding of a conforming AnchorEvidence: its bytes are not the exact sealed encoding.",
    ],
    [
      "carried anchor is invalid: ESSCertIDv2.hashAlgorithm names digest algorithm 1.3.14.3.2.26, which is not admitted.",
      "carried timestamp proof is invalid: ESSCertIDv2.hashAlgorithm names hash algorithm 1.3.14.3.2.26, which is not admitted.",
    ],
    [
      "carried anchor is invalid: RSASSA-PSS carries no parameters, so its digest defaults to SHA-1 (§6.1 rule 5).",
      "carried timestamp proof is invalid: RSASSA-PSS carries no parameters, so its hash defaults to SHA-1 (§6.1 rule 5).",
    ],
    [
      "carried anchor is invalid: The file digest operation is 0x02; this profile admits SHA-256 (0x08) only.",
      "carried timestamp proof is invalid: The file hash operation is 0x02; this profile admits SHA-256 (0x08) only.",
    ],
    [
      "carried anchor is invalid: The messageDigest attribute is not the digest of eContent (§6.1 rule 4).",
      "carried timestamp proof is invalid: The messageDigest attribute is not the hash of eContent (§6.1 rule 4).",
    ],
    [
      "carried anchor is invalid: TSTInfo.tsa is not among the signer certificate's subject names (§6.1 rule 10).",
      "carried timestamp proof is invalid: TSTInfo.tsa is not among the names the signer certificate is issued to (§6.1 rule 10).",
    ],
    [
      `carried anchor is invalid: The proof is detached from ${hex}, not from the subject ${hex}.`,
      `carried timestamp proof is invalid: The proof is detached from ${hex}, not from the covered record's fingerprint ${hex}.`,
    ],
    [
      "carried anchor is invalid: The subject digest is not 64 hex characters.",
      "carried timestamp proof is invalid: The covered record's fingerprint is not 64 hex characters.",
    ],
    [
      "carried anchor is invalid: messageImprint.hashAlgorithm is 1.3.14.3.2.26; the caller's subject digest is a SHA-256 and cannot be compared to it (§6.1 rule 12).",
      "carried timestamp proof is invalid: messageImprint.hashAlgorithm is 1.3.14.3.2.26; the covered record's fingerprint is a SHA-256 hash and cannot be compared to it (§6.1 rule 12).",
    ],
    [
      "carried anchor is invalid: messageImprint.hashedMessage is not the subject digest (§6.1 rule 12).",
      "carried timestamp proof is invalid: messageImprint.hashedMessage is not the covered record's fingerprint (§6.1 rule 12).",
    ],
    [
      `malformed cellKey task digest (must be 64 lowercase hex digits): ${hex}/x/1`,
      `malformed cellKey task fingerprint (must be 64 lowercase hex digits): ${hex}/x/1`,
    ],
    [
      `malformed cellKey replicate (must be 1-based minimal decimal): ${hex}/x/1`,
      `malformed cellKey repeat (must be 1-based minimal decimal): ${hex}/x/1`,
    ],
    ["expected cell set exceeds MAX_MATERIALIZED_CELLS (1000000): 1500000", "the expected set of runs exceeds the cap of 1000000 runs: 1500000"],
    [
      "expected cell cardinality exceeds Number.MAX_SAFE_INTEGER: 9007199254740993",
      "the expected number of runs exceeds Number.MAX_SAFE_INTEGER: 9007199254740993",
    ],
    [
      "Benchmark item's task descriptor lacks a sha256 digest (schema invariant violated)",
      "Benchmark item's task descriptor lacks a fingerprint (schema invariant violated)",
    ],
    [
      `artifacts/${hex}.bin digest does not match its exact descriptor`,
      `artifacts/${hex}.bin fingerprint does not match its exact descriptor`,
    ],
    ["claim-package/3 evidence closure differs from records/", "the claim's evidence closure differs from records/"],
    [
      "claim-package/3 is inconsistent with the exact evidence-native chain",
      "the claim is inconsistent with the exact evidence-native chain",
    ],
    ["report.json differs from the signed Report v3 payload", "report.json differs from the signed v3 result's payload"],
    ["Report v3 signature is invalid or unbound", "the v3 result's signature is invalid or unbound"],
    ["Report v3 envelope has the wrong payload type", "the signed v3 result has the wrong payload type"],
    ["Report v2 must subject the exact Matrix v2 bytes", "the v2 result must name the exact v2 matrix.json bytes as its input"],
    [
      "matrix-rederivation: exact matrix bytes are required for verifyMatrix",
      "matrix-rederivation: the exact bytes of matrix.json are required for verifyMatrix",
    ],
    [
      "matrix-rederivation: re-derived matrix bytes diverge at offset 0",
      "matrix-rederivation: the runs re-derived from the evidence diverge from matrix.json at offset 0",
    ],
    [
      "evaluator-independence: evaluator Agent IRI is not distinct from solver",
      "evaluator-independence: judge Agent IRI is not distinct from solver",
    ],
    [
      "evaluator-independence: solver or evaluator unresolved (fail-closed)",
      "evaluator-independence: solver or judge unresolved (fail-closed)",
    ],
    [
      "verdict-spec-match: verdict lacks a digest-shaped evaluationSpecification and task has no pinned digest",
      "verdict-spec-match: verdict lacks a fingerprint-shaped evaluationSpecification and task has no pinned fingerprint",
    ],
    [
      "report-authenticity: Report envelope has no signer keyid to bind to author",
      "report-authenticity: the signed result has no signer keyid to bind to author",
    ],
    [
      "report-envelope: Report payload bytes are not the exact canonical encoding",
      "report-envelope: the result's payload bytes are not the exact canonical encoding",
    ],
    [
      "report-envelope: invalid Report payload: IJsonNumberError: number is not an exact I-JSON integer: x",
      "report-envelope: invalid result payload: IJsonNumberError: number is not an exact I-JSON integer: x",
    ],
    [
      "report-recompute: exact subject bytes/order do not match the sealed Report subjects",
      "report-recompute: the exact matrix.json bytes, in order, do not match the runs the sealed result names",
    ],
    [
      "disclosures-faithfulness: recomputed per-subject disclosures do not match the exact subject bytes/order",
      "disclosures-faithfulness: what was pinned, recomputed from the exact matrix.json bytes in order, does not match the sealed result",
    ],
    [
      `disclosures-faithfulness: Error: subject ${hex} is not a valid Matrix: IJsonNumberError: number is not an exact I-JSON integer: x`,
      `disclosures-faithfulness: Error: matrix.json ${hex} is not valid: IJsonNumberError: number is not an exact I-JSON integer: x`,
    ],
    [
      `disclosures-faithfulness: Error: subject ${hex} is not the exact canonical Matrix encoding`,
      `disclosures-faithfulness: Error: matrix.json ${hex} is not in exact canonical encoding`,
    ],
    [
      `benchmark-comparability: subjects resolve to distinct Benchmark digests: ${hex}`,
      `benchmark-comparability: the result's runs resolve to distinct Benchmark fingerprints: ${hex}`,
    ],
    [
      "benchmark-comparability: version-robust result does not disclose exact paired Task digests",
      "benchmark-comparability: version-robust result does not disclose exact paired Task fingerprints",
    ],
    [
      "benchmark-comparability: version-robust cross-Benchmark result has no exact shared Task-digest pairing",
      "benchmark-comparability: version-robust cross-Benchmark result has no exact shared Task-fingerprint pairing",
    ],
    [
      "benchmark-comparability: version-robust cross-Benchmark results must disclose one identical Task-digest pairing per subject",
      "benchmark-comparability: version-robust cross-Benchmark results must disclose one identical Task-fingerprint pairing for each set of runs",
    ],
    [
      "benchmark-comparability: version-robust pairing includes a Task digest not shared by every subject",
      "benchmark-comparability: version-robust pairing includes a Task fingerprint not shared by every set of runs",
    ],
    [
      `report-recompute: Error: method subjectSha256 is not an exact lowercase sha256: ${hex}`,
      `report-recompute: Error: method subjectSha256 is not an exact fingerprint in lowercase hex: ${hex}`,
    ],
    [
      `report-recompute: Error: method subjectSha256 ${hex} does not match canonical Matrix digest ${hex}`,
      `report-recompute: Error: method subjectSha256 ${hex} does not match the canonical matrix.json fingerprint ${hex}`,
    ],
    [
      `report-recompute: Error: method subject identity is duplicated: ${hex}`,
      `report-recompute: Error: the method is given the same matrix.json twice: ${hex}`,
    ],
    [
      "report-recompute: Error: clean-subset@1: delegate did not preserve the restricted subject identity",
      "report-recompute: Error: clean-subset@1: delegate did not preserve the identity of the restricted runs",
    ],
    [
      "report-recompute: Error: entry previous must be null or an exact lowercase sha256 digest",
      "report-recompute: Error: entry previous must be null or an exact fingerprint in lowercase hex",
    ],
    [
      "report-recompute: Error: signed entry does not announce the requested Benchmark digest",
      "report-recompute: Error: signed entry does not announce the requested Benchmark fingerprint",
    ],
    ["report-recompute: Error: instrument arm ids must be unique", "report-recompute: Error: the judges' configuration ids must be unique"],
    ["report-recompute: Error: invalid instrument digest for x", "report-recompute: Error: invalid judge fingerprint for configuration x"],
    [
      "report-recompute: Error: invalid paired-majority-delta@1 parameters: parameters \"baseline\" and \"candidate\" must name distinct arms",
      "report-recompute: Error: invalid paired-majority-delta@1 parameters: parameters \"baseline\" and \"candidate\" must name distinct configurations",
    ],
    [
      "sealed Report: invalid binary qualification: qualification cell keys must be unique across item groups",
      "report.json: invalid binary qualification: qualification runs must be unique across item groups",
    ],
    [
      "sealed Report: invalid binary qualification: qualification task x must carry exactly one group for every arm",
      "report.json: invalid binary qualification: qualification task x must carry exactly one group for every configuration",
    ],
    [
      "sealed Report: invalid binary qualification: qualification.arms must bind distinct instruments per arm",
      "report.json: invalid binary qualification: qualification.arms must bind a distinct judge for each configuration",
    ],
    [
      "sealed Report: invalid binary qualification: qualification.arms must contain two or more arms",
      "report.json: invalid binary qualification: qualification.arms must contain two or more configurations",
    ],
    [
      "sealed Report: invalid binary qualification: qualification.conflicted contains an unknown cell key",
      "report.json: invalid binary qualification: qualification.conflicted contains an unknown run",
    ],
    [
      `report-recompute: MethodInputError: anchored-announcement-unavailable: sha256:${hex}: resolver returned no exact signed Discovery Entry envelope bytes`,
      `report-recompute: MethodInputError: anchored-announcement-unavailable: sha256:${hex}: resolver returned no exact DSSE-signed Discovery Entry bytes`,
    ],
    [
      `report-recompute: MethodInputError: anchored-announcement-unverified: sha256:${hex}: verification proof does not bind the exact source, entry chain, head anchor, and derived time`,
      `report-recompute: MethodInputError: anchored-announcement-unverified: sha256:${hex}: verification proof does not bind the exact source, entry chain, timestamp proof of the head, and derived time`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: Result Evaluation does not bind the exact Matrix Task`,
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: Result Evaluation does not bind the exact Task its run names`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: parser-invalid output does not match the sealed instrument policy`,
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: the decision on an answer that could not be read does not match the sealed judge record's policy`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: signed instrument drifts from the Run arm pin`,
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: the signed judge drifts from the Run configuration's judge pin`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: sole Result Evaluation is reused across Matrix cells x and ${hex}/x/1`,
      `report-recompute: MethodInputError: binary-binding-mismatch: ${hex}: sole Result Evaluation is reused across runs x and ${hex}/x/1`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: EvaluationSpec drifts from the frozen binary evaluator contract`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: EvaluationSpec drifts from the frozen binary judge contract`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: EvaluationSpec grader digest is not the frozen binary evaluator semantics`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: EvaluationSpec grader fingerprint is not the frozen binary judge semantics`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: Run arms do not exactly cover Matrix arms`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: the sealed Run's configurations do not exactly cover matrix.json's configurations`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: Task must remain arm-neutral and cannot pin an instrument`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: Task must remain configuration-neutral and cannot pin a judge`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: binary-instrument@1 requires distinct instruments across arms`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: binary-instrument@1 requires a distinct judge for each configuration`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: binary-instrument@1 requires two or more matching, distinct Run and Matrix arms`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: binary-instrument@1 requires two or more distinct configurations, matching between the sealed Run and matrix.json`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: judge observation drifts from its exact Matrix cell or semantic request`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: judge observation drifts from its exact run or semantic request`,
    ],
    [
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: judge observation limitations are not the frozen per-profile disclosure`,
      `report-recompute: MethodInputError: binary-binding-mismatch: sha256:${hex}: judge observation limitations are not the frozen per-profile limitations`,
    ],
    [
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${hex}: judge observation cannot resolve its instrument's declared model`,
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${hex}: judge observation cannot resolve its judge record's declared model`,
    ],
    [
      "report-recompute: MethodInputError: binary-binding-mismatch: x: instrument generation drifts from the frozen x call policy",
      "report-recompute: MethodInputError: binary-binding-mismatch: x: the judge record's generation drifts from the frozen x call policy",
    ],
    [
      "report-recompute: MethodInputError: binary-binding-mismatch: x: instrument identity does not match the Run arm",
      "report-recompute: MethodInputError: binary-binding-mismatch: x: the judge record's identity does not match its Run configuration",
    ],
    [
      "report-recompute: MethodInputError: binary-binding-mismatch: x: instrument prompt digest does not match its message templates",
      "report-recompute: MethodInputError: binary-binding-mismatch: x: the judge record's prompt fingerprint does not match its message templates",
    ],
    [
      "report-recompute: MethodInputError: binary-binding-mismatch: x: instrument must use the jinn-openai adapter and a declared judge model",
      "report-recompute: MethodInputError: binary-binding-mismatch: x: the judge record must use the jinn-openai adapter and a declared judge model",
    ],
    [
      "report-recompute: MethodInputError: binary-binding-mismatch: x: instrument invalidOutputDecision does not match its registered parser pair",
      "report-recompute: MethodInputError: binary-binding-mismatch: x: the judge record's invalidOutputDecision does not match its registered parser pair",
    ],
    [
      "report-recompute: MethodInputError: binary-record-digest-mismatch: x: arm x instrument bytes hash to x",
      "report-recompute: MethodInputError: binary-record-digest-mismatch: x: configuration x's judge record bytes hash to x",
    ],
    [
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${hex}: Run arm x instrument pin must be sha256:<64 lowercase hex>`,
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${hex}: Run configuration x's judge pin must be sha256:<64 lowercase hex>`,
    ],
    [
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${hex}: analysis-context.json digest has an unsupported field set`,
      `report-recompute: MethodInputError: binary-record-malformed: sha256:${hex}: analysis-context.json's fingerprint field has an unsupported field set`,
    ],
    [
      `report-recompute: MethodInputError: verdict-record-malformed: ${hex}: invalid DSSE envelope: x`,
      `report-recompute: MethodInputError: verdict-record-malformed: ${hex}: not valid DSSE: x`,
    ],
    [
      `report-recompute: MethodInputError: binary-record-malformed: ${hex}: Task subject digest must carry one lowercase sha256 digest`,
      `report-recompute: MethodInputError: binary-record-malformed: ${hex}: Task subject digest must carry one fingerprint in lowercase hex`,
    ],
    [
      `report-recompute: MethodInputError: verdict-record-malformed: ${hex}: every subject must carry one exact lowercase sha256 digest`,
      `report-recompute: MethodInputError: verdict-record-malformed: ${hex}: every subject must carry one exact fingerprint in lowercase hex`,
    ],
    [
      "report-recompute: MethodInputError: binary-record-malformed: x: reviewVerdictSha256s must be a strictly sorted unique pair of sha256 digests",
      "report-recompute: MethodInputError: binary-record-malformed: x: reviewVerdictSha256s must be a strictly sorted unique pair of fingerprints",
    ],
    [
      "report-recompute: BinaryInstrumentReductionError: context-drift: contexts must name every and only Matrix Task exactly once",
      "report-recompute: BinaryInstrumentReductionError: context-drift: contexts must name every and only Task in matrix.json exactly once",
    ],
    [
      `report-recompute: BinaryInstrumentReductionError: duplicate-coordinate: Matrix repeats ${hex}/x/x`,
      `report-recompute: BinaryInstrumentReductionError: duplicate-coordinate: matrix.json repeats ${hex}/x/x`,
    ],
    [
      "report-recompute: BinaryInstrumentReductionError: incomplete-coordinate-set: Matrix is not the exact task x arm x 1..x cell set",
      "report-recompute: BinaryInstrumentReductionError: incomplete-coordinate-set: matrix.json is not the exact task x configuration x 1..x set of runs",
    ],
    [
      `report-recompute: BinaryInstrumentReductionError: instrument-drift: ${hex}/x/1 does not carry arm x's expected instrument`,
      `report-recompute: BinaryInstrumentReductionError: instrument-drift: ${hex}/x/1 does not carry configuration x's expected judge`,
    ],
    [
      "report-recompute: BinaryInstrumentReductionError: instrument-drift: duplicate instrument for arm x",
      "report-recompute: BinaryInstrumentReductionError: instrument-drift: duplicate judge for configuration x",
    ],
    [
      "report-recompute: BinaryInstrumentReductionError: instrument-drift: instruments must name every and only Matrix arm exactly once",
      "report-recompute: BinaryInstrumentReductionError: instrument-drift: judges must name every and only configuration in matrix.json exactly once",
    ],
    [
      "report-recompute: BinaryInstrumentReductionError: invalid-subject: Matrix must contain at least one cell",
      "report-recompute: BinaryInstrumentReductionError: invalid-subject: matrix.json must contain at least one run",
    ],
    [
      `report-recompute: BinaryInstrumentReductionError: unknown-cell-input: cell ${hex}/x/1 without a sole valid verdict carries a parsed evaluation`,
      `report-recompute: BinaryInstrumentReductionError: unknown-cell-input: run ${hex}/x/1 without a sole valid verdict carries a parsed evaluation`,
    ],
    [
      `report-recompute: BinaryInstrumentReductionError: unknown-cell-input: non-judged cell ${hex}/x/1 carries a parsed evaluation`,
      `report-recompute: BinaryInstrumentReductionError: unknown-cell-input: non-judged run ${hex}/x/1 carries a parsed evaluation`,
    ],
    [
      `report-recompute: BinaryInstrumentReductionError: unknown-cell-input: parsed input names non-Matrix cell ${hex}/x/1`,
      `report-recompute: BinaryInstrumentReductionError: unknown-cell-input: parsed input names ${hex}/x/1, a run matrix.json does not carry`,
    ],
    [
      `report-recompute: BinaryInstrumentReductionError: verdict-digest-mismatch: ${hex}/x/1 parsed ${hex}, Matrix names x`,
      `report-recompute: BinaryInstrumentReductionError: verdict-digest-mismatch: ${hex}/x/1 parsed ${hex}, matrix.json names x`,
    ],
    [
      "binary admission replay failed: admissionManifest: (root): digest references must be sorted and unique",
      "binary admission replay failed: admissionManifest: (root): fingerprint references must be sorted and unique",
    ],
    [
      `report-recompute: MethodInputError: verdict-record-malformed: ${hex}: invalid DSSE envelope: TrustCoreError: DSSE envelope payload must be a string.`,
      `report-recompute: MethodInputError: verdict-record-malformed: ${hex}: not valid DSSE: payload must be a string.`,
    ],
    [
      "sealed Report: invalid binary qualification: qualification.arms must contain two or more arms; qualification task t1 must carry exactly one group for every arm; qualification task t2 must carry exactly one group for every arm",
      "report.json: invalid binary qualification: qualification.arms must contain two or more configurations; qualification task t1 must carry exactly one group for every configuration; qualification task t2 must carry exactly one group for every configuration",
    ],
    [
      "binary admission replay failed: admissionManifest: reviewVerdictSha256s: digest references must be sorted and unique; (root): Invalid input; visibilityReceiptSha256s: digest references must be sorted and unique",
      "binary admission replay failed: admissionManifest: reviewVerdictSha256s: fingerprint references must be sorted and unique; (root): Invalid input; visibilityReceiptSha256s: fingerprint references must be sorted and unique",
    ],
    [
      "report-recompute: invalid method parameters: parameter \"k\" must be an odd positive safe integer; parameters \"baseline\" and \"candidate\" must name distinct arms",
      "report-recompute: invalid method parameters: parameter \"k\" must be an odd positive safe integer; parameters \"baseline\" and \"candidate\" must name distinct configurations",
    ],
  ];
})();

test("the platform and schema refusals the inventory reaches use the reader's names, and --json keeps the message", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const [message, human] of READER_WORDING_5373) {
    const verify = async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); };
    const result = await runVerifierCli(["bundle"], { verify });
    assert.equal(result.exitCode, 1, message);
    assert.equal(result.stderr, `colophon-check: ${human}\n`, message);

    const json = await runVerifierCli(["bundle", "--json"], { verify });
    assert.equal(json.stderr, "", message);
    assert.equal(JSON.parse(json.stdout).message, message);
  }
});

// The same rules, after text a publisher could choose: each prints unchanged. A list item is
// reworded only inside a list the message starts with.
test("the #5373 refusal wording is rewritten only where a rule matches from the message's start", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const [body] of READER_WORDING_5373) {
    for (const message of [`unknown member: ${body}`, `; ${body}`]) {
      const result = await runVerifierCli(["bundle"], {
        verify: async () => { throw Object.assign(new Error(message), { code: "record-integrity" }); },
      });
      assert.equal(result.stderr, `colophon-check: ${message}\n`, message);
    }
  }
});

// A freeze-repository or domain-binding refusal reaches a reader inside a note, and is worded as a
// bundle refusal is: from its own start, with the note's lead in front.
test("a note's refusal is worded from its own start, and --json keeps it", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const message = "the bundle's evidence catalog assigns no freeze-artifact role";
  const deps = {
    verify: async () => verified({ format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES }),
    freezeRepo: () => Promise.reject(Object.assign(new Error(message), { code: "not-found" })),
  };
  const human = await runVerifierCli(["bundle", "--freeze-repo", "repo"], deps);
  assert.equal(human.exitCode, 2);
  assert.equal(human.stderr, "colophon-check: freeze repository not checked: the bundle's evidence.json assigns no freeze-artifact role\n");

  const json = await runVerifierCli(["bundle", "--json", "--freeze-repo", "repo"], deps);
  assert.equal(JSON.parse(json.stdout).freezeRepo.message, message);
});

test("freeze-repo failures keep identifiers in --json and alias them for a human", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const method = "https://registry.jinn.benchmarking/methods/freeze/v1";
  const deps = {
    verify: async () => verified({ format: "benchmark-product-public-bundle/2", identity: "a".repeat(64), checks: ["manifest"], ...V6_IDENTITIES }),
    freezeRepo: () => {
      const error = Object.assign(new Error(`freeze-repo-render: no licence declared for ${method}`), { code: "freeze-repo-render" });
      return Promise.reject(error);
    },
  };

  const json = await runVerifierCli(["bundle", "--json", "--freeze-repo", "repo"], deps);
  assert.equal(json.exitCode, 2);
  assert.equal(JSON.parse(json.stdout).freezeRepo.message, `freeze-repo-render: no licence declared for ${method}`);

  const human = await runVerifierCli(["bundle", "--freeze-repo", "repo"], deps);
  assert.equal(human.exitCode, 2);
  assert.match(human.stderr, /freeze repository not checked: .*<identifier: see --json>/);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);
});

test("freeze-repo and domain-binding notes cannot forge a stderr line", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const forged = "\u001b[2K\rcolophon-check: bundle verified\ncolophon-check: ok";
  const deps = {
    verify: async () => verified(publisherResult(keyId)),
    freezeRepo: () => Promise.reject(Object.assign(new Error(`freeze-repo-render: ${forged}`), { code: "freeze-repo-render" })),
    readFile: () => { throw Object.assign(new Error(`binding document ${forged}`), { code: "validation" }); },
  };

  const human = await runVerifierCli(["bundle", "--freeze-repo", "repo", "--identity-binding", "binding.json"], deps);
  assert.equal(human.exitCode, 2);
  assert.doesNotMatch(human.stderr, CONTROL_CHARACTER_EXCEPT_LF);
  const lines = human.stderr.split("\n");
  assert.equal(lines.length, 3, "one note is one line");
  assert.match(lines[0], /^colophon-check: freeze repository not checked: /u);
  assert.match(lines[1], /^colophon-check: domain binding not applied: /u);

  const json = await runVerifierCli(["bundle", "--json", "--freeze-repo", "repo", "--identity-binding", "binding.json"], deps);
  assert.equal(json.exitCode, 2);
  assert.equal(json.stderr, "");
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.freezeRepo.message, `freeze-repo-render: ${forged}`);
  assert.equal(parsed.identityBinding.message, `binding document ${forged}`);
});

test("non-Jinn URLs survive the human refusal surface", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const calendar = "https://alice.btc.calendar.opentimestamps.org/";
  const human = await runVerifierCli(["bundle"], {
    verify: () => {
      const error = Object.assign(new Error(`integrity-anchors: the calendar at ${calendar} did not answer`), { code: "environment" });
      return Promise.reject(error);
    },
  });
  assert.equal(human.exitCode, 2);
  assert.match(human.stderr, /https:\/\/alice\.btc\.calendar\.opentimestamps\.org\//);
  assert.doesNotMatch(human.stderr, /<identifier: see --json>/);
});

test("one human refusal prints the served spec identifier whole and aliases the unserved one (issue #4894)", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  // The two differ only in their version: the spec release serves binary-judgment 2.0 and not 1.0,
  // so only the exact served-path rule tells them apart, and one refusal carries both.
  const served = "https://spec.jinn.network/task-profiles/binary-judgment/2.0";
  const unserved = "https://spec.jinn.network/task-profiles/binary-judgment/1.0";
  const message = `admission: the task profile is ${unserved}, but this bundle's format requires ${served}`;
  const deps = {
    verify: () => Promise.reject(Object.assign(new Error(message), { code: "record-integrity" })),
  };

  const human = await runVerifierCli(["bundle"], deps);
  assert.equal(human.exitCode, 1);
  assert.equal(
    human.stderr,
    "colophon-check: admission: the task profile is <identifier: see --json>, "
      + `but this bundle's format requires ${served}\n`,
  );
  assert.equal(human.stderr.includes(unserved), false);

  const json = await runVerifierCli(["bundle", "--json"], deps);
  assert.equal(json.exitCode, 1);
  assert.equal(JSON.parse(json.stdout).message, message);
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
/**
 * @param {string} [domain]
 * @param {"dns-txt" | "well-known-url"} [mechanism]
 */
async function mintDomainBinding(domain = "example.com", mechanism = "dns-txt") {
  const { canonicalJsonBytes } = await import("@jinn-network/trust-core");
  const { domainBindingStatementBytes } = await import("../dist/index.js");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" });
  assert.ok(x !== undefined, "an ed25519 JWK must carry its public coordinate");
  const raw = Buffer.from(x, "base64url");
  const keyId = `did:key:z${base58btc(Uint8Array.from([0xed, 0x01, ...raw]))}`;
  /** @type {Parameters<typeof domainBindingStatementBytes>[0]} */
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

/**
 * @param {string} keyId
 * @returns {import("../dist/index.js").PublicBundleVerificationResult}
 */
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
    verify: async () => verified(publisherResult(keyId)),
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
  // The retired verdict word reaches this paragraph only through --identity-binding, and this is
  // the one verdict-word assertion that renders it (issue #4269); other tests pass the flag and
  // assert other things about the same paragraph.
  assert.doesNotMatch(result.stdout, /verified|certified|validated|audited/i);
  // This is the one actionable raw identifier on the human surface: the exact TXT value to compare.
  assert.equal(result.stdout.match(/did:key:/g)?.length, 1);
  assert.match(result.stdout, new RegExp(`\n {4}expect: colophon-domain-binding=1; key=${keyId}\n`));
  assert.doesNotMatch(result.stdout, /jinn\.network|jinn\.benchmarking/);
});

test("without a binding the publisher is named by its bare key fingerprint", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(["bundle"], { verify: async () => verified(publisherResult(keyId)) });
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
    verify: async () => verified(publisherResult(other.keyId)),
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
    verify: async () => verified(publisherResult(keyId)),
  });
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.identityBinding.ok, true);
  assert.equal(parsed.identityBinding.domain, "example.org");
  assert.equal(parsed.identityBinding.confirmation, "key-signature-only");
  assert.equal(parsed.identityBinding.proof.location, "https://example.org/.well-known/colophon-domain-binding.txt");
  assert.equal(parsed.identityBinding.proof.expectedValue, `colophon-domain-binding=1; key=${keyId}`);
  // The bundle's own digest is untouched: a binding must never shadow the value a consumer pins by.
  assert.equal(parsed.identity, "a".repeat(64));

  const bad = await runVerifierCli(["bundle", "--json", "--identity-binding", "b.json"], {
    readFile: () => new TextEncoder().encode("{"),
    verify: async () => verified(publisherResult(keyId)),
  });
  const parsedBad = JSON.parse(bad.stdout);
  assert.equal(parsedBad.ok, false);
  assert.equal(parsedBad.identityBinding.ok, false);
  assert.equal(parsedBad.identityBinding.code, "validation");
  assert.equal(parsedBad.identity, "a".repeat(64));
});

test("identity-binding failures keep identifiers in --json and alias them for a human", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const kind = "https://spec.jinn.network/records/domain-binding/v1";
  const deps = {
    verify: async () => verified(publisherResult(keyId)),
    readFile: () => {
      const error = Object.assign(new Error(`binding document uses unsupported kind ${kind}`), { code: "validation" });
      throw error;
    },
  };

  const json = await runVerifierCli(["bundle", "--json", "--identity-binding", "binding.json"], deps);
  assert.equal(json.exitCode, 2);
  assert.equal(JSON.parse(json.stdout).identityBinding.message, `binding document uses unsupported kind ${kind}`);

  const human = await runVerifierCli(["bundle", "--identity-binding", "binding.json"], deps);
  assert.equal(human.exitCode, 2);
  assert.match(human.stderr, /domain binding not applied: .*<identifier: see --json>/);
  assert.doesNotMatch(human.stderr, INTERNAL_NAMESPACE);
});

test("--identity-binding requires a value and may be supplied only once", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  for (const args of [["bundle", "--identity-binding"], ["bundle", "--identity-binding", "a", "--identity-binding", "b"]]) {
    const result = await runVerifierCli(args, { verify: async () => { throw new Error("must not be reached"); } });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Usage: colophon-check/);
  }
});

test("a binding for a grader key never becomes the publisher's identity", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const publisher = await mintDomainBinding();
  const grader = await mintDomainBinding("grader.example");
  const result = await runVerifierCli(["bundle", "--identity-binding", "binding.json"], {
    readFile: () => grader.bytes,
    verify: async () => verified({
      format: "benchmark-product-public-bundle/6",
      identity: "a".repeat(64),
      checks: V6_CHECKS,
      ...V6_IDENTITIES,
      signers: [
        { role: "publisher", identity: "urn:jinn:agent:alpha", keyId: publisher.keyId, custody: "same-operator", keyFingerprint: keyFingerprintFromDidKey(publisher.keyId) },
        { role: "automated-grader", identity: "urn:jinn:agent:beta", keyId: grader.keyId, custody: "same-operator", keyFingerprint: keyFingerprintFromDidKey(grader.keyId) },
      ],
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
  const deps = {
    readFile: () => bytes,
    verify: async () => verified({
      format: "benchmark-product-public-bundle/6",
      identity: "a".repeat(64),
      checks: V6_CHECKS,
      ...V6_IDENTITIES,
      signers: [
        { role: "publisher", identity: "urn:jinn:agent:alpha", keyId, custody: "same-operator" },
        { role: "publisher", identity: "urn:jinn:agent:beta", keyId: second.keyId, custody: "same-operator" },
      ],
    }),
  };
  const result = await runVerifierCli(["bundle", "--identity-binding", "binding.json"], deps);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /2 publisher keys/);
  assert.doesNotMatch(result.stdout, /claims publication/);
  // The limits paragraph must not qualify a name the report never showed.
  assert.doesNotMatch(result.stdout, /registrar/);

  // The refusal's code is public through `--json`, and it is `validation`: the binding's
  // precondition -- exactly one publisher key -- is unmet, and nothing collides with anything, so
  // `conflict` would tell an embedder branching on the code to retry under another name (#4378).
  const json = await runVerifierCli(["bundle", "--json", "--identity-binding", "binding.json"], deps);
  assert.equal(json.exitCode, 2);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.identityBinding.ok, false);
  assert.equal(parsed.identityBinding.code, "validation");
  assert.match(parsed.identityBinding.message, /2 publisher keys/);
});

test("a drifted freeze repository still exits 1 when an unrelated binding also failed", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(
    ["bundle", "--freeze-repo", "repo", "--identity-binding", "binding.json"],
    {
      readFile: () => new TextEncoder().encode("{"),
      verify: async () => verified(publisherResult(keyId)),
      freezeRepo: async () => ({ ok: false, bundleIdentity: "a".repeat(64), commitId: "c".repeat(40), fileCount: 3, executableBitChecked: true, differences: [{ kind: "changed", path: "README.md" }] }),
    },
  );
  assert.equal(result.exitCode, 1);
  // Both flags reported, neither swallowed.
  assert.match(result.stdout, /freeze repository: DOES NOT match this bundle/);
  assert.match(result.stderr, /domain binding not applied/);
});

// ── The dropped mode dimension names its own reason (issue #3604) ──────────────────────────────
//
// `executableBitChecked: false` has two materially different causes, and the note used to assert
// the first one for both — telling a reader whose read-only mount refused the probe that their
// filesystem carries no executable bit. A filesystem that does not record the bit is not reachable
// from CI, so the injectable `freezeRepo` dep is the only place that string can be exercised.

/**
 * `executableBitChecked` is required rather than defaulted: it and `executableBitSkipped` are
 * derived from one probe and cannot disagree, so a caller that states only the skip reason must
 * not silently acquire a `true`.
 *
 * @param {Partial<Omit<import("../dist/index.js").FreezeRepoVerificationResult, "executableBitChecked">>
 *   & Pick<import("../dist/index.js").FreezeRepoVerificationResult, "executableBitChecked">} extra
 * @returns {import("../dist/index.js").FreezeRepoVerificationResult}
 */
function matchedTree(extra) {
  return { ok: true, bundleIdentity: "a".repeat(64), commitId: "d".repeat(40), fileCount: 3, differences: [], ...extra };
}

test("a filesystem that does not record the bit is reported as one, not as a refused probe", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(["bundle", "--freeze-repo", "repo"], {
    verify: async () => verified(publisherResult(keyId)),
    freezeRepo: async () => matchedTree({ executableBitChecked: false, executableBitSkipped: "not-recorded" }),
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /file modes were not checked \(this filesystem does not record an executable bit\)/);
});

test("a refused probe says so rather than describing the reader's filesystem", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(["bundle", "--freeze-repo", "repo"], {
    verify: async () => verified(publisherResult(keyId)),
    freezeRepo: async () => matchedTree({ executableBitChecked: false, executableBitSkipped: "not-probed" }),
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /file modes were not checked \(the filesystem could not be probed\)/);
  // The claim the pre-#3604 string made for both causes.
  assert.doesNotMatch(result.stdout, /does not (carry|record) an executable bit/);
});

test("a result carrying no reason claims neither cause", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(["bundle", "--freeze-repo", "repo"], {
    verify: async () => verified(publisherResult(keyId)),
    freezeRepo: async () => matchedTree({ executableBitChecked: false }),
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /note: file modes were not checked\n/);
  assert.doesNotMatch(result.stdout, /does not record an executable bit|could not be probed/);
});

test("a checked mode dimension adds no note at all", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const result = await runVerifierCli(["bundle", "--freeze-repo", "repo"], {
    verify: async () => verified(publisherResult(keyId)),
    freezeRepo: async () => matchedTree({ executableBitChecked: true }),
  });
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /file modes were not checked/);
  // renderFreezeRepoCheck is appended to the same stdout, and no other verdict-word guard in this
  // file renders it: this is the one verdict-word assertion that reaches it (issue #4269); other
  // tests render the same block and assert other things about it.
  assert.doesNotMatch(result.stdout, /verified|certified|validated|audited/i);
});

// ── The freeze tree renders from the reported verdict's own snapshot (issue #4386) ─────────────
//
// #3781 moved the `verify` seam to `{ verification, snapshot }` for one reason, recorded at
// `src/cli.ts:37-42`: `--freeze-repo` must render from the same authenticated snapshot the
// printed verdict came from. The shape before it verified once for the verdict and again inside
// the freeze check, and that second pass ran without the caller's `--tsa-root` / `--ots-headers`
// material -- so its anchor outcomes could disagree with the reported ones with nothing saying
// so. `src/cli.ts` implements it; until this test nothing observed it, because every freezeRepo
// stub ignored its arguments and every verify stub omitted `snapshot` entirely.

test("the freeze check renders from the exact snapshot the reported verdict came from", async () => {
  const { runVerifierCli } = await import("../dist/index.js");
  const { keyId } = await mintDomainBinding();
  const snapshot = bundleSnapshot("f".repeat(64));
  /** @type {import("../dist/index.js").VerifiedBundleSnapshot | undefined} */
  let seen;
  const result = await runVerifierCli(["bundle", "--freeze-repo", "repo"], {
    verify: async () => verified(publisherResult(keyId), snapshot),
    freezeRepo: async (received) => {
      seen = received;
      return matchedTree({ executableBitChecked: true });
    },
  });
  assert.equal(result.exitCode, 0);
  // Identity, not shape. A stale re-verification that happened to produce an equal-looking
  // snapshot is precisely the failure #3781 exists to prevent, and `deepEqual` would accept it.
  assert.equal(seen, snapshot);
});

// ── The promoted caveat's enumeration (issue #3691) ─────────────────────────────────────────────
//
// The sentence beneath the verdict says what was recomputed. It used to hand-list the v2/v4
// closure — and not even all of it: `trust` was missing — so an anchored or disclosed bundle
// printed `of 7` or `of 8` above a sentence that accounted for five checks.

/** @type {readonly import("../dist/index.js").PublicBundleVerificationCheck[]} */
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
  assert.match(caveat, /timestamp proof well-formedness/);
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
  // Issue #5251: the caveat names each subject by its section 5 name.
  assert.match(caveat, /what was pinned/);
  assert.doesNotMatch(caveat, /disclosure specification/);
  assert.match(caveat, /the result/);
  assert.doesNotMatch(caveat, /the report/);
  assert.match(caveat, /timestamp proof well-formedness/);
  assert.doesNotMatch(caveat, /undefined/);
});

test("the caveat never claims a deferred check was recomputed (issue #3691)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  const output = renderVerifiedBundle(v5({
    ...V5_RESULT,
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first",
    artifactContent: {
      status: "not-fetched", verified: 2, notFetched: 3,
      notFetchedDigests: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    },
  }));
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
      outcomes: checks.map((check) => (/** @type {import("../dist/index.js").VerificationCheckOutcome} */ ({ check, state: "passed" }))),
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

const V5_METADATA_FIRST = v5({
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
});

/** @type {import("../dist/index.js").PublicBundleVerificationResult} */
const V8_SHAPE = {
  format: "benchmark-product-public-bundle/8",
  identity: "a".repeat(64),
  checks: V8_CHECKS,
  ...V6_IDENTITIES,
  // The anchor block is a shape `evaluateIntegrityAnchors` can actually emit, so the render this
  // guard walks is the render the product produces. The `@type` annotation above this literal
  // binds it to `PublicBundleVerificationResult`, and `tsconfig.tests.json` (issue #4385) turns
  // on the `checkJs` that honors it, so the field shape is enforced -- including that every
  // `subject` here is one of `ClaimAnchorSubject`'s two members (`lock`/`matrix`). Emittability
  // is not enforced, because that type admits blocks the closure never produces. Those are the
  // parts only this comment holds: the subject rows are the fixed pair that closure maps over,
  // never a one-row reduction (`subjects` is an unbounded `readonly AnchorSubjectReport[]`) -- so
  // a subject-keyed line in `renderSubject` or `renderAnchor` reaches this guard instead of being
  // skipped by a subject the closure never emits. A `present` RFC 3161 entry has parsed, so it
  // carries the `provider` and `facts` its own type documents for that status (both are optional
  // on a flat interface, and `facts` is typed `unknown`, so its contents are this comment's
  // charge too); `genTime` is what `anchoredValue` reads for the head line's value segment.
  anchors: {
    anchors: [{
      recordSha256: "9".repeat(64), status: "present", subject: "lock",
      provider: "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
      timeBasis: "authority-time", trustMaterial: "none",
      facts: { genTime: "2026-01-02T03:04:05Z" },
    }],
    subjects: [{ subject: "lock", outcome: "anchored" }, { subject: "matrix", outcome: "absent" }],
    invalid: [],
  },
};

/**
 * One `/10` result declaring every capability the registry carries, so every check a capability
 * can add renders here. Derived, never listed: a capability registered later is declared, and its
 * check rendered, with no edit to this file (issue #5333).
 *
 * @returns {Promise<import("../dist/index.js").PublicBundleVerificationResult>}
 */
async function v10EveryCapability() {
  const { CAPABILITY_REGISTRY, expectedChecks } = await import("../dist/index.js");
  // The wire vector is code-unit sorted; `expectedChecks` refuses any other order.
  const capabilities = [...new Set(CAPABILITY_REGISTRY.map(({ token }) => token))].sort();
  return {
    format: "benchmark-product-public-bundle/10",
    identity: "a".repeat(64),
    capabilities,
    checks: expectedChecks(capabilities),
    ...V6_IDENTITIES,
  };
}

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
  // Three shapes cover every check name in the union: the disclosed `/8` closure carries `trust`,
  // `integrity-anchors`, and `disclosure-specification`; the evidence-native `/5` carries
  // `artifact-integrity` and `signature-validity`; the `/10` result declaring every registered
  // capability carries every check a capability adds, `external-import` among them.
  const glosses = {
    "manifest": "every listed file is here, unaltered",
    "evidence-closure": "every run's evidence is carried here",
    "trust": "the signing keys match the identities",
    "matrix-rederivation": "the run tally follows from the evidence",
    "report-verification": "the result follows from the runs",
    "claim-consistency": "the claim agrees with the records here",
    "integrity-anchors": "the timestamp proofs are well formed",
    "disclosure-specification": "what was pinned is recorded and matches",
    "external-import": "the import marker matches the claim",
    "artifact-integrity": "each artifact matches its fingerprint",
    "signature-validity": "each signature matches its key",
  };
  const seen = new Set();
  for (const shape of [V8_SHAPE, V5_METADATA_FIRST, await v10EveryCapability()]) {
    const output = renderVerifiedBundle(shape);
    for (const { check, row } of checkRows(output, shape.checks)) {
      seen.add(check);
      assert.ok(Object.hasOwn(glosses, check), `no pinned gloss for ${check}`);
      // Name verbatim, then a state, then the gloss — the gloss never replaces the sealed name.
      assert.match(
        row,
        new RegExp(`^${check} {2,}(passed|not fetched) +${glosses[check].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        `wrong gloss row for ${check}: ${JSON.stringify(row)}`,
      );
    }
  }
  // The three shapes together must cover every check any supported closure can emit, so this test
  // cannot drift narrower than the product. The composed generation's checks are read from the
  // capability registry, so a capability that adds a check widens this set with no edit here. The
  // exhaustiveness of the gloss map itself is a type obligation -- it is keyed by the check union,
  // the same discipline `CHECK_SUBJECTS` uses.
  const {
    CAPABILITY_REGISTRY, expectedChecks,
    PUBLIC_BUNDLE_VERIFICATION_CHECKS, PUBLIC_BUNDLE_V6_CHECKS, PUBLIC_BUNDLE_V7_CHECKS, PUBLIC_BUNDLE_V8_CHECKS,
  } = await import("../dist/index.js");
  const { EVIDENCE_NATIVE_BUNDLE_V5_CHECKS } = await import("@jinn-network/benchmarking-evidence");
  const everyCheck = new Set([
    ...PUBLIC_BUNDLE_VERIFICATION_CHECKS,
    ...PUBLIC_BUNDLE_V6_CHECKS,
    ...PUBLIC_BUNDLE_V7_CHECKS,
    ...PUBLIC_BUNDLE_V8_CHECKS,
    ...EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
    ...expectedChecks([...new Set(CAPABILITY_REGISTRY.map(({ token }) => token))].sort()),
  ]);
  assert.deepEqual([...seen].sort(), [...everyCheck].sort(), "the shapes must cover every check a closure can emit");
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

// ── The retired verdict word, across every rendered paragraph (issue #3510) ─────────────────────

test("no paragraph of the default human render carries a retired verdict word (issue #3510)", async () => {
  const { renderVerifiedBundle } = await import("../dist/index.js");
  // These two shapes are what reaches the paragraphs the golden bundle cannot: `/5` renders the
  // artifact-content report and its limitation, `/8` the anchor block and the anchor-limits
  // paragraph. All four render empty over golden's format /2, so the real-binary assertion in the
  // golden test guards the signer block and this one guards the rest — they are not two spellings
  // of the same coverage. `renderAnchor` prints `entry.status` verbatim and `verified` is a
  // legitimate status there, so a `verified`-status entry added to this shared fixture would fail
  // this test on a correct render. A `present` entry does not, which is why one is carried above
  // (issue #4269): it renders `renderAnchor`, `timestampProofEvaluationNote`, and `renderSubject` over both an
  // anchored and an absent subject, none of which match the word list.
  for (const shape of [V8_SHAPE, V5_METADATA_FIRST]) {
    assert.doesNotMatch(renderVerifiedBundle(shape), /verified|certified|validated|audited/i, shape.format);
  }
});
