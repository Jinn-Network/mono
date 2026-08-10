import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const root = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

describe("Colophon production presentation contract", () => {
  test("keeps a curated, checksummed design reference and real source marks", () => {
    const adaptation = source("../design-system/ADAPTATION.md");
    const provenance = JSON.parse(source("../design-system/SOURCE.json")) as {
      readonly archiveSha256?: string;
      readonly omitted?: readonly string[];
    };
    expect(provenance.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.omitted).toContain("_ds_bundle.js");
    expect(adaptation).toContain("reference-only");
    expect(source("public/brand/mark.svg")).toContain('aria-label="Colophon mark"');
  });

  test("renders the Colophon public promise and real workspace CTA", () => {
    const page = source("src/app/page.tsx");
    expect(page).toContain("categoryDescriptor");
    expect(page).toContain("PRODUCT_BRANDING.tagline");
    expect(page).toContain("PRODUCT_BRANDING.promise");
    expect(page).toContain('href="/workspace"');
    expect(page).toContain('href="/preview/reports"');
  });

  test("keeps future hosted surfaces allowlisted, read-only, and visibly labelled", () => {
    const preview = source("src/app/preview/[surface]/page.tsx");
    const catalog = source("src/lib/preview-surfaces.ts");
    expect(preview).toContain("Preview — future hosted service");
    expect(catalog).toContain("pricing");
    expect(catalog).toContain("billing");
    expect(preview).not.toMatch(/GUI_SERVER_ACTIONS|ActionForm|<form|action=/u);
  });

  test("ships no remote font or prototype-runtime dependency", () => {
    const globals = source("src/app/globals.css");
    const layout = source("src/app/layout.tsx");
    expect(`${globals}\n${layout}`).not.toMatch(/fonts\.googleapis|fonts\.gstatic|_ds_bundle/u);
    expect(globals).toContain("--paper: #f7f4ed");
    expect(globals).toContain("--font-display");
  });
});
