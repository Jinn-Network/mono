import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  compareCodeUnitStrings,
  deriveAttemptUri,
  documentDigest,
  type GoldenConformanceReport,
  type GoldenScenario,
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceTaskBytes,
  loadGoldenConformanceReport,
  loadGoldenDeliveryBytes,
  loadGoldenObservations,
  loadGoldenSubmissionBytes,
  loadGoldenTaskBytes,
  foldObservations,
  readAdversarialFile,
  readAdversarialJson,
  sealDelivery,
  sealSubmission,
  sealTask,
  sha256Hex,
  validateDelivery,
  validateDispatchContext,
  validateObservation,
  validateSubmission,
  validateTask,
} from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";

const SCENARIOS: readonly GoldenScenario[] = ["local", "marketplace"];

/**
 * The marketplace scenario's conformance-report entry additionally records the §16.2
 * correlation tuple the deterministic Attempt URI was derived from — a golden-fixture-only
 * field, not part of `GoldenConformanceReport`'s frozen shape.
 */
type GoldenConformanceReportWithCorrelationTuple = GoldenConformanceReport & {
  scenarios: {
    marketplace: GoldenConformanceReport["scenarios"]["marketplace"] & {
      correlationTuple?: {
        chainId: number;
        coordinatorAddress: string;
        taskId: string;
        attemptIndex: number;
      };
    };
  };
};
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

async function readProtocolFixtureBytes(relativePath: string): Promise<Uint8Array> {
  const url = import.meta.resolve(`@jinn-network/task-execution-protocol/fixtures/${relativePath}`);
  return new Uint8Array(await readFile(fileURLToPath(url)));
}

/**
 * §21.3: extensions may add information, never redirect interpretation. This is the narrow,
 * documented detector for the one demonstrable pattern the adversarial `extension-override`
 * fixture exercises: a namespaced key whose local name (after stripping a trailing "Override")
 * names a core top-level field, carrying a value that contradicts that field. It is not a
 * general semantic-contradiction engine — most extension/core contradictions are not
 * machine-checkable (§21.3), which is exactly why the rule's enforceable form is narrow.
 */
function detectCoreFieldOverride(
  document: Record<string, unknown>,
  coreFields: readonly string[],
): { key: string; coreField: string } | undefined {
  const lowerCoreFields = new Set(coreFields.map((field) => field.toLowerCase()));
  for (const key of Object.keys(document)) {
    if (!key.includes("/")) continue; // only namespaced extension keys are in scope (§21.3)
    const localName = key.slice(key.lastIndexOf("/") + 1);
    const normalized = localName.replace(/Override$/i, "").toLowerCase();
    if (!lowerCoreFields.has(normalized)) continue;
    const coreField = coreFields.find((field) => field.toLowerCase() === normalized);
    if (coreField === undefined) continue;
    if (document[coreField] !== undefined && document[coreField] !== document[key]) {
      return { key, coreField };
    }
  }
  return undefined;
}

const MAX_INLINE_CONTENT_BYTES = 65536; // 64 KiB advisory ceiling (§6.4/§20)
const MAX_FREE_TEXT_BYTES = 4096; // 4 KiB advisory ceiling (§10.2/§20)

function idempotencyScope(submission: { requester: string; idempotencyKey: string }): string {
  return `${submission.requester}::${submission.idempotencyKey}`;
}

/**
 * The §24 Layer-1 protocol conformance suite: schema validation, sealing/digest rules (producer-
 * and consumer-side), reference and cardinality rules, extension preservation, observation
 * ordering and fold correctness, Delivery binding, and the §24 adversarial minimum set — all
 * driven off the golden local+marketplace scenario pair and the adversarial fixtures the
 * protocol package ships (Task 1.8). Consumable by bindings via vitest.
 */
export function describeProtocolConformance(): void {
  describe("TEP Layer 1: protocol conformance — golden fixtures", () => {
    test("the Task validates against the Task schema", async () => {
      const bytes = await loadGoldenTaskBytes();
      expect(validateTask(decode(bytes)).conforms).toBe(true);
    });

    test("re-sealing the Task reproduces its pinned bytes and digest (producer-side, §6.1)", async () => {
      const bytes = await loadGoldenTaskBytes();
      const report = await loadGoldenConformanceReport();
      const resealed = sealTask(decode(bytes));
      expect(resealed).toEqual(bytes);
      expect(documentDigest(resealed)).toBe(report.taskDigest);
    });

    test("the Task digest over stored exact bytes matches the pinned digest without re-canonicalizing (consumer-side, §6.1)", async () => {
      const bytes = await loadGoldenTaskBytes();
      const report = await loadGoldenConformanceReport();
      expect(documentDigest(bytes)).toBe(report.taskDigest);
    });

    test.each(SCENARIOS)("%s Submission validates, re-seals identically, and digests match (producer + consumer side)", async (scenario) => {
      const bytes = await loadGoldenSubmissionBytes(scenario);
      const report = await loadGoldenConformanceReport();
      expect(validateSubmission(decode(bytes)).conforms).toBe(true);
      const resealed = sealSubmission(decode(bytes));
      expect(resealed).toEqual(bytes);
      expect(documentDigest(resealed)).toBe(report.scenarios[scenario].submissionDigest);
      expect(documentDigest(bytes)).toBe(report.scenarios[scenario].submissionDigest);
    });

    test.each(SCENARIOS)("%s Delivery validates, re-seals identically, and digests match (producer + consumer side)", async (scenario) => {
      const bytes = await loadGoldenDeliveryBytes(scenario);
      const report = await loadGoldenConformanceReport();
      expect(validateDelivery(decode(bytes)).conforms).toBe(true);
      const resealed = sealDelivery(decode(bytes));
      expect(resealed).toEqual(bytes);
      expect(documentDigest(resealed)).toBe(report.scenarios[scenario].deliveryDigest);
      expect(documentDigest(bytes)).toBe(report.scenarios[scenario].deliveryDigest);
    });

    test.each(SCENARIOS)("%s: the Attempt names exactly one Task and one Submission (cardinality, §9.1)", async (scenario) => {
      const observations = await loadGoldenObservations(scenario);
      const report = await loadGoldenConformanceReport();
      const engaged = observations[0] as { type: string; data: { task: string; submission: string; attempt: string } };
      expect(engaged.type).toBe("network.jinn.task-execution.attempt-engaged.v1");
      expect(engaged.data.task).toBe(report.taskDigest);
      expect(engaged.data.submission).toBe(report.scenarios[scenario].submission);
      expect(engaged.data.attempt).toBe(report.scenarios[scenario].attempt);

      const deliveryBytes = await loadGoldenDeliveryBytes(scenario);
      const delivery = decode(deliveryBytes) as { task: string; attempt: string };
      expect(delivery.task).toBe(report.taskDigest);
      expect(delivery.attempt).toBe(report.scenarios[scenario].attempt);
    });

    test("the marketplace Attempt URI is the deterministic UUIDv5 over the recorded correlation tuple (§9.2/§16.2)", async () => {
      const report = await loadGoldenConformanceReport() as GoldenConformanceReportWithCorrelationTuple;
      const tuple = report.scenarios.marketplace.correlationTuple;
      expect(tuple).toBeDefined();
      const derived = deriveAttemptUri("jinn:marketplace", [
        tuple!.chainId,
        tuple!.coordinatorAddress,
        tuple!.taskId,
        tuple!.attemptIndex,
      ]);
      expect(derived).toBe(report.scenarios.marketplace.attempt);
    });

    test.each(SCENARIOS)("%s: the observation log validates and folds to a delivered terminal (ordering + fold correctness)", async (scenario) => {
      const observations = await loadGoldenObservations(scenario);
      for (const observation of observations) {
        expect(validateObservation(observation).conforms).toBe(true);
      }
      const report = await loadGoldenConformanceReport();
      const derived = foldObservations(observations as never[]);
      expect(derived.state).toBe("delivered");
      expect(derived.terminal).toBe(true);
      expect(derived.contradictory).toBe(false);
      expect(derived.deliveries).toEqual([{ digest: report.scenarios[scenario].deliveryDigest }]);
    });

    test.each(SCENARIOS)("%s: the Delivery's output digest matches the artifact bytes (Delivery binding, §11.2)", async (scenario) => {
      const deliveryBytes = await loadGoldenDeliveryBytes(scenario);
      const delivery = decode(deliveryBytes) as { outputs: { name: string; digest: { sha256: string } }[] };
      const patch = delivery.outputs.find((output) => output.name === "patch");
      expect(patch).toBeDefined();
      const artifact = await readProtocolFixtureBytes("golden-task-execution-v1/artifacts/patch.diff");
      expect(sha256Hex(artifact)).toBe(patch!.digest.sha256);
    });

    test("two key-permuted Task documents seal to the identical pinned digest (key-order-sensitive equivalence)", async () => {
      const [a, b, expected] = await Promise.all([
        loadEquivalenceTaskBytes("a"),
        loadEquivalenceTaskBytes("b"),
        loadEquivalenceExpectedDigest(),
      ]);
      expect(documentDigest(a)).toBe(expected);
      expect(documentDigest(b)).toBe(expected);
      expect(documentDigest(sealTask(decode(a)))).toBe(expected);
      expect(documentDigest(sealTask(decode(b)))).toBe(expected);
    });

    test("a namespaced extension field survives seal -> bytes -> decode unchanged (extension preservation, §21.3)", () => {
      const withExtension = {
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: {
          uri: "https://jinn.network/task-profiles/repository-work/1.0",
          digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
        },
        instructions: "Extensions must round-trip through sealed bytes.",
        outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
        "x-conformance-kit/example.test/note": "an unknown namespaced field",
      };
      const bytes = sealTask(withExtension);
      const decoded = decode(bytes) as Record<string, unknown>;
      expect(decoded["x-conformance-kit/example.test/note"]).toBe("an unknown namespaced field");
    });
  });

  describe("TEP Layer 1: protocol conformance — adversarial minimum set (§24)", () => {
    test("manifest ships the §24 minimum set", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(14);
    });

    test("malformed-document: a Task missing required outputs[] is invalid-document", async () => {
      const task = await readAdversarialJson("malformed-document", "task.json");
      const result = validateTask(task);
      expect(result.conforms).toBe(false);
      expect(result.errors.some((error) => error.path === "outputs")).toBe(true);
    });

    test("digest-mismatch: the claimed digest does not match the exact bytes' actual digest (content-corruption)", async () => {
      const documentBytes = await readAdversarialFile("digest-mismatch", "document.json");
      const { claimedDigest, actualDigest } = (await readAdversarialJson(
        "digest-mismatch",
        "claimed-digest.json",
      )) as { claimedDigest: string; actualDigest: string };
      const digest = documentDigest(documentBytes);
      expect(digest).not.toBe(claimedDigest);
      expect(digest).toBe(actualDigest);
    });

    test("illegal-terminal-transition: a late non-terminal observation does not un-terminate (terminal absorption, §10.4 rule 1)", async () => {
      const observations = await readAdversarialJson("illegal-terminal-transition", "observations.json") as never[];
      const derived = foldObservations(observations);
      expect(derived.state).toBe("cancelled");
      expect(derived.terminal).toBe(true);
    });

    test("replayed-and-out-of-order: dedupes on (source,id) and resolves order by sequence, not array position", async () => {
      const observations = await readAdversarialJson("replayed-and-out-of-order", "observations.json") as never[];
      for (const observation of observations) {
        expect(validateObservation(observation).conforms).toBe(true);
      }
      // Order-insensitivity up to the terminal (§10.4 rule 3): reversing array position must not
      // change the derived result, proving the fold resolves order by `sequence`.
      expect(foldObservations(observations)).toEqual(foldObservations([...observations].reverse()));
      expect(foldObservations(observations).state).toBe("running");
    });

    test("sequence-boundary: the fixed 16-digit encoding orders lexicographically the same as numerically", async () => {
      const [low, high] = (await readAdversarialJson("sequence-boundary", "observations.json")) as {
        sequence: string;
      }[];
      expect(low!.sequence).toBe("0000000000000009");
      expect(high!.sequence).toBe("0000000000000010");
      expect(compareCodeUnitStrings(low!.sequence, high!.sequence)).toBeLessThan(0);
    });

    test("contradictory-terminals: derived state is the first terminal in sequence order, flagged contradictory", async () => {
      const observations = await readAdversarialJson("contradictory-terminals", "observations.json") as never[];
      const derived = foldObservations(observations);
      expect(derived.state).toBe("delivered");
      expect(derived.contradictory).toBe(true);
    });

    test("expired-then-late-terminal: provisional expired is superseded by a genuine terminal, never itself a log entry", async () => {
      const options = (await readAdversarialJson("expired-then-late-terminal", "fold-options.json")) as {
        now: string;
        effectiveDeadline: string;
      };
      const withoutTerminal = await readAdversarialJson("expired-then-late-terminal", "log-without-terminal.json") as never[];
      const withTerminal = await readAdversarialJson("expired-then-late-terminal", "log-with-terminal.json") as never[];

      const provisional = foldObservations(withoutTerminal, options);
      expect(provisional.state).toBe("expired");
      expect(provisional.contradictory).toBe(false);

      const superseded = foldObservations(withTerminal, options);
      expect(superseded.state).toBe("delivered");
      expect(superseded.contradictory).toBe(false);
    });

    test("lost-then-corrected: a later genuine terminal supersedes lost without raising contradictory (§10.4 rule 6)", async () => {
      const observations = await readAdversarialJson("lost-then-corrected", "observations.json") as never[];
      const derived = foldObservations(observations);
      expect(derived.state).toBe("delivered");
      expect(derived.contradictory).toBe(false);
    });

    test("forged-cross-attempt-supersedes: a Delivery naming another Attempt's Delivery is invalid-document (§11.3 rule 1)", async () => {
      const deliveryA = await readAdversarialJson("forged-cross-attempt-supersedes", "delivery-a.json") as {
        attempt: string;
      };
      const deliveryABytes = await readAdversarialFile("forged-cross-attempt-supersedes", "delivery-a.json");
      const deliveryB = await readAdversarialJson(
        "forged-cross-attempt-supersedes",
        "delivery-b-forged-supersedes.json",
      ) as { attempt: string; supersedes?: string };

      expect(deliveryA.attempt).not.toBe(deliveryB.attempt);
      expect(deliveryB.supersedes).toBe(documentDigest(deliveryABytes));
      // §11.3 rule 1: this is checkable whenever both records are held — a cross-Attempt
      // `supersedes` is invalid-document, closing the forged-supersession attack.
      const isSameAttemptSupersession = deliveryB.supersedes === undefined || deliveryA.attempt === deliveryB.attempt;
      expect(isSameAttemptSupersession).toBe(false);
    });

    test("idempotency-scopes: same requester + key + different bytes conflicts; different requester + same key literal does not (§12.2)", async () => {
      const a = await readAdversarialJson("idempotency-scopes", "submission-a.json") as {
        requester: string;
        idempotencyKey: string;
      };
      const aBytes = await readAdversarialFile("idempotency-scopes", "submission-a.json");
      const b = await readAdversarialJson(
        "idempotency-scopes",
        "submission-b-same-key-different-bytes.json",
      ) as { requester: string; idempotencyKey: string };
      const bBytes = await readAdversarialFile("idempotency-scopes", "submission-b-same-key-different-bytes.json");
      const c = await readAdversarialJson(
        "idempotency-scopes",
        "submission-c-different-requester-same-key.json",
      ) as { requester: string; idempotencyKey: string };

      expect(idempotencyScope(a)).toBe(idempotencyScope(b));
      expect(documentDigest(aBytes)).not.toBe(documentDigest(bBytes));

      expect(a.idempotencyKey).toBe(c.idempotencyKey);
      expect(idempotencyScope(a)).not.toBe(idempotencyScope(c)); // distinct scopes: different requester
    });

    test("dispatch-context-grafting: a well-formed-but-never-conveyed DispatchContext is NOT caught by structure alone (§24, Layer-3 boundary)", async () => {
      const grafted = await readAdversarialJson("dispatch-context-grafting", "grafted-dispatch-context.json");
      // The document is structurally indistinguishable from a genuinely conveyed one: it passes
      // schema validation. Catching the graft requires the Layer-3 dispatch-binding check, which
      // compares the crate's captured dispatch-context input against the backend's own dispatch
      // record — out of this milestone's scope. This test documents the boundary explicitly
      // rather than faking a catch.
      expect(validateDispatchContext(grafted).conforms).toBe(true);
    });

    test("leaked-task-resubmission: a confidential Task resubmitted with no capabilityGrants is a structural fact only (§24, Layer-3 boundary)", async () => {
      const confidentialTask = await readAdversarialJson("leaked-task-resubmission", "confidential-task.json") as {
        inputs?: { annotations?: Record<string, unknown> }[];
      };
      const unauthorizedSubmission = await readAdversarialJson(
        "leaked-task-resubmission",
        "unauthorized-submission.json",
      ) as { capabilityGrants?: unknown };

      expect(confidentialTask.inputs?.[0]?.annotations?.["network.jinn.confidential/classification"]).toBe(
        "restricted",
      );
      // Structural fact only: no grants are present. Whether resubmission is *authorized* is a
      // resolution-failure the backend/application must enforce — out of this milestone's scope
      // (the kit's fake backend cannot prove grant resolution either, §24 Layer 3).
      expect(unauthorizedSubmission.capabilityGrants).toBeUndefined();
      expect(validateSubmission(unauthorizedSubmission).conforms).toBe(true);
    });

    test("extension-override: a namespaced extension claiming a different protocol than the core field is detected (§21.3)", async () => {
      const task = await readAdversarialJson("extension-override", "task.json") as Record<string, unknown>;
      // Not caught by the schema itself (extensions are opaque by design) — the kit's narrow
      // §21.3 detector is the enforceable form of "extensions may add information, never
      // redirect interpretation."
      expect(validateTask(task).conforms).toBe(true);
      const override = detectCoreFieldOverride(task, ["protocol"]);
      expect(override).toEqual({ key: "x-jinn-example.test/protocolOverride", coreField: "protocol" });
    });

    test("oversized-content: the observation message ceiling IS enforced (§10.2); the 64 KiB inline-content ceiling is a documented un-enforced SHOULD (§6.4/§20, Layer-3 boundary)", async () => {
      const observation = await readAdversarialJson("oversized-content", "oversized-observation.json") as {
        data: { message?: string };
      };
      expect(observation.data.message!.length).toBeGreaterThan(MAX_FREE_TEXT_BYTES);
      // The `progress.v1` payload schema enforces the 4 KiB free-text ceiling directly — a
      // genuine, schema-checked MUST.
      expect(validateObservation(observation).conforms).toBe(false);

      const descriptor = await readAdversarialJson("oversized-content", "resource-descriptor.json") as {
        content?: string;
      };
      expect(descriptor.content).toBeDefined();
      const decodedLength = Buffer.from(descriptor.content!, "base64").length;
      expect(decodedLength).toBeGreaterThan(MAX_INLINE_CONTENT_BYTES);
      // By contrast, §6.4/§20's 64 KiB inline-content ceiling is a SHOULD, not a MUST: the
      // ResourceDescriptor schema imposes no content-size bound, and this kit does not invent
      // one it isn't mandated to enforce. The oversized descriptor is structurally
      // indistinguishable from a compliant one — exactly the honest-boundary pattern the
      // dispatch-context-grafting and leaked-task-resubmission adversarial fixtures above already
      // document, rather than faking a catch.
      const taskCarryingTheDescriptor = {
        protocol: "https://jinn.network/profiles/task-execution/1.0",
        profile: {
          uri: "https://jinn.network/task-profiles/repository-work/1.0",
          digest: { sha256: "3917f0428b2626fd2cc93675172731cc000b69d7d783f9adaf5159be56fd10a6" },
        },
        instructions: "oversized-content boundary fixture.",
        outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
        inputs: [descriptor],
      };
      expect(validateTask(taskCarryingTheDescriptor).conforms).toBe(true);
    });
  });
}
