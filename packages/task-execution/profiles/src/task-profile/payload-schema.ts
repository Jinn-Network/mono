import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import safeRegex from "safe-regex";
import { ProfilesError } from "../errors.js";

/** Profile-format constants (design §6.4, program-gate confirmable). */
export const PROFILE_SCHEMA_MAX_BYTES = 262144;
export const PROFILE_SCHEMA_MAX_DEPTH = 32;
export const PROFILE_SCHEMA_MAX_PATTERN_LENGTH = 1024;

/**
 * An ajv-compatible `RegExp`-shaped constructor (program §7.17). The default is native `RegExp`;
 * the marketplace deployment profile injects a linear-time engine (RE2) to close the residual
 * `safe-regex` cannot (a static star-height check, not a runtime bound). Most RE2 wrapper
 * packages expose exactly this shape: `new RE2(pattern, flags)` then `.test(value)`.
 */
export type RegExpEngine = new (pattern: string, flags?: string) => { test(value: string): boolean };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkPatternString(pattern: unknown, path: string): void {
  if (typeof pattern !== "string") return;
  if (pattern.length > PROFILE_SCHEMA_MAX_PATTERN_LENGTH) {
    throw new ProfilesError(
      "invalid-document",
      `payloadSchema pattern at ${path} exceeds the maximum length of ${PROFILE_SCHEMA_MAX_PATTERN_LENGTH}.`,
    );
  }
  // A static star-height check (safe-regex), NOT a runtime bound — see the injectable regExp
  // engine seam below and program §7.17's documented residual.
  if (!safeRegex(pattern)) {
    throw new ProfilesError(
      "invalid-document",
      `payloadSchema pattern at ${path} failed the safe-regex static ReDoS check: ${pattern}`,
    );
  }
}

function checkPatternBearingKeywords(node: Record<string, unknown>, path: string): void {
  checkPatternString(node.pattern, `${path}.pattern`);
  if (isPlainRecord(node.patternProperties)) {
    for (const key of Object.keys(node.patternProperties)) {
      checkPatternString(key, `${path}.patternProperties`);
    }
  }
  if (isPlainRecord(node.propertyNames)) {
    checkPatternString(node.propertyNames.pattern, `${path}.propertyNames.pattern`);
  }
}

function checkRef(node: Record<string, unknown>, path: string): void {
  if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
    throw new ProfilesError(
      "invalid-document",
      `payloadSchema contains a non-local $ref at ${path}: "${node.$ref}". Validators MUST NOT `
        + "perform network retrieval during validation (§6.4).",
    );
  }
}

function walkSchema(node: unknown, depth: number, path: string): void {
  if (depth > PROFILE_SCHEMA_MAX_DEPTH) {
    throw new ProfilesError(
      "invalid-document",
      `payloadSchema nesting depth exceeds the maximum of ${PROFILE_SCHEMA_MAX_DEPTH} at ${path}.`,
    );
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSchema(item, depth + 1, `${path}[${index}]`));
    return;
  }
  if (isPlainRecord(node)) {
    checkRef(node, path);
    checkPatternBearingKeywords(node, path);
    for (const [key, value] of Object.entries(node)) {
      walkSchema(value, depth + 1, `${path}.${key}`);
    }
  }
}

/**
 * Admission-time static pre-filter (§6.4): because anyone may publish a profile, `payloadSchema`
 * is validator input from an untrusted source. Rejects: any `$ref` that is not a local `#…`
 * fragment; more than `PROFILE_SCHEMA_MAX_BYTES` bytes; nesting depth beyond
 * `PROFILE_SCHEMA_MAX_DEPTH`; any pattern-bearing string (`pattern`, `patternProperties` keys,
 * `propertyNames.pattern`) longer than `PROFILE_SCHEMA_MAX_PATTERN_LENGTH` or that `safe-regex`
 * flags as vulnerable to catastrophic backtracking.
 */
export function assertSafeSchema(schema: unknown, bytes: Uint8Array): void {
  if (bytes.byteLength > PROFILE_SCHEMA_MAX_BYTES) {
    throw new ProfilesError(
      "invalid-document",
      `payloadSchema is ${bytes.byteLength} bytes, exceeding the maximum of ${PROFILE_SCHEMA_MAX_BYTES}.`,
    );
  }
  walkSchema(schema, 0, "$");
}

export interface PayloadValidationResult {
  ok: boolean;
  errors?: string[];
}

/**
 * Runs `assertSafeSchema` first, then compiles with ajv-2020, guaranteeing no network fetch (no
 * `loadSchema` means an unresolved `$ref` throws) and routing every regex through the injected
 * (or default native) engine. ajv's `code.regExp` seam expects a callable `(pattern, flags) =>
 * RegExpLike`, invoked WITHOUT `new` — a raw ES6 class engine would throw if passed directly, so
 * this wraps the constructor-shaped `RegExpEngine` into ajv's call convention rather than passing
 * it through unwrapped.
 *
 * ajv also deduplicates compiled patterns in its codegen scope by `rx.toString()` (see
 * `usePattern` in `ajv/dist/vocabularies/code.js`): every instance of a custom engine class that
 * does not override `toString()` returns the same `"[object Object]"`, so ajv would collapse
 * every distinct pattern in the schema onto whichever instance happened to be scoped first — a
 * silent cross-pattern mix-up, not a compile error. This wrapper stamps a `toString()` unique to
 * `(pattern, flags)` onto every constructed instance so ajv's cache key stays injective.
 */
export function compilePayloadValidator(
  schema: unknown,
  bytes: Uint8Array,
  opts?: { regExp?: RegExpEngine },
): (payload: unknown) => PayloadValidationResult {
  assertSafeSchema(schema, bytes);

  const Engine = opts?.regExp ?? RegExp;
  // ajv's `code.regExp` type additionally requires a `.code` string property (used only for its
  // standalone-code-generation shortcut, which this package never invokes) — set to anything
  // other than the literal `"new RegExp"` so ajv always routes through this wrapper function
  // rather than assuming it can inline a bare `new RegExp(...)` call.
  const regExpEngine = Object.assign(
    (pattern: string, flags: string) => {
      const instance = new Engine(pattern, flags);
      Object.defineProperty(instance, "toString", {
        value: () => `/${pattern}/${flags}`,
      });
      return instance;
    },
    { code: "task-execution-profiles.regExp" },
  );
  const ajv = new Ajv2020({
    strict: true,
    loadSchema: undefined,
    code: { regExp: regExpEngine },
  });

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as Record<string, unknown>);
  } catch (cause) {
    throw new ProfilesError("invalid-document", "payloadSchema failed to compile.", { cause });
  }

  return (payload: unknown): PayloadValidationResult => {
    const ok = validate(payload) as boolean;
    if (ok) return { ok: true };
    return {
      ok: false,
      errors: (validate.errors ?? []).map(
        (error) => `${error.instancePath || "<root>"} ${error.message ?? ""}`.trim(),
      ),
    };
  };
}
