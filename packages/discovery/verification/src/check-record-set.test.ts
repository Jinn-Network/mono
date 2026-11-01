// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalJsonBytes, dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { TASK_EXECUTION_PROTOCOL_URI, sealDelivery, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  buildRfc3161AnchorEvidenceRecord,
  createFixtureAuthority,
} from "@jinn-network/trust-testing";

import { checkRecordSet, didKeyFromEd25519PublicKey, recordDigest } from "./index.js";
import type { RecordSetInputRecord } from "./index.js";

const PROFILE = canonicalJsonBytes({ note: "a held profile document" });
const hex = (bytes: Uint8Array) => recordDigest(bytes).slice("sha256:".length);

const ATTEMPT = "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ATTEMPT = "urn:uuid:eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee";
const SOURCE = "urn:jinn:backend:local";

const task = sealTask({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  profile: { uri: "https://spec.jinn.network/task-profiles/repository-work/1.0", digest: { sha256: hex(PROFILE) } },
  instructions: "Normalize the slug helper.",
  outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
});
const taskDigest = recordDigest(task);

function delivery(overrides: Record<string, unknown> = {}): Uint8Array {
  return sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: ATTEMPT,
    task: taskDigest,
    outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "3".repeat(64) } }],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
    ...overrides,
  });
}

function observation(type: string, id: string, sequence: number, data: unknown, overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    specversion: "1.0",
    id,
    source: SOURCE,
    subject: ATTEMPT,
    time: "2026-07-28T00:00:00Z",
    datacontenttype: "application/json",
    sequence: String(sequence).padStart(16, "0"),
    taskdigest: taskDigest,
    type: `network.jinn.task-execution.${type}.v1`,
    data,
    ...overrides,
  }));
}

const ENGAGED = {
  attempt: ATTEMPT,
  task: taskDigest,
  submission: "urn:uuid:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
  effectiveDeadline: "2026-07-29T00:00:00Z",
  source: SOURCE,
  dispatchContext: { digest: { sha256: "6".repeat(64) } },
};

function records(...bytes: readonly Uint8Array[]): readonly RecordSetInputRecord[] {
  return bytes.map((entry) => ({ bytes: entry }));
}

async function set(roots: readonly string[], ...bytes: readonly Uint8Array[]) {
  const report = await checkRecordSet({ records: records(...bytes), roots });
  const [references, lifecycle, anchors] = report.checks;
  return { report, references, lifecycle, anchors };
}

describe("references", () => {
  test("a closed set passes, walking from the roots through every record", async () => {
    const closing = delivery();
    const { references } = await set([recordDigest(closing)], closing, task, PROFILE);
    expect(references).toMatchObject({ id: "references", status: "passed", reached: 3, unreached: 0, resolved: 2, dangling: 0 });
  });

  test("a Delivery whose Task is not held dangles", async () => {
    const lone = delivery();
    const { references, report } = await set([recordDigest(lone)], lone);
    expect(references).toMatchObject({ status: "failed", dangling: 1 });
    expect(references.findings).toEqual(expect.arrayContaining([{
      code: "dangling-reference",
      subject: recordDigest(lone),
      path: "/task",
      detail: expect.stringContaining(taskDigest),
    }]));
    // A set can fail where no single record did.
    expect(report.records[0]!.outcome).toBe("checked");
  });

  test("a Submission whose Task is not held dangles", async () => {
    const submission = sealSubmission({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      submission: "urn:uuid:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
      task: { digest: { sha256: "9".repeat(64) } },
      requester: "urn:uuid:cccccccc-cccc-5ccc-8ccc-cccccccccccc",
      idempotencyKey: "key-1",
      nonce: "nonce-1",
      deadline: "2026-07-29T00:00:00Z",
    });
    const { references } = await set([recordDigest(submission)], submission);
    expect(references.findings[0]).toMatchObject({ code: "dangling-reference", path: "/task/digest/sha256" });
  });

  test("an output the family lets a reader lack is unavailable, not dangling", async () => {
    const closing = delivery();
    const { references } = await set([recordDigest(closing)], closing, task, PROFILE);
    expect(references).toMatchObject({ status: "passed", unavailable: 1 });
    expect(references.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "references-unavailable" })]));
  });

  test("a held output is resolved", async () => {
    const output = new TextEncoder().encode("the patch");
    const closing = delivery({ outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: hex(output) } }] });
    const { references } = await set([recordDigest(closing)], closing, task, PROFILE, output);
    expect(references).toMatchObject({ status: "passed", resolved: 3, unavailable: 0 });
  });

  test("a reference resolves through a published document, which is not a record of the set", async () => {
    const lone = delivery();
    const report = await checkRecordSet({ records: records(lone, task), roots: [recordDigest(lone)], published: [PROFILE] });
    expect(report.checks[0]).toMatchObject({ status: "passed", resolved: 1, resolvedPublished: 1, dangling: 0 });
    expect(report.summary.records).toBe(2);
    expect(report.records).toHaveLength(2);
  });

  test("a published document resolves only the digest its bytes hash to", async () => {
    const lone = delivery();
    const tampered = PROFILE.slice();
    tampered[2] = tampered[2]! ^ 1;
    const report = await checkRecordSet({ records: records(lone, task), roots: [recordDigest(lone)], published: [tampered] });
    expect(report.checks[0]).toMatchObject({ status: "failed", resolvedPublished: 0, dangling: 1 });
  });

  test("a held record is resolved as held even if it is also published", async () => {
    const lone = delivery();
    const report = await checkRecordSet({ records: records(lone, task, PROFILE), roots: [recordDigest(lone)], published: [PROFILE] });
    expect(report.checks[0]).toMatchObject({ resolved: 2, resolvedPublished: 0 });
  });

  test("a published document is not a root", async () => {
    const report = await checkRecordSet({ records: records(task), roots: [recordDigest(PROFILE)], published: [PROFILE] });
    expect(report.checks[0].findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "root-missing" })]));
  });

  test("bytes the family lets a reader lack resolve through a published document too", async () => {
    const artifact = new TextEncoder().encode("published artifact");
    const closing = delivery({ outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: hex(artifact) } }] });
    const report = await checkRecordSet({ records: records(closing, task, PROFILE), roots: [recordDigest(closing)], published: [artifact] });
    expect(report.checks[0]).toMatchObject({ resolvedPublished: 1, unavailable: 0 });
  });

  test("a root the set does not hold fails", async () => {
    const missing = `sha256:${"7".repeat(64)}`;
    const { references } = await set([missing], task, PROFILE);
    expect(references.status).toBe("failed");
    expect(references.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "root-missing", subject: missing })]));
  });

  test("what no root reaches is counted, because its references were not followed", async () => {
    const { references } = await set([recordDigest(task)], delivery(), task, PROFILE);
    expect(references).toMatchObject({ status: "passed", reached: 2, unreached: 1 });
    expect(references.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "records-not-reached" })]));
  });

  test("a reached record of unknown kind is opaque: its references were not read", async () => {
    const { references } = await set([recordDigest(PROFILE)], PROFILE);
    expect(references).toMatchObject({ status: "skipped", opaque: 1 });
    expect(references.findings).toEqual([expect.objectContaining({ code: "no-references-read" })]);
  });

  test("a record that failed its schema is not walked", async () => {
    const broken = canonicalJsonBytes({ protocol: TASK_EXECUTION_PROTOCOL_URI, attempt: ATTEMPT, task: taskDigest });
    const { references } = await set([recordDigest(broken)], broken);
    expect(references).toMatchObject({ opaque: 1, dangling: 0 });
  });

  test("a kind whose references throw is opaque, not a thrown error", async () => {
    const TYPE = "https://example.test/records/note/v1";
    const note = canonicalJsonBytes({ protocol: TYPE });
    const report = await checkRecordSet({
      records: [{ bytes: note }],
      roots: [recordDigest(note)],
      kinds: {
        [TYPE]: {
          family: "example",
          identify: () => true,
          validate: () => [],
          unsignedBecause: "notes are not signed",
          references: () => { throw new Error("references bug"); },
        },
      },
    });
    expect(report.checks[0]).toMatchObject({ status: "skipped", opaque: 1 });
  });

  test("two citations of one record are two citations, and its own are read once", async () => {
    const first = delivery();
    const second = delivery({ attempt: OTHER_ATTEMPT });
    const { references } = await set([recordDigest(first), recordDigest(second)], first, second, task, PROFILE);
    expect(references).toMatchObject({ status: "passed", reached: 4, resolved: 3 });
  });

  test("a claimed digest resolves nothing: only the bytes' own digest does", async () => {
    const report = await checkRecordSet({
      records: [{ bytes: task, digest: `sha256:${"8".repeat(64)}` }],
      roots: [`sha256:${"8".repeat(64)}`],
    });
    expect(report.checks[0].status).toBe("failed");
    expect(report.records[0]!.checks[0]).toMatchObject({ id: "digest", status: "failed" });
  });

  test("no roots reach nothing, and that does not read as passed", async () => {
    const { references } = await set([], task);
    expect(references.status).toBe("skipped");
    expect(references.findings[0]).toMatchObject({ code: "no-roots" });
  });
});

describe("lifecycle", () => {
  const closing = delivery();
  const closingDigest = recordDigest(closing);
  const log = [
    observation("attempt-engaged", "evt-1", 1, ENGAGED),
    observation("attempt-started", "evt-2", 2, { startedAt: "2026-07-28T00:01:00Z" }),
    observation("delivery-recorded", "evt-3", 3, { digest: closingDigest }),
    observation("attempt-terminal", "evt-4", 4, { state: "delivered" }),
  ];

  test("a set with no observations and no supersession has no lifecycle to check", async () => {
    const { lifecycle } = await set([], closing, task);
    expect(lifecycle).toMatchObject({ id: "lifecycle", status: "skipped", attempts: [] });
    expect(lifecycle.findings[0]).toMatchObject({ code: "no-lifecycle-records" });
  });

  test("a log with no engagement has no authoritative source, so it does not read as passed", async () => {
    const { lifecycle } = await set([], closing,
      observation("delivery-recorded", "d", 8, { digest: closingDigest }, { source: "urn:attacker" }),
      observation("attempt-terminal", "t", 9, { state: "delivered" }, { source: "urn:attacker" }));
    expect(lifecycle.status).toBe("skipped");
    expect(lifecycle.findings).toEqual([expect.objectContaining({ code: "attempt-not-engaged", subject: ATTEMPT })]);
    expect(lifecycle.attempts[0]).toMatchObject({ engaged: false, state: "delivered" });
  });

  test("an observation that failed its schema is not folded", async () => {
    const { lifecycle } = await set([], observation("attempt-engaged", "evt-1", 1, ENGAGED),
      observation("attempt-terminal", "evt-2", 2, { state: "exploded" }));
    expect(lifecycle.attempts).toEqual([expect.objectContaining({ engaged: true, state: "pending", terminal: false })]);
  });

  test("a log folds to its derived state, and a Delivery recorded in it is held", async () => {
    const { lifecycle } = await set([], closing, task, PROFILE, ...log);
    expect(lifecycle).toMatchObject({
      status: "passed",
      attempts: [{ attempt: ATTEMPT, engaged: true, state: "delivered", terminal: true, contradictory: false, deliveries: [closingDigest] }],
      deliveriesWithoutObservations: 0,
    });
  });

  test("two terminals are contradictory, surfaced and not merged", async () => {
    const { lifecycle } = await set([], ...log, observation("attempt-terminal", "evt-5", 5, { state: "failed", blame: "task" }), closing);
    expect(lifecycle.status).toBe("failed");
    expect(lifecycle.findings).toEqual([expect.objectContaining({ code: "contradictory-terminals", subject: ATTEMPT })]);
    expect(lifecycle.attempts[0]).toMatchObject({ state: "delivered", contradictory: true });
  });

  test("a recorded Delivery the set does not hold fails", async () => {
    const { lifecycle } = await set([], ...log);
    expect(lifecycle.findings).toEqual([expect.objectContaining({ code: "recorded-delivery-missing", subject: ATTEMPT })]);
  });

  test("a recorded digest that is not a Delivery fails like one not held", async () => {
    const { lifecycle } = await set([], task, observation("attempt-engaged", "evt-1", 1, ENGAGED),
      observation("delivery-recorded", "evt-3", 3, { digest: taskDigest }));
    expect(lifecycle.findings).toEqual([expect.objectContaining({ code: "recorded-delivery-missing", subject: ATTEMPT })]);
  });

  test("a submission-scoped observation opens no Attempt", async () => {
    const accepted = observation("submission-accepted", "evt-0", 1, { submission: ENGAGED.submission, task: taskDigest }, { subject: ENGAGED.submission });
    const { lifecycle } = await set([], accepted, closing, task, ...log);
    expect(lifecycle.attempts.map(({ attempt }) => attempt)).toEqual([ATTEMPT]);
  });

  test("a recorded Delivery of another Attempt fails", async () => {
    const foreign = delivery({ attempt: OTHER_ATTEMPT });
    const { lifecycle } = await set([], foreign, observation("attempt-engaged", "evt-1", 1, ENGAGED),
      observation("delivery-recorded", "evt-3", 3, { digest: recordDigest(foreign) }));
    expect(lifecycle.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "delivery-attempt-mismatch", subject: ATTEMPT })]));
  });

  test("a recorded Delivery of another Task fails", async () => {
    const foreign = delivery({ task: `sha256:${"9".repeat(64)}` });
    const { lifecycle } = await set([], foreign, observation("attempt-engaged", "evt-1", 1, ENGAGED),
      observation("delivery-recorded", "evt-3", 3, { digest: recordDigest(foreign) }));
    expect(lifecycle.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "delivery-task-mismatch", subject: ATTEMPT })]));
  });

  test("§10.4: the first engagement in sequence is the engagement, wherever it sits in the input", async () => {
    const foreign = delivery({ task: `sha256:${"9".repeat(64)}` });
    const genuine = observation("attempt-engaged", "evt-1", 1, ENGAGED);
    const forged = observation("attempt-engaged", "evt-9", 9, { ...ENGAGED, task: `sha256:${"9".repeat(64)}` });
    const recorded = observation("delivery-recorded", "evt-3", 3, { digest: recordDigest(foreign) });
    for (const input of [[forged, genuine, recorded], [genuine, forged, recorded], [recorded, forged, genuine]]) {
      // eslint-disable-next-line no-await-in-loop -- each order is its own set.
      const { lifecycle } = await set([], foreign, ...input);
      expect(lifecycle.status).toBe("failed");
      expect(lifecycle.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "delivery-task-mismatch" })]));
    }
  });

  test("a Delivery with no log is counted, not assumed", async () => {
    const stray = delivery({ attempt: OTHER_ATTEMPT });
    const { lifecycle } = await set([], stray, closing, ...log);
    expect(lifecycle).toMatchObject({ status: "passed", deliveriesWithoutObservations: 1 });
    expect(lifecycle.findings).toEqual([expect.objectContaining({ code: "deliveries-without-observations" })]);
  });

  test("§11.3 rule 1: what is superseded must be a Delivery", async () => {
    const forged = delivery({ supersedes: taskDigest, createdAt: "2026-07-28T00:06:00Z" });
    const { lifecycle } = await set([], forged, task);
    expect(lifecycle.status).toBe("failed");
    expect(lifecycle.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "supersedes-not-a-delivery", subject: recordDigest(forged) })]));

    const broken = canonicalJsonBytes({ protocol: TASK_EXECUTION_PROTOCOL_URI, attempt: ATTEMPT, task: taskDigest });
    const overBroken = delivery({ supersedes: recordDigest(broken), createdAt: "2026-07-28T00:06:00Z" });
    expect((await set([], overBroken, broken)).lifecycle.status).toBe("failed");
  });

  test("§11.3 rule 1 holds whenever both records are held, with no log at all", async () => {
    const first = delivery();
    const forged = delivery({ attempt: OTHER_ATTEMPT, supersedes: recordDigest(first), createdAt: "2026-07-28T00:06:00Z" });
    const { lifecycle } = await set([], first, forged);
    expect(lifecycle.status).toBe("failed");
    expect(lifecycle.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "supersedes-other-attempt", subject: recordDigest(forged) })]));

    const correction = delivery({ supersedes: recordDigest(first), createdAt: "2026-07-28T00:06:00Z" });
    expect((await set([], first, correction)).lifecycle.status).toBe("passed");
  });

  test("a superseding Delivery whose target is not held compares nothing, so it does not read as passed", async () => {
    const correction = delivery({ supersedes: `sha256:${"7".repeat(64)}`, createdAt: "2026-07-28T00:06:00Z" });
    const { lifecycle } = await set([], correction);
    expect(lifecycle).toMatchObject({ status: "skipped", attempts: [], deliveriesWithoutObservations: 1 });
    expect(lifecycle.findings).toEqual([
      expect.objectContaining({ code: "supersedes-target-not-held", subject: recordDigest(correction) }),
      expect.objectContaining({ code: "deliveries-without-observations" }),
    ]);
  });

  test("beside an engaged log, a target not held is said, not a bare pass", async () => {
    const correction = delivery({ supersedes: `sha256:${"7".repeat(64)}`, createdAt: "2026-07-28T00:06:00Z" });
    const { lifecycle } = await set([], closing, correction, ...log);
    expect(lifecycle.status).toBe("passed");
    expect(lifecycle.findings).toEqual([expect.objectContaining({ code: "supersedes-target-not-held", subject: recordDigest(correction) })]);
  });

  test("one supersession compared is a check that ran, beside one that could not be", async () => {
    const first = delivery();
    const compared = delivery({ supersedes: recordDigest(first), createdAt: "2026-07-28T00:06:00Z" });
    const unheld = delivery({ supersedes: `sha256:${"7".repeat(64)}`, createdAt: "2026-07-28T00:07:00Z" });
    const { lifecycle } = await set([], first, compared, unheld);
    expect(lifecycle.status).toBe("passed");
    expect(lifecycle.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "supersedes-target-not-held", subject: recordDigest(unheld) })]));
  });

  describe("§10.4 rule 3: nothing depends on input order", () => {
    const FORGED_SOURCE = "urn:jinn:backend:forged";
    const engaged = observation("attempt-engaged", "evt-1", 1, ENGAGED);
    const terminals = [
      observation("attempt-terminal", "evt-4", 4, { state: "delivered" }),
      observation("attempt-terminal", "evt-5", 5, { state: "failed", blame: "task" }),
    ];
    const unheldRecorded = observation("delivery-recorded", "evt-3", 3, { digest: `sha256:${"8".repeat(64)}` });

    test.each<[string, readonly Uint8Array[], Uint8Array, string]>([
      [
        "a later engagement reusing the true (source, id)",
        [engaged, ...terminals],
        observation("attempt-engaged", "evt-1", 9, { ...ENGAGED, source: FORGED_SOURCE }),
        "conflicting-observations",
      ],
      [
        "a later delivery-recorded reusing the true id",
        [engaged, unheldRecorded, closing],
        observation("delivery-recorded", "evt-3", 9, { digest: closingDigest }),
        "conflicting-observations",
      ],
      [
        "a later progress reusing a terminal's id",
        [engaged, ...terminals],
        observation("progress", "evt-5", 9, { message: "still going" }),
        "conflicting-observations",
      ],
      [
        "a forged engagement tied on sequence",
        [engaged, ...terminals],
        observation("attempt-engaged", "evt-0", 1, { ...ENGAGED, source: FORGED_SOURCE }),
        "first-engagement-tied",
      ],
    ])("%s fails the same placed first and placed last", async (_name, genuine, forged, code) => {
      const first = (await set([], forged, ...genuine)).lifecycle;
      const last = (await set([], ...genuine, forged)).lifecycle;
      expect(first.status).toBe("failed");
      expect(first.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
      expect(last).toEqual(first);
    });

    test("a log the fold refuses is a finding on that Attempt, and the others still fold", async () => {
      const onOther = { subject: OTHER_ATTEMPT };
      const { lifecycle } = await set(
        [],
        ...[engaged, ...terminals],
        observation("progress", "evt-5", 9, { message: "still going" }),
        observation("attempt-engaged", "evt-1", 1, ENGAGED, onOther),
      );
      expect(lifecycle.status).toBe("failed");
      expect(lifecycle.findings).toEqual([
        expect.objectContaining({ code: "conflicting-observations", subject: ATTEMPT }),
      ]);
      expect(lifecycle.attempts.map(({ attempt }) => attempt)).toEqual([OTHER_ATTEMPT]);
    });

    test("the same bytes twice are one record, not a tie", async () => {
      const { lifecycle } = await set([], closing, engaged, ...log.slice(1), engaged);
      expect(lifecycle.status).toBe("passed");
    });

    test("only a tie on the first engagement is refused", async () => {
      const later = (id: string) => observation("attempt-engaged", id, 7, { ...ENGAGED, executor: id });
      const { lifecycle } = await set([], closing, ...log, later("evt-7"), later("evt-8"));
      expect(lifecycle.status).toBe("passed");
    });

    test("a tie is refused only among engagements", async () => {
      const { lifecycle } = await set([], closing, ...log, observation("progress", "evt-9", 1, { message: "at the same sequence" }));
      expect(lifecycle.status).toBe("passed");
    });

    /** A seeded Fisher-Yates, so a failing order can be reproduced. */
    function shuffled<Item>(items: readonly Item[], seed: number): readonly Item[] {
      const result = [...items];
      let state = seed;
      const next = (bound: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) | 0;
        return (state >>> 0) % bound;
      };
      for (let index = result.length - 1; index > 0; index -= 1) {
        const other = next(index + 1);
        [result[index], result[other]] = [result[other]!, result[index]!];
      }
      return result;
    }

    test("the lifecycle result is identical under every shuffle tried", async () => {
      const onOther = { subject: OTHER_ATTEMPT };
      const third = { subject: "urn:uuid:dddddddd-dddd-5ddd-8ddd-dddddddddddd" };
      const first = delivery();
      const wrongAttempt = delivery({ attempt: OTHER_ATTEMPT, supersedes: recordDigest(first), createdAt: "2026-07-28T00:06:00Z" });
      const unheld = delivery({ supersedes: `sha256:${"7".repeat(64)}`, createdAt: "2026-07-28T00:07:00Z" });
      const alsoUnheld = delivery({ supersedes: `sha256:${"6".repeat(64)}`, createdAt: "2026-07-28T00:08:00Z" });
      const records = [
        engaged,
        ...terminals,
        observation("attempt-engaged", "evt-1", 9, { ...ENGAGED, source: FORGED_SOURCE }),
        observation("progress", "evt-5", 8, { message: "reusing a terminal's id" }),
        observation("attempt-engaged", "evt-1", 1, ENGAGED, onOther),
        observation("delivery-recorded", "evt-3", 3, { digest: `sha256:${"8".repeat(64)}` }, onOther),
        observation("delivery-recorded", "evt-3", 9, { digest: closingDigest }, onOther),
        observation("attempt-engaged", "evt-1", 1, ENGAGED, third),
        observation("attempt-engaged", "evt-0", 1, { ...ENGAGED, source: FORGED_SOURCE }, third),
        observation("attempt-terminal", "evt-4", 4, { state: "delivered" }, third),
        closing,
        first,
        wrongAttempt,
        unheld,
        alsoUnheld,
        task,
      ];
      const expected = (await set([], ...records)).lifecycle;
      expect(expected.status).toBe("failed");
      // Two of the three logs hold a disagreeing pair, so only the third is folded.
      expect(expected.attempts).toHaveLength(1);
      expect(expected.findings.filter(({ code }) => code === "conflicting-observations")).toHaveLength(2);
      const seeds = Array.from({ length: 300 }, (_unused, index) => index + 1);
      await Promise.all(seeds.map(async (seed) => {
        expect((await set([], ...shuffled(records, seed))).lifecycle).toEqual(expected);
      }));
    });
  });
});

describe("anchors", () => {
  const authority = createFixtureAuthority("check-record-set");

  function anchorOver(digest: string, subjectKind: string = RECORD_KINDS.task) {
    const subjectSha256 = digest.slice("sha256:".length);
    return buildRfc3161AnchorEvidenceRecord({
      subjectKind,
      subjectSha256,
      proofBytes: authority.mintTimeStampToken({ subjectSha256, genTime: "20260501120000Z" }).tokenDer,
    }).bytes;
  }

  test("a set with no anchor records says so", async () => {
    const { anchors } = await set([], task);
    expect(anchors).toMatchObject({ id: "anchors", status: "skipped" });
    expect(anchors.findings[0]).toMatchObject({ code: "no-anchor-records" });
  });

  test("an anchor over a Task digest stands, and its time is not claimed without trust material", async () => {
    const anchor = anchorOver(taskDigest);
    const { anchors, report } = await set([recordDigest(anchor)], anchor, task, PROFILE);
    expect(report.records[0]).toMatchObject({ kind: "https://spec.jinn.network/records/anchor-evidence/v1", outcome: "checked" });
    expect(anchors.status).toBe("passed");
    expect(anchors.report?.anchors[0]).toMatchObject({ status: "present", subject: taskDigest, trustMaterial: "none" });
    expect(anchors.findings).toEqual([expect.objectContaining({ code: "anchor-time-not-evaluated" })]);
  });

  test("with the authority's root the time is evaluated", async () => {
    const anchor = anchorOver(taskDigest);
    const report = await checkRecordSet({
      records: records(anchor, task),
      roots: [],
      trust: { anchors: { rfc3161: { trustAnchorsDer: [authority.certificateDer] } } },
    });
    expect(report.checks[2]).toMatchObject({ status: "passed", findings: [] });
    expect(report.checks[2].report?.anchors[0]).toMatchObject({ status: "verified", time: "2026-05-01T12:00:00Z" });
  });

  test("an anchor whose label misdescribes the record it names fails", async () => {
    const anchor = anchorOver(taskDigest, RECORD_KINDS.delivery);
    const { anchors } = await set([], anchor, task);
    expect(anchors.status).toBe("failed");
    expect(anchors.findings).toEqual([expect.objectContaining({ code: "anchor-invalid", subject: recordDigest(anchor) })]);
  });

  test("an anchor over a record the set does not hold fails", async () => {
    const anchor = anchorOver(`sha256:${"9".repeat(64)}`);
    const { anchors, references } = await set([recordDigest(anchor)], anchor);
    expect(anchors.status).toBe("failed");
    expect(references.status).toBe("failed");
  });

  test("an anchor over a record of unknown kind stands, and the kind it states is reported unchecked", async () => {
    const anchor = anchorOver(recordDigest(PROFILE), "https://example.test/records/note/v1");
    const { anchors } = await set([], anchor, PROFILE);
    expect(anchors.status).toBe("passed");
    expect(anchors.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "anchor-subject-kind-unchecked" })]));
  });
});

describe("the summary", () => {
  const APPLICATION_TYPE = "https://spec.jinn.network/binary-judgment/judge-observation/v1";

  test("counts kinds, keeps unknown apart from known, and says what ran", async () => {
    const application = canonicalJsonBytes({ protocol: APPLICATION_TYPE });
    const respelled = new TextEncoder().encode(JSON.stringify({ protocol: APPLICATION_TYPE }, null, 1));
    const archive = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    const closing = delivery();
    const { report } = await set([recordDigest(closing)], closing, task, PROFILE, application, respelled, archive);
    expect(report.summary).toEqual({
      records: 6,
      recordsFailed: 1,
      kinds: { [RECORD_KINDS.delivery]: 1, [RECORD_KINDS.task]: 1, unknown: 4 },
      unknownTypes: { [APPLICATION_TYPE]: 2 },
      namingNoType: 2,
      signatures: { total: 0, verified: 0, verifiedWithSuppliedKey: 0, invalid: 0, unverified: 0 },
      checks: {
        digest: { passed: 0, failed: 0, skipped: 6 },
        encoding: { passed: 4, failed: 1, skipped: 1 },
        schema: { passed: 2, failed: 0, skipped: 4 },
        signature: { passed: 0, failed: 0, skipped: 6 },
        "trust-binding": { passed: 0, failed: 0, skipped: 6 },
      },
    });
  });

  test("adds up the signatures of every record", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signed = (signature: Uint8Array) => sealDsseEnvelope({
      payloadType: "application/vnd.jinn.not-registered.v1+json",
      payloadBytes: canonicalJsonBytes({}),
      signatures: [{ keyid: didKeyFromEd25519PublicKey(publicKey), signature }],
    });
    const good = new Uint8Array(sign(null, dssePreAuthEncoding("application/vnd.jinn.not-registered.v1+json", canonicalJsonBytes({})), privateKey));
    const { report } = await set([], signed(good), signed(new Uint8Array(64)), task);
    expect(report.summary.signatures).toEqual({ total: 2, verified: 1, verifiedWithSuppliedKey: 0, invalid: 1, unverified: 0 });
  });

  test("an empty set is empty", async () => {
    const { report } = await set([]);
    expect(report.summary.records).toBe(0);
    expect(report.checks.map(({ status }) => status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  test("a bad record never throws out of a set", async () => {
    const { report } = await set([], Uint8Array.of(0xc3, 0x28), new TextEncoder().encode("null"), new Uint8Array());
    expect(report.summary.records).toBe(3);
  });
});
