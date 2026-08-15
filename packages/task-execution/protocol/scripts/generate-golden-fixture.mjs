import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(packageRoot, "fixtures", "golden-task-execution-v1");

const { sealDelivery, sealSubmission, sealTask } = await import("../dist/sealing.js");
const { documentDigest, sha256Hex } = await import("../dist/hashing.js");
const { deriveAttemptUri } = await import("../dist/identifiers.js");

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const decode = (bytes) => new TextDecoder().decode(bytes);

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

// --- one Task, sealed once (§24: "a complete local-and-marketplace scenario pair over one Task
// digest") ---
const taskDocument = {
  protocol: "https://spec.jinn.network/profiles/task-execution/v1",
  profile: {
    uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
    digest: {
      sha256: sha256Hex(
        Buffer.from("golden fixture placeholder repository-work profile v1"),
      ),
    },
  },
  instructions: "Normalize the slug helper and add a regression test.",
  outputs: [
    { name: "patch", mediaType: "text/x-diff", required: true },
  ],
  requirements: {
    maxAttemptDurationMs: 600000,
    effort: "medium",
  },
};
const taskBytes = sealTask(taskDocument);
const taskDigest = documentDigest(taskBytes);
await write(join(fixtureRoot, "task.json"), taskBytes);

// --- one artifact the golden Deliveries reference ---
const patchArtifactBytes = Buffer.from(
  [
    "diff --git a/src/slug.ts b/src/slug.ts",
    "--- a/src/slug.ts",
    "+++ b/src/slug.ts",
    "@@ -1 +1 @@",
    "-export const slug = (s: string) => s;",
    "+export const slug = (s: string) => s.trim().toLowerCase();",
    "",
  ].join("\n"),
);
await write(join(fixtureRoot, "artifacts", "patch.diff"), patchArtifactBytes);
const patchDigestHex = sha256Hex(patchArtifactBytes);

function terminalDeliveredLog({ attempt, submission, executor, effectiveDeadline, source, deliveryDigest }) {
  return [
    {
      specversion: "1.0",
      id: "evt-1",
      source,
      subject: attempt,
      time: "2026-07-28T00:00:00Z",
      datacontenttype: "application/json",
      sequence: "0000000000000001",
      taskdigest: taskDigest,
      type: "network.jinn.task-execution.attempt-engaged.v1",
      data: {
        attempt,
        task: taskDigest,
        submission,
        executor,
        effectiveDeadline,
        source,
        dispatchContext: {
          uri: `https://example.test/dispatch-context/${attempt}.json`,
          digest: { sha256: sha256Hex(Buffer.from(attempt)) },
        },
      },
    },
    {
      specversion: "1.0",
      id: "evt-2",
      source,
      subject: attempt,
      time: "2026-07-28T00:01:00Z",
      datacontenttype: "application/json",
      sequence: "0000000000000002",
      taskdigest: taskDigest,
      type: "network.jinn.task-execution.attempt-started.v1",
      data: { startedAt: "2026-07-28T00:01:00Z", executor },
    },
    {
      specversion: "1.0",
      id: "evt-3",
      source,
      subject: attempt,
      time: "2026-07-28T00:05:00Z",
      datacontenttype: "application/json",
      sequence: "0000000000000003",
      taskdigest: taskDigest,
      type: "network.jinn.task-execution.delivery-recorded.v1",
      data: { digest: deliveryDigest },
    },
    {
      specversion: "1.0",
      id: "evt-4",
      source,
      subject: attempt,
      time: "2026-07-28T00:05:30Z",
      datacontenttype: "application/json",
      sequence: "0000000000000004",
      taskdigest: taskDigest,
      type: "network.jinn.task-execution.attempt-terminal.v1",
      data: { state: "delivered" },
    },
  ];
}

const report = { taskDigest, scenarios: {} };

// --- local scenario: single-party binding, random Attempt URI (§9.2) ---
{
  const attempt = "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa";
  const submissionUri = "urn:uuid:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb";
  const source = "urn:jinn:backend:local";
  const submissionDocument = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: submissionUri,
    task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
    requester: "urn:uuid:cccccccc-cccc-5ccc-8ccc-cccccccccccc",
    idempotencyKey: "golden-local-1",
    nonce: "golden-local-nonce-1",
    deadline: "2026-07-29T00:00:00Z",
  };
  const submissionBytes = sealSubmission(submissionDocument);
  await write(join(fixtureRoot, "local", "submission.json"), submissionBytes);

  const deliveryDocument = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt,
    task: taskDigest,
    outputs: [
      { name: "patch", digest: { sha256: patchDigestHex }, mediaType: "text/x-diff" },
    ],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
  };
  const deliveryBytes = sealDelivery(deliveryDocument);
  const deliveryDigest = documentDigest(deliveryBytes);
  await write(join(fixtureRoot, "local", "delivery.json"), deliveryBytes);

  const observations = terminalDeliveredLog({
    attempt,
    submission: submissionUri,
    executor: "urn:jinn:agent:local-operator",
    effectiveDeadline: "2026-07-29T00:00:00Z",
    source,
    deliveryDigest,
  });
  await write(join(fixtureRoot, "local", "observations.json"), json(observations));

  report.scenarios.local = {
    submission: submissionUri,
    submissionDigest: documentDigest(submissionBytes),
    attempt,
    deliveryDigest,
  };
}

// --- marketplace scenario: two-party binding, deterministic Attempt URI (§9.2/§16.2) ---
{
  const chainId = 8453; // Base mainnet
  const coordinatorAddress = "0xfFa7118A3D820cd4E820010837D65FAfF463181B"; // JinnRouter (CLAUDE.md)
  const taskId = "golden-task-1";
  const attemptIndex = 0;
  const attempt = deriveAttemptUri("jinn:marketplace", [chainId, coordinatorAddress, taskId, attemptIndex]);
  const submissionUri = "urn:uuid:dddddddd-dddd-5ddd-8ddd-dddddddddddd";
  const source = "urn:jinn:backend:marketplace";
  const submissionDocument = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: submissionUri,
    task: { digest: { sha256: taskDigest.slice("sha256:".length) } },
    requester: "urn:uuid:eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee",
    idempotencyKey: "golden-marketplace-1",
    nonce: "golden-marketplace-nonce-1",
    deadline: "2026-07-29T00:00:00Z",
    annotations: {
      "network.jinn.marketplace/chainId": chainId,
      "network.jinn.marketplace/coordinator": coordinatorAddress,
      "network.jinn.marketplace/taskId": taskId,
    },
  };
  const submissionBytes = sealSubmission(submissionDocument);
  await write(join(fixtureRoot, "marketplace", "submission.json"), submissionBytes);

  const deliveryDocument = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    attempt,
    task: taskDigest,
    outputs: [
      { name: "patch", digest: { sha256: patchDigestHex }, mediaType: "text/x-diff" },
    ],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
  };
  const deliveryBytes = sealDelivery(deliveryDocument);
  const deliveryDigest = documentDigest(deliveryBytes);
  await write(join(fixtureRoot, "marketplace", "delivery.json"), deliveryBytes);

  const observations = terminalDeliveredLog({
    attempt,
    submission: submissionUri,
    executor: "urn:jinn:agent:marketplace-operator-1",
    effectiveDeadline: "2026-07-29T00:00:00Z",
    source,
    deliveryDigest,
  });
  await write(join(fixtureRoot, "marketplace", "observations.json"), json(observations));

  report.scenarios.marketplace = {
    submission: submissionUri,
    submissionDigest: documentDigest(submissionBytes),
    attempt,
    deliveryDigest,
    correlationTuple: { chainId, coordinatorAddress, taskId, attemptIndex },
  };
}

await write(join(fixtureRoot, "conformance-report.json"), json(report));

// --- equivalence record: two key-permuted Task inputs that seal to the same digest ---
const equivalenceA = {
  protocol: taskDocument.protocol,
  profile: taskDocument.profile,
  instructions: taskDocument.instructions,
  outputs: taskDocument.outputs,
  requirements: taskDocument.requirements,
};
const equivalenceB = {
  requirements: { effort: "medium", maxAttemptDurationMs: 600000 },
  outputs: taskDocument.outputs,
  instructions: taskDocument.instructions,
  protocol: taskDocument.protocol,
  profile: {
    digest: taskDocument.profile.digest,
    uri: taskDocument.profile.uri,
  },
};
const equivalenceABytes = sealTask(equivalenceA);
const equivalenceBBytes = sealTask(equivalenceB);
const equivalenceDigest = documentDigest(equivalenceABytes);
if (documentDigest(equivalenceBBytes) !== equivalenceDigest) {
  throw new Error("equivalence fixture generation failed: digests diverged across key order");
}
await write(join(fixtureRoot, "equivalence", "task-a.json"), equivalenceABytes);
await write(join(fixtureRoot, "equivalence", "task-b.json"), equivalenceBBytes);
await write(
  join(fixtureRoot, "equivalence", "expected-digest.json"),
  json({ digest: equivalenceDigest }),
);

console.log(`Generated golden fixture set. Task digest: ${taskDigest}`);
