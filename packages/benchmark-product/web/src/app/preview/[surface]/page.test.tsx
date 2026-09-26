import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import PreviewPage from "./page";

// MOCK_JUSTIFICATION: Next navigation is a framework boundary; PreviewPage only needs notFound as a stub.
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("hosted preview surfaces", () => {
  test("states no check count the verifier's supported formats do not all promise", async () => {
    const markup = renderToStaticMarkup(
      await PreviewPage({ params: Promise.resolve({ surface: "reports" }) }),
    );

    // Same defect class as issue #3311: a numeral on the verifier is a denominator
    // readers cannot rely on across formats. The shared "What is real today" aside
    // renders on every /preview/<surface> route (issue #3817).
    expect(markup).toContain("What is real today");
    expect(markup).toContain("standalone verifier");
    expect(markup).not.toMatch(/\b(?:six|seven|[0-9]+)[\s-]+(?:bundle\s+)?checks?\b/iu);
  });
});
