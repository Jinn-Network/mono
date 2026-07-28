import type { TaskExecutionErrorCategory } from "@jinn-network/task-execution-protocol";

// The three categories profiles produces, drawn from TEP's vocabulary (never redeclared here).
// `Extract` keeps the binding live — if protocol renames a category this stops compiling rather
// than silently drifting (program §7.3; TEP §13: bindings never invent parallel taxonomies).
export type ProfilesErrorCode = Extract<
  TaskExecutionErrorCategory,
  "invalid-document" | "unsupported-profile" | "unsupported-requirement"
>;

// Profiles keeps its own Error class: it is not the backend, so it must never throw
// TaskExecutionError.
export class ProfilesError extends Error {
  constructor(readonly code: ProfilesErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProfilesError";
  }
}
