import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-lifecycle-notifications-"));
const archive = join(temporaryRoot, "lifecycle-notifications.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(
        `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
      )));
  });
}

try {
  await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: packageRoot });
  const entries = (await output("tar", ["-tzf", archive])).split(/\r?\n/u).filter(Boolean);
  for (const required of ["package/README.md", "package/dist/index.d.ts", "package/dist/index.js"]) {
    if (!entries.includes(required)) throw new Error(`packed archive missing ${required}`);
  }
  if (entries.some((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry))) {
    throw new Error("test files leaked into the tarball");
  }

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@jinn-network/lifecycle-notifications": `file:${archive}` },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
  await writeFile(
    join(consumer, "consume.mjs"),
    'import { buildNotifications, NOTIFICATION_KINDS } from "@jinn-network/lifecycle-notifications";\n'
      + "if (NOTIFICATION_KINDS.length !== 16) throw new Error(\"kind count drifted\");\n"
      + "if (typeof buildNotifications !== \"function\") throw new Error(\"deriver missing\");\n"
      + "console.log(\"ok\");\n",
  );
  await run(process.execPath, ["consume.mjs"], { cwd: consumer });
  console.log("Packed lifecycle-notifications distribution + archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
