// SPDX-License-Identifier: Apache-2.0
//
// One walk over `actions/download-artifact` steps, shared by every gate that
// asks what a workflow restores. It used to be copied per workflow test, and
// #3127 fixed the copy in `workflow-precedent-citations.test.mjs` while the
// other two kept the pre-fix walk — a repository holding a fixed and an
// unfixed copy of the same walk. The behaviour lives here now; the tests
// import it.

// A `name:` value is a whole YAML scalar, not a single unquoted token. Reading
// it as `(\S+)` skipped any name carrying a `${{ }}` expression, because the
// spaces inside the expression defeat `\S+` — and a skipped step is one the
// gates never see. It also kept the surrounding quotes of a quoted name, so
// quoting an artifact consistently on both sides read as a missing restore.
export function artifactValue(line, key) {
  const match = line.match(new RegExp(`^\\s+${key}:\\s+(.+?)\\s*$`));
  if (!match) return undefined;
  return match[1].replace(/^(['"])(.*)\1$/, '$2');
}

// The indentation of the `- ` line that opens the step containing `index`.
export function stepOpenerIndent(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const opener = lines[cursor].match(/^(\s*)- /);
    if (opener) return opener[1].length;
  }
  return 0;
}

// True at the first line that cannot belong to the step opened at `stepIndent`:
// the next step, or any dedent out of the step's block. Without the dedent arm a
// `pattern:` restore that is the last step of its job keeps scanning into the
// next job and matches that job's `name:`, scoring a workflow that restores
// nothing by name as compliant.
export function leavesStep(line, stepIndent) {
  if (line.trim() === '') return false;
  const indent = line.match(/^\s*/)[0].length;
  return indent <= stepIndent;
}

// Returns one `{ name, path }` per download step that restores by name. Reading
// both from inside the step is what makes a placement assertion mean anything:
// a bare `name: x` / `path: y` search over the whole file also matches the
// *upload* steps, so it would pass while the restores land somewhere else
// entirely.
export function restoredArtifacts(source) {
  const restored = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('uses: actions/download-artifact')) continue;
    const stepIndent = stepOpenerIndent(lines, index);
    const step = { name: undefined, path: undefined };
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (leavesStep(lines[cursor], stepIndent)) break;
      const name = artifactValue(lines[cursor], 'name');
      if (name) step.name = name;
      const path = artifactValue(lines[cursor], 'path');
      if (path) step.path = path;
    }
    if (step.name) restored.push(step);
  }
  return restored;
}

export function restoredArtifactNames(source) {
  return restoredArtifacts(source).map((step) => step.name);
}
