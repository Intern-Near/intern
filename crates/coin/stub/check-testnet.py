#!/usr/bin/env python3
"""Checks the deployed stub from the command line, over NEAR's public RPC. Read-only; needs no key.

    python3 check-testnet.py views      # call every view of 01-SHARED-INTERFACE.md section 8, check the field names
    python3 check-testnet.py snapshot [SCENE]   # one line: scene, round, rank, positions, last feed event

The account and RPC come from intern/interface/deployments.json (testnet.stub, testnet.rpc), or from
the STUB and RPC environment variables.
"""
import base64
import json
import os
import pathlib
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
DEPLOY = json.loads((HERE / "../../../interface/deployments.json").read_text())["testnet"]
STUB = os.environ.get("STUB") or DEPLOY["stub"]
RPC = os.environ.get("RPC") or DEPLOY["rpc"]


def view(method, args=None):
    body = {
        "jsonrpc": "2.0", "id": 1, "method": "query",
        "params": {"request_type": "call_function", "finality": "final", "account_id": STUB,
                   "method_name": method, "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode()},
    }
    req = urllib.request.Request(RPC, json.dumps(body).encode(), {"content-type": "application/json"})
    out = json.loads(urllib.request.urlopen(req, timeout=20).read())
    if "error" in out or "error" in out.get("result", {}):
        raise RuntimeError(f"{method}: {out.get('error') or out['result']['error']}")
    return json.loads(bytes(out["result"]["result"]).decode())


# Field names from section 8.1 (and 10 for feed data).
SHAPES = {
    "Constants": ["interface_version", "network", "usdc_token", "coin_decimals", "ranks", "markets", "min_notional", "round",
                  "vote", "model", "funding", "result_source", "lending", "hl", "runner", "min_first_deposit", "refusal_codes"],
    "Limits": ["rank", "per_bet_bps", "max_bets", "per_round_bps", "sides", "max_leverage", "markets"],
    "RankState": ["rank", "status", "since_round", "pending"],
    "Round": ["id", "phase", "settled", "stuck", "started_at", "guess_closes_at", "propose_from", "propose_until", "close_from",
              "ends_at", "rank", "status", "brave_at_open", "bets_used", "at_risk", "skipped", "refused", "result"],
    "Rulebook": ["round_id", "nonce", "text"],
    "Position": ["id", "round_id", "market", "side", "margin", "leverage", "notional", "status", "approved_at", "open_signed_at",
                 "close_signed_at", "settled_at", "sz_e8", "returned", "result", "result_source"],
    "SignedAction": ["id", "position_id", "kind", "action", "nonce", "expires_after", "signature", "created_at"],
    "Pot": ["brave", "safe", "coin_supply", "coin_price_e6", "bosses", "outside_income_total"],
    "Account": ["account_id", "registered", "coin", "locked", "brave_value", "pending_brave", "safe", "joined_round", "vote_weight"],
    "Vote": ["id", "kind", "playbook_id", "opened_by", "opened_at", "closes_at", "yes", "no", "locked_weight_at_open", "state",
             "effective_round"],
    "Refusal": ["id", "round_id", "code", "at", "asked", "limit", "decision", "is_first"],
    "StickerFirst": ["code", "account_id", "round_id"],
    "FeedItem": ["seq", "at", "event", "data"],
    "FtMetadata": ["spec", "name", "symbol", "icon", "reference", "reference_hash", "decimals"],
    "StorageBalance": ["total", "available"],
    "StorageBalanceBounds": ["min", "max"],
}
EVENT_DATA = {
    "round_opened": ["round_id", "rank", "status", "brave_at_open"], "paid_in": ["account_id", "pool", "amount", "pending"],
    "coins_minted": ["account_id", "coins", "round_id"], "cashed_out": ["account_id", "pool", "coins", "paid"],
    "dial_turned": ["account_id", "to", "amount"], "locked": ["account_id", "amount"], "unlocked": ["account_id", "amount"],
    "skipped": ["round_id"], "refused": ["refusal_id", "round_id", "code", "asked", "limit", "is_first"],
    "approved": ["position_id", "round_id", "market", "side", "margin", "leverage"],
    "order_signed": ["action_id", "position_id", "kind"],
    "result_reported": ["position_id", "returned", "result", "result_source"], "settled": ["round_id", "result", "brave_after"],
    "vote_opened": ["vote_id", "kind", "playbook_id", "opened_by", "closes_at"],
    "vote_cast": ["vote_id", "account_id", "support", "weight"], "vote_finished": ["vote_id", "state", "effective_round"],
    "rank_changed": ["from", "to", "effective_round"], "fired": ["round_id"], "rehired": ["effective_round"],
    "outside_income": ["source", "amount"],
}


def shape(name, obj):
    if sorted(obj) != sorted(SHAPES[name]):
        raise AssertionError(f"{name}: fields {sorted(obj)} != {sorted(SHAPES[name])}")


def each(name, items):
    for x in items:
        shape(name, x)


def ensure(ok, what):
    if not ok:
        raise AssertionError(what)


def feed(items):
    for f in items:
        shape("FeedItem", f)
        ensure(sorted(f["data"]) == sorted(EVENT_DATA[f["event"]]), f"{f['event']} data fields")


def views():
    checks = [
        ("get_constants", {}, lambda v: shape("Constants", v)),
        ("get_rank", {}, lambda v: shape("RankState", v)),
        ("get_limits", {"rank": "TRADER"}, lambda v: shape("Limits", v)),
        ("get_round", {}, lambda v: shape("Round", v)),
        ("get_round_by_id", {"round_id": 41}, lambda v: shape("Round", v)),
        ("get_rulebook", {}, lambda v: shape("Rulebook", v)),
        ("get_positions", {}, lambda v: each("Position", v)),
        ("get_outbox", {}, lambda v: each("SignedAction", v)),
        ("get_pot", {}, lambda v: shape("Pot", v)),
        ("get_account", {"account_id": "boss.testnet"}, lambda v: shape("Account", v)),
        ("get_votes", {}, lambda v: each("Vote", v)),
        ("get_refusals", {}, lambda v: each("Refusal", v)),
        ("get_sticker_firsts", {}, lambda v: (each("StickerFirst", v), ensure(len(v) == 16, "16 entries"))),
        ("get_feed", {}, feed),
        ("get_active_playbook", {}, lambda v: ensure(v is None, "null")),
        ("ft_balance_of", {"account_id": "boss.testnet"}, lambda v: ensure(isinstance(v, str), "U128 string")),
        ("ft_total_supply", {}, lambda v: ensure(isinstance(v, str), "U128 string")),
        ("ft_metadata", {}, lambda v: shape("FtMetadata", v)),
        ("storage_balance_of", {"account_id": "boss.testnet"}, lambda v: shape("StorageBalance", v)),
        ("storage_balance_bounds", {}, lambda v: shape("StorageBalanceBounds", v)),
    ]
    print(f"stub {STUB} via {RPC}, scene {view('get_scene')['scene']}")
    failed = 0
    for method, args, check in checks:
        try:
            v = view(method, args)
            check(v)
            text = json.dumps(v, separators=(",", ":"))
            print(f"  OK   {method}({json.dumps(args) if args else ''}) -> {text[:110]}{'...' if len(text) > 110 else ''}")
        except Exception as e:  # report every view, then fail once
            failed += 1
            print(f"  FAIL {method}: {e}")
    print(f"{len(checks) - failed} of {len(checks)} views answered with the section 8 shapes")
    sys.exit(1 if failed else 0)


def snapshot(expect=None):
    # Wait (up to 30 s) until a just-sent set_scene is visible at "final" finality.
    for _ in range(30):
        if expect is None or view("get_scene")["scene"] == expect:
            break
        time.sleep(1)
    r, k, p, f = view("get_round"), view("get_rank"), view("get_positions"), view("get_feed", {"limit": 1})
    print(json.dumps({
        "scene": view("get_scene")["scene"],
        "round": {x: r[x] for x in ("id", "phase", "settled", "stuck", "bets_used", "result")},
        "rank": f"{k['rank']}/{k['status']}",
        "positions": [x["status"] for x in p],
        "last_feed": f"#{f[-1]['seq']} {f[-1]['event']}",
    }, separators=(",", ":")))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "views"
    {"views": views, "snapshot": lambda: snapshot(sys.argv[2] if len(sys.argv) > 2 else None)}[mode]()
