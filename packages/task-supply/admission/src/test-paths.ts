// SPDX-License-Identifier: Apache-2.0

import { posix as path } from "node:path";
import { CommandSpecSchema, type EnvironmentRecord } from "@jinn-network/environment-record";
import type { z } from "zod";
import { refuse } from "./refusals.js";

/** The shell-free command shape, derived from C1's pinned schema (never re-declared). */
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

function segments(rawPath: string, label: string): string[] {
  if (rawPath === "") refuse("invalid-candidate", `${label} must not be empty`);
  if (path.isAbsolute(rawPath)) {
    refuse("invalid-candidate", `${label} must be repository-relative, not absolute`);
  }
  const raw = rawPath.split("/");
  if (raw.includes("..")) refuse("invalid-candidate", `${label} must not contain traversal`);
  if (raw.some((segment) => segment.startsWith("-"))) {
    refuse("invalid-candidate", `${label} must not contain option-shaped segments`);
  }
  const normalized = path.normalize(rawPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    refuse("invalid-candidate", `${label} escapes the repository workspace`);
  }
  return normalized.split("/").filter((segment) => segment !== "." && segment !== "");
}

/** Normalize a repository-relative path, refusing anything that could escape the workspace. */
export function normalizeRepositoryPath(rawPath: string, label: string): string {
  return segments(rawPath, label).join("/");
}

function commandCwdSegments(record: EnvironmentRecord, command: CommandSpec): string[] {
  if (command.cwd === undefined) return [];
  const workspace = record.workspace;
  if (!path.isAbsolute(workspace) || workspace.split("/").includes("..")) {
    refuse("invalid-environment-record", "the record workspace is unsafe");
  }
  if (path.isAbsolute(command.cwd)) {
    const normalizedWorkspace = path.normalize(workspace);
    const normalizedCwd = path.normalize(command.cwd);
    if (normalizedCwd === normalizedWorkspace) return [];
    if (!normalizedCwd.startsWith(`${normalizedWorkspace}/`)) {
      refuse("invalid-environment-record", "the test command cwd escapes the record workspace");
    }
    return segments(normalizedCwd.slice(normalizedWorkspace.length + 1), "test command cwd");
  }
  return segments(command.cwd, "test command cwd");
}

/**
 * Select the record's only targetable test-command template and append exactly one path scoped to
 * that command's working directory. The command stays structured — no shell, ever — and is what
 * the receipt binds by hash.
 */
export function targetTestCommandForPath(
  record: EnvironmentRecord,
  repositoryRelativeTestPath: string,
): CommandSpec {
  const templates = record.invocations.test;
  if (templates.length !== 1) {
    refuse(
      "invalid-environment-record",
      "exactly one targetable test command is required for per-path admission",
    );
  }
  const template = CommandSpecSchema.parse(templates[0]);

  const pathSegments = segments(repositoryRelativeTestPath, "test path");
  const cwdSegments = commandCwdSegments(record, template);
  if (!cwdSegments.every((segment, index) => pathSegments[index] === segment)) {
    refuse("invalid-candidate", "test path is outside the test command workspace");
  }
  const target = pathSegments.slice(cwdSegments.length);
  if (target.length === 0) {
    refuse("invalid-candidate", "test path must name a file below the test command workspace");
  }

  return {
    ...template,
    args: [...template.args, target.join("/")],
    ...(template.env === undefined ? {} : { env: { ...template.env } }),
  };
}
