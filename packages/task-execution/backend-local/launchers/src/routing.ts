import type { LauncherContract } from "./contract.js";

export const REPOSITORY_WORK_PROFILE =
  "https://jinn.network/task-profiles/repository-work/1.0";
export const EVALUATION_TASK_PROFILE =
  "https://jinn.network/task-profiles/evaluation-task/1.0";
export const EVALUATION_LAUNCHER_ID = "evaluation-harness";

function supports(launcher: LauncherContract, profile: string): boolean {
  return launcher.capabilities().taskProfiles.includes(profile);
}

/**
 * Applies the deployment's profile routing rule before planning.  Registry insertion order is
 * deliberately not an input to routing: an evaluation Task has exactly one eligible launcher.
 */
export function selectProfileSafeLauncher(
  launchers: readonly LauncherContract[],
  profile: string,
  harness?: string,
): LauncherContract {
  if (profile === EVALUATION_TASK_PROFILE) {
    if (harness !== undefined && harness !== EVALUATION_LAUNCHER_ID) {
      throw new Error(`harness "${harness}" does not support profile "${profile}"`);
    }
    const evaluation = launchers.filter((candidate) =>
      candidate.id === EVALUATION_LAUNCHER_ID && supports(candidate, profile));
    if (evaluation.length !== 1) {
      throw new Error("evaluation profile requires exactly one dedicated evaluation harness");
    }
    return evaluation[0]!;
  }

  const candidates = launchers.filter((candidate) =>
    candidate.id !== EVALUATION_LAUNCHER_ID
    && supports(candidate, profile)
    && (harness === undefined || candidate.id === harness));
  if (candidates.length === 0) {
    if (harness !== undefined) {
      throw new Error(`harness "${harness}" does not support profile "${profile}"`);
    }
    throw new Error(`no launcher supports profile "${profile}"`);
  }
  return [...candidates].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)[0]!;
}
