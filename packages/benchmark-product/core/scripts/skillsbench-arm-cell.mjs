#!/usr/bin/env node
/**
 * Runs one Demo-1 cell: one unit, one arm, one replicate.
 *
 * Materializes the arm's workspace, lets Claude Code attempt the task in it, then copies the
 * resulting workspace into the unit's pinned container and grades it with the upstream verifier.
 *
 * The three arms differ in exactly one thing — where the instruction text lives:
 *   A  the curated SKILL.md files in a plugin root, loaded through native progressive disclosure
 *   B  the same authenticated bodies flattened into a root CLAUDE.md, no SKILL.md anywhere
 *   C  neither
 * All three receive byte-identical non-instruction resources and the same base environment.
 *
 * The agent runs on the host rather than in the container, because Claude Code authenticates
 * itself there and no credential ever has to be handled or forwarded. The cost is that the agent
 * works against the host's interpreter rather than the task image's; that is a real deviation and
 * it is recorded on every cell rather than hidden.
 *
 *   node scripts/skillsbench-arm-cell.mjs --task <id> [--arms A,B,C] [--replicate 0]
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../../..");
const CACHE = resolve(REPO_ROOT, ".skillsbench-cache");
const OUT = resolve(REPO_ROOT, "docs/superpowers/plans/demo-report-1/E1-arm-cells.v1.json");
const COMMIT = "b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af";
const MODEL = process.env.DEMO1_MODEL ?? "claude-haiku-4-5-20251001";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const taskId = option("--task", "3d-scan-calc");
const armIds = (option("--arms", "A,B,C")).split(",");
const replicate = Number(option("--replicate", "0"));

const ARMS = {
  A: "A-native-skill",
  B: "B-flat-claude-md",
  C: "C-no-instructions",
};

const sh = (c, o = {}) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o });
const gitBlobId = (b) => createHash("sha1").update(`blob ${b.length}\0`, "utf8").update(b).digest("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

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
  if (gitBlobId(bytes) !== id) throw new Error(`blob ${id} does not match its Git object id`);
  writeFileSync(cached, bytes);
  return bytes;
}

const tree = JSON.parse(readFileSync(join(CACHE, `tree-${COMMIT}.json`), "utf8")).tree
  .filter((e) => e.type === "blob" && e.path.startsWith(`${taskId}/`));
if (tree.length === 0) throw new Error(`${taskId} not in the cached tree`);

const pkg = mkdtempSync(join(tmpdir(), `sb-cell-${taskId}-`));
for (const entry of tree) {
  const target = join(pkg, ...entry.path.slice(taskId.length + 1).split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, blob(entry.sha), { mode: entry.mode === "100755" ? 0o755 : 0o644 });
}

const statement = readFileSync(join(pkg, "task.md"), "utf8");
const body = statement.replace(/^---\n[\s\S]*?\n---\n/u, "");

/** Parses SKILL.md into frontmatter and body, mirroring the product's transform. */
function splitSkill(text) {
  const match = /^---\n[\s\S]*?\n---\n\n?/u.exec(text);
  if (match === null) throw new Error("SKILL.md has no frontmatter");
  return { front: match[0], body: text.slice(match[0].length) };
}

const skillsRoot = join(pkg, "environment", "skills");
const folders = existsSync(skillsRoot)
  ? sh(`ls -1 ${skillsRoot}`).trim().split("\n").filter((f) => existsSync(join(skillsRoot, f, "SKILL.md")))
  : [];
const skills = folders.sort().map((folder) => {
  const text = readFileSync(join(skillsRoot, folder, "SKILL.md"), "utf8");
  return { folder, text, ...splitSkill(text) };
});

const TRANSFORM = "jinn.demo1.claude-md-flatten@1";
const claudeMd = skills.map(({ folder, body: skillBody }) => {
  const source = `environment/skills/${folder}/SKILL.md`;
  return `<!-- ${TRANSFORM} begin source=${source} sha256=${sha256(skillBody)} -->\n`
    + `${skillBody}${skillBody.endsWith("\n") ? "" : "\n"}`
    + `<!-- ${TRANSFORM} end source=${source} -->`;
}).join("\n");

// Build the image once. Every arm grades in the same pinned environment.
const dockerText = readFileSync(join(pkg, "environment", "Dockerfile"), "utf8");
const reference = /^FROM\s+(\S+)/mu.exec(dockerText)[1];
sh(`docker pull -q ${reference}`);
const baseDigest = sh(`docker inspect --format '{{index .RepoDigests 0}}' ${reference}`).trim();
writeFileSync(join(pkg, "environment", "Dockerfile.pinned"), dockerText.replace(/^FROM\s+\S+/mu, `FROM ${baseDigest}`));
const tag = `jinn-demo1/${taskId}:cell`;
sh(`docker build -q -f ${join(pkg, "environment", "Dockerfile.pinned")} -t ${tag} ${join(pkg, "environment")}`, { timeout: 1_800_000 });

const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {
  schema: "jinn.demo1.arm-cells.v1",
  status: "REAL DEMO-1 ARM CELLS — pilot scale, not a locked official run",
  source: { benchmark: "skillsbench", release: "v1.1", commit: COMMIT },
  model: MODEL,
  agentLocation: "host",
  deviation: "The agent runs on the host, not inside the task image. Claude Code authenticates itself there, so no credential is handled or forwarded. The agent therefore works against the host interpreter rather than the task environment; grading always happens inside the pinned image.",
  cells: {},
};

for (const armId of armIds) {
  const arm = ARMS[armId];
  if (arm === undefined) throw new Error(`unknown arm ${armId}`);
  const cellId = `${taskId}/${arm}/r${replicate}`;
  if (results.cells[cellId] !== undefined) { console.log(`${cellId}: already recorded`); continue; }

  const ws = join(pkg, `ws-${arm}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });

  // Non-instruction environment content: identical in all three arms.
  for (const entry of tree) {
    const rel = entry.path.slice(taskId.length + 1);
    if (!rel.startsWith("environment/") || rel === "environment/Dockerfile") continue;
    const skill = /^environment\/skills\/([^/]+)\/(.+)$/u.exec(rel);
    if (skill !== null && skill[2] === "SKILL.md") continue;
    const dest = skill === null
      ? rel.slice("environment/".length)
      : `skills/${skill[1]}/${skill[2]}`;
    const target = join(ws, ...dest.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blob(entry.sha), { mode: entry.mode === "100755" ? 0o755 : 0o644 });
  }

  const args = ["-p", body, "--model", MODEL, "--permission-mode", "bypassPermissions"];
  if (arm === "A-native-skill") {
    const plugin = join(ws, ".jinn-demo1-skills");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), '{"name":"jinn-demo1-skills","version":"1.0.0"}\n');
    for (const skill of skills) {
      mkdirSync(join(plugin, "skills", skill.folder), { recursive: true });
      writeFileSync(join(plugin, "skills", skill.folder, "SKILL.md"), skill.text);
    }
    args.push("--plugin-dir", plugin);
  }
  if (arm === "B-flat-claude-md") writeFileSync(join(ws, "CLAUDE.md"), claudeMd);

  process.stdout.write(`${cellId}: solving... `);
  const started = Date.now();
  const agent = spawnSync("claude", args, { cwd: ws, encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
  const elapsed = Math.round((Date.now() - started) / 1000);
  if (process.env.DEMO1_TRACE === "1") {
    console.log(`\n--- agent stdout (${arm}) ---\n${(agent.stdout ?? "").slice(0, 1200)}`);
    console.log(`--- agent stderr ---\n${(agent.stderr ?? "").slice(0, 600)}`);
    console.log(`--- workspace ---\n${sh(`find ${ws} -maxdepth 2 -not -path '*/.git*' | head -25`)}`);
  }

  // Grade inside the pinned image, with the solved workspace mounted at the task's working dir.
  const graded = sh(
    `docker run --rm --network bridge -v "${ws}:/root:rw" -v "${join(pkg, "verifier")}:/verifier:ro" ${tag} `
    + `bash -c 'cd /root; mkdir -p /logs/verifier; bash /verifier/test.sh >/tmp/v.log 2>&1 || true; `
    + `echo REWARD=$(cat /logs/verifier/reward.txt 2>/dev/null || echo MISSING)'`,
    { timeout: 1_800_000 },
  );
  const reward = /REWARD=(\S+)/u.exec(graded)?.[1] ?? null;
  const fullPass = reward !== null && reward !== "MISSING" && Number(reward) === 1;

  results.cells[cellId] = {
    taskId, arm, replicate, model: MODEL,
    reward, fullPass,
    agentExit: agent.status, agentSeconds: elapsed,
    skills: skills.map((s) => ({ folder: s.folder, bodySha256: sha256(s.body) })),
    claudeMdSha256: arm === "B-flat-claude-md" ? sha256(claudeMd) : null,
    baseImage: baseDigest,
  };
  console.log(`reward=${reward} ${fullPass ? "PASS" : "fail"} (${elapsed}s)`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
}

try { sh(`docker rmi -f ${tag}`); } catch { /* fine */ }
if (process.env.DEMO1_KEEP !== "1") rmSync(pkg, { recursive: true, force: true }); else console.log(`kept ${pkg}`);
console.log(`\ncells recorded: ${Object.keys(results.cells).length}`);
console.log(`sealed ${OUT}`);
