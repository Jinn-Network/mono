// SPDX-License-Identifier: Apache-2.0

/**
 * Manually pinned JavaScript adaptation of a small MIT-licensed Gitleaks rule
 * subset. Source: https://github.com/gitleaks/gitleaks at the annotated tag
 * v8.28.0, peeled commit 4fb43823ef3d152d239e92d7d5cb04783b548062.
 */
export const GITLEAKS_PACK = Object.freeze({
  pin: Object.freeze({
    source: "https://github.com/gitleaks/gitleaks",
    ref: "v8.28.0",
    commit: "4fb43823ef3d152d239e92d7d5cb04783b548062",
    license: "MIT",
    adaptation: "JavaScript RegExp without Go inline flag verbs",
  }),
  rules: Object.freeze([
    Object.freeze({
      id: "github-pat",
      regex: "\\bghp_[0-9a-zA-Z]{36}\\b",
    }),
    Object.freeze({
      id: "github-fine-grained-pat",
      regex: "\\bgithub_pat_[0-9a-zA-Z_]{82}\\b",
    }),
    Object.freeze({
      id: "slack-bot-token",
      regex: "\\bxoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
    }),
    Object.freeze({
      id: "npm-access-token",
      regex: "\\bnpm_[A-Za-z0-9]{36}\\b",
    }),
    Object.freeze({
      id: "stripe-access-token",
      regex: "\\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\\b",
    }),
    Object.freeze({
      id: "openai-api-key",
      regex: "\\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\\b",
    }),
    Object.freeze({
      id: "anthropic-api-key",
      regex: "\\bsk-ant-api03-[A-Za-z0-9_-]{93}AA\\b",
    }),
    Object.freeze({
      id: "aws-access-token",
      regex: "\\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b",
    }),
    Object.freeze({
      id: "google-api-key",
      regex: "\\bAIza[0-9A-Za-z_-]{35}\\b",
    }),
    Object.freeze({
      id: "pypi-upload-token",
      regex: "\\bpypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}",
    }),
    Object.freeze({
      id: "hashicorp-tf-api-token",
      regex: "\\b[a-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9\\-_=]{60,70}\\b",
    }),
    Object.freeze({
      id: "private-key",
      regex:
        "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
    }),
  ]),
});
