import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const scratch = await mkdtemp(join(tmpdir(), "colophon-verify-pack-"));
try {
  const { stdout } = await run("yarn", ["pack", "--out", join(scratch, "verify.tgz")], { cwd: root });
  if (!stdout.includes("verify.tgz")) throw new Error("yarn pack did not create the requested tarball");
  await run("tar", ["-tzf", join(scratch, "verify.tgz")]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
