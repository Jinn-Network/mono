import { makeLauncher } from "./launcher-factory.js";
export const cursorLauncher = makeLauncher("cursor", ["cursor-agent", "--headless"]);
