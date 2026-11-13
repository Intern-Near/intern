#!/usr/bin/env bash
# One command for judges: builds every contract, runs every test, and checks that what runs on NEAR testnet
# is exactly this source. Read-only towards the network: it sends no transaction and uses no key.
#
#   ./verify.sh            everything (about 10-15 minutes: the sandbox suite runs a local NEAR node)
#   ./verify.sh --quick    the same without the local node
#
# Needs: the Rust toolchain of rust-toolchain.toml (1.95.0, wasm32-unknown-unknown), cargo-near 0.23.0,
# python3, and Node 24 with npm for step 6 (skipped if npm is missing). The sandbox suite downloads a NEAR node
# binary on first run; step 6 downloads the npm packages of package-lock.json.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
quick=0; [ "${1:-}" = "--quick" ] && quick=1
log="$here/target/verify"; mkdir -p "$log"
fail=0
note() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

step "1. Tools"
note "rustc:      $(rustc --version 2>/dev/null || echo MISSING)   (expected 1.95.0, from rust-toolchain.toml)"
note "cargo-near: $(cargo near --version 2>/dev/null || echo MISSING)   (expected 0.23.0)"
note "near-sdk:   $(grep -A1 'name = "near-sdk"' Cargo.lock | grep version | head -1 | cut -d'"' -f2)   (pinned =5.30.1 in Cargo.toml)"
note "node:       $(node --version 2>/dev/null || echo MISSING)   (expected 24, from .nvmrc; only for step 6)"

step "2. Build every contract (wasm)"
build() { # crate dir, extra args, log suffix
  l="$log/build-$(basename "$1")${3:-}.log"
  (cd "crates/$1" && cargo near build non-reproducible-wasm --no-abi ${2:-} >"$l" 2>&1) \
    && note "built $1 ${2:-}" || { note "BUILD FAILED: $1 (see $l)"; fail=1; }
}
build mock-usdc; build lender; build stickers; build launchpad; build coin/stub
build coin "--out-dir $here/target/near/coin"
build coin "--features fake-ai-check --out-dir $here/target/near/coin-fake" -fake   # the test copy coin-fast

step "3. Unit and property tests (every crate)"
cargo test --workspace --exclude sandbox --no-fail-fast >"$log/tests.log" 2>&1
passed=$(grep -E '^test result' "$log/tests.log" | awk '{p+=$4} END {print p+0}')
failed=$(grep -E '^test result' "$log/tests.log" | awk '{f+=$6} END {print f+0}')
note "passed: $passed   failed: $failed"
grep -E '^test .* FAILED$' "$log/tests.log" | sed 's/^/  /'
[ "$failed" = 0 ] || fail=1

if [ $quick = 0 ]; then
  step "4. Local NEAR node: the contracts deployed and used for real (crates/coin/sandbox)"
  crates/coin/sandbox/run.sh >"$log/sandbox.log" 2>&1; rc=$?
  sp=$(grep -E '^test result' "$log/sandbox.log" | awk '{p+=$4} END {print p+0}')
  sf=$(grep -E '^test result' "$log/sandbox.log" | awk '{f+=$6} END {print f+0}')
  note "passed: $sp   failed: $sf"
  grep -oE 'ATTACK .*' "$log/sandbox.log" | sed 's/^/  /'
  [ "$rc" = 0 ] && [ "$sf" = 0 ] || fail=1
else
  step "4. Local NEAR node: skipped (--quick)"
fi

step "5. Is what runs on testnet exactly this source? (sha256 of each wasm vs the account's code_hash)"
python3 -I - "$here" <<'EOF' || fail=1
import base64, hashlib, json, pathlib, sys, urllib.request
here = pathlib.Path(sys.argv[1])
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(b):
    n = int.from_bytes(b, "big"); s = ""
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s
dep = json.loads((here / "interface/deployments.json").read_text())["testnet"]
rpc = dep["rpc"]
def code_hash(account):
    body = {"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"request_type": "view_account", "finality": "final", "account_id": account}}
    req = urllib.request.Request(rpc, json.dumps(body).encode(), {"content-type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    return r.get("result", {}).get("code_hash", "?")
rows = [("coin", "target/near/coin/coin.wasm"), ("usdc", "target/near/mock_usdc/mock_usdc.wasm"),
        ("lender", "target/near/lender/lender.wasm"), ("stickers", "target/near/stickers/stickers.wasm"),
        ("launchpad", "target/near/launchpad/launchpad.wasm"), ("stub", "target/near/stub/stub.wasm"),
        ("coin-fast", "target/near/coin-fake/coin.wasm")]
dep.setdefault("coin-fast", "coin-fast.desk-lab-2026.testnet")  # the test copy (stand-in AI check, 5-minute rounds)
bad = 0
for key, path in rows:
    account = dep.get(key)
    f = here / path
    if not account or not f.exists():
        print(f"  {key:10s} skipped"); continue
    local = b58(hashlib.sha256(f.read_bytes()).digest())
    chain = code_hash(account)
    ok = local == chain
    bad += not ok
    print(f"  {key:10s} {account:38s} local {local[:12]}…  on chain {chain[:12]}…  {'SAME' if ok else 'DIFFERENT'}")
sys.exit(1 if bad else 0)
EOF

step "6. The off-chain parts: tests of the runner, Tail or Fade, the stream cues and the shadow run (TypeScript)"
if command -v npm >/dev/null 2>&1; then
  for p in runner tailfade stream shadow; do
    l="$log/npm-$p.log"
    if (cd "$p" && npm ci --no-audit --no-fund && npm test) >"$l" 2>&1; then r=""; else r="FAILED (see $l)"; fail=1; fi
    np=$(grep -aE '^(ℹ|#) pass [0-9]+' "$l" | tail -1 | grep -oE '[0-9]+$')
    nf=$(grep -aE '^(ℹ|#) fail [0-9]+' "$l" | tail -1 | grep -oE '[0-9]+$')
    note "$(printf '%-9s' "$p") passed: ${np:-?}   failed: ${nf:-?}   $r"
  done
else
  note "skipped: npm not found (Node 24 is needed for this step only)"
fi

step "Summary"
if [ $fail = 0 ]; then note "ALL CHECKS PASSED"; else note "SOME CHECKS FAILED (logs in $log)"; fi
exit $fail
