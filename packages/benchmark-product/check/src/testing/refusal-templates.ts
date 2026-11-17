// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #5299: every refusal template the reader's own modules write, read from their source.
 *
 * The characterization suite reaches a refusal only when one of its bundles provokes it, so the
 * glossary conformance test, reading that suite's pins, saw a few dozen of the several hundred
 * refusal lines the reader can print. This reads the source instead. It starts at `runVerifierCli`
 * in `cli.ts` and follows every function, class and constant the reachable code calls or names,
 * within this package's `src/` (tests and `testing/` excluded). In that code it collects each place
 * that throws with a message:
 *
 * - `refuse(code, path, message)` from `profile/errors.ts`;
 * - `new Error(message)`, and `TypeError`, `RangeError`, `SyntaxError`;
 * - `new` of an error class this package declares, read through its constructor's `super(...)`;
 * - a call to a function that forwards its own parameters, or one property of one
 *   (`${source.label}`), into any of these, filled with what the caller passes.
 *
 * A message is read as a template: its fixed text, with each value it interpolates as a hole,
 * written `${source}`. A `const` bound to a string expression is read through, so a path the module
 * builds once (`resolutions.${index}`) reaches the template as built.
 *
 * A hole that interpolates the error a `catch` clause caught makes its template a wrapper: a
 * template thrown inside the `try` block, or in what the block reaches, can reach the reader
 * behind the wrapper's fixed text (`binary admission replay failed: …`). So each template is
 * probed bare and behind each wrapper that catches it, one level deep.
 *
 * What it does not read, each of which reaches the reader only inside a hole: messages the platform
 * packages (`@jinn-network/*`) write; text a module returns as data (a `reason` or `detail` field)
 * before a caller interpolates it; and a schema library's issue text.
 */

import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** One place a reader-reachable module throws with a message. */
export interface RefusalTemplate {
  /** The refusing module, relative to this package's `src/`. */
  readonly module: string;
  /** 1-based line of the throw site, for a reader of the inventory; not part of its identity. */
  readonly line: number;
  /** The message as the module writes it: its fixed text, each interpolated value as `${source}`. */
  readonly template: string;
  /** Whether the template interpolates a caught error, which makes it a wrapper. */
  readonly wraps: boolean;
  /**
   * Messages the reader can receive from this site, sorted: the template with each hole filled by a
   * value of the shape its source names (a fingerprint, an index, a word), bare and behind each
   * wrapper whose `try` block reaches it.
   */
  readonly messages: readonly string[];
}

export interface RefusalInventory {
  /** Sorted by module, then line. One entry per distinct template in a module. */
  readonly templates: readonly RefusalTemplate[];
  /** The modules the walk read, relative to `src/`, sorted. */
  readonly modules: readonly string[];
}

interface ParameterPart {
  readonly owner: ts.FunctionLikeDeclaration;
  readonly param: number;
  /** Set when the message reads one property of the parameter (`source.label`). */
  readonly property?: string;
}
type Part = { readonly text: string } | { readonly hole: string; readonly caught: boolean } | ParameterPart;
type Template = readonly Part[];

const ERROR_CONSTRUCTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError"]);
/** The most alternatives one message expands to. No site comes close; the cap bounds a mistake. */
const ALTERNATIVES_CAP = 64;
/** How deep a message's expression is read before the rest is taken as a hole. */
const DEPTH_CAP = 8;

function inScope(file: string): boolean {
  if (!file.startsWith(SRC) || !file.endsWith(".ts") || file.endsWith(".d.ts")) return false;
  const local = relative(SRC, file);
  return !local.endsWith(".test.ts") && !local.split(sep).includes("testing");
}

function modulePath(node: ts.Node): string {
  return relative(SRC, node.getSourceFile().fileName).split(sep).join("/");
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
  if ("hole" in part) return `h:${part.caught}:${part.hole}`;
  return `p:${part.param}:${part.property ?? ""}`;
}

function templateText(template: Template): string {
  return template.map((part) => ("text" in part ? part.text : "hole" in part ? `\${${part.hole}}` : `\${${parameterText(part)}}`)).join("");
}

/**
 * A value of the shape a hole's source names, so a wording rule that captures a fingerprint or an
 * index sees one: a run's `<task fingerprint>/<configuration>/<repeat>` for a `cellKey`, 64 hex
 * digits for a digest, `0` for an index or a count, a word otherwise. A caught error's message is
 * `inner`.
 */
function holeValue(source: string, caught: boolean, inner: string): string {
  if (caught) return inner;
  if (/cellKey/u.test(source)) return `${"a".repeat(64)}/x/1`;
  if (/sha256|digest|hex\b|identity\b/iu.test(source)) return "a".repeat(64);
  if (/index|Index|count|Count|length|height|\b[ijn]\b/u.test(source)) return "0";
  return "x";
}

function probe(template: Template, inner: string): string {
  return template.map((part) => ("text" in part ? part.text : "hole" in part ? holeValue(part.hole, part.caught, inner) : "x")).join("");
}

/** Every refusal template the modules `runVerifierCli` reaches write, read from their source. */
export function refusalTemplateInventory(): RefusalInventory {
  const entry = resolve(SRC, "cli.ts");
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
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

  // ── Messages, as templates ───────────────────────────────────────────────────────────────────
  const parameterOf = (identifier: ts.Identifier): { owner: ts.FunctionLikeDeclaration; param: number } | undefined => {
    const [declaration] = declarationsOf(identifier);
    if (declaration === undefined || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
    const owner = declaration.parent;
    return isFunctionLike(owner) ? { owner, param: owner.parameters.indexOf(declaration) } : undefined;
  };
  /** Whether an expression reads the error a `catch` clause caught, directly or through a `const`. */
  const readsCaught = (expression: ts.Node, depth = 0): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node)) {
        const [declaration] = declarationsOf(node);
        if (declaration !== undefined && ts.isVariableDeclaration(declaration)) {
          if (ts.isCatchClause(declaration.parent)) found = true;
          else if (depth < DEPTH_CAP && declaration.initializer !== undefined
            && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) {
            found = readsCaught(declaration.initializer, depth + 1);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };

  const render = (expression: ts.Expression, depth = 0): Template[] => {
    if (depth > DEPTH_CAP) return [[{ hole: sourceOf(expression), caught: false }]];
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
    if (ts.isConditionalExpression(expression)) {
      return [...render(expression.whenTrue, depth + 1), ...render(expression.whenFalse, depth + 1)].slice(0, ALTERNATIVES_CAP);
    }
    if (readsCaught(expression)) return [[{ hole: sourceOf(expression), caught: true }]];
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
    return [[{ hole: sourceOf(expression), caught: false }]];
  };

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
  const substitute = (templates: readonly Template[], owner: ts.FunctionLikeDeclaration, args: readonly ts.Expression[]): Template[] => {
    const out: Template[] = [];
    for (const template of templates) {
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
      out.push(...alternatives);
    }
    return out.slice(0, ALTERNATIVES_CAP);
  };

  // ── What throws with a message ───────────────────────────────────────────────────────────────
  /** Callables that forward their parameters into a message, by the templates they throw. */
  const forwarders = new Map<ts.FunctionLikeDeclaration, Template[]>();

  /** An error class's message: its constructor's `super(...)` argument, or its base class's. */
  const classMessage = (declaration: ts.ClassDeclaration, args: readonly ts.Expression[]): Template[] | undefined => {
    const constructor = declaration.members.find(ts.isConstructorDeclaration);
    if (constructor === undefined) {
      const base = declaration.heritageClauses?.[0]?.types[0]?.expression;
      if (base === undefined) return undefined;
      if (ts.isIdentifier(base) && ERROR_CONSTRUCTORS.has(base.text) && declarationsOf(base).length === 0) {
        return args[0] === undefined ? undefined : render(args[0]);
      }
      const [baseDeclaration] = declarationsOf(base);
      return baseDeclaration !== undefined && ts.isClassDeclaration(baseDeclaration) ? classMessage(baseDeclaration, args) : undefined;
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
    return message === undefined ? undefined : substitute(message, constructor, args);
  };

  /** The templates a call or `new` throws with, or undefined when it throws none. */
  const sinkMessage = (node: ts.CallExpression | ts.NewExpression): Template[] | undefined => {
    const args = node.arguments ?? [];
    const callee = node.expression;
    if (ts.isNewExpression(node) && ts.isIdentifier(callee) && ERROR_CONSTRUCTORS.has(callee.text) && declarationsOf(callee).length === 0) {
      return args[0] === undefined ? undefined : render(args[0]);
    }
    for (const declaration of declarationsOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee)) {
      if (ts.isFunctionDeclaration(declaration) && declaration.name?.text === "refuse" && modulePath(declaration) === "profile/errors.ts") {
        return args[2] === undefined ? undefined : render(args[2]);
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
    readonly templates: readonly Template[];
  }
  const collectSites = (): Site[] => {
    const sites: Site[] = [];
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !seen.has(node)) {
        seen.add(node);
        const templates = sinkMessage(node);
        if (templates !== undefined) sites.push({ node, templates });
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

  // A forwarder found in one round makes its callers' messages readable in the next, and a caller
  // that forwards in turn is found then. Settles once a round finds nothing new.
  for (let round = 0; ; round += 1) {
    if (round > 20) throw new Error("refusal inventory: forwarding did not settle");
    let changed = false;
    for (const { templates } of collectSites()) {
      for (const template of templates) {
        const owner = forwardingOwner(template);
        if (owner === undefined) continue;
        const known = forwarders.get(owner) ?? [];
        const key = template.map(partKey).join("\u0000");
        if (known.some((existing) => existing.map(partKey).join("\u0000") === key)) continue;
        forwarders.set(owner, [...known, template]);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ── Sites, as the reader meets them ──────────────────────────────────────────────────────────
  const reported: { readonly node: ts.Node; readonly template: Template }[] = [];
  for (const site of collectSites()) {
    for (const template of site.templates) {
      // Reported at each call of the forwarder instead, filled with what it passes.
      if (forwardingOwner(template) !== undefined) continue;
      const settled: Template = template.map((part) => (isParameterPart(part) ? { hole: parameterText(part), caught: false } : part));
      // Only holes: the message forwards a caught error unchanged, or is an opaque value. Either way
      // it has no words of its own.
      if (settled.every((part) => "hole" in part)) continue;
      reported.push({ node: site.node, template: settled });
    }
  }

  // Wrappers: each `try` block, and the templates of the `catch` clauses that interpolate its error.
  const wrapping = new Map<ts.Block, Template[]>();
  for (const { node, template } of reported) {
    if (!template.some((part) => "hole" in part && part.caught)) continue;
    let clause: ts.Node = node;
    while (!ts.isCatchClause(clause) && !ts.isSourceFile(clause)) clause = clause.parent;
    if (!ts.isCatchClause(clause)) continue;
    const tryBlock = clause.parent.tryBlock;
    wrapping.set(tryBlock, [...(wrapping.get(tryBlock) ?? []), template]);
  }
  const enclosingUnit = (node: ts.Node): ts.Node | undefined => {
    for (let current = node.parent; current !== undefined; current = current.parent) if (reachable.has(current)) return current;
    return undefined;
  };
  const wrappersOf = new Map<ts.Node, Template[]>();
  for (const [tryBlock, wrappers] of wrapping) {
    const units = reach(named(tryBlock));
    for (const { node } of reported) {
      const inside = node.getSourceFile() === tryBlock.getSourceFile() && node.pos >= tryBlock.pos && node.end <= tryBlock.end;
      const unit = enclosingUnit(node);
      if (!inside && (unit === undefined || !units.has(unit))) continue;
      wrappersOf.set(node, [...(wrappersOf.get(node) ?? []), ...wrappers]);
    }
  }

  const byKey = new Map<string, { template: RefusalTemplate; messages: Set<string> }>();
  for (const { node, template } of reported) {
    const module = modulePath(node);
    const text = templateText(template);
    const bare = probe(template, "x");
    const key = `${module}\u0000${text}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        template: {
          module,
          line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
          template: text,
          wraps: template.some((part) => "hole" in part && part.caught),
          messages: [],
        },
        messages: new Set(),
      };
      byKey.set(key, entry);
    }
    entry.messages.add(bare);
    for (const wrapper of wrappersOf.get(node) ?? []) if (wrapper !== template) entry.messages.add(probe(wrapper, bare));
  }
  const templates = [...byKey.values()].map(({ template, messages }) => ({ ...template, messages: [...messages].sort() }));
  templates.sort((left, right) => (left.module === right.module ? left.line - right.line : left.module < right.module ? -1 : 1));
  const modules = [...new Set([...reachable].map(modulePath))].sort();
  return { templates, modules };
}
