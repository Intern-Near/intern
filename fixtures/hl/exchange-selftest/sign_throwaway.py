# Signs one Hyperliquid TESTNET order with a brand-new throwaway key (held in memory only, never printed or saved),
# using the official SDK, and prints the signed action and the throwaway ADDRESS (public). The account has no
# funds and has never existed on Hyperliquid, so Hyperliquid must refuse it and name the address it recovered.
import json, sys, time
from eth_account import Account
from hyperliquid.utils.signing import sign_l1_action, order_request_to_order_wire, order_wires_to_order_action

wallet = Account.create()
nonce = int(time.time() * 1000)
expires_after = nonce + 60_000
order = {"coin": "DOGE", "is_buy": True, "sz": 143.0, "limit_px": 0.069, "order_type": {"limit": {"tif": "Ioc"}}, "reduce_only": False}
action = order_wires_to_order_action([order_request_to_order_wire(order, 173)])  # DOGE on testnet is asset 173 (01 §4)
sig = sign_l1_action(wallet, action, None, nonce, expires_after, False)  # is_mainnet=False: testnet
print(json.dumps({"address": wallet.address.lower(), "action": action, "nonce": nonce, "expires_after": expires_after, "signature": sig}))
