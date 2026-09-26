// SPDX-License-Identifier: Apache-2.0

/**
 * The evidence-native session document and its phase machine (#3340).
 *
 * The five `evidence` verbs are one workflow split across five invocations, so the state between
 * them has to be durable and the refusals between them have to be identical everywhere. Both live
 * here rather than in the five operation modules, so a phase rule cannot mean one thing in
 * `evidence seal` and another in `evidence publish`.
 *
 * ## Phases, and what each one may still learn
 *
 * `preregistered → captured → sealed → published`, forward only.
 *
 * - `preregistered` — the benchmark definition is sealed and the publisher's analysis policy is
 *   recorded verbatim, along with the digest of its canonical bytes. NOTHING about results is
 *   knowable yet, which is the entire point of the phase.
 * - `captured` — a native run has been snapshotted and atomized; members exist with their exact
 *   Task and Result digests. Evaluations may be issued against those members.
 * - `sealed` — the analysis manifest, the Evidence Cohort, and Matrix v2 are sealed. Selection has
 *   happened, so nothing may be captured or evaluated afterwards.
 * - `published` — a public bundle has been emitted and verified. Terminal.
 *
 * ## Why the analysis manifest is sealed at `seal` and not at `prereg`
 *
 * `BenchmarkAnalysisManifest.sources[].source` is a `TypedRecordReference` to the Execution Batch
 * Capture record — a digest that does not exist until capture runs. Both golden fixtures
 * (`packages/benchmarking/evidence/src/golden-lifecycle.test.ts`,
 * `../conformance/v5-signer-disclosure.test.ts`) name a real capture there. Sealing the manifest at
 * `prereg` would therefore require inventing that digest, which is exactly the hollow declaration
 * the evidence-first design refuses.
 *
 * `preregistration: "local-sealed-before-selection"` stays literally true: the manifest is sealed
 * before SELECTION, which is the cohort's admission step, not before capture. What makes the
 * pre-registration checkable rather than merely asserted is `policyDigest` — `evidence seal`
 * recomputes it over the policy it is about to seal and refuses on any drift, and the audit journal
 * carries `prereg`'s own `inputsDigest` at a timestamp strictly before capture's.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { serializeCanonicalJson, documentDigest, type JsonValue } from "@jinn-network/benchmarking-protocol";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { evidenceSessionStatePath } from "../workspace/layout.js";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

/** Session ids are path components. Nothing traversal-shaped, nothing that collides case-wise. */
const SessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);

const DescriptorSchema = z.strictObject({
  name: z.string().min(1),
  digest: z.strictObject({ sha256: Sha256HexSchema }),
  mediaType: z.string().min(1).optional(),
});

const EvidenceReferenceSchema = z.strictObject({
  family: z.enum(["execution-evidence", "result-evaluation", "execution-verification", "human-label-resolution"]),
  record: DescriptorSchema,
});

const TypedReferenceSchema = z.strictObject({
  recordKind: z.string().min(1),
  record: DescriptorSchema,
});

const ArtifactSchema = z.strictObject({
  name: z.string().min(1),
  sha256: Sha256HexSchema,
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
});

/**
 * One issued or ingested Result Evaluation over a member.
 *
 * `ingested` distinguishes an opinion this workspace SIGNED from one it merely accepted. The CLI
 * never signs as a human, so a human reviewer's opinion can only ever arrive ingested, and the two
 * must stay tellable apart in the durable record.
 */
const EvaluationSchema = z.strictObject({
  evaluatorId: z.string().min(1),
  keyId: z.string().min(1),
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  evaluatedAt: z.string().min(1),
  reference: EvidenceReferenceSchema,
  ingested: z.boolean(),
});

const MemberSchema = z.strictObject({
  memberKey: z.string().min(1),
  groupId: z.string().min(1),
  slotId: z.string().min(1),
  unitKey: z.string().min(1),
  correlationKey: z.string().min(1),
  execution: EvidenceReferenceSchema,
  taskDigest: Sha256DigestSchema,
  resultDigests: z.array(Sha256DigestSchema).min(1),
  task: ArtifactSchema,
  results: z.array(ArtifactSchema).min(1),
  assurance: z.looseObject({
    origin: z.string().min(1),
    timing: z.string().min(1),
    closure: z.string().min(1),
    availability: z.string().min(1),
    limitations: z.array(z.string().min(1)),
  }),
  evaluations: z.array(EvaluationSchema),
});

export const EvidenceSessionSchema = z.strictObject({
  documentVersion: z.literal(1),
  sessionId: SessionIdSchema,
  phase: z.enum(["preregistered", "captured", "sealed", "published"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /**
   * `documentDigest` over the canonical JSON of `analysis`. Recorded at `prereg`, re-derived at
   * `seal`: it is what makes "sealed before selection" a checkable local fact rather than a claim.
   */
  policyDigest: Sha256DigestSchema,
  benchmark: DescriptorSchema,
  /** The publisher's pre-registered analysis policy, verbatim. Shape-validated by
   * `./analysis-plan.ts` at `prereg`; `sealBenchmarkAnalysisManifest` is the authority on its
   * semantics at `seal`, and a second copy of that grammar here would be a second place to drift. */
  analysis: z.unknown(),
  method: z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    parameters: z.unknown(),
    implementation: DescriptorSchema,
  }),
  evaluationMethod: DescriptorSchema,
  capture: z.strictObject({
    adapterId: z.string().min(1),
    reference: TypedReferenceSchema,
    limitations: z.array(z.string().min(1)),
  }).optional(),
  members: z.array(MemberSchema),
  seal: z.strictObject({
    manifest: DescriptorSchema,
    cohort: DescriptorSchema,
    matrix: DescriptorSchema,
  }).optional(),
  published: z.strictObject({
    bundleDir: z.string().min(1),
    identity: Sha256DigestSchema,
  }).optional(),
});

export type EvidenceSessionDocument = z.infer<typeof EvidenceSessionSchema>;
export type EvidenceSessionMember = z.infer<typeof MemberSchema>;
export type EvidenceSessionEvaluation = z.infer<typeof EvaluationSchema>;
export type EvidenceSessionPhase = EvidenceSessionDocument["phase"];

function issuesFrom(error: z.ZodError): readonly ProductIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/** Canonical bytes of the pre-registered policy — the input to `policyDigest`. */
export function policyDigestOf(analysis: unknown): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(analysis as JsonValue));
}

export function assertSessionId(sessionId: string): void {
  if (!SessionIdSchema.safeParse(sessionId).success) {
    refuse(
      "invalid-invocation",
      "evidence",
      `evidence session id "${sessionId}" must be 1-64 characters of [A-Za-z0-9._-] starting alphanumeric`,
    );
  }
}

export function readEvidenceSession(
  workspaceDir: string,
  sessionId: string,
): EvidenceSessionDocument | undefined {
  const path = evidenceSessionStatePath(workspaceDir, sessionId);
  if (!existsSync(path)) return undefined;
  const parsed = EvidenceSessionSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) refuseWithIssues("record-integrity", issuesFrom(parsed.error));
  return parsed.data;
}

export function writeEvidenceSession(workspaceDir: string, session: EvidenceSessionDocument): void {
  const parsed = EvidenceSessionSchema.safeParse(session);
  if (!parsed.success) refuseWithIssues("validation", issuesFrom(parsed.error));
  atomicWriteFileSync(
    evidenceSessionStatePath(workspaceDir, session.sessionId),
    `${JSON.stringify(parsed.data, null, 2)}\n`,
  );
}

/**
 * The session a verb is acting on, in a phase that verb is allowed to act from.
 *
 * An unknown session is `not-found`; a known session in the wrong phase is `conflict` and names
 * both phases, because "you already sealed this" and "you have not captured yet" are different
 * problems with different fixes.
 */
export function requireEvidenceSession(
  workspaceDir: string,
  sessionId: string,
  verb: string,
  allowed: readonly EvidenceSessionPhase[],
): EvidenceSessionDocument {
  assertSessionId(sessionId);
  const session = readEvidenceSession(workspaceDir, sessionId);
  if (session === undefined) {
    refuse(
      "not-found",
      "evidence",
      `evidence session "${sessionId}" does not exist; "evidence prereg" creates it`,
    );
  }
  if (!allowed.includes(session.phase)) {
    refuse(
      "conflict",
      "evidence",
      `evidence ${verb} requires an evidence session in phase ${allowed.join(" or ")}; "${sessionId}" is ${session.phase}`,
    );
  }
  return session;
}

/** The member `evidence evaluate` names, or a refusal that says the member was never captured. */
export function requireMember(
  session: EvidenceSessionDocument,
  memberKey: string,
): EvidenceSessionMember {
  const member = session.members.find((candidate) => candidate.memberKey === memberKey);
  if (member === undefined) {
    refuse(
      "not-found",
      "member",
      `evidence session "${session.sessionId}" captured no member "${memberKey}"; it holds ${
        session.members.length === 0 ? "none" : session.members.map(({ memberKey: key }) => key).join(", ")
      }`,
    );
  }
  return member;
}
