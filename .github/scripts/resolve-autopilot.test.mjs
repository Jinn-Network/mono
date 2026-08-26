import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const resolver = join(root, ".github/scripts/resolve-autopilot.sh");
const pinPath = join(root, ".github/autopilot-pin.json");
const painterPath = join(root, ".github/workflows/autopilot-board-painter.yml");

const SKILL_PATHS = [
  ".claude/skills/implement-issue/SKILL.md",
  ".claude/skills/review-pr/SKILL.md",
  ".claude/skills/fix-child/SKILL.md",
  ".claude/skills/reconcile/SKILL.md",
  ".claude/skills/eng-day/SKILL.md",
  ".claude/skills/merge-batch/SKILL.md",
  ".claude/skills/autopilot-runtime/SKILL.md",
  ".claude/skills/autopilot-runtime/references/claude.md",
  ".claude/skills/autopilot-runtime/references/cursor.md",
  ".claude/skills/autopilot-runtime/references/hermes.md",
  ".claude/skills/merge-batch/references/merge-mechanics.md",
];

function source(env, extra = "type autopilot") {
  return spawnSync("bash", ["-c", `set -euo pipefail; . "${resolver}"; ${extra}`], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("pin file is an exact SHA, not a branch", () => {
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  assert.equal(pin.repository, "Jinn-Network/autopilot");
  assert.match(pin.sha, /^[0-9a-f]{40}$/u);
});

test("board-painter workflow pins the standalone repo at the pin SHA", () => {
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  const yaml = readFileSync(painterPath, "utf8");
  assert.match(yaml, /repository:\s+Jinn-Network\/autopilot/);
  assert.doesNotMatch(yaml, /yarn --cwd packages\/autopilot/);
  assert.ok(
    yaml.includes(pin.sha),
    "autopilot-board-painter.yml must embed .github/autopilot-pin.json sha",
  );
});

test("evaluator inventories no longer treat packages/autopilot as a live subject", () => {
  const scope = readFileSync(
    join(root, "operator/src/harnesses/impls/jinn-repo-evaluator/scope-tests.ts"),
    "utf8",
  );
  const docker = readFileSync(
    join(root, "operator/src/harnesses/impls/jinn-repo-evaluator/docker-immutable-verifier.ts"),
    "utf8",
  );
  assert.doesNotMatch(scope, /export const AUTOPILOT_PACKAGE/);
  assert.doesNotMatch(scope, /root:\s*'packages\/autopilot'/);
  assert.doesNotMatch(docker, /'packages\/autopilot'/);
});

test("skills do not default to packages/autopilot", () => {
  for (const rel of SKILL_PATHS) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.doesNotMatch(
      text,
      /JINN_AUTOPILOT_PACKAGE_DIR:-\S*packages\/autopilot/,
      `${rel} must not default JINN_AUTOPILOT_PACKAGE_DIR to packages/autopilot`,
    );
    assert.doesNotMatch(
      text,
      /yarn --cwd packages\/autopilot/,
      `${rel} must not hardcode yarn --cwd packages/autopilot`,
    );
    assert.doesNotMatch(
      text,
      /\$WORKTREE_PATH\/packages\/autopilot/,
      `${rel} must not cd into the vendored tree`,
    );
  }
});

test("missing Autopilot resolution is a hard error", () => {
  const result = source({
    JINN_AUTOPILOT_BIN: "",
    JINN_AUTOPILOT_PACKAGE_DIR: "",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /vendored packages\/autopilot tree is not a fallback/);
});

test("a packages/autopilot directory is refused even when explicitly set", () => {
  const result = source({
    JINN_AUTOPILOT_BIN: "",
    JINN_AUTOPILOT_PACKAGE_DIR: join(root, "packages/autopilot"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not point at the retired vendored tree/);
});

test("JINN_AUTOPILOT_BIN wins and must exist", () => {
  const missing = source({
    JINN_AUTOPILOT_BIN: join(root, "definitely-not-an-autopilot-bin"),
    JINN_AUTOPILOT_PACKAGE_DIR: "",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /JINN_AUTOPILOT_BIN is set but not found/);

  const dir = mkdtempSync(join(tmpdir(), "jinn-autopilot-bin-"));
  const bin = join(dir, "autopilot");
  try {
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const ok = source(
      { JINN_AUTOPILOT_BIN: bin, JINN_AUTOPILOT_PACKAGE_DIR: "" },
      'autopilot; printf ok',
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
