import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const sourceRoot = new URL("./", import.meta.url).pathname;

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = join(directory, item.name);
    if (item.isDirectory()) return productionFiles(path);
    if (!item.name.endsWith(".ts") || item.name.endsWith(".test.ts")) return [];
    if (item.name === "fixtures.ts" || item.name === "testing.ts") return [];
    return [path];
  });
}

type Finding = readonly [kind: string, detail: string];

const AMBIENT_ROOTS = new Set([
  "process", "globalThis", "global", "window", "self", "Function", "eval", "require",
  "fetch", "WebSocket", "EventSource", "XMLHttpRequest",
]);
const TRANSPORT_MODULES = new Set([
  "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "node:http2",
  "undici", "axios", "node-fetch", "got", "superagent", "ws",
]);

function textOf(name: ts.Identifier | ts.PrivateIdentifier): string {
  // escapedText is TypeScript's parser-normalized identifier spelling. In particular,
  // `pro\\u0063ess` arrives here as `process`, which is why this guard is AST based.
  return String(name.escapedText);
}

function staticString(expression: ts.Expression, constants: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) return constants.get(textOf(expression));
  if (ts.isParenthesizedExpression(expression)) return staticString(expression.expression, constants);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(expression.left, constants);
    const right = staticString(expression.right, constants);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function stringConstants(source: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const value = staticString(node.initializer, constants);
      if (value !== undefined) constants.set(textOf(node.name), value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return constants;
}

function propertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, constants: ReadonlyMap<string, string>): string | undefined {
  return ts.isPropertyAccessExpression(node)
    ? textOf(node.name)
    : node.argumentExpression === undefined ? undefined : staticString(node.argumentExpression, constants);
}

function isReflectOwnKeysBase(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) && parent.expression === node && textOf(parent.name) === "ownKeys";
}

/**
 * A source-maintainability gate, deliberately not a sandbox. It parses TypeScript rather than
 * matching spellings, rejects direct ambient/evaluator authority, and admits one named static
 * `createServer` import. The Linux network-denied runtime proof is the actual egress boundary.
 */
function capabilityFindings(sourceText: string, fileName = "candidate.ts"): Finding[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const constants = stringConstants(source);
  const findings: Finding[] = [];
  const add = (kind: string, detail: string): void => { findings.push([kind, detail]); };

  for (const diagnostic of (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []) {
    add("parse", ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
        const value = specifier.text;
        const permittedHttp = value === "node:http" && fileName.endsWith("/service.ts")
          && ts.isImportDeclaration(node)
          && node.importClause?.name === undefined
          && node.importClause?.namedBindings !== undefined
          && ts.isNamedImports(node.importClause.namedBindings)
          && node.importClause.namedBindings.elements.length === 1
          && textOf(node.importClause.namedBindings.elements[0]!.name) === "createServer"
          && node.importClause.namedBindings.elements[0]!.propertyName === undefined;
        if (value.startsWith("node:") && !permittedHttp) add("module", value);
        if (TRANSPORT_MODULES.has(value)) add("transport", value);
      }
    }
    if (ts.isImportEqualsDeclaration(node)) add("module", "import equals");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add("module", "dynamic import");
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && textOf(node.expression.expression) === "Object"
      && (textOf(node.expression.name) === "getOwnPropertyDescriptor" || textOf(node.expression.name) === "getPrototypeOf")
      && node.arguments.some((argument) => staticString(argument, constants) === "constructor")) {
      add("evaluator", "constructor");
    }
    if (ts.isIdentifier(node)) {
      const name = textOf(node);
      if (AMBIENT_ROOTS.has(name)) { add("ambient", name); }
      if (name === "Reflect" && !isReflectOwnKeysBase(node)) { add("reflection", "Reflect"); }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node, constants);
      if (name === "constructor" || name === "__proto__") add("evaluator", name);
      if (name === "prototype" && (!ts.isIdentifier(node.expression)
        || !["Object", "Array", "String", "Number", "Boolean"].includes(textOf(node.expression)))) {
        add("evaluator", name);
      }
      if (ts.isIdentifier(node.expression) && textOf(node.expression) === "Reflect" && name !== "ownKeys") {
        add("reflection", `Reflect.${name ?? "dynamic"}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

const files = productionFiles(sourceRoot);
const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

describe("the replay service has a closed execution profile", () => {
  test("keeps a non-empty production surface under the AST policy", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("admits only the named static createServer import in service.ts", () => {
    const findings = [...sources.entries()].flatMap(([file, source]) => capabilityFindings(source, file));
    expect(findings).toEqual([]);
  });

  test("normalizes escapes and refuses direct, dynamic, and reflective capability recovery", () => {
    const cases = [
      'const p = pro\\u0063ess.getBuiltinModule("node:http");',
      'await fetch("https://example.test");',
      'const client = await import("node:https");',
      'const load = require("node:net");',
      'const key = "con" + "structor"; createServer[key]("return process")();',
      'const reflect = Reflect; const get = reflect["g" + "et"]; get(createServer, "constructor");',
      'const descriptor = Object.getOwnPropertyDescriptor(createServer, "constructor");',
      'import { request } from "node:http";',
      'import * as http from "node:http";',
    ];
    for (const source of cases) {
      expect(capabilityFindings(source, "/candidate.ts").length, source).toBeGreaterThan(0);
    }
  });

  test("preserves the narrow production operations used by sealed replay", () => {
    const permitted = [
      'const frozen = Object.freeze({ value: 1 });',
      'for (const key of Reflect.ownKeys(frozen)) { Object.entries({ key }); }',
      'const values = ["a"]; const value = values[0];',
      'import { createServer } from "node:http";',
    ].join("\n");
    expect(capabilityFindings(permitted, "/service.ts")).toEqual([]);
  });
});
