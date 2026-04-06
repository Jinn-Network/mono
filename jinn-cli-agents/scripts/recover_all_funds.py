#!/usr/bin/env python3
"""
Recover all available funds from the current middleware state into a single address.

This script mirrors the internal Operate recovery helpers so it respects whatever
guards/modules are attached to the Safes.

Requirements:
  - Set RECOVERY_DEST to the address that should receive all funds.
  - Set OPERATE_PASSWORD to the current middleware password.
  - Optional: RPC_URL for Base (defaults to https://mainnet.base.org).

Run:
  RECOVERY_DEST=0xYourAddress OPERATE_PASSWORD=... \
    python scripts/recover_all_funds.py
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from aea_ledger_ethereum.ethereum import EthereumCrypto

from operate.cli import OperateApp
from operate.keys import KeysManager
from operate.ledger.profiles import OLAS, ERC20_TOKENS
from operate.operate_types import Chain, LedgerType
from operate.utils.gnosis import (
    drain_eoa,
    transfer_erc20_from_safe,
    transfer as transfer_from_safe,
    get_asset_balance,
)


RECOVERY_DEST = os.environ.get("RECOVERY_DEST")
if not RECOVERY_DEST:
    raise SystemExit("❌ RECOVERY_DEST environment variable is required.")

OPERATE_PASSWORD = os.environ.get("OPERATE_PASSWORD")
if not OPERATE_PASSWORD:
    raise SystemExit("❌ OPERATE_PASSWORD environment variable is required.")

# OperateApp looks at OPERATE_USER_PASSWORD for the wallet manager password.
os.environ.setdefault("OPERATE_USER_PASSWORD", OPERATE_PASSWORD)

RPC_URL = os.environ.get("RPC_URL")

OPERATE_HOME = Path("olas-operate-middleware") / ".operate"
CHAIN = Chain.BASE


def log(message: str) -> None:
    print(message, flush=True)


def load_app() -> OperateApp:
    app = OperateApp(home=OPERATE_HOME)
    app.password = OPERATE_PASSWORD
    return app


def maybe_override_rpc(wallet, chain: Chain):
    if RPC_URL:
        ledger_api = wallet.ledger_api(chain=chain, rpc=RPC_URL)
    else:
        ledger_api = wallet.ledger_api(chain=chain)
    return ledger_api


def drain_master(app: OperateApp) -> None:
    log("\n=== Master Safe & EOA ===")
    wallet_manager = app.wallet_manager
    master_wallet = wallet_manager.load(ledger_type=LedgerType.ETHEREUM)
    ledger_api = maybe_override_rpc(master_wallet, CHAIN)

    safe_address = master_wallet.safes[CHAIN]
    log(f"Master Safe: {safe_address}")

    # Transfer OLAS
    olas_token = OLAS[CHAIN]
    olas_balance = get_asset_balance(
        ledger_api=ledger_api,
        asset_address=olas_token,
        address=safe_address,
    )
    if olas_balance > 0:
        log(f"→ Transferring {olas_balance} OLAS (wei) from Master Safe")
        transfer_erc20_from_safe(
            ledger_api=ledger_api,
            crypto=master_wallet.crypto,
            safe=safe_address,
            token=olas_token,
            to=RECOVERY_DEST,
            amount=olas_balance,
        )
    else:
        log("→ No OLAS in Master Safe")

    # Transfer ETH
    eth_balance = ledger_api.get_balance(safe_address)
    if eth_balance > 0:
        log(f"→ Transferring {eth_balance} wei ETH from Master Safe")
        transfer_from_safe(
            ledger_api=ledger_api,
            crypto=master_wallet.crypto,
            safe=safe_address,
            to=RECOVERY_DEST,
            amount=eth_balance,
        )
    else:
        log("→ No ETH in Master Safe")

    # Drain any remaining ERC20s the helper tracks
    for token_map in ERC20_TOKENS:
        token = token_map.get(CHAIN)
        if token in (None, olas_token):
            continue
        token_balance = get_asset_balance(ledger_api, token, safe_address)
        if token_balance > 0:
            log(f"→ Transferring {token_balance} of token {token} from Master Safe")
            transfer_erc20_from_safe(
                ledger_api=ledger_api,
                crypto=master_wallet.crypto,
                safe=safe_address,
                token=token,
                to=RECOVERY_DEST,
                amount=token_balance,
            )

    # Finally drain the Master EOA itself
    log("→ Draining Master EOA residual ETH")
    try:
        master_wallet.drain(
            withdrawal_address=RECOVERY_DEST,
            chain=CHAIN,
            from_safe=False,
            rpc=RPC_URL,
        )
    except Exception as exc:  # pylint: disable=broad-except
        log(f"   Skipped Master EOA drain due to error: {exc}")


def load_service_safes(app: OperateApp) -> list[tuple[str, list[str]]]:
    service_manager = app.service_manager()
    services, _ = service_manager.get_all_services()
    safes: list[tuple[str, list[str]]] = []
    for service in services:
        chain_config = service.chain_configs.get(CHAIN.value)
        if not chain_config:
            continue
        multisig = chain_config.chain_data.multisig
        if not multisig or multisig.lower().startswith("0x0"):
            continue
        safes.append((multisig, service.agent_addresses))
    return safes


def drain_service_safe(
    ledger_api,
    safe_address: str,
    agent_wallet: EthereumCrypto,
) -> None:
    log(f"\n=== Service Safe: {safe_address} ===")

    # Transfer any ETH
    eth_balance = ledger_api.get_balance(safe_address)
    if eth_balance > 0:
        log(f"→ Transferring {eth_balance} wei ETH from Service Safe")
        transfer_from_safe(
            ledger_api=ledger_api,
            crypto=agent_wallet,
            safe=safe_address,
            to=RECOVERY_DEST,
            amount=eth_balance,
        )
    else:
        log("→ No ETH in Service Safe")

    # Drain any tracked ERC20 tokens
    for token_map in ERC20_TOKENS:
        token = token_map.get(CHAIN)
        if not token:
            continue
        token_balance = get_asset_balance(ledger_api, token, safe_address)
        if token_balance > 0:
            log(f"→ Transferring {token_balance} of token {token}")
            transfer_erc20_from_safe(
                ledger_api=ledger_api,
                crypto=agent_wallet,
                safe=safe_address,
                token=token,
                to=RECOVERY_DEST,
                amount=token_balance,
            )

    # Drain the agent EOA that owns the service Safe
    log("→ Draining Service Agent EOA residual ETH")
    try:
        drain_eoa(
            ledger_api=ledger_api,
            crypto=agent_wallet,
            withdrawal_address=RECOVERY_DEST,
            chain_id=CHAIN.id,
        )
    except Exception as exc:  # pylint: disable=broad-except
        log(f"   Skipped agent EOA drain due to error: {exc}")


def main() -> None:
    app = load_app()
    drain_master(app)

    ledger_api = maybe_override_rpc(app.wallet_manager.load(LedgerType.ETHEREUM), CHAIN)
    keys_path = OPERATE_HOME / "keys"
    keys_manager = KeysManager(path=keys_path, logger=app.wallet_manager.logger)

    service_safes = load_service_safes(app)
    if not service_safes:
        log("\nNo service safes found.")
        return

    for safe_address, agent_addresses in service_safes:
        primary_agent: Optional[str] = agent_addresses[0] if agent_addresses else None
        if not primary_agent:
            log(f"\nSkipping {safe_address}: no agent owner recorded.")
            continue
        try:
            agent_wallet = keys_manager.get_crypto_instance(primary_agent)
        except Exception as exc:  # pylint: disable=broad-except
            log(f"\nSkipping {safe_address}: unable to load agent key ({exc}).")
            continue

        drain_service_safe(ledger_api, safe_address, agent_wallet)


if __name__ == "__main__":
    try:
        main()
        log("\n✅ Recovery script completed.")
    except Exception as err:  # pylint: disable=broad-except
        log(f"\n❌ Recovery script failed: {err}")
        raise
