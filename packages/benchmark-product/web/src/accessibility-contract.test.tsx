import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CardTitle } from "@/components/ui/card";
import RootLayout from "./app/layout";

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("application accessibility contract", () => {
  test("the root layout provides the first keyboard target as a skip link", () => {
    const markup = renderToStaticMarkup(<RootLayout><main id="main-content">Content</main></RootLayout>);
    expect(markup).toMatch(/<body[^>]*><a[^>]+href="#main-content"/u);
    expect(markup).toContain("Skip to main content");
  });

  test("every route keeps the main-content skip target visibly focusable", () => {
    const css = source("./app/globals.css");
    expect(css).toMatch(/main#main-content:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--foreground\)[^}]*\}/su);
    for (const route of [
      "./app/page.tsx",
      "./app/workspace/page.tsx",
      "./app/workspace/new/page.tsx",
      "./app/workspace/[draftId]/page.tsx",
      "./app/workspace/[draftId]/run/page.tsx",
      "./app/workspace/[draftId]/results/page.tsx",
    ]) {
      const component = source(route);
      expect(component, route).toMatch(/<main id="main-content"[^>]*tabIndex=\{-1\}/u);
    }
  });

  test("card titles are real second-level headings", () => {
    expect(renderToStaticMarkup(<CardTitle>State</CardTitle>)).toContain("<h2");
  });

  test("global styles keep focus visible and disable nonessential motion on request", () => {
    const css = source("./app/globals.css");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toMatch(/animation-duration:\s*0\.01ms/u);
  });

  test("action results are programmatically focusable after live updates", () => {
    for (const component of [
      source("./components/action-form.tsx"),
      source("./components/verification-form.tsx"),
    ]) {
      expect(component).toContain("resultRef");
      expect(component).toMatch(/tabIndex=\{-1\}/u);
      expect(component).toContain(".focus()");
      expect(component).toContain("focus-visible:ring-");
      expect(component).not.toMatch(/aria-atomic="true" className="[^"]*outline-none/u);
    }
  });
});
