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
  const archive = join(scratch, "verify.tgz");
  const listing = (await run("tar", ["-tzf", archive])).stdout.split("\n");
  for (const required of [
    "package/dist/admission/index.js",
    "package/dist/admission/index.d.ts",
    "package/dist/profile/binary-judge-manifest.js",
    "package/dist/reader-instructions.js",
  ]) {
    if (!listing.includes(required)) throw new Error(`packed verifier is missing ${required}`);
  }
  const manifest = JSON.parse((await run("tar", ["-xOzf", archive, "package/package.json"])).stdout);
  if (manifest.name !== "@colophon-claims/verify" || manifest.version !== "2.0.0") {
    throw new Error("packed verifier identity/version drifted");
  }
  if (manifest.exports?.["./admission"] === undefined) {
    throw new Error("packed verifier omits the portable admission export");
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
