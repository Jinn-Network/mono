// SPDX-License-Identifier: Apache-2.0

/**
 * Issues #5299 and #5373: every refusal line the reader can print, read from source.
 *
 * The characterization suite reaches a refusal only when one of its bundles provokes it, so the
 * glossary conformance test, reading that suite's pins, saw a few dozen of the several hundred
 * refusal lines the reader can print. This reads the source instead. It starts at `runVerifierCli`
 * in `cli.ts` and follows every function, class and constant the reachable code calls or names,
 * through this package's `src/` (tests and `testing/` excluded) and into the source of each
 * `@jinn-network/*` platform package it imports (#5373): an import resolves to the package's built
 * declaration, and the walk reads the module that declaration was built from. In that code it
 * collects each place that throws with a message:
 *
 * - `refuse(code, path, message)` from `profile/errors.ts`;
 * - `new Error(message)`, and `TypeError`, `RangeError`, `SyntaxError`;
 * - `new` of an error class this package or a platform package declares, read through its
 *   constructor's `super(...)`;
 * - a call to a function that forwards its own parameters, or one property of one
 *   (`${source.label}`), into any of these, filled with what the caller passes.
 *
 * A message is read as a template: its fixed text, with each value it interpolates as a hole,
 * written `${source}`. A `const` bound to a string expression is read through, so a path the module
 * builds once (`resolutions.${index}`) reaches the template as built.
 *
 * A call to a function that returns a string built from its parameters reads as that string
 * (`reasonFor({ code, message })`), case by case where a `switch` picks the string by `code`.
 *
 * Then each message is followed to where it ends, as an exception travels: up from its throw site
 * to the innermost `try` around it, or out of its function to every place that calls it. A place
 * that calls is a call (`f()`, `obj.f()`, `TABLE[id].f()`), a callback passed to a call, or a value
 * bound to a name or listed; a call through an interface type the walked code declares
 * (`method.compute(…)`) calls every implementation stored under that property name. A message that
 * reaches `runVerifierCli`'s own handlers prints. A `catch` clause it lands in decides the rest:
 *
 * - `throw <caught>` sends it on unchanged;
 * - a throw whose message interpolates the caught error is a wrapper: the message goes on inside the
 *   wrapper's text (`binary admission replay failed: …`), with the error's class name in front when
 *   the wrapper interpolates the error itself, as `String(cause)` prints it;
 * - a property the clause returns as data (`{ check, detail: String(cause) }`), directly or through
 *   a function that returns its parameter as one (`invalid(reason)`), carries it to every refusal
 *   that interpolates that property of a call's result (`${verifiedReport.check}:
 *   ${verifiedReport.detail}`) when the call reaches the clause, with the object's other properties
 *   filling the refusal's other holes; an object that only passes the property on
 *   (`detail: comparability.detail`) relays it with its own;
 * - anything else swallows it, and it prints nowhere.
 *
 * The same data channel carries a string reached code writes into such a property without throwing
 * it (`detail: "recomputed results do not match …"`, `issues.push("…")` read as
 * `${validation.issues.join("; ")}`), read as a `data` template. And a refusal that prints a parse
 * failure (`${parsed.error.issues.map(…)}`, `${issue.message}`) prints the issue messages the parsed
 * schema's own code writes (`ctx.addIssue({ message })`, `.refine(fn, message)`), read as `schema`
 * templates, each as one issue at a field (`x: <message>`) and at the record's root
 * (`(root): <message>`).
 *
 * So each template's messages are the lines it reaches the reader as, through every wrapper between
 * it and the reader. A template no path prints is listed apart, as caught. To see one template's
 * path, hop by hop: `REFUSAL_INVENTORY_TRACE=<text of the template>` prints each step to stdout.
 *
 * What it does not read, each of which reaches a line only inside a template's hole: a string a
 * module returns other than as a property of a call's result (the reasons `anchor/check.ts` words), a
 * value a refusal reads by a longer path than `result.property`, and the schema library's own issue
 * text (`Invalid input`). A list a refusal joins (`a; b`) is probed one item at a time. A schema's
 * `.parse()`, which throws its issue messages rather than returning them, is not followed either: a
 * message only such a call throws reaches a line unscanned. The walk lists each such call it reaches
 * instead (`schemaParses`), and the conformance test records each with the guard that keeps it from
 * throwing on a reader's input (#5404).
 */

import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));
/** The repository's `packages/` directory, which holds the source of every `@jinn-network/*` package. */
const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));
const CHECK = fileURLToPath(new URL("../../", import.meta.url));
/** Directories under a package's `src/` that hold tests or test helpers, not code a caller runs. */
const TEST_DIRECTORIES = new Set(["test", "tests", "testing", "__tests__", "fixtures"]);

/** One place reader-reachable code writes a refusal's text. */
export interface RefusalTemplate {
  /**
   * The writing module: relative to this package's `src/` for its own (`verify.ts`), relative to the
   * repository's `packages/` for a platform package's (`benchmarking/aggregate/src/report.ts`).
   */
  readonly module: string;
  /** 1-based line of the site, for a reader of the inventory; not part of its identity. */
  readonly line: number;
  /** The text as the module writes it: its fixed text, each interpolated value as `${source}`. */
  readonly template: string;
  /** Whether the template interpolates a caught error, which makes it a wrapper. */
  readonly wraps: boolean;
  /**
   * `thrown`: the module throws it. `data`: the module returns it as a property of a result.
   * `schema`: a schema's issue message, which a refusal prints when a parse against it fails.
   */
  readonly kind: "thrown" | "data" | "schema";
  /**
   * The messages the reader's refusal line can carry from this site, sorted: the template with each
   * hole filled by a value of the shape its source names (a fingerprint, an index, a word), inside
   * every wrapper it travels through to the reader. Empty for a template no path prints.
   */
  readonly messages: readonly string[];
}

export interface RefusalInventory {
  /** Templates some path prints, sorted by module, then line. One entry per distinct template in a module. */
  readonly templates: readonly RefusalTemplate[];
  /** Templates reachable code writes, but every path catches before a line prints, sorted the same way. */
  readonly caught: readonly RefusalTemplate[];
  /** The modules the walk read, named as `RefusalTemplate.module` names them, sorted. */
  readonly modules: readonly string[];
  /** `@jinn-network/*` imports that did not resolve to their source (an unbuilt package), sorted. */
  readonly unreadImports: readonly string[];
  /**
   * Each `.parse()` of a schema in reached code, or another method that throws as it does
   * (`findSchemaParses`), sorted by module, then line. Such a call throws its issue messages rather
   * than returning them, and the walk does not follow it, so the conformance test records each one
   * with the guard that keeps it from throwing on a reader's input (#5404).
   */
  readonly schemaParses: readonly SchemaParse[];
}

/** One `.parse()` of a schema in reached code, called or handed on as a value. */
export interface SchemaParse {
  /** The calling module, named as `RefusalTemplate.module` names it. */
  readonly module: string;
  /** 1-based line of the call, for a reader of the inventory; not part of its identity. */
  readonly line: number;
  /** The named function the call sits in (`Class.method` for a method), or `(module)` at top level. */
  readonly within: string;
  /** The call as written, or the method alone when it is handed on as a value, whitespace collapsed. */
  readonly call: string;
}

interface ParameterPart {
  readonly owner: ts.FunctionLikeDeclaration;
  readonly param: number;
  /** Set when the message reads one property of the parameter (`source.label`). */
  readonly property?: string;
}
interface HolePart {
  readonly hole: string;
  readonly caught: boolean;
  /** The interpolated expression, when the template was read from one. */
  readonly node?: ts.Expression;
}
type Part = { readonly text: string } | HolePart | ParameterPart;
type Template = readonly Part[];
/** A template, with the name of the error class that throws it (`String(cause)` prints the name). */
interface Thrown {
  readonly name: string;
  readonly template: Template;
}
interface Message {
  readonly text: string;
  readonly name: string;
}

const ERROR_CONSTRUCTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError"]);
/** How the walk compiles what it reads. */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};
/** The most alternatives one message expands to. No site comes close; the cap bounds a mistake. */
const ALTERNATIVES_CAP = 64;
/** How deep a message's expression is read before the rest is taken as a hole. */
const DEPTH_CAP = 8;
/** The most wrappers and data hops one message is followed through. No path comes close. */
const HOPS_CAP = 12;

/** Whether a file is one of this package's own modules: `src/`, tests and `testing/` excluded. */
function isCheckSource(file: string): boolean {
  if (!file.startsWith(SRC) || !file.endsWith(".ts") || file.endsWith(".d.ts")) return false;
  const local = relative(SRC, file);
  return !local.endsWith(".test.ts") && !local.split(sep).includes("testing");
}

/**
 * Whether a file is the source of a `@jinn-network/*` platform package: a `.ts` file under a
 * package's `src/` in this repository, tests and test helpers excluded.
 */
function isPlatformSource(file: string): boolean {
  if (!file.startsWith(PACKAGES) || file.startsWith(CHECK) || !file.endsWith(".ts") || file.endsWith(".d.ts")) return false;
  if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) return false;
  const segments = relative(PACKAGES, file).split(sep);
  const src = segments.indexOf("src");
  return src > 0 && !segments.slice(src + 1, -1).some((segment) => TEST_DIRECTORIES.has(segment));
}

function inScope(file: string): boolean {
  return isCheckSource(file) || isPlatformSource(file);
}

function modulePath(node: ts.Node): string {
  const file = node.getSourceFile().fileName;
  return relative(isCheckSource(file) ? SRC : PACKAGES, file).split(sep).join("/");
}

/** Whether an inventory module is a platform package's, by the name `RefusalTemplate.module` gives it. */
export function isPlatformModule(module: string): boolean {
  return module.includes("/src/");
}

/**
 * A platform package resolves, through its `exports`, to the declaration its build wrote
 * (`<package>/dist/<path>.d.ts`). The walk reads the module that declaration was built from
 * (`<package>/src/<path>.ts`), so it sees the messages the package throws, not only their types.
 */
function sourceOfPlatformDeclaration(file: string): string | undefined {
  if (!file.startsWith(PACKAGES) || !file.endsWith(".d.ts")) return undefined;
  const segments = file.split(sep);
  const dist = segments.lastIndexOf("dist");
  if (dist < 0) return undefined;
  const source = [...segments.slice(0, dist), "src", ...segments.slice(dist + 1)].join(sep).replace(/\.d\.ts$/u, ".ts");
  return existsSync(source) && isPlatformSource(source) ? source : undefined;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

/** A callable a caller reaches by name: a function declaration, a method, or a `const` bound to a
 * function expression. Only these forward their parameters into a message. */
function isNamedCallable(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name !== undefined;
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent) && node.parent.initializer === node;
}

function isParameterPart(part: Part): part is ParameterPart {
  return "param" in part;
}

function isHolePart(part: Part): part is HolePart {
  return "hole" in part;
}

function isStringExpression(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return isStringExpression(expression.expression);
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isTemplateExpression(expression)) return true;
  if (ts.isConditionalExpression(expression)) return isStringExpression(expression.whenTrue) && isStringExpression(expression.whenFalse);
  return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    && (isStringExpression(expression.left) || isStringExpression(expression.right));
}

function concat(left: readonly Template[], right: readonly Template[]): Template[] {
  const out: Template[] = [];
  for (const a of left) for (const b of right) if (out.length < ALTERNATIVES_CAP) out.push([...a, ...b]);
  return out;
}

function sourceOf(node: ts.Node): string {
  return node.getText().replace(/\s+/gu, " ");
}

function parameterText(part: ParameterPart): string {
  const name = part.owner.parameters[part.param]?.name.getText() ?? "?";
  return part.property === undefined ? name : `${name}.${part.property}`;
}

function partKey(part: Part): string {
  if ("text" in part) return `t:${part.text}`;
  if (isHolePart(part)) return `h:${part.caught}:${part.hole}`;
  return `p:${part.param}:${part.property ?? ""}`;
}

function templateText(template: Template): string {
  return template.map((part) => ("text" in part ? part.text : isHolePart(part) ? `\${${part.hole}}` : `\${${parameterText(part)}}`)).join("");
}

/**
 * A value of the shape a hole's source names, so a wording rule that captures a fingerprint or an
 * index sees one: a run's `<task fingerprint>/<configuration>/<repeat>` for a `cellKey`, 64 hex
 * digits for a digest, `0` for an index or a count, a word otherwise.
 */
function holeValue(source: string): string {
  if (/cellKey/u.test(source)) return `${"a".repeat(64)}/x/1`;
  if (/sha256|digest|hex\b|identity\b/iu.test(source)) return "a".repeat(64);
  if (/index|Index|count|Count|length|height|\b[ijn]\b/u.test(source)) return "0";
  return "x";
}

/**
 * The caught error as a hole prints it: its message, or, when the hole interpolates the error itself
 * (`String(cause)`, `${cause}`), `<class name>: <message>`, as `Error.prototype.toString` writes it.
 */
function caughtText(source: string, message: Message): string {
  if (/\.message\b/u.test(source) || /^describeError\(/u.test(source)) return message.text;
  return /^(?:String\(\s*[\w$]+\s*\)|[\w$]+)$/u.test(source) ? `${message.name}: ${message.text}` : message.text;
}

/** A template as printed: each caught hole holds `message`, every other hole a value of its shape. */
function fill(template: Template, message: Message | undefined): string {
  return template.map((part) => {
    if ("text" in part) return part.text;
    if (isHolePart(part)) return part.caught && message !== undefined ? caughtText(part.hole, message) : holeValue(part.hole);
    return "x";
  }).join("");
}

/** `x as T`, `(x)`, `x!`, `await x`: the expression they wrap. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isAwaitExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether an identifier marks a place what it names can throw: it is called (`f()`, `obj.f()`,
 * `new C()`), it roots an access chain that is called (`TABLE[id].compute(…)`), it is passed to a
 * call that can call it (`items.map(f)`), or it is the class a class `extends`. A name stored as a
 * value (`{ resolve: f }`, `return f`), tested (`instanceof C`) or used as a type is not: what it
 * names throws where the value is later called, if anywhere this walk can see.
 */
function isInvocation(identifier: ts.Identifier): boolean {
  let node: ts.Node = identifier;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) node = node.parent;
  for (;;) {
    const up = node.parent;
    if ((ts.isPropertyAccessExpression(up) && up.expression === node) || (ts.isElementAccessExpression(up) && up.expression === node)
      || ts.isNonNullExpression(up) || ts.isParenthesizedExpression(up) || ts.isAsExpression(up) || ts.isAwaitExpression(up)
      || ts.isSatisfiesExpression(up) || (ts.isConditionalExpression(up) && up.condition !== node)
      || (ts.isBinaryExpression(up) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]
        .includes(up.operatorToken.kind))) {
      node = up;
      continue;
    }
    break;
  }
  const parent = node.parent;
  // Bound to a name or listed: called where that name or list is, which this walk takes as here.
  if ((ts.isVariableDeclaration(parent) && parent.initializer === node) || ts.isArrayLiteralExpression(parent)) return true;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && (parent.arguments ?? []).some((arg) => arg === node)) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return true;
  return ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)
    && parent.parent.token === ts.SyntaxKind.ExtendsKeyword;
}

/** Every refusal line `runVerifierCli` can print, read from the source of the code it reaches. */
export function refusalTemplateInventory(): RefusalInventory {
  const entry = resolve(SRC, "cli.ts");
  const options = COMPILER_OPTIONS;
  const host = ts.createCompilerHost(options, true);
  /** `@jinn-network/*` imports that resolved to no platform source, which would end the walk silently. */
  const unread = new Set<string>();
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, sourceFile) => literals.map((literal) => {
    const mode = ts.getModeForUsageLocation(sourceFile, literal, compilerOptions);
    const { resolvedModule } = ts.resolveModuleName(literal.text, containingFile, compilerOptions, host, undefined, redirected, mode);
    if (!literal.text.startsWith("@jinn-network/") || !inScope(containingFile)) return { resolvedModule };
    const source = resolvedModule === undefined ? undefined : sourceOfPlatformDeclaration(resolvedModule.resolvedFileName);
    if (source === undefined) {
      unread.add(`${literal.text} from ${relative(PACKAGES, containingFile).split(sep).join("/")}`);
      return { resolvedModule };
    }
    return { resolvedModule: { ...resolvedModule, resolvedFileName: source, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
  });
  const program = ts.createProgram({ rootNames: [entry], options, host });
  const checker = program.getTypeChecker();
  const cli = program.getSourceFile(entry);
  const runVerifierCli = cli?.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "runVerifierCli");
  if (runVerifierCli === undefined) throw new Error("refusal inventory: runVerifierCli is gone from cli.ts");

  /** The in-scope declarations an identifier names, through an import. */
  const declarationsOf = (node: ts.Node): ts.Declaration[] => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined) return [];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    return (symbol.declarations ?? []).filter((declaration) => inScope(declaration.getSourceFile().fileName));
  };

  // ── Reachable code ───────────────────────────────────────────────────────────────────────────
  // A unit is a function-like declaration, a class, a variable bound to a function, or a module-level
  // variable's initializer (an object of ports, a table of handlers). A unit reaches every unit an
  // identifier inside it names, called or not, so a function passed as a value or returned in an
  // object is reached too. A local variable's other initializers are not units: they run where they
  // are declared, inside a unit already read, not where they are named.
  const unitOf = (declaration: ts.Declaration): ts.Node | undefined => {
    if (isFunctionLike(declaration) || ts.isClassDeclaration(declaration)) return declaration;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
    const initializer = declaration.initializer;
    if (isFunctionLike(initializer)) return initializer;
    return ts.isSourceFile(declaration.parent.parent.parent) ? initializer : undefined;
  };
  const named = (root: ts.Node): ts.Node[] => {
    const found: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        for (const declaration of declarationsOf(node)) {
          const unit = unitOf(declaration);
          if (unit !== undefined && unit !== root) found.push(unit);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return found;
  };
  const edges = new Map<ts.Node, readonly ts.Node[]>();
  const reach = (seeds: Iterable<ts.Node>): Set<ts.Node> => {
    const seen = new Set<ts.Node>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const unit = queue.pop()!;
      if (seen.has(unit)) continue;
      seen.add(unit);
      let next = edges.get(unit);
      if (next === undefined) edges.set(unit, next = named(unit));
      queue.push(...next);
    }
    return seen;
  };
  const reachable = reach([runVerifierCli]);
  const enclosingUnit = (node: ts.Node): ts.Node | undefined => {
    for (let current = node.parent; current !== undefined; current = current.parent) if (reachable.has(current)) return current;
    return undefined;
  };

  // ── Messages, as templates ───────────────────────────────────────────────────────────────────
  const parameterOf = (identifier: ts.Identifier): { owner: ts.FunctionLikeDeclaration; param: number } | undefined => {
    const [declaration] = declarationsOf(identifier);
    if (declaration === undefined || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
    const owner = declaration.parent;
    return isFunctionLike(owner) ? { owner, param: owner.parameters.indexOf(declaration) } : undefined;
  };
  /** Whether an expression reads the error a `catch` clause caught (`clause`, or any when omitted),
   * directly or through a `const`. */
  const readsCaught = (expression: ts.Node, clause?: ts.CatchClause, depth = 0): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node)) {
        const [declaration] = declarationsOf(node);
        if (declaration !== undefined && ts.isVariableDeclaration(declaration)) {
          if (ts.isCatchClause(declaration.parent)) found = clause === undefined || declaration.parent === clause;
          else if (depth < DEPTH_CAP && declaration.initializer !== undefined
            && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) {
            found = readsCaught(declaration.initializer, clause, depth + 1);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };

  const render = (expression: ts.Expression, depth = 0): Template[] => {
    if (depth > DEPTH_CAP) return [[{ hole: sourceOf(expression), caught: false, node: expression }]];
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      return render(expression.expression, depth);
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [[{ text: expression.text }]];
    if (ts.isTemplateExpression(expression)) {
      let out: Template[] = [[{ text: expression.head.text }]];
      for (const span of expression.templateSpans) {
        out = concat(concat(out, render(span.expression, depth + 1)), [[{ text: span.literal.text }]]);
      }
      return out;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return concat(render(expression.left, depth + 1), render(expression.right, depth + 1));
    }
    // A call to a function that returns a string built from its parameters reads as that string.
    if (ts.isCallExpression(expression)) {
      const returned = returnedTemplates(expression, depth);
      if (returned !== undefined) return returned;
    }
    // `cause instanceof Error ? cause.message : String(cause)` is one hole: what a caught error prints.
    if (readsCaught(expression) && !ts.isTemplateExpression(expression) && !ts.isBinaryExpression(expression)) {
      return [[{ hole: sourceOf(expression), caught: true, node: expression }]];
    }
    if (ts.isConditionalExpression(expression)) {
      return [...render(expression.whenTrue, depth + 1), ...render(expression.whenFalse, depth + 1)].slice(0, ALTERNATIVES_CAP);
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const parameter = parameterOf(expression.expression);
      if (parameter !== undefined) return [[{ ...parameter, property: expression.name.text }]];
    }
    if (ts.isIdentifier(expression)) {
      const parameter = parameterOf(expression);
      if (parameter !== undefined) return [[parameter]];
      const [declaration] = declarationsOf(expression);
      if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
        && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 && isStringExpression(declaration.initializer)) {
        return render(declaration.initializer, depth + 1);
      }
    }
    return [[{ hole: sourceOf(expression), caught: false, node: expression }]];
  };

  /**
   * The strings a function returns, each in terms of its parameters, for a call that passes `args`:
   * `defaultReason({ code: "not-anchor-evidence", message })` reads as the case it returns for that
   * code. Only a function every return of which is a string with words of its own, so a helper that
   * returns its argument's message (`describeError`) stays the hole it is.
   */
  function returnedTemplates(call: ts.CallExpression, depth: number): Template[] | undefined {
    if (depth >= DEPTH_CAP) return undefined;
    const callee = call.expression;
    const code = call.arguments.flatMap((arg) => (ts.isObjectLiteralExpression(arg) ? arg.properties : []))
      .find((element): element is ts.PropertyAssignment => ts.isPropertyAssignment(element) && element.name.getText() === "code");
    const codeText = code !== undefined && ts.isStringLiteralLike(code.initializer) ? code.initializer.text : undefined;
    for (const declaration of declarationsOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee)) {
      const unit = unitOf(declaration);
      if (unit === undefined || !isFunctionLike(unit) || unit.body === undefined) continue;
      const returns: { readonly expression: ts.Expression; readonly label?: string }[] = [];
      let strings = true;
      const collect = (expression: ts.Expression, label?: string): void => {
        const value = unwrap(expression);
        if (ts.isIdentifier(value) && value.text === "undefined") return;
        if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          collect(value.left, label);
          collect(value.right, label);
          return;
        }
        if (!isStringExpression(value) && !ts.isCallExpression(value)) strings = false;
        else returns.push({ expression: value, ...(label === undefined ? {} : { label }) });
      };
      if (!ts.isBlock(unit.body)) collect(unit.body);
      else {
        const visit = (node: ts.Node): void => {
          if (isFunctionLike(node)) return;
          if (ts.isReturnStatement(node) && node.expression !== undefined) {
            let label: string | undefined;
            for (let current: ts.Node = node.parent; current !== unit; current = current.parent) {
              if (ts.isCaseClause(current) && ts.isStringLiteralLike(current.expression)) {
                label = current.expression.text;
                break;
              }
            }
            collect(node.expression, label);
          }
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(unit.body, visit);
      }
      if (!strings || returns.length === 0) continue;
      const templates = returns
        .filter(({ label }) => label === undefined || codeText === undefined || label === codeText)
        .flatMap(({ expression }) => render(expression, depth + 1))
        .filter((template) => template.some((part) => "text" in part && part.text.trim() !== ""));
      if (templates.length === 0) continue;
      return substitute(templates.map((template) => ({ name: "Error", template })), unit, call.arguments)
        .map(({ template }) => template);
    }
    return undefined;
  }

  /** `arg.property`, read from an object literal a caller passes, through a parameter, or as a hole. */
  const renderProperty = (arg: ts.Expression, property: string): Template[] => {
    if (ts.isObjectLiteralExpression(arg)) {
      for (const element of arg.properties) {
        if (ts.isPropertyAssignment(element) && element.name.getText() === property) return render(element.initializer);
      }
    }
    if (ts.isIdentifier(arg)) {
      const parameter = parameterOf(arg);
      if (parameter !== undefined) return [[{ ...parameter, property }]];
    }
    return [[{ hole: `${sourceOf(arg)}.${property}`, caught: false }]];
  };

  /** A callable's templates, in terms of its own parameters, filled with what a call passes. */
  const substitute = (thrown: readonly Thrown[], owner: ts.FunctionLikeDeclaration, args: readonly ts.Expression[]): Thrown[] => {
    const out: Thrown[] = [];
    for (const { name, template } of thrown) {
      let alternatives: Template[] = [[]];
      for (const part of template) {
        if (!isParameterPart(part) || part.owner !== owner) {
          alternatives = concat(alternatives, [[part]]);
          continue;
        }
        const arg = args[part.param];
        alternatives = concat(alternatives, arg === undefined
          ? [[{ hole: parameterText(part), caught: false }]]
          : part.property === undefined ? render(arg) : renderProperty(arg, part.property));
      }
      out.push(...alternatives.map((alternative) => ({ name, template: alternative })));
    }
    return out.slice(0, ALTERNATIVES_CAP);
  };

  // ── What throws with a message ───────────────────────────────────────────────────────────────
  /** Callables that forward their parameters into a message, by the templates they throw. */
  const forwarders = new Map<ts.FunctionLikeDeclaration, Thrown[]>();

  /** The `name` an error class's instances carry, which `String(error)` prints before the message. */
  const errorNameOf = (declaration: ts.ClassDeclaration, depth = 0): string => {
    for (const member of declaration.members) {
      if (ts.isPropertyDeclaration(member) && member.name.getText() === "name" && member.initializer !== undefined
        && ts.isStringLiteralLike(member.initializer)) return member.initializer.text;
    }
    let assigned: string | undefined;
    const visit = (node: ts.Node): void => {
      if (assigned !== undefined) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword
        && node.left.name.text === "name" && ts.isStringLiteralLike(node.right)) assigned = node.right.text;
      ts.forEachChild(node, visit);
    };
    const constructor = declaration.members.find(ts.isConstructorDeclaration);
    if (constructor?.body !== undefined) visit(constructor.body);
    if (assigned !== undefined) return assigned;
    const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    if (base === undefined) return "Error";
    if (ts.isIdentifier(base) && ERROR_CONSTRUCTORS.has(base.text) && declarationsOf(base).length === 0) return base.text;
    const [baseDeclaration] = declarationsOf(base);
    return baseDeclaration !== undefined && ts.isClassDeclaration(baseDeclaration) && depth < DEPTH_CAP
      ? errorNameOf(baseDeclaration, depth + 1)
      : "Error";
  };

  /** An error class's message: its constructor's `super(...)` argument, or its base class's. */
  const classMessage = (declaration: ts.ClassDeclaration, args: readonly ts.Expression[], name = errorNameOf(declaration)): Thrown[] | undefined => {
    const constructor = declaration.members.find(ts.isConstructorDeclaration);
    if (constructor === undefined) {
      const base = declaration.heritageClauses?.[0]?.types[0]?.expression;
      if (base === undefined) return undefined;
      if (ts.isIdentifier(base) && ERROR_CONSTRUCTORS.has(base.text) && declarationsOf(base).length === 0) {
        return args[0] === undefined ? undefined : render(args[0]).map((template) => ({ name, template }));
      }
      const [baseDeclaration] = declarationsOf(base);
      return baseDeclaration !== undefined && ts.isClassDeclaration(baseDeclaration) ? classMessage(baseDeclaration, args, name) : undefined;
    }
    let message: Template[] | undefined;
    const visit = (node: ts.Node): void => {
      if (message !== undefined) return;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && node.arguments[0] !== undefined) {
        message = render(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    if (constructor.body !== undefined) visit(constructor.body);
    return message === undefined ? undefined : substitute(message.map((template) => ({ name, template })), constructor, args);
  };

  /** The error class `refuse` throws, by name. */
  const refuseName = (declaration: ts.FunctionDeclaration): string => {
    let name = "Error";
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const [target] = declarationsOf(node.expression);
        if (target !== undefined && ts.isClassDeclaration(target)) name = errorNameOf(target);
      }
      ts.forEachChild(node, visit);
    };
    if (declaration.body !== undefined) visit(declaration.body);
    return name;
  };

  /** The templates a call or `new` throws with, or undefined when it throws none. */
  const sinkMessage = (node: ts.CallExpression | ts.NewExpression): Thrown[] | undefined => {
    const args = node.arguments ?? [];
    const callee = node.expression;
    if (ts.isNewExpression(node) && ts.isIdentifier(callee) && ERROR_CONSTRUCTORS.has(callee.text) && declarationsOf(callee).length === 0) {
      return args[0] === undefined ? undefined : render(args[0]).map((template) => ({ name: callee.text, template }));
    }
    for (const declaration of declarationsOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee)) {
      if (ts.isFunctionDeclaration(declaration) && declaration.name?.text === "refuse" && modulePath(declaration) === "profile/errors.ts") {
        const name = refuseName(declaration);
        return args[2] === undefined ? undefined : render(args[2]).map((template) => ({ name, template }));
      }
      if (ts.isNewExpression(node) && ts.isClassDeclaration(declaration)) {
        const message = classMessage(declaration, args);
        if (message !== undefined) return message;
      }
      const unit = unitOf(declaration);
      const forwarded = unit !== undefined && isFunctionLike(unit) ? forwarders.get(unit) : undefined;
      if (forwarded !== undefined) return substitute(forwarded, unit as ts.FunctionLikeDeclaration, args);
    }
    return undefined;
  };

  interface Site {
    readonly node: ts.CallExpression | ts.NewExpression;
    readonly thrown: readonly Thrown[];
  }
  const collectSites = (): Site[] => {
    const sites: Site[] = [];
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !seen.has(node)) {
        seen.add(node);
        const thrown = sinkMessage(node);
        if (thrown !== undefined) sites.push({ node, thrown });
      }
      ts.forEachChild(node, visit);
    };
    for (const unit of reachable) visit(unit);
    return sites;
  };
  /** The named callable a template still forwards for, if any. */
  const forwardingOwner = (template: Template): ts.FunctionLikeDeclaration | undefined => {
    const owner = template.find(isParameterPart)?.owner;
    return owner !== undefined && isNamedCallable(owner) ? owner : undefined;
  };
  const thrownKey = ({ name, template }: Thrown): string => `${name}\u0000${template.map(partKey).join("\u0000")}`;

  // A forwarder found in one round makes its callers' messages readable in the next, and a caller
  // that forwards in turn is found then. Settles once a round finds nothing new.
  for (let round = 0; ; round += 1) {
    if (round > 20) throw new Error("refusal inventory: forwarding did not settle");
    let changed = false;
    for (const { thrown } of collectSites()) {
      for (const candidate of thrown) {
        const owner = forwardingOwner(candidate.template);
        if (owner === undefined) continue;
        const known = forwarders.get(owner) ?? [];
        if (known.some((existing) => thrownKey(existing) === thrownKey(candidate))) continue;
        forwarders.set(owner, [...known, candidate]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const sites = collectSites();
  const siteOf = new Map<ts.Node, Site>(sites.map((site) => [site.node, site]));

  // ── Where a message goes ─────────────────────────────────────────────────────────────────────
  // A call through an interface type the walked packages declare (`method.compute(…)`,
  // `verifier.verifyProof(…)`) can run any implementation stored under that property name, so each
  // implementation in reachable code is a unit of its own, called from every such call.
  const implementations = new Map<string, ts.Node[]>();
  const implement = (name: string, unit: ts.Node): void => {
    const list = implementations.get(name) ?? [];
    if (!list.includes(unit)) list.push(unit);
    implementations.set(name, list);
  };
  for (const unit of [...reachable]) {
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && (ts.isObjectLiteralExpression(node.parent) || ts.isClassLike(node.parent)) && node.body !== undefined) {
        reachable.add(node);
        implement(node.name.getText(), node);
      } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
        const value = unwrap(node.initializer);
        if (isFunctionLike(value)) {
          reachable.add(value);
          implement(node.name.getText(), value);
        } else if (ts.isIdentifier(value)) {
          for (const declaration of declarationsOf(value)) {
            const target = unitOf(declaration);
            if (target !== undefined && reachable.has(target)) implement(node.name.getText(), target);
          }
        }
      } else if (ts.isShorthandPropertyAssignment(node)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(node);
        for (const declaration of (symbol?.declarations ?? []).filter((candidate) => inScope(candidate.getSourceFile().fileName))) {
          const target = unitOf(declaration);
          if (target !== undefined && reachable.has(target)) implement(node.name.text, target);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
  }

  /** Every place each reachable unit can throw from, in the innermost unit it sits in (`isInvocation`). */
  const callers = new Map<ts.Node, ts.Identifier[]>();
  const call = (target: ts.Node, at: ts.Identifier): void => {
    const list = callers.get(target) ?? [];
    if (!list.includes(at)) list.push(at);
    callers.set(target, list);
  };
  for (const unit of reachable) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && enclosingUnit(node) === unit && isInvocation(node)) {
        for (const declaration of declarationsOf(node)) {
          const target = unitOf(declaration);
          if (target !== undefined && reachable.has(target)) call(target, node);
          else if (ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)) {
            for (const implementation of implementations.get(node.text) ?? []) call(implementation, node);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
  }

  interface Origin {
    readonly key: string;
    readonly module: string;
    readonly line: number;
    readonly template: string;
    readonly wraps: boolean;
    readonly kind: "thrown" | "data" | "schema";
  }
  const origins = new Map<string, Origin>();
  const printed = new Map<string, Set<string>>();
  const originOf = (node: ts.Node, template: Template, kind: Origin["kind"]): Origin => {
    const module = modulePath(node);
    const text = templateText(template);
    const key = `${module}\u0000${text}`;
    let origin = origins.get(key);
    if (origin === undefined) {
      origin = {
        key,
        module,
        line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
        template: text,
        wraps: template.some((part) => isHolePart(part) && part.caught),
        kind,
      };
      origins.set(key, origin);
      printed.set(key, new Set());
    }
    return origin;
  };

  /** A message one `catch` clause turned into a property of what its function returns, or a string
   * code writes into such a property itself. */
  interface Product {
    readonly property: string;
    /** The object literal the property sits in, whose other properties fill a consumer's other holes. */
    readonly object?: ts.ObjectLiteralExpression;
    /** Where the property is written, to decide which calls' results can carry it. */
    readonly at: ts.Node;
    readonly text: string;
    /** The template it carries; a written string's own is made one only when a refusal prints it. */
    readonly origin: Origin | (() => Origin);
  }
  const products: Product[] = [];
  const productKeys = new Set<string>();
  const addProduct = (product: Product): void => {
    const origin = typeof product.origin === "function" ? product.at.pos : product.origin.key;
    const key = `${origin}\u0000${product.property}\u0000${product.text}\u0000${product.at.pos}\u0000${product.at.getSourceFile().fileName}`;
    if (productKeys.has(key)) return;
    productKeys.add(key);
    products.push(product);
  };

  /**
   * Functions that return a parameter as a property (`invalid(reason) => ({ status, reason })`), by
   * the property each parameter becomes. A clause that calls one with the caught error returns it.
   */
  const dataForwarders = new Map<ts.FunctionLikeDeclaration, { readonly param: number; readonly property: string; readonly at: ts.Node }[]>();
  for (const unit of reachable) {
    const visit = (node: ts.Node): void => {
      const element = ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) ? node : undefined;
      if (element !== undefined) {
        let parameter: { owner: ts.FunctionLikeDeclaration; param: number } | undefined;
        if (ts.isPropertyAssignment(element)) {
          const value = unwrap(element.initializer);
          parameter = ts.isIdentifier(value) ? parameterOf(value) : undefined;
        } else {
          // `{ reason }`: the name is the property; the value is what the shorthand names.
          const declaration = checker.getShorthandAssignmentValueSymbol(element)?.declarations?.[0];
          if (declaration !== undefined && ts.isParameter(declaration) && isFunctionLike(declaration.parent)) {
            parameter = { owner: declaration.parent, param: declaration.parent.parameters.indexOf(declaration) };
          }
        }
        if (parameter !== undefined && isNamedCallable(parameter.owner)) {
          const list = dataForwarders.get(parameter.owner) ?? [];
          list.push({ param: parameter.param, property: element.name.getText(), at: element });
          dataForwarders.set(parameter.owner, list);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
  }
  const dataForwardsOf = (call: ts.CallExpression): readonly { param: number; property: string; at: ts.Node }[] => {
    const callee = call.expression;
    for (const declaration of declarationsOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee)) {
      const unit = unitOf(declaration);
      const forwards = unit !== undefined && isFunctionLike(unit) ? dataForwarders.get(unit) : undefined;
      if (forwards !== undefined) return forwards;
    }
    return [];
  };

  /** Where an error thrown at a node is next handled: the innermost enclosing `try`'s `catch`, or
   * the unit it escapes from. */
  const handlers = new Map<ts.Node, ts.CatchClause | ts.Node | undefined>();
  const handlerOf = (node: ts.Node): ts.CatchClause | ts.Node | undefined => {
    if (handlers.has(node)) return handlers.get(node);
    let found: ts.CatchClause | ts.Node | undefined;
    let child: ts.Node = node;
    for (let current = node.parent; current !== undefined; child = current, current = current.parent) {
      if (ts.isTryStatement(current) && child === current.tryBlock && current.catchClause !== undefined) {
        found = current.catchClause;
        break;
      }
      if (reachable.has(current)) {
        found = current;
        break;
      }
    }
    handlers.set(node, found);
    return found;
  };

  const emitted = new Map<ts.Node, Set<string>>();
  const record = (origin: Origin, text: string): void => {
    printed.get(origin.key)!.add(text);
  };

  /** An error carrying `message` is thrown at `node`: follow it to where it prints or ends. */
  const emit = (node: ts.Node, message: Message, origin: Origin, hops: number): void => {
    const key = `${origin.key}\u0000${message.name}\u0000${message.text}`;
    const seen = emitted.get(node) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    emitted.set(node, seen);
    const handler = handlerOf(node);
    const trace = process.env["REFUSAL_INVENTORY_TRACE"];
    if (trace !== undefined && trace !== "" && origin.template.includes(trace)) {
      const where = (at: ts.Node): string => `${modulePath(at)}:${at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1}`;
      const next = handler === undefined ? "nowhere" : ts.isCatchClause(handler) ? `catch at ${where(handler)}` : `out of ${where(handler)}`;
      console.log(`refusal trace: hop ${hops} at ${where(node)}, then ${next}: ${message.text}`);
    }
    if (handler === undefined) return;
    if (ts.isCatchClause(handler)) {
      land(handler, message, origin, hops);
      return;
    }
    // It escapes `runVerifierCli` itself: the CLI's caller prints it whole.
    if (handler === runVerifierCli) {
      record(origin, message.text);
      return;
    }
    for (const caller of callers.get(handler) ?? []) emit(caller, message, origin, hops);
  };

  /** An error carrying `message` lands in `clause`: what the clause does with it. */
  const land = (clause: ts.CatchClause, message: Message, origin: Origin, hops: number): void => {
    // `runVerifierCli`'s handlers print the message they catch, on its own refusal line.
    if (enclosingUnit(clause) === runVerifierCli) {
      record(origin, message.text);
      return;
    }
    if (clause.variableDeclaration === undefined || hops >= HOPS_CAP) return;
    const visit = (node: ts.Node): void => {
      if (ts.isThrowStatement(node) && node.expression !== undefined) {
        const thrown = unwrap(node.expression);
        if (ts.isIdentifier(thrown) && readsCaught(thrown, clause)) emit(node, message, origin, hops + 1);
      }
      const site = siteOf.get(node);
      if (site !== undefined) {
        for (const thrown of site.thrown) {
          if (!thrown.template.some((part) => isHolePart(part) && part.caught && part.node !== undefined && readsCaught(part.node, clause))) continue;
          // A wrapper that also prints a parameter of its own function (`new MethodInputError(code,
          // digest, String(cause))`) carries the caught message on too, the parameter printed as a
          // value of its shape.
          const wrapper = thrown.template.map((part) => (isParameterPart(part) ? { hole: parameterText(part), caught: false } : part));
          emit(site.node, { text: fill(wrapper, message), name: thrown.name }, origin, hops + 1);
        }
      }
      // A returned alternative that does not carry the caught error is another branch's text.
      const carries = (template: Template): boolean => template.some((part) => isHolePart(part) && part.caught);
      if (ts.isPropertyAssignment(node) && readsCaught(node.initializer, clause)) {
        const object = ts.isObjectLiteralExpression(node.parent) ? node.parent : undefined;
        for (const template of render(node.initializer).filter(carries)) {
          addProduct({ property: node.name.getText(), ...(object === undefined ? {} : { object }), at: node, text: fill(template, message), origin });
        }
      }
      if (ts.isCallExpression(node)) {
        for (const forward of dataForwardsOf(node)) {
          const arg = node.arguments[forward.param];
          if (arg === undefined || !readsCaught(arg, clause)) continue;
          for (const template of render(arg).filter(carries)) {
            addProduct({ property: forward.property, at: forward.at, text: fill(template, message), origin });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(clause.block);
  };

  // ── Each template, from where it is thrown ───────────────────────────────────────────────────
  for (const site of sites) {
    for (const thrown of site.thrown) {
      // Reported at each call of the forwarder instead, filled with what it passes.
      if (forwardingOwner(thrown.template) !== undefined) continue;
      const template: Template = thrown.template.map((part) => (isParameterPart(part) ? { hole: parameterText(part), caught: false } : part));
      // Only holes: the message forwards a caught error unchanged, or is an opaque value. Either way
      // it has no words of its own.
      if (template.every(isHolePart)) continue;
      const origin = originOf(site.node, template, "thrown");
      emit(site.node, { text: fill(template, undefined), name: thrown.name }, origin, 0);
    }
  }

  // ── Schema issue messages ────────────────────────────────────────────────────────────────────
  // A refusal that prints a zod parse failure (`${parsed.error.issues.map(…)}`, `${issue.message}`)
  // prints the messages the parsed schema writes: `ctx.addIssue({ message })`, `.refine(fn, message)`,
  // `.regex(re, message)` and the like. Each is followed from the refusal that prints it.
  /** The schema a `safeParse` result an expression reads was parsed by, if any. */
  const parsedSchemaOf = (expression: ts.Node): ts.Expression | undefined => {
    let found: ts.Expression | undefined;
    const fromIdentifier = (identifier: ts.Identifier, depth: number): ts.Expression | undefined => {
      const [declaration] = declarationsOf(identifier);
      if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined || depth > 4) return undefined;
      let value = unwrap(declaration.initializer);
      if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "safeParse") {
        return value.expression.expression;
      }
      while (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) value = unwrap(value.expression);
      return ts.isIdentifier(value) ? fromIdentifier(value, depth + 1) : undefined;
    };
    const visit = (node: ts.Node): void => {
      if (found !== undefined) return;
      if (ts.isIdentifier(node)) found = fromIdentifier(node, 0);
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };
  /** The units a schema expression names, through the parameter a call fills when it is one. */
  const schemaUnitsOf = (schema: ts.Expression, site: Site): ts.Node[] => {
    let expression = unwrap(schema);
    if (ts.isIdentifier(expression)) {
      const parameter = parameterOf(expression);
      if (parameter !== undefined) {
        const callee = site.node.expression;
        const calls = declarationsOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee)
          .some((declaration) => unitOf(declaration) === parameter.owner);
        const arg = calls ? site.node.arguments?.[parameter.param] : undefined;
        if (arg === undefined) return [];
        expression = unwrap(arg);
      }
    }
    const out: ts.Node[] = [];
    for (const declaration of declarationsOf(ts.isPropertyAccessExpression(expression) ? expression.name : expression)) {
      const unit = unitOf(declaration);
      if (unit !== undefined) out.push(unit);
    }
    return out;
  };
  const SCHEMA_MESSAGE_METHODS = new Set([
    "addIssue", "refine", "superRefine", "regex", "min", "max", "length", "nonempty", "startsWith", "endsWith",
    "includes", "gt", "gte", "lt", "lte", "int", "positive", "nonnegative", "negative", "nonpositive", "multipleOf",
  ]);
  /** The issue messages a schema's code writes, with where each is written. */
  const schemaMessagesOf = (units: readonly ts.Node[]): { readonly at: ts.Node; readonly template: Template }[] => {
    const out: { at: ts.Node; template: Template }[] = [];
    const seen = new Set<ts.Node>();
    for (const unit of reach(units)) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && SCHEMA_MESSAGE_METHODS.has(node.expression.name.text)) {
          const args = node.arguments;
          for (const arg of args) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const element of arg.properties) {
              if (ts.isPropertyAssignment(element) && ["message", "error"].includes(element.name.getText())
                && isStringExpression(element.initializer) && !seen.has(element)) {
                seen.add(element);
                for (const template of render(element.initializer)) out.push({ at: element, template });
              }
            }
          }
          const last = args[args.length - 1];
          if (args.length >= 2 && last !== undefined && isStringExpression(last) && !seen.has(last)) {
            seen.add(last);
            for (const template of render(last)) out.push({ at: last, template });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(unit);
    }
    return out;
  };
  /** How a hole prints a parse failure: each issue as `path: message`, zod's JSON of the issues, one issue's message. */
  const issueFormat = (hole: HolePart): "list" | "json" | "message" | undefined => {
    if (/\.issues\.map\(/u.test(hole.hole) && /\.message\b/u.test(hole.hole)) return "list";
    if (/\.error\.message$/u.test(hole.hole)) return "json";
    return /\.message$/u.test(hole.hole) ? "message" : undefined;
  };
  const issueText = (format: "list" | "json" | "message", message: string): readonly string[] => {
    if (format === "message") return [message];
    if (format === "json") return [JSON.stringify([{ code: "custom", path: [], message }], null, 2)];
    // A field's issue prints its path; a whole record's prints `(root)`.
    return [`x: ${message}`, `(root): ${message}`];
  };
  for (const site of sites) {
    for (const thrown of site.thrown) {
      if (forwardingOwner(thrown.template) !== undefined) continue;
      for (const part of thrown.template) {
        if (!isHolePart(part) || part.caught || part.node === undefined) continue;
        const format = issueFormat(part);
        const schema = format === undefined ? undefined : parsedSchemaOf(part.node);
        if (format === undefined || schema === undefined) continue;
        for (const { at, template: issue } of schemaMessagesOf(schemaUnitsOf(schema, site))) {
          if (issue.every(isHolePart) || issue.some(isParameterPart)) continue;
          const origin = originOf(at, issue, "schema");
          for (const issueLine of issueText(format, fill(issue, undefined))) {
            const text = thrown.template.map((other) => {
              if ("text" in other) return other.text;
              if (other === part) return issueLine;
              return isHolePart(other) ? holeValue(other.hole) : "x";
            }).join("");
            emit(site.node, { text, name: thrown.name }, origin, 0);
          }
        }
      }
    }
  }

  // ── The data channel ─────────────────────────────────────────────────────────────────────────
  // A refusal that interpolates `result.property`, where `result` holds what a call returned, prints
  // whatever the called code returns as that property: a caught message (a product, above), or a
  // string it writes there itself.
  interface Consumer {
    readonly site: Site;
    readonly thrown: Thrown;
    readonly hole: HolePart;
    readonly root: string;
    readonly property: string;
    readonly reached: Set<ts.Node>;
  }
  /** The units whose return value an identifier holds: through `const`/`let` bindings and
   * assignments, property and element reads, down to a call. */
  const producersOf = (identifier: ts.Identifier, depth = 0): ts.Node[] => {
    const [declaration] = declarationsOf(identifier);
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || depth > 4) return [];
    const sources: ts.Expression[] = declaration.initializer === undefined ? [] : [declaration.initializer];
    let scope: ts.Node = declaration;
    while (!ts.isSourceFile(scope) && !isFunctionLike(scope)) scope = scope.parent;
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)
        && declarationsOf(node.left)[0] === declaration) sources.push(node.right);
      ts.forEachChild(node, visit);
    };
    visit(scope);
    const out: ts.Node[] = [];
    for (const source of sources) {
      let expression = unwrap(source);
      while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) expression = unwrap(expression.expression);
      if (ts.isCallExpression(expression)) {
        const callee = expression.expression;
        for (const target of declarationsOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee)) {
          const unit = unitOf(target);
          if (unit !== undefined && reachable.has(unit)) out.push(unit);
        }
      } else if (ts.isIdentifier(expression)) {
        out.push(...producersOf(expression, depth + 1));
      }
    }
    return out;
  };
  /** `result.property`, `result.property ?? fallback`, or a list joined (`result.issues.join("; ")`). */
  const readOf = (hole: HolePart): { root: ts.Identifier; property: string } | undefined => {
    if (hole.node === undefined || hole.caught) return undefined;
    let expression = unwrap(hole.node);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      expression = unwrap(expression.left);
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === "join") {
      expression = unwrap(expression.expression.expression);
    }
    return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
      ? { root: expression.expression, property: expression.name.text }
      : undefined;
  };
  const consumers: Consumer[] = [];
  for (const site of sites) {
    for (const thrown of site.thrown) {
      if (thrown.template.some(isParameterPart)) continue;
      for (const part of thrown.template) {
        if (!isHolePart(part)) continue;
        const read = readOf(part);
        if (read === undefined) continue;
        const units = producersOf(read.root);
        if (units.length === 0) continue;
        consumers.push({ site, thrown, hole: part, root: read.root.text, property: read.property, reached: reach(units) });
      }
    }
  }
  const consumedProperties = new Set(consumers.map((consumer) => consumer.property));
  // Strings code writes straight into a consumed property: `{ check, detail: "…" }`, or pushes onto
  // a list of that name it returns (`issues.push("…")`, read as `${validation.issues.join("; ")}`).
  for (const unit of reachable) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && enclosingUnit(node) === unit) {
        // A string passed to a function that returns it as a consumed property: `invalid("…")`.
        for (const forward of dataForwardsOf(node)) {
          const arg = node.arguments[forward.param];
          if (arg === undefined || !consumedProperties.has(forward.property) || !isStringExpression(arg) || readsCaught(arg)) continue;
          for (const template of render(arg)) {
            if (!template.some((part) => "text" in part && /[A-Za-z]\s+[A-Za-z]/u.test(part.text)) || template.some(isParameterPart)) continue;
            addProduct({ property: forward.property, at: forward.at, text: fill(template, undefined), origin: () => originOf(node, template, "data") });
          }
        }
      }
      if (ts.isCallExpression(node) && enclosingUnit(node) === unit && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "push" && ts.isIdentifier(node.expression.expression)
        && consumedProperties.has(node.expression.expression.text)) {
        const property = node.expression.expression.text;
        for (const arg of node.arguments) {
          if (!isStringExpression(arg) || readsCaught(arg)) continue;
          for (const template of render(arg)) {
            if (!template.some((part) => "text" in part && /[A-Za-z]\s+[A-Za-z]/u.test(part.text)) || template.some(isParameterPart)) continue;
            addProduct({ property, at: node, text: fill(template, undefined), origin: () => originOf(node, template, "data") });
          }
        }
      }
      if (ts.isPropertyAssignment(node) && enclosingUnit(node) === unit && consumedProperties.has(node.name.getText())
        && isStringExpression(node.initializer) && !readsCaught(node.initializer)) {
        const object = ts.isObjectLiteralExpression(node.parent) ? node.parent : undefined;
        for (const template of render(node.initializer)) {
          // Prose only: a constant written as a value (an OID, a code) fills a hole; it is no refusal's text.
          if (!template.some((part) => "text" in part && /[A-Za-z]\s+[A-Za-z]/u.test(part.text)) || template.some(isParameterPart)) continue;
          addProduct({
            property: node.name.getText(),
            ...(object === undefined ? {} : { object }),
            at: node,
            text: fill(template, undefined),
            origin: () => originOf(node, template, "data"),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
  }

  /**
   * A property that passes on another call's result property (`detail: comparability.detail`)
   * relays it: what reaches the read reaches this object too, beside this object's other properties
   * (`check: "benchmark-comparability"`).
   */
  interface Relay {
    readonly node: ts.PropertyAssignment;
    readonly object: ts.ObjectLiteralExpression;
    readonly property: string;
    readonly reads: string;
    readonly reached: Set<ts.Node>;
  }
  const relays: Relay[] = [];
  for (const unit of reachable) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && enclosingUnit(node) === unit && ts.isObjectLiteralExpression(node.parent)
        && consumedProperties.has(node.name.getText()) && !readsCaught(node.initializer)) {
        const value = unwrap(node.initializer);
        if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
          const units = producersOf(value.expression);
          if (units.length > 0) {
            relays.push({ node, object: node.parent, property: node.name.getText(), reads: value.name.text, reached: reach(units) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
  }

  /** The value an object literal's other property prints, for a consumer's other holes. */
  const sibling = (object: ts.ObjectLiteralExpression | undefined, property: string): string | undefined => {
    if (object === undefined) return undefined;
    for (const element of object.properties) {
      if (ts.isPropertyAssignment(element) && element.name.getText() === property) {
        const [template] = render(element.initializer);
        return template === undefined ? undefined : fill(template, undefined);
      }
    }
    return undefined;
  };
  const consumed = new Set<string>();
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index]!;
    const unit = ts.isSourceFile(product.at) ? undefined : enclosingUnit(product.at);
    if (unit === undefined) continue;
    for (const relay of relays) {
      if (relay.reads !== product.property || !relay.reached.has(unit) || relay.node === product.at) continue;
      addProduct({ property: relay.property, object: relay.object, at: relay.node, text: product.text, origin: product.origin });
    }
    for (const consumer of consumers) {
      if (consumer.property !== product.property || !consumer.reached.has(unit)) continue;
      const key = `${index}\u0000${consumers.indexOf(consumer)}`;
      if (consumed.has(key)) continue;
      consumed.add(key);
      let complete = true;
      const text = consumer.thrown.template.map((part) => {
        if ("text" in part) return part.text;
        if (!isHolePart(part)) return "x";
        if (part === consumer.hole) return product.text;
        const read = readOf(part);
        if (read === undefined || read.root.text !== consumer.root) return holeValue(part.hole);
        const value = sibling(product.object, read.property);
        // The object this property sits in has none of the other properties the refusal reads, so
        // a relay further on (one that adds them) carries it to this refusal instead.
        if (value === undefined) complete = false;
        return value ?? holeValue(part.hole);
      }).join("");
      if (!complete) continue;
      emit(consumer.site.node, { text, name: consumer.thrown.name }, typeof product.origin === "function" ? product.origin() : product.origin, 1);
    }
  }

  const entries = [...origins.values()].map((origin) => ({
    module: origin.module,
    line: origin.line,
    template: origin.template,
    wraps: origin.wraps,
    kind: origin.kind,
    messages: [...printed.get(origin.key)!].sort(),
  }));
  const byPlace = (left: RefusalTemplate, right: RefusalTemplate): number =>
    (left.module === right.module ? left.line - right.line : left.module < right.module ? -1 : 1);
  const modules = [...new Set([...reachable].map(modulePath))].sort();
  return {
    templates: entries.filter((entry) => entry.messages.length > 0).sort(byPlace),
    caught: entries.filter((entry) => entry.messages.length === 0).sort(byPlace),
    modules,
    unreadImports: [...unread].sort(),
    schemaParses: findSchemaParses(checker, reachable, modulePath).sort((left, right) =>
      (left.module === right.module ? left.line - right.line : left.module < right.module ? -1 : 1)),
  };
}

// ── Schema parses ──────────────────────────────────────────────────────────────────────────────
/** The schema methods that throw their issue messages rather than returning them. */
const THROWING_SCHEMA_METHODS = new Set(["parse", "parseAsync", "decode", "decodeAsync", "encode", "encodeAsync"]);

/** The named function a node sits in (`Class.method` for a method), or `(module)` at top level. */
function withinOf(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
    if ((ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current))
      && ts.isClassLike(current.parent) && current.parent.name !== undefined) {
      return `${current.parent.name.text}.${current.name.getText()}`;
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer !== undefined
      && isFunctionLike(unwrap(current.initializer))) return current.name.text;
  }
  return "(module)";
}

/**
 * Each schema `.parse()` under `units`, and each other method in `THROWING_SCHEMA_METHODS`: called
 * (`schema.parse(value)`, `schemas.get(kind)?.parse(value)`) or handed on as a value
 * (`items.map(schema.parse)`), listed at the call when there is one. These throw their issue
 * messages, which no template holds. A receiver is a schema when its type, read without `undefined`,
 * has `safeParse`, or any member of it does when it is a union. One whose type cannot be read counts
 * as one, so an unresolved type lists a call rather than hiding it.
 */
export function findSchemaParses(
  checker: ts.TypeChecker,
  units: Iterable<ts.Node>,
  moduleOf: (node: ts.Node) => string,
): SchemaParse[] {
  const isSchema = (receiver: ts.Expression): boolean => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
    if ((type.flags & ts.TypeFlags.Any) !== 0) return true;
    return (type.isUnion() ? type.types : [type]).some((member) => member.getProperty("safeParse") !== undefined);
  };
  const found: SchemaParse[] = [];
  const seen = new Set<ts.Node>();
  for (const unit of units) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && !seen.has(node) && THROWING_SCHEMA_METHODS.has(node.name.text)
        && isSchema(node.expression)) {
        seen.add(node);
        const site = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : node;
        found.push({
          module: moduleOf(site),
          line: site.getSourceFile().getLineAndCharacterOfPosition(site.getStart()).line + 1,
          within: withinOf(site),
          call: sourceOf(site),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(unit);
  }
  return found;
}

/**
 * `findSchemaParses` over one module written as `source`, read with the walk's compiler options, so
 * a test can show what the walk lists without a reader path to it.
 */
export function schemaParsesInSource(source: string): SchemaParse[] {
  const file = resolve(SRC, "testing", "schema-parse-sample.ts");
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => (name === file
    ? ts.createSourceFile(name, source, languageVersion, true)
    : getSourceFile(name, languageVersion, ...rest));
  const program = ts.createProgram({ rootNames: [file], options: COMPILER_OPTIONS, host });
  const sample = program.getSourceFile(file);
  if (sample === undefined) throw new Error("schema parse sample did not load");
  return findSchemaParses(program.getTypeChecker(), [sample], () => "sample.ts");
}
