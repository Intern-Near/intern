"""Reference digests for hl-order, computed with Hyperliquid's official Python SDK.

Run (from this folder):
    python3 -m venv /tmp/hlsdk && /tmp/hlsdk/bin/pip install hyperliquid-python-sdk==0.24.0
    /tmp/hlsdk/bin/python -I sdk_digests.py > digests.json

It prints one JSON document to stdout (saved as digests.json) and a check line per case to stderr.

Cases:
- probe-order-0..4, probe-leverage-0..2: the 8 cases the research probe cross-checked
  (research-scripts/hl_guard_e2e.mjs, "digest cross-check"; its output printed the 5 order digests only).
- live-*: 6 actions that were really signed by NEAR's signing network on 2026-11-11 and posted to Hyperliquid
  testnet, which recovered the expected address from each signature (research-scripts/hl_chainsig_order_output.txt
  and hl_guard_e2e_output.txt). Their printed digests are copied below.
- mainnet-*: two of the probe cases hashed for mainnet (source "a"), so both sources are covered.
All have no vault address.

The actions are built with the SDK's own functions: orders with order_request_to_order_wire and
order_wires_to_order_action (prices and sizes through float_to_wire); leverage exactly as Exchange.update_leverage
builds it (keys type, asset, isCross, leverage). The digest is action_hash -> construct_phantom_agent -> l1_payload
-> eth_account encode_typed_data -> keccak(0x19 || version || header || body), the hash that sign_inner signs.
"""

import json
import sys

import msgpack
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from hyperliquid.utils.signing import (
    action_hash,
    construct_phantom_agent,
    l1_payload,
    order_request_to_order_wire,
    order_wires_to_order_action,
)

SDK_VERSION = "hyperliquid-python-sdk 0.24.0"
DOGE, KPEPE, BTC = 173, 12, 3  # testnet asset indexes used by the probe on 2026-11-11

# (id, asset, is_buy, px, sz, reduce_only, nonce, expires_after, printed digest, printed connection id)
ORDERS = [
    ("probe-order-0", DOGE, True, "0.068837", "177", False, 1794375800115, None,
     "0x93bfe0e81a9c8caaf6b218a22ef35b450a008c23e28d8a9b7b0c4837733060e9", None),
    ("probe-order-1", DOGE, False, "0.067473", "177", True, 1794375801092, 1794375921092,
     "0x133a827faef6ecfd3190e8ec9e87da45149a057a125232fb51af4215c42d8798", None),
    ("probe-order-2", KPEPE, True, "0.005323", "3000", False, 1794375802069, None,
     "0xfc0ce626cb8085f7064c265ea9c1bb5c184f5f5c68acc96b576258b16e2bdf10", None),
    ("probe-order-3", BTC, False, "74921", "0.000123", False, 1794375803046, 1794375923046,
     "0xda8b122c375617c720d4f7db4d8659d0a8b9857667da8aedc4901b93f5f1c7a4", None),
    ("probe-order-4", 3, True, "12.345", "1", True, 1794375804023, None,
     "0x6dab1c8a47665d24825d78112c0b8a43b955ab8af22b3429a7b3f7e96f4eb35f", None),
    ("live-chainsig-open", DOGE, True, "0.068837", "177", False, 1794375806401, None,
     "0x6d2e65cac47349866783c25578ab0d647c6512a39b4b305b1fe3ac7ea0cf138f",
     "0xe2fff03fbe273923f375ab23c42a8143b53b1df8127a500018b69c62b0485304"),
    ("live-chainsig-close", DOGE, False, "0.067473", "177", True, 1794375812947, None,
     "0xc3c25668689c531aaa5a3dc1f2ac757ad3a9b597520fe783a9c28a81d2049732",
     "0x5063d4ef2b7b4be4ad03d1ba2863e9043c8413674fab05b9aca501529ee7e55b"),
    ("live-guard-open", DOGE, True, "0.068795", "177", False, 1794375990906, 1794376110906,
     "0x4a97e6d053f91faf9efeca2785ff8fd17289fa7375fd2409b26229d56c62135d", None),
    ("live-guard-close", DOGE, False, "0.067433", "177", True, 1794376000939, 1794376120939,
     "0x57e7c2cf24726d23b13c8215f1ab5404c2849687a37620c6a6dd08bf87ebbbf6", None),
]

# (id, asset, leverage, nonce, expires_after, printed digest, printed connection id)
LEVERAGES = [
    ("probe-leverage-0", DOGE, 2, 1794375900000, 1794376020000, None, None),
    ("probe-leverage-1", KPEPE, 1, 1794375900001, 1794376020001, None, None),
    ("probe-leverage-2", 200, 10, 1794375900002, 1794376020002, None, None),
    ("live-chainsig-leverage", DOGE, 2, 1794375800115, None,
     "0x14c60d70d1b009e936f8ffb850c755b678bf256041520cc979bae6ecdda19b17",
     "0x9e69fb65abb08ccd7e29c4b4f5c63cc54927950bca7552d973faa382a2fc3f20"),
    ("live-guard-leverage", DOGE, 2, 1794375978592, 1794376098592,
     "0x50438dd924b6ffa4ddf673498d96db9b2c309866d9f5753b438485254bcf1526", None),
]


def digest_of(action, nonce, expires_after, testnet):
    connection_id = action_hash(action, None, nonce, expires_after)
    signable = encode_typed_data(full_message=l1_payload(construct_phantom_agent(connection_id, not testnet)))
    digest = keccak(b"\x19" + signable.version + signable.header + signable.body)
    return "0x" + connection_id.hex(), "0x" + digest.hex()


def record(case_id, inputs, action, nonce, expires_after, printed_digest, printed_connection_id, testnet=True):
    connection_id, digest = digest_of(action, nonce, expires_after, testnet)
    checks = []
    if printed_digest is not None:
        checks.append(digest == printed_digest)
    if printed_connection_id is not None:
        checks.append(connection_id == printed_connection_id)
    verdict = "no printed value" if not checks else ("matches printed" if all(checks) else "MISMATCH")
    print(f"{case_id:24s} {digest}  {verdict}", file=sys.stderr)
    return {
        "id": case_id,
        "inputs": inputs,
        "nonce": nonce,
        "expires_after": expires_after,
        "testnet": testnet,
        "action_json": json.dumps(action, separators=(",", ":")),
        "msgpack_hex": msgpack.packb(action).hex(),
        "connection_id": connection_id,
        "digest": digest,
        "printed_digest": printed_digest,
        "printed_connection_id": printed_connection_id,
        "printed_match": None if not checks else all(checks),
    }


out = []
for case_id, asset, is_buy, px, sz, reduce_only, nonce, expires_after, printed, printed_cid in ORDERS:
    order = {
        "coin": "",
        "is_buy": is_buy,
        "sz": float(sz),
        "limit_px": float(px),
        "order_type": {"limit": {"tif": "Ioc"}},
        "reduce_only": reduce_only,
    }
    action = order_wires_to_order_action([order_request_to_order_wire(order, asset)])
    wire = action["orders"][0]
    assert (wire["p"], wire["s"]) == (px, sz), (case_id, wire)  # the SDK writes the same price and size strings
    inputs = {"kind": "order", "asset": asset, "is_buy": is_buy, "px": px, "sz": sz, "reduce_only": reduce_only}
    out.append(record(case_id, inputs, action, nonce, expires_after, printed, printed_cid))

for case_id, asset, leverage, nonce, expires_after, printed, printed_cid in LEVERAGES:
    action = {"type": "updateLeverage", "asset": asset, "isCross": False, "leverage": leverage}
    inputs = {"kind": "leverage", "asset": asset, "leverage": leverage}
    out.append(record(case_id, inputs, action, nonce, expires_after, printed, printed_cid))

# Mainnet (source "a"): the same inputs as probe-order-0 and probe-leverage-0.
first_order = next(c for c in out if c["id"] == "probe-order-0")
first_leverage = next(c for c in out if c["id"] == "probe-leverage-0")
for case_id, base in (("mainnet-order-0", first_order), ("mainnet-leverage-0", first_leverage)):
    action = json.loads(base["action_json"])
    out.append(record(case_id, base["inputs"], action, base["nonce"], base["expires_after"], None, None, testnet=False))

json.dump({"generated_by": SDK_VERSION, "cases": out}, sys.stdout, indent=2)
print(file=sys.stdout)
if any(c["printed_match"] is False for c in out):
    sys.exit(1)
