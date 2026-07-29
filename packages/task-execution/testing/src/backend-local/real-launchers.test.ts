import { claudeCodeLauncher, codexLauncher, cursorLauncher, hermesLauncher } from "@jinn-network/task-execution-launchers";
import { describeLauncherContract } from "./launcher-contract.js";

// Concrete subjects are owned by the downstream testing package (program §7.25).
describeLauncherContract(claudeCodeLauncher);
describeLauncherContract(codexLauncher);
describeLauncherContract(hermesLauncher);
describeLauncherContract(cursorLauncher);
