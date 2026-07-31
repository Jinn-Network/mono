// Emits the published JSON Schema. `--write` regenerates; `--check` detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const mode = process.argv.includes("--write") ? "--write" : "--check";

const {
  ENVIRONMENT_RECORD_SCHEMA_ID,
  EnvironmentRecordSchema,
  SHELL_INTERPRETERS,
  SHELL_METACHARACTERS,
} = await import(join(root, "dist", "index.js"));

const NAMESPACED =
  "^(?:[A-Za-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9-]*)+|[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+)$";

// `z.toJSONSchema` drops `.refine()` predicates, which is where the shell-freedom rules of
// `CommandSpecSchema` live. Left alone, the published schema would accept a record the zod
// schema refuses, and a third party validating with it would reach a different verdict than
// this package does. Both rules ARE expressible in JSON Schema, so they are re-emitted here
// — derived from the very constants the zod schema refines against, so the two cannot drift.
const CHARACTER_CLASS_ESCAPES = new Map([
  ["\\", "\\\\"], ["\n", "\\n"], ["\r", "\\r"], ["]", "\\]"], ["^", "\\^"], ["-", "\\-"],
]);
const SHELL_FREE_PATTERN = `^[^${
  SHELL_METACHARACTERS.map((character) => CHARACTER_CLASS_ESCAPES.get(character) ?? character).join("")
}]+$`;
// Matches an interpreter basename in any position a `bin` value can hide one: whole string,
// after a path separator, or as a whitespace-delimited token ("/usr/bin/env bash"). JSON
// Schema patterns carry no flags, so the case-insensitivity and the `.exe` tolerance that
// `normalizeBasename` gives the runtime are spelled out here, character class by character
// class — the two surfaces must reach the same verdict on `bash.exe` and `/bin/SH`.
const eitherCase = (name) => [...name]
  .map((character) => (/[a-z]/u.test(character)
    ? `[${character}${character.toUpperCase()}]`
    : character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
  .join("");
const SHELL_INTERPRETER_PATTERN = `(^|[/\\s])(${
  SHELL_INTERPRETERS.map((name) => eitherCase(name.toLowerCase().replace(/\.exe$/u, ""))).join("|")
})(\\.[Ee][Xx][Ee])?(\\s|$)`;

const shellFreeString = () => ({ pattern: SHELL_FREE_PATTERN });

/** A CommandSpec node in the emitted tree: a closed object with exactly `bin` + `args`. */
function isCommandSpecNode(node) {
  return node?.type === "object"
    && node.properties?.bin?.type === "string"
    && node.properties?.args?.type === "array"
    && node.additionalProperties === false;
}

function restoreShellFreedom(node) {
  if (Array.isArray(node)) {
    for (const element of node) restoreShellFreedom(element);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (isCommandSpecNode(node)) {
    Object.assign(node.properties.bin, shellFreeString(), {
      not: { pattern: SHELL_INTERPRETER_PATTERN },
    });
    Object.assign(node.properties.args.items, shellFreeString());
    if (node.properties.cwd) Object.assign(node.properties.cwd, shellFreeString());
    if (node.properties.env?.additionalProperties) {
      Object.assign(node.properties.env.additionalProperties, shellFreeString());
    }
  }
  for (const member of Object.values(node)) restoreShellFreedom(member);
}

const schema = z.toJSONSchema(EnvironmentRecordSchema, {
  target: "draft-2020-12",
  unrepresentable: "any",
});

restoreShellFreedom(schema);

schema.$id = ENVIRONMENT_RECORD_SCHEMA_ID;
schema.title = "Jinn environment record";
schema.description =
  "A sealed description of one execution environment: one (source, image, platform, "
  + "invocations, parser) binding. The document asserts what the environment is, never that "
  + "it works — behavior claims live in separately published verification attestations.";
schema.propertyNames = {
  anyOf: [{ enum: Object.keys(schema.properties ?? {}) }, { pattern: NAMESPACED }],
};
schema.$comment = [
  "Structural validation only. Four checks are runtime-only and are not expressible here:",
  "(shell-freedom IS expressed, as bin/args/cwd/env patterns.)",
  "image.reference must end with @<manifestDigest>;",
  "image.indexDigest, when present, must differ from image.manifestDigest;",
  "build.recipe and build.dependencyPinning are required at reproducibilityTier >= 1;",
  "and the record's bytes must be the exact RFC 8785 canonical encoding of the document.",
].join(" ");

const target = join(root, "schemas", "environment.schema.json");
const text = `${JSON.stringify(schema, null, 2)}\n`;

if (mode === "--write") {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  console.log("schema written");
} else {
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) {
    console.error("published schema is out of date; run `yarn generate:schemas`");
    process.exit(1);
  }
  console.log("schema up to date");
}
