import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const image = "node:22.22.2-bookworm-slim";

function docker(args) {
  try {
    execFileSync("docker", args, { cwd: packageRoot, stdio: "inherit" });
  } catch (error) {
    // A skipped runtime proof would turn the static policy back into the asserted boundary.
    // Treat an unavailable daemon, image, mount, or namespace as a failed closed-profile check.
    throw new Error(`network-denied replay proof could not establish its Docker boundary: ${error.message}`);
  }
}

docker(["info"]);
docker([
  "run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL",
  "--security-opt=no-new-privileges", "--tmpfs", "/tmp",
  "--mount", `type=bind,src=${packageRoot},dst=/work,readonly`,
  "--workdir", "/work", image, "node", "scripts/network-denied-runtime.mjs",
]);
