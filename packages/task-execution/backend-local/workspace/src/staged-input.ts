/**
 * The provisioned `input/` directory contract (#2538).
 *
 * The provisioner decides where the sealed Task lands; every reader of that Task — launchers, the
 * evaluation harness runtime, the conformance kit — must read the SAME name. Before this module
 * existed the name was a string literal repeated at each site, and the two that mattered most had
 * drifted apart: the provisioner staged `input/task.sealed`, while the prediction-v1-baseline
 * launcher walked the input tree for `*.json` only. Live, on the two-operator gate, that launcher
 * found zero Tasks and exited 2 about ten milliseconds after start, so a claimed task could never
 * reach delivery.
 *
 * The defect survived CI because the launcher's own test hand-wrote `task.json` into a scratch
 * input dir. A fixture that stages the input itself can disagree with production in the same
 * direction forever, and then no test can ever catch the divergence. Both halves are fixed here:
 * the name is single-sourced below, and the launcher test provisions through the real provisioner
 * instead of writing a file of its own choosing.
 *
 * Read from a constant, never glob. Globbing `*.json` also meant any materialized input that
 * happened to parse as a native Task could stand in for the sealed one; reading the contracted
 * path makes that substitution impossible.
 */

/** The sealed Task document, staged by the provisioner at `<input>/task.sealed`. */
export const STAGED_SEALED_TASK_FILENAME = "task.sealed";

/** The sealed dispatch context, staged by the provisioner at `<input>/dispatch-context.json`. */
export const STAGED_DISPATCH_CONTEXT_FILENAME = "dispatch-context.json";
