#!/usr/bin/env python3
"""Check the on-chain state of service 165 using the middleware's Python libraries."""
import os
import sys

# Add middleware to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'olas-operate-middleware'))

os.environ["CUSTOM_CHAIN_RPC"] = os.environ.get("RPC_URL", "https://base.publicnode.com")

from operate.services.protocol import EthSafeTxBuilder, StakingState
from operate.data.contracts.service_registry import get_service_info, get_agent_instances
from autonomy.chain.base import registry_contracts

# Use web3 directly
from web3 import Web3

SERVICE_ID = 165
RPC_URL = os.environ.get("RPC_URL", "https://base.publicnode.com")
AGENTSFUN1 = "0x2585e63df7BD9De8e058884D496658a030b5c6ce"
JINN = "0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139"

w3 = Web3(Web3.HTTPProvider(RPC_URL))

print("=== Service 165 State Check via Middleware ===\n")

try:
    from aea_ledger_ethereum import EthereumApi
    ledger_api = EthereumApi(address=RPC_URL)

    result = get_service_info(
        ledger_api=ledger_api,
        chain_type="base",
        token_id=SERVICE_ID,
    )
    print(f"Service Info: {result}")
except Exception as e:
    print(f"get_service_info failed: {e}")

# Try direct web3 call
print("\n--- Direct web3 getService call ---")
try:
    service_registry = w3.eth.contract(
        address=Web3.to_checksum_address("0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE"),
        abi=[{
            "inputs": [{"name": "serviceId", "type": "uint256"}],
            "name": "getService",
            "outputs": [{
                "components": [
                    {"name": "securityDeposit", "type": "uint96"},
                    {"name": "multisig", "type": "address"},
                    {"name": "configHash", "type": "bytes32"},
                    {"name": "threshold", "type": "uint32"},
                    {"name": "maxNumAgentInstances", "type": "uint32"},
                    {"name": "numAgentInstances", "type": "uint32"},
                    {"name": "state", "type": "uint8"},
                    {"name": "agentIds", "type": "uint32[]"},
                ],
                "type": "tuple",
            }],
            "stateMutability": "view",
            "type": "function",
        }]
    )
    result = service_registry.functions.getService(SERVICE_ID).call()
    print(f"  securityDeposit: {result[0]}")
    print(f"  multisig: {result[1]}")
    print(f"  configHash: {result[2].hex()}")
    print(f"  threshold: {result[3]}")
    print(f"  maxNumAgentInstances: {result[4]}")
    print(f"  numAgentInstances: {result[5]}")
    print(f"  state: {result[6]} (1=PreReg 2=ActiveReg 3=FinishedReg 4=Deployed 5=TermBonded)")
    print(f"  agentIds: {result[7]}")
except Exception as e:
    print(f"  getService failed: {e}")

# Check NFT owner
print("\n--- NFT Owner ---")
try:
    erc721 = w3.eth.contract(
        address=Web3.to_checksum_address("0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE"),
        abi=[{"inputs": [{"name": "tokenId", "type": "uint256"}], "name": "ownerOf", "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"}]
    )
    owner = erc721.functions.ownerOf(SERVICE_ID).call()
    print(f"  Owner: {owner}")
except Exception as e:
    print(f"  ownerOf failed: {e}")
