import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GuiActionState } from "@/lib/action-state";

const actionState = vi.hoisted(() => ({ current: { status: "idle" } as GuiActionState }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useActionState: () => [actionState.current, vi.fn(), false],
}));

import { TIMESTAMP_PROOF_LABELS, VerificationForm } from "./verification-form";

const action = vi.fn(async () => ({ status: "idle" as const }));

describe("verification action presentation", () => {
  beforeEach(() => { actionState.current = { status: "idle" }; });

  test("renders named checks and exact digests semantically after success", () => {
    actionState.current = {
      status: "success",
      result: {
        checks: ["matrix-rederivation", "report-verification", "claim-consistency"],
        matrixSha256: "a".repeat(64),
        reportEnvelopeSha256: "b".repeat(64),
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("Verification passed");
    expect(markup).toContain("matrix-rederivation");
    expect(markup).toContain("report-verification");
    expect(markup).toContain("claim-consistency");
    expect(markup).toContain("a".repeat(64));
    expect(markup).toContain("b".repeat(64));
    expect(markup).not.toContain("<pre");
  });

  test("lists the reader checks verify did not run when the result carries them", () => {
    actionState.current = {
      status: "success",
      result: {
        checks: ["matrix-rederivation", "report-verification", "claim-consistency"],
        matrixSha256: "a".repeat(64),
        reportEnvelopeSha256: "b".repeat(64),
        readerChecksNotRun: ["manifest", "evidence-closure", "trust"],
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("Not run here (publish runs them on the bundle)");
    expect(markup).toContain("<li>manifest</li><li>evidence-closure</li><li>trust</li>");
  });

  test("shows no not-run list when the result omits the field", () => {
    actionState.current = {
      status: "success",
      result: { checks: ["matrix-rederivation"], matrixSha256: "a".repeat(64) },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("Verification passed");
    expect(markup).not.toContain("Not run here");
  });

  test("treats a malformed not-run field as an unreadable result", () => {
    actionState.current = {
      status: "success",
      result: { checks: ["matrix-rederivation"], matrixSha256: "a".repeat(64), readerChecksNotRun: [1] },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("unreadable result");
  });

  test("names each timestamp proof and outcome as the reader tool does, with the pending-window warning", () => {
    // Reader-facing vocabulary spec section 4.2, v1.14 (issue #5241). The raw outcome values stay
    // in the result; none reaches the card.
    actionState.current = {
      status: "success",
      result: {
        draftId: "draft-1",
        checks: ["matrix-rederivation", "integrity-anchors"],
        matrixSha256: "a".repeat(64),
        anchors: {
          anchors: [{
            recordSha256: "c".repeat(64),
            status: "pending",
            subject: "lock",
            trustMaterial: "none",
          }, {
            recordSha256: "e".repeat(64),
            status: "present",
            subject: "matrix",
            trustMaterial: "none",
          }],
          subjects: [
            { subject: "lock", outcome: "anchored" },
            {
              subject: "matrix",
              outcome: "declared-but-absent",
              declaredProfiles: ["https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1"],
            },
          ],
          invalid: [],
        },
        anchoringWindow: { closingOperation: "report" },
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain(">Timestamps<");
    expect(markup).toContain(`lock timestamp proof · pending · ${"c".repeat(64)}`);
    expect(markup).toContain(">Timestamp coverage<");
    expect(markup).toContain(`the runs timestamp proof · present · ${"e".repeat(64)}`);
    expect(markup).toContain("lock: timestamped");
    expect(markup).toContain("the runs: promised but missing (opentimestamps/v1)");
    // Spec section 4.2, v1.15 (issue #5278): the raw subject `matrix` stays in the result only.
    expect(markup).not.toMatch(/>matrix(?![\w-])/u);
    expect(markup).toContain("a timestamp proof is still pending, and `report` closes the anchoring window.");
    expect(markup).not.toMatch(/>Anchors<|Anchor subjects|anchored|declared-but-absent|anchor evidence/u);
  });

  test("names an absent subject none and an empty proof list as the reader does", () => {
    actionState.current = {
      status: "success",
      result: {
        checks: ["matrix-rederivation", "integrity-anchors"],
        matrixSha256: "a".repeat(64),
        anchors: { anchors: [], subjects: [{ subject: "matrix", outcome: "absent" }], invalid: [] },
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("no timestamp proofs carried");
    expect(markup).toContain("the runs: none");
    expect(markup).not.toMatch(/absent|no anchor records carried/u);
  });

  test("treats an outcome the card has no name for as an unreadable result", () => {
    actionState.current = {
      status: "success",
      result: {
        checks: ["integrity-anchors"],
        matrixSha256: "a".repeat(64),
        anchors: { anchors: [], subjects: [{ subject: "lock", outcome: "anchored-twice" }], invalid: [] },
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("unreadable result");
    expect(markup).not.toContain("anchored-twice");
  });

  test("its timestamp-proof labels are the ones the reader tool prints", () => {
    // This package cannot import the reader (`@colophon-claims/check`), so it reads the source the
    // labels copy, as `present-protocol-profile.test.ts` does for the identifier rule.
    const reader = readFileSync(fileURLToPath(new URL("../../../check/src/cli.ts", import.meta.url)), "utf8");
    const declaration = (name: string) =>
      new RegExp(`^(?:export )?function ${name}\\b[\\s\\S]*?^\\}$`, "mu").exec(reader)?.[0] ?? "";
    const subject = declaration("renderSubject");
    for (const name of Object.values(TIMESTAMP_PROOF_LABELS.outcomes)) {
      expect(subject, `the reader's renderSubject prints "${name}"`).toContain(`}: ${name}`);
    }
    expect(declaration("renderTimestampCoverage")).toContain(`\`${TIMESTAMP_PROOF_LABELS.coverageHeading}\\n`);
    const report = declaration("renderAnchorReport");
    expect(report).toContain(`\\n${TIMESTAMP_PROOF_LABELS.heading}\\n`);
    expect(report).toContain(`"  ${TIMESTAMP_PROOF_LABELS.noneCarried}"`);
    expect(declaration("renderAnchor")).toContain(` ${TIMESTAMP_PROOF_LABELS.proof}\``);
    expect(declaration("renderAnchor")).toContain("timestampSubjectName(entry.subject)");
    expect(subject).toContain("timestampSubjectName(subject.subject)");
    const subjectNames = /^const TIMESTAMP_SUBJECT_NAMES\b[^=]*= (\{[^}]*\});$/mu.exec(reader)?.[1];
    expect(subjectNames, "the reader's TIMESTAMP_SUBJECT_NAMES").toBe(
      `{ ${Object.entries(TIMESTAMP_PROOF_LABELS.subjects).map(([raw, name]) => `${raw}: "${name}"`).join(", ")} }`,
    );
  });

  test("names declared anchor profiles, which the spec origin does not serve, without the origin", () => {
    actionState.current = {
      status: "success",
      result: {
        checks: ["integrity-anchors"],
        matrixSha256: "a".repeat(64),
        anchors: {
          anchors: [],
          subjects: [{
            subject: "lock",
            outcome: "anchored",
            declaredProfiles: ["https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1"],
          }],
          invalid: [],
        },
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain("rfc3161-tsa/v1");
    expect(markup).not.toContain("spec.jinn.network");
    expect(markup).not.toContain("https://");
  });

  test("renders a typed recomputation or integrity failure loudly and never claims success", () => {
    actionState.current = {
      status: "error",
      error: {
        code: "record-integrity",
        detail: "matrix-rederivation: exact recompute divergence",
      },
    };
    const markup = renderToStaticMarkup(<VerificationForm action={action} draftId="draft-1" />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Verification failed: record-integrity");
    expect(markup).toContain("exact recompute divergence");
    expect(markup).not.toContain("Verification passed");
  });
});
