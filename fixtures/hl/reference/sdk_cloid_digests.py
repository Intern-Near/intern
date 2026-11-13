"""Reference digests for hl-order's client order id ("cloid"), computed with Hyperliquid's official Python SDK.

Run (from this folder). It works offline: it makes no network call.
    python3 -m venv /tmp/hlsdk && /tmp/hlsdk/bin/pip install hyperliquid-python-sdk==0.24.0
    /tmp/hlsdk/bin/python -I sdk_cloid_digests.py > cloid_digests.json

It prints one JSON document to stdout (saved as cloid_digests.json) and a check line per case to stderr, and exits
non-zero if any check fails.

What the SDK does with a cloid (0.24.0, hyperliquid/utils/signing.py): order_request_to_order_wire adds
`order_wire["c"] = order["cloid"].to_raw()` after "t" when the order request has a cloid, and action_hash msgpacks
the action as it is, so "c" is the last key of the order's map. A Cloid (hyperliquid/utils/types.py) is "0x" and
32 hex digits; Cloid.from_int writes them in lower case, zero padded.

Cases. Every one has an expiry, as the contract always sets one, and no vault address:
- r7-open, r7-close: round 7's opening and closing orders exactly as the coin contract signed them on 2026-11-12
  (../exchange/*-round7-position3-*/request.json), with no cloid. Hyperliquid testnet filled both. The script checks
  that the SDK builds the same action, and that each recorded signature recovers, from the digest computed here, to
  the contract's Hyperliquid address.
- r7-*-cloid*: the same orders with the cloid proposed in crates/hl-order/README.md (round id, position id, the
  order's own nonce), on testnet and on mainnet's source "a".
- r7-open-mainnet: r7-open hashed with mainnet's source "a" (the asset index stays testnet's, as in digests.json).
- cloid-*: other cloids on other markets: all zeros, all ones, the example in Hyperliquid's API docs, and the value
  the SDK's own signing test uses. The mainnet ones use 01 section 4's mainnet asset indexes.

For every case the script also signs the action with the SDK's own sign_l1_action, using a throwaway key made on the
spot and held in memory only (never printed or saved), and checks that this signature recovers, from the digest
computed here, to the throwaway address: so the digest is exactly the hash the SDK signs.
"""

import json
import pathlib
import sys
from importlib.metadata import version

import msgpack
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from hyperliquid.utils.signing import (
    action_hash,
    construct_phantom_agent,
    l1_payload,
    order_request_to_order_wire,
    order_wires_to_order_action,
    sign_l1_action,
)
from hyperliquid.utils.types import Cloid

EXCHANGE = pathlib.Path(__file__).resolve().parent.parent / "exchange"
# The coin contract's Hyperliquid testnet address (fixtures/chain/testnet-accounts.md, step 7).
CONTRACT = "0x46f8eb2a044a826c70e9682fe3bfd65970340132"
# Asset indexes from 01 section 4 (testnet: DOGE 173, TRUMP 150; mainnet: DOGE 12, kPEPE 15). Asset 3 is the
# probe's BTC case of digests.json.
DOGE_T, TRUMP_T, ASSET3_T, DOGE_M, KPEPE_M = 173, 150, 3, 12, 15

THROWAWAY = Account.create()  # a brand-new key, in memory only; never printed or saved


def proposed_cloid(round_id, position_id, nonce):
    """crates/hl-order/README.md's proposal: round id (4 bytes), position id (4), nonce (8), all big-endian."""
    raw = round_id.to_bytes(4, "big") + position_id.to_bytes(4, "big") + nonce.to_bytes(8, "big")
    cloid = Cloid.from_int(int.from_bytes(raw, "big"))
    assert cloid.to_raw() == "0x" + raw.hex(), cloid  # from_int: lower case, zero padded to 32 digits
    return cloid


def order_action(asset, is_buy, px, sz, reduce_only, cloid):
    """The action as the SDK's Exchange.order builds it: order_request_to_order_wire, then order_wires_to_order_action."""
    request = {
        "coin": "",
        "is_buy": is_buy,
        "sz": float(sz),
        "limit_px": float(px),
        "order_type": {"limit": {"tif": "Ioc"}},
        "reduce_only": reduce_only,
    }
    if cloid is not None:
        request["cloid"] = cloid
    action = order_wires_to_order_action([order_request_to_order_wire(request, asset)])
    wire = action["orders"][0]
    assert (wire["p"], wire["s"]) == (px, sz), wire  # the SDK writes the same price and size strings
    return action


def digest_of(action, nonce, expires_after, testnet):
    """action_hash -> construct_phantom_agent -> l1_payload -> EIP-712: the hash sign_l1_action signs."""
    connection_id = action_hash(action, None, nonce, expires_after)
    signable = encode_typed_data(full_message=l1_payload(construct_phantom_agent(connection_id, not testnet)))
    return connection_id, keccak(b"\x19" + signable.version + signable.header + signable.body)


def signer_of(digest, signature):
    vrs = (signature["v"], int(signature["r"], 16), int(signature["s"], 16))
    return Account._recover_hash(digest, vrs=vrs).lower()


def record(case_id, source, inputs, cloid_parts, action, nonce, expires_after, testnet, recorded_signature=None):
    connection_id, digest = digest_of(action, nonce, expires_after, testnet)
    signed = sign_l1_action(THROWAWAY, action, None, nonce, expires_after, not testnet)
    checks = {"sign_l1_action": signer_of(digest, signed) == THROWAWAY.address.lower()}
    if recorded_signature is not None:
        checks["recorded signature recovers to the contract"] = signer_of(digest, recorded_signature) == CONTRACT
    ok = all(checks.values())
    detail = ", ".join(f"{name}: {'ok' if passed else 'FAILED'}" for name, passed in checks.items())
    print(f"{case_id:24s} 0x{digest.hex()}  {detail}", file=sys.stderr)
    case = {
        "id": case_id,
        "source": source,
        "inputs": inputs,
        "cloid_parts": cloid_parts,
        "nonce": nonce,
        "expires_after": expires_after,
        "testnet": testnet,
        "action_json": json.dumps(action, separators=(",", ":")),
        "msgpack_hex": msgpack.packb(action).hex(),
        "connection_id": "0x" + connection_id.hex(),
        "digest": "0x" + digest.hex(),
    }
    return ok, case


def order_case(case_id, source, asset, is_buy, px, sz, reduce_only, nonce, expires_after, testnet, cloid,
               cloid_parts=None, recorded=None):
    action = order_action(asset, is_buy, px, sz, reduce_only, cloid)
    inputs = {"kind": "order", "asset": asset, "is_buy": is_buy, "px": px, "sz": sz, "reduce_only": reduce_only,
              "cloid": None if cloid is None else cloid.to_raw()}
    signature = None
    if recorded is not None:
        # The SDK builds, byte for byte, the action the contract signed and the runner posted.
        assert json.dumps(action, separators=(",", ":")) == json.dumps(recorded["action"], separators=(",", ":"))
        assert (nonce, expires_after) == (recorded["nonce"], recorded["expiresAfter"])
        signature = recorded["signature"]
    return record(case_id, source, inputs, cloid_parts, action, nonce, expires_after, testnet, signature)


def request_of(folder):
    return json.loads((EXCHANGE / folder / "request.json").read_text())


OPEN = request_of("20261112T113940Z-round7-position3-open-action5")
CLOSE = request_of("20261112T114911Z-round7-position3-close-action6")
R7_OPEN = (DOGE_T, True, "0.067076", "268", False, OPEN["nonce"], OPEN["expiresAfter"])
R7_CLOSE = (DOGE_T, False, "0.065767", "268", True, CLOSE["nonce"], CLOSE["expiresAfter"])
R7_OPEN_PARTS = {"round_id": 7, "position_id": 3, "nonce": OPEN["nonce"]}
R7_CLOSE_PARTS = {"round_id": 7, "position_id": 3, "nonce": CLOSE["nonce"]}
R7_OPEN_CLOID = proposed_cloid(**R7_OPEN_PARTS)
R7_CLOSE_CLOID = proposed_cloid(**R7_CLOSE_PARTS)
SIGNED_BY_CONTRACT = "signed by the coin contract through NEAR's signing network and filled on Hyperliquid testnet"

results = [
    order_case("r7-open", f"round 7's opening order as {SIGNED_BY_CONTRACT} (../exchange/20261112T113940Z-*)",
               *R7_OPEN, True, None, recorded=OPEN),
    order_case("r7-open-cloid", "r7-open with the proposed cloid (round 7, position 3, its nonce)",
               *R7_OPEN, True, R7_OPEN_CLOID, R7_OPEN_PARTS),
    order_case("r7-open-mainnet", "r7-open hashed with mainnet's source \"a\"", *R7_OPEN, False, None),
    order_case("r7-open-cloid-mainnet", "r7-open-cloid hashed with mainnet's source \"a\"",
               *R7_OPEN, False, R7_OPEN_CLOID, R7_OPEN_PARTS),
    order_case("r7-close", f"round 7's closing order as {SIGNED_BY_CONTRACT} (../exchange/20261112T114911Z-*)",
               *R7_CLOSE, True, None, recorded=CLOSE),
    order_case("r7-close-cloid", "r7-close with the proposed cloid (round 7, position 3, its nonce)",
               *R7_CLOSE, True, R7_CLOSE_CLOID, R7_CLOSE_PARTS),
    order_case("cloid-zero", "probe-order-3's order (digests.json) with the all-zero cloid, Cloid.from_int(0)",
               ASSET3_T, False, "74921", "0.000123", False, 1794375803046, 1794375923046, True, Cloid.from_int(0)),
    order_case("cloid-max-mainnet", "a reduce-only DOGE order on mainnet with the all-ones cloid",
               DOGE_M, False, "0.067473", "177", True, 1794375801092, 1794375921092, False,
               Cloid.from_int(2**128 - 1)),
    order_case("cloid-docs-example", "a TRUMP order with the example cloid of Hyperliquid's API docs",
               TRUMP_T, True, "7.1234", "17.4", False, 1794483600000, 1794483720000, True,
               Cloid.from_str("0x1234567890abcdef1234567890abcdef")),
    order_case("cloid-sdk-test-mainnet", "a kPEPE order on mainnet with the cloid of the SDK's own signing test",
               KPEPE_M, True, "0.005323", "1878", False, 1794483600001, 1794483720001, False,
               Cloid.from_str("0x00000000000000000000000000000001")),
]

doc = {
    "generated_by": f"hyperliquid-python-sdk {version('hyperliquid-python-sdk')}",
    "cases": [case for _, case in results],
}
json.dump(doc, sys.stdout, indent=2)
print(file=sys.stdout)
if not all(ok for ok, _ in results):
    sys.exit(1)
