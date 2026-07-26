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
import {
  BUILTIN_DETECTOR_VERSION,
  builtinDetectorImplementationDigest,
  DETERMINISTIC_PUBLIC_RECIPE,
  type RegexRecipe,
} from "./recipe.js";
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
  readonly confidence: ConfidenceBand;
  readonly evidence: string;
};

function recipeRegex(
  recipe: RegexRecipe,
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
    version: BUILTIN_DETECTOR_VERSION,
    implementationDigest: builtinDetectorImplementationDigest(
      id,
      controlledImplementation,
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
    confidence: match.confidence,
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
  confidence: ConfidenceBand,
): Match[] {
  const matches: Match[] = [];
  const execution = DETERMINISTIC_PUBLIC_RECIPE.regexExecution;
  const regex = new RegExp(
    pattern.source,
    execution.ensureGlobalFlag && !pattern.flags.includes("g")
      ? `${pattern.flags}g`
      : pattern.flags,
  );
  let result: RegExpExecArray | null;
  while ((result = regex.exec(text)) !== null) {
    if (result[0].length === 0) {
      regex.lastIndex += execution.zeroLengthAdvanceCodeUnits;
      continue;
    }
    matches.push({
      class: classification,
      start: result.index,
      end: result.index + result[0].length,
      evidence,
      confidence,
    });
  }
  return matches;
}

function luhn(candidate: string): boolean {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.algorithms.luhn;
  const digits = candidate.replace(recipeRegex(recipe.nonDigit), "");
  const { minimumDigits, maximumDigits } = recipe;
  if (digits.length < minimumDigits || digits.length > maximumDigits) {
    return false;
  }
  if (
    recipe.rejectRepeatedDigit &&
    recipeRegex(recipe.repeatedDigit).test(digits)
  ) {
    return false;
  }
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (alternate && recipe.doubleEverySecondFromRight) {
      value *= 2;
      if (value > 9) value -= recipe.doubledDigitReduction;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % recipe.modulus === recipe.validRemainder;
}

function ibanMod97(candidate: string): boolean {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.algorithms.iban;
  const compact = candidate
    .replace(recipeRegex(recipe.whitespace), "")
    .toUpperCase();
  if (
    compact.length < recipe.compactMinimumLength ||
    compact.length > recipe.compactMaximumLength ||
    !recipeRegex(recipe.compactShape).test(compact)
  ) {
    return false;
  }
  const rearranged =
    compact.slice(recipe.rearrangePrefixLength) +
    compact.slice(0, recipe.rearrangePrefixLength);
  let remainder = 0;
  for (const character of rearranged) {
    const expanded =
      character >= "0" && character <= "9"
        ? character
        : String(character.charCodeAt(0) - recipe.alphaNumericOffset);
    for (const digit of expanded) {
      remainder =
        (remainder * 10 + Number(digit)) % recipe.modulus;
    }
  }
  return remainder === recipe.validRemainder;
}

const BIP39_WORDS = new Set(BIP39_ENGLISH);

function bip39Matches(text: string): Match[] {
  const tokens = [
    ...text.matchAll(
      recipeRegex(DETERMINISTIC_PUBLIC_RECIPE.bip39.wordToken),
    ),
  ].map((match) => ({
    word:
      DETERMINISTIC_PUBLIC_RECIPE.bip39.wordNormalization === "lowercase"
        ? match[0].toLowerCase()
        : match[0],
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
        class: DETERMINISTIC_PUBLIC_RECIPE.bip39.finding.class,
        start: window[0]!.start,
        end: window.at(-1)!.end,
        confidence:
          DETERMINISTIC_PUBLIC_RECIPE.bip39.finding.confidence,
        evidence:
          `${DETERMINISTIC_PUBLIC_RECIPE.bip39.finding.evidencePrefix}${length}`,
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
    result -=
      probability *
      (Math.log(probability) /
        Math.log(
          DETERMINISTIC_PUBLIC_RECIPE.algorithms.entropy.logarithmBase,
        ));
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
        !(
          recipeRegex(recipe.lowercaseRequiredBelowStrictLength).test(token) &&
          recipeRegex(
            recipe.upperOrDigitRequiredBelowStrictLength,
          ).test(token)
        )) ||
      recipeRegex(recipe.syntheticBenchmarkId).test(token) ||
      classifyTechnicalValue(token, {
        field: surface.location.split("/").at(-1),
      }) !== null
    ) {
      continue;
    }
    matches.push({
      class: recipe.finding.class,
      start: candidate.index + leading,
      end: candidate.index + leading + token.length,
      confidence: recipe.finding.confidence,
      evidence: recipe.finding.evidence,
    });
  }
  return matches;
}

async function secretlintMatches(text: string): Promise<Match[]> {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.secretlint;
  const result = await lintSource({
    source: {
      filePath: recipe.invocation.source.filePath,
      content: text,
      ext: recipe.invocation.source.ext,
      contentType: recipe.invocation.source.contentType,
    },
    options: {
      config: {
        rules: [
          {
            id: recipe.invocation.ruleId,
            rule: creator,
          },
        ],
      },
    },
  });
  return result.messages.map((message) => ({
    class: recipe.finding.class,
    start: message.range[0],
    end: message.range[1],
    confidence: recipe.finding.confidence,
    evidence: `${recipe.finding.evidencePrefix}${
      (recipe.finding.lowercase
        ? message.ruleId
            .replace(recipeRegex(recipe.finding.stripRuleId), "")
            .replace(
              recipeRegex(recipe.finding.unsafeEvidenceCharacters),
              recipe.finding.unsafeEvidenceReplacement,
            )
            .toLowerCase()
        : message.ruleId)
    }`,
  }));
}

function gitleaksMatches(text: string): Match[] {
  const recipe = DETERMINISTIC_PUBLIC_RECIPE.gitleaks;
  return recipe.pack.rules.flatMap((rule) =>
    regexMatches(
      text,
      new RegExp(rule.regex, recipe.invocation.flags),
      recipe.finding.classByRuleId[
        rule.id as keyof typeof recipe.finding.classByRuleId
      ] ?? recipe.finding.defaultClass,
      `${recipe.finding.evidencePrefix}${rule.id}`,
      recipe.finding.confidence,
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
  const patterns = DETERMINISTIC_PUBLIC_RECIPE.patterns;
  const fromRule = (
    rule: {
      readonly regex: RegexRecipe;
      readonly class: string;
      readonly evidence: string;
      readonly confidence: ConfidenceBand;
    },
  ): Match[] =>
    regexMatches(
      text,
      recipeRegex(rule.regex),
      rule.class,
      rule.evidence,
      rule.confidence,
    );
  const matches = [
    ...gitleaksMatches(text),
    ...(await secretlintMatches(text)),
    ...fromRule(patterns.email),
    ...fromRule(patterns.absolutePath),
    ...DETERMINISTIC_PUBLIC_RECIPE.technicalClassifier
      .credentialPrecedence.additional.flatMap(fromRule),
    ...fromRule(patterns.urlCredential),
    ...fromRule(patterns.walletAddress),
    ...fromRule(patterns.gitIdentityCarrier),
    ...fromRule(patterns.machineIdentityCarrier),
  ];
  const keyContext = recipeRegex(patterns.privateKeyContext.regex);
  if (keyContext.test(text)) {
    matches.push(...fromRule(patterns.privateKeyHex));
  }
  matches.push(...bip39Matches(text));
  matches.push(...fromRule(patterns.environmentBlock));
  const card = recipeRegex(patterns.paymentCardCandidate.regex);
  const luhnRecipe = DETERMINISTIC_PUBLIC_RECIPE.algorithms.luhn;
  for (const candidate of text.matchAll(card)) {
    if (luhn(candidate[0])) {
      matches.push({
        class: luhnRecipe.finding.class,
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        confidence: luhnRecipe.finding.confidence,
        evidence: luhnRecipe.finding.evidence,
      });
    }
  }
  const iban = recipeRegex(patterns.ibanCandidate.regex);
  const ibanRecipe = DETERMINISTIC_PUBLIC_RECIPE.algorithms.iban;
  for (const candidate of text.matchAll(iban)) {
    if (ibanMod97(candidate[0])) {
      matches.push({
        class: ibanRecipe.finding.class,
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        confidence: ibanRecipe.finding.confidence,
        evidence: ibanRecipe.finding.evidence,
      });
    }
  }
  const ipv4 = recipeRegex(patterns.ipv4Candidate.regex);
  const ipRecipe = DETERMINISTIC_PUBLIC_RECIPE.algorithms.ipRanges;
  for (const candidate of text.matchAll(ipv4)) {
    const range = ipRange(candidate[0]);
    if (range !== "ignored") {
      matches.push({
        class: ipRecipe.finding.class,
        start: candidate.index,
        end: candidate.index + candidate[0].length,
        confidence:
          range === "public"
            ? ipRecipe.finding.publicConfidence
            : ipRecipe.finding.privateConfidence,
        evidence: `${ipRecipe.finding.evidencePrefix}${range}`,
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
    configuration.knownIdentities.some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    !Array.isArray(configuration.privateAllowlist) ||
    configuration.privateAllowlist.some(
      (value) => typeof value !== "string" || value.length === 0,
    )
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
      valueValidation:
        DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration
          .valueValidation,
      finding:
        DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration
          .knownIdentityFinding,
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
        let offset = surface.text.indexOf(value);
        while (offset >= 0) {
          results.push(
            finding(
              surface,
              {
                class:
                  DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration
                    .knownIdentityFinding.class,
                start: offset,
                end: offset + value.length,
                confidence:
                  DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration
                    .knownIdentityFinding.confidence,
                evidence:
                  DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration
                    .knownIdentityFinding.evidence,
              },
              knownDescriptor,
            ),
          );
          offset = surface.text.indexOf(
            value,
            offset +
              (DETERMINISTIC_PUBLIC_RECIPE.privateConfiguration
                .knownIdentityMechanism.matchAdvance ===
              "matched-length"
                ? value.length
                : 1),
          );
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

function splitsSurrogatePair(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= text.length) return false;
  const previous = text.charCodeAt(boundary - 1);
  const next = text.charCodeAt(boundary);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
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
    const offsetsValid =
      Number.isInteger(candidate.start) &&
      Number.isInteger(candidate.end) &&
      candidate.start >= 0 &&
      candidate.end > candidate.start &&
      candidate.end <= surface.text.length &&
      !splitsSurrogatePair(surface.text, candidate.start) &&
      !splitsSurrogatePair(surface.text, candidate.end);
    const matchedPlaintext = offsetsValid
      ? surface.text.slice(candidate.start, candidate.end).toLowerCase()
      : undefined;
    const reflectsMatchedPlaintext = (value: string): boolean =>
      matchedPlaintext !== undefined &&
      value.toLowerCase().includes(matchedPlaintext);
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
      !offsetsValid ||
      typeof candidate.class !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(candidate.class) ||
      reflectsMatchedPlaintext(candidate.class) ||
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
          reflectsMatchedPlaintext(code),
      ) ||
      reflectsMatchedPlaintext(detectorValue.id) ||
      reflectsMatchedPlaintext(detectorValue.version) ||
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
