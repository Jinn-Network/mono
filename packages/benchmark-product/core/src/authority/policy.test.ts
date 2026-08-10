import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthorityPolicySchema,
  GATED_OPERATIONS,
  checkAuthority,
  foundingAuthorityPolicy,
  readAuthorityPolicy,
  writeAuthorityPolicy,
  type AuthorityPolicy,
} from "./policy.js";
import { BenchmarkProductError } from "../errors.js";
import { authorityPath } from "../workspace/layout.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp10-aa-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function caughtErrorOf(fn: () => void): BenchmarkProductError {
  try {
    fn();
  } catch (cause) {
    expect(cause).toBeInstanceOf(BenchmarkProductError);
    return cause as BenchmarkProductError;
  }
  throw new Error("expected fn to throw");
}

describe("foundingAuthorityPolicy", () => {
  test("grants the initializing sponsor every gated operation", () => {
    const policy = foundingAuthorityPolicy("sponsor-1");
    expect(policy.policyVersion).toBe(1);
    expect(policy.principals).toHaveLength(1);
    expect(policy.principals[0]).toEqual({
      id: "sponsor-1",
      role: "sponsor",
      grants: [...GATED_OPERATIONS],
    });
  });

  test("validates against AuthorityPolicySchema", () => {
    const policy = foundingAuthorityPolicy("sponsor-1");
    expect(AuthorityPolicySchema.safeParse(policy).success).toBe(true);
  });
});

describe("writeAuthorityPolicy / readAuthorityPolicy", () => {
  test("write then read round-trips the policy", () => {
    const policy = foundingAuthorityPolicy("sponsor-1");
    writeAuthorityPolicy(workspaceDir, policy);
    expect(readAuthorityPolicy(workspaceDir)).toEqual(policy);
  });

  test("readAuthorityPolicy refuses not-found when absent", () => {
    const error = caughtErrorOf(() => readAuthorityPolicy(workspaceDir));
    expect(error.code).toBe("not-found");
  });

  test("readAuthorityPolicy refuses validation when the file is malformed", () => {
    writeFileSync(authorityPath(workspaceDir), "not json {{{");
    const error = caughtErrorOf(() => readAuthorityPolicy(workspaceDir));
    expect(error.code).toBe("validation");
  });

  test("duplicate principal ids refuse validation", () => {
    const policy = {
      policyVersion: 1,
      principals: [
        { id: "sponsor-1", role: "sponsor", grants: ["lock"] },
        { id: "sponsor-1", role: "delegated-agent", grants: ["launch"] },
      ],
    } as unknown as AuthorityPolicy;
    const error = caughtErrorOf(() => writeAuthorityPolicy(workspaceDir, policy));
    expect(error.code).toBe("validation");
  });
});

describe("checkAuthority", () => {
  const policy: AuthorityPolicy = {
    policyVersion: 1,
    principals: [
      { id: "sponsor-1", role: "sponsor", grants: [...GATED_OPERATIONS] },
      { id: "agent-1", role: "delegated-agent", grants: ["launch"] },
      { id: "agent-2", role: "delegated-agent", grants: [] },
    ],
  };

  test("an unknown principal is refused authority-denied even for a read operation", () => {
    const error = caughtErrorOf(() => checkAuthority(policy, "ghost", "draft.get"));
    expect(error.code).toBe("authority-denied");
  });

  test("a member without the lock grant is refused for lock", () => {
    const error = caughtErrorOf(() => checkAuthority(policy, "agent-2", "lock"));
    expect(error.code).toBe("authority-denied");
  });

  test("a member with the grant passes", () => {
    expect(() => checkAuthority(policy, "sponsor-1", "lock")).not.toThrow();
  });

  test("any member passes for non-gated operations", () => {
    for (const operation of ["draft.create", "draft.get", "init"]) {
      expect(() => checkAuthority(policy, "agent-2", operation)).not.toThrow();
    }
  });

  test("a delegated agent with a gated grant passes that gated operation — capability parity", () => {
    expect(() => checkAuthority(policy, "agent-1", "launch")).not.toThrow();
  });
});
