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
npm run runner -- status --contract <account>          # read-only: constants, rank, round, this round's bets
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

Tests drive the round loop against test doubles in `test/support/`: an in-memory stand-in for the contract and a
`fetch` answering like NEAR AI and Hyperliquid testnet. They are labelled as test doubles, live only under `test/`,
and no command can select them. Hyperliquid's market data in them is a real testnet reply.

## What is not done, and what is a stand-in

- **Stand-ins exist only in the tests** (`test/support/`: an in-memory program, NEAR AI and Hyperliquid answering in
  their documented shapes). Every command talks to the real services.
- **One real fill so far** (round 7). On that bet the result matched Hyperliquid's account value to the
  micro-dollar. A partial fill, funding paid across the hour, and a close signed again have run only in the tests.
- **Closing again stops after 6 orders.** 01 sets no limit; the runner's is `MAX_CLOSE_SIGNS` in `src/round.ts`.
  After that it logs `STUCK` and a person has to look.
- **Gas** attached to each call is a guess (`TERA_GAS` in `src/chain.ts`, UNVERIFIED). Every call logs the gas it
  really burnt (`tgas`); the first real round's numbers are under "What is checked live".
- `check` reads each model's signer from NEAR AI's attestation report without verifying the hardware evidence.
  `attestation-check` verifies part of that evidence for the pinned model; what it leaves UNVERIFIED is listed
  above. The runner itself does not run it before proposing.
