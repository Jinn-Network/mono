// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  MCP_SERVER_NAME,
  RUNTIME_ROLES,
  TOOLS_BY_ROLE,
  TOOL_NAMES,
  isRuntimeRole,
} from "./identifiers.js";

describe("mcp identifiers", () => {
  test("the server name is stable and host-safe", () => {
    expect(MCP_SERVER_NAME).toBe("jinn");
    expect(MCP_SERVER_NAME).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test("tool names are snake_case and unique", () => {
    const names = Object.values(TOOL_NAMES);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the tools role exposes exactly the read surface", () => {
    expect([...TOOLS_BY_ROLE.tools]).toEqual([
      TOOL_NAMES.corpusSearch,
      TOOL_NAMES.corpusFetch,
      TOOL_NAMES.health,
    ]);
  });

  test("the session role is a strict superset of the tools role", () => {
    for (const name of TOOLS_BY_ROLE.tools) {
      expect(TOOLS_BY_ROLE.session).toContain(name);
    }
    expect(TOOLS_BY_ROLE.session.length).toBeGreaterThan(TOOLS_BY_ROLE.tools.length);
  });

  test("no writing tool is reachable from the tools role", () => {
    for (const name of [
      TOOL_NAMES.captureOpen,
      TOOL_NAMES.captureSeal,
      TOOL_NAMES.captureAbandon,
      TOOL_NAMES.pickup,
    ]) {
      expect(TOOLS_BY_ROLE.tools).not.toContain(name);
    }
  });

  test("isRuntimeRole accepts only the two roles", () => {
    expect(RUNTIME_ROLES).toEqual(["tools", "session"]);
    expect(isRuntimeRole("tools")).toBe(true);
    expect(isRuntimeRole("session")).toBe(true);
    expect(isRuntimeRole("admin")).toBe(false);
    expect(isRuntimeRole(undefined)).toBe(false);
  });
});
