import { createPrivateKey, createPublicKey, randomUUID, verify as edVerify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dssePreAuthEncoding, parseDsseEnvelope } from "@jinn-network/trust-core";
import { sealSubmission, TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import { buildSampleBenchmark, type SampleBenchmark } from "../intake/sample.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  createLocalVenue,
  EVALUATION_HARNESS_PIN,
  EVALUATOR_REQUIREMENT_KEY,
  SOLVE_HARNESS_PINS,
  VENUE_ISOLATION_POLICY,
  type LocalVenue,
} from "./venue.js";
import { readEvaluatorPublicKeys, readVerdictEnvelope } from "./signing.js";

const FAR_FUTURE_DEADLINE = "2099-01-01T00:00:00.000Z";
const SIX_FRACTION_DIGITS = /^-?\d+\.\d{6}$/;

function requesterUrn(): string {
  return `urn:uuid:${randomUUID()}`;
}

function submissionFor(input: {
  readonly taskSha256: string;
  readonly requirements: Record<string, unknown>;
}): Uint8Array {
  return sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: `urn:uuid:${randomUUID()}`,
    task: { digest: { sha256: input.taskSha256 } },
    requester: requesterUrn(),
    idempotencyKey: randomUUID(),
    nonce: randomUUID(),
    deadline: FAR_FUTURE_DEADLINE,
    requirements: input.requirements,
  });
}

let workspaceDir: string;
let venue: LocalVenue;
let sample: SampleBenchmark;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "bp12-venue-"));
  venue = createLocalVenue({ workspaceDir, now: () => new Date().toISOString() });
  sample = await buildSampleBenchmark();
});

afterEach(async () => {
  await venue.shutdown();
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("createLocalVenue", () => {
  it(
    "runs a prediction-forecast solve cell through prediction-v1-baseline on the real local backend",
    async () => {
      const task = sample.tasks[0]!;
      const submissionBytes = submissionFor({
        taskSha256: task.sha256,
        requirements: {
          harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"],
          isolationPolicy: VENUE_ISOLATION_POLICY,
        },
      });

      const ack = await venue.backend.submit(task.bytes, submissionBytes);
      expect(ack.accepted, JSON.stringify(ack)).toBe(true);
      if (!ack.accepted) throw new Error("unreachable");
      await venue.backend.drain();

      const snapshot = await venue.backend.observe(ack.submission);
      expect(snapshot.descriptor.derived, JSON.stringify(snapshot.observations)).toMatchObject({
        state: "delivered",
        terminal: true,
      });

      const refs = await venue.backend.deliveries(snapshot.descriptor.attempt);
      expect(refs).toHaveLength(1);
      const deliveryBytes = await venue.backend.fetchDelivery(refs[0]!);
      const delivery = JSON.parse(new TextDecoder().decode(deliveryBytes)) as {
        readonly outputs: readonly { readonly name: string; readonly mediaType?: string; readonly digest: { readonly sha256: string } }[];
      };
      expect(delivery.outputs).toHaveLength(1);
      expect(delivery.outputs[0]).toMatchObject({ name: "prediction", mediaType: "application/json" });

      const resultBytes = await venue.backend.fetchArtifact({ digest: { sha256: delivery.outputs[0]!.digest.sha256 } });
      const result = JSON.parse(new TextDecoder().decode(resultBytes)) as {
        readonly probabilityYes: string;
        readonly submittedAt: string;
      };
      // prediction-v1-baseline echoes the posted consensus verbatim, stamped at observedAt.
      expect(result.probabilityYes).toBe("0.640000");
      expect(result.submittedAt).toBe("2026-01-01T00:00:00Z");
    },
    60_000,
  );

  it(
    "runs the same solve cell through the bundled sample-uniform launcher (always predicts 0.5)",
    async () => {
      const task = sample.tasks[0]!;
      const submissionBytes = submissionFor({
        taskSha256: task.sha256,
        requirements: {
          harness: SOLVE_HARNESS_PINS["sample-uniform"],
          isolationPolicy: VENUE_ISOLATION_POLICY,
        },
      });

      const ack = await venue.backend.submit(task.bytes, submissionBytes);
      expect(ack.accepted, JSON.stringify(ack)).toBe(true);
      if (!ack.accepted) throw new Error("unreachable");
      await venue.backend.drain();

      const snapshot = await venue.backend.observe(ack.submission);
      expect(snapshot.descriptor.derived, JSON.stringify(snapshot.observations)).toMatchObject({
        state: "delivered",
        terminal: true,
      });

      const refs = await venue.backend.deliveries(snapshot.descriptor.attempt);
      expect(refs).toHaveLength(1);
      const deliveryBytes = await venue.backend.fetchDelivery(refs[0]!);
      const delivery = JSON.parse(new TextDecoder().decode(deliveryBytes)) as {
        readonly outputs: readonly { readonly name: string; readonly mediaType?: string; readonly digest: { readonly sha256: string } }[];
      };
      expect(delivery.outputs).toEqual([{
        name: "prediction",
        mediaType: "application/json",
        digest: expect.objectContaining({ sha256: expect.any(String) }),
      }]);

      const resultBytes = await venue.backend.fetchArtifact({ digest: { sha256: delivery.outputs[0]!.digest.sha256 } });
      const result = JSON.parse(new TextDecoder().decode(resultBytes)) as {
        readonly probabilityYes: string;
        readonly submittedAt: string;
      };
      expect(result.probabilityYes).toBe("0.5");
      expect(result.submittedAt).toBe("2026-01-01T00:00:00Z");
    },
    60_000,
  );

  it(
    "prepares and runs an evaluation cell that grades a completed solve, producing a signed pass verdict",
    async () => {
      const task = sample.tasks[0]!;

      // Solve leg (prediction-v1-baseline).
      const solveSubmissionBytes = submissionFor({
        taskSha256: task.sha256,
        requirements: {
          harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"],
          isolationPolicy: VENUE_ISOLATION_POLICY,
        },
      });
      const solveAck = await venue.backend.submit(task.bytes, solveSubmissionBytes);
      expect(solveAck.accepted, JSON.stringify(solveAck)).toBe(true);
      if (!solveAck.accepted) throw new Error("unreachable");
      await venue.backend.drain();
      const solveSnapshot = await venue.backend.observe(solveAck.submission);
      expect(solveSnapshot.descriptor.derived).toMatchObject({ state: "delivered", terminal: true });
      const solveRefs = await venue.backend.deliveries(solveSnapshot.descriptor.attempt);
      const subjectDeliveryBytes = await venue.backend.fetchDelivery(solveRefs[0]!);
      const subjectDelivery = JSON.parse(new TextDecoder().decode(subjectDeliveryBytes)) as {
        readonly outputs: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
      };
      const resultBytes = await venue.backend.fetchArtifact({
        digest: { sha256: subjectDelivery.outputs[0]!.digest.sha256 },
      });

      // Evaluation leg.
      const prepared = venue.prepareEvaluationCell({
        subjectTaskBytes: task.bytes,
        subjectDeliveryBytes,
        resultArtifacts: [{ name: subjectDelivery.outputs[0]!.name, bytes: resultBytes }],
        evaluationSpecBytes: sample.evaluationSpec.bytes,
      });
      expect(prepared.taskSha256).toMatch(/^[0-9a-f]{64}$/);

      // The venue's default is a single evaluator identity, evaluator-1; every evaluation
      // Submission must name the evaluator it runs under (never silently defaulted).
      expect(venue.evaluators.map((evaluator) => evaluator.id)).toEqual([
        "urn:jinn:benchmark-product:local-venue:evaluator-1",
      ]);
      const evalSubmissionBytes = submissionFor({
        taskSha256: prepared.taskSha256,
        requirements: {
          harness: EVALUATION_HARNESS_PIN,
          [EVALUATOR_REQUIREMENT_KEY]: venue.evaluators[0]!.id,
        },
      });
      const evalAck = await venue.backend.submit(prepared.taskBytes, evalSubmissionBytes);
      expect(evalAck.accepted, JSON.stringify(evalAck)).toBe(true);
      if (!evalAck.accepted) throw new Error("unreachable");
      await venue.backend.drain();
      const evalSnapshot = await venue.backend.observe(evalAck.submission);
      expect(evalSnapshot.descriptor.derived, JSON.stringify(evalSnapshot.observations)).toMatchObject({
        state: "delivered",
        terminal: true,
      });

      const evalRefs = await venue.backend.deliveries(evalSnapshot.descriptor.attempt);
      expect(evalRefs).toHaveLength(1);
      const evalDeliveryBytes = await venue.backend.fetchDelivery(evalRefs[0]!);
      const evalDelivery = JSON.parse(new TextDecoder().decode(evalDeliveryBytes)) as {
        readonly outputs: readonly { readonly name: string; readonly mediaType?: string; readonly digest: { readonly sha256: string } }[];
      };
      expect(evalDelivery.outputs).toEqual([{
        name: "verdict",
        mediaType: "application/vnd.in-toto+json",
        digest: expect.objectContaining({ sha256: expect.any(String) }),
      }]);

      const envelopeBytes = await venue.backend.fetchArtifact({
        digest: { sha256: evalDelivery.outputs[0]!.digest.sha256 },
      });
      const view = readVerdictEnvelope(envelopeBytes);
      expect(view.verdict).toBe("pass");
      expect(view.measurements["integrity"]).toBe(true);
      expect(view.measurements["resolved"]).toBe(true);
      expect(view.measurements["solverBrier"]).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));
      expect(view.measurements["consensusBrier"]).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));
      expect(view.measurements["brierSpread"]).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));
      expect(view.evaluationSpecificationSha256).toBe(sha256Hex(sample.evaluationSpec.bytes));

      // The signature verifies against evaluator-1's own workspace public key.
      const parsedEnvelope = parseDsseEnvelope(envelopeBytes);
      expect(parsedEnvelope.payloadType).toBe("application/vnd.in-toto+json");
      const [signature] = parsedEnvelope.signatures;
      expect(signature?.keyid).toBe(venue.verdictKeyId);
      expect(venue.verdictKeyId).toBe(venue.evaluators[0]!.keyId);
      const pem = await readFile(join(workspaceDir, "venue", "evaluators", "1", "verdict-signing-key.pem"), "utf8");
      const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
      const publicKey = createPublicKey(privateKey);
      const preAuthEncoding = dssePreAuthEncoding(parsedEnvelope.payloadType, parsedEnvelope.payloadBytes);
      const decodedSignature = Buffer.from(signature!.sig, "base64");
      expect(edVerify(null, Buffer.from(preAuthEncoding), publicKey, decodedSignature)).toBe(true);
    },
    60_000,
  );

  it(
    "runs one evaluation cell under each of two evaluator identities, each verdict sealed with that evaluator's own key",
    async () => {
      // Separate venue: the shared beforeEach venue is the default single-evaluator one.
      const multiWorkspaceDir = await mkdtemp(join(tmpdir(), "bp21-venue-multi-"));
      const multiVenue = createLocalVenue({
        workspaceDir: multiWorkspaceDir,
        now: () => new Date().toISOString(),
        evaluatorCount: 2,
      });
      try {
        const task = sample.tasks[0]!;
        const [evaluator1, evaluator2] = multiVenue.evaluators;
        expect(evaluator1!.keyId).not.toBe(evaluator2!.keyId);

        // Solve leg (prediction-v1-baseline), once.
        const solveAck = await multiVenue.backend.submit(task.bytes, submissionFor({
          taskSha256: task.sha256,
          requirements: {
            harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"],
            isolationPolicy: VENUE_ISOLATION_POLICY,
          },
        }));
        expect(solveAck.accepted, JSON.stringify(solveAck)).toBe(true);
        if (!solveAck.accepted) throw new Error("unreachable");
        await multiVenue.backend.drain();
        const solveSnapshot = await multiVenue.backend.observe(solveAck.submission);
        expect(solveSnapshot.descriptor.derived).toMatchObject({ state: "delivered", terminal: true });
        const solveRefs = await multiVenue.backend.deliveries(solveSnapshot.descriptor.attempt);
        const subjectDeliveryBytes = await multiVenue.backend.fetchDelivery(solveRefs[0]!);
        const subjectDelivery = JSON.parse(new TextDecoder().decode(subjectDeliveryBytes)) as {
          readonly outputs: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
        };
        const resultBytes = await multiVenue.backend.fetchArtifact({
          digest: { sha256: subjectDelivery.outputs[0]!.digest.sha256 },
        });

        // One evaluation cell, dispatched once per evaluator identity.
        const prepared = multiVenue.prepareEvaluationCell({
          subjectTaskBytes: task.bytes,
          subjectDeliveryBytes,
          resultArtifacts: [{ name: subjectDelivery.outputs[0]!.name, bytes: resultBytes }],
          evaluationSpecBytes: sample.evaluationSpec.bytes,
        });

        // A Submission naming an evaluator outside the venue's inventory refuses at submit time.
        const unknownAck = await multiVenue.backend.submit(prepared.taskBytes, submissionFor({
          taskSha256: prepared.taskSha256,
          requirements: {
            harness: EVALUATION_HARNESS_PIN,
            [EVALUATOR_REQUIREMENT_KEY]: "urn:jinn:benchmark-product:local-venue:evaluator-9",
          },
        }));
        expect(unknownAck.accepted).toBe(false);

        const publicKeys = readEvaluatorPublicKeys(multiWorkspaceDir);
        for (const evaluator of multiVenue.evaluators) {
          const evalAck = await multiVenue.backend.submit(prepared.taskBytes, submissionFor({
            taskSha256: prepared.taskSha256,
            requirements: {
              harness: EVALUATION_HARNESS_PIN,
              [EVALUATOR_REQUIREMENT_KEY]: evaluator.id,
            },
          }));
          expect(evalAck.accepted, JSON.stringify(evalAck)).toBe(true);
          if (!evalAck.accepted) throw new Error("unreachable");
          await multiVenue.backend.drain();
          const evalSnapshot = await multiVenue.backend.observe(evalAck.submission);
          expect(evalSnapshot.descriptor.derived, JSON.stringify(evalSnapshot.observations)).toMatchObject({
            state: "delivered",
            terminal: true,
          });
          const evalRefs = await multiVenue.backend.deliveries(evalSnapshot.descriptor.attempt);
          const evalDeliveryBytes = await multiVenue.backend.fetchDelivery(evalRefs[0]!);
          const evalDelivery = JSON.parse(new TextDecoder().decode(evalDeliveryBytes)) as {
            readonly outputs: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
          };
          const envelopeBytes = await multiVenue.backend.fetchArtifact({
            digest: { sha256: evalDelivery.outputs[0]!.digest.sha256 },
          });

          // The verdict statement carries THIS evaluator's identity...
          const view = readVerdictEnvelope(envelopeBytes);
          expect(view.evaluatorId).toBe(evaluator.id);
          expect(view.verdict).toBe("pass");

          // ...and its DSSE signature is THIS evaluator's own key, verified via the registry.
          const parsedEnvelope = parseDsseEnvelope(envelopeBytes);
          expect(parsedEnvelope.signatures[0]?.keyid).toBe(evaluator.keyId);
          const preAuthEncoding = dssePreAuthEncoding(parsedEnvelope.payloadType, parsedEnvelope.payloadBytes);
          const decodedSignature = Buffer.from(parsedEnvelope.signatures[0]!.sig, "base64");
          expect(edVerify(null, Buffer.from(preAuthEncoding), publicKeys.get(evaluator.id)!, decodedSignature)).toBe(true);
        }
      } finally {
        await multiVenue.shutdown();
        await rm(multiWorkspaceDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
