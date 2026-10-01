/**
 * The commands a claimant runs to bring a finished run, in the order they are run (issue #4943).
 *
 * One list, because three surfaces state this order and the pre-publish rehearsal found them
 * disagreeing: the published CLI's top-level help started at `method`, which cannot run before
 * `init` and `draft create`; `method --help` described the service's launch path; and the CLI
 * README left `quote` out although `lock` accepts only a quoted draft. The help texts are rendered
 * from this list or tested against it, so a step added here reaches all of them.
 *
 * `quote` is on the path because `lock` requires a quoted draft today (`operations/run-lock.ts`).
 * `anchor` is the one optional step: a claim publishes without it, and a lock anchor is only
 * obtainable before `run import`, which is why it sits where it does.
 */

export interface ClaimantCommand {
  /** The verb as the CLI dispatches it, e.g. `"draft create"`. */
  readonly verb: string;
  /** True for a step a claim can be published without. */
  readonly optional: boolean;
}

export const CLAIMANT_COMMAND_PATH: readonly ClaimantCommand[] = [
  { verb: "init", optional: false },
  { verb: "draft create", optional: false },
  { verb: "method", optional: false },
  { verb: "arm add", optional: false },
  { verb: "quote", optional: false },
  { verb: "lock", optional: false },
  { verb: "anchor", optional: true },
  { verb: "run import", optional: false },
  { verb: "collect", optional: false },
  { verb: "report", optional: false },
  { verb: "publish", optional: false },
];

/** The path on one line, an optional step in brackets: `init, draft create, …, [anchor], …`. */
export function renderClaimantCommandPath(): string {
  return CLAIMANT_COMMAND_PATH.map((step) => (step.optional ? `[${step.verb}]` : step.verb)).join(", ");
}
