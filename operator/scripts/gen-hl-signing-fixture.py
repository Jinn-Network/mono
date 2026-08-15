"""
Regenerate the Hyperliquid L1-action golden signing fixture.

Used as ground truth by
operator/test/harnesses/impls/claude-mcp-hyperliquid/index.test.ts (or similar)
— the TypeScript implementation of hlExchangePost() must reproduce this
signature byte-for-byte for the same (privkey, action, nonce) tuple.

Usage:
    python3 -m venv /tmp/hl-fixture-venv
    /tmp/hl-fixture-venv/bin/pip install hyperliquid-python-sdk
    /tmp/hl-fixture-venv/bin/python operator/scripts/gen-hl-signing-fixture.py \
        > operator/test/harnesses/impls/claude-mcp-hyperliquid/fixtures/hl-signing-golden.json
"""

import json

from eth_account import Account
from hyperliquid.utils.signing import sign_l1_action

PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111"
wallet = Account.from_key(PRIVATE_KEY)

ACTION = {
    "type": "order",
    "orders": [
        {
            "a": 0,
            "b": True,
            "p": "50000.0",
            "s": "0.001",
            "r": False,
            "t": {"limit": {"tif": "Gtc"}},
        }
    ],
    "grouping": "na",
}

NONCE = 1712000000000
VAULT_ADDRESS = None
EXPIRES_AFTER = None
IS_MAINNET = False

signature = sign_l1_action(
    wallet=wallet,
    action=ACTION,
    active_pool=VAULT_ADDRESS,
    nonce=NONCE,
    expires_after=EXPIRES_AFTER,
    is_mainnet=IS_MAINNET,
)

fixture = {
    "_description": "Golden Hyperliquid L1-action signature — regenerated via operator/scripts/gen-hl-signing-fixture.py.",
    "_source_sdk": "hyperliquid-python-sdk",
    "inputs": {
        "privateKey": PRIVATE_KEY,
        "signerAddress": wallet.address,
        "action": ACTION,
        "nonce": NONCE,
        "vaultAddress": VAULT_ADDRESS,
        "expiresAfter": EXPIRES_AFTER,
        "isMainnet": IS_MAINNET,
    },
    "expected": {
        "r": signature["r"],
        "s": signature["s"],
        "v": signature["v"],
    },
}

print(json.dumps(fixture, indent=2, sort_keys=False))
