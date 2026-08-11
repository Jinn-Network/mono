import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalTaskExecutionBackendConfig } from "@jinn-network/task-execution-backend-local";
import { describe, expect, test } from "vitest";
import { createRoleScopedLocalBackends } from "./role-backends.js";

function config(role: string): Omit<LocalTaskExecutionBackendConfig, "stateRoot"> {
  return {
    source: `urn:jinn:${role}:source`,
    executor: `urn:jinn:${role}:executor`,
    profileStore: { get: () => undefined },
    launchers: [],
    provisioner: () => { throw new Error("not used"); },
    provisionerCapabilities: {
      taskProfiles: [], workspaceKinds: [], inputMediaTypes: [], outputMediaTypes: [], isolation: [],
    },
    trustKeys: {
      deliverySigningKey: { keyId: `${role}-delivery-key`, sign: () => new Uint8Array([1]) },
    },
  } as Omit<LocalTaskExecutionBackendConfig, "stateRoot">;
}

const purposeKeys = {
  solverDelivery: "solver-delivery-key",
  evaluatorBackendDelivery: "evaluator-delivery-key",
  evaluatorVerdict: "evaluator-verdict-key",
  reportAuthor: "report-author-key",
  journalAuthor: "journal-author-key",
} as const;

describe("role-scoped local backend composition", () => {
  test("uses exclusive roots, identities, keys, and writer locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-role-backends-"));
    const roles = createRoleScopedLocalBackends({
      stateRoot: root,
      identities: {
        solverDelivery: "urn:jinn:solver:executor",
        evaluatorVerdict: "urn:jinn:evaluator-verdict",
        reportAuthor: "urn:jinn:report-author",
        journalAuthor: "urn:jinn:journal-author",
      },
      purposeKeys,
      solver: config("solver"),
      evaluator: config("evaluator"),
    });
    expect(roles.roots.solver).not.toBe(roles.roots.evaluator);
    expect((await roles.solver.capabilities()).signedDeliveries).toBe(true);
    expect((await roles.evaluator.capabilities()).signedDeliveries).toBe(true);
    await Promise.all([roles.solver.shutdown(), roles.evaluator.shutdown()]);
  });

  test("refuses signer confusion", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-role-confusion-"));
    const evaluator = { ...config("evaluator"), trustKeys: config("solver").trustKeys };
    expect(() => createRoleScopedLocalBackends({
      stateRoot: root,
      identities: {
        solverDelivery: "urn:jinn:solver:executor", evaluatorVerdict: "b", reportAuthor: "c", journalAuthor: "d",
      },
      purposeKeys,
      solver: config("solver"), evaluator,
    })).toThrow(/distinct purpose-scoped/u);
  });
});
