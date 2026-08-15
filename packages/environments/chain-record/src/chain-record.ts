import { z } from "zod";

import { ChainSourceAnchorSchema } from "./anchor.js";
import { CapabilityEnvelopeSchema } from "./envelope.js";
import { DeterminismControlsSchema } from "./determinism.js";
import { topLevelRecordSchema } from "./extensions.js";
import { ChainFixturesSchema } from "./fixture-modules.js";
import { BLACKHOLE_EGRESS_POLICY_ID, CHAIN_ENVIRONMENT_KIND } from "./identifiers.js";
import { DigestPinnedDescriptorSchema } from "./primitives.js";
import { ChainRuntimeSchema } from "./runtime.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";
import { ChainStateMaterializationSchema } from "./state.js";
import { VerificationContractSchema } from "./verification-contract.js";

/**
 * One record = one sandboxed chain world (§4.3). Sealed forever: no expiry, no status, no
 * outcome — staleness and assurance are derived by consumers from attestation history, never
 * stored here (§4.5). `supersedes` is a static backward pointer carrying promotion lineage
 * (E12); it is not status either.
 *
 * The document states what the world IS. It makes no claim that the world boots, reproduces,
 * or corresponds to a public chain beyond the fidelity class it declares; every such claim
 * lives in separately published attestations and is bounded there.
 */
export const ChainEnvironmentRecordSchema = topLevelRecordSchema({
  kind: z.literal(CHAIN_ENVIRONMENT_KIND),
  runtime: ChainRuntimeSchema,
  sourceAnchor: ChainSourceAnchorSchema.optional(),
  stateMaterialization: ChainStateMaterializationSchema,
  fixtures: ChainFixturesSchema,
  determinismControls: DeterminismControlsSchema,
  capabilityEnvelope: CapabilityEnvelopeSchema,
  verificationContract: VerificationContractSchema,
  supersedes: DigestPinnedDescriptorSchema.optional(),
}).superRefine((record, ctx) => {
  const state = record.stateMaterialization;
  const anchored = state.fidelityClass !== "local";

  // 1. An anchor is present exactly when the record claims correspondence to a source chain.
  if (anchored && record.sourceAnchor === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceAnchor"],
      message: `fidelityClass "${state.fidelityClass}" claims a source chain, so sourceAnchor is required (§4.3)`,
    });
  }
  if (!anchored && record.sourceAnchor !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceAnchor"],
      message: "a local world claims no source chain and must not carry a sourceAnchor (§4.2)",
    });
  }

  // 2. The post-fixture commitment is a different claim about a different world than the
  //    source root. Spelling them the same is either a confusion or the claim §4.3 forbids.
  if (record.sourceAnchor !== undefined
      && state.initialStateCommitment === record.sourceAnchor.stateRoot) {
    ctx.addIssue({
      code: "custom",
      path: ["stateMaterialization", "initialStateCommitment"],
      message:
        "initialStateCommitment equals sourceAnchor.stateRoot. It is the post-fixture, "
        + "agent-visible world's commitment, computed by the pinned materializer — explicitly "
        + "distinct from the source root (§4.3)",
    });
  }

  // 3. Sandbox execution identity is one value, declared once.
  if (record.capabilityEnvelope.permittedChainId !== record.runtime.evm.sandboxChainId) {
    ctx.addIssue({
      code: "custom",
      path: ["capabilityEnvelope", "permittedChainId"],
      message:
        "permittedChainId disagrees with runtime.evm.sandboxChainId; the agent may only sign "
        + "for the chain id the sandbox reports (§4.3)",
    });
  }

  // 4. Signers expose fixture accounts and nothing else (§5.1 step 6 probes this).
  const fixtureAddresses = new Set(record.fixtures.accounts.map((account) => account.address));
  record.capabilityEnvelope.signerRoles.forEach((signer, index) => {
    signer.accounts.forEach((account, accountIndex) => {
      if (!fixtureAddresses.has(account)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilityEnvelope", "signerRoles", index, "accounts", accountIndex],
          message: `${account} is not a declared fixture account; signers expose only fixture accounts (§5.1)`,
        });
      }
    });
  });

  // 5. Probe coverage is declared per fixture module, for every module and no others.
  const moduleIds = new Set(record.fixtures.modules.map((module) => module.id));
  const coveredIds = new Set(
    record.verificationContract.fixtureProbeCoverage.map((entry) => entry.fixtureId),
  );
  for (const id of moduleIds) {
    if (!coveredIds.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: ["verificationContract", "fixtureProbeCoverage"],
        message: `fixture module "${id}" declares no smoke probes; each module answers its own (§5.1 step 6)`,
      });
    }
  }
  for (const id of coveredIds) {
    if (!moduleIds.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: ["verificationContract", "fixtureProbeCoverage"],
        message: `probe coverage declared for "${id}", which is not a fixture module of this record`,
      });
    }
  }

  if (state.closureClass !== "closed-state") return;

  // 6. A closed-state world runs with every egress interface dead, and earns the class only
  //    through the closure check — never by existing (E3).
  if (record.capabilityEnvelope.egressPolicyId !== BLACKHOLE_EGRESS_POLICY_ID) {
    ctx.addIssue({
      code: "custom",
      path: ["capabilityEnvelope", "egressPolicyId"],
      message: `a closed-state world declares egressPolicyId "${BLACKHOLE_EGRESS_POLICY_ID}" (§4.2, §5.1 step 2)`,
    });
  }
  if (record.verificationContract.closureCheckRequired !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["verificationContract", "closureCheckRequired"],
      message: "a closed-state world requires the closure check; the class is earned, never asserted (E3)",
    });
  }

  // 7. Repetition means fresh processes (§5.1 step 8).
  if (record.determinismControls.resetMechanism !== "fresh-process") {
    ctx.addIssue({
      code: "custom",
      path: ["determinismControls", "resetMechanism"],
      message:
        "a closed-state world resets by launching a fresh process with a clean copy of the state "
        + "artifact; snapshot/revert inside one process cannot catch startup, artifact-load, "
        + "cache, or process-global drift (§5.1 step 8)",
    });
  }
});

export type ChainEnvironmentRecord = z.infer<typeof ChainEnvironmentRecordSchema>;

/**
 * Validate, then canonicalize once. The returned bytes are the record forever; its identity is
 * `chainEnvironmentRecordDigest(bytes)`.
 *
 * Throws `InvalidDocumentError` for a schema failure or a refused `__proto__` member, and
 * `IJsonNumberError` / `IJsonStringError` / `UndefinedArrayElementError` for a value no
 * canonical encoding admits. All four carry `category: "invalid-document"` — catch on that
 * rather than on `InvalidDocumentError` by class.
 */
export function sealChainEnvironmentRecord(record: unknown): Uint8Array {
  return sealWithSchema(ChainEnvironmentRecordSchema, record);
}

/** Parse sealed bytes, requiring them to be the one exact canonical encoding. */
export function parseChainEnvironmentRecord(bytes: Uint8Array): ChainEnvironmentRecord {
  return parseExactWithSchema(ChainEnvironmentRecordSchema, bytes);
}

/**
 * Whether materializing this record requires the caller to supply a `ChainStateBackend`.
 *
 * True for exactly the `archive-dependent` class, whose historical state resolves at
 * materialization time rather than from a committed artifact. The rule lives here, in the
 * package both the materializer and the extractor already depend on, so neither re-derives it
 * from the closure class and neither drifts. A materializer handed such a record without a
 * backend fails closed; `archive.providerLocators` tells a *caller* where it may look and is
 * never an instruction to the runtime.
 */
export function requiresStateBackend(record: ChainEnvironmentRecord): boolean {
  return record.stateMaterialization.closureClass === "archive-dependent";
}
