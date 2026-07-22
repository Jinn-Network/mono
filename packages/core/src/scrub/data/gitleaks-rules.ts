/** Vendored gitleaks MIT rule subset — see pin.note (Q6). */
export const GITLEAKS_PACK = {
  "pin": {
    "source": "https://github.com/gitleaks/gitleaks",
    "ref": "v8.28.0",
    "date": "2026-07-22",
    "license": "MIT",
    "note": "Q6: pin-and-manually-refresh subset; no build-time sync. Regexes adapted to JS (no Go (?i)/(?-i:) verbs)."
  },
  "rules": [
    {
      "id": "github-pat",
      "description": "GitHub Personal Access Token (classic).",
      "regex": "\\bghp_[0-9a-zA-Z]{36}\\b"
    },
    {
      "id": "github-fine-grained-pat",
      "description": "GitHub Fine-Grained Personal Access Token.",
      "regex": "\\bgithub_pat_[0-9a-zA-Z_]{82}\\b"
    },
    {
      "id": "slack-bot-token",
      "description": "Slack Bot token.",
      "regex": "\\bxoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*"
    },
    {
      "id": "npm-access-token",
      "description": "npm access token.",
      "regex": "\\bnpm_[A-Za-z0-9]{36}\\b"
    },
    {
      "id": "stripe-access-token",
      "description": "Stripe secret/restricted key.",
      "regex": "\\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\\b"
    },
    {
      "id": "openai-api-key",
      "description": "OpenAI API key (legacy sk-…T3BlbkFJ… shape).",
      "regex": "\\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\\b"
    },
    {
      "id": "anthropic-api-key",
      "description": "Anthropic API key.",
      "regex": "\\bsk-ant-api03-[A-Za-z0-9_-]{93}AA\\b"
    },
    {
      "id": "aws-access-token",
      "description": "AWS access key id.",
      "regex": "\\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b"
    },
    {
      "id": "pypi-upload-token",
      "description": "PyPI upload token.",
      "regex": "\\bpypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}"
    },
    {
      "id": "hashicorp-tf-api-token",
      "description": "HashiCorp Terraform API token (…atlasv1…).",
      "regex": "\\b[a-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9\\-_=]{60,70}\\b"
    },
    {
      "id": "private-key",
      "description": "PEM private key block.",
      "regex": "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----"
    }
  ]
} as const;
export type GitleaksPack = typeof GITLEAKS_PACK;
