import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

// Skill-text pins for the Autopilot session skills (single-surface lifecycle
// §7: "The skill-text test suite pins each skill's contract: required verbs
// present, forbidden operations absent"). The prose these pins match is the
// contract, not decoration -- a rewording that drops a pinned phrase must
// update the pin in the same change, and must not drop the rule.
//
// Issue #3239: a fix-child session landed a code fix and its commit message
// asserted it had also corrected the parent PR body. It had not, and could
// not: `session child-complete` writes no PR body. The skill was silent on
// the boundary, so the session filled the silence with a false claim.

const root = resolve(import.meta.dirname, "../..");
const fixChildPath = join(root, ".claude/skills/fix-child/SKILL.md");
const fixChild = readFileSync(fixChildPath, "utf8");
// Pinned phrases are prose, so they wrap. Match against a flow-collapsed copy.
const fixChildFlow = fixChild.replace(/\s+/gu, " ");

// The complete set of shared mutations a fix-child session may perform, per
// the autopilot-runtime verb roster.
const FIX_CHILD_VERBS = new Set(["checkpoint", "child-complete", "human"]);

test("fix-child invokes only its three roster verbs", () => {
  const invoked = new Set(
    [...fixChild.matchAll(/autopilot session ([a-z-]+)/gu)].map((m) => m[1]),
  );
  for (const verb of invoked) {
    assert.ok(
      FIX_CHILD_VERBS.has(verb),
      `fix-child must not invoke 'autopilot session ${verb}'`,
    );
  }
  for (const verb of FIX_CHILD_VERBS) {
    assert.ok(invoked.has(verb), `fix-child must document 'autopilot session ${verb}'`);
  }
});

test("fix-child states that it cannot mutate the parent PR body", () => {
  assert.match(
    fixChildFlow,
    /no verb that mutates the parent pull request body/,
    "fix-child must state plainly that it has no PR-body verb",
  );
});

test("fix-child forbids asserting an unmutatable change", () => {
  assert.match(
    fixChildFlow,
    /Never assert a change to a surface this session has no verb to mutate\./,
    "fix-child must forbid commit messages that claim an unreachable change",
  );
});

test("fix-child routes a materially falsified summary to the human door", () => {
  const start = fixChild.indexOf("## Surfaces you cannot mutate");
  assert.notEqual(start, -1, "fix-child must carry the surfaces section");
  const section = fixChild.slice(start);
  assert.match(
    section,
    /session human/,
    "the surfaces section must name `session human` as the escalation route",
  );
});

test("fix-child invents no summary-writing flag", () => {
  assert.doesNotMatch(
    fixChild,
    /child-complete[^\n]*--summary-file/,
    "`session child-complete` takes no --summary-file; do not document one",
  );
});
