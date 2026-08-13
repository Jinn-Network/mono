import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "@jinn-network/task-execution-oci-grader";
import { parseHfRow, toSweRebenchRow } from "./mint-micro-slate.mjs";

const upstream = {
  instance_id: "owner__repo-1",
  repo: "owner/repo",
  base_commit: "a".repeat(40),
  problem_statement: "Fix the behavior.",
  created_at: "2026-08-01T00:00:00Z",
  image_name: "swerebench/example:latest",
  patch: "SECRET GOLD PATCH",
  test_patch: "PUBLIC TEST PATCH",
  FAIL_TO_PASS: "[\"test_regression\"]",
  PASS_TO_PASS: ["test_existing"],
  install_config: JSON.stringify({
    install: ["pip install -e ."],
    test_cmd: ["pytest -q"],
    log_parser: "parse_log_pytest",
  }),
};

test("mint parser structurally excludes the upstream gold patch", () => {
  const parsed = parseHfRow(upstream);
  assert.equal(Object.hasOwn(parsed, "patch"), false);
  assert.equal(JSON.stringify(parsed).includes("SECRET GOLD PATCH"), false);
  assert.equal(parsed.test_patch, "PUBLIC TEST PATCH");
});

test("mint mapper emits the exact canonical P3b material and matching image pin", () => {
  const parsed = parseHfRow(upstream);
  const hex = "b".repeat(64);
  const row = toSweRebenchRow(parsed, {
    source: upstream.image_name,
    reference: `swerebench/example@sha256:${hex}`,
    digest: `sha256:${hex}`,
  });
  assert.equal(row.image.name, "swe-rebench-grader-image");
  assert.equal(row.image.uri, `docker://swerebench/example@sha256:${hex}`);
  assert.equal(row.image.digest.sha256, hex);
  assert.equal(row.testMaterial.length, 1);
  const descriptor = row.testMaterial[0];
  assert.equal(descriptor.name, "swe-rebench-evaluation-row");
  const bytes = new Uint8Array(Buffer.from(descriptor.content, "base64"));
  assert.equal(sha256Hex(bytes), descriptor.digest.sha256);
  const material = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  assert.deepEqual(Object.keys(material).sort(), [
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "base_commit",
    "install_config",
    "instance_id",
    "test_patch",
  ]);
  assert.equal(material.test_patch, upstream.test_patch);
  assert.equal(JSON.stringify(material).includes(upstream.patch), false);
});
