#!/usr/bin/env bash
# Builds the contracts the sandbox tests deploy, then runs the tests on a local NEAR node.
# Usage: ./run.sh            (from intern/crates/coin/sandbox)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
intern="$(cd "$here/../../.." && pwd)"
(cd "$intern/crates/mock-usdc" && cargo near build non-reproducible-wasm --no-abi)
for c in lender stickers launchpad; do (cd "$intern/crates/$c" && cargo near build non-reproducible-wasm --no-abi); done
# The coin as the tests deploy it: stand-in AI check + test hooks. Never deployed anywhere else.
(cd "$intern/crates/coin" && cargo near build non-reproducible-wasm --no-abi --features fake-ai-check,test-hooks --out-dir "$intern/target/near/coin-test")
# The coin with the REAL AI check (Engine 2's ai-check) + test hooks, to replay recorded answers. Never deployed anywhere else.
(cd "$intern/crates/coin" && cargo near build non-reproducible-wasm --no-abi --features test-hooks --out-dir "$intern/target/near/coin-real-test")
# The coin as coin-fast runs it (stand-in AI check, no hooks): what the 1.4 migration test upgrades to.
(cd "$intern/crates/coin" && cargo near build non-reproducible-wasm --no-abi --features fake-ai-check --out-dir "$intern/target/near/coin-fake")
cd "$intern" && cargo test -p sandbox -- --nocapture --test-threads=1
