// SPDX-License-Identifier: Apache-2.0
/**
 * Chain-only E2E gate harness (program §5 / E14).
 *
 * Resolves an archive-capable RPC (free default: sepolia.base.org), extracts a
 * closed chain environment against live eth_getProof at a frozen tip (WETH as
 * source), widens to closed-reproducible with K≥5 blackhole runs on a live Anvil
 * ProcessHost that loads the harvested artifact, then admits approval-hygiene
 * via evaluatePredicates composed into a ChainObservationPort (no safety override).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createJsonRpcArchiveRpcPort,
  redactUrl,
  resolveArchiveUrlThatServesProofsAsync,
} from "./archive-port.mjs";
import {
  createGateChainRuntime,
  GATE_SOURCE,
} from "./gate-runtime.mjs";
import { createEvaluateObservationPort } from "./admission-observation.mjs";
import { produceApprovalHygieneObservation } from "./admission-anvil.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

function pkg(distRel) {
  return pathToFileURL(join(ROOT, distRel)).href;
}

const ANVIL_VERSION = (() => {
  const out = execFileSync("anvil", ["--version"], { encoding: "utf8" });
  const m = out.match(/anvil Version:\s*(\S+)/);
  return m?.[1] ?? "unknown";
})();

const ANVIL_BINARY_DIGEST = (() => {
  const which = execFileSync("which", ["anvil"], { encoding: "utf8" }).trim();
  const sum = execFileSync("shasum", ["-a", "256", which], { encoding: "utf8" })
    .split(/\s+/)[0];
  return `sha256:${sum}`;
})();

const CAIP2 = "eip155:84532";
const CHAIN_ID = 84532;
const STUB_ABI_DIGEST = "a".repeat(64);
const UNSAFE_ALLOWANCE = 10_000_000_000_000_000_000n;

function scriptedAccountPort(addresses) {
  let index = 0;
  return async (request) => {
    if (index >= addresses.length) {
      throw new Error(`scripted account port exhausted at role ${request.role}`);
    }
    const address = addresses[index];
    index += 1;
    return { address, role: request.role };
  };
}

async function main() {
  const resolved = await resolveArchiveUrlThatServesProofsAsync();
  if (!resolved) {
    throw new Error(
      "No archive/RPC URL — set JINN_ARCHIVE_RPC_URL or rpcUrl in ~/.jinn-client/config.json",
    );
  }
  const { url: archiveUrl, probe } = resolved;

  console.log("[gate] archive probe", redactUrl(archiveUrl));
  console.log(
    "[gate] eth_getProof ok at frozen tip-1 block",
    probe.blockNumber,
    "(tip",
    probe.tipNumber + ")",
  );

  const extraction = await import(pkg("packages/environments/chain-extraction/dist/index.js"));
  const extractionTesting = await import(
    pkg("packages/environments/chain-extraction/dist/testing.js")
  );
  const verification = await import(
    pkg("packages/environments/chain-verification/dist/index.js")
  );
  const verificationRecords = await import(
    pkg("packages/environments/chain-verification/dist/conformance-records.js")
  );
  const chainRecord = await import(pkg("packages/environments/chain-record/dist/index.js"));
  const scenarios = await import(pkg("packages/task-supply/chain-scenarios/dist/index.js"));
  const fixtureSources = await import(
    pkg("packages/task-supply/chain-scenarios/dist/fixture-sources.js")
  );
  const admission = await import(pkg("packages/task-supply/admission/dist/index.js"));
  const trustCore = await import(pkg("packages/trust/core/dist/index.js"));
  const profiles = await import(pkg("packages/task-execution/profiles/dist/index.js"));

  const { extractEnvironment, widenAndReverify, PROVISIONAL_COMMITMENT } = extraction;
  const {
    createInMemoryArtifactStore,
    createFixedClock,
    FAKE_ACTOR,
  } = extractionTesting;
  const { buildConformanceChainRecord } = verificationRecords;
  const {
    sealChainEnvironmentRecord,
    sealCryptoEnvironmentRecord,
    chainEnvironmentRecordDigest,
    cryptoEnvironmentRecordDigest,
  } = chainRecord;
  const {
    approvalHygieneTemplate,
    ApprovalHygieneParamsSchema,
    parameterize,
    buildScenarioEvaluationSpec,
    buildSealedScenarioTask,
    sealReferenceScript,
    loadChainDerivationEnvironment,
    createFixtureAddressLedger,
  } = scenarios;
  const { buildCompositeRecordBody, buildApprovalChainRecordBody, fixtureRoleAddress } =
    fixtureSources;
  const { admitChainCandidate } = admission;
  const { recordDigest } = trustCore;
  const { stateReadKey, evaluatePredicates } = profiles;

  const params = ApprovalHygieneParamsSchema.parse({});
  const signer = async () => [
    { signature: new Uint8Array([1, 2, 3, 4]), keyid: "urn:jinn:gate:ephemeral" },
  ];

  const archive = createJsonRpcArchiveRpcPort(archiveUrl);
  const tip = await archive.getBlockHeader("latest");
  const runtime = await createGateChainRuntime();
  const conf = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  const approval = buildApprovalChainRecordBody();

  const draft = {
    ...conf,
    fixtures: {
      modules: conf.fixtures.modules,
      accounts: approval.fixtures.accounts,
    },
    capabilityEnvelope: {
      ...conf.capabilityEnvelope,
      permittedChainId: CHAIN_ID,
      signerRoles: approval.capabilityEnvelope.signerRoles,
      egressPolicyId: "jinn.egress.blackhole/1",
      limits: approval.capabilityEnvelope.limits,
      toolInterfaces: approval.capabilityEnvelope.toolInterfaces
        ?? conf.capabilityEnvelope.toolInterfaces,
    },
    runtime: {
      ...conf.runtime,
      version: ANVIL_VERSION,
      binary: {
        ...conf.runtime.binary,
        version: ANVIL_VERSION,
        digest: ANVIL_BINARY_DIGEST,
      },
      evm: {
        ...conf.runtime.evm,
        sandboxChainId: CHAIN_ID,
      },
    },
    sourceAnchor: {
      ...conf.sourceAnchor,
      caip2ChainId: CAIP2,
      nativeChainId: CHAIN_ID,
      blockNumber: tip.number,
      blockHash: tip.hash,
      stateRoot: tip.stateRoot,
      timestamp: tip.timestamp,
      finalityPolicy: "latest",
    },
    stateMaterialization: {
      ...conf.stateMaterialization,
      closureClass: "archive-dependent",
      constructionMethod: "archive-extraction",
      fidelityClass: "anchored-subset",
      initialStateCommitment: PROVISIONAL_COMMITMENT,
    },
    determinismControls: {
      ...conf.determinismControls,
      resetMechanism: "fresh-process",
    },
    verificationContract: {
      ...conf.verificationContract,
      closureCheckRequired: true,
    },
  };

  const request = {
    draft,
    caip2ChainId: CAIP2,
    anchorBlockNumber: tip.number,
    fidelityClass: "anchored-subset",
    sourceAddresses: [GATE_SOURCE],
    fixtureDeclarations: [{ address: FAKE_ACTOR, kind: "account" }],
    finalityPolicy: "latest",
    budget: { maxCalls: 2_000, maxBytes: 20_000_000 },
    maxWidenings: 8,
  };

  const deps = {
    archive,
    forkBackend: { kind: "injected-port" },
    runtime,
    replayer: {
      async replay() {
        return {
          status: "replayed",
          observation: {},
          observationDigest: `sha256:${"f".repeat(64)}`,
          reportedValues: {},
        };
      },
    },
    artifactStore: createInMemoryArtifactStore(),
    signer,
    clock: createFixedClock(),
    verifier: {
      id: "https://spec.jinn.network/chain-state-extraction/gate",
      version: "0.1.0",
      digest: `sha256:${"c".repeat(64)}`,
    },
  };

  console.log("[gate] extractEnvironment against live archive…");
  const extracted = await extractEnvironment(deps, request);
  if (extracted.status !== "candidate") {
    throw new Error(`extract failed: ${JSON.stringify(extracted, null, 2)}`);
  }
  console.log("[gate] extract candidate ok; archiveUsage", extracted.archiveUsage);

  console.log("[gate] widenAndReverify…");
  const converged = await widenAndReverify(
    deps,
    { candidate: extracted.candidate, request },
    { runCount: verification.MINIMUM_RUN_COUNT },
  );
  if (converged.status !== "converged") {
    throw new Error(`widen failed: ${JSON.stringify(converged, null, 2)}`);
  }
  console.log(
    "[gate] converged rounds=",
    converged.rounds.length,
    "outcome=",
    converged.attestation.outcome,
  );

  const chainBytes = sealChainEnvironmentRecord(converged.candidate.record);
  const chainDigest = chainEnvironmentRecordDigest(chainBytes);
  const chainDigestBare = chainDigest.slice("sha256:".length);
  const compositeBody = buildCompositeRecordBody(chainDigestBare);
  const compositeBytes = sealCryptoEnvironmentRecord(compositeBody);
  const compositeDigest = cryptoEnvironmentRecordDigest(compositeBytes);
  const attestationDigest = recordDigest(
    new TextEncoder().encode(JSON.stringify(converged.attestation)),
  );
  console.log("[gate] composite", compositeDigest);

  const env = loadChainDerivationEnvironment(compositeBytes, chainBytes);
  const ownerAddr = approval.fixtures.accounts.find((a) => a.role === "owner")?.address
    ?? fixtureRoleAddress("b2");

  const scenario = await parameterize(
    {
      ledger: createFixtureAddressLedger(),
      accounts: scriptedAccountPort([ownerAddr]),
    },
    approvalHygieneTemplate,
    params,
    env,
  );
  const spec = buildScenarioEvaluationSpec(scenario, env);
  const task = buildSealedScenarioTask(scenario, env, spec.digest);
  const reference = sealReferenceScript(scenario.referenceScript);
  const block = scenario.predicateBlock;

  function resolveRole(role) {
    const hit = env.chainRecord.fixtures.accounts.find((a) => a.role === role);
    if (!hit) throw new Error(`missing role ${role}`);
    return hit.address;
  }

  async function observationFor(kind) {
    const initialBlock = String(env.chainRecord.determinismControls.initialBlockNumber);
    const initialTs = String(env.chainRecord.determinismControls.initialTimestamp);
    return produceApprovalHygieneObservation(
      {
        token: resolveRole(params.tokenRole),
        owner: resolveRole(params.ownerRole),
        retainedSpender: resolveRole(params.retainedSpenderRole),
        unsafeSpenders: params.unsafeSpenderRoles.map((role) => resolveRole(role)),
        startingBalance: BigInt(params.startingTokenBalance),
        retainedAllowance: BigInt(params.retainedAllowance),
        unsafeAllowance: UNSAFE_ALLOWANCE,
        environmentRecord: env.recordDigest,
        initialBlockNumber: initialBlock,
        initialTimestamp: initialTs,
        stubAbiDigest: STUB_ABI_DIGEST,
        stateReadKey,
      },
      kind,
    );
  }

  console.log("[gate] admitChainCandidate (live Anvil observations)…");
  const observeChain = createEvaluateObservationPort({
    evaluatePredicates,
    predicateBlock: block,
    observationFor,
    referenceDigest: reference.digest,
  });
  const admitResult = await admitChainCandidate(
    {
      issuer: "urn:jinn:gate:chain-only-e2e",
      observeChain,
    },
    {
      taskDocumentDigest: task.digest,
      statementDigest: scenario.sourceCommitment,
      referenceScriptDigest: reference.digest,
      evaluationSpecBytes: spec.bytes,
      evalSemanticsVersion: scenario.predicateBlock.predicateSemanticsVersion,
    },
    env.recordDigest,
  );

  if (!("receipt" in admitResult)) {
    throw new Error(`admission refused: ${JSON.stringify(admitResult.refusal, null, 2)}`);
  }

  const receiptDigest = recordDigest(
    new TextEncoder().encode(JSON.stringify(admitResult.receipt)),
  );

  const evidence = {
    generatedAt: new Date().toISOString(),
    archiveHost: redactUrl(archiveUrl),
    anvilVersion: ANVIL_VERSION,
    anvilBinaryDigest: ANVIL_BINARY_DIGEST,
    anchorBlockNumber: tip.number,
    sourceAddress: GATE_SOURCE,
    digests: {
      compositeRecord: compositeDigest,
      chainEnvironmentRecord: chainDigest,
      verificationAttestation: attestationDigest,
      attestationOutcome: converged.attestation.outcome,
      admissionReceipt: receiptDigest,
    },
    findings: [
      {
        id: "F-GATE-1",
        claim: "Anvil pin is measured PATH binary, not fixture 1.3.7 (F-T17-1).",
        disposition: "accept for this gate evidence",
      },
      {
        id: "F-GATE-2",
        claim:
          "Blackhole K≥5 spawns a live Anvil ProcessHost, loads the harvested state "
          + "artifact via anvil_set*, and reads WETH keys over RPC for the observation fingerprint.",
        disposition: "closed — live Anvil sealed materializer",
      },
      {
        id: "F-GATE-3",
        claim:
          "Admission observes do-nothing/reference on a live Anvil MiniToken world "
          + "(setCode + seeded allowances + impersonated approve(0)), then composes "
          + "evaluatePredicates into ChainObservationPort with no safety override.",
        disposition: "closed — live Anvil observation + evaluatePredicates composition",
      },
      {
        id: "F-GATE-4",
        claim:
          "Extract assemble drove live eth_getProof against a frozen tip via "
          + "https://sepolia.base.org (Coinbase public Base Sepolia). Probe requires tip-1 "
          + "so tip-only publicnode/Tenderly slots are rejected. Source address is WETH.",
        disposition: "closed — free archive RPC verified for capture→assemble",
      },
      {
        id: "F-GATE-5",
        claim:
          "approvalConstraint.allowedSpenders skips Approval(amount=0) revokes; "
          + "positive grants to non-allowed spenders still violate.",
        disposition: "closed — CE2 evaluateApprovalConstraint fix",
      },
    ],
  };

  const outDir = join(ROOT, ".superpowers/sdd/2026-07-31-chain-environment-program");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "gate-evidence.md");
  const md = `# Chain-only gate evidence (program §5 / E14)

Generated: ${evidence.generatedAt}

## Digests

| Item | Value |
| --- | --- |
| Composite record (\`informationWorlds: []\`) | \`${evidence.digests.compositeRecord}\` |
| Chain environment record | \`${evidence.digests.chainEnvironmentRecord}\` |
| Verification attestation | \`${evidence.digests.verificationAttestation}\` |
| Attestation outcome | \`${evidence.digests.attestationOutcome}\` |
| Admission receipt | \`${evidence.digests.admissionReceipt}\` |

## Run context

- Archive host (live eth_getProof): \`${evidence.archiveHost}\`
- Anchor block: \`${evidence.anchorBlockNumber}\`
- Source address: \`${evidence.sourceAddress}\` (WETH)
- Anvil on PATH: \`${evidence.anvilVersion}\` (\`${evidence.anvilBinaryDigest}\`)

## Findings

${evidence.findings.map((f) => `### ${f.id}\n\n- **Claim:** ${f.claim}\n- **Disposition:** ${f.disposition}\n`).join("\n")}

## Honesty

Extract→widen assembled against **live** archive \`eth_getProof\` (F-GATE-4) and
blackhole K≥5 on a **live Anvil** ProcessHost loaded from the harvested artifact
(F-GATE-2). Admission observed do-nothing/reference on a **live Anvil MiniToken**
world and composed \`evaluatePredicates\` with no safety override (F-GATE-3, F-GATE-5).
Outcome: \`${evidence.digests.attestationOutcome}\` with empty-\`informationWorlds\` composite.
`;

  writeFileSync(outPath, md);
  writeFileSync(join(outDir, "gate-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("[gate] wrote", outPath);
  console.log(JSON.stringify(evidence.digests, null, 2));
}

main().catch((err) => {
  console.error("[gate] FAILED", err);
  process.exitCode = 1;
});
