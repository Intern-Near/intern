"""Reference vectors for tailfade, computed with Hyperliquid's official Python SDK.

Run (from this folder):
    python3 -m venv /tmp/hlsdk && /tmp/hlsdk/bin/pip install hyperliquid-python-sdk==0.24.0
    /tmp/hlsdk/bin/python -I sdk_vectors.py > ../test/vectors.json

User-signed actions (approveAgent, usdSend) are hashed with the SDK's user_signed_payload and the type lists of
sign_agent / USD_SEND_SIGN_TYPES; L1 actions (updateLeverage, order) with action_hash -> construct_phantom_agent ->
l1_payload. Signatures use eth_account (RFC 6979, deterministic) with fixed TEST keys that hold nothing.
"""

import json

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from hyperliquid.utils.signing import (
    USD_SEND_SIGN_TYPES,
    action_hash,
    construct_phantom_agent,
    l1_payload,
    order_request_to_order_wire,
    order_wires_to_order_action,
    user_signed_payload,
)

SDK_VERSION = "hyperliquid-python-sdk 0.24.0"
USER_KEY = "0x" + "11" * 32  # TEST key standing in for the visitor's NEAR-derived address
AGENT_KEY = "0x" + "22" * 32  # TEST key standing in for the browser's trading key
FAUCET_KEY = "0x" + "33" * 32  # TEST key standing in for the faucet's account
AGENT_TYPES = [
    {"name": "hyperliquidChain", "type": "string"},
    {"name": "agentAddress", "type": "address"},
    {"name": "agentName", "type": "string"},
    {"name": "nonce", "type": "uint64"},
]


def digest(data):
    m = encode_typed_data(full_message=data)
    return keccak(b"\x19" + m.version + m.header + m.body)


def sign(key, data):
    signed = Account.sign_message(encode_typed_data(full_message=data), key)
    return {"r": hex(signed.r), "s": hex(signed.s), "v": signed.v}


cases = []
agent_addr = Account.from_key(AGENT_KEY).address
for nonce, name in [(1794500000000, "tailfade"), (1794500000123, "")]:
    action = {
        "type": "approveAgent",
        "signatureChainId": "0x66eee",
        "hyperliquidChain": "Testnet",
        "agentAddress": agent_addr.lower(),
        "agentName": name,
        "nonce": nonce,
    }
    data = user_signed_payload("HyperliquidTransaction:ApproveAgent", AGENT_TYPES, action)
    cases.append({"id": f"approve-agent-{nonce}", "kind": "user", "primary": "HyperliquidTransaction:ApproveAgent",
                  "action": action, "digest": "0x" + digest(data).hex(), "signer": Account.from_key(USER_KEY).address,
                  "signature": sign(USER_KEY, data)})

for nonce, dest, amount in [(1794500001000, "0x66726d2cf438f3d9b3b61bc6e1f52dbf51f4df43", "30"),
                            (1794500002000, "0x46f8eb2a044a826c70e9682fe3bfd65970340132", "12.5")]:
    action = {"type": "usdSend", "signatureChainId": "0x66eee", "hyperliquidChain": "Testnet",
              "destination": dest, "amount": amount, "time": nonce}
    data = user_signed_payload("HyperliquidTransaction:UsdSend", USD_SEND_SIGN_TYPES, action)
    cases.append({"id": f"usd-send-{nonce}", "kind": "user", "primary": "HyperliquidTransaction:UsdSend",
                  "action": action, "digest": "0x" + digest(data).hex(), "signer": Account.from_key(FAUCET_KEY).address,
                  "signature": sign(FAUCET_KEY, data)})

DOGE = 173
l1 = [
    ("leverage-isolated-2x", {"type": "updateLeverage", "asset": DOGE, "isCross": False, "leverage": 2}, 1794500003000),
    ("order-tail-doge", order_wires_to_order_action([order_request_to_order_wire(
        {"coin": "DOGE", "is_buy": True, "sz": 300.0, "limit_px": 0.069421, "order_type": {"limit": {"tif": "Ioc"}},
         "reduce_only": False}, DOGE)]), 1794500004000),
    ("order-fade-doge", order_wires_to_order_action([order_request_to_order_wire(
        {"coin": "DOGE", "is_buy": False, "sz": 721.0, "limit_px": 0.067998, "order_type": {"limit": {"tif": "Ioc"}},
         "reduce_only": False}, DOGE)]), 1794500005000),
    ("order-close-doge", order_wires_to_order_action([order_request_to_order_wire(
        {"coin": "DOGE", "is_buy": False, "sz": 300.0, "limit_px": 0.06801, "order_type": {"limit": {"tif": "Ioc"}},
         "reduce_only": True}, DOGE)]), 1794500006000),
]
for cid, action, nonce in l1:
    h = action_hash(action, None, nonce, None)
    data = l1_payload(construct_phantom_agent(h, False))
    cases.append({"id": cid, "kind": "l1", "action": action, "nonce": nonce, "testnet": True,
                  "action_hash": "0x" + h.hex(), "digest": "0x" + digest(data).hex(),
                  "signer": agent_addr, "signature": sign(AGENT_KEY, data)})

print(json.dumps({"generated_by": SDK_VERSION, "keys_are_test_only": {"user": USER_KEY, "agent": AGENT_KEY,
                  "faucet": FAUCET_KEY}, "cases": cases}, indent=2))
