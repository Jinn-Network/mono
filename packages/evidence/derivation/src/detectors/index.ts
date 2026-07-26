// SPDX-License-Identifier: Apache-2.0

import { lintSource } from "@secretlint/core";
import { creator } from "@secretlint/secretlint-rule-preset-recommend";

import { canonicalJsonBytes, sha256Digest } from "../bytes.js";
import {
  derivationDetectorDescriptorSchema,
} from "../descriptor-schema.js";
import { EvidenceDerivationError } from "../errors.js";
import {
  assertNotProxy,
  ownDataProperty,
  snapshotInertData,
} from "../inert.js";
import { classifyTechnicalValue } from "../technical-values.js";
import { BIP39_ENGLISH } from "./data/bip39-english.js";
import { GITLEAKS_PACK } from "./data/gitleaks-rules.js";
import type {
  ConfidenceBand,
  CreateEvidenceDeriverOptions,
  DerivationDetector,
  DerivationDetectorDescriptor,
  DerivationFinding,
  DerivationSurface,
  DerivationOperationOptions,
} from "../types.js";

export interface BuiltinPrivateConfiguration {
  readonly schemaVersion: "jinn.private-detector-configuration.v1";
  readonly nonce: string;
  readonly knownIdentities: readonly string[];
  readonly privateAllowlist: readonly string[];
}

export interface BuiltinDetectorOptions {
  readonly privateConfiguration: BuiltinPrivateConfiguration;
}

type Match = {
  readonly class: string;
  readonly start: number;
  readonly end: number;
  readonly confidence?: ConfidenceBand;
  readonly evidence: string;
};

function regexRecipe(value: RegExp): Readonly<{
  source: string;
  flags: string;
}> {
  return Object.freeze({ source: value.source, flags: value.flags });
}

const DETERMINISTIC_PUBLIC_RECIPE = Object.freeze({
  schemaVersion: "jinn.evidence-derivation.detector-recipe.v1",
  secretlint: Object.freeze({
    package: "@secretlint/secretlint-rule-preset-recommend",
    version: "13.0.4",
  }),
  gitleaks: GITLEAKS_PACK,
  bip39: Object.freeze({
    wordlistDigest: sha256Digest(canonicalJsonBytes(BIP39_ENGLISH)),
    wordToken: regexRecipe(/[A-Za-z]+/gu),
    separator: regexRecipe(/^[\s,;|"'`]+$/u),
    wordCounts: Object.freeze([24, 12]),
  }),
  patterns: Object.freeze({
    email: regexRecipe(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
    ),
    absolutePath: regexRecipe(/\/(?:Users|home)\/[^/\s"'`]+/gu),
    credentialToken: regexRecipe(
      /\b(?:ghp_|xox[baprs]-|npm_|sk-(?:proj-)?|rk_live_|sk_live_)[A-Za-z0-9_-]{16,}\b/gu,
    ),
    cloudCredential: regexRecipe(
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{35}/gu,
    ),
    urlCredential: regexRecipe(
      /https?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+|[?&](?:token|key|secret|password)=[^&\s]+/giu,
    ),
    walletAddress: regexRecipe(/\b0x[a-fA-F0-9]{40}\b/gu),
    gitIdentityCarrier: regexRecipe(
      /(?:^|\n)(?:(?:Author|Committer|Signed-off-by|Co-authored-by|Reviewed-by|Acked-by):[^\n]+|(?:user\.name|user\.email|GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL))\s*[:=][^\n]+)/giu,
    ),
    machineIdentityCarrier: regexRecipe(
      /\b(?:hostname|machine(?:-name)?)\s*[:=]\s*[A-Za-z0-9._-]+/giu,
    ),
    privateKeyContext: regexRecipe(
      /\b(?:private[_\s-]?key|privkey|secret[_\s-]?key|wallet[_\s-]?key|signing[_\s-]?key)\b/iu,
    ),
    privateKeyHex: regexRecipe(/(?<!0x)\b[a-fA-F0-9]{64}\b/gu),
    environmentBlock: regexRecipe(
      /(?:^|\n)(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*(?:\n(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*){2,}/gu,
    ),
    paymentCardCandidate: regexRecipe(/\b(?:\d[ -]*?){13,19}\b/gu),
    ibanCandidate: regexRecipe(
      /\b(?:[A-Z]{2}\d{2}[A-Z0-9]{11,30}|[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/giu,
    ),
    ipv4Candidate: regexRecipe(
      /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/gu,
    ),
  }),
  algorithms: Object.freeze({
    luhn: Object.freeze({
      name: "ISO/IEC-7812-Luhn",
      minimumDigits: 13,
      maximumDigits: 19,
      rejectRepeatedDigit: true,
    }),
    iban: Object.freeze({
      name: "ISO-13616-mod-97",
      compactMinimumLength: 15,
      compactMaximumLength: 34,
      compactShape: regexRecipe(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u),
    }),
    ipRanges: Object.freeze({
      ignore: Object.freeze([
        "0/8",
        "127/8",
        "169.254/16",
        "192.0.2/24",
        "198.51.100/24",
        "203.0.113/24",
        "224/4",
        "255/8",
      ]),
      private: Object.freeze(["10/8", "172.16/12", "192.168/16"]),
    }),
    entropy: Object.freeze({
      minimumLength: 16,
      strictLength: 20,
      bitsPerCharacter: 4,
      token: regexRecipe(/\S+/gu),
      leadingTrim: regexRecipe(/^[("'`[{},;:]*/u),
      trailingTrim: regexRecipe(/[)"'`\]},;:.]*$/u),
      alphabet: regexRecipe(/^[A-Za-z0-9+/=_-]+$/u),
      syntheticBenchmarkId: regexRecipe(
        /^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*-\d+$/u,
      ),
    }),
  }),
  privateConfiguration: Object.freeze({
    schemaVersion: "jinn.private-detector-configuration.v1",
    knownIdentityMechanism: "exact-code-point-substring",
    privateAllowlistMechanism: "exact-matched-span-substring-exclusion",
  }),
});

function recipeRegex(
  recipe: Readonly<{ source: string; flags: string }>,
): RegExp {
  return new RegExp(recipe.source, recipe.flags);
}

function descriptor(
  id: string,
  controlledImplementation: unknown,
  configurationDigest?: `sha256:${string}`,
): DerivationDetectorDescriptor {
  return Object.freeze({
    id,
    version: "1.2.0",
    implementationDigest: sha256Digest(
      canonicalJsonBytes({
        id,
        version: "1.2.0",
        controlledImplementation,
      }),
    ),
    reproducibility: "byte-stable",
    ...(configurationDigest ? { configurationDigest } : {}),
  });
}

function finding(
  surface: DerivationSurface,
  match: Match,
  detectorDescriptor: DerivationDetectorDescriptor,
): DerivationFinding {
  return Object.freeze({
    class: match.class,
    confidence: match.confidence ?? "VERY_HIGH",
    surfaceId: surface.surfaceId,
    start: match.start,
    end: match.end,
    evidence: Object.freeze([match.evidence]),
    detector: detectorDescriptor,
  });
}

function regexMatches(
  text: string,
  pattern: RegExp,
  classification: string,
  evidence: string,
  confidence?: ConfidenceBand,
): Match[] {
  const matches: Match[] = [];
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let result: RegExpExecArray | null;
  while ((result = regex.exec(text)) !== null) {
    if (result[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({
      class: classification,
      start: result.index,
      end: result.index + result[0].length,
      evidence,
      ...(confidence ? { confidence } : {}),
    });
  }
  return matches;
}

function luhn(candidate: string): boolean {
  const { minimumDigits, maximumDigits } =
    DETERMINISTIC_PUBLIC_RECIPE.algorithms.luhn;
  const digits = candidate.replace(/\D/gu, "");
  if (digits.length < minimumDigits || digits.length > maximumDigits) {
    return false;
  }
  if (/^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function ibanMod97(candidate: string): boolean {
  const compact = candidate.replace(/\s/gu, "").toUpperCase();
  if (
    !recipeRegex(
      DETERMINISTIC_PUBLIC_RECIPE.algorithms.iban.compactShape,
    ).test(compact)
  ) {
    return false;
  }
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const expanded =
      character >= "0" && character <= "9"
        ? character
        : String(character.charCodeAt(0) - 55);
    for (const digit of expanded) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

const BIP39_WORDS = new Set(BIP39_ENGLISH);

function bip39Matches(text: string): Match[] {
  const tokens = [
    ...text.matchAll(
      recipeRegex(DETERMINISTIC_PUBLIC_RECIPE.bip39.wordToken),
    ),
  ].map((match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const matches: Match[] = [];
  for (let offset = 0; offset < tokens.length; offset += 1) {
    for (const length of DETERMINISTIC_PUBLIC_RECIPE.bip39.wordCounts) {
      const window = tokens.slice(offset, offset + length);
      if (
        window.length !== length ||
        window.some(({ word }) => !BIP39_WORDS.has(word)) ||
        window.slice(0, -1).some(({ end }, index) =>
          !recipeRegex(
            DETERMINISTIC_PUBLIC_RECIPE.bip39.separator,
          ).test(text.slice(end, window[index + 1]!.start)),
        )
      ) {
        continue;
      }
      matches.push({
        class: "funds-controlling-secret",
        start: window[0]!.start,
        end: window.at(-1)!.end,
        evidence: `bip39-mnemonic-${length}`,
      });
      break;
    }
  }
  return matches;
}

function entropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let result = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function entropyMatches(
  text: string,
  surface: DerivationSurface,
): Match[] {
  const matches: Match[] = [];
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.algorithms.entropy;
  for (const candidate of text.matchAll(recipeRegex(recipe.token))) {
    const leading =
      candidate[0].match(recipeRegex(recipe.leadingTrim))?.[0].length ?? 0;
    const token = candidate[0]
      .slice(leading)
      .replace(recipeRegex(recipe.trailingTrim), "");
    if (
      token.length < recipe.minimumLength ||
      !recipeRegex(recipe.alphabet).test(token) ||
      entropy(token) < recipe.bitsPerCharacter ||
      (token.length < recipe.strictLength &&
        !(/[a-z]/u.test(token) && /[A-Z0-9]/u.test(token))) ||
      recipeRegex(recipe.syntheticBenchmarkId).test(token) ||
      classifyTechnicalValue(token, {
        field: surface.location.split("/").at(-1),
      }) !== null
    ) {
      continue;
    }
    matches.push({
      class: "high-entropy-secret",
      start: candidate.index + leading,
      end: candidate.index + leading + token.length,
      confidence: "HIGH",
      evidence: "secret-high-entropy",
    });
  }
  return matches;
}

async function secretlintMatches(text: string): Promise<Match[]> {
  const result = await lintSource({
    source: {
      filePath: "/span",
      content: text,
      ext: ".txt",
      contentType: "text",
    },
    options: {
      config: {
        rules: [
          {
            id: "@secretlint/secretlint-rule-preset-recommend",
            rule: creator,
          },
        ],
      },
    },
  });
  return result.messages.map((message) => ({
    class: "credential",
    start: message.range[0],
    end: message.range[1],
    evidence: `secretlint-${message.ruleId
      .replace(/^@secretlint\/secretlint-rule-/u, "")
      .replace(/[^a-z0-9:-]/giu, "-")
      .toLowerCase()}`,
  }));
}

function gitleaksMatches(text: string): Match[] {
  return GITLEAKS_PACK.rules.flatMap((rule) =>
    regexMatches(
      text,
      new RegExp(rule.regex, "giu"),
      rule.id === "private-key" ? "funds-controlling-secret" : "credential",
      `gitleaks-${rule.id}`,
    ),
  );
}

function ipRange(ip: string): "public" | "private" | "ignored" {
  const octets = ip.split(".").map(Number);
  const address = octets.reduce(
    (value, octet) => value * 256 + octet,
    0,
  ) >>> 0;
  const inCidr = (cidr: string): boolean => {
    const [networkText, prefixText] = cidr.split("/");
    const networkOctets = networkText!.split(".").map(Number);
    while (networkOctets.length < 4) networkOctets.push(0);
    const network = networkOctets.reduce(
      (value, octet) => value * 256 + octet,
      0,
    ) >>> 0;
    const prefix = Number(prefixText);
    const mask = prefix === 0
      ? 0
      : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) === (network & mask);
  };
  if (
    DETERMINISTIC_PUBLIC_RECIPE.algorithms.ipRanges.ignore.some(inCidr)
  ) {
    return "ignored";
  }
  if (
    DETERMINISTIC_PUBLIC_RECIPE.algorithms.ipRanges.private.some(inCidr)
  ) {
    return "private";
  }
  return "public";
}

async function patternMatches(
  text: string,
  surface: DerivationSurface,
): Promise<Match[]> {
  const matches = [
    ...gitleaksMatches(text),
    ...(await secretlintMatches(text)),
    ...regexMatches(
      text,
      recipeRegex(DETERMINISTIC_PUBLIC_RECIPE.patterns.email),
      "email",
      "email-shape",
    ),
    ...regexMatches(
      text,
      recipeRegex(DETERMINISTIC_PUBLIC_RECIPE.patterns.absolutePath),
      "absolute-path",
      "home-path",
    ),
    ...regexMatches(
      text,
      recipeRegex(
        DETERMINISTIC_PUBLIC_RECIPE.patterns.credentialToken,
      ),
      "credential",
      "credential-token-shape",
    ),
    ...regexMatches(
      text,
      recipeRegex(
        DETERMINISTIC_PUBLIC_RECIPE.patterns.cloudCredential,
      ),
      "credential",
      "cloud-credential-id",
    ),
    ...regexMatches(
      text,
      recipeRegex(
        DETERMINISTIC_PUBLIC_RECIPE.patterns.urlCredential,
      ),
      "url-credential",
      "url-credential",
    ),
    ...regexMatches(
      text,
      recipeRegex(DETERMINISTIC_PUBLIC_RECIPE.patterns.walletAddress),
      "wallet-address",
      "wallet-address",
    ),
    ...regexMatches(
      text,
      recipeRegex(
        DETERMINISTIC_PUBLIC_RECIPE.patterns.gitIdentityCarrier,
      ),
      "git-identity",
      "git-identity-carrier",
    ),
    ...regexMatches(
      text,
      recipeRegex(
        DETERMINISTIC_PUBLIC_RECIPE.patterns.machineIdentityCarrier,
      ),
      "machine-identity",
      "machine-identity-carrier",
    ),
  ];
  const keyContext = recipeRegex(
    DETERMINISTIC_PUBLIC_RECIPE.patterns.privateKeyContext,
  );
  if (keyContext.test(text)) {
    matches.push(
      ...regexMatches(
        text,
        recipeRegex(DETERMINISTIC_PUBLIC_RECIPE.patterns.privateKeyHex),
        "funds-controlling-secret",
        "private-key-hex64",
      ),
    );
  }
  matches.push(...bip39Matches(text));
  const env = recipeRegex(
    DETERMINISTIC_PUBLIC_RECIPE.patterns.environmentBlock,
  );
  matches.push(
    ...regexMatches(text, env, "environment-dump", "environment-assignment-run"),
  );
  const card = recipeRegex(
    DETERMINISTIC_PUBLIC_RECIPE.patterns.paymentCardCandidate,
  );
  for (const candidate of text.matchAll(card)) {
    if (luhn(candidate[0])) {
      matches.push({
        class: "payment-instrument",
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        evidence: "luhn-valid-card",
      });
    }
  }
  const iban = recipeRegex(
    DETERMINISTIC_PUBLIC_RECIPE.patterns.ibanCandidate,
  );
  for (const candidate of text.matchAll(iban)) {
    if (ibanMod97(candidate[0])) {
      matches.push({
        class: "payment-instrument",
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        evidence: "iban-mod97",
      });
    }
  }
  const ipv4 = recipeRegex(
    DETERMINISTIC_PUBLIC_RECIPE.patterns.ipv4Candidate,
  );
  for (const candidate of text.matchAll(ipv4)) {
    const range = ipRange(candidate[0]);
    if (range !== "ignored") {
      matches.push({
        class: "ip-address",
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        confidence: range === "public" ? "VERY_HIGH" : "MEDIUM",
        evidence: `ipv4-${range}`,
      });
    }
  }
  matches.push(...entropyMatches(text, surface));
  return matches;
}

export function createBuiltinDerivationDetectors(
  options: BuiltinDetectorOptions,
): readonly DerivationDetector[] {
  options = snapshotInertData(options, "built-in detector options");
  const configuration = options?.privateConfiguration;
  if (
    !configuration ||
    configuration.schemaVersion !==
      "jinn.private-detector-configuration.v1" ||
    typeof configuration.nonce !== "string" ||
    configuration.nonce.length < 32 ||
    !Array.isArray(configuration.knownIdentities) ||
    !Array.isArray(configuration.privateAllowlist)
  ) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Built-in detector private configuration requires a nonce of at least 128 bits.",
    );
  }
  const configurationDigest = sha256Digest(
    canonicalJsonBytes({
      schemaVersion: configuration.schemaVersion,
      nonce: configuration.nonce,
      knownIdentities: configuration.knownIdentities,
      privateAllowlist: configuration.privateAllowlist,
    }),
  );
  const knownDescriptor = descriptor(
    "known-identity",
    {
      schemaVersion: DETERMINISTIC_PUBLIC_RECIPE.schemaVersion,
      mechanism:
        DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration
          .knownIdentityMechanism,
      privateConfigurationSchema:
        DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration.schemaVersion,
    },
    configurationDigest,
  );
  const knownValues = Object.freeze([...configuration.knownIdentities]);
  const privateAllowlist = Object.freeze([...configuration.privateAllowlist]);
  const knownIdentity: DerivationDetector = Object.freeze({
    descriptor: knownDescriptor,
    async detect(
      surface: DerivationSurface,
      operationOptions?: DerivationOperationOptions,
    ) {
      if (operationOptions?.signal?.aborted) {
        throw new EvidenceDerivationError(
          "OPERATION_ABORTED",
          "Derivation was aborted.",
        );
      }
      const results: DerivationFinding[] = [];
      for (const value of knownValues) {
        if (!value) continue;
        let offset = surface.text.indexOf(value);
        while (offset >= 0) {
          results.push(
            finding(
              surface,
              {
                class: "known-identity",
                start: offset,
                end: offset + value.length,
                evidence: "known-identity-exact",
              },
              knownDescriptor,
            ),
          );
          offset = surface.text.indexOf(value, offset + value.length);
        }
      }
      return results;
    },
  });
  const patternsDescriptor = descriptor(
    "deterministic-patterns",
    DETERMINISTIC_PUBLIC_RECIPE,
    configurationDigest,
  );
  const patterns: DerivationDetector = Object.freeze({
    descriptor: patternsDescriptor,
    async detect(
      surface: DerivationSurface,
      operationOptions?: DerivationOperationOptions,
    ) {
      if (operationOptions?.signal?.aborted) {
        throw new EvidenceDerivationError(
          "OPERATION_ABORTED",
          "Derivation was aborted.",
        );
      }
      const matches = await patternMatches(surface.text, surface);
      if (operationOptions?.signal?.aborted) {
        throw new EvidenceDerivationError(
          "OPERATION_ABORTED",
          "Derivation was aborted.",
        );
      }
      return matches
        .filter((match) => {
          const matched = surface.text.slice(match.start, match.end);
          return !privateAllowlist.some(
            (allowed) => allowed.length > 0 && matched.includes(allowed),
          );
        })
        .map((match) => finding(surface, match, patternsDescriptor));
    },
  });
  return Object.freeze([knownIdentity, patterns]);
}

function descriptorKey(descriptorValue: DerivationDetectorDescriptor): string {
  return [
    descriptorValue.id,
    descriptorValue.version,
    descriptorValue.implementationDigest,
    descriptorValue.reproducibility,
    descriptorValue.configurationDigest ?? "",
  ].join("\u0000");
}

function snapshotDescriptor(
  value: unknown,
  errorCode: "INVALID_DERIVATION_INPUT" | "DETECTOR_CONTRACT_VIOLATION",
): DerivationDetectorDescriptor {
  try {
    const snapshot = snapshotInertData(
      value,
      "detector descriptor",
    ) as DerivationDetectorDescriptor;
    const parsed = derivationDetectorDescriptorSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new Error("invalid detector descriptor");
    }
    return Object.freeze({
      ...parsed.data,
    }) as DerivationDetectorDescriptor;
  } catch (cause) {
    throw new EvidenceDerivationError(
      errorCode,
      "Detector descriptor is invalid.",
      { cause },
    );
  }
}

export function normalizeDetectorFindings(
  surface: DerivationSurface,
  findings: readonly DerivationFinding[],
  expectedDescriptor?: DerivationDetectorDescriptor,
): readonly DerivationFinding[] {
  let findingSnapshots: readonly DerivationFinding[];
  try {
    assertNotProxy(findings, "Detector findings must not be a Proxy.");
    findingSnapshots = snapshotInertData(
      findings,
      "detector findings",
    );
  } catch (cause) {
    throw new EvidenceDerivationError(
      "DETECTOR_CONTRACT_VIOLATION",
      "Detector findings must be an inert array.",
      { cause },
    );
  }
  if (!Array.isArray(findings)) {
    throw new EvidenceDerivationError(
      "DETECTOR_CONTRACT_VIOLATION",
      "Detector findings must be an array.",
    );
  }
  const expected = expectedDescriptor
    ? snapshotDescriptor(expectedDescriptor, "DETECTOR_CONTRACT_VIOLATION")
    : undefined;
  const normalized: DerivationFinding[] = [];
  for (const rawCandidate of findingSnapshots) {
    let candidate: DerivationFinding;
    let detectorValue: DerivationDetectorDescriptor;
    try {
      candidate = snapshotInertData(
        rawCandidate,
        "detector finding",
      ) as DerivationFinding;
      detectorValue = snapshotDescriptor(
        candidate.detector,
        "DETECTOR_CONTRACT_VIOLATION",
      );
    } catch (cause) {
      if (
        cause instanceof EvidenceDerivationError &&
        cause.code === "DETECTOR_CONTRACT_VIOLATION"
      ) {
        throw cause;
      }
      throw new EvidenceDerivationError(
        "DETECTOR_CONTRACT_VIOLATION",
        "Detector emitted a behavioral or invalid finding.",
        { cause },
      );
    }
    const candidateKeys = Object.keys(candidate).sort();
    if (
      JSON.stringify(candidateKeys) !==
        JSON.stringify([
          "class",
          "confidence",
          "detector",
          "end",
          "evidence",
          "start",
          "surfaceId",
        ]) ||
      candidate.surfaceId !== surface.surfaceId ||
      !Number.isInteger(candidate.start) ||
      !Number.isInteger(candidate.end) ||
      candidate.start < 0 ||
      candidate.end <= candidate.start ||
      candidate.end > surface.text.length ||
      typeof candidate.class !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(candidate.class) ||
      ![
        "VERY_LOW",
        "LOW",
        "MEDIUM",
        "HIGH",
        "VERY_HIGH",
      ].includes(candidate.confidence) ||
      !Array.isArray(candidate.evidence) ||
      candidate.evidence.some(
        (code) =>
          typeof code !== "string" ||
          !/^[a-z0-9][a-z0-9:-]*$/.test(code) ||
          code.includes(surface.text.slice(candidate.start, candidate.end)),
      ) ||
      (expected && descriptorKey(detectorValue) !== descriptorKey(expected))
    ) {
      throw new EvidenceDerivationError(
        "DETECTOR_CONTRACT_VIOLATION",
        "Detector emitted an invalid finding.",
      );
    }
    normalized.push(
      Object.freeze({
        class: candidate.class,
        confidence: candidate.confidence,
        surfaceId: candidate.surfaceId,
        start: candidate.start,
        end: candidate.end,
        evidence: Object.freeze([...candidate.evidence]),
        detector: detectorValue,
      }),
    );
  }
  normalized.sort(
    (left, right) =>
      left.surfaceId.localeCompare(right.surfaceId) ||
      left.start - right.start ||
      left.end - right.end ||
      left.class.localeCompare(right.class) ||
      descriptorKey(left.detector).localeCompare(descriptorKey(right.detector)),
  );
  const unique = normalized.filter(
    (candidate, index) =>
      index === 0 ||
      JSON.stringify(candidate) !== JSON.stringify(normalized[index - 1]),
  );
  return Object.freeze(unique);
}

export function snapshotDetectors(
  detectors: CreateEvidenceDeriverOptions["detectors"],
): readonly DerivationDetector[] {
  assertNotProxy(detectors, "Detector array must not be a Proxy.");
  if (!Array.isArray(detectors)) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Detectors must be an explicit array.",
    );
  }
  const ids = new Set<string>();
  return Object.freeze(
    detectors.map((detector) => {
      assertNotProxy(detector, "Detector must not be a Proxy.");
      if (!detector || typeof detector !== "object") {
        throw new EvidenceDerivationError(
          "INVALID_DERIVATION_INPUT",
          "Detector must be an inert object.",
        );
      }
      const own = Object.getOwnPropertyDescriptors(detector);
      if (
        Reflect.ownKeys(own).some(
          (key) =>
            typeof key !== "string" ||
            !["descriptor", "detect"].includes(key) ||
            !("value" in own[key]!),
        )
      ) {
        throw new EvidenceDerivationError(
          "INVALID_DERIVATION_INPUT",
          "Detector must contain only own descriptor and detect data properties.",
        );
      }
      const descriptorValue = snapshotDescriptor(
        ownDataProperty(detector, "descriptor", "detector"),
        "INVALID_DERIVATION_INPUT",
      );
      const detect = ownDataProperty(detector, "detect", "detector");
      assertNotProxy(detect, "Detector callable must not be a Proxy.");
      if (typeof detect !== "function") {
        throw new EvidenceDerivationError(
          "INVALID_DERIVATION_INPUT",
          "Detector detect slot must be a callable data property.",
        );
      }
      if (ids.has(descriptorValue.id)) {
        throw new EvidenceDerivationError(
          "INVALID_DERIVATION_INPUT",
          "Detector ids must be unique.",
        );
      }
      ids.add(descriptorValue.id);
      return Object.freeze({
        descriptor: descriptorValue,
        async detect(
          surface: DerivationSurface,
          options?: DerivationOperationOptions,
        ) {
          return Reflect.apply(detect, undefined, [surface, options]) as Promise<
            readonly DerivationFinding[]
          >;
        },
      });
    }),
  );
}
