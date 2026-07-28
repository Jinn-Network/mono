import { ProfilesError } from "../errors.js";
import { compilePayloadValidator, type PayloadValidationResult, type RegExpEngine } from "./payload-schema.js";
import { sealTaskProfile } from "./seal.js";
import type { TaskProfileDocument } from "./schema.js";

export type CompiledValidator = (payload: unknown) => PayloadValidationResult;

/**
 * Compiled SDK validators are digest-keyed caches over the authoritative profile document
 * (design §6.4): the document is the runtime validation authority, not the cache. `get` compiles
 * `doc.payloadSchema` once per digest and reuses it thereafter; `checkDrift` refuses to keep
 * validating against a cached document once its digest no longer matches the pinned digest for
 * its URI (a newer patch published under the same URI — design §6.2).
 */
export class PayloadValidatorCache {
  private readonly cache = new Map<string, CompiledValidator>();

  get(digest: string, doc: TaskProfileDocument, opts?: { regExp?: RegExpEngine }): CompiledValidator {
    const cached = this.cache.get(digest);
    if (cached !== undefined) return cached;
    const bytes = sealTaskProfile(doc).bytes;
    const validator = compilePayloadValidator(doc.payloadSchema, bytes, opts);
    this.cache.set(digest, validator);
    return validator;
  }

  /**
   * Throws `unsupported-profile`, naming the unresolvable digest, when `cachedDoc`'s own digest
   * does not equal the pinned `digest` for `uri` — a backend holding only a different digest for
   * the same URI (a newer patch) MUST NOT validate against its cached document (§6.2).
   */
  checkDrift(uri: string, digest: string, cachedDoc: TaskProfileDocument): void {
    const actual = sealTaskProfile(cachedDoc).digest;
    if (actual !== digest) {
      throw new ProfilesError(
        "unsupported-profile",
        `cached document for profile URI "${uri}" has digest ${actual}, but the pinned digest is `
          + `${digest}; refusing to validate against a differently-digested cache.`,
      );
    }
  }
}
