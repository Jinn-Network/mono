export type RunVerdict = 'completed' | 'interactive-block' | 'error';

/**
 * Phrases that signal the run stopped to ask the human. Matched against the
 * tail of the final output. Tuned against live runs in the suite task.
 */
const INTERACTIVE_TAIL =
  /(which (?:option|approach)|waiting for (?:your |you)|let me know|shall i|should i proceed|do you want|your approval|approve (?:this|the)|please confirm)\b/i;

/**
 * Classify a finished headless run.
 *
 * The strong signal is whether the skill produced its expected deliverable.
 * If it did not, an interactive-style tail means the skill tried to block on a
 * human (the headless override failed); anything else is an error.
 */
export function classifyRun(
  finalText: string,
  opts: { producedDeliverable: boolean },
): RunVerdict {
  if (opts.producedDeliverable) return 'completed';
  const tail = finalText.trimEnd().slice(-600);
  if (INTERACTIVE_TAIL.test(tail) || /\?\s*$/.test(tail)) return 'interactive-block';
  return 'error';
}
