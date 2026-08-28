#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministically projects the sealed SkillsBench comparison packet into
 * benchmark-product-public-bundle/5. It decodes and re-packages authenticated
 * bytes; it never reruns cells or recomputes the sealed result.
 *
 *   yarn demo1:public-bundle --output /absolute/path/to/bundle
 */
import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_PACKAGE_V3_PROFILE,
  documentDigest,
  evidenceReferenceKey,
  parseEvidenceCohort,
  sealEvidenceNativeClaimPackageV3,
  serializeCanonicalJson,
} from "@jinn-network/benchmarking-protocol";
import {
  EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
  buildEvidenceNativeBundleManifestV5,
  verifyEvidenceNativePortableBundle,
} from "@jinn-network/benchmarking-evidence";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../../..");
const SOURCE_ROOT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1");

const SOURCE_PATHS = {
  packet: "E1-demo1-evidence-bundle.v1.json",
  summary: "demo1-report.v1.json",
  humanReport: "demo1-report.md",
  preregistration: "E1-demo1-preregistration.v1.json",
  cells: "E1-demo1-confirmatory-cells.v1.json",
  hostControls: "E1-demo1-host-control-evidence.v1.json",
};

const PUBLIC_TITLE = "Do you need a Skill, or is CLAUDE.md enough?";
const PUBLIC_SLUG = "skill-vs-root-claude-md-haiku-4-5";
const VERIFY_COMMAND = "npx @colophon-claims/verify@0.1 ./bundle";

const decoder = new TextDecoder();
const codeUnitCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fromBase64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function descriptor(name, bytes, mediaType) {
  return {
    name,
    digest: { sha256: documentDigest(bytes).slice("sha256:".length) },
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function collectEvidence(cohort) {
  const evidence = new Map();
  const add = (reference) => evidence.set(evidenceReferenceKey(reference), reference);
  for (const member of cohort.members) {
    add(member.execution);
    for (const group of [member.evaluations, member.verifications, member.labelResolutions]) {
      for (const bucket of [group.considered, group.admitted, group.excluded]) {
        for (const reference of bucket) add(reference);
      }
    }
  }
  return [...evidence.values()].sort((left, right) =>
    codeUnitCompare(evidenceReferenceKey(left), evidenceReferenceKey(right)));
}

function admitSealedCells(declaration, cellsDocument) {
  const admitted = [];
  const declared = new Set();
  for (const [section, entries] of [
    ["slate", declaration.slate],
    ["screening", declaration.screening ?? []],
  ]) {
    for (const entry of entries) {
      for (const [arm, count] of Object.entries(entry.expected)) {
        for (let replicate = 0; replicate < count; replicate += 1) {
          const cellId = `${entry.taskId}/${arm}/r${replicate}`;
          declared.add(cellId);
          const record = cellsDocument.cells[cellId];
          if (record === undefined) throw new Error(`sealed cells omit declared cell ${cellId}`);
          if (record.model !== declaration.model) throw new Error(`sealed cell ${cellId} has wrong model`);
          const rewardValue = Number(record.reward);
          if (record.reward === null || !Number.isFinite(rewardValue)) {
            throw new Error(`sealed cell ${cellId} has an unparseable reward`);
          }
          admitted.push({ cellId, section, taskId: entry.taskId, arm, rewardValue });
        }
      }
    }
  }
  const undeclared = Object.keys(cellsDocument.cells).filter((cellId) => !declared.has(cellId));
  if (undeclared.length !== 0) throw new Error(`sealed cells contain ${undeclared.length} undeclared cells`);
  return admitted.sort((left, right) => codeUnitCompare(left.cellId, right.cellId));
}

function informativeTaskIds(cells) {
  const byTask = new Map();
  for (const cell of cells) {
    const group = byTask.get(cell.taskId) ?? [];
    group.push(cell);
    byTask.set(cell.taskId, group);
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return [...byTask]
    .filter(([, group]) => {
      const c = group.filter((cell) => cell.arm === "C-no-instructions");
      const a = group.filter((cell) => cell.arm === "A-native-skill").map((cell) => cell.rewardValue);
      const b = group.filter((cell) => cell.arm === "B-flat-claude-md").map((cell) => cell.rewardValue);
      return c.length > 0 && a.length > 0 && b.length > 0
        && c.every((cell) => cell.rewardValue === 0)
        && Math.max(mean(a), mean(b)) > 0;
    })
    .map(([taskId]) => taskId)
    .sort(codeUnitCompare);
}

function publicPresentation({ packet, summary, report, cohort, cellsDocument, hostControls }) {
  const admitted = admitSealedCells(packet.declaration, cellsDocument);
  const slateCells = admitted.filter((cell) => cell.section === "slate");
  const informativeIds = informativeTaskIds(slateCells);
  const taskIds = new Set(slateCells.map((cell) => cell.taskId));
  const controlNonzero = new Set(
    slateCells
      .filter((cell) => cell.arm === "C-no-instructions" && cell.rewardValue !== 0)
      .map((cell) => cell.taskId),
  );
  const signedInformativeIds = report.results.pairedDelta.perTask
    .map((task) => task.taskId)
    .sort(codeUnitCompare);
  if (JSON.stringify(informativeIds) !== JSON.stringify(signedInformativeIds)) {
    throw new Error("sealed informative subset does not match the signed report");
  }
  const bothInstructedZero = taskIds.size - controlNonzero.size - informativeIds.length;
  const cellsByArm = Object.fromEntries(
    ["A-native-skill", "B-flat-claude-md", "C-no-instructions"].map((arm) => [
      arm,
      slateCells.filter((cell) => cell.arm === arm).length,
    ]),
  );
  const failedHostOracles = Object.entries(hostControls.units)
    .filter(([, value]) => Number(value.oracleReward) !== 1 || Number(value.noOpReward) !== 0)
    .map(([taskId, value]) => ({
      taskId,
      host: value.host,
      oracleReward: value.oracleReward,
      noOpReward: value.noOpReward,
    }));
  const paired = report.results.pairedDelta;

  if (
    taskIds.size !== 41 ||
    controlNonzero.size !== 4 ||
    bothInstructedZero !== 23 ||
    informativeIds.length !== 14 ||
    admitted.length !== 492 ||
    failedHostOracles.length !== 2
  ) {
    throw new Error(`sealed Demo-1 accounting no longer matches the public presentation contract: ${JSON.stringify({
      flatTasks: taskIds.size,
      controlNonzero: controlNonzero.size,
      bothInstructedZero,
      informativeTasks: informativeIds.length,
      cells: admitted.length,
      failedHostOracles: failedHostOracles.length,
    })}`);
  }

  return {
    schema: "colophon.report-presentation/1",
    title: PUBLIC_TITLE,
    slug: PUBLIC_SLUG,
    summary:
      "The same instruction bytes were loaded as a native Skill or root CLAUDE.md, with a no-instructions arm. On this model and run, the estimate slightly favored CLAUDE.md, but the interval includes zero and effects in either direction.",
    sealedAt: packet.sealedAt,
    subject: {
      model: summary.model,
      benchmark: {
        name: "SkillsBench",
        release: summary.source.release,
        commit: summary.source.commit,
      },
    },
    question: {
      instructionBytes: "identical-between-a-and-b",
      comparison: "A-native-skill minus B-flat-claude-md",
      arms: [
        { id: "A-native-skill", label: "Native Skill", replicatesPerTask: 5 },
        { id: "B-flat-claude-md", label: "Root CLAUDE.md", replicatesPerTask: 5 },
        { id: "C-no-instructions", label: "No instructions", replicatesPerTask: 2 },
      ],
    },
    execution: {
      source: {
        benchmark: "SkillsBench",
        release: summary.source.release,
        commit: summary.source.commit,
        upstreamRuntime: {
          name: "BenchFlow",
          version: "0.6.3",
          usedForOfficialCells: false,
        },
        preservedPackageParts: [
          "curated Skill bundles",
          "task environments",
          "oracles",
          "verifiers",
        ],
      },
      armConstruction: {
        owner: "Colophon",
        transform: "jinn.demo1.claude-md-flatten@1",
        reason:
          "BenchFlow's standard modes could not express the Skill, flattened CLAUDE.md, and no-instructions arms while keeping non-instruction resources constant.",
      },
      agentHarness: {
        name: "Claude Code",
        location: "host",
        heldConstantAcrossArms: true,
      },
      grading: {
        verifier: "upstream task verifier",
        location: "pinned task container",
      },
    },
    result: {
      unit: report.results.unit,
      informativeTasks: paired.n,
      estimatePpm: paired.meanPpm,
      confidenceInterval95Ppm: {
        lower: paired.ci95Ppm.lower,
        upper: paired.ci95Ppm.upper,
      },
      interpretation:
        "The point estimate slightly favors root CLAUDE.md. The 95% interval includes zero and effects in either direction.",
      methodStatement:
        "This method estimates an effect; it does not gate one. No verdict, threshold, or selection was registered.",
    },
    population: {
      flatTasks: taskIds.size,
      funnel: [
        { stage: "Statically admitted; all run", tasks: taskIds.size },
        { stage: "Control arm not identically zero", tasks: controlNonzero.size },
        { stage: "Both instructed arms remained at zero", tasks: bothInstructedZero },
        { stage: "Pre-declared informative subset", tasks: informativeIds.length },
      ],
      officialFloor: {
        units: 21,
        independenceClusters: 13,
        met: false,
      },
    },
    accounting: {
      expectedCells: admitted.length,
      cellsByArm,
      admittedCells: cohort.closure.admittedCount,
      excludedCells: cohort.closure.excludedCount,
      unavailableCells: cohort.closure.unavailableCount,
      failedHostOracles,
    },
    manipulationCheck: report.results.manipulationCheck,
    limitations: [
      "This is one model and one run. It does not establish a general result about Skills, CLAUDE.md, SkillsBench as a whole, or other models.",
      "The population was a flat 41 statically admitted tasks. The paired estimate uses the pre-declared 14-task informative subset: every control replicate scored zero and at least one instructed arm had a positive mean.",
      "Four tasks had a nonzero control result and 23 left both instructed arms at zero. No task was selected or dropped because of its outcome.",
      "Fourteen informative tasks do not meet the official confirmatory floor of 21 units in 13 independence clusters.",
      "The agent ran on the host while grading ran in the pinned task container. The agent-side environment was the host interpreter, not the task image.",
      "The same operator designed, ran, graded, and sealed this comparison. Local evidence makes the process inspectable and reproducible; it does not prove honesty against the run owner.",
      "Two on-host task oracles failed. Both tasks remain in the fail-closed 492-cell denominator.",
      "Distinct droplets and cell keys do not establish distinct real-world parties.",
      "This report does not certify or rank either instruction-loading path, and it is not a publication that Skills do not work.",
    ],
    selfRunDisclosure:
      "The same operator designed, ran, graded, and sealed this comparison and is using it to show Colophon. The artifact makes the method and evidence checkable; it does not prove honesty against the run owner.",
    verification: {
      bundleFormat: "benchmark-product-public-bundle/5",
      checks: EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
      command: VERIFY_COMMAND,
      readerAvailability: "available",
      reportEnvelopeSha256: summary.digests.report.slice("sha256:".length),
    },
    provenance: {
      internalRunId: report.results.stage,
      declarationSha256: summary.digests.declaration.slice("sha256:".length),
      benchmarkSha256: summary.digests.benchmark.slice("sha256:".length),
      analysisManifestSha256: summary.digests.analysisManifest.slice("sha256:".length),
      cohortSha256: summary.digests.cohort.slice("sha256:".length),
      matrixSha256: summary.digests.matrix.slice("sha256:".length),
    },
  };
}

function presentationReadme(presentation) {
  const result = presentation.result;
  const asReward = (ppm) => (ppm / 1_000_000).toFixed(3);
  return `# ${presentation.title}

The same instruction bytes were loaded as a native Skill or root \`CLAUDE.md\`, with a no-instructions arm.

On the ${result.informativeTasks}-task informative subset, the paired Skill-minus-\`CLAUDE.md\` estimate was **${asReward(result.estimatePpm)}**. The 95% confidence interval was **${asReward(result.confidenceInterval95Ppm.lower)} to ${asReward(result.confidenceInterval95Ppm.upper)}**. The point estimate slightly favors root \`CLAUDE.md\`; the interval includes zero and effects in either direction.

This is one model and one self-run comparison. It does not establish a general result about Skills, \`CLAUDE.md\`, SkillsBench as a whole, or other models. The estimate uses 14 informative tasks out of a flat 41-task population and does not meet the official 21-unit / 13-cluster floor. Two host oracles failed and remain in the fail-closed 492-cell denominator.

The signed report is \`report-envelope.json\` at \`sha256:${presentation.verification.reportEnvelopeSha256}\`. Run \`${presentation.verification.command}\` with the public npm reader to check this bundle. The check recomputes the numbers from the per-run evidence, confirms every file listed in \`bundle.json\` still matches its recorded digest, and confirms that the evidence, the calculations, and the report the claim was signed over are the ones in this bundle. Any mismatch is reported.

Identifiers inside the record files are internal names, not addresses the check visits, even where they look like web addresses. The check runs on code installed from npm and fetches nothing from the web.

See \`presentation.json\` for the claim as a reader record, and \`claim-package.json\` for the same claim, its method, and its evidence in machine-readable form.
`;
}

function writeBundle(outputDir, files) {
  if (existsSync(outputDir)) {
    throw new Error(`refusing to overwrite existing output directory: ${outputDir}`);
  }
  for (const [path, bytes] of files) {
    const target = join(outputDir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

export async function exportDemo1PublicBundle(outputDir) {
  const packetPath = join(SOURCE_ROOT, SOURCE_PATHS.packet);
  const summaryPath = join(SOURCE_ROOT, SOURCE_PATHS.summary);
  const cellsPath = join(SOURCE_ROOT, SOURCE_PATHS.cells);
  const hostControlsPath = join(SOURCE_ROOT, SOURCE_PATHS.hostControls);
  const packet = readJson(packetPath);
  const summary = readJson(summaryPath);
  const cellsDocument = readJson(cellsPath);
  const hostControls = readJson(hostControlsPath);

  if (packet.schema !== "jinn.demo1.evidence-bundle.v1" || packet.stage !== "final") {
    throw new Error("public export requires the sealed final Demo-1 evidence packet");
  }

  const benchmarkBytes = fromBase64(packet.benchmark);
  const manifestBytes = fromBase64(packet.manifest);
  const cohortBytes = fromBase64(packet.cohort);
  const matrixBytes = fromBase64(packet.matrix);
  const reportEnvelopeBytes = fromBase64(packet.reportEnvelope);
  const reportEnvelope = JSON.parse(decoder.decode(reportEnvelopeBytes));
  const reportBytes = fromBase64(reportEnvelope.payload);
  const report = JSON.parse(decoder.decode(reportBytes));
  const cohort = parseEvidenceCohort(cohortBytes);
  const evidence = collectEvidence(cohort);

  const files = new Map([
    ["benchmark.json", benchmarkBytes],
    ["analysis-manifest.json", manifestBytes],
    ["cohort.json", cohortBytes],
    ["matrix.json", matrixBytes],
    ["report.json", reportBytes],
    ["report-envelope.json", reportEnvelopeBytes],
  ]);

  for (const reference of evidence) {
    const key = evidenceReferenceKey(reference);
    const encoded = packet.records[key];
    if (encoded === undefined) throw new Error(`sealed packet omits evidence record ${key}`);
    files.set(`records/${reference.record.digest.sha256}.bin`, fromBase64(encoded));
  }

  const artifactDescriptors = [];
  for (const [digest, encoded] of Object.entries(packet.artifacts).sort(([left], [right]) => codeUnitCompare(left, right))) {
    const bytes = fromBase64(encoded);
    files.set(`artifacts/${digest}.bin`, bytes);
    artifactDescriptors.push(descriptor(`artifact-${digest}.bin`, bytes));
  }

  const signerSpecs = [
    {
      keyId: "urn:key:urn:evaluator:skillsbench-verifier",
      identity: "urn:evaluator:skillsbench-verifier",
      purpose: "automated-evaluator",
      name: "skillsbench-verifier-public-key.spki.der",
    },
    {
      keyId: "urn:key:urn:publisher:colophon",
      identity: report.author,
      purpose: "report",
      name: "colophon-report-public-key.spki.der",
    },
  ];
  const signers = signerSpecs.map((signer) => {
    const encoded = packet.publicKeys[signer.keyId];
    if (encoded === undefined) throw new Error(`sealed packet omits public key ${signer.keyId}`);
    const bytes = fromBase64(encoded);
    const publicKey = descriptor(signer.name, bytes, "application/octet-stream");
    files.set(`artifacts/${publicKey.digest.sha256}.bin`, bytes);
    artifactDescriptors.push(publicKey);
    return {
      keyId: signer.keyId,
      identity: signer.identity,
      purpose: signer.purpose,
      publicKey,
      algorithm: "ed25519",
    };
  }).sort((left, right) => codeUnitCompare(left.keyId, right.keyId));

  const uniqueArtifactDescriptors = [...new Map(
    artifactDescriptors.map((artifact) => [artifact.digest.sha256, artifact]),
  ).values()].sort((left, right) => codeUnitCompare(left.digest.sha256, right.digest.sha256));
  const claim = sealEvidenceNativeClaimPackageV3({
    claimSchema: "benchmark-product.claim-package/3",
    profile: CLAIM_PACKAGE_V3_PROFILE,
    records: {
      benchmark: descriptor("benchmark.json", benchmarkBytes),
      manifest: descriptor("analysis-manifest.json", manifestBytes),
      cohort: descriptor("cohort.json", cohortBytes),
      matrix: descriptor("matrix.json", matrixBytes),
      reportPayload: descriptor("report.json", reportBytes),
      reportEnvelope: descriptor("report-envelope.json", reportEnvelopeBytes),
      evidence,
      artifacts: uniqueArtifactDescriptors,
    },
    method: {
      id: report.method.id,
      version: report.method.version,
      parameters: report.method.parameters,
    },
    results: report.results,
    closure: cohort.closure,
    trust: {
      signers,
      signatureValidityIsNotAuthorization: true,
    },
    verification: {
      checks: EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
      command: VERIFY_COMMAND,
    },
    issuedAt: packet.sealedAt,
  });
  files.set("claim-package.json", claim.bytes);

  const presentation = publicPresentation({ packet, summary, report, cohort, cellsDocument, hostControls });
  files.set("presentation.json", serializeCanonicalJson(presentation));
  files.set("README.md", new TextEncoder().encode(presentationReadme(presentation)));
  for (const [publicPath, sourceName] of [
    ["source/demo1-report.v1.json", SOURCE_PATHS.summary],
    ["source/demo1-report.md", SOURCE_PATHS.humanReport],
    ["source/E1-demo1-preregistration.v1.json", SOURCE_PATHS.preregistration],
    ["source/E1-demo1-confirmatory-cells.v1.json", SOURCE_PATHS.cells],
    ["source/E1-demo1-host-control-evidence.v1.json", SOURCE_PATHS.hostControls],
  ]) {
    files.set(publicPath, new Uint8Array(readFileSync(join(SOURCE_ROOT, sourceName))));
  }

  const manifest = buildEvidenceNativeBundleManifestV5(files);
  files.set("bundle.json", manifest.bytes);
  const verification = await verifyEvidenceNativePortableBundle({
    files,
    verifySignature: ({ publicKeyBytes, preAuthEncoding, signature }) => {
      const key = createPublicKey({ key: Buffer.from(publicKeyBytes), format: "der", type: "spki" });
      return key.asymmetricKeyType === "ed25519" && verifyEd25519(
        null,
        Buffer.from(preAuthEncoding),
        key,
        Buffer.from(signature),
      );
    },
  });
  writeBundle(resolve(outputDir), files);
  return { outputDir: resolve(outputDir), presentation, verification, fileCount: files.size };
}

function outputArgument(args) {
  const index = args.indexOf("--output");
  if (index === -1 || args[index + 1] === undefined || args.length !== 2) {
    throw new Error("usage: demo1-export-public-bundle.mjs --output <new-directory>");
  }
  return args[index + 1];
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  exportDemo1PublicBundle(outputArgument(process.argv.slice(2)))
    .then(({ outputDir, verification, fileCount }) => {
      console.log(`exported ${fileCount} authenticated files to ${outputDir}`);
      console.log(`bundle ${verification.identity}`);
      console.log(`verified ${verification.checks.length} checks; ${verification.evidenceRecords} evidence records; ${verification.artifacts} artifacts`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
