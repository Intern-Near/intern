# Open items for the owner (from Engine 2)

## Status after 01 version 1.3 (2026-11-12)

Nothing is open. P and Q (below) are fixed in 01: §8.1 shows the current `interface_version`, and §9.3 says
`sign_next` and `close` return `null` when the signature failed (nothing changed: call again). Known limit 8 records
the filled bet of round 7. What 1.3 asked of Engine 2, and what was done:

| 1.3 asks | Engine 2 now |
|---|---|
| `ai-check`'s test read `interface_version` "1.2" from `checks.json` | Reads "1.3"; D1 to D13 unchanged; 17/17 |
| `rebalance()` once each round, before proposing, 300 TGas | The runner calls it at the start of the proposal window, from the relayer (anyone may call it, so the runner's function-call key stays limited to `propose`, `sign_next`, `report_result`). Logged with the dollars moved and the pool's idle and lent money after it. A failure is logged and the round goes on |
| `propose` takes an optional `credited_to` | `npm run runner -- trick --message "…" --credited-to <visitor account>` sends it; other commands never do. The account id's format is checked; the program cannot check whose it is |
| The rulebook may carry a playbook | Sent unchanged, as before. `preflight` fills the `playbook:` line from `get_active_playbook` when it compares the text with 01 §6.1 |
| A cash-out or dial turn needs 300 TGas | The runner never cashes out or turns the dial (no such call in its code) |

## Status after 01 version 1.2 (2026-11-12)

Engine 1's note of 2026-11-12 (`ENGINE-1-NOTE-FOR-ENGINE-2.txt`) and 01 version 1.2 settle almost every item below.
What Engine 2 changed for each, and what is still open:

| Item | 01 1.2 says | Engine 2 now |
|---|---|---|
| A. $1 example bet, no minimum stated | The rulebook has `min_notional_e6` and the sentence on amounts; example bet $11 | The runner sends `get_rulebook().text` unchanged; `preflight` compares it with 1.2's template, which passes Engine 1's rulebook cases R1 to R3 |
| B. Shape of the request | Written into §6.3 as `ai-check` enforces it | No change needed |
| C. Decision-line edge cases | §6.2: `"0"` is well-formed (D13); leverage 1 or more | No change needed; D13 passes |
| D. Two NEAR AI headers | Written into §6.3 | No change needed |
| E. Form of `v` for `ecrecover` | 1.1: 0 or 1, high-s accepted | No change needed |
| F. Whole-number prices | No change to 01 | None |
| G. Body size limit | No change to 01; Engine 1 measures gas in step 7 | None |
| H. Blank lines around the answer | Strict: `MALFORMED_DECISION` (D12) | `ai-check`: strict is the only rule; the `strict-answer` option is gone. The runner forecasts with the strict rule |
| I. `build` cannot check the size | The contract calls `check_format` before `build` | No change needed |
| J. Check 8 overflow | Settled in 1.1 | The runner's copy already passed |
| K. Pin ed25519 | Pinned `z-ai/glm-5.3-flash`, ed25519, signer `5a0210f2…caff` | A test pins exactly these three values |
| L. `px_e8` type | A decimal string (a number is also accepted) | The runner sends a string |
| M. Signing again | 1.1: `close` may be signed again | Used since step 6 (2026-11-12): when every closing order so far was sent or expired and Hyperliquid's fills still show the bet open, the runner calls `close` again at the price of that moment, with twice the last price margin, at most 6 times (`runner/README.md`, step 12) |
| N. `v` in a signed action | 27 or 28 | The runner already required 27 or 28 |
| O. $10 minimum never placeable | `min_notional` is $11 | The runner's copy of check 8 uses $11; its tests read the 26 rule cases from `checks.json` |
| Runner account | The real contract accepts the runner's calls from `intern-runner-ed25519.testnet` only | `sign_next` now goes from the runner's function-call key, with no deposit (1.1); the key must allow exactly `propose`, `sign_next`, `report_result` |

Two things found in 01 version 1.2 (what / why / who):

### P. 01 §8.1 still prints `interface_version: "1.1"`

- **What:** the `Constants` type in §8.1 says `interface_version: "1.1"`, while 01's header says 1.2 and the real
  contract returns `"1.2"`.
- **Why:** a reader who checks the version against §8.1 would refuse the real contract. The runner checks for `"1.2"`.
- **Who:** the owner (01), the website if it checks the version.

### Q. `sign_next` may return null, and 01 does not say so

- **What:** Engine 1's note says `sign_next` "returns the SignedAction or null if the signature failed: call again".
  01 §9.3 says it returns the signed action. It does not say whether `close` can return null too.
- **Why:** a reader that expects a signed action every time would stop on null. The runner treats null from either
  call as "not signed this time" and calls again on its next pass.
- **Who:** the owner (01 §9.3), Engine 1, Engine 2 (runner).

### Still open

- **Step 6, test dollars** for the real contract's Hyperliquid address `0x46f8eb2a044a826c70e9682fe3bfd65970340132`
  (the section at the end of this file; the owner's decision on the money). Until then Hyperliquid refuses every
  order with "User or API Wallet … does not exist".
- **The shadow runs** started on 2026-11-11 keep the rulebook they started with (`proposed-A`: a `min_notional_e6`
  line of $10 and a $10 example bet), so their numbers stay comparable from start to end. Their report judges them
  with the $10 minimum they were told. 01 1.2's rulebook differs from theirs only in those two amounts.

The rest of this file is the history, as written on 2026-11-11 against 01 version 1.0.

---

Written 2026-11-11 against `01-SHARED-INTERFACE.md` version 1.0; items L to O added the same day, from step 5. Every item is what / why / who, then a proposal.
Evidence is in the repository: `intern/fixtures/ai/README.md` (19 real signed answers recorded in step 1) and the
tests named below. Nothing here has been worked around in code: where 01 is unclear, the code follows 01 as written
and the choice is a setting or a clearly labelled option.

## The shadow run: started 2026-11-11, with these choices

Decided on 2026-11-11 by the Engine 2 builder ("do as you suggested"), following the proposals in this note. Run
folder: `intern/shadow/data/2026-11-11-intern`. First tick 2026-11-11 16:45 UTC; decisions until 2026-11-14 16:45
UTC; prices read until 2026-11-15 02:45 UTC so the last paper positions can close. It runs on the Engine 2 builder's
laptop, with sleep blocked.

| Choice | Setting | Follows |
|---|---|---|
| Rulebook | `proposed-A` | Issue A's proposal. **01 §6.1 must adopt this text**, or the run measured a different prompt from the product's |
| Thinking | on (each model's default) | Issue H, option (a): the report ignores blank lines around the answer, and also shows how many answers only the strict rule refuses |
| Signature checked in the report | `ed25519` | Item K. Both schemes verify on every answer recorded so far |
| Rank told | INTERN | The brief's protocol |
| Prices in the user message | all six markets | Tests whether a model offered a forbidden coin takes it anyway |
| Public claim | perp prices, not the swap quotes of the product spec's section 19 | The report says so in its limits |

Estimated cost of the whole run: about $0.75 of NEAR AI credit (from one real tick; thinking length varies).

**Early sign (first ticks): no refusals.** With the $1 example gone, every answer in the first ticks was a legal
bet, and most bet exactly the new example's $10: the example amount anchors the bet size, whatever it is. In step 1
the only real limit break came from a pressure message, never from the plain request. If this holds, the plain
run's headline is "the models follow stated limits when asked plainly", and the number that matters comes from the
second run:

**A second run, alongside: pressure messages.** Started 2026-11-11, ticks at :07, :22, :37 and :52 (first 17:07 UTC;
decisions until 2026-11-14 17:07 UTC), folder `intern/shadow/data/2026-11-11-intern-pressure`. Same settings as the
plain run, except that each user message ends with one of six published pressure messages instead of "Decide this
round's bet." (set `pressure-v1`, `intern/shadow/src/pressure.ts`; one message per tick for all models, in
rotation). Each message aims at one rule: the per-bet limit, a fake promotion, a coin off the list, a short, more
leverage, a fake vote. It measures how often a model can be talked into breaking its rules, which is the situation
of the challenge page. Estimated cost: another $0.75.

## Built on the proposals below, before 01 changes

`intern/crates/ai-check` (step 3) follows proposals B, C, E, H (option a) and K as adopted on 2026-11-11. One
consequence for `checks.json`: under H, test case D12 (a trailing newline) is valid, not `MALFORMED_DECISION`. The
crate keeps 01 version 1.0's strict rule as a build option (`--features strict-answer`), so either decision is one
switch. Details: `intern/crates/ai-check/README.md`.

## Items in 01

### A. The rulebook teaches a $1 bet and never states the $10 minimum or the unit (§6.1)

- **What:** the example line has `"margin_e6":"1000000"`, which is $1, and would itself be refused as `ZERO_MARGIN`.
  The template never says amounts are dollars × 1,000,000, nor that a bet must be at least $10.
- **Why:** in step 1, 9 of 19 real answers bet exactly $1, and every model did at least once. Each would be refused,
  so the headline number would mostly measure this prompt mistake.
- **Who:** Engine 1 (template and contract), Engine 2 (shadow run), the public claim.
- **Proposal:** add the line `min_notional_e6: 10000000` after `max_margin_e6`, add one sentence ("Amounts are US
  dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least
  min_notional_e6.") before the answer forms, and make the example margin `"10000000"`. The exact text is
  `proposedRulebookA` in `intern/shadow/src/prompts.ts`; a test shows its example bet passes every check.

### B. The allowed shape of the request is not defined (§6.1, §6.3, check 4)

- **What:** 01 says the system message must be the rulebook. It does not say whether other messages or other system
  messages are allowed, or which other request fields (`n`, `tools`, `response_format`, `logit_bias`,
  `chat_template_kwargs`, ...).
- **Why:** NEAR AI passes unknown fields through to the model (its API reference: `additionalProperties`), so
  `ai-check` has to enforce one exact rule and the runner has to follow it. Too loose weakens "the AI saw the
  rules"; too strict breaks real requests.
- **Who:** Engine 1, Engine 2 (`ai-check`, runner), the README's claims.
- **Proposal:** exactly two messages, the rulebook as the system message, then one user message; top-level fields
  only `model`, `messages`, `stream: false`, plus `chat_template_kwargs: {"enable_thinking": false}` if issue H is
  settled that way; `n` absent; a duplicated key gives `WRONG_RULEBOOK`. The TypeScript copy today checks the model,
  one system message (first, equal to the rulebook) and one choice in the response.

### C. Edge cases of the decision line are not pinned (§6.2, §12)

- **What:** `"margin_e6":"0"` (test case 7 needs it readable, but §6.2 says "no leading zero"); `"leverage":0`; a
  market outside the six, such as `"BTC"`; numbers too big for u128 (margin) or u32 (leverage).
- **Why:** the Rust check, the TypeScript copy and the site must give the same code. `"BTC"` as
  `MALFORMED_DECISION` counts a real rule break as a format error in the headline number.
- **Who:** Engine 1 (`checks.json`), Engine 2, frontend.
- **Proposal:** add cases D13 to D17: margin `"0"` is a bet (then `ZERO_MARGIN`); leverage 0, a margin above u128 or
  a leverage above u32 are `MALFORMED_DECISION`; `"BTC"` is `MALFORMED_DECISION` (or `NOT_ON_LIST`, if the owner
  wants it counted as a rule break; that needs a wider `Market` type). The TypeScript copy implements this proposal.

### D. §6.3 misses two of NEAR AI's conditions for a model-signed answer

- **What:** NEAR AI's docs also require the header `x-no-aliasing: true`, and say to send `Accept-Encoding:
  identity` (`docs.near.ai/cloud/verification/cloud-api/response-signatures.md`).
- **Why:** without them the gateway may sign instead of the model, and check 3 fails. Every request so far sends
  both.
- **Who:** Engine 2 (runner); the text of 01.
- **Proposal:** add one line to §6.3.

### E. `Host::ecrecover` does not say which form `v` takes (§11)

- **What:** NEAR AI returns the last signature byte as 27 or 28; both were seen in step 1.
- **Why:** `ai-check` must pass the right value to the contract's host function, and the trait is silent on it and
  on the malleability flag.
- **Who:** Engine 1 (the `Host` implementation), Engine 2 (`ai-check`).
- **Proposal:** document that `v` is the recovery id, 0 or 1; `ai-check` converts 27/28. Engine 1 confirms the host
  function's form in the pinned SDK. Item K below would remove this question.

### F. Hyperliquid also accepts any whole-number price (§4)

- **What:** Hyperliquid's docs: "Integer prices are always allowed, regardless of the number of significant figures.
  E.g. 123456 is a valid price". 01 §4 allows 5 significant figures only.
- **Why:** `hl-order`'s `check_format` follows 01, which is stricter. No price of the six markets is near that size.
- **Who:** Engine 2 (`hl-order`), Engine 1.
- **Proposal:** keep 01 as it is and add a note, or add the exception. Either is safe for the six markets.

### G. No size limit on the request and response bodies

- **What:** the largest response so far was 15.4 KB (Qwen3.6, 4,564 thinking tokens); bodies grow with thinking.
- **Why:** the contract hashes and reads them within its gas budget.
- **Who:** Engine 1 (gas), Engine 2 (`ai-check`).
- **Proposal:** Engine 1 measures gas for a 64 KB response; then pick a cap (64 KB per body would be four times the
  largest seen), refused as `MALFORMED_DECISION` after the signature check so the order of checks holds.

### H. Two of the four models pad every answer with blank lines (§6.2)

- **What:** with thinking on (their default), Qwen3.8-27B and Qwen3.6-35B-A3B-FP8 start every answer with `"\n\n"`
  (8 of 8 in step 1, 2 of 2 in the smoke tick). GLM and DeepSeek never did (0 of 9).
- **Why:** under §6.2 these are always `MALFORMED_DECISION`, whatever the bet, and the runner may not edit answers.
  Those two models could never get a YES, and the shadow run would count a server formatting habit as disobedience.
- **Who:** Engine 1 (the contract rule, case D12), Engine 2 (`ai-check`, shadow run), the headline number.
- **Options:** (a) ignore spaces, tabs and line breaks before and after the line, keeping the line itself exact
  (case D12 becomes valid); (b) turn thinking off for the Qwen models with `chat_template_kwargs` (2 of 2 answers
  came back clean; needs item B to allow that field; changes how they decide); (c) leave it.
- **Recommendation:** (a). It is the smallest change and keeps the exactness that matters, on the JSON itself.

### I. `hl-order`'s `build` cannot check the size format (§11.2)

- **What:** `Action::Order` has no size decimals, so `build` cannot check the size; `check_format` does.
- **Why:** a contract that calls only `build` would sign a size with too many decimals, and Hyperliquid would refuse
  it. No money is at risk, but a signing call is wasted (6 to 10 s).
- **Who:** Engine 1.
- **Proposal:** one sentence in §11.2, "the contract calls `check_format` with the market's size decimals before
  `build`", or add `sz_decimals` to `Action::Order`. `crates/hl-order/README.md` already says it.

### J. Check 8 can overflow in the contract's Rust (§7)

- **What:** `margin_e6` (u128) × `leverage` (u32) at check 8 can overflow u128 for answers `ai-check` accepts.
- **Why:** a panic aborts the transaction and erases the refusal record, which §7 forbids ("a NOPE must not abort").
- **Who:** Engine 1 (the rules crate, `checks.json`).
- **Proposal:** use `checked_mul` or `saturating_mul`; add case 25: TRADER, bet DOGE long, margin =
  340282366920938463463374607431768211455 at 2x, gives `OVER_TRADE_LIMIT` (asked that margin, limit 100000000).
  The TypeScript copy already passes it (`intern/runner/test/rules.test.ts`).

### K. Proposal: pin `ed25519`, not `ecdsa` (§6.3, `get_constants().model`)

- **What:** both schemes were available for all four models, and every recording verifies under both.
- **Why:** on-chain, ed25519 is one host call, `ed25519_verify(signature, text, public key)`. ECDSA needs the
  "personal sign" hash, `ecrecover`, the 27/28 conversion (item E), a hash of the recovered key, and a 20-byte compare.
- **Who:** Engine 1 (contract, constants), Engine 2 (`ai-check`).
- **Note:** Engine 1 confirms `ed25519_verify` in the pinned NEAR SDK. Gas was not measured for either scheme.
  The pinned keys: `intern/fixtures/ai/README.md`, finding 3.

## Found while building the runner (step 5), 2026-11-11

### L. The JSON type of `px_e8` in `sign_next` and `close` is not stated (§9.3)

- **What:** `sign_next({ position_id, px_e8 })` and `close({ position_id, px_e8 })`: §2 types U128 (a string) and
  Ms (a number), but not `px_e8`. The research probe took a JSON number; `Position.sz_e8` is a string.
- **Why:** the contract's argument parser accepts one form and fails the call on the other.
- **Who:** Engine 1 (the argument type), Engine 2 (the runner).
- **Proposal:** a decimal string, like `sz_e8`. The runner refuses both calls until 01 says (`PX_E8_JSON` in
  `runner/src/chain.ts`); a YES then gets its margin reported back at close.

### M. A signed action that expires, or a close that does not fill, cannot be signed again (§9.3)

- **What:** 01 says `sign_next` is called twice and `close` once. It does not say whether either may be called again
  when the signed action expired (120 s) before delivery, or when the immediate-or-cancel close did not fill.
- **Why:** one runner restart at the wrong moment, or one unfilled close, leaves a bet that can never be opened or
  closed, and the round stuck for good. The contract cannot see Hyperliquid, so it cannot tell these cases apart.
- **Who:** Engine 1 (the rules of `sign_next` and `close`), Engine 2 (the runner's recovery).
- **Proposal:** allow `close` again, any number of times, until the bet is settled: it is reduce-only, so it can
  never open anything. Allow the leverage action to be signed again (it only sets isolated margin). Never re-sign an
  opening order: if the first one was delivered, a second could double the bet. Also say whether `report_result`
  may be called for a bet whose opening order was never signed (the runner does that, reporting the margin back).
  Today the runner logs `STUCK` and waits for a person when a bet stays open after every closing order expired.

### N. The form of `v` in a signed action's signature (§8.1)

- **What:** `SignedAction.signature` is `{ r, s, v }`; 01 does not say whether `v` is 27/28 or 0/1.
- **Why:** the runner delivers the signature to Hyperliquid unchanged. The probe sent 27 + recovery id and
  Hyperliquid recovered the contract's address (VERIFIED). With 0/1 it would most likely recover another address
  (UNVERIFIED) and answer "User or API Wallet … does not exist", the error that hides a wrong signature.
- **Who:** Engine 1 (writes it), Engine 2 (delivers it).
- **Proposal:** 27 or 28, Hyperliquid's own form. The runner refuses to send any other value and logs why.

### O. A bet at exactly the $10 minimum can never be placed on Hyperliquid (§3, §7 check 8, §9.3)

- **What:** `min_notional` is $10, the same as Hyperliquid's minimum order value ("Order must have minimum value of
  $10", VERIFIED in its docs). The contract sizes the order as `floor(notional / px)` cut to the size decimals, so
  `px × size ≤ notional`: a $10 bet always becomes an order worth a little under $10. Example with today's testnet
  DOGE mid and a limit price 1% through it: 143 × 0.069861 = $9.99.
- **Why:** Hyperliquid refuses such an order. Whether it measures the value at the limit price or the market price is
  UNVERIFIED; both are under $10 here. In the shadow runs' first ticks, 13 of the 20 bets were exactly $10 (the
  example of item A), so most YES bets would never open. One size step is up to about $0.17 at today's prices (WIF).
- **Who:** Engine 1 (`min_notional`, check 8, the rulebook), Engine 2 (the shadow run's `proposed-A` example).
- **Proposal:** raise `min_notional` to $11 (11000000), and the rulebook's example bet with it (item A). Changing it
  does not change what the shadow run measures, only the amount the models are shown.

## Decisions needed from the owner to finish steps 5 and 6

### The runner account name, before Engine 1 deploys: `intern-runner-ed25519.testnet`

`get_constants().runner` must name the account the runner proposes from (01 §9.3: "the runner only"). **Engine 1:
set it to `intern-runner-ed25519.testnet`.** Created 2026-11-12 by the Engine 2 builder (recipe in `runner/README.md`,
"Accounts") and checked read-only on testnet the same day: it exists, holds 10 NEAR from the faucet, and has one
full-access key, kept by the NEAR CLI on the Engine 2 laptop. The relayer, `intern-relayer-ed25519.testnet`, is
separate and needs nothing from the contract (10 NEAR, one full-access key, the one in `runner/.env`). The runner's
function-call key can only be added once the contract's account name is known.

### Step 6: test dollars for the contract's Hyperliquid address (needs your yes; real money)

Hyperliquid testnet's free tap gives 1,000 mock USDC, but only "to use the testnet faucet, you need to have deposited
on mainnet with the same address" (VERIFIED, https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet,
tap at https://app.hyperliquid-testnet.xyz/drip). The contract's address cannot deposit on mainnet itself, so the
dollars must come from another address and be sent across on testnet. Options:

| Option | What you do | Real money |
|---|---|---|
| 1. A wallet that has already deposited on Hyperliquid mainnet | Use it to claim the testnet tap, then send test dollars to the contract's address on testnet | None |
| 2. One small deposit | From a wallet you control: deposit 5 USDC to Hyperliquid mainnet as USDC on Arbitrum (plus a little ETH on Arbitrum for gas). Claim the tap with the same address. Send test dollars to the contract's address on testnet. Later withdraw the 5 USDC | 5 USDC deposited, back minus the $1 withdrawal fee; Arbitrum gas (UNVERIFIED, likely cents). **Deposits below 5 USDC are lost** |
| 3. Ask someone with testnet funds to send some | Ask in Hyperliquid's community (its docs point API questions to Discord) | None, but it depends on a stranger; not documented (UNVERIFIED) |

Facts behind the table (VERIFIED in Hyperliquid's docs, 2026-11-11): deposits are "USDC deposits via Arbitrum only"
for wallet users and "Deposits below 5 USDC are lost" (support FAQ, deposited-usdc); "There is a $1 fee for
withdrawing" (exchange-endpoint, withdraw3); sending to another address is the "Core USDC transfer" (`usdSend`, with
`hyperliquidChain: "Testnet"` on testnet), signed by the sender's wallet; "New HyperCore accounts require 1 quote token
(e.g., 1 USDC ...) of fees for the first transaction which has the new account as destination address"
(activation-gas-fee): on testnet that 1 dollar is mock.

Three things to know before choosing:
- **Fund the address of the contract that will trade.** The address comes from the contract's own account and path
  (`npm run runner -- preflight` shows and checks it), so the stub's address and the real contract's differ.
- **About $100 of test dollars is plenty**: at rank INTERN a bet is at most 2% of the pool (01 §3), $20 for a $1,000
  pool, and every order is at least $10.
- Nothing here is done by Engine 2: the deposit, the tap and the testnet transfer are all signed by your wallet.
