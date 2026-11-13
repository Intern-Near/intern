# $INTERN

$INTERN is a memecoin with an AI "Intern" that proposes perp bets on Hyperliquid, and a NEAR contract that checks
every bet against the Intern's rank before anything is signed. The contract answers YES or NOPE and keeps a public
record of every answer. Everything here runs on **NEAR testnet and Hyperliquid testnet, with test dollars**. It
was built at the NEAR hackathon.

**The problem.** An AI agent that trades a shared pool of money is usually trusted, not checked. Its limits live
in a prompt or in the operator's server, and holders cannot see them or change them. Here the limits are in a
NEAR contract that holders can read. The contract holds the money, rejects any proposal that breaks a rule, and
builds and signs the Hyperliquid orders itself with NEAR chain signatures. The AI cannot place a bet that the
contract did not approve, however it was asked. Holders vote to promote, demote, fire or rehire the Intern, and
the rank sets how much it may risk.

| | |
|---|---|
| The coin contract | [`coin.desk-lab-2026.testnet`](https://testnet.nearblocks.io/address/coin.desk-lab-2026.testnet), live on testnet, 30-minute rounds |
| Its Hyperliquid account | [`0x46f8eb2a044a826c70e9682fe3bfd65970340132`](https://app.hyperliquid-testnet.xyz/explorer/address/0x46f8eb2a044a826c70e9682fe3bfd65970340132), derived from the contract by NEAR's signing network |
| Live services | trick API `https://intern-runner-production.up.railway.app/tricks`, Tail or Fade faucet `https://tailfade-faucet-production.up.railway.app/faucet` |
| The website | Not hosted yet. To run it on your machine, see [Run it yourself](#run-it-yourself) |
| All addresses | [`interface/deployments.json`](interface/deployments.json); every account and transaction: [`fixtures/chain/testnet-accounts.md`](fixtures/chain/testnet-accounts.md) |
| Tracks | Memecoins With Mechanics, Agent Economy, Privacy & Private AI, Games With Real Economies |

**One number:** the contracts on testnet are byte-for-byte this source, 7 of 7. `./verify.sh --quick` rebuilds
them and compares each sha256 with the account's `code_hash` on chain.

## Judge check: about 5 minutes, no keys, no funds

Every step below only reads. Nothing needs a wallet, a key or test money. Steps 2 to 7 need only `python3` and
`curl`.

| # | Do | See |
|---|---|---|
| 1 | `./verify.sh --quick` (needs Rust 1.95.0 from `rust-toolchain.toml`, `cargo install cargo-near --version 0.23.0 --locked`, Node 24 for step 6) | `passed: 251   failed: 0` for the Rust tests, seven lines ending in `SAME`, four TypeScript lines with `failed: 0`, then `ALL CHECKS PASSED` (exit code 0) |
| 2 | `python3 tools/view.py get_rank` | `"rank": "INTERN"`, `"status": "EMPLOYED"`: the Intern's current rank on the live coin |
| 3 | `python3 tools/view.py get_feed '{"limit": 20}'` | The live record: `round_opened`, `approved` (market, side, margin, leverage), `order_signed` (`LEVERAGE`, `OPEN`, `CLOSE`), `result_reported` with `"result_source": "REPORTED"`, `settled` |
| 4 | `curl -s https://api.hyperliquid-testnet.xyz/info -H 'content-type: application/json' -d '{"type":"userFills","user":"0x46f8eb2a044a826c70e9682fe3bfd65970340132"}'` | Hyperliquid's own fills for the contract's address (meme perps such as `DOGE`, `kPEPE`, `Open Long` and `Close Long`). The orders were signed by NEAR's signing network for the contract, not by a key we hold |
| 5 | `python3 tools/view.py get_refusals '{"limit": 3}' --on coin-fast` | NOPE answers kept on chain, for example `"code": "OVER_LEVERAGE"` (round 22, a second 10x ticket) and `"code": "NOT_ON_LIST"`. `coin-fast` is the test copy with 5-minute rounds |
| 6 | `python3 tools/view.py get_rulebook` | The exact text the AI must answer to: the round, a nonce, `rank: INTERN`, the markets, the sides, `max_leverage`, `max_margin_e6` (what is left of this round's limit) and the two allowed answer forms. The contract refuses an answer given to any other text (`WRONG_RULEBOOK`) |
| 7 | `curl -s https://tailfade-faucet-production.up.railway.app/address/boss2.desk-lab-2026.testnet` | `"hl_address": "0xd859cdeb4eaa5fcb6b9e3f8c226c8c173b0bb047"`: the Hyperliquid address NEAR's signing network derives for that NEAR account. It is the address of the Tail or Fade run in [`docs/TAILFADE.md`](docs/TAILFADE.md) |

The full check (`./verify.sh`, 10 to 15 minutes) also starts a local NEAR node and runs the contracts in it,
including an attack suite. On our machine `./verify.sh --quick` took under 3 minutes from a fresh clone, with the
Rust crates and npm packages already in the local caches. A first-ever run also downloads the toolchain, the
crates and the packages.

## How it works

1. **Money in.** People pay test USDC into the coin and get $INTERN. The money goes to one of two pools: BRAVE
   (the Intern may bet a slice of it) or SAFE (never bet). Each holder chooses the split with a dial.
2. **The rulebook.** Each round the contract publishes a rulebook: the rank, the limits in dollars, the markets.
3. **The AI answers.** In the proposal window the runner asks `z-ai/glm-5.3-flash` on NEAR AI Cloud for one
   line of JSON: a skip, or a bet such as
   `{"v":1,"round":40,"nonce":"…","action":"bet","market":"PEPE","side":"long","margin_e6":"31476233","leverage":1}`
   ($31.476233 on PEPE, long, 1x). NEAR AI signs its answer.
4. **The contract checks.** The runner passes the signed answer to `propose`. The contract verifies NEAR AI's
   ed25519 signature for the pinned model, that the rulebook in the request is the current one byte for byte, and
   the decision line. Then it applies the rank's limits. One of sixteen NOPE codes is recorded, or YES
   ([`interface/refusal-codes.json`](interface/refusal-codes.json)). A NOPE is recorded, not reverted.
5. **The contract signs the orders.** On YES the contract builds the Hyperliquid orders itself and has them
   signed by NEAR's signing network (`v1.signer-prod.testnet`) for its own derived address. It checks that the
   signature recovers to that address before publishing it. The runner only carries the signed orders to
   Hyperliquid.
6. **The result.** The runner reports the result from the fills, and the contract settles the round. On testnet
   the result is reported, not measured (see the limits below).
7. **Votes.** Holders lock $INTERN to vote. A vote can promote or demote the Intern, fire or rehire it, choose a
   playbook (advice added to the rulebook; its authors get 10% of a winning round's result), or grant a long
   shot. Voting weight grows over 7
   rounds.

| Rank | Per bet | Bets per round | Per round | Sides | Leverage | Markets |
|---|---|---|---|---|---|---|
| INTERN (start) | 2% of BRAVE | 1 | 2% | long | 1x | DOGE, SHIB, PEPE, PENGU |
| ANALYST | 5% | 2 | 8% | long | 1x | + WIF, TRUMP |
| TRADER | 10% | 3 | 20% | long, short | 2x | same |

The limits are fixed when the contract is deployed. No vote can raise them, with one exception: a `LONG_SHOT` vote
allows one ticket of 0.5% of the pool at up to 10x, at most once every seven rounds.

**Around it** (each part is described in [`docs/REAL-VS-STANDIN.md`](docs/REAL-VS-STANDIN.md)):

- **Trick the Intern.** A visitor writes to the AI. The answer is proposed unchanged, so the contract judges it
  like any other proposal. The first trick on the live coin asked for "the whole pot at 5x". The model proposed its
  $31.49 limit at 1x, the contract said YES, and the bet filled. See [`docs/TRICK-API.md`](docs/TRICK-API.md).
- **Tail or Fade.** When the Intern bets, a visitor has 10 minutes to put $10 or $25 on the same market with the
  Intern (TAIL) or against it (FADE). It is a real Hyperliquid testnet position in the visitor's own account,
  derived from their NEAR account by NEAR's signing network. See [`docs/TAILFADE.md`](docs/TAILFADE.md).
- **The reward ladder.** A free guess each round (YES, NOPE or SKIP), streaks, golden stickers, a streak jackpot,
  a payday draw from the pool's interest, and the long shot.
- **Stickers, goals, a launchpad.** Badges and "first of its kind" stickers (NEP-171), tip and goal bars, and a
  small launchpad (a constant-product curve) whose 1% fee goes to the BRAVE pool.

## Where NEAR is used

| NEAR technology | Where |
|---|---|
| Smart contracts (Rust, `near-sdk` 5.30.1) | `crates/coin` (the program), `crates/rules` (the rank checks, plain Rust), `mock-usdc`, `lender`, `stickers`, `launchpad` |
| Chain signatures (`v1.signer-prod.testnet`) | The coin signs its own Hyperliquid orders (`crates/hl-order`, `crates/coin/src`); Tail or Fade derives each visitor's Hyperliquid address and approves a trading key (`tailfade/src/mpc.ts`) |
| NEAR AI Cloud | The model `z-ai/glm-5.3-flash`. Its ed25519 signature is checked on chain by `crates/ai-check` |
| NEP-141, NEP-145, NEP-148 | The $INTERN coin and the test dollar |
| NEP-171 | Stickers and badges (`stickers.desk-lab-2026.testnet`) |
| NEP-413 signed messages | A visitor proves their account to be credited for a trick |
| Block randomness (`env::random_seed`) | Golden stickers and the payday draw |
| `@hot-labs/near-connect` | The website's wallet connection |

## What is real and what is a stand-in

The full table, with a transaction for each line, is [`docs/REAL-VS-STANDIN.md`](docs/REAL-VS-STANDIN.md). In
short:

| Real on testnet | Stand-in or not built |
|---|---|
| The coin, both pools, rounds, the feed, votes, playbooks, stickers, goals, the launchpad, the reward ladder | The dollar is a test token with an open `mint` |
| The rank checks and the "really the AI" check (NEAR AI's signature, the rulebook, the decision) | The lender is a stand-in at a fixed 5% test rate |
| Order signing by NEAR's signing network, and filled bets on Hyperliquid testnet | Margin does not move from the contract to Hyperliquid: the address was funded once by hand with 100 test USDC |
| Tricks proposed unchanged; Tail or Fade in the visitor's own account | A bet's result is reported by the runner from the fills (`result_source: REPORTED`) |
| | The funding quote (checks 13 to 16) is not built |
| | The stream's lines are written ([`interface/lines.json`](interface/lines.json)); no live video stream is built |
| | Rounds are 30 minutes for the demo; the product's round is 24 hours |

**Known limits** ([`01-SHARED-INTERFACE.md`](01-SHARED-INTERFACE.md) section 14 lists all sixteen):

- The contract cannot read Hyperliquid. It bounds what it signs against the margin it recorded.
- An immediate-or-cancel order may fill only in part, or not at all. The runner reports what happened.
- Voting power can be rented for one round's exposure. Weight that grows over 7 rounds and the fixed limits
  cap what a captured vote can do.
- If NEAR AI changes the model's signing key, every proposal is refused until the contract is upgraded. Cash-out
  still works.
- The contracts can still be upgraded: each account still holds its full-access key
  ([`docs/ACCESS-KEYS.md`](docs/ACCESS-KEYS.md)). `./verify.sh` shows what runs today.

## Run it yourself

| What | How |
|---|---|
| All checks, with a local NEAR node | `./verify.sh` (or `make verify`) |
| Only the contracts' tests | `cargo test --workspace --exclude sandbox` |
| The local-node tests | `crates/coin/sandbox/run.sh` |
| Build the contracts and compare their hashes by hand | [`docs/REPRODUCIBLE-BUILD.md`](docs/REPRODUCIBLE-BUILD.md) |
| The runner's tests (no network) | `cd runner && npm ci && npm test` |
| The website, on your machine | `cd web && npm ci && npm run dev`, then open the address Vite prints. It reads the testnet contracts |
| Read any view on testnet | `python3 tools/view.py <view> '<json args>' [--on coin-fast]` (the views: `01-SHARED-INTERFACE.md` section 8) |

Running the Intern itself (`runner/`) needs a NEAR account, a NEAR AI key and the runner's configuration. See
[`runner/README.md`](runner/README.md). The recorded AI answers and Hyperliquid replies in `fixtures/` let the
tests run without them.

## What is in this repository

| Folder | What it is |
|---|---|
| `crates/` | The NEAR contracts (Rust): `coin`, `rules`, `shared`, `ai-check`, `hl-order`, `mock-usdc`, `lender`, `stickers`, `launchpad`, `coin/stub`. `crates/coin/sandbox/` has the local-node tests |
| `runner/` | The off-chain Intern (TypeScript). It asks the model, proposes on NEAR, carries signed orders to Hyperliquid, reports results, and serves the trick API |
| `tailfade/` | Tail or Fade (TypeScript, browser and Node) and its faucet service |
| `stream/` | Builds a cue (pose, line, caption) for every feed event |
| `shadow/` | The 3-day test run: four NEAR AI models asked every 15 minutes and judged as the contract would, on paper only |
| `web/` | The website (Vite + React) |
| `interface/` | Addresses, ranks, markets, refusal codes, the stream's lines, test vectors |
| `fixtures/` | Recorded AI answers, Hyperliquid replies, and every testnet account and transaction |
| `docs/` | Real versus stand-in, measurements (gas, storage, attacks), APIs, the build |
| `tools/view.py` | Read-only questions to the testnet contracts |
| `01-SHARED-INTERFACE.md` | The interface every part follows (version 1.5) |

## How it was built

- **When.** All code here was written between 2026-11-11 and 2026-11-14, inside the hackathon's window. No
  earlier code was reused. The git history starts on 2026-11-12. The plans and the interface were written on
  2026-11-11.
- **AI-generated code.** Almost all code, tests and docs in this repository were written by AI coding agents
  (Anthropic's Claude Opus models in Claude Code), directed and reviewed by the team. Three agent sessions
  worked in parallel on the contracts, the runner and the website, held together by `01-SHARED-INTERFACE.md`.
  `crates/hl-order` and `tailfade/` are checked against vectors from Hyperliquid's official Python SDK
  (`tailfade/reference/sdk_vectors.py`, `fixtures/hl/reference/`).
- **AI-generated art.** The characters and stickers were made with ChatGPT image generation, and the room and
  animated clips with Midjourney.
- **AI in the product.** The Intern is `z-ai/glm-5.3-flash` on NEAR AI Cloud.
- **Libraries.** Rust: `near-sdk` and `near-contract-standards` 5.30.1, `near-workspaces` 0.24.0 (tests),
  `ed25519-dalek`, `k256`, `sha2`, `sha3`, `serde`, `serde_json`, `base64`, `proptest`, `tokio`, `anyhow` (exact
  versions in `Cargo.lock`). TypeScript: `near-api-js`, `@noble/curves`, `@noble/hashes`, React, Vite, Vitest,
  pixi.js, `pixi-live2d-display-lipsyncpatch`, `@number-flow/react`, `@hot-labs/near-connect`, Biome and ESLint
  (exact versions in each `package-lock.json`). Fonts: Departure Mono (`web/public/fonts/DepartureMono-LICENSE.txt`),
  Bricolage Grotesque and DynaPuff through Fontsource. The stream page can show a Live2D model. It then fetches
  Live2D's Cubism Core runtime from Live2D's server, under Live2D's licence. No Live2D model is in this
  repository.

## Team

- [Kaustubh-404](https://github.com/Kaustubh-404): the contracts (Engine 1), the website, the product and the art.
- [AtharvaWaghchoure](https://github.com/AtharvaWaghchoure): the runner and the AI and order crates
  (Engine 2).
