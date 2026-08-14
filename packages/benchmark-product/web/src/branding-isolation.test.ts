/**
 * Brand-neutrality sweep for the web application (see
 * `packages/benchmark-product/core/src/cli/lexicon.test.ts` for the pattern this
 * mirrors -- read, not modified; that file belongs to a sibling packet).
 *
 * This test file is itself part of the swept tree below (nothing is excluded by
 * filename, per the packet brief: "skip nothing else"). That means every banned
 * term has to be assembled from fragments rather than written as a contiguous
 * literal anywhere in this file -- including in comments and messages --
 * otherwise this file would fail its own checks.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { PRODUCT_BRANDING } from "./lib/branding.js";

// Fragments, not contiguous literals -- see file header.
const BANNED_LEXICON = [
  ["ve", "ssel"].join(""),
  ["v", "ow"].join(""),
  ["sum", "mon"].join(""),
  ["se", "er"].join(""),
  ["sm", "oke"].join(""),
  ["wa", "ne"].join(""),
];

const PROTOCOL_NAME = ["J", "inn"].join("");
const EXPECTED_ATTRIBUTION = ["Built on ", PROTOCOL_NAME, "."].join("");

const DESIGN_SYSTEM_REFS = [
  ["j", "inn-design-system"].join(""),
  ["colors_and_", "type"].join(""),
  ["foundations", ".css"].join(""),
];

// Conservative pictographic range, same as apps/website/test/content.test.mjs.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function renderCodeOnly(source: string, isCode: Uint8Array): string {
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    out += isCode[index] ? source[index] : source[index] === "\n" ? "\n" : " ";
  }
  return out;
}

function typescriptCodeOnly(source: string, file: string): string {
  const scriptKind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const isCode = new Uint8Array(source.length);
  const walk = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(parsed);
    if (children.length === 0) {
      for (let index = node.getStart(parsed); index < node.getEnd(); index += 1) isCode[index] = 1;
      return;
    }
    for (const child of children) walk(child);
  };
  walk(parsed);
  return renderCodeOnly(source, isCode);
}

function cssCodeOnly(source: string, file: string): string {
  const isCode = new Uint8Array(source.length);
  isCode.fill(1);
  postcss.parse(source, { from: file }).walkComments((comment) => {
    const start = comment.source?.start?.offset;
    const end = comment.source?.end?.offset;
    if (start === undefined || end === undefined) throw new Error(`CSS comment has no source range in ${file}`);
    isCode.fill(0, start, end);
  });
  return renderCodeOnly(source, isCode);
}

function sourceCodeOnly(source: string, file: string): string {
  return extname(file) === ".css" ? cssCodeOnly(source, file) : typescriptCodeOnly(source, file);
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("web package lexicon and brand-neutrality sweep", () => {
  const files = collectSourceFiles(SRC_DIR);

  test("collects at least one source file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("comment prose is ignored while TSX and CSS values remain scanned", () => {
    const term = BANNED_LEXICON[0]!;
    const emoji = String.fromCodePoint(0x1f9ea);
    const proseTerms = [term, PROTOCOL_NAME, emoji, DESIGN_SYSTEM_REFS[0]].join(" ");
    const tsxSource = `/** ${proseTerms} */\n// ${proseTerms}\nconst View = () => <span>safe</span>;`;
    const tsxProse = sourceCodeOnly(tsxSource, "fixture.tsx");
    expect(tsxProse).toHaveLength(tsxSource.length);
    expect([...tsxProse.matchAll(/\n/gu)].map(({ index }) => index))
      .toEqual([...tsxSource.matchAll(/\n/gu)].map(({ index }) => index));
    expect(tsxProse).not.toMatch(new RegExp(`\\b${term}`, "i"));
    expect(tsxProse).not.toContain(PROTOCOL_NAME);
    expect(tsxProse).not.toMatch(EMOJI_RE);
    expect(tsxProse).not.toContain(DESIGN_SYSTEM_REFS[0]);

    const tsxCode = sourceCodeOnly(
      `/** safe */\nconst View = () => <span>${term}</span>;`,
      "fixture.tsx",
    );
    expect(tsxCode).toMatch(new RegExp(`\\b${term}`, "i"));

    const cssSource = `/* ${proseTerms} */\n.label { content: "safe"; }`;
    const cssProse = sourceCodeOnly(cssSource, "fixture.css");
    expect(cssProse).toHaveLength(cssSource.length);
    expect([...cssProse.matchAll(/\n/gu)].map(({ index }) => index))
      .toEqual([...cssSource.matchAll(/\n/gu)].map(({ index }) => index));
    expect(cssProse).not.toMatch(new RegExp(`\\b${term}`, "i"));
    expect(cssProse).not.toContain(PROTOCOL_NAME);
    expect(cssProse).not.toMatch(EMOJI_RE);
    expect(cssProse).not.toContain(DESIGN_SYSTEM_REFS[0]);

    const cssValue = `https://example.test/*${term}*/`;
    const cssCode = sourceCodeOnly(`/* safe */\n.label { content: ${JSON.stringify(cssValue)}; }`, "fixture.css");
    expect(cssCode).toContain(JSON.stringify(cssValue));
    expect(cssCode).toMatch(new RegExp(`\\b${term}`, "i"));
  });

  test("no banned lexicon term appears in any source file", () => {
    for (const file of files) {
      const text = sourceCodeOnly(readFileSync(file, "utf8"), file);
      for (const term of BANNED_LEXICON) {
        const pattern = new RegExp(`\\b${term}`, "i");
        expect(text, `${file} contains a banned lexicon term`).not.toMatch(pattern);
      }
    }
  });

  test("no source file names the protocol as product identity", () => {
    // Case-sensitive on purpose: a lowercase package-specifier fragment (e.g. the
    // "@<protocol>-network/..." scope) is infrastructure plumbing, not identity;
    // the capitalized word is what a reader sees. This package has no such
    // dependency at all yet, so no file should match either form.
    const pattern = new RegExp(`\\b${PROTOCOL_NAME}\\b`);
    for (const file of files) {
      const text = sourceCodeOnly(readFileSync(file, "utf8"), file);
      expect(text, `${file} names the protocol brand`).not.toMatch(pattern);
    }
  });

  test("no emoji in any source file", () => {
    for (const file of files) {
      const text = sourceCodeOnly(readFileSync(file, "utf8"), file);
      expect(text, `${file} contains an emoji`).not.toMatch(EMOJI_RE);
    }
  });

  test("no file references the protocol's design system", () => {
    for (const file of files) {
      const text = sourceCodeOnly(readFileSync(file, "utf8"), file);
      for (const term of DESIGN_SYSTEM_REFS) {
        expect(text, `${file} references the protocol design system`).not.toContain(term);
      }
    }
  });
});

describe("branding drift pin", () => {
  test("the web identity is the public core branding object", () => {
    expect(PRODUCT_BRANDING).toEqual({
      displayName: "Colophon",
      categoryDescriptor: "Benchmark publishing for agent configurations",
      tagline: "Compare agents on the same work.",
      promise: "Publish benchmark claims people can check.",
      attribution: EXPECTED_ATTRIBUTION,
      commandName: "colophon",
    });
  });
});
