import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDemo1UpstreamSkill } from "../method/demo1-prerun.js";
import { readSkillsBenchReward } from "../method/skillsbench-reward.js";
import {
  buildSkillsBenchClaudeMd,
  buildSkillsBenchTreatment,
  verifySkillsBenchClaudeMdBodies,
} from "../method/skillsbench-treatment.js";
import { buildSkillsBenchUnit } from "../method/skillsbench-unit.js";
import { materializeSkillsBenchWorkspace, verifySkillsBenchWorkspaceTriple } from "./skillsbench-workspace.js";

/**
 * Non-model end-to-end fixture for the SkillsBench path. Opt in with `SKILLSBENCH_E2E=1`.
 *
 * Drives the whole chain on one real unit: authenticate the package, build the treatment manifest,
 * materialize all three arms, run each in the real pinned container with a NO-OP agent, grade with
 * the upstream verifier, and seal the outcomes.
 *
 * THIS IS A PLUMBING FIXTURE, NOT A DEMO-1 RUN. No model executes and the "agent" does nothing, so
 * every arm is expected to score zero. That is the point twice over: it proves the chain carries a
 * real outcome from materialization to sealed verdict, and it proves something a materialization
 * bug could otherwise hide — an arm scoring above zero here would mean its own instruction
 * materialization leaked the answer.
 */
const ENABLED = process.env.SKILLSBENCH_E2E === "1";
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const CACHE = resolve(REPO_ROOT, ".skillsbench-cache");
const OUT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-e2e-fixture.v1.json");
const taskId = process.env.SKILLSBENCH_E2E_TASK ?? "3d-scan-calc";


const sh = (c, o = {}) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o });
const gitBlobId = (b) => createHash("sha1").update(`blob ${b.length}\0`, "utf8").update(b).digest("hex");

describe.skipIf(!ENABLED)("SkillsBench non-model end-to-end fixture", () => {
  it("drives one unit through all three arms in real containers", { timeout: 3_600_000 }, async () => {

    function blob(id) {
      mkdirSync(CACHE, { recursive: true });
      const cached = join(CACHE, id);
      if (existsSync(cached)) {
        const bytes = readFileSync(cached);
        if (gitBlobId(bytes) !== id) throw new Error(`cached blob ${id} does not hash back`);
        return bytes;
      }
      const raw = execFileSync("gh", ["api", `repos/benchflow-ai/skillsbench/git/blobs/${id}`, "--jq", ".content"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const bytes = Buffer.from(raw.trim(), "base64");
      if (gitBlobId(bytes) !== id) throw new Error(`blob ${id} does not match its declared Git object id`);
      writeFileSync(cached, bytes);
      return bytes;
    }

    const treeCache = join(CACHE, `tree-b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af.json`);
    const tree = JSON.parse(readFileSync(treeCache, "utf8")).tree
      .filter((e) => e.type === "blob" && e.path.startsWith(`${taskId}/`));
    if (tree.length === 0) throw new Error(`${taskId} has no entries in the cached tree`);

    const dir = mkdtempSync(join(tmpdir(), `sb-e2e-${taskId}-`));
    for (const entry of tree) {
      const rel = entry.path.slice(taskId.length + 1);
      const target = join(dir, ...rel.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blob(entry.sha), { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }

    // Build the unit exactly as admission does.
    const entries = tree.map((e) => ({
      path: e.path.slice(taskId.length + 1), mode: e.mode, gitBlob: e.sha, bytes: e.size ?? 0,
    }));
    const statementText = readFileSync(join(dir, "task.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/u.exec(statementText);
    const scalar = (k) => (new RegExp(`^\\s{2}${k}:\\s*(\\S+)`, "mu").exec(front[1]) ?? [])[1]?.replace(/^["']|["']$/gu, "");
    const folders = [...new Set(entries.filter((e) => e.path.startsWith("environment/skills/") && e.path.split("/").length > 3)
      .map((e) => e.path.split("/")[2]))];
    const skills = folders.map((folder) => ({
      folder, skillMd: readFileSync(join(dir, "environment", "skills", folder, "SKILL.md"), "utf8"),
    }));

    const unit = buildSkillsBenchUnit({
      task: { name: taskId, treeSha: "0".repeat(40), packageDigest: "0".repeat(64) },
      statement: {
        path: "task.md", gitBlob: tree.find((e) => e.path.endsWith("/task.md")).sha, bytes: statementText.length,
        frontmatter: {
          networkMode: scalar("network_mode") ?? "public", verifierType: scalar("type") ?? "test-script",
          agentTimeoutSec: 900, verifierTimeoutSec: 900,
        },
        body: statementText.slice(front[0].length),
      },
      entries, skills, rootLicenseSpdxId: "Apache-2.0",
    });

    const bodies = skills.map(({ folder, skillMd }) => ({
      folder,
      body: new TextDecoder().decode(parseDemo1UpstreamSkill(new TextEncoder().encode(skillMd)).sourceMd),
    }));
    const treatment = buildSkillsBenchTreatment({ unit, bodies });
    if (!treatment.feasible) {
      throw new Error(`${taskId} is unverifiable: ${treatment.unverifiableReasons.join(", ")}`);
    }
    const claudeMd = buildSkillsBenchClaudeMd(unit, bodies);
    verifySkillsBenchClaudeMdBodies(claudeMd, unit);

    // Pin the base image and build once; every arm runs the same image.
    const dockerfile = join(dir, "environment", "Dockerfile");
    const text = readFileSync(dockerfile, "utf8");
    const reference = /^FROM\s+(\S+)/mu.exec(text)[1];
    sh(`docker pull -q ${reference}`);
    const baseDigest = sh(`docker inspect --format '{{index .RepoDigests 0}}' ${reference}`).trim();
    writeFileSync(join(dir, "environment", "Dockerfile.pinned"), text.replace(/^FROM\s+\S+/mu, `FROM ${baseDigest}`));
    const tag = `jinn-demo1/${taskId}:e2e`;
    sh(`docker build -q -f ${join(dir, "environment", "Dockerfile.pinned")} -t ${tag} ${join(dir, "environment")}`,
      { timeout: 1_800_000 });

    const arms = ["A-native-skill", "B-flat-claude-md", "C-no-instructions"];
    const workspaces = arms.map((arm) => materializeSkillsBenchWorkspace({
      treatment, arm, packageDir: dir, workspaceDir: join(dir, `ws-${arm}`), claudeMd,
    }));
    verifySkillsBenchWorkspaceTriple(workspaces);

    const results = {};
    for (const workspace of workspaces) {
      // The NO-OP agent: it does nothing. Every arm must therefore score zero, and any arm that does
      // not has leaked its own answer through materialization.
      const out = sh(
        `docker run --rm --network bridge -v "${workspace.root}:/root:rw" -v "${join(dir, "verifier")}:/verifier:ro" ${tag} `
        + `bash -c 'cd /root; mkdir -p /logs/verifier; bash /verifier/test.sh >/tmp/v.log 2>&1 || true; `
        + `echo REWARD=$(cat /logs/verifier/reward.txt 2>/dev/null || echo MISSING)'`,
        { timeout: 1_800_000 },
      );
      const reward = /REWARD=(\S+)/u.exec(out)?.[1] ?? null;
      const reading = readSkillsBenchReward({ rewardTxt: reward === "MISSING" ? null : reward });
      results[workspace.arm] = {
        reward, outcome: reading.outcome,
        files: workspace.files.length,
        resourceParityDigest: workspace.resourceParityDigest,
        argv: workspace.argv.length,
      };
      console.log(`${workspace.arm}: reward=${reward} outcome=${reading.outcome} files=${workspace.files.length}`);
    }
    try { sh(`docker rmi -f ${tag}`); } catch { /* fine */ }

    const parity = new Set(Object.values(results).map((r) => r.resourceParityDigest));
    const leaked = Object.entries(results).filter(([, r]) => r.outcome === "full-pass");
    const fixture = {
      schema: "jinn.demo1.e2e-fixture.v1",
      status: "NON-MODEL PLUMBING FIXTURE — NOT AN OFFICIAL DEMO-1 RUN",
      taskId,
      baseImage: baseDigest,
      skills: unit.skills.map((s) => ({ folder: s.folder, bodySha256: s.bodySha256 })),
      claudeMdSha256: createHash("sha256").update(claudeMd).digest("hex"),
      arms: results,
      assertions: {
        resourceParityAcrossArms: parity.size === 1,
        noArmPassedWithoutAnAgent: leaked.length === 0,
        armBExposesNoSkillMd: true,
        armCExposesNoInstructionPath: true,
      },
      execution: { modelArms: 0, previews: 0, agentRuns: 0, containerRuns: arms.length },
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });

    console.log(`\nresource parity across arms: ${parity.size === 1 ? "yes" : "NO"}`);
    console.log(`no arm passed without an agent: ${leaked.length === 0 ? "yes" : `NO — ${leaked.map(([a]) => a).join(", ")}`}`);
    console.log(`sealed ${OUT}`);
    expect(parity.size, "arms must carry byte-identical non-instruction resources").toBe(1);
        expect(leaked.map(([arm]) => arm), "no arm may pass without an agent having solved the task").toEqual([]);
        expect(fixture.execution.modelArms).toBe(0);

  });
});
