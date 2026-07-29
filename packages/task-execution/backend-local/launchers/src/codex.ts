import { makeLauncher } from "./launcher-factory.js";
export const codexLauncher = makeLauncher("codex", ["codex", "exec", "--json"]);
