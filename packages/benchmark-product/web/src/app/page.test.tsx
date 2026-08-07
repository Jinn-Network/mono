import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Button } from "@/components/ui/button";
import { WEB_BRANDING } from "@/lib/branding";
import Page from "./page";

describe("landing page", () => {
  const markup = renderToStaticMarkup(<Page />);

  test("renders the product identity", () => {
    expect(markup).toContain(WEB_BRANDING.displayName);
    expect(markup).toContain(WEB_BRANDING.tagline);
  });

  test("explains what the product compares", () => {
    expect(markup).toContain("agent configurations on the same tasks");
  });

  test("carries the run-accounting and report facts", () => {
    const lower = markup.toLowerCase();
    for (const term of ["quality", "cost", "runtime", "failures", "disagreement", "report"]) {
      expect(lower, `expected markup to mention "${term}"`).toContain(term);
    }
  });
});

describe("shadcn primitive plumbing", () => {
  test("Button renders its text child", () => {
    const markup = renderToStaticMarkup(<Button>Continue</Button>);
    expect(markup).toContain("Continue");
  });
});
