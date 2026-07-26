// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, sha256Digest } from "../bytes.js";
import { BIP39_ENGLISH } from "./data/bip39-english.js";
import { GITLEAKS_PACK } from "./data/gitleaks-rules.js";

export interface RegexRecipe {
  readonly source: string;
  readonly flags: string;
}

export function regexRecipe(value: RegExp): RegexRecipe {
  return Object.freeze({ source: value.source, flags: value.flags });
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const BUILTIN_DETECTOR_VERSION = "1.3.0";

export const DETERMINISTIC_PUBLIC_RECIPE = deepFreeze({
  schemaVersion: "jinn.evidence-derivation.detector-recipe.v2",
  regexExecution: {
    ensureGlobalFlag: true,
    zeroLengthAdvanceCodeUnits: 1,
    offsets: "utf16-code-units",
  },
  dependencies: {
    secretlintCore: {
      package: "@secretlint/core",
      version: "13.0.4",
    },
    secretlintPreset: {
      package: "@secretlint/secretlint-rule-preset-recommend",
      version: "13.0.4",
    },
  },
  secretlint: {
    invocation: {
      source: {
        filePath: "/span",
        ext: ".txt",
        contentType: "text",
      },
      ruleId: "@secretlint/secretlint-rule-preset-recommend",
    },
    finding: {
      class: "credential",
      confidence: "VERY_HIGH",
      evidencePrefix: "secretlint-",
      stripRuleId: regexRecipe(/^@secretlint\/secretlint-rule-/u),
      unsafeEvidenceCharacters: regexRecipe(/[^a-z0-9:-]/giu),
      unsafeEvidenceReplacement: "-",
      lowercase: true,
    },
  },
  gitleaks: {
    pack: GITLEAKS_PACK,
    invocation: {
      flags: "giu",
    },
    finding: {
      defaultClass: "credential",
      classByRuleId: {
        "private-key": "funds-controlling-secret",
      },
      confidence: "VERY_HIGH",
      evidencePrefix: "gitleaks-",
    },
  },
  bip39: {
    wordlistDigest: sha256Digest(canonicalJsonBytes(BIP39_ENGLISH)),
    wordToken: regexRecipe(/[A-Za-z]+/gu),
    separator: regexRecipe(/^[\s,;|"'`]+$/u),
    wordCounts: [24, 12],
    wordNormalization: "lowercase",
    finding: {
      class: "funds-controlling-secret",
      confidence: "VERY_HIGH",
      evidencePrefix: "bip39-mnemonic-",
    },
  },
  patterns: {
    email: {
      regex: regexRecipe(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
      ),
      class: "email",
      confidence: "VERY_HIGH",
      evidence: "email-shape",
    },
    absolutePath: {
      regex: regexRecipe(/\/(?:Users|home)\/[^/\s"'`]+/gu),
      class: "absolute-path",
      confidence: "VERY_HIGH",
      evidence: "home-path",
    },
    urlCredential: {
      regex: regexRecipe(
        /https?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+|[?&](?:token|key|secret|password)=[^&\s]+/giu,
      ),
      class: "url-credential",
      confidence: "VERY_HIGH",
      evidence: "url-credential",
    },
    walletAddress: {
      regex: regexRecipe(/\b0x[a-fA-F0-9]{40}\b/gu),
      class: "wallet-address",
      confidence: "VERY_HIGH",
      evidence: "wallet-address",
    },
    gitIdentityCarrier: {
      regex: regexRecipe(
        /(?:^|\n)(?:(?:Author|Committer|Signed-off-by|Co-authored-by|Reviewed-by|Acked-by):[^\n]+|(?:user\.name|user\.email|GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL))\s*[:=][^\n]+)/giu,
      ),
      class: "git-identity",
      confidence: "VERY_HIGH",
      evidence: "git-identity-carrier",
    },
    machineIdentityCarrier: {
      regex: regexRecipe(
        /\b(?:hostname|machine(?:-name)?)\s*[:=]\s*[A-Za-z0-9._-]+/giu,
      ),
      class: "machine-identity",
      confidence: "VERY_HIGH",
      evidence: "machine-identity-carrier",
    },
    privateKeyContext: {
      regex: regexRecipe(
        /\b(?:private[_\s-]?key|privkey|secret[_\s-]?key|wallet[_\s-]?key|signing[_\s-]?key)\b/iu,
      ),
    },
    privateKeyHex: {
      regex: regexRecipe(/(?<!0x)\b[a-fA-F0-9]{64}\b/gu),
      class: "funds-controlling-secret",
      confidence: "VERY_HIGH",
      evidence: "private-key-hex64",
    },
    environmentBlock: {
      regex: regexRecipe(
        /(?:^|\n)(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*(?:\n(?:export\s+)?[A-Z][A-Z0-9_]*=[^\n]*){2,}/gu,
      ),
      class: "environment-dump",
      confidence: "VERY_HIGH",
      evidence: "environment-assignment-run",
    },
    paymentCardCandidate: {
      regex: regexRecipe(/\b(?:\d[ -]*?){13,19}\b/gu),
    },
    ibanCandidate: {
      regex: regexRecipe(
        /\b(?:[A-Z]{2}\d{2}[A-Z0-9]{11,30}|[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/giu,
      ),
    },
    ipv4Candidate: {
      regex: regexRecipe(
        /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/gu,
      ),
    },
  },
  algorithms: {
    luhn: {
      name: "ISO/IEC-7812-Luhn",
      minimumDigits: 13,
      maximumDigits: 19,
      nonDigit: regexRecipe(/\D/gu),
      repeatedDigit: regexRecipe(/^(\d)\1+$/u),
      rejectRepeatedDigit: true,
      doubleEverySecondFromRight: true,
      doubledDigitReduction: 9,
      modulus: 10,
      validRemainder: 0,
      finding: {
        class: "payment-instrument",
        confidence: "VERY_HIGH",
        evidence: "luhn-valid-card",
      },
    },
    iban: {
      name: "ISO-13616-mod-97",
      whitespace: regexRecipe(/\s/gu),
      compactMinimumLength: 15,
      compactMaximumLength: 34,
      compactShape: regexRecipe(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u),
      rearrangePrefixLength: 4,
      alphaNumericOffset: 55,
      modulus: 97,
      validRemainder: 1,
      finding: {
        class: "payment-instrument",
        confidence: "VERY_HIGH",
        evidence: "iban-mod97",
      },
    },
    ipRanges: {
      ignore: [
        "0/8",
        "127/8",
        "169.254/16",
        "192.0.2/24",
        "198.51.100/24",
        "203.0.113/24",
        "224/4",
        "255/8",
      ],
      private: ["10/8", "172.16/12", "192.168/16"],
      finding: {
        class: "ip-address",
        publicConfidence: "VERY_HIGH",
        privateConfidence: "MEDIUM",
        evidencePrefix: "ipv4-",
      },
    },
    entropy: {
      minimumLength: 16,
      strictLength: 20,
      bitsPerCharacter: 4,
      logarithmBase: 2,
      token: regexRecipe(/\S+/gu),
      leadingTrim: regexRecipe(/^[("'`[{},;:]*/u),
      trailingTrim: regexRecipe(/[)"'`\]},;:.]*$/u),
      alphabet: regexRecipe(/^[A-Za-z0-9+/=_-]+$/u),
      lowercaseRequiredBelowStrictLength: regexRecipe(/[a-z]/u),
      upperOrDigitRequiredBelowStrictLength: regexRecipe(/[A-Z0-9]/u),
      syntheticBenchmarkId: regexRecipe(
        /^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*-\d+$/u,
      ),
      finding: {
        class: "high-entropy-secret",
        confidence: "HIGH",
        evidence: "secret-high-entropy",
      },
    },
  },
  technicalClassifier: {
    credentialPrecedence: {
      gitleaksRuleFlags: "giu",
      additional: [
        {
          id: "credential-token-shape",
          regex: regexRecipe(
            /\b(?:ghp_|github_pat_|xox[baprs]-|npm_|sk-(?:proj-)?|rk_(?:live|test|prod)_|sk_(?:live|test|prod)_)[A-Za-z0-9_-]{10,}\b/gu,
          ),
          class: "credential",
          confidence: "VERY_HIGH",
          evidence: "credential-token-shape",
        },
        {
          id: "cloud-credential-id",
          regex: regexRecipe(
            /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{35}/gu,
          ),
          class: "credential",
          confidence: "VERY_HIGH",
          evidence: "cloud-credential-id",
        },
        {
          id: "embedded-0x-private-key",
          regex: regexRecipe(/[/.]0x[a-fA-F0-9]{64}/gu),
          class: "funds-controlling-secret",
          confidence: "VERY_HIGH",
          evidence: "embedded-0x-private-key",
        },
      ],
    },
    sha256Digest: regexRecipe(/^sha256:[a-f0-9]{64}$/u),
    transactionDigest: regexRecipe(/^0x[a-fA-F0-9]{64}$/u),
    cid: {
      text: regexRecipe(/^b[a-z2-7]+$/u),
      base32Alphabet: "abcdefghijklmnopqrstuvwxyz234567",
      version: 1,
      minimumCodec: 1,
      minimumMultihashCode: 1,
      minimumDigestLength: 1,
      maximumVarintBytes: 9,
      varintRadix: 128,
      rejectNonMinimalVarint: true,
    },
    publicKey: {
      pem: regexRecipe(
        /^-----BEGIN PUBLIC KEY-----\r?\n([\s\S]+)\r?\n-----END PUBLIC KEY-----\r?\n?$/u,
      ),
      supportedSpkiAlgorithms: [
        {
          oidHex: "2a864886f70d010101",
          parameters: "null",
          subject: "rsa-public-key",
        },
        {
          oidHex: "2a8648ce3d0201",
          parameters: "object-identifier",
          subject: "ec-point",
        },
        {
          oidHex: "2b656e",
          parameters: "absent",
          subject: "fixed-bytes",
          subjectBytes: 32,
        },
        {
          oidHex: "2b656f",
          parameters: "absent",
          subject: "fixed-bytes",
          subjectBytes: 56,
        },
        {
          oidHex: "2b6570",
          parameters: "absent",
          subject: "fixed-bytes",
          subjectBytes: 32,
        },
        {
          oidHex: "2b6571",
          parameters: "absent",
          subject: "fixed-bytes",
          subjectBytes: 57,
        },
      ],
      requireDer: true,
      requireSpkiSequence: true,
      requireNonemptySubjectPublicKey: true,
      requireZeroUnusedBits: true,
      rsaSubject: {
        fields: ["modulus", "publicExponent"],
        requireCanonicalPositiveIntegers: true,
        rejectZero: true,
      },
      ecPoint: {
        compressedPrefixes: [0x02, 0x03],
        uncompressedPrefix: 0x04,
        namedCurves: [
          {
            oidHex: "2a8648ce3d030107",
            coordinateBytes: 32,
          },
          {
            oidHex: "2b81040022",
            coordinateBytes: 48,
          },
          {
            oidHex: "2b81040023",
            coordinateBytes: 66,
          },
          {
            oidHex: "2b8104000a",
            coordinateBytes: 32,
          },
        ],
      },
      derTags: {
        sequence: 0x30,
        integer: 0x02,
        objectIdentifier: 0x06,
        bitString: 0x03,
        null: 0x05,
      },
    },
    dsse: {
      payloadType: "application/vnd.in-toto+json",
      structuralRoles: ["dsse-payload", "dsse-signature"],
      requiredEnvelopeFields: ["payload", "payloadType", "signatures"],
      requiredSignatureFields: ["sig"],
      optionalSignatureFields: ["keyid"],
      extensions: "inert-own-data-allowed",
      optionalKeyId: "string-including-empty",
      requireNonemptySignatures: true,
      acceptEmptyByteString: true,
      acceptStandardAlphabet: true,
      acceptUrlSafeAlphabet: true,
      acceptPadded: true,
      acceptUnpadded: true,
      requireCanonicalTrailingBits: true,
    },
    version: {
      fields: ["version", "packageVersion"],
      fieldSubstring: "version",
      regex: regexRecipe(
        /^(?:v)?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u,
      ),
    },
    modelId: {
      fields: ["model", "modelId"],
      regex: regexRecipe(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u),
    },
  },
  privateConfiguration: {
    schemaVersion: "jinn.private-detector-configuration.v1",
    knownIdentityMechanism: {
      comparison: "exact-code-unit-substring",
      overlap: "non-overlapping",
      matchAdvance: "matched-length",
    },
    valueValidation: "nonempty-string-elements",
    knownIdentityFinding: {
      class: "known-identity",
      confidence: "VERY_HIGH",
      evidence: "known-identity-exact",
    },
    privateAllowlistMechanism: "exact-matched-span-substring-exclusion",
  },
} as const);

export type DeterministicPublicRecipe =
  typeof DETERMINISTIC_PUBLIC_RECIPE;

export function builtinDetectorImplementationDigest(
  id: string,
  controlledImplementation: unknown,
): `sha256:${string}` {
  return sha256Digest(
    canonicalJsonBytes({
      id,
      version: BUILTIN_DETECTOR_VERSION,
      controlledImplementation,
    }),
  );
}
