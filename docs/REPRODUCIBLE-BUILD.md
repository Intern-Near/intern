# Building the contracts yourself (and checking they are what runs on testnet)

Every contract is built from this folder with pinned tools. NEAR stores the sha256 of each account's code
(`code_hash`, in base58), so anyone can build the source and compare. `./verify.sh` does it for you (section 5).

## The tools (pinned)

| Tool | Version | Where it is pinned |
|---|---|---|
| Rust | 1.95.0, target `wasm32-unknown-unknown` | `rust-toolchain.toml` (rustup installs it on first build) |
| cargo-near | 0.23.0 | install with `cargo install cargo-near --version 0.23.0 --locked` |
| near-sdk | 5.30.1 | `=5.30.1` in `Cargo.toml`; every other crate version is fixed by `Cargo.lock` |

## The commands

From `intern/`:

```
(cd crates/coin       && cargo near build non-reproducible-wasm --no-abi --out-dir ../../target/near/coin)
(cd crates/coin       && cargo near build non-reproducible-wasm --no-abi --features fake-ai-check --out-dir ../../target/near/coin-fake)
(cd crates/mock-usdc  && cargo near build non-reproducible-wasm --no-abi)
(cd crates/lender     && cargo near build non-reproducible-wasm --no-abi)
(cd crates/stickers   && cargo near build non-reproducible-wasm --no-abi)
(cd crates/launchpad  && cargo near build non-reproducible-wasm --no-abi)
(cd crates/coin/stub  && cargo near build non-reproducible-wasm --no-abi)
```

or simply `./verify.sh --quick`, which runs these, the tests, and the comparison with testnet.

The coin includes Engine 2's crates `ai-check` (the "really the AI" check) and `hl-order` (Hyperliquid
orders), from `crates/` in this folder; their code is part of the coin's hash.

## The expected hashes (2026-11-12)

| Account | Wasm | Size (bytes) | sha256, base58 (= the account's `code_hash`) |
|---|---|---|---|
| `coin.desk-lab-2026.testnet` | `target/near/coin/coin.wasm` | 540,200 | `3yDwSmrChLAwwYX6fLq3VLsuo9QjZdkhtRc3U8Z4GkDb` |
| `usdc.desk-lab-2026.testnet` | `target/near/mock_usdc/mock_usdc.wasm` | 149,106 | `C1HZ8APmPbLQSQ9YbWNxQ563bt5XNNreneNR56qg3n8H` |
| `lender.desk-lab-2026.testnet` | `target/near/lender/lender.wasm` | 131,977 | `2uAJpQ3nxMsXYA5MHtVHTBMxa1WYjFaB2QAnK9uAu9Em` |
| `stickers.desk-lab-2026.testnet` | `target/near/stickers/stickers.wasm` | 203,578 | `22dhHG3m9RS7F2jofoenjt2kESaWpnLRDw7JvhCjTmnm` |
| `launch.desk-lab-2026.testnet` | `target/near/launchpad/launchpad.wasm` | 208,384 | `Drf72TPyCMNRw7G2YVUsj6h2k8WWxWFjXjAmEo1P82DT` |
| `stub.hackcheck-2026-1103.testnet` | `target/near/stub/stub.wasm` | 290,399 | `FArWUwVDh57zyMX9cfLQHRY8x5yMMPqi4NdBZvfKkesB` |
| `coin-fast.desk-lab-2026.testnet` (test copy) | `target/near/coin-fake/coin.wasm` | 537,862 | `9pJfHuEPH7H4qUunU3wrxMcvak5iHwwRc6CdEXnTmUv5` |

`./verify.sh --quick` on 2026-11-12 printed `SAME` for all seven. To check one by hand:

```
python3 -c "import hashlib,sys;B='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';n=int.from_bytes(hashlib.sha256(open(sys.argv[1],'rb').read()).digest(),'big');s='';exec('while n: n,r=divmod(n,58); s=B[r]+s');print(s)" target/near/coin/coin.wasm
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"coin.desk-lab-2026.testnet"}}' | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['code_hash'])"
```

## What has been checked, and what has not

- **The same machine, another folder: identical.** The whole `intern/` folder was copied elsewhere and the coin
  built there gave the same `3yDwSmrChLAwwYX6fLq3VLsuo9QjZdkhtRc3U8Z4GkDb`. The build does not depend on where
  the folder lives.
- **Another machine: not yet checked.** The same Rust, cargo-near and `Cargo.lock` should give the same bytes on
  another Linux machine, but nobody has tried it. If a judge gets a different hash, the most likely cause is a
  different Rust version (check `rustc --version` inside `intern/` says 1.95.0).
- **The fully reproducible build (in Docker) is not used.** `cargo near build reproducible-wasm` builds inside a
  pinned Docker image and records the source's git commit in the contract, so NEAR explorers can show
  "verified source". It needs the code in a git repository, and this folder is not one yet. Putting the code in
  a repository is the owner's decision; once it is, the build can be switched and the contracts redeployed.
- **The contracts can still be changed.** Each account still has its full-access key, so a matching hash today
  says nothing about tomorrow; re-run `./verify.sh`. Removing the keys is the owner's decision
  (`ACCESS-KEYS.md`).
