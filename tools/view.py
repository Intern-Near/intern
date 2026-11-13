#!/usr/bin/env python3
"""Ask a contract on NEAR testnet a read-only question. No key, no account, no install (Python 3 only).

    python3 tools/view.py get_rank
    python3 tools/view.py get_feed '{"limit": 10}'
    python3 tools/view.py get_refusals '{"limit": 3}' --on coin-fast

--on takes a name from interface/deployments.json (coin, usdc, stub, stickers, launchpad, lender), coin-fast (the
test copy with 5-minute rounds), or a full account id. The default is the live coin. The views are listed in
01-SHARED-INTERFACE.md section 8.
"""
import base64
import json
import pathlib
import sys
import urllib.request

here = pathlib.Path(__file__).resolve().parent.parent
dep = json.loads((here / "interface/deployments.json").read_text())["testnet"]
dep.setdefault("coin-fast", "coin-fast.desk-lab-2026.testnet")

args = sys.argv[1:]
target = "coin"
if "--on" in args:
    i = args.index("--on")
    target = args[i + 1]
    del args[i:i + 2]
if not args:
    sys.exit(__doc__)
method = args[0]
json_args = args[1] if len(args) > 1 else "{}"
json.loads(json_args)  # fail early on bad JSON
account = dep.get(target, target)

body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
    "request_type": "call_function", "finality": "final", "account_id": account, "method_name": method,
    "args_base64": base64.b64encode(json_args.encode()).decode()}}
req = urllib.request.Request(dep["rpc"], json.dumps(body).encode(), {"content-type": "application/json"})
reply = json.load(urllib.request.urlopen(req, timeout=30))
result = reply.get("result") or {}
if "result" not in result:
    sys.exit(f"{account} {method}: {json.dumps(reply.get('error') or result.get('error') or reply)[:600]}")
print(json.dumps(json.loads(bytes(result["result"])), indent=1))
