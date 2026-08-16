import ts from "typescript";

/**
 * The file's code with every comment blanked to spaces. Newlines and byte offsets are preserved, so
 * line numbers in a failure still point at the real source.
 *
 * Architecture gates match patterns that name a dependency — an import specifier, an identifier, a
 * string-literal marker. Prose is none of those, so a rule must not be able to fire on it. Parsing
 * (rather than regexing or raw-scanning) is what makes this correct: the parser tokenizes template
 * and regex literals properly, and it is the only way to identify JSDoc, which TypeScript admits
 * into the AST as real nodes rather than trivia.
 */
export function codeOnly(source: string): string {
  const parsed = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    out += isCode[index] ? source[index] : source[index] === "\n" ? "\n" : " ";
  }
  return out;
}
