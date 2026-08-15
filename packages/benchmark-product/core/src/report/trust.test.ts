import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BENCHMARKING_REPORTS_SCOPE } from "@jinn-network/benchmarking-records";
import { dssePreAuthEncoding, sealDsseEnvelope, verifyEnvelopeBinding } from "@jinn-network/trust-core";
import { createWorkspaceLayout } from "../workspace/workspace.js";
import { createReportDsseSigner, loadOrCreateReportSigningKey } from "./signing.js";
import { buildWorkspaceTrustDeps } from "./trust.js";

const AUTHOR = "urn:uuid:11111111-1111-5111-8111-111111111111";
const CREATED_AT = "2026-08-01T00:00:00Z";
const REPORT_PAYLOAD_TYPE = "application/vnd.jinn.benchmarking.report.v1+json";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-trust-"));
  createWorkspaceLayout(workspaceDir, CREATED_AT);
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function sealReportEnvelope(workspaceDirForKey: string): Promise<Uint8Array> {
  const key = loadOrCreateReportSigningKey(workspaceDirForKey);
  const signer = createReportDsseSigner(key);
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ fixture: "report" }));
  const preAuthEncoding = dssePreAuthEncoding(REPORT_PAYLOAD_TYPE, payloadBytes);
  const signatures = await signer({ payloadType: REPORT_PAYLOAD_TYPE, payloadBytes, preAuthEncoding });
  return sealDsseEnvelope({ payloadBytes, signatures, payloadType: REPORT_PAYLOAD_TYPE });
}

describe("buildWorkspaceTrustDeps", () => {
  it("accepts a report envelope signed by the workspace's own report key for the author at a time >= createdAt", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const envelopeBytes = await sealReportEnvelope(workspaceDir);
    const deps = buildWorkspaceTrustDeps({ workspaceDir, author: AUTHOR });

    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes,
        key: key.keyId,
        agent: AUTHOR,
        family: BENCHMARKING_REPORTS_SCOPE,
        atTime: "2026-08-02T00:00:00Z",
      },
      deps,
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });

  it("rejects a foreign keyid — this workspace's dsseVerifier cannot validate a signature made by a different workspace's key", async () => {
    const foreignWorkspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-trust-foreign-"));
    try {
      createWorkspaceLayout(foreignWorkspaceDir, CREATED_AT);
      const foreignKey = loadOrCreateReportSigningKey(foreignWorkspaceDir);
      const envelopeBytes = await sealReportEnvelope(foreignWorkspaceDir);
      const deps = buildWorkspaceTrustDeps({ workspaceDir, author: AUTHOR });

      const outcome = await verifyEnvelopeBinding(
        {
          envelopeBytes,
          key: foreignKey.keyId,
          agent: AUTHOR,
          family: BENCHMARKING_REPORTS_SCOPE,
          atTime: "2026-08-02T00:00:00Z",
        },
        deps,
      );
      // Step 1 (offline signature verification against THIS workspace's own key) fails before the
      // binding resolver is even consulted -- a workspace's dsseVerifier only ever knows its own
      // key, so a foreign-keyid claim is refused at the earliest possible check.
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe("envelope-signature-invalid");
    } finally {
      rmSync(foreignWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects a foreign keyid claimed against an envelope this workspace's own key DID sign (binding never resolves for an unknown key)", async () => {
    const foreignWorkspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-trust-foreign2-"));
    try {
      createWorkspaceLayout(foreignWorkspaceDir, CREATED_AT);
      const foreignKey = loadOrCreateReportSigningKey(foreignWorkspaceDir);
      const envelopeBytes = await sealReportEnvelope(workspaceDir);
      const deps = buildWorkspaceTrustDeps({ workspaceDir, author: AUTHOR });

      const outcome = await verifyEnvelopeBinding(
        {
          envelopeBytes,
          key: foreignKey.keyId,
          agent: AUTHOR,
          family: BENCHMARKING_REPORTS_SCOPE,
          atTime: "2026-08-02T00:00:00Z",
        },
        deps,
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe("envelope-signature-invalid");
    } finally {
      rmSync(foreignWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects a different claimed author, even for the workspace's genuine report key", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const envelopeBytes = await sealReportEnvelope(workspaceDir);
    const deps = buildWorkspaceTrustDeps({ workspaceDir, author: AUTHOR });

    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes,
        key: key.keyId,
        agent: "urn:uuid:99999999-9999-5999-8999-999999999999",
        family: BENCHMARKING_REPORTS_SCOPE,
        atTime: "2026-08-02T00:00:00Z",
      },
      deps,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("binding-not-resolved");
  });

  it("rejects atTime before the workspace's own createdAt (window violation)", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const envelopeBytes = await sealReportEnvelope(workspaceDir);
    const deps = buildWorkspaceTrustDeps({ workspaceDir, author: AUTHOR });

    const outcome = await verifyEnvelopeBinding(
      {
        envelopeBytes,
        key: key.keyId,
        agent: AUTHOR,
        family: BENCHMARKING_REPORTS_SCOPE,
        atTime: "2020-01-01T00:00:00Z",
      },
      deps,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("window-violation");
  });
});
