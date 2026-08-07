import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

describe("narrow viewport action-result containment", () => {
  test("the reusable form and run-control grid let long terminal output shrink and wrap locally", () => {
    const actionForm = readFileSync(fileURLToPath(new URL("./action-form.tsx", import.meta.url)), "utf8");
    const runPage = readFileSync(
      fileURLToPath(new URL("../app/workspace/[draftId]/run/page.tsx", import.meta.url)),
      "utf8",
    );

    expect(actionForm).toMatch(/<form[^>]+className="[^"]*min-w-0/);
    expect(actionForm).toMatch(/<div aria-live="polite" className="[^"]*min-w-0/);
    expect(actionForm).toMatch(/<pre className="[^"]*max-w-full[^"]*overflow-x-auto[^"]*whitespace-pre-wrap[^"]*break-all/);
    expect(runPage).toMatch(/<CardContent className="[^"]*min-w-0[^"]*\[&>\*\]:min-w-0/);
  });
});
