// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";
import {
  SKILLSBENCH_ADAPTER_ID,
  SKILLSBENCH_UNIT_KIND,
  createSkillsBenchNativeAdapter,
} from "./skillsbench.js";
import type { NativeSnapshotEntry, NativeSnapshotReader } from "./harbor.js";
import type { NativeSnapshot } from "./types.js";

const SNAPSHOT: NativeSnapshot = {
  snapshotId: "snap-1",
  source: { kind: "skillsbench", locator: "tasks/" },
  root: { digest: { sha256: "a".repeat(64) } } as never,
  capturedAt: "2026-08-16T00:00:00Z",
};

const OPTIONS = {
  adapterVersion: "0.1.0",
  mappingVersion: "1",
  release: { tag: "v1.1", commit: "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af" },
  benchflow: { version: "0.6.3", commit: "99baefb602674bbd31139fd2f1a22c3ed45752f9" },
  executable: { path: "/usr/bin/bench", descriptor: { digest: { sha256: "b".repeat(64) } } },
};

function reader(paths: readonly string[]): NativeSnapshotReader {
  const entries: NativeSnapshotEntry[] = paths.map((path) => ({ path, kind: "file", size: 1 }));
  return { list: () => entries, read: () => new Uint8Array() };
}

/** A complete package plus a deliberately incomplete sibling. */
const ROSTER = reader([
  "citation-check/task.md",
  "citation-check/environment/Dockerfile",
  "citation-check/environment/skills/citation/SKILL.md",
  "citation-check/oracle/solve.sh",
  "citation-check/verifier/test.sh",
  "bike-rebalance/task.md",
  "bike-rebalance/environment/Dockerfile",
  "bike-rebalance/oracle/solve.sh",
  "bike-rebalance/verifier/test.sh",
  "half-a-task/task.md",
  "half-a-task/environment/Dockerfile",
]);

test("probe reports compatibility, scope, and the release as the native group", () => {
  const probe = createSkillsBenchNativeAdapter(ROSTER, OPTIONS).probe(SNAPSHOT);
  expect(probe.compatible).toBe(true);
  expect(probe.adapter.id).toBe(SKILLSBENCH_ADAPTER_ID);
  expect(probe.expectedScope.unitKind).toBe(SKILLSBENCH_UNIT_KIND);
  expect(probe.expectedScope.expectedUnitCount).toBe(2);
  expect(probe.expectedScope.nativeGroupId?.value).toBe(OPTIONS.release.commit);
});

test("probe records the mutable-base-tag and egress limitations on every run", () => {
  // A reader of the sealed evidence has to see these without going back to the source.
  const { limitations } = createSkillsBenchNativeAdapter(ROSTER, OPTIONS).probe(SNAPSHOT);
  expect(limitations.some((line) => /mutable base tag/u.test(line))).toBe(true);
  expect(limitations.some((line) => /per-unit allowlist/u.test(line))).toBe(true);
});

test("probe refuses a snapshot with no task package", () => {
  const probe = createSkillsBenchNativeAdapter(reader(["README.md", "docs/x.md"]), OPTIONS).probe(SNAPSHOT);
  expect(probe.compatible).toBe(false);
  expect(probe.expectedScope.expectedUnitCount).toBe(0);
  expect(probe.limitations.some((line) => /at least one task package/u.test(line))).toBe(true);
});

test("inventory enumerates complete packages only, in stable order", () => {
  const inventory = createSkillsBenchNativeAdapter(ROSTER, OPTIONS).inventory(SNAPSHOT);
  expect(inventory.units.map((unit) => unit.unitKey)).toEqual(["bike-rebalance", "citation-check"]);
  expect(inventory.nativeGroup?.value).toBe(OPTIONS.release.commit);
});

test("inventory binds release, task, and the exact BenchFlow version to every unit", () => {
  const [unit] = createSkillsBenchNativeAdapter(ROSTER, OPTIONS).inventory(SNAPSHOT).units;
  const schemes = unit.identifiers.map((id) => id.scheme);
  expect([...schemes].sort()).toEqual(["urn:benchflow:version", "urn:skillsbench:release", "urn:skillsbench:task"]);
  expect(unit.identifiers.find((id) => id.scheme === "urn:benchflow:version")?.value).toBe("0.6.3");
});

test("atomize captures a complete package without fabricating evidence", () => {
  const adapter = createSkillsBenchNativeAdapter(ROSTER, OPTIONS);
  const [unit] = adapter.inventory(SNAPSHOT).units;
  const draft = adapter.atomize(SNAPSHOT, unit!, { mode: "prospective", owner: "urn:test:owner" as never });
  expect(draft.status).toBe("captured");
  // A package describes work that has not run. Synthesizing Execution Evidence here would be
  // claiming an observation that never happened.
  expect(draft.evidence).toBe(undefined);
  expect(draft.artifacts).toEqual([]);
  expect(draft.limitations.some((line) => /none is synthesized/u.test(line))).toBe(true);
});

test("atomize excludes an incomplete package and names what is missing", () => {
  const adapter = createSkillsBenchNativeAdapter(ROSTER, OPTIONS);
  const draft = adapter.atomize(
    SNAPSHOT,
    { unitKey: "half-a-task", identifiers: [] },
    { mode: "prospective", owner: "urn:test:owner" as never },
  );
  expect(draft.status).toBe("excluded");
  expect(draft.limitations[0]!).toMatch(/missing oracle\/solve\.sh, verifier\/test\.sh/u);
});

test("atomize tombstones a unit that vanished between inventory and atomization", () => {
  const adapter = createSkillsBenchNativeAdapter(ROSTER, OPTIONS);
  const draft = adapter.atomize(
    SNAPSHOT,
    { unitKey: "gone", identifiers: [] },
    { mode: "prospective", owner: "urn:test:owner" as never },
  );
  expect(draft.status).toBe("tombstone");
});

test("prepareLaunch is absent unless a launch is configured", () => {
  expect(createSkillsBenchNativeAdapter(ROSTER, OPTIONS).prepareLaunch).toBe(undefined);
});

test("prepareLaunch pins argv, environment, and an isolated workspace", () => {
  const adapter = createSkillsBenchNativeAdapter(ROSTER, {
    ...OPTIONS,
    launch: { argv: ["bench", "eval", "run"], environment: [{ name: "BENCHFLOW_SANDBOX", value: "docker" }] },
  });
  const invocation = adapter.prepareLaunch!(SNAPSHOT, adapter.probe(SNAPSHOT));
  expect(invocation.argv).toEqual(["bench", "eval", "run"]);
  // Never the sealed source root: a solve must not be able to edit the package bytes the run pins.
  expect(invocation.workingDirectoryPolicy).toBe("isolated-workspace");
  expect(invocation.executable.path).toBe("/usr/bin/bench");
});
