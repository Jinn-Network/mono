import { makeLauncher } from "./launcher-factory.js";
export const hermesLauncher = makeLauncher("hermes", ["hermes-agent"], ["OPENROUTER_API_KEY", "secrets/openrouter-api-key"]);
