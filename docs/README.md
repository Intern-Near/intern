# Engine 1 (the program on NEAR): where to look

| File | What it answers |
|---|---|
| `../verify.sh` (`make verify`, `make verify-quick`) | One command: builds every contract, runs every test, and checks the code on testnet is exactly this source. Sends no transaction, uses no key |
| `REAL-VS-STANDIN.md` | Which parts are real on testnet, which are stand-ins, and which are not built |
| `measurements.md` | Gas for every call (testnet and a local node), storage, and the attack suite's results |
| `REPRODUCIBLE-BUILD.md` | Pinned tools, build commands, the expected hash of each contract |
| `ACCESS-KEYS.md` | The contracts can still be upgraded; how and when the keys would be removed (the owner's decision) |
| `../fixtures/chain/testnet-accounts.md` | Every testnet account and the transaction behind each deploy and check |
| `../interface/deployments.json` | Contract addresses the site and the runner use |
| `../01-SHARED-INTERFACE.md` | The interface every part follows (v1.3), including the known limits (section 14) |

The contracts' source is in `../crates/`: `coin` (the program), `rules` (the rank checks, no NEAR code), `shared`
(types shared with Engine 2), `ai-check` and `hl-order` (Engine 2's crates, compiled into the coin), `mock-usdc`,
`lender`, `stickers`, `launchpad`, and `coin/stub`. The tests that run contracts on a local NEAR node are in
`../crates/coin/sandbox/tests/`.
