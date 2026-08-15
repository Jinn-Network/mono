/**
 * Workspace-local trust deps (BP-13 deliverable 1, spec §7.1): the `@jinn-network/trust-core`
 * `VerifyEnvelopeBindingDeps` bundle `verifyReport`'s authenticity leg calls.
 *
 * THIS IS A WORKSPACE-LOCAL TRUST ROOT, NOT A THIRD-PARTY ATTESTATION. The binding this module
 * hands back is synthesized entirely from the workspace's own key material and its own
 * `workspace.json` `createdAt` — it proves only that the report envelope was signed by this
 * workspace's own report key (`./signing.ts`), on behalf of this workspace's run owner. It
 * carries no on-chain anchor, no independent registrar, no third party who could contest it. On a
 * self-run venue (spec §7.1's "venue honesty") the verifier and the author are the same operator:
 * a caller running this deps bundle is checking the report against the same workspace that
 * produced it, not against an outside authority. Callers (and downstream artifacts, e.g.
 * `./claim.ts`'s claim package) must not represent a passing `verifyReport` run as third-party
 * attestation — it demonstrates internal consistency (the report was genuinely signed by the key
 * this workspace holds), nothing more.
 *
 * The synthesized `KeyBinding`'s ceremony is `agentId` for a structural, not evidentiary, reason:
 * `verifyEnvelopeBinding`'s ceremony leg (`verify.ts`'s `verifyCeremonyLeg`) treats agentId/oidc-
 * machine/github-human ceremonies as already-authenticated by resolution (a non-null
 * `ResolvedBinding` for one of those ceremony types carries the authenticity guarantee itself,
 * per that function's own comment) — unlike `eoa`/`safe`, which demand ceremony evidence or a
 * 1271 witness this local venue has neither of. The `voucher.caip19` value below is therefore
 * SYNTHETIC (the platform fixture's own placeholder shape, `packages/benchmarking/aggregate/
 * src/report.test.ts`'s `resolvedBinding` helper) — not a real ERC-8004 agentId this workspace
 * registered anywhere. `witnessVerifier` is wired but never reached for this ceremony type.
 */

import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARKING_REPORTS_SCOPE } from "@jinn-network/benchmarking-records";
import {
  sha256Hex,
  TRUST_KEY_BINDING_FORMAT,
  type ResolvedBinding,
  type VerifyEnvelopeBindingDeps,
} from "@jinn-network/trust-core";
import { assertWorkspace } from "../workspace/workspace.js";
import { loadOrCreateReportSigningKey, verifyReportEnvelopeSignatures } from "./signing.js";

/** Synthetic placeholder voucher (not a real on-chain registration) — mirrors the platform
 * fixture's own shape (`benchmarking-aggregate`'s `report.test.ts`) for an agentId ceremony that
 * has no genuine ERC-8004 registration to point at on a local, self-run venue. */
const SYNTHETIC_VOUCHER_CAIP19 = "eip155:1/erc721:0x0000000000000000000000000000000000000000/1";

export interface BuildWorkspaceTrustDepsInput {
  readonly workspaceDir: string;
  /** The Agent IRI this workspace's report key is claimed to bind to (the run owner). */
  readonly author: string;
}

export interface PublicReportTrustMaterial {
  readonly author: string;
  readonly keyId: string;
  readonly didKey: string;
  readonly algorithm: "ed25519";
  readonly spkiDerBase64: string;
  readonly validFrom: string;
}

export interface BuildPublicReportTrustDepsInput {
  readonly report: PublicReportTrustMaterial;
  /** Exact public trust-document bytes carrying `report`; used as the resolved binding envelope. */
  readonly bindingEnvelopeBytes: Uint8Array;
}

/** Public-only counterpart to `buildWorkspaceTrustDeps`, used by deletion-portable bundles. */
export function buildPublicReportTrustDeps(input: BuildPublicReportTrustDepsInput): VerifyEnvelopeBindingDeps {
  const { report, bindingEnvelopeBytes } = input;
  if (report.keyId !== report.didKey) {
    throw new Error("report trust keyId must equal didKey");
  }
  const spkiDer = Buffer.from(report.spkiDerBase64, "base64");
  const publicKey = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  const bindingDigest = `sha256:${sha256Hex(bindingEnvelopeBytes)}` as const;
  const binding: ResolvedBinding = {
    binding: {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: report.author,
      key: {
        publicKey: report.spkiDerBase64,
        keyid: report.keyId,
        algorithm: report.algorithm,
        didKey: report.didKey,
      },
      voucher: { kind: "agentId", caip19: SYNTHETIC_VOUCHER_CAIP19 },
      relationship: "controls",
      scope: [BENCHMARKING_REPORTS_SCOPE],
      validFrom: report.validFrom,
      ceremony: { type: "agentId", digest: `sha256:${sha256Hex(spkiDer)}` },
      strength: "strong",
      anchors: [],
    },
    envelopeBytes: bindingEnvelopeBytes,
    bindingDigest,
    effectiveStart: report.validFrom,
    isGenesis: true,
    revocations: [],
  };
  return {
    dsseVerifier: (envelopeBytes) => verifyReportEnvelopeSignatures(envelopeBytes, {
      keyId: report.keyId,
      publicKey,
    }),
    bindingResolver: {
      async resolveBinding(query) {
        if (query.key !== report.keyId || query.agent !== report.author) return null;
        return binding;
      },
    },
    witnessVerifier: {
      async verify1271Witness() {
        return { verified: false, reason: "no 1271 witnesses on the local venue" };
      },
    },
  };
}

/** Builds the `VerifyEnvelopeBindingDeps` bundle for `verifyReport`'s authenticity leg, scoped to
 * exactly this workspace's own report key and claimed author. See the module header for the
 * workspace-local-trust-root caveat. Deliberately never passes `policy` (spec §7.1: policy-chain
 * verification, "step 5", stays off for the local venue). */
export function buildWorkspaceTrustDeps(input: BuildWorkspaceTrustDepsInput): VerifyEnvelopeBindingDeps {
  const { workspaceDir, author } = input;
  const key = loadOrCreateReportSigningKey(workspaceDir);
  const { createdAt } = assertWorkspace(workspaceDir);
  const spkiDer = key.publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64 = Buffer.from(spkiDer).toString("base64");
  const sidecarBytes = readFileSync(join(workspaceDir, "venue", "report-signing-key.json"));
  const bindingDigest = `sha256:${sha256Hex(sidecarBytes)}` as const;

  const binding: ResolvedBinding = {
    binding: {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: author,
      key: {
        publicKey: publicKeyBase64,
        keyid: key.keyId,
        algorithm: "ed25519",
        didKey: key.keyId,
      },
      voucher: { kind: "agentId", caip19: SYNTHETIC_VOUCHER_CAIP19 },
      relationship: "controls",
      scope: [BENCHMARKING_REPORTS_SCOPE],
      validFrom: createdAt,
      ceremony: { type: "agentId", digest: `sha256:${sha256Hex(spkiDer)}` },
      strength: "strong",
      anchors: [],
    },
    envelopeBytes: sidecarBytes,
    bindingDigest,
    effectiveStart: createdAt,
    isGenesis: true,
    revocations: [],
  };

  return {
    dsseVerifier: (envelopeBytes) => verifyReportEnvelopeSignatures(envelopeBytes, key),
    bindingResolver: {
      async resolveBinding(query) {
        if (query.key !== key.keyId || query.agent !== author) return null;
        return binding;
      },
    },
    witnessVerifier: {
      async verify1271Witness() {
        return { verified: false, reason: "no 1271 witnesses on the local venue" };
      },
    },
  };
}
