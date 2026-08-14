import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { Button } from "@/components/ui/button";
import Page from "./page";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("landing page", () => {
  const markup = renderToStaticMarkup(<Page />);

  test("leads with the three local jobs", () => {
    for (const term of ["Run the sample", "Verify a bundle", "Use my work"]) expect(markup).toContain(term);
    expect(markup.indexOf("Run the sample")).toBeLessThan(markup.indexOf("Advanced product surfaces"));
  });

  test("states the zero-account and local-only boundary in plain speech", () => {
    const lower = markup.toLowerCase();
    for (const term of ["no account", "no api key", "no telemetry", "stays on this machine", "may cost money"]) {
      expect(lower, `expected markup to mention "${term}"`).toContain(term);
    }
  });

  test("keeps expert work behind an advanced disclosure", () => {
    expect(markup).toContain("Advanced product surfaces");
    expect(markup).toContain('href="/workspace"');
  });
});

describe("shadcn primitive plumbing", () => {
  test("Button renders its text child", () => {
    const markup = renderToStaticMarkup(<Button>Continue</Button>);
    expect(markup).toContain("Continue");
  });
});
