import { BenchmarkProductError, readAuthorityPolicy } from "@colophon-claims/core";

/**
 * The principal the local app acted as before it looked at the workspace. It is still the answer
 * for a workspace that has no authority record yet: the app's Initialize action then founds the
 * workspace under it.
 */
export const LOCAL_OPERATOR = "local-operator";

/**
 * The ids of the workspace's members, or `undefined` when it has no authority record yet (never
 * initialized, or not a workspace). A record that exists but cannot be read is a refusal rather
 * than "no members": acting as a guessed principal over a broken policy would hide the breakage.
 */
export function readWorkspaceMemberIds(workspaceDir: string): readonly string[] | undefined {
  try {
    return readAuthorityPolicy(workspaceDir).principals.map((principal) => principal.id);
  } catch (cause) {
    if (cause instanceof BenchmarkProductError && cause.code === "not-found") return undefined;
    throw cause;
  }
}

/**
 * Which principal the local app acts as (issue #4957). The app's operations refuse every
 * principal that is not a member of the workspace, and `init --principal <id>` makes `<id>` the
 * only member, so a fixed `local-operator` was denied on every workspace the command line made.
 * In order:
 *
 * 1. an explicit `--principal`, which must be a member once the workspace has members;
 * 2. no members yet: `local-operator`, as before;
 * 3. `local-operator` when it is a member, which keeps workspaces the app founded working;
 * 4. the sole member;
 * 5. otherwise a refusal that lists the members, because choosing one of several would be a guess.
 */
export function resolveLocalAppPrincipal(input: {
  readonly explicit?: string;
  readonly members: readonly string[] | undefined;
}): string {
  const { explicit, members } = input;
  if (explicit !== undefined && explicit.trim() === "") throw new TypeError("--principal requires a value");
  if (members === undefined) return explicit ?? LOCAL_OPERATOR;
  if (explicit !== undefined) {
    if (members.includes(explicit)) return explicit;
    throw new Error(`${explicit} is not a member of this workspace. Members: ${members.join(", ")}. Choose one with --principal.`);
  }
  if (members.includes(LOCAL_OPERATOR)) return LOCAL_OPERATOR;
  if (members.length === 1) return members[0]!;
  throw new Error(`this workspace has several members (${members.join(", ")}) and none is ${LOCAL_OPERATOR}. Say which one to act as with --principal <id>.`);
}
