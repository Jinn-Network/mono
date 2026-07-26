// SPDX-License-Identifier: Apache-2.0

import { lintSource } from "@secretlint/core";
import { creator } from "@secretlint/secretlint-rule-preset-recommend";

import { canonicalJsonBytes, sha256Digest } from "../bytes.js";
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

function descriptor(
  id: string,
  controlledImplementation: unknown,
  configurationDigest?: `sha256:${string}`,
): DerivationDetectorDescriptor {
  return Object.freeze({
    id,
    version: "1.1.0",
    implementationDigest: sha256Digest(
      canonicalJsonBytes({
        id,
        version: "1.1.0",
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
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
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
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(compact)) return false;
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
  const tokens = [...text.matchAll(/[A-Za-z]+/gu)].map((match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const matches: Match[] = [];
  for (let offset = 0; offset < tokens.length; offset += 1) {
    for (const length of [24, 12] as const) {
      const window = tokens.slice(offset, offset + length);
      if (
        window.length !== length ||
        window.some(({ word }) => !BIP39_WORDS.has(word)) ||
        window.slice(0, -1).some(({ end }, index) =>
          !/^[\s,;|"'`]+$/u.test(
            text.slice(end, window[index + 1]!.start),
          ),
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
  for (const candidate of text.matchAll(/\S+/gu)) {
    const leading = candidate[0].match(/^[("'`[{},;:]*/u)?.[0].length ?? 0;
    const token = candidate[0]
      .slice(leading)
      .replace(/[)"'`\]},;:.]*$/u, "");
    if (
      token.length < 16 ||
      !/^[A-Za-z0-9+/=_-]+$/u.test(token) ||
      entropy(token) < 4 ||
      (token.length < 20 &&
        !(/[a-z]/u.test(token) && /[A-Z0-9]/u.test(token))) ||
      /^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*-\d+$/u.test(token) ||
      classifyTechnicalValue(token, {
        field: surface.location.split("/").at(-1),
      }) !== null
    ) {
      continue;
    }
    matches.push({
      class: "credential",
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
  const [a, b, c] = ip.split(".").map(Number);
  if (
    a === 127 ||
    a === 0 ||
    a === 255 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a !== undefined && a >= 224)
  ) {
    return "ignored";
  }
  if (
    a === 10 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
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
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "email",
      "email-shape",
    ),
    ...regexMatches(
      text,
      /\/(?:Users|home)\/[^/\s"'`]+/g,
      "absolute-path",
      "home-path",
    ),
    ...regexMatches(
      text,
      /\b(?:ghp_|xox[baprs]-|npm_|sk-(?:proj-)?|rk_live_|sk_live_)[A-Za-z0-9_-]{16,}\b/g,
      "credential",
      "credential-token-shape",
    ),
    ...regexMatches(
      text,
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{35}/g,
      "credential",
      "cloud-credential-id",
    ),
    ...regexMatches(
      text,
      /https?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+|[?&](?:token|key|secret|password)=[^&\s]+/gi,
      "url-credential",
      "url-credential",
    ),
    ...regexMatches(
      text,
      /\b0x[a-fA-F0-9]{40}\b/g,
      "wallet-address",
      "wallet-address",
    ),
    ...regexMatches(
      text,
      /(?:^|\n)(?:Author|Committer):[^\n]+|(?:user\.name|user\.email)\s*=[^\n]+/g,
      "git-identity",
      "git-identity-carrier",
    ),
    ...regexMatches(
      text,
      /\b(?:hostname|machine(?:-name)?)\s*[:=]\s*[A-Za-z0-9._-]+/gi,
      "machine-identity",
      "machine-identity-carrier",
    ),
  ];
  const keyContext =
    /\b(?:private[_\s-]?key|privkey|secret[_\s-]?key|wallet[_\s-]?key|signing[_\s-]?key)\b/i;
  if (keyContext.test(text)) {
    matches.push(
      ...regexMatches(
        text,
        /(?<!0x)\b[a-fA-F0-9]{64}\b/g,
        "funds-controlling-secret",
        "private-key-hex64",
      ),
    );
  }
  matches.push(...bip39Matches(text));
  const env = /(?:^|\n)(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*(?:\n(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*){2,}/g;
  matches.push(
    ...regexMatches(text, env, "environment-dump", "environment-assignment-run"),
  );
  const card = /\b(?:\d[ -]*?){13,19}\b/g;
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
  const iban =
    /\b(?:[A-Z]{2}\d{2}[A-Z0-9]{11,30}|[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/giu;
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
  const ipv4 =
    /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
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
      mechanism: "exact-code-point-substring",
      privateConfigurationSchema: configuration.schemaVersion,
    },
    configurationDigest,
  );
  const knownValues = Object.freeze([...configuration.knownIdentities]);
  const privateAllowlist = Object.freeze([...configuration.privateAllowlist]);
  const knownIdentity: DerivationDetector = Object.freeze({
    descriptor: knownDescriptor,
    async detect(surface: DerivationSurface) {
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
    {
      mechanisms: [
        "plain-patterns",
        "git-identity",
        "secretlint-preset-recommend",
        "gitleaks-subset",
        "entropy-fallback",
        "context-private-key",
        "bip39-english",
        "environment-block",
        "luhn",
        "iban-mod97",
        "ip-range",
      ],
      secretlintVersion: "13.0.4",
      gitleaks: GITLEAKS_PACK,
      bip39WordlistDigest: sha256Digest(canonicalJsonBytes(BIP39_ENGLISH)),
      entropy: { minimumLength: 16, strictLength: 20, bitsPerCharacter: 4 },
      privateConfigurationSchema: configuration.schemaVersion,
    },
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
    const keys = Object.keys(snapshot).sort();
    const expected = [
      "id",
      "implementationDigest",
      "reproducibility",
      "version",
      ...(snapshot.configurationDigest ? ["configurationDigest"] : []),
    ].sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(expected) ||
      typeof snapshot.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(snapshot.id) ||
      typeof snapshot.version !== "string" ||
      snapshot.version.length === 0 ||
      !/^sha256:[a-f0-9]{64}$/u.test(snapshot.implementationDigest) ||
      !["byte-stable", "best-effort"].includes(snapshot.reproducibility) ||
      (snapshot.configurationDigest !== undefined &&
        !/^sha256:[a-f0-9]{64}$/u.test(snapshot.configurationDigest))
    ) {
      throw new Error("invalid detector descriptor");
    }
    return Object.freeze({ ...snapshot });
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
  try {
    assertNotProxy(findings, "Detector findings must not be a Proxy.");
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
  for (const rawCandidate of findings) {
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
    if (
      candidate.surfaceId !== surface.surfaceId ||
      !Number.isInteger(candidate.start) ||
      !Number.isInteger(candidate.end) ||
      candidate.start < 0 ||
      candidate.end <= candidate.start ||
      candidate.end > surface.text.length ||
      !candidate.class ||
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
        ...candidate,
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
