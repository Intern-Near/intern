# runner: the off-chain Intern

Engine 2 of $INTERN. It asks the AI for a decision, hands the answer to the contract unchanged, and delivers the
orders the contract signs to Hyperliquid. It never decides whether a bet is allowed; the contract does.

**Status (2026-11-12): follows 01-SHARED-INTERFACE.md version 1.3, and points at the real contract,
`coin.desk-lab-2026.testnet`** (`intern/interface/deployments.json`, `testnet.coin`). `preflight` passes against it
with the runner's function-call key. The first real round's results, and the first real fill (step 6, round 7), are
under "What is checked live". Steps 0 and 1 (access check, real signed AI answers) are done. Open questions and decisions for the owner:
`OPEN-ITEMS-FOR-OWNER.md`.

## Set-up

Node 24.11 or newer.

```
npm ci
cp .env.example .env    # fill in the values; .env is git-ignored
```

| Variable | Used by | What it must be |
|---|---|---|
| `NEARAI_API_KEY` | everything that asks the model | A NEAR AI Cloud key |
| `RUNNER_ACCOUNT_ID`, `RUNNER_PRIVATE_KEY` | `dry`, `once`, `loop`, `trick` | The account named in `get_constants().runner` (`intern-runner-ed25519.testnet`), with a **function-call key** for the contract allowing exactly `propose`, `sign_next` and `report_result` (01 1.1: `sign_next` is runner-only and needs no deposit). The runner refuses to start with a full-access key, a key for another contract, or a key allowing other methods |
| `RELAYER_ACCOUNT_ID`, `RELAYER_PRIVATE_KEY` | `once`, `loop` | A separate testnet account with a little NEAR and a full-access key, for `close` (it attaches 1 yocto, which a function-call key cannot), `settle` and `rebalance` (01 1.3: anyone may call it). No special rights in the contract |
| `NEAR_RPC_URL` | everything | Optional. Default `https://test.rpc.fastnear.com`. The runner refuses any RPC whose chain is not `testnet` |
| `INTERN_KEY_SCOPE` | `dry`, `once`, `loop`, `trick`, `preflight` | Optional: `off`, `warn` (the default) or `strict`. At start, the key the runner (and the relayer) signs with is checked against what is declared, and the accounts' other keys are logged as notes ("key-scope" below). `warn` only logs, so it cannot stop a deployment; `strict` refuses to start only when a signing key can do more than declared |

## Accounts

Two testnet accounts, kept apart (03 brief §3). Make them in **your own terminal**, not through a chat (and not
with Claude Code's `!` prefix, which puts the output into the conversation), because two of these commands show a
private key on screen. Paste each private key into `runner/.env` yourself; never anywhere else. Commands from NEAR's
official docs (https://docs.near.org/tools/near-cli and the near-cli-rs guide,
https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md), read 2026-11-11. Every form below was checked on
near-cli-rs 0.31.1 with `--help` (2026-11-12): it parses, but none has been run for real yet.

`save-to-keychain` / `sign-with-keychain` need a system keychain (the D-Bus Secret Service, `org.freedesktop.secrets`;
the near-cli-rs binary uses it). The Engine 2 laptop has none running (KDE, KWallet's Secret Service not on), so the
forms below avoid it: the relayer's key is printed once and goes straight into `.env`; the runner account's
full-access key goes to the **legacy keychain**, a key file in `~/.near-credentials/testnet/` (the folder the old JS
CLI used). With a system keychain, `save-to-keychain` and `sign-with-keychain` work the same way and keep the key out
of files. If the CLI asks for a signature scheme, keep ed25519: the runner reads ed25519 keys only.

```
pnpm add -g near-cli-rs@latest        # or: npm install -g near-cli-rs@latest

# the relayer: a full-access key, testnet NEAR from the faucet; its key is printed once, for .env
near account create-account sponsor-by-faucet-service <relayer>.testnet autogenerate-new-keypair print-to-terminal network-config testnet create
#   → paste the private key it shows into .env as RELAYER_PRIVATE_KEY, and RELAYER_ACCOUNT_ID=<relayer>.testnet

# the runner: the account now (its name goes to Engine 1 for get_constants().runner); its full-access key is kept
# by the CLI, never shown, for the add-key step below
near account create-account sponsor-by-faucet-service <runner>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

... and its function-call key for the contract. The account's own full-access key stays with the CLI; the runner gets
only the limited key. Run on 2026-11-12 by the Engine 2 builder for the real contract (it prints the new key pair
once; the private key goes into `.env`):

```
near account add-key intern-runner-ed25519.testnet grant-function-call-access --allowance '1 NEAR' --contract-account-id coin.desk-lab-2026.testnet --function-names 'propose, sign_next, report_result' autogenerate-new-keypair print-to-terminal network-config testnet sign-with-legacy-keychain send
#   → in .env: RUNNER_ACCOUNT_ID=intern-runner-ed25519.testnet and RUNNER_PRIVATE_KEY=<the printed private key>
```

The allowance caps what the key may spend on gas; whether a call's unused prepaid gas is charged against it is
UNVERIFIED, so 1 NEAR (about 30 calls at 300 TGas, if it is) is a safe start. When it runs out, add another key the
same way. Then `npm run runner -- preflight` checks both accounts and keys.

## The runner (step 5)

```
npm run runner -- preflight --contract <account>       # read-only: every check below, in one go
npm run runner -- status --contract <account> [--relayer <account>]
                                                       # read-only: constants, rank, round, this round's bets; whether
                                                       # NEAR AI's model list and Hyperliquid testnet's /info answer;
                                                       # the relayer's NEAR (--relayer, else RELAYER_ACCOUNT_ID)
npm run runner -- dry    --contract <account>          # steps 1 to 8 once, then stop
npm run runner -- once   --contract <account>          # one whole round, from wherever it is now
npm run runner -- loop   --contract <account>          # round after round
npm run runner -- trick  --contract <account> --message "<a visitor's message>" [--credited-to <visitor.testnet>]
```

`--contract` defaults to `testnet.coin` in `intern/interface/deployments.json`: the real contract,
`coin.desk-lab-2026.testnet`. Pass `--contract stub.hackcheck-2026-1103.testnet` to use the stub. Options:
`--max-asks <n>` (exchanges with the model per round, default 1), `--slippage-bps <n>` (how far through the market an
order's limit price is set, default 100), `--instruction <text>` (the user message's last line, default "Decide this
round's bet.").

One pass through a round, as the brief's step 5 lists it, all driven by what the chain says:

1. Wait for phase `PROPOSE` (offsets from `get_round`; no clock time is written anywhere). Then, once each round
   and before proposing, `rebalance()` (01 1.3 §9.6), sent by the relayer with 300 TGas: anyone may call it, so the
   runner's key stays limited to its three calls. It keeps the Intern's slice idle and lends the rest to the lender
   (a STAND-IN on testnet), or brings money back. The log line `rebalanced` has the dollars moved and the pool's
   idle and lent money after it. If it fails, the failure is logged and the round goes on: the program decides
   what may be bet. `dry` and `trick` do not rebalance (they use the runner's key only).
2. `get_rank`. If `FIRED`: no new bets; open bets are closed.
3. `get_rulebook`, sent unchanged as the system message.
4. Market data for the user message: the rank's markets from Hyperliquid testnet (`metaAndAssetCtxs`), where the
   orders go.
5. Ask the pinned model (`get_constants().model`): no streaming, the full model name, `x-no-aliasing`,
   `Accept-Encoding: identity`. Every exchange is saved before and as it happens.
6. Fetch the signature in the pinned scheme.
7. `propose({request, response, signature})`, the exact bytes as base64. A malformed answer is submitted as it is.
   From the trick entry point, `--credited-to <account>` adds `credited_to` (01 1.3 §9.5): the visitor whose message
   was used. The program cannot check that name; the first credited refusal of each code decides its sticker.
8. The verdict. The runner also works out its own forecast with its TypeScript copy of the checks (01 1.2: the
   strict answer rule, the $11 minimum, limits on the smaller of the pool at the round's start and now) and logs
   whether the contract agrees; a difference is logged as `CONTRACT AND RUNNER DISAGREE`. A signature that does not
   match the pinned signer is logged as `SIGNER CHANGED?` before it is submitted.
9. On YES: `sign_next` twice with the runner's key, no deposit (leverage, then the opening order), each priced from
   Hyperliquid testnet's mid, `--slippage-bps` through the market, in Hyperliquid's format, never past the mid.
   `px_e8` is sent as a decimal string (01 1.2). If `sign_next` returns null (the signing network failed), it is
   called again on the next pass.
10. Each signed action is posted to Hyperliquid testnet `/exchange` at once, within its 120 seconds, exactly as the
    contract signed it; the request and the reply are saved in `intern/fixtures/hl/exchange/`. When Hyperliquid
    refuses an action with "User or API Wallet 0x… does not exist", the log notes the address it names: Hyperliquid
    recovers the signer from the signature first, so this shows who signed. If Hyperliquid refuses the leverage, the
    opening order is not signed (01 has no way to sign the leverage again), with one exception: when the refusal is
    that the contract's own address has no account yet (never funded), the opening order is signed and sent all the
    same, since nothing can be placed or filled there, and Hyperliquid checks that signature too.
11. Hold until phase `CLOSE`.
12. `close` (the relayer, 1 yocto), priced like step 9 on the other side, then deliver the closing order. An
    immediate-or-cancel order fills at once or never, so when every closing order so far has been sent (or expired
    unsent) and Hyperliquid's fills still show the bet open, `close` is called again at the price of that moment
    with twice the last price margin (100, 200, 400, 800, then at most 1,000 basis points). 01 §9.3 step 4 allows
    this for as long as the bet has no result: the order is reduce-only. After 6 closing orders the runner logs
    `STUCK` and waits for a person.
13. Work out the dollars returned from Hyperliquid's own fills and funding for the contract's address
    (`returned = margin + trading result − fees + funding`, `src/result.ts`), cross-checked against the open
    positions Hyperliquid shows, and `report_result`. Hyperliquid's replies it was worked out from (`userFillsByTime`,
    `userFunding`, `clearinghouseState`) and the working are saved first, in
    `intern/fixtures/hl/exchange/<time>-round<r>-position<p>-result/` (`info.json`, `result.json`), next to the
    orders' own folders. If the opening order did not fill, the margin is reported back in full, and the log says so.
14. `settle`.

**Restart-safe.** Each pass reads the round, the rank, the round's bets and the outbox, and does the next thing due.
The number of exchanges already made this round is read from the chain (`bets_used + skipped + refused`), so a
restart never asks again. A signed action is never sent twice: `logs/<contract>/deliveries.jsonl` records each
delivery, and Hyperliquid refuses a nonce used before anyway. An action found expired is not sent.

**Every failure is visible.** One JSON line per step, with the round id, in `logs/<contract>/runner.jsonl` and on
the terminal. A failed exchange with the model is retried at most three times per round, each retry logged with its
reason. A failed step for one bet is logged and tried again on the next pass. After 20 failed passes in a row the
runner stops with exit code 1.

One runner per contract at a time (a lock file in `logs/<contract>/`): two would race for the same nonce.

**`preflight`** checks, read-only and in one go: each view the runner uses and the exact shape of its answer; the
constants against 01 (testnet, version 1.3, the market table, the ranks, the $11 minimum); where the BRAVE money is
(idle, lent, the lending mode); the rulebook against 01 §6.1's text for this round (unchanged in 1.3, with the
active playbook's text on the `playbook:` line), line by line; that `hl.address` is the address NEAR's signing network derives for
this contract and `hl.path`; that the pinned model is listed by NEAR AI and that its signer is the pinned one; the
runner account (`get_constants().runner`, a function-call key for this contract allowing exactly `propose`,
`sign_next` and `report_result`); the relayer (a separate account, a full-access key, its balance); and the
Hyperliquid testnet balance of the contract's address. It exits with 1 if any check fails.

## What is checked live

| What | How | Result |
|---|---|---|
| **A round under 01 1.3** (round 9 of `coin.desk-lab-2026.testnet`, 2026-11-12 12:39–12:49 UTC) | `npm run runner -- once`; every transaction then read back with `wait_until: FINAL` | All three calls SUCCESS (VERIFIED). `rebalance` (relayer, no deposit, 300 TGas attached) tx `GrD4NKSEXQcnpntZHKpxtwmNBcitbToFibbNYyrKXSTK`, 12.06 TGas burnt, returned `"98293971"`: it lent $98.293971 (the $100.30 of outside income credited when the round opened, less what the slice needed), leaving exactly INTERN's slice idle ($11.494551 = 2% of $574.727578) and $563.233027 lent to the STAND-IN lender. `propose` tx `2eq9NnudQAxLHuim7dSPgLRGBwBMbviembX1FrfgJdx2`: GLM answered skip; SKIP, as the runner forecast. `settle` tx `4n9y6pakzVQj9RYjm36yvCw4MomMg4MjyNTDEnMegcim`, result 0. No trade, so nothing went to Hyperliquid |
| **The first real fill** (step 6: round 7 of `coin.desk-lab-2026.testnet`, 2026-11-12 11:39–11:49 UTC, after the owner put 100 test USDC on the contract's Hyperliquid address) | `npm run runner -- once`; every transaction then read back from the RPC with `wait_until: FINAL`; Hyperliquid's fills and account read back | All six calls SUCCESS (VERIFIED). `propose`: YES, position 3 (`z-ai/glm-5.3-flash` bet DOGE long $17.997883 at 1x, INTERN's whole 2% limit; the runner's forecast agreed), tx `to2Ws7EBSoUsBG5ch7mQpiyrF1tVmRa2cUjVi31Nfz4`. Leverage tx `Hsdcwc7bM7kFzCfE9cLsh6D11JrvHfwLjYHnwkHFsiEn`: Hyperliquid accepted it (`{"status":"ok","response":{"type":"default"}}`). Opening order tx `89jnB9h8uhUJEFEAef9zEnS7YTKin6vPpkg515jhLWbm` (buy 268 DOGE, limit 0.067076, IOC): filled 268, as 251 at 0.06647 and 17 at 0.06656. `close` (relayer, 1 yocto) tx `Hoot635hrvyVqR8BGUdm1pzLDi2HtvHpyo4KfGjLj1MB` (sell 268, reduce-only, limit 0.065767): filled 268 at 0.066397 on the first try. Fees $0.016023, no funding. `report_result` 17960766 tx `EAisCAqMF6uJ8pkKkRoB6oVruEdJkd3nBzAoJbwfzu1r`; `settle` tx `FjUGg2EmNxBLuhXUxmZZ2dDANPENGmVCx8G2Qrf8Nr7x`, round result −37117. Hyperliquid's own account value went from 100.0 to 99.962883: the same −$0.037117. Everything is in `fixtures/hl/exchange/20261112T11*-round7-*` |
| Hyperliquid's `closedPnl` | Round 7's closing fill | −0.020904. It leaves out fees, and it equals (0.066397 − 0.066475) × 268, with the average entry price cut to 0.066475; the fills' own prices give −0.021094. The account value followed the fills, not `closedPnl`, so the runner's way (prices, sizes, fees) is the one that matched (VERIFIED on this one bet) |
| **One whole round on the real contract** (round 6 of `coin.desk-lab-2026.testnet`, 2026-11-12 09:33–09:49 UTC) | `npm run runner -- once`; every transaction then read back from the RPC with `wait_until: FINAL` | All six calls SUCCESS (VERIFIED). `propose`: YES, position 2 (`z-ai/glm-5.3-flash` bet PEPE long $11 at 1x; the runner's forecast agreed), tx `25YLUkh7u1hjFTyysHCbtTT8vK4mAt7R6TukXfE4veB7`, 4.8 TGas burnt. `sign_next` (runner's key, no deposit, `px_e8` a string): leverage tx `3Jac6BQf4SXtWzXn7xnb7YqksyeCnAmQGyKJA6tRkHr2` and opening order tx `6eHZ5K7F9cAmmPSjsajigUKo6kqbM83B7BYCCoGDgMez`, about 15.6 TGas each. `close` (relayer, 1 yocto) tx `3Qdd2YYYfeVBCMzWmNXTqXH2f3RZ95yXo3MfhN4gJipG`, 15.6 TGas. `report_result` 11000000 tx `GoPUvXo3gNPjvZ65phWKuu7xvMoQMoqSnKJ8Rh6EL1cX`, 2.5 TGas. `settle` tx `JDP5J7WkKov3T2VV9wUNtH3yBYvNdc8d8z5a3uxFtHPW`, result 0 |
| The contract's signed actions on Hyperliquid testnet | The same round: the three actions from `get_outbox`, posted as they were | Hyperliquid answered each with "User or API Wallet 0x46f8eb2a044a826c70e9682fe3bfd65970340132 does not exist.": it recovered the contract's own address from every signature (`v` 28, 27, 27); the address has no test dollars, so nothing traded (VERIFIED). Requests and replies: `fixtures/hl/exchange/20261112T09*` |
| `preflight` against the real contract | `npm run runner -- preflight` | Every check passes; one warning: the Hyperliquid account has no test dollars (VERIFIED, 2026-11-12) |
| Delivery of a signed order to Hyperliquid testnet | An order signed by a throwaway key (official SDK), sent with the runner's own `exchangeBody` and `postExchange` (`fixtures/hl/exchange-selftest/`) | Hyperliquid recovered exactly the throwaway address from the runner's body (VERIFIED, 2026-11-11). It has no funds, so nothing traded |
| The contract's Hyperliquid address | `derived_public_key` on `v1.signer-prod.testnet` for the research probe, through the runner's code | `0x283779…e040`, as in the research (VERIFIED) |
| The testnet RPC, the program's views | `status` and `preflight` against the research probe | Both answer on testnet; the probe has no `get_constants`, and both say so in one line |
| Replies used by the tests | Hyperliquid testnet market data, mid prices, the probe's empty account; NEAR AI attestation reports | Saved in `fixtures/hl/info/` and `test/data/` |

## Other commands

| Command | What it does |
|---|---|
| `npm run check` | Read-only. Checks the NEAR AI key, the four signed models and their signers, and the six Hyperliquid markets on both networks against 01 §4. Exit code 0: all match. 1: a difference, or no key. 2: a call failed |
| `npm run check -- --save` | The same, and saves the raw responses under `../fixtures/` in a folder named by the UTC minute. Never overwrites |
| `npm run record -- --case <case> [--model <id>]…` | Records one real signed answer per model into `../fixtures/ai/<model-slug>/<case>/`. Spends a little NEAR AI credit |
| `npm run verify-recordings` | Re-verifies every recording from the saved files alone: no network, no key |
| `npm run verify-round -- <tx hash>` | Re-checks one `propose` transaction from public data (below). Read-only, no key |
| `npm run attestation-check` | Checks a fresh NEAR AI attestation report for the pinned model (below). Read-only, no key |
| `npm run fills-check -- [--coin <account>] [--rounds N] [--rpc <url>] [--json <file>]` | Read-only. The results the runner reported against Hyperliquid's own fills ("fills-check" below) |
| `npm run key-scope -- <account> [--expect runner\|relayer] [--key <public key>]` | Read-only. The key an account signs with against what is declared, and its other keys ("key-scope" below) |
| `npm run books -- [--coin <account>] [--json <file>]` | Read-only. Whether the coin holds and has lent exactly what it owes, bucket by bucket ("books" below) |
| `npm run supply-log -- [--coin <account>] [--json <file>] [--csv <file>]` | Read-only. Every mint and burn of $INTERN, rebuilt from the feed, against `ft_total_supply` ("supply-log" below) |
| `npm run quote -- --market PEPE --side long --margin 20 [--leverage 1]` | Read-only. "Why NOPE?": the verdict a bet would get from checks 6 to 12 right now, with the rule, its 01 section and the numbers ("quote" below) |
| `npm run --silent mcp` | The read-only MCP server for other AI agents, over stdio ("mcp" below) |
| `npm run mcp-check` | Starts that server the way an MCP client does, lists its tools, calls `intern_status` and `intern_quote`. Read-only |
| `npm run contract-scan -- [--accounts a,b,...] [--json <file>]` | Read-only. Who can change each contract: keys, the host functions its code imports, the code hash against the recorded one ("contract-scan" below) |
| `npm run refusals -- [--coin <account>] [--json <file>]` | Read-only. The sixteen NOPE codes, each with its count, first example and that example's transaction ("refusals" below) |
| `npm run proof -- [--json <file>]` | Read-only. Everything above in one JSON bundle for a proof page ("proof" below) |
| `npm test` | The tests. Offline |
| `npm run verify` | Type check, lint, tests |

## verify-round: re-check a proposal from public data

```
npm run verify-round -- <tx hash> [--sender intern-runner-ed25519.testnet] [--rpc <url>] [--save <dir>]
```

Anyone can run it: it needs NEAR RPC only, no key and no NEAR AI call. For one `propose` transaction it:

1. reads the transaction and its receipts with `tx` (`wait_until: NONE`) from `--rpc` (default
   `https://test.rpc.fastnear.com`). A regular node keeps about 36 hours; when it answers `UNKNOWN_TRANSACTION`, the
   archival nodes `https://archival-rpc.testnet.fastnear.com`, then `https://archival-rpc.testnet.near.org` are
   tried (both answered for a 2026-11-11 transaction on 2026-11-13), and the later calls start there too;
2. decodes the three base64 arguments (01 §9.3) strictly, as the contract does: the exact request, the exact
   response, the signature;
3. rebuilds the signed text `model:sha256(request):sha256(response)` (01 §6.3) and verifies the signature with 01's
   pin (`src/pinned.ts`: `z-ai/glm-5.3-flash`, ed25519, `5a0210f2…caff`), with `src/signature.ts`; it also shows the
   contract's own pin, `get_constants().model`, read at the block before the proposal ran. A signature that fails is
   tried against the ed25519 keys recorded for the four signed models, to name its signer (ed25519 has no key
   recovery, so another key cannot be named);
4. checks the request's shape (01 §6.3) and compares its system message, byte for byte, with what `get_rulebook`
   returned at the block before the proposal ran (a `query` with `block_id`): the rulebook of that moment;
5. reads the AI's answer as a decision line for that round and nonce (01 §6.2);
6. prints the contract's verdict, from the receipt's return value and its `approved`, `refused` or `skipped` event,
   and whether it fits this re-check of checks 3 to 5.

Exit code 0: everything verified and the verdict fits. 1: a problem, or a part that could not be checked. 2: the
transaction could not be read or is not a proposal. `--save <dir>` keeps every RPC reply in `<dir>/rpc.json`; the
tests replay two saved this way (`fixtures/ai/verify-round/`).

Not done: a request whose JSON writes a key twice is not detected (`JSON.parse` keeps the last copy; `ai-check`
refuses it). Checks 1, 2 and 6 to 12 are not recomputed; the verdict shown for them is the contract's. If another
receipt changed the contract earlier in the same block, the rulebook read at the previous block can differ; the
line says so. On `coin-fast` the signature is the stand-in text `FAKE` and the tool says that it is not a NEAR AI
signature.

Real run, 2026-11-13 (the live coin, round 51, trimmed):

```
$ npm run verify-round -- LNUHvA9cZe5edjeqGMK4htV6rkAuf5uM8VqDN2KDtkz
  from intern-runner-ed25519.testnet to coin.desk-lab-2026.testnet, method propose, status FINAL; read from https://test.rpc.fastnear.com
  OK         model: z-ai/glm-5.3-flash named in the request; 01 pins z-ai/glm-5.3-flash
  OK         signer: the ed25519 signature verifies with the pinned key 5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff: NEAR AI's z-ai/glm-5.3-flash key signed exactly these bytes
  OK         rulebook: the system message equals, byte for byte, the rulebook get_rulebook served just before the proposal ran (round 51, nonce ff0388b1b803fd25, 728 bytes)
  INFO       the answer: {"v":1,"round":51,"nonce":"ff0388b1b803fd25","action":"bet","market":"PEPE","side":"long","margin_e6":"20000000","leverage":1}
  INFO       return value: YES, position 32
  OK         agreement: the contract passed checks 3 to 5, and so does this re-check
RESULT  verified from public data: z-ai/glm-5.3-flash signed this answer to this request, the request carried the rulebook of that moment, and the contract's verdict (YES, position 32) fits it
```

## attestation-check: NEAR AI's hardware evidence for the pinned model

```
npm run attestation-check -- [--model z-ai/glm-5.3-flash] [--algo ed25519] [--save <dir>]
```

It asks NEAR AI for a fresh attestation report (`GET /v1/attestation/report`, `provider=near`, a new random 32-byte
nonce; public, no key, not billed) and checks each model candidate as NEAR AI's docs describe
(`docs.near.ai/cloud/verification/cloud-api/model-attestations.md` and `.../reference/quote-nonce-signer.md`),
with Node's own crypto and no new dependency:

- the nonce is echoed (`request_nonce`), and the signer is 01's pin;
- the Intel TDX quote (`src/tdx-quote.ts`): its PCK certificate chain ends in Intel's SGX root certificate (pinned,
  from Intel's site), the quoting enclave's report is signed by the PCK key and binds the attestation key, and the
  quote is signed by that key; its report data is the signer's key then our nonce; debug mode is off; MRCONFIGID is
  `01 || sha256(app_compose) || 15 zero bytes`; the event log replays to the quote's RTMR3;
- the NVIDIA GPU evidence (`src/nvidia-gpu.ts`): the payload carries our nonce; it is sent unchanged to NVIDIA's
  attestation service (`POST https://nras.attestation.nvidia.com/v3/attest/gpu`), and the reply must say
  `x-nvidia-overall-att-result: true`; its tokens' ES384 signatures are checked against NVIDIA's published keys,
  with our nonce, inside their time window, every GPU's token named by the overall one.

UNVERIFIED (printed on every run, with the reason): Intel's TCB status and advisories, the quoting enclave's
identity and certificate revocation (they need Intel's collateral; NEAR AI's docs name the `dcap-qvl` verifier for
that, 27 npm packages, not added); the measured software against an allowlist, and the images' build provenance
(NEAR AI's docs leave both to the reader's policy); which instance answered a given completion (instances share the
key); NVIDIA's own checks behind its verdict, and any link between the GPU evidence and the TDX quote beyond the
shared nonce; the gateway's attestation. Exit code 0: every check passed; 1: a check failed; 2: a call failed. The
tests use a saved run (`fixtures/ai/attestation/`).

Real run, 2026-11-13 14:00 UTC (trimmed):

```
$ npm run attestation-check
  OK    nonce echoed: request_nonce is ours
  OK    signer is 01's pin: 5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff (01 §6.3)
  OK    PCK certificate chain: Intel SGX PCK Certificate -> Intel SGX PCK Platform CA -> Intel SGX Root CA; each signed by the next, the last is Intel's pinned root, all valid now
  OK    quote signature: the header and TD report are signed by the attestation key
  OK    report data: the quote's report data is the signer's key then our nonce: it binds both
  OK    event log: RTMR3 replayed from 10 events equals the quote's
  OK    GPU verdict: x-nvidia-overall-att-result is true
  OK    each GPU: 8 GPU token(s), each signed by NVIDIA, named by the overall token, nonce matched
RESULT  every check above passed: NEAR AI's z-ai/glm-5.3-flash ed25519 key is bound to a fresh Intel TDX quote with our nonce, and the GPU evidence with the same nonce passed NVIDIA's attestation. The parts listed as UNVERIFIED were not checked.
```

## Seed and temperature

Could `temperature: 0` and a fixed `seed` stop the runner re-asking the AI until it likes the answer? No:
`docs/seed-and-temperature.md` has the docs, 10 real calls and a proposal for the owner. `ai-check` is unchanged.

## fills-check: the reported results against Hyperliquid's fills

```
npm run fills-check -- [--coin <account>] [--rounds N] [--rpc <url>] [--json <file>] [--save <dir>]
```

Read-only; it needs no key and reads no `.env`. For the last N rounds (default 10, the current one included; at
most 200) it reads what the contract recorded: each round (`get_round_by_id`), its bets (`get_positions`), the orders
the contract signed (`get_outbox`) and the feed (`get_feed`, whose `result_reported` events must agree with
`get_positions`). Then it reads Hyperliquid testnet's own records for the contract's address
(`get_constants().hl.address`) since the first of those rounds began: the fills (`userFillsByTime`, paged) and the
funding (`userFunding`). It ties each signed order to its fills, works each bet's result out again with the runner's
own rule (`src/result.ts`: returned = margin + trading result − fees + funding), and prints one line per bet: round,
market, side, margin, orders signed (opening and closing), fills matched, the reported and the recomputed result (in
dollars, returned − margin), and a status.

| Status | Means |
|---|---|
| `OK` | The fills tied to the bet's orders give exactly the amount reported, to the micro-dollar |
| `NO FILLS` | No fill for any of its orders (or no opening order was signed), and the margin was reported back in full |
| `MISMATCH` | The fills give another amount than the one reported, or show the bet still open, or the feed and `get_positions` disagree. The line below says which |
| `UNMATCHED FILLS` | Fills on the bet's coin, inside the time of its orders, that none of its signed orders accounts for |
| `NOT REPORTED` | No result yet (the round is still running). The recomputed amount is shown |
| `NOT CHECKED` | The contract no longer keeps the bet's signed orders: `get_outbox` keeps the last 200 signed actions |

A summary follows, with the counts and any fill on the account that no signed order accounts for. `--json <file>`
writes the same data for a web page. `--save <dir>` also saves every view and Hyperliquid reply as received (the tests
replay one such recording). Exit code: 0 everything matches; 1 a `MISMATCH`, `UNMATCHED FILLS` or a fill no order
accounts for; 2 a call failed.

**The matching is approximate** until orders carry a client order id (another item adds one to `crates/hl-order`).
Today a fill is tied to a signed order by what both show: the coin, the side and direction (`Open Long`, `Close
Long`, …), the size (an order's fills, grouped by Hyperliquid's order id, add up to at most its size) and the time
(between the order's nonce, the millisecond it was signed, and its expiry, with the runner's 10 s of slack). When two
orders fit, the one signed last before the fills wins. With a client order id the tie would be exact: live fill
records carry a `cloid` when the order had one.

First real run (2026-11-13 13:56 UTC, all 52 rounds of `coin.desk-lab-2026.testnet`): 32 bets, 30 `OK`, 1 `NO FILLS`
(round 6, before the address was funded), 1 `MISMATCH`: round 3, where position 1 was reported +$1.00 with no order
ever signed. That was Engine 1's step-4 test, `report_result {"position_id":1,"returned":"16000000"}` sent by
`runner.desk-lab-2026.testnet` (tx `Bb8owBz1HGqQEgwtx2ZdD9KXD3fQem6JvvYtEEu2Ke9z`, read on the archival RPC), before
this runner existed. Every one of the address's 62 fills is tied to an order the contract signed, and round 7 came out
at exactly the runner's own saved working (17960766).

Not done: it cannot say who reported a result (the views do not say); it does not compare with the positions open now
(the runner's extra check when it reports); fills older than the oldest order the contract keeps are listed apart, not
checked; it trusts what Hyperliquid's /info says.

## key-scope: the key the runner signs with, and the account's other keys

```
npm run key-scope -- <account> [--expect runner|relayer] [--key <public key>] [--coin <account>] [--rpc <url>]
```

Read-only; it needs no private key and reads no `.env`. It lists every access key of the account (the RPC query
`view_access_key_list`): full access, or a function-call key with its contract, methods and allowance. The verdict is
about one key only, the one the runner (or the relayer) signs with, named by `--key`:

| Role | Its signing key, as declared | Where |
|---|---|---|
| runner | A function-call key for the coin contract limited to exactly `propose`, `sign_next` and `report_result`; the account is `get_constants().runner` | 01 §9.3 and §13; "Set-up" above |
| relayer | A full-access key, because `close` attaches 1 yocto and a function-call key cannot attach NEAR (NEAR's docs, https://docs.near.org/protocol/access-keys); a separate account, not the contract's runner | "Set-up" above and `.env.example`. 01 does not name the relayer |

| Verdict | Means |
|---|---|
| `AS DECLARED` | The signing key is exactly as declared |
| `NOT AS DECLARED` | The signing key can do more: full access, another contract, every method or other methods (or the relayer's account is the contract's runner). The only verdict that makes `INTERN_KEY_SCOPE=strict` refuse to start |
| `UNUSABLE` | The signing key can do less than the calls need, or is not on the account, or the account is not the contract's runner |

The account's other keys are listed with a plain note, never as a failure: a NEAR account normally keeps its owner's
full-access key, and that is not the key the runner signs with. For example: "also holds 1 full-access key (normally
the account owner's key; whoever holds it can do anything with this account)". Without `--key`, every key is listed
with whether it would pass as the signing key, and there is no verdict on which key the runner uses. Without
`--expect`, the account is judged as the runner when `get_constants().runner` names it, and only listed otherwise.
Exit code: with `--key`, 0 as declared and 1 otherwise; without it, 0 when some key would pass and 1 when none
would; 2 a call failed or a bad option.

The same check runs in `npm run runner -- preflight` (the lines `runner key scope` and `relayer key scope`) and at the
start of `dry`, `once`, `loop` and `trick`, behind `INTERN_KEY_SCOPE`. There the signing key is the public key of
`RUNNER_PRIVATE_KEY` (and `RELAYER_PRIVATE_KEY`), derived the way the runner loads its keys; the private key itself is
never shown. `warn`, the default, logs one `key scope` line per account and never stops the runner; `strict` refuses
to start only when a signing key is `NOT AS DECLARED`; `off` skips it. A check that cannot run is logged and stops
nothing: the key check just before it already stops a runner whose key cannot be read or does not fit. In `preflight`,
`NOT AS DECLARED` is a warning (a failure with `strict`), `UNUSABLE` a failure, and with no private key set the keys
that would pass are listed.

Real runs (2026-11-13, read-only): `npm run key-scope -- intern-runner-ed25519.testnet --key
ed25519:Cd5AKFazydp6F8rvUkKZsxV2mQYpUiAGAPEb464XF9wy` gives `AS DECLARED` (the function-call key for the coin: the
three calls, 0.870 NEAR of allowance left), with the note that the account also holds 1 full-access key
(`ed25519:5ymHpQp7aMbRG2sLuD4CkvoUoFqfw9uvXoWFoPAiikes`, kept by the NEAR CLI: "Accounts" above). Without `--key`: no
verdict on which key the runner uses, and 1 key would pass as its signing key, the same function-call key; exit
code 0. The relayer `intern-relayer-ed25519.testnet` with `--expect relayer --key
ed25519:5zY72Yfx1wsREXKUbynWnf1z3g5M1HfcQcQPS3BAzrQT`: its one full-access key, `AS DECLARED`, 9.91 NEAR.

## books: do the coin's dollars add up?

```
npm run books -- [--coin <account>] [--lender <account>] [--rpc <url>] [--json <file>] [--save <dir>]
```

Read-only; it needs no key and reads no `.env`. It pins one final block and reads every number at that block, so a
payment cannot fall between two reads. What the coin owes comes from its own views, bucket by bucket; what holds
that money is the test dollar's balance of the coin (`ft_balance_of` on `get_constants().usdc_token`) and what the
lender's own books say the coin lent it (the lender's `get_account(<coin>).principal`, `crates/lender`). The rule is
01 §9.7's, the one the contract's sandbox tests assert after every move:

```
USDC held by the coin = brave.total - brave.lent + brave.pending + safe.total + brave.income_waiting
                        + jackpot + draw_pot + prizes_owed,      and brave.lent is at the lender
```

| Bucket | View field | Where the money is |
|---|---|---|
| BRAVE pool, split into idle, margin on open bets and lent | `get_pot.brave.total` (`idle`, `in_play`, `lent`) | the coin's USDC; `lent` at the lender |
| BRAVE pending (paid in, coins at the next opening) | `get_pot.brave.pending` | the coin's USDC |
| Outside income waiting for the next opening | `get_pot.brave.income_waiting` | the coin's USDC |
| SAFE | `get_pot.safe.total` | the coin's USDC |
| Streak jackpot, payday draw pot, prizes owed | `get_rewards.jackpot`, `.draw_pot`, `.prizes_owed` | the coin's USDC |

`brave.interest` is shown but not added: it is a running total of interest collected, which since 01 1.4 sits in
the draw pot or was paid as prizes. It prints the buckets, what holds them, each place's difference (the coin's
USDC, the lender) and the total's, and two checks from 01: `idle + in_play + lent = brave.total` (§9.6) and
`safe.lent` is 0 (the §9.7 rule counts all of SAFE as held by the coin).

| Verdict | Means |
|---|---|
| `ADD UP` | Each place holds exactly what it should, to the micro-dollar |
| `MOVING` | The total adds up, but the coin and the lender differ by the same amount: a loan or a repayment in flight |
| `SURPLUS` | More is held and lent than is owed: dollars sent by a plain `ft_transfer`, or a payment in flight |
| `SHORT` | Less is held and lent than is owed. A payment in flight can do this for a block or two; run it again |
| `NOT CHECKED` | Money is lent and no lender was read (`--lender`) |

Exit code: 0 `ADD UP` with both checks passing; 1 anything else; 2 a call failed. `--json` writes the same data;
`--save <dir>` keeps every RPC exchange as received (the tests replay two such recordings).

It says plainly what is not in these books. **Hyperliquid:** the bets' margin there was funded by hand, not by the
contract (01 §14.3; the live coin's address got 100 test USDC once), so `brave.in_play` never leaves the coin's USDC
and the Hyperliquid account is outside the books. **Results** are reported by the runner, and the contract mints or
burns test dollars to match each round's result (01 §14.12), so the books add up whatever the bets did; `fills-check`
is what checks the results against the fills. **The lender** is a stand-in: it pays interest out of the dollars it
holds and mints any shortfall when it pays back (`crates/lender` `send`), so its own USDC can be below what it owes
(on 2026-11-13 it held 0.000110 less than the two coins' principal, the same as the interest the live coin had
collected from it). Its interest
accrued and not yet collected is shown, not counted. `get_constants` does not name the lender; the default is
`testnet.lender` in `interface/deployments.json`.

Real runs (2026-11-13 15:09 UTC, read-only): the live coin at block 277526435 owes 1894.091972 (BRAVE pool 1572.985657,
SAFE 221.106315, jackpot 100.000000, the rest 0); the coin holds 351.951646 and the lender 1542.140326 for it:
`ADD UP`, difference 0.000000. `coin-fast` at block 277526441: owes 703.800000, holds 28.800000 and lent 675.000000:
`ADD UP`.

## supply-log: every mint and burn of $INTERN

```
npm run supply-log -- [--coin <account>] [--rpc <url>] [--json <file>] [--csv <file>] [--save <dir>]
```

Read-only; no key, no `.env`. It reads the whole feed (`get_feed`, every page) at one final block, rebuilds the coin
supply event by event, and compares the total with `ft_total_supply` at the same block. What changes the supply is
taken from the contract's code (`crates/coin`, `crates/rules`, read only):

| In the feed | What it does to the supply | Kind |
|---|---|---|
| `round_opened` | The dollars waiting become coins at that moment: `floor(waiting × supply / pool)` (`shares.rs` `open_round_mint`). The first conversion ever makes as many coins as dollars and locks 1,000 units for ever in the contract's own balance. The event carries no coin count, so the count is worked out with that rule from the feed's own figures (`brave_at_open`, the dollars waiting) | MINT |
| `coins_minted` | Nothing: one account's share of an opening, written to its balance the next time it acts (01 §5). Checked against what the rule gives that account | WRITE |
| `cashed_out` from BRAVE with `coins` | Burns them | BURN |
| `dial_turned` to SAFE | Burns `amount` coins | BURN |
| `paid_in` to BRAVE, `dial_turned` to BRAVE | Dollars wait for the next opening | WAIT |
| `cashed_out` from BRAVE with `coins: null` | Waiting dollars taken back | TAKEN BACK |

Every other event in 01 §10 moves no coin. The output: one line per event (seq, time, round, kind, account, dollars,
coins, the supply after it), one line per round that minted, wrote or burned coins (dollars in, coins minted, the
price, written so far, not yet written, burned, the supply after), then the supply now: minted (locked for ever,
written to accounts, not yet written, rounding dust), minus burned at cash-out and by the dial, against
`ft_total_supply`. Checks: the rebuilt supply equals `ft_total_supply`; `ft_total_supply` equals
`get_pot.coin_supply`; the locked units equal `ft_balance_of(<coin>)`; the dollars still waiting equal
`get_pot.brave.pending`; every `coins_minted` gives its account exactly what the rule gives it. An opening that is
due but not yet written by any transaction is counted as the views count it. `--csv` writes the event lines (amounts
with 6 decimals), `--json` everything. Exit code: 0 the feed accounts for every coin; 1 a difference or a gap; 2 a
call failed.

**What the feed cannot account for** is listed, never filled in: a feed that no longer starts at seq 1 (it keeps the
latest 1,000 events; then the supply before its first event is unknown, so the openings' coins cannot be worked out
and nothing is compared), an event 01 §10 does not list, an event that disagrees with the rule, or a difference with
`ft_total_supply`. A cash-out or dial turn in flight at the block burns its coins before the feed logs it: run again.

Real runs (2026-11-13 15:09 UTC): the live coin at block 277526446, feed seq 1 to 313, all of it. Four openings made
coins: round 2 (100.000000, of which 0.001000 locked), round 3 (900.000000), round 5 (49.947423), round 12
(824.695144). Two cash-outs burned 474.999250 and two dial turns 101.000000. Rebuilt 1298.643317 = `ft_total_supply`
1298.643317; the three `coins_minted` events match the rule. `coin-fast` at block 277526452: 700.000000 =
`ft_total_supply`, its round 23 due and not yet written. Findings for the owner, printed by the tool:

- `round_opened` carries no coin count and the 1,000 locked units have no event, so the log depends on the share
  rule; a `minted` and `locked` field on `round_opened` would make the feed state it (an interface change).
- 824.695144 coins (63.5% of the live supply), boss1's $1,000 of round 12, have no `coins_minted` event yet, because
  that account has not acted since (by design, 01 §5). The contract emits its NEP-141 `ft_mint` log at that same later
  moment, so adding up `ft_mint` and `ft_burn` logs gives 473.948173, not `ft_total_supply` (from the code; how an
  explorer counts is UNVERIFIED).
- The feed has used 313 of its 1,000 places, about 5.9 a round: in about 116 more rounds (around 2.4 days at 30-minute
  rounds) seq 1 drops out and the log can no longer be rebuilt from the feed alone.

## quote: "Why NOPE?", a free dry run of a bet

```
npm run quote -- --market PEPE --side long --margin 20 [--leverage 1] [--coin <account>] [--rpc <url>] [--json] [--save <file>]
```

The verdict a bet would get from checks 6 to 12 (01 §7) right now: YES, or the NOPE code, with the rule in plain
words, its 01 section, and the numbers it hit (asked against limit, and where the limit comes from). Each check is
listed; the ones after the deciding check are "not reached", with what each would say on its own. It is free: it only
reads the contract's views (`get_constants`, `get_rank`, `get_round`, `get_pot`, `get_rulebook`, `get_positions`),
all at the latest final block. Nothing is signed or sent, no key is needed, no `.env` is read. `--margin` is in
dollars (up to 6 decimals). Exit code: 0 YES; 1 NOPE; 2 no quote.

**Checks 1 to 5 are not part of a dry run**: the proposal window (1), the firing (2), the AI's signature (3), the
request carrying the exact rulebook (4) and the decision line (5). The output says where checks 1 and 2 stood when the
views were read, for information only.

- **The verdict is `rules.ts`'s.** `src/explain.ts` calls `rankChecks` for it and never works it out again; it only
  lists checks 6 to 12 with their numbers, every limit taken from `ranks.ts` and `rules.ts` (none typed in it). If its
  own list ever disagreed with `rankChecks`, it would throw rather than give a wrong reason.
- **The state is the one `propose` uses** (`crates/coin/src/round.rs`): the rank and status now (`get_rank`: a
  demotion applies at once, while `get_round().rank` is the rank at round open), the pool at round open and now (the
  limit base is the smaller), the round's counters, `min_notional`, and the long-shot ticket the rulebook states
  (`rulebook.ts` `longShotOf`).
- **It refuses rather than guess** (exit 2): the contract's rank limits differ from `ranks.ts`, the rulebook is for
  another round, or the network is not testnet. A bet that cannot be written as a decision line (01 §6.2: an unknown
  market, leverage 0, more than 6 decimals) is refused with check 5's own reason, from `decision.ts`.
- **Browser-safe**, so the website can bundle it: `explain.ts` loads only `rules.ts` and `ranks.ts`; `quote.ts` (views
  to state, the bet, the text) adds `contract.ts`, `decision.ts`, `rulebook.ts`, `pricing.ts`, `markets.ts` and
  `json.ts`. No `node:` import and no package in either; the one Node global among them is `Buffer` inside
  `rulebook.ts`'s `buildRulebook`, which they never call. `test/explain.test.ts` walks their imports to keep it so.
- **Parity tests** (`test/explain.test.ts`): Engine 1's vectors in `interface/vectors/checks.json`. 22 of the 26 rule
  cases apply and give the expected verdict, code, asked and limit. Cases 21, 22, 23 and 26 do not apply: checks 1 and
  2 decide them (`FIRED`, `OUTSIDE_WINDOW`), and a dry run never runs those (for them the test still checks that the
  explainer equals `rankChecks`). The decision-line cases test check 5's reader and the rulebook cases pin the §6.1
  text, so neither applies; two decision-line notes name what the rank checks do next (D10, D13), and those are checked.
  Then 5,000 random states against `rankChecks` (long-shot tickets, counters above the rank's limits as after a
  demotion, pools that shrank, other `min_notional`s), covering every code of checks 6 to 12, YES and SKIP.
- `quote.test.ts` replays one real run (`test/data/quote-2026-11-13T151111Z.json`).

Real run, 2026-11-13 15:11 UTC (the live coin, round 54, in its proposal window, just after the runner's bet #35):

```
$ npm run quote -- --market PEPE --side long --margin 20 --leverage 1
quote: a free dry run of checks 6 to 12 (01 §7) for coin.desk-lab-2026.testnet. Read-only: views at block 277526635 (2026-11-13T15:11:10.223Z); nothing signed or sent.
the bet:    PEPE long, margin $20.00 × 1 = notional $20.00
the round:  54, phase PROPOSE, 17:10 in; rank INTERN (EMPLOYED); bets so far 1 of 1, $15.00 at risk
            #35 PEPE long $15.00 ×1 (OPEN_SIGNED)
the pool:   $1,572.985657 when the round opened, $1,572.985657 now

VERDICT of checks 6 to 12: NOPE TOO_MANY_TRADES (check 10)
  rule:     Each rank allows max_bets bets per round; once they are used, another bet is refused. (01 §7 check 10; §3)
  numbers:  asked 2 (bets_used + 1) against limit 1 (max_bets)
  limits:   INTERN's max_bets, 1 per round (01 §3).
  checks:
     6 NOT_ON_LIST        pass                             PEPE is on INTERN's list (DOGE, SHIB, PEPE, PENGU)
     ...
    10 TOO_MANY_TRADES    fail                             INTERN allows 1 bet per round and 1 is used: this would be bet 2
    11 OVER_TRADE_LIMIT   not reached (alone: pass)        margin $20.00 is within the per-bet limit $31.459713
    12 OVER_ROUND_LIMIT   not reached (alone: fail)        at risk this round $15.00 + this margin $20.00 = $35.00, above the per-round limit $31.459713

Checks 1 to 5 are not part of a dry run: the proposal window (1) and the firing (2) come before the rank checks, and the AI's signature (3), the request carrying the exact rulebook (4) and the decision line (5) need a real signed answer from the AI. This verdict is checks 6 to 12 only, on the state read now.
For information, when the views were read: check 1 would pass now (17:10 into the round, phase PROPOSE; proposals are taken from 15:00 to 20:00 into the round); check 2 would pass (the Intern is EMPLOYED).
```

Not done: checks 13 to 16 (the funding quote; nothing attaches one on testnet). The state can change between the
dry run and a real proposal (another bet, a cash-out, a vote, a new round); the output says so.

## mcp: a read-only MCP server for other AI agents

```
npm run --silent mcp -- [--coin <account>] [--rpc <url>]      # or: node src/cli/mcp.ts [--coin …] [--rpc …]
npm run mcp-check -- [--market PEPE --side long --margin 20 --leverage 1] [--coin <account>] [--rpc <url>]
```

An MCP server over stdio, built with the official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2), so that other
AI agents can look at the Intern. Six tools:

| Tool | What it answers |
|---|---|
| `intern_status` | Rank and status, the round (id, phase, times, counters), the pool (BRAVE: idle, lent, in play, pending; SAFE; coin price; bosses), the limits in force now from `get_constants`, this round's bets |
| `intern_rulebook` | The exact rulebook text `get_rulebook` serves now (the AI's system message), with round and nonce |
| `intern_quote` | `quote` above for a hypothetical bet: `market`, `side` (`long`/`short`), `margin_usd`, `leverage` (default 1) |
| `intern_feed` | Recent events from `get_feed`, oldest first: `after_seq` (optional), `limit` (1 to 100, default 20) |
| `intern_verify_round` | `verify-round` above for one propose transaction: `tx_hash`, `sender` (default: the contract's runner) |
| `intern_fills_check` | `fills-check` above for the last N rounds: `rounds` (1 to 200, default 10) |

**Every tool only reads. No tool signs, sends or spends anything, and none reads a key or `.env`.** Each tool's
description says so, and each is marked `readOnlyHint`. They read the coin's views (01 §8) at the latest final block
over NEAR RPC, public transactions (verify-round, with the archival fallback) and Hyperliquid testnet's public
`/info` (fills-check). The server reads no environment variable and no file but `interface/deployments.json` (the
default coin); `mcp-check` starts it with the SDK's default environment (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`,
`USER`). Its code loads no module that holds a key or can sign a NEAR transaction (no `near.ts`,
`chain.ts`, `secret.ts` or near-api-js; a test walks its imports). It loads `hl-exchange.ts` for the `/info` readers;
no tool calls that file's `/exchange` delivery, and the tests record every request the tools make: views only, NEAR
RPC `status`, `block`, `query` and `tx`, and `/info` `userFillsByTime` and `userFunding`.

Each answer is plain text first, then the same data as JSON (also as `structuredContent`). Amounts ending in `_e6`
are dollars times 1,000,000. A bet that cannot be quoted, or a quote the explainer cannot give, comes back as a tool
error with the reason.

**Add it to an MCP client.** It needs Node 24.11 or newer (it runs the `.ts` files directly) and absolute paths.
stdout carries only the protocol: plain `npm run mcp` prints npm's own banner on stdout first, so let the client
start `node` itself. Claude Desktop, in `claude_desktop_config.json` (the shape from MCP's own guide,
https://modelcontextprotocol.io/docs/develop/connect-local-servers, read 2026-11-13):

```json
{
  "mcpServers": {
    "intern": {
      "command": "node",
      "args": ["/absolute/path/to/intern/runner/src/cli/mcp.ts"]
    }
  }
}
```

Claude Code (the form `claude mcp add --help` gives: `claude mcp add [options] <name> <commandOrUrl> [args...]`):

```
claude mcp add intern -- node /absolute/path/to/intern/runner/src/cli/mcp.ts
```

Add `--coin coin-fast.desk-lab-2026.testnet` after the path for the test copy with 5-minute rounds. Run `npm ci`
in `runner/` first: the SDK and `zod` are dev dependencies (below).

**Dependencies.** `@modelcontextprotocol/sdk` 1.32.2 (published 2026-10-23) and its required peer `zod` 4.6.7
(2026-10-12), pinned exactly and installed with `npm install --before=2026-10-30`, so every package in their tree is
at least two weeks old. That adds 81 packages, among them the SDK's HTTP and auth parts (express, hono, ajv, jose),
which the stdio server does not load. They are **dev dependencies on purpose**: the runner's Docker image (`npm ci
--omit=dev`) holds the runner's keys, and it gets nothing new.

**Tests** (`test/mcp.test.ts`, offline): the SDK's own client over its in-memory transport, against a fake chain
(`test/support/fake-coin-views.ts`, the coin's views from memory; it throws on anything that is not a view) and
against recorded real replies (verify-round's and fills-check's). They list the tools, call every one (with errors
too), and check the requests above.

Real run, 2026-11-13 15:18 UTC (read-only, against `coin.desk-lab-2026.testnet`; round 54 in HOLD):

```
$ npm run --silent mcp-check -- --market PEPE --side long --margin 20 --leverage 1
mcp: the Intern's read-only MCP server is running on stdio (coin coin.desk-lab-2026.testnet, RPC https://test.rpc.fastnear.com)
server: intern-testnet 0.1.0, over stdio (…/node …/runner/src/cli/mcp.ts )
tools (6):
  intern_status: The Intern now [readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true]
  intern_rulebook: The rulebook now [readOnlyHint=true, …]
  intern_quote: Why NOPE? A free dry run of a bet [readOnlyHint=true, …]
  intern_feed: Recent events [readOnlyHint=true, …]
  intern_verify_round: Re-check a proposal from public data [readOnlyHint=true, …]
  intern_fills_check: Reported results against Hyperliquid's fills [readOnlyHint=true, …]

=== intern_status {}
$INTERN, coin.desk-lab-2026.testnet on testnet, block 277527377 (2026-11-13T15:18:22.706Z). Read-only: it signs nothing, sends no transaction and spends nothing, and it reads no key and no .env.
rank INTERN, EMPLOYED since round 1
round 54: phase HOLD, 24:22 in; proposals 15:00 to 20:00, closing from 25:00; ends 2026-11-13T15:24:00.000Z; skipped 2, refused 0
pool: BRAVE $1,572.985657 (at round open $1,572.985657; idle $15.845331, lent $1,542.140326, in play $15.00, pending $0.00); SAFE $221.106315; coin price $1.199702; 2 boss(es)
limits now (INTERN, from get_constants): per bet $31.459713, per round $31.459713 ($16.459713 left), bets 1 of 1, leverage up to 1x, DOGE, SHIB, PEPE, PENGU, long; min notional $11.00; limit base $1,572.985657
bets this round: #35 PEPE long $15.00 ×1 OPEN_SIGNED

=== intern_quote {"market":"PEPE","side":"long","margin_usd":"20","leverage":1}
quote: a free dry run of checks 6 to 12 (01 §7) for coin.desk-lab-2026.testnet. Read-only: views at block 277527380 (2026-11-13T15:18:24.630Z); nothing signed or sent.
…
VERDICT of checks 6 to 12: NOPE TOO_MANY_TRADES (check 10)
…
For information, when the views were read: check 1 would refuse a proposal now with OUTSIDE_WINDOW (24:24 into the round, phase HOLD; proposals are taken from 15:00 to 20:00 into the round); check 2 would pass (the Intern is EMPLOYED).
```

The other four tools were also called once, live and read-only, the same minute: `intern_feed` (events 315 to 318),
`intern_rulebook` (round 54), `intern_verify_round` on the round-51 proposal (verified, as above) and
`intern_fills_check` for rounds 52 to 54 (2 OK, 1 NOT REPORTED: bet #35 was still open).

Not done, and what to know:
- **SDK v1.** The SDK's README calls 1.x "the maintenance line" (bug and security fixes for at least six months after
  2026-07-27): it implements the MCP spec up to 2025-11-25. The current stable line is v2, in separate packages
  (`@modelcontextprotocol/server` and `/client`, 2.4.0), for the 2026-07-28 spec. This uses the package the brief
  names; a client and server agree on a protocol version when they connect, so a client that still speaks 2025-11-25
  or older works. Moving to v2 would be a separate change.
- **stdio only**: it runs next to the client, on the client's machine. No HTTP transport, so nothing to host and no
  auth; it holds nothing worth protecting.
- Each call reads a fresh final block (a second or two behind the chain), through public RPCs with their rate limits.
  `intern_fills_check` reads the whole feed and outbox each time, as the command does: a few seconds.

## contract-scan: who can change the contracts

```
npm run contract-scan -- [--accounts a,b,...] [--rpc <url>] [--json <file>] [--save <dir>]
```

Read-only; no key, no `.env`. Without `--accounts` it scans every account under `testnet` in
`interface/deployments.json` that holds a contract (an account with no code, such as the runner's, is listed as
skipped). For each account it reads, at the latest final block:

- `view_account`: the code hash, the balance and the storage used. With the storage price from
  `EXPERIMENTAL_protocol_config` (10^19 yocto per byte on testnet) it says how much NEAR the storage holds and how much
  room is left (NEAR requires balance + locked ≥ storage × price: nearcore `check_storage_stake`);
- `view_access_key_list`: every key, described as `key-scope` does;
- `view_code`: the deployed wasm. It checks that the bytes hash to the code hash, then lists the NEAR host functions the
  wasm imports, read with a small parser of the WebAssembly binary format (`src/wasm-imports.ts`: the header and the
  import section; no new dependency);
- the code hash against the one the repository records: the "expected hashes" table of `docs/REPRODUCIBLE-BUILD.md`.
  `verify.sh` records none of its own: it builds the wasm and compares its sha256 with the chain.

It flags the 11 host functions that can change who controls an account or its code (`src/host-functions.ts`, names
exactly as nearcore's `runtime/near-vm-runner/src/imports.rs` and near-sdk's `near-sys/src/lib.rs` give them, both in
the owner's `Cargo.lock`): `promise_batch_action_deploy_contract`, `promise_batch_action_add_key_with_full_access`,
`promise_batch_action_add_key_with_function_call`, `promise_batch_action_add_gas_key_with_full_access`,
`promise_batch_action_add_gas_key_with_function_call`, `promise_batch_action_delete_key`,
`promise_batch_action_delete_account`, `promise_batch_action_deploy_global_contract`,
`promise_batch_action_deploy_global_contract_by_account_id`, `promise_batch_action_use_global_contract` and
`promise_batch_action_use_global_contract_by_account_id`. Why those and nothing else: nearcore refuses deploying code,
adding or deleting keys, deleting an account and using a global contract unless the account itself acts
(`check_actor_permissions` in `runtime/runtime/src/actions.rs`), and a function-call key can only send one function
call with no deposit (`verify_function_call_permission` in `runtime/runtime/src/verifier.rs`). So an account changes only
through a full-access key or through its own code calling one of those 11; a code that follows another account's
global contract changes when that account republishes it. The verdict per account says which applies, for example
`1 full-access key: the holder can change it`, or `0 full-access keys and no code path that deploys code, changes
keys or deletes the account: nobody can change it`. Exit code: 0 nothing failed (a key that can still change a contract
is a caveat, not a failure); 1 a hash differs from the recorded one, the code read does not match its hash, or an
account could not be read; 2 a bad option or a network other than testnet.

**What the code part can and cannot show.** A wasm module can only call the host functions it imports, so "imports
none of the 11" proves there is no such path. Importing them proves nothing either way: near-sdk 5.30.1 handles every
kind of action in one function (`PromiseAction::add` in `src/promise.rs`), so any contract that uses its `Promise` type
(as cross-contract calls do) imports all 11, used or not. That is the case for all six contracts today; the scan reports "cannot rule out a
code path" for them, and it does not try to follow the code. (By hand, 2026-11-13: none of the contracts' sources under
`crates/` calls the SDK functions that build those actions; the sandbox tests aside.) While each account keeps its
full-access key, the key decides it anyway.

Real run, 2026-11-13 15:23 UTC (trimmed):

```
$ npm run contract-scan
coin.desk-lab-2026.testnet (coin)
  code       9oufg5viW3x5eQ49p8zBkZMNvdLzyQFT7Pd4GRjuBoZK, 632,157 bytes; the bytes read hash to it
  recorded   SAME: the same hash as docs/REPRODUCIBLE-BUILD.md records (The expected hashes (2026-11-13, interface 1.5)): the code on chain is that build
  storage    738,077 bytes (7.380 NEAR held for it); balance 7.972 NEAR: 0.591 NEAR free, room for about 59,158 more bytes
  keys       ed25519:86fbY6YwRaJMcYMCtw6YcRixD21QdqaSsnDWPXrTtNSY: a full-access key
  imports    43 NEAR host functions; 11 of the 11 that can change control: deploy_contract, add_key_with_full_access, …
             the others: read_register, sha256, keccak256, value_return, ed25519_verify, prepaid_gas, attached_deposit, …
  verdict    1 full-access key: the holder can change it (deploy new code, add or delete keys, delete the account); its code also imports all 11 host functions that can deploy code, change keys or delete the account, so this scan cannot rule out a code path that does
…
intern-runner-ed25519.testnet (runner): skipped, no contract code deployed

SUMMARY  6 account(s) scanned, 6 with a contract: 0 nobody can change, 6 changeable by a full-access key, 6 whose code imports control host functions; code hash 6 same as recorded, 0 different, 0 not recorded
```

The other five (`stub`, `usdc`, `stickers`, `launch`, `lender`) read the same: their recorded build, one full-access
key, all 11 imported.

**The live coin's storage room** (measured by hand on 2026-11-13 with `view_account` at older blocks on the archival
node, not by this tool): its storage grew from 712,087 bytes (block 277,497,910, 10:29 UTC) to 738,077 (block
277,527,910, 15:23 UTC), about 5.3 KB an hour, and its balance did not change. The 0.591 NEAR beyond its storage holds
about 59 KB more: at that rate it is used up around 02:30 UTC on 14 November. NEAR checks the balance against the
storage after every receipt and fails one that leaves too little (`LackBalanceForState`; nearcore
`runtime/runtime/src/lib.rs`), so from then on calls that grow the coin's storage would fail until someone sends it
NEAR; anyone can, with or without its keys. The owner's call (`docs/ACCESS-KEYS.md`, step 2).

## refusals: the refusal catalogue

```
npm run refusals -- [--coin <account>]... [--no-tx] [--rpc <url>] [--json <file>] [--save <dir>]
```

Read-only; no key, no `.env`. Default: the live coin (`testnet.coin` of `deployments.json`) and its test copy
`coin-fast.desk-lab-2026.testnet`. For each it reads every refusal with `get_refusals` (01 §8: newest first, `from` is
the highest id to return, 100 per page) and lists the sixteen codes of `interface/refusal-codes.json` in check order:
how many refusals each has, and the first one (round, time, the bet, `asked` and `limit` with their meaning; dollars for
`ZERO_MARGIN`, `OVER_TRADE_LIMIT` and `OVER_ROUND_LIMIT`, whose numbers are dollars), then the codes with no example yet.

For each first example it also finds the transaction, read-only. NEAR's RPC cannot list an account's transactions, so
it asks NearBlocks' public API (`GET https://api-testnet.nearblocks.io/v3/accounts/<coin>/receipts?method=propose&
before_ts=<ns>`, checked against its `openapi.json` and by running it, 2026-11-13) for the `propose` receipts at the
refusal's millisecond (`at` is the block time of the proposal), then reads each candidate with the RPC `tx` method (an
archival node when the regular one no longer has it) and keeps the one that returned this very refusal (`refusal_id`
and `code`), with its `refused` event. The explorer link is `https://testnet.nearblocks.io/txns/<hash>`: the form NEAR's
own explorer page links to (the NearBlocks page itself sits behind a browser check and was not fetched). `--no-tx`
skips NearBlocks. A transaction that cannot be found is a line, not a failure. NearBlocks asks for attribution
("Powered by Nearblocks.io APIs") when its data is shown; its free rate limit is not stated (UNVERIFIED): an HTTP 429
is reported, never retried in a loop. Exit code: 0 read; 2 a refusal list could not be read, a bad option, or a network
other than testnet.

Real run, 2026-11-13 15:23 UTC (trimmed):

```
$ npm run refusals
coin.desk-lab-2026.testnet: 1 refusal(s), ids 1 to 1
  11 OVER_TRADE_LIMIT       1  first: refusal 1, round 2, 2026-11-11T18:43:13.911Z: DOGE long $10.000000 at 1x; asked $10.000000 (margin); limit $1.000010 (per-bet limit in dollars)
                             tx https://testnet.nearblocks.io/txns/5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW: confirmed on https://archival-rpc.testnet.fastnear.com, it returned NOPE OVER_TRADE_LIMIT, refusal 1, and logged the refused event
  no example yet (15): OUTSIDE_WINDOW, FIRED, BAD_MODEL_SIGNATURE, …

coin-fast.desk-lab-2026.testnet: 3 refusal(s), ids 1 to 3
   2 FIRED                  1  first: refusal 1, round 7, 2026-11-12T06:40:28.244Z: no decision recorded
   6 NOT_ON_LIST            1  first: refusal 2, round 16, 2026-11-12T12:15:15.310Z: WIF long $11.000000 at 1x; credited to boss2.desk-lab-2026.testnet
   9 OVER_LEVERAGE          1  first: refusal 3, round 22, 2026-11-13T08:10:12.792Z: DOGE long $3.514000 at 10x; asked 10 (leverage); limit 1 (max_leverage)
  (each with its transaction, confirmed: DuTxFWRf…, 4VoxFZW9…, 2VzPaXTJ…)

SUMMARY  4 refusal(s) on 2 coin(s); 4 of 16 codes have an example (FIRED, NOT_ON_LIST, OVER_LEVERAGE, OVER_TRADE_LIMIT); no example anywhere yet: OUTSIDE_WINDOW, BAD_MODEL_SIGNATURE, WRONG_RULEBOOK, MALFORMED_DECISION, SHORT_NOT_UNLOCKED, ZERO_MARGIN, TOO_MANY_TRADES, OVER_ROUND_LIMIT, BAD_QUOTE_SIGNATURE, STALE_QUOTE, QUOTE_MISMATCH, TOO_EXPENSIVE. First examples' transactions: 4 confirmed, 0 found but not confirmed, 0 not found.
```

The live coin's only refusal is Engine 1's step-4 test with the stand-in signature (`fixtures/chain/testnet-accounts.md`);
no proposal on it has been refused since (`get_refusals` holds only that one).

## proof: one bundle for the proof page

```
npm run proof -- [--json <file>] [--coin <account>] [--relayer <account>] [--rounds N] [--proposals N] [--rpc <url>]
```

Read-only; no key, no `.env`. It calls the libraries of the read-only tools directly (no subprocess), one after another,
and writes one JSON file (`--json`) with a section per check; a section that fails is recorded with its error and the
others still run. About 35 seconds. Defaults: the live coin, the relayer `intern-relayer-ed25519.testnet`, the last 10
rounds, the last 3 proposals. Exit code: 0 no section failed; 1 a section failed; 2 a bad option or a network other
than testnet. A real bundle, with its own times, is `test/data/proof-bundle-2026-11-13T152437Z.json`.

| Section `id` | What it runs | `data` |
|---|---|---|
| `contract-scan` | The scan above, default list | `contract-scan`'s report (as `--json` writes it) |
| `key-scope` | `key-scope` on `get_constants().runner` (as runner) and the relayer, with no signing key named (no `.env` is read): the keys, and which would pass | A list of two key scopes (`src/key-scope.ts` `KeyScope`) |
| `fills-check` | `fills-check` over the last `--rounds` rounds | `fills-check`'s report (as its `--json` writes it) |
| `verify-round` | The coin's latest `--proposals` `propose` transactions, found with NearBlocks (as above), each through `verify-round` | A list of `{tx_hash, link, sender, block_height, at, failures, unverified, fatal, result, lines}` |
| `attestation` | `attestation-check` for 01's pinned model, with a fresh random nonce | `{model, signing_algo, lines, failures, callFailures, unverified_parts}` |
| `refusals` | The catalogue above, both coins, with transactions | `refusals`' report (as `--json` writes it) |

The shape, for the website (`bundleShapeProblems` in `src/proof.ts` checks it; the tests run it on the sample):

```ts
type Bundle = {
  kind: "intern-proof-bundle";
  version: 1;
  generated_at: string;              // ISO time the run started; finished_at when it ended
  finished_at: string;
  network: "testnet";
  coin: string;                      // the coin contract
  git: { commit: string; ref: string | null } | null;   // read from .git files; null where there is no .git
  endpoints: {                       // every service the bundle read
    near_rpc: string; near_archival_rpcs: string[]; hyperliquid_info: string; near_ai: string;
    nvidia_attestation: string[]; nearblocks_api: string; explorer: string;
  };
  summary: { ok: number; warn: number; fail: number; sentence: string };
  sections: Section[];               // in the order of the table above
};
type Section = {
  id: "contract-scan" | "key-scope" | "fills-check" | "verify-round" | "attestation" | "refusals";
  title: string;                     // a heading for the page
  status: "ok" | "warn" | "fail";    // warn: true, with a caveat to show (e.g. the contracts still have their keys)
  sentence: string;                  // one plain sentence for the page
  started_at: string;                // ISO time
  took_ms: number;
  data: unknown;                     // the tool's own output, unchanged (table above); null when the section failed
  error: string | null;              // why the section could not run
};
```

Real run, 2026-11-13 15:24 UTC (the sample):

```
$ npm run proof -- --json bundle.json
  WARN  contract-scan 6 contracts, each running exactly the build docs/REPRODUCIBLE-BUILD.md records; each still has a full-access key, so its holder can change it; all import the host functions that deploy code or change keys (near-sdk links them), so the code alone does not show it never will.
  OK    key-scope     The runner intern-runner-ed25519.testnet: a function-call key for coin.desk-lab-2026.testnet (propose, sign_next, report_result; allowance 0.862 NEAR) would pass as its signing key; it also holds a full-access key, normally the owner's. The relayer intern-relayer-ed25519.testnet: a full-access key would pass as its signing key. No private key was read, so which key actually signs is not shown.
  OK    fills-check   Rounds 46 to 55: 9 bets (9 OK); every fill on the contract's Hyperliquid address is tied to an order the contract signed.
  OK    verify-round  The last 3 proposals re-checked from public data: in each, NEAR AI's pinned key signed the exact request and answer, the request carried the rulebook of that moment, and the contract's verdict fits.
  OK    attestation   NEAR AI's z-ai/glm-5.3-flash ed25519 key is bound to a fresh Intel TDX quote carrying our nonce, and the GPU evidence with the same nonce passed NVIDIA's attestation; 6 parts stay UNVERIFIED (listed).
  OK    refusals      4 refusals on 2 coins: 4 of the 16 codes have an example (FIRED, NOT_ON_LIST, OVER_LEVERAGE, OVER_TRADE_LIMIT), 12 have none yet; each code's first example is tied to its transaction, confirmed on chain.
SUMMARY  6 checks: 5 ok, 1 with a caveat, 0 failed.
```

Not done: the bundle is a snapshot made where the repository is (it reads `interface/` and `docs/`, which the runner's
Docker image does not have); nothing publishes it or runs it on a schedule. `git` says which commit, not whether the
working tree had uncommitted changes.

## What is in `src/`

| File | What it is |
|---|---|
| `round.ts` | The round loop: the passes above, `dry` and `full`, the trick entry point, delivery |
| `chain.ts` | The program as the runner sees it (`Chain`), and `NearChain`, its NEAR implementation |
| `contract.ts` | Strict readers for the program's answers (01 §8.1): a missing field, a U128 sent as a JSON number, an unknown value all stop the runner with the field's name |
| `near.ts` | NEAR RPC: views, signed calls, signing accounts |
| `hl-exchange.ts` | Hyperliquid testnet for the runner: mid prices, `/exchange` delivery and replies, fills, funding. Only testnet addresses are in this file |
| `pricing.ts` | Exact decimals; Hyperliquid's price format; the limit price of an immediate order |
| `result.ts` | The dollars a bet returned, from fills and funding |
| `log.ts` | One JSON line per step |
| `preflight.ts` | The read-only checks of `preflight`, and the key check the other commands use at start |
| `fills-check.ts`, `fills-match.ts`, `fills-text.ts` | `fills-check`: reading the rounds and the fills, tying orders to fills, the verdict per bet, the text |
| `key-scope.ts` | `key-scope`: the signing key against what is declared, the account's other keys as notes; the start-up check behind `INTERN_KEY_SCOPE` |
| `status-checks.ts` | `status`'s lines on NEAR AI, Hyperliquid testnet and the relayer's NEAR |
| `deployments.ts` | The default coin for the read-only commands, from `intern/interface/deployments.json` |
| `cli/run.ts` | The command line, its start-up checks (testnet, 01 version, market table, the runner's key, one runner at a time) |
| `markets.ts`, `ranks.ts` | Copies of 01 §4 (markets) and §3 (ranks). The runner checks the contract's against them at start |
| `rulebook.ts` | The rulebook text of 01 §6.1: version 1.0's (kept for the step 1 recordings and the shadow runs started on 2026-11-11) and version 1.2's (for `preflight` and the tests). The runner always fetches the rulebook from the contract and sends it unchanged |
| `decision.ts` | The decision line of 01 §6.2: the canonical writer and a strict reader |
| `rules.ts`, `judge.ts` | The TypeScript copy of checks 1 to 12 (01 1.2 §7); its tests read the 26 rule cases of `intern/interface/vectors/checks.json`. The runner forecasts with it; the shadow report judges with it, with the $10 minimum its rulebooks stated |
| `signature.ts` | NEAR AI signatures over `model:sha256(request):sha256(response)`, ECDSA and ed25519 |
| `nearai.ts`, `hyperliquid.ts`, `prompt.ts` | NEAR AI calls; Hyperliquid's market list and prices (read-only); the market-data message |
| `exchange.ts` | One signed exchange saved as it happens |
| `recordings.ts`, `check.ts`, `check-run.ts` | Step 1 recordings; the step 0 access check |
| `secret.ts` | Keeps keys from ever being printed |
| `verify-round.ts`, `near-rpc.ts`, `pinned.ts` | `verify-round`: the re-check of one proposal; a small read-only NEAR JSON-RPC client with the archival fallback; 01's pin, and the four models' recorded ed25519 keys (to name a signer that is not the pin) |
| `attestation-check.ts`, `tdx-quote.ts`, `nvidia-gpu.ts` | `attestation-check`: the report's checks; the TDX quote and its signature chain; NVIDIA's GPU verdict and tokens |
| `seed-temperature.ts`, `cli/seed-temperature.ts` | The fixed question of the seed and temperature research (`docs/seed-and-temperature.md`) |
| `books-check.ts`, `books-text.ts` | `books`: the coin's buckets and what holds them, at one block; 01 §9.7's rule, the verdict, the text |
| `supply-log.ts`, `supply-text.ts` | `supply-log`: the feed at one block, the supply rebuilt with the contract's share rule, the text and CSV |
| `at-block.ts`, `view-fields.ts`, `deployed.ts` | Views read at one final block (testnet only); strict readers for view answers; any name from `deployments.json` |
| `explain.ts`, `quote.ts`, `chain-snapshot.ts`, `cli/quote.ts` | `quote`: the explanation of checks 6 to 12 (browser-safe; the verdict is `rules.ts`'s), the views turned into the round's state and the bet (browser-safe), the views at one final block, the command |
| `mcp.ts`, `cli/mcp.ts`, `cli/mcp-check.ts` | The read-only MCP server's six tools, its stdio entry point, and a client that starts it and calls two tools |
| `contract-scan.ts`, `wasm-imports.ts`, `host-functions.ts` | `contract-scan`: the scan and its verdicts; the WebAssembly import-section reader; the NEAR host functions that can change control, with their sources |
| `refusals.ts`, `nearblocks.ts` | `refusals`: the catalogue and the transaction lookup; NearBlocks' receipts endpoint and the explorer link |
| `proof.ts`, `git-head.ts` | `proof`: the sections, their sentences and the bundle's shape check; the commit read from the `.git` files |
| `rpc-read.ts` | Read-only RPC queries at the latest final block over `near-rpc.ts` (so every reply can be recorded and replayed) |

Tests drive the round loop against test doubles in `test/support/`: an in-memory stand-in for the contract and a
`fetch` answering like NEAR AI and Hyperliquid testnet. They are labelled as test doubles, live only under `test/`,
and no command can select them. Hyperliquid's market data in them is a real testnet reply.

## What is not done, and what is a stand-in

- **Stand-ins exist only in the tests** (`test/support/`: an in-memory program, NEAR AI and Hyperliquid answering in
  their documented shapes). Every command talks to the real services.
- **Real fills.** The first was round 7, where the result matched Hyperliquid's account value to the micro-dollar. By
  2026-11-13 13:56 UTC, 30 bets on the live coin had filled and been reported, and `fills-check` finds every one of
  those results equal to what the fills give. No order has filled only in part, no bet has paid funding (none was
  held across the hour) and no close has been signed twice: those have run only in the tests.
- **`fills-check` ties fills to orders approximately** (coin, side, size, time) until orders carry a client order
  id. **`key-scope` sees keys, not who holds them**: the signing key is the one named (`--key`, or the public key of
  the private key in the environment); the account's other keys are listed with a note.
- **Closing again stops after 6 orders.** 01 sets no limit; the runner's is `MAX_CLOSE_SIGNS` in `src/round.ts`.
  After that it logs `STUCK` and a person has to look.
- **Gas** attached to each call is a guess (`TERA_GAS` in `src/chain.ts`, UNVERIFIED). Every call logs the gas it
  really burnt (`tgas`); the first real round's numbers are under "What is checked live".
- **`contract-scan` reads imports, not code paths.** All six contracts import the 11 host functions that can change
  control (near-sdk links them), so for each it can only say a path is not ruled out; it does not follow the code.
  **`refusals` and `proof` find transactions through NearBlocks**, a third-party index (each find is then confirmed
  on NEAR RPC); its free rate limit is UNVERIFIED.
- `check` reads each model's signer from NEAR AI's attestation report without verifying the hardware evidence.
  `attestation-check` verifies part of that evidence for the pinned model; what it leaves UNVERIFIED is listed
  above. The runner itself does not run it before proposing.
- **`books` checks the contract's books, not Hyperliquid's**: the bets' margin there is a hand-funded stand-in and is
  outside them. The lender is the one `deployments.json` names, because `get_constants` names none (if it were the
  wrong one, its principal for the coin would not match `brave.lent`). It cannot see a payment in flight; one shows
  as a difference for a block or two.
- **`supply-log` needs the whole feed**: once the feed drops seq 1 (it keeps 1,000 events) it says so and stops
  short of a total. It works each opening's coins out with the contract's share rule, because `round_opened` does not
  state them; if a round opened while a cash-out's payment was still in flight, that opening's count could be off
  and the comparison with `ft_total_supply` would show it. The coin contract's NEP-141 logs (`ft_mint`, `ft_burn`)
  are not read: RPC gives a transaction's logs only by its hash, so reading them all needs an indexer.
