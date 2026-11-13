# $INTERN — the shared interface

**Version 1.7, 2026-11-13.** Read `00-HOW-WE-WORK.md` first. *(In the public repository: `00-HOW-WE-WORK.md` and the
other planning files, `02` to `05`, are not included. This file is complete without them.)*

This is the one rulebook that the program (Engine 1), the off-chain Intern (Engine 2) and the website all follow. If any other file disagrees with this one, this one wins. To change it, see `00-HOW-WE-WORK.md` section 7.

Everything here is our own design unless a line says it is an outside fact. Outside facts carry a tag: `VERIFIED` (ran it, or read the official page), `TO VERIFY` (must be checked before it is relied on). Numbers marked `PROPOSED` are starting values the owner may change before deploy; the names and shapes around them are fixed.

This file replaces section 15 of `INTERN-PRODUCT-SPEC.md`, which was written before the move to dollars, lending and perps.

**Contents:** 1 words · 2 units and types · 3 ranks · 4 markets · 5 the round · 6 the decision format · 7 the sixteen NOPE reasons · 8 questions the program answers (views) · 9 actions · 10 events and the feed · 11 the two shared libraries · 12 test cases · 13 deployments · 14 known limits · 15 change log

---

## 1. Words

| Word | Meaning |
|---|---|
| Boss | Anyone holding the coin |
| Coin | `$INTERN`, a NEP-141 token. One coin is one share of the BRAVE pool |
| BRAVE | Money whose owner lets the Intern use a small slice |
| SAFE | Money the Intern can never touch. A plain ledger entry, no coin |
| Dial | A person's own split between SAFE and BRAVE |
| Pocket money | The slice of the BRAVE pool the Intern may put at risk |
| Rank | `INTERN`, `ANALYST` or `TRADER`: a fixed set of limits |
| Round | One cycle: open, propose, hold, close, settle. One per day in the real product |
| Decision | The one line the AI answers with: a bet, or "skip" |
| Proposal | A decision plus the proof it came from the AI, sent to the program |
| YES / NOPE | The program's verdict on a proposal. A NOPE is also called a refusal |
| Rulebook | The exact text the program writes for the AI each time: the rank, the limits, the round |
| Runner | The off-chain process that calls the AI and submits proposals |
| Outbox | Orders the program has signed and that anyone may deliver to Hyperliquid |

## 2. Units and types

Types are written in TypeScript notation because all three builds can read it. JSON on the wire.

```ts
type U128   = string;  // whole number as a decimal string, e.g. "20000000". Never a JSON number
type Usdc   = U128;    // dollars with 6 decimals. "20000000" is $20.00
type Coin   = U128;    // $INTERN with 6 decimals
type Signed = string;  // like U128 but may start with "-". Used for results
type Ms     = number;  // Unix time in milliseconds (safe as a JSON number)
type Bps    = number;  // hundredths of a percent. 200 = 2%
type AccountId = string;

type RankName = "INTERN" | "ANALYST" | "TRADER";
type Status   = "EMPLOYED" | "FIRED";
type Market   = "DOGE" | "SHIB" | "PEPE" | "PENGU" | "WIF" | "TRUMP";
type Side     = "LONG" | "SHORT";
type Pool     = "BRAVE" | "SAFE";
```

Rules:
- **All money is whole numbers.** No floating point anywhere in the program or in the rule checks.
- **Rounding always favours the pool**, never the person.
- **Prices and sizes sent to Hyperliquid** are whole numbers scaled by 100,000,000 (`_e8`), as in the working probe.
- Names in JSON are `snake_case`. Enum values are `UPPER_CASE`, except inside the decision line (section 6), which is lower case because the AI writes it.
- The coin has 6 decimals, so at the start one coin is worth one dollar.

## 3. Ranks

Fixed at deploy. No vote can change these numbers. Values `PROPOSED`.

| | `INTERN` | `ANALYST` | `TRADER` |
|---|---|---|---|
| `per_bet_bps`: most margin for one bet, as a share of the BRAVE pool | 200 | 500 | 1000 |
| `max_bets`: bets per round | 1 | 2 | 3 |
| `per_round_bps`: most margin at risk in one round | 200 | 800 | 2000 |
| `sides` | `LONG` | `LONG` | `LONG`, `SHORT` |
| `max_leverage` | 1 | 1 | 2 |
| `markets` | DOGE, SHIB, PEPE, PENGU | + WIF, TRUMP | the same six |

- **The limit base** is the smaller of two figures: the BRAVE pool's size at the moment the round opened (`brave_at_open`) and the BRAVE pool's size right now (`get_pot().brave.total`). People may cash out during a round, and a limit must never be sized on money that has left. *(1.1)*
- A limit in dollars is `limit base × bps / 10000`, rounded **down**. So a limit can go down during a round, never up.
- *(1.7)* The rulebook text (section 6.1) states the limits on **the limit base** too (the smaller figure), so it says what checks 11 and 12 will allow. *(Until 1.6 it used `brave_at_open` alone: after a cash-out, a bet of exactly the stated maximum was refused `OVER_TRADE_LIMIT`; known limit 17.)* If money leaves while the AI answers, the text changes and an answer to the old text is refused `WRONG_RULEBOOK`; the runner reads the rulebook again before proposing and, if it changed, asks once more.
- `min_notional`: 11000000 ($11). Hyperliquid refuses orders under $10 (VERIFIED, its docs: "Order must have minimum value of $10"). *(1.2: it was $10. An order is sized `floor(notional / px)` cut to the size decimals, so a $10 bet always became an order a little under $10 that Hyperliquid would refuse. Found by Engine 2.)*
- A fourth state, `FIRED`: no new bets. Closing an open bet is still allowed.
- The Intern starts as `INTERN`, `EMPLOYED`.

```ts
type Limits = {
  rank: RankName;
  per_bet_bps: Bps; max_bets: number; per_round_bps: Bps;
  sides: Side[]; max_leverage: number; markets: Market[];
};
```

## 4. Markets

Our name on the left; Hyperliquid's on the right. Indexes are from Hyperliquid's own market list on 2026-11-11 (VERIFIED, `research-scripts/hl_markets_2026-11-11.txt`). **They differ per network and can change**, so they are pinned at deploy and re-checked before each deploy.

| `Market` | Hyperliquid name | Testnet index | Mainnet index | Size decimals | Note |
|---|---|---|---|---|---|
| DOGE | DOGE | 173 | 12 | 0 | |
| SHIB | kSHIB | 29 | 38 | 0 | One unit is 1,000 SHIB |
| PEPE | kPEPE | 12 | 15 | 0 | One unit is 1,000 PEPE |
| PENGU | PENGU | 139 | 163 | 0 | |
| WIF | WIF | 78 | 98 | 0 | |
| TRUMP | TRUMP | 150 | 174 | 1 | |

```ts
type MarketInfo = { market: Market; hl_name: string; hl_asset: number; sz_decimals: number };
```

Hyperliquid's number format (VERIFIED, its docs and the probe): a price has at most 5 significant figures and at most `6 − sz_decimals` decimal places; a size has `sz_decimals` decimal places; trailing zeros are removed.

## 5. The round

A round is a fixed length of time. Every moment in it is an **offset from the round's start**, stored as a constant. **Nobody hard-codes clock times**: the site and the runner read the offsets from `get_constants`.

| Constant | Real product | Demo deployment (`PROPOSED`) | Meaning |
|---|---|---|---|
| `round_ms` | 86,400,000 (24 h, starting 00:00 UTC) | 1,800,000 (30 min) | Length of a round |
| `guess_close_ms` | 42,900,000 (11:55) | 840,000 (14:00) | The free guess closes |
| `propose_from_ms` | 43,200,000 (12:00) | 900,000 (15:00) | Proposals accepted from here |
| `propose_until_ms` | 46,800,000 (13:00) | 1,200,000 (20:00) | Proposals accepted until here |
| `close_from_ms` | 79,200,000 (22:00) | 1,500,000 (25:00) | Anyone may close open bets from here |

```ts
type Phase = "OPEN" | "PROPOSE" | "HOLD" | "CLOSE";
```

| Phase | From | What is allowed |
|---|---|---|
| `OPEN` | round start | Pay in, cash out, vote. No bet is open |
| `PROPOSE` | `propose_from_ms` | The runner submits proposals |
| `HOLD` | `propose_until_ms` | Nothing new. Open bets stay open |
| `CLOSE` | `close_from_ms` | Anyone may close and settle |

Rules:
- **The next round starts only when this one is settled.** If a bet cannot be closed, the round stays in `CLOSE`. `stuck` is true when the round is not settled and the time is past `ends_at`. *(1.1)*
- Rounds start on the grid: round start times are whole multiples of `round_ms` after `genesis_ms`. A stuck round that settles late is followed by the round that would be running at that moment; skipped slots get no round.
- **Money paid into BRAVE counts from the next round.** It waits as `pending`. When that round opens, the money counts as coins from that moment: every view shows the right balances at once. The program writes each account's conversion into storage the next time that account does anything, so the `coins_minted` event for an account can arrive after `round_opened`, even much later. *(1.1: opening a round must never loop over every depositor.)*
- **Cash-out is never blocked** by any phase.
- A round with no bet is valid and is recorded.
- Tail or Fade (later phase) opens for `tail_fade_ms` (600,000) after each YES.

## 6. The decision format

This is the place where the two engines meet. It has three parts: the rulebook the program writes, the one line the AI answers, and the proof that travels with it.

### 6.1 The rulebook

The program builds this text itself, from its own state. The runner fetches it with `get_rulebook` and sends it to the AI **unchanged, as the system message**. The runner never builds it.

The template, byte for byte. Lines end with `\n`. No trailing newline after the last line. `{…}` are filled in by the program.

```
You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.
round: {round_id}
nonce: {nonce}
rank: {rank}
markets: {markets joined with ", "}
sides: {sides in lower case joined with ", "}
max_leverage: {max_leverage}
max_margin_e6: {largest margin allowed for the next bet}
min_notional_e6: {min_notional}
bets_left: {max_bets − bets_used}
playbook: {active playbook text, or "none"}
Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.
Answer with exactly one line of JSON and nothing else, in one of these two forms:
{"v":1,"round":{round_id},"nonce":"{nonce}","action":"skip"}
{"v":1,"round":{round_id},"nonce":"{nonce}","action":"bet","market":"DOGE","side":"long","margin_e6":"11000000","leverage":1}
```

- `max_margin_e6` is the smaller of the per-bet limit and what is left of the per-round limit, both computed from the limit base (section 3: the smaller of `brave_at_open` and the pool now). *(1.7; before, from `brave_at_open`.)*
- The example bet in the last line is $11, the smallest bet allowed. *(1.1: it was $1, which every model that copied the example would have been refused for. 1.2: $11, and the `min_notional_e6` line and the sentence on amounts were added, as Engine 2's 3-day run uses them: in that run's first ticks the models bet the example's amount far more often than any other.)*
- `nonce` is 16 lower-case hex characters. It changes at the start of each round and after every proposal the program rules on (YES, NOPE or skip). So a signed answer can be used once.
- Playbook text is limited to 2,000 bytes and may not contain a newline (the program replaces newlines with spaces when a playbook is submitted).
- *(1.5)* **Only in a round with a long-shot ticket** (section 9.7), one more line follows the `playbook:` line: `long_shot: one ticket this round: margin_e6 exactly <margin>, leverage up to 10`. The margin is 0.5% of `brave_at_open`, rounded down. Every other round's text is byte for byte as before.
- The user message is free. The runner puts market data there.

### 6.2 The decision line

The AI's answer must be **exactly** one of these, with the keys in this order, no spaces, no line break, nothing before or after:

```
{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"skip"}
{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"bet","market":"DOGE","side":"long","margin_e6":"20000000","leverage":1}
```

| Field | Type | Rule |
|---|---|---|
| `v` | number | Always 1 |
| `round` | number | The current round id |
| `nonce` | string | The rulebook's nonce |
| `action` | string | `"skip"` or `"bet"` |
| `market` | string | One of the six names in section 4, upper case |
| `side` | string | `"long"` or `"short"` |
| `margin_e6` | string | Dollars to put at risk, 6 decimals, digits only, no leading zero. The plain value `"0"` is allowed (it is well-formed, and is then refused as `ZERO_MARGIN`) |
| `leverage` | number | A whole number, 1 or more |

- The position size is `margin_e6 × leverage` dollars. The AI does not choose a price.
- **No tolerant reading.** The program parses the line, writes it out again in its own form, and requires the two to be byte-equal. Anything else is `MALFORMED_DECISION`: extra spaces, a different key order, a code fence, a sentence before the JSON, a number where a string belongs.
- *(1.2)* Blank lines, spaces or tabs before or after the line also make it `MALFORMED_DECISION` (test case D12). Two of the four models tried add blank lines before every answer when thinking is on; the pinned model does not.
- The AI is allowed to break the *limits*: that is what the rank checks are for, and what the 3-day run measures. It is the *shape* that must be exact.

### 6.3 The proof

NEAR AI signs each answer inside secure hardware. The signed text is:

```
{model}:{sha256 of the request body, lower-case hex}:{sha256 of the response body, lower-case hex}
```

(VERIFIED in NEAR AI's docs, `https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md`, and by recovering the signer of a real signature; see `RESEARCH-mandate-coin-prior-art.md`.)

A proposal therefore carries three things, each as base64:

| Field | What it is |
|---|---|
| `request` | The exact bytes of the HTTP request body the runner sent to NEAR AI |
| `response` | The exact bytes of the HTTP response body that came back |
| `signature` | The signature bytes NEAR AI returned for that exchange |

Outside facts the format depends on (all VERIFIED in the research unless marked):
- Base URL `https://cloud-api.near.ai/v1`. The signature is fetched from `GET /v1/signature/<chat id>?signing_algo=ecdsa|ed25519` and needs the API key.
- Two schemes exist. `ecdsa`: secp256k1, the Ethereum "personal sign" form, 65 bytes, the signer is a 20-byte address. `ed25519`: 64 bytes over the text, the signer is a 32-byte public key.
- **The default scheme differs per endpoint, and streamed or aliased requests are signed by a gateway, not the model's own hardware.** So: no streaming, the full model name, and the scheme always named.
- The pinned model and signer live in `get_constants().model`. *(1.2)* **Pinned: `z-ai/glm-5.3-flash`, scheme `ed25519`, signer (public key) `5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff`.** Chosen by Engine 2 from 19 recorded answers of four models (`intern/fixtures/ai/README.md`, findings 3 and 4): it never padded its answer, was the least swayed by the pressure messages of the 3-day run, and is the cheapest. ed25519 is one host call on-chain; ECDSA needs four steps.
- *(1.2)* **The request the runner sends** (checked by `ai-check` at check 4; any other shape, or any key written twice, is `WRONG_RULEBOOK`): a JSON object whose only keys are `model`, `messages`, `stream` and, optionally, `chat_template_kwargs`; `model` is the pinned model; `stream` is `false`; `messages` is exactly two messages, each with exactly the keys `role` and `content` (a string): the system message, equal to the rulebook byte for byte, then one user message; `chat_template_kwargs`, if present, is exactly `{"enable_thinking": false}`.
- *(1.2)* The runner also sends the headers `x-no-aliasing: true` and `Accept-Encoding: identity`. Without them NEAR AI's gateway may sign instead of the model (VERIFIED by Engine 2 in NEAR AI's docs, `response-signatures.md`).
- The hashes cover the request and response bodies exactly as sent and received. The decision line is the `content` of the one message in the response's `choices`, which must hold exactly one choice. *(1.2: VERIFIED by Engine 2 on 19 recordings.)*

What the proof shows and does not show: it shows which model gave which answer to which request, and that the request carried the current rulebook. It does **not** stop the runner from choosing the user message, or from asking several times and submitting one answer. **The rank is the only bound.** Every public text says so.

## 7. The sixteen NOPE reasons

Spelled exactly like this everywhere: in the program, the runner, the site, the stickers, the README.

The checks run in this order and **stop at the first failure**, so one proposal gets one code.

*(1.5)* **The long-shot ticket** (section 9.7): in a round with a ticket, a bet at **exactly** the ticket's margin and above the rank's `max_leverage` is judged as the ticket. Checks 6, 7 and 8 apply as always; check 9 uses the ticket's cap (10, or 5 on PENGU and WIF, Hyperliquid's own limits); checks 10 and 11 do not apply (it is one extra bet of a fixed size); check 12 applies (it sits inside the round's limit). Any other bet is judged as before.

| # | Code | Fails when | `asked` | `limit` |
|---|---|---|---|---|
| 1 | `OUTSIDE_WINDOW` | The phase is not `PROPOSE` | ms into the round | `propose_from_ms` if too early, `propose_until_ms` if too late |
| 2 | `FIRED` | Status is `FIRED` | — | — |
| 3 | `BAD_MODEL_SIGNATURE` | The signature does not match the pinned signer for the request and response given | — | — |
| 4 | `WRONG_RULEBOOK` | The request's system message is not the current rulebook, or the model named in the request is not the pinned one | — | — |
| 5 | `MALFORMED_DECISION` | The answer is not exactly a decision line, or its `v`, `round` or `nonce` is wrong | — | — |
| 6 | `NOT_ON_LIST` | `market` is not on this rank's list | — | — |
| 7 | `SHORT_NOT_UNLOCKED` | `side` is `short` and the rank allows only `LONG` | — | — |
| 8 | `ZERO_MARGIN` | `margin_e6` is 0, or `margin_e6 × leverage` is under `min_notional` | notional | `min_notional` |
| 9 | `OVER_LEVERAGE` | `leverage` is above the rank's `max_leverage` | leverage | `max_leverage` |
| 10 | `TOO_MANY_TRADES` | `bets_used` already equals `max_bets` | `bets_used + 1` | `max_bets` |
| 11 | `OVER_TRADE_LIMIT` | `margin_e6` is above the per-bet limit | margin | per-bet limit in dollars |
| 12 | `OVER_ROUND_LIMIT` | `at_risk + margin_e6` is above the per-round limit | `at_risk + margin` | per-round limit in dollars |
| 13 | `BAD_QUOTE_SIGNATURE` | A funding quote is attached and its signature does not match the pinned 1Click key | — | — |
| 14 | `STALE_QUOTE` | The quote's timestamp is older than `quote_max_age_ms` (60,000, `PROPOSED`) | age in ms | `quote_max_age_ms` |
| 15 | `QUOTE_MISMATCH` | The quote is for another amount or pays someone else | quote amount | margin |
| 16 | `TOO_EXPENSIVE` | The quote's cost is above `max_funding_cost_bps` (400, `PROPOSED`) of the margin | cost in bps | `max_funding_cost_bps` |

- A `skip` that passes checks 1–5 is accepted and recorded. It is not a bet and uses none of the limits.
- Checks 13–16 run only when a funding quote is attached. On testnet the quote is optional (section 9.4).
- `ZERO_MARGIN` also covers "too small for the exchange". This widens the product spec's meaning ("empty order") by one case; it avoids a seventeenth code.
- Input that cannot even be decoded (bad base64 in `request`, `response` or `signature`) is recorded as `BAD_MODEL_SIGNATURE`; a funding quote that cannot be decoded is `BAD_QUOTE_SIGNATURE`. Neither aborts. *(1.1)*
- Checks 8–12 use the limit base of section 3.
- **A NOPE is a successful transaction.** The program records it, emits an event and returns the verdict. It must not abort, because an abort erases the record. Only a caller who is not allowed to call at all gets an abort.

```ts
type RefusalCode =
  | "OUTSIDE_WINDOW" | "FIRED" | "BAD_MODEL_SIGNATURE" | "WRONG_RULEBOOK" | "MALFORMED_DECISION"
  | "NOT_ON_LIST" | "SHORT_NOT_UNLOCKED" | "ZERO_MARGIN" | "OVER_LEVERAGE" | "TOO_MANY_TRADES"
  | "OVER_TRADE_LIMIT" | "OVER_ROUND_LIMIT" | "BAD_QUOTE_SIGNATURE" | "STALE_QUOTE"
  | "QUOTE_MISMATCH" | "TOO_EXPENSIVE";
```

For the site, the sixteen checks group into five lights, lit in this order:

| Light | Checks |
|---|---|
| 1 On time and employed | 1–2 |
| 2 Really the AI | 3–5 |
| 3 Allowed coin and direction | 6–7 |
| 4 Fits the rank | 8–12 |
| 5 Funding quote | 13–16 |

## 8. Questions the program answers (views)

Read-only and free. The site and the runner use only these.

| View | Arguments | Returns |
|---|---|---|
| `get_constants` | — | `Constants` |
| `get_rank` | — | `RankState` |
| `get_limits` | `{ rank: RankName }` | `Limits` |
| `get_round` | — | `Round` (the current one) |
| `get_round_by_id` | `{ round_id: number }` | `Round \| null` |
| `get_rulebook` | — | `Rulebook` |
| `get_positions` | `{ round_id?: number }` | `Position[]` (default: current round) |
| `get_outbox` | `{ after_id?: number, limit?: number }` | `SignedAction[]` |
| `get_pot` | — | `Pot` |
| `get_account` | `{ account_id: AccountId }` | `Account` |
| `get_votes` | `{ from?: number, limit?: number }` | `Vote[]`, newest first |
| `get_refusals` | `{ from?: number, limit?: number }` | `Refusal[]`, newest first |
| `get_sticker_firsts` | — | `StickerFirst[]`, sixteen, in the order of section 7 *(1.3: shape widened)* |
| `get_feed` | `{ after_seq?: number, limit?: number }` | `FeedItem[]`, oldest first |
| `get_active_playbook` | — | `Playbook \| null` |
| `get_playbooks` *(1.3)* | `{ from?: number, limit?: number }` | `Playbook[]`, newest first |
| `get_goals` *(1.3)* | — | `Goals` |
| `get_goal_fills` *(1.3)* | `{ from?: number, limit?: number }` | `GoalFill[]`, newest first |
| `get_rewards` *(1.4)* | — | `Rewards` (section 9.7) |
| `get_player` *(1.4)* | `{ account_id: AccountId }` | `PlayerView` (section 9.7) |
| `get_draw_results` *(1.4)* | `{ from?: number, limit?: number }` | `DrawResult[]`, newest first |
| `get_jackpot_wins` *(1.4)* | `{ limit?: number }` | `JackpotWin[]`, newest first |
| `get_claimable` *(1.3)* | `{ account_id: AccountId }` | `Claimable` |
| `get_week` *(1.6)* | — | `WeekView` (section 9.8) |
| `get_auto` *(1.7)* | — | `AutoView` (section 9.9) |
| `get_bounty` *(1.7)* | — | `{ pot, paid_total, added_total, from_tricks_total: Usdc; tricks_paid: number; trick_price: Usdc; bounty_bps: number }` (section 9.10) |
| `get_nft_earnings` *(1.7)* | — | `{ owed_total, paid_total: Usdc; tokens: { token_id, owed: Usdc }[]; careers_minted: number }` (section 9.12) |
| `get_career` *(1.7)* | — | `{ rank, status, level, rounds, bets, refusals: number; result: Signed; svg: string }` (section 9.12) |
| `get_challenges` *(1.7)* | — | `{ bonds_held, bond: Usdc; window_rounds: number; challenges: { vote_id, position_id, challenger, bond, reported, claimed, reason, state: "OPEN" \| "PASSED" \| "APPLYING" \| "APPLIED" \| "FAILED" }[] }`, newest first, at most 20 (section 9.14) |
| `get_stake` *(1.7)* | — | `{ coins: U128; value: Usdc; fee_bps: number; grew_total, burned_total: U128 }` (section 9.13) |
| `get_rescue` *(1.7)* | — | `{ fund, target: Usdc; contributors: number; rescuers: [AccountId, Usdc][]; from_round, until_round: number; cut_bps: number; paid_total: Usdc; rescues: number }` (section 9.11) |
| `get_trick_payment` *(1.7)* | `{ id: string }` | `{ account_id, amount: Usdc, at: Ms, round_id } \| null` (section 9.10) |
| `get_rebalance` *(1.7)* | — | `{ action: "LEND" \| "RECALL" \| "NONE" \| "BUSY" \| "NO_LENDER", amount: Usdc }`: what `rebalance` would move now, without moving it |
| `get_league` *(1.6)* | `{ week?: number, group?: number, account_id?: AccountId }` | `LeagueView` (section 9.8) |
| `get_league_results` *(1.6)* | `{ week: number }` | `GroupResult[]` (section 9.8) |
| `get_review` *(1.6)* | `{ week: number }` | `ReviewView \| null` (section 9.8) |
| `get_reviews` *(1.6)* | `{ from?: number, limit?: number }` | `ReviewView[]`, newest first; `limit` defaults to 10, at most 50 |
| `ft_balance_of`, `ft_total_supply`, `ft_metadata`, `storage_balance_of` | standard | standard NEP-141 / NEP-145 / NEP-148 |

`limit` defaults to 50 and is capped at 100.

Paging *(1.1)*:
- On the newest-first lists (`get_votes`, `get_refusals`), `from` is the highest id to return. Leave it out to start from the newest.
- `get_feed` with no `after_seq` returns the latest `limit` items, still oldest first.
- The feed keeps 1,000 items. If a reader has fallen further behind than that, the reply starts at the oldest item still kept; the jump in `seq` shows that items were missed.
- *(1.6)* `get_outbox` keeps the last 200 signed actions (`OUTBOX_KEEP`). An older bet's orders can no longer be read back from the contract; its fills on Hyperliquid can still be found by their client order id (section 11.2).

### 8.1 Shapes

```ts
type Constants = {
  interface_version: "1.3";
  network: "testnet" | "mainnet";
  usdc_token: AccountId;
  coin_decimals: 6;
  ranks: Limits[];                 // three entries
  markets: MarketInfo[];           // six entries
  min_notional: Usdc;
  round: { genesis_ms: Ms; round_ms: number; guess_close_ms: number; propose_from_ms: number;
           propose_until_ms: number; close_from_ms: number; tail_fade_ms: number };
  vote: { promote_pass_bps: Bps; promote_quorum_bps: Bps; tighten_pass_bps: Bps;
          vote_ms: number; weight_full_rounds: number };
  model: { id: string; signing_algo: "ecdsa" | "ed25519"; signer: string };  // signer as hex
  funding: { mode: "RECORDED" | "ONECLICK"; quote_signer: string; quote_max_age_ms: number;
             max_funding_cost_bps: Bps };
  result_source: "REPORTED" | "MEASURED";
  lending: { mode: "NONE" | "STANDIN" | "RHEA"; lender: AccountId | null };   // (1.7) lender: the lending contract
  hl: { testnet: boolean; address: string; signer_contract: AccountId; path: string;
        order_expiry_ms: number };
  runner: AccountId;
  min_first_deposit: Usdc;
  refusal_codes: RefusalCode[];    // sixteen, in the order of section 7
  // (1.3)
  coach_cut_bps: Bps;              // share of a winning round paid to the active playbook's authors
  goals: { boss_ladder: number[]; tip_jar_target: Usdc; min_tip: Usdc;
           hype_window_ms: number; hype_levels: number[] };
  stickers: AccountId;             // the NFT contract (section 9.5)
  launchpad: AccountId;            // the launchpad contract (section 9.5)
};

type RankState = {
  rank: RankName; status: Status; since_round: number;
  pending: { rank: RankName; status: Status; effective_round: number } | null;
};

type Round = {
  id: number; phase: Phase; settled: boolean; stuck: boolean;
  started_at: Ms; guess_closes_at: Ms; propose_from: Ms; propose_until: Ms; close_from: Ms; ends_at: Ms;
  rank: RankName; status: Status;          // as they were when the round opened
  brave_at_open: Usdc;
  bets_used: number; at_risk: Usdc; skipped: number; refused: number;
  result: Signed | null;                   // dollars back minus dollars out; null until settled
};

type Rulebook = { round_id: number; nonce: string; text: string };

type PositionStatus = "APPROVED" | "OPEN_SIGNED" | "CLOSE_SIGNED" | "SETTLED";
type Position = {
  id: number; round_id: number; market: Market; side: Side;
  margin: Usdc; leverage: number; notional: Usdc;
  status: PositionStatus;
  approved_at: Ms; open_signed_at: Ms | null; close_signed_at: Ms | null; settled_at: Ms | null;
  sz_e8: U128 | null;                      // size of the open order, in the exchange's units
  returned: Usdc | null; result: Signed | null;
  result_source: "REPORTED" | "MEASURED" | "ABANDONED" | "CORRECTED" | null;   // (1.7) ABANDONED: booked as lost by `abandon`; CORRECTED: a challenge passed
};

type SignedAction = {
  id: number; position_id: number; kind: "LEVERAGE" | "OPEN" | "CLOSE";
  action: object;                          // the exact JSON Hyperliquid expects as "action"
  nonce: Ms; expires_after: Ms;
  signature: { r: string; s: string; v: number };   // r, s as 0x-hex; v is 27 or 28, Hyperliquid's own form (1.2)
  created_at: Ms;
};

type Pot = {
  brave: { total: Usdc; lent: Usdc; in_play: Usdc; idle: Usdc; pending: Usdc;
           interest: Usdc;          // (1.3) lending interest collected into the pool so far
           income_waiting: Usdc };  // (1.3) outside income credited at the next round's opening
  safe:  { total: Usdc; lent: Usdc; idle: Usdc };
  coin_supply: Coin;
  coin_price_e6: U128;                     // dollars per whole coin, 6 decimals. "1000000" is $1.00.
                                           // Counts everything in BRAVE except margin out on open bets (section 9.1)
  bosses: number;                          // accounts holding the coin
  outside_income_total: Usdc;
};

type Account = {
  account_id: AccountId; registered: boolean;
  coin: Coin; locked: Coin; brave_value: Usdc; pending_brave: Usdc; safe: Usdc;
  joined_round: number | null;             // first round this account held the coin
  vote_weight: U128;                       // right now, for a vote opened right now
};

type VoteKind = "PROMOTE" | "DEMOTE" | "FIRE" | "REHIRE" | "SET_PLAYBOOK" | "LONG_SHOT" | "RENEW" | "CORRECT";   // (1.5) LONG_SHOT, (1.7) RENEW, CORRECT (opened only by a challenge)
type Vote = {
  id: number; kind: VoteKind; playbook_id: number | null; opened_by: AccountId;
  opened_at: Ms; closes_at: Ms;
  yes: U128; no: U128; locked_weight_at_open: U128;
  state: "OPEN" | "PASSED" | "FAILED"; effective_round: number | null;
};

type Refusal = {
  id: number; round_id: number; code: RefusalCode; at: Ms;
  asked: string | null; limit: string | null;      // the numbers of section 7, as decimal strings
  decision: Decision | null;                        // null when the answer could not be read
  is_first: boolean;                                // first refusal ever with this code
  credited_to: AccountId | null;                    // (1.3) the visitor the runner named, if any
};

type StickerFirst = {                               // (1.3)
  code: RefusalCode;
  account_id: AccountId | null;   // the credited account of the first CREDITED refusal with this code
  round_id: number | null;        // the round of that refusal
  claimed: boolean;
};

type Decision =
  | { action: "SKIP" }
  | { action: "BET"; market: Market; side: Side; margin: Usdc; leverage: number };

type Playbook = { id: number; text: string; authors: { account_id: AccountId; share_bps: Bps }[];
                  submitted_round: number;
                  active_from: number | null;     // (1.3) the round it became active, if it ever did
                  paid_total: Usdc };             // (1.3) coach cut paid to its authors so far

type Goals = {                                      // (1.3) section 9.5
  boss:    { level: number; target: number | null; now: number };    // target null: the ladder is done
  tip_jar: { jar: number; target: Usdc; now: Usdc };
  hype:    { train: number; level: number; points: number; ends_at: Ms | null };  // ends_at null: no train running
};
type GoalFill = { id: number; goal: "BOSS" | "TIP_JAR" | "HYPE"; level: number; at: Ms; round_id: number };
type Claimable = { badge: boolean; originals: RefusalCode[]; goal_fills: number[] };

type FeedItem = { seq: number; at: Ms; event: EventName; data: object };  // section 10
```

### 8.2 Sample answers

These are made-up values in the correct shape. The site builds on them until the stub is live; the stub returns them.

`get_rank`
```json
{"rank":"INTERN","status":"EMPLOYED","since_round":1,"pending":null}
```

`get_round` (a $1,000 BRAVE pool, one bet approved)
```json
{"id":42,"phase":"HOLD","settled":false,"stuck":false,
 "started_at":1794355200000,"guess_closes_at":1794398100000,"propose_from":1794398400000,
 "propose_until":1794402000000,"close_from":1794434400000,"ends_at":1794441600000,
 "rank":"INTERN","status":"EMPLOYED","brave_at_open":"1000000000",
 "bets_used":1,"at_risk":"20000000","skipped":0,"refused":2,"result":null}
```

`get_positions`
```json
[{"id":7,"round_id":42,"market":"DOGE","side":"LONG","margin":"20000000","leverage":1,
  "notional":"20000000","status":"OPEN_SIGNED","approved_at":1794398460000,
  "open_signed_at":1794398481000,"close_signed_at":null,"settled_at":null,
  "sz_e8":"29300000000","returned":null,"result":null,"result_source":null}]
```

`get_pot`
```json
{"brave":{"total":"1000000000","lent":"980000000","in_play":"20000000","idle":"0","pending":"50000000"},
 "safe":{"total":"400000000","lent":"400000000","idle":"0"},
 "coin_supply":"1000000000","coin_price_e6":"1000000","bosses":23,"outside_income_total":"0"}
```

`get_account`
```json
{"account_id":"boss.testnet","registered":true,"coin":"250000000","locked":"100000000",
 "brave_value":"250000000","pending_brave":"0","safe":"100000000","joined_round":12,
 "vote_weight":"100000000"}
```

`get_refusals`
```json
[{"id":31,"round_id":42,"code":"OVER_TRADE_LIMIT","at":1794398420000,
  "asked":"450000000","limit":"20000000",
  "decision":{"action":"BET","market":"DOGE","side":"LONG","margin":"450000000","leverage":1},
  "is_first":false}]
```

`get_feed`
```json
[{"seq":912,"at":1794398420000,"event":"refused",
  "data":{"refusal_id":31,"round_id":42,"code":"OVER_TRADE_LIMIT","asked":"450000000","limit":"20000000"}},
 {"seq":913,"at":1794398460000,"event":"approved",
  "data":{"position_id":7,"round_id":42,"market":"DOGE","side":"LONG","margin":"20000000","leverage":1}}]
```

## 9. Actions

Calls that change something. Each row says who may call.

### 9.1 Money

| Action | Who | Call | What happens |
|---|---|---|---|
| Register | Anyone | `storage_deposit` on the coin contract (NEP-145), with the deposit `storage_balance_bounds` names | Required once before holding the coin or a SAFE balance, or guessing. *(1.4)* 1,280 bytes (0.0128 NEAR): the boss's records and the reward ladder's. Read the amount from `storage_balance_bounds`; never hard-code it |
| Pay in | Anyone registered | On the **USDC token**: `ft_transfer_call({ receiver_id: <coin contract>, amount, msg })`, 1 yocto. `msg` is `{"pool":"BRAVE"}` or `{"pool":"SAFE"}` | SAFE is credited at once. BRAVE waits as `pending` and becomes coins when the next round opens. A bad `msg`, an unregistered sender or any token other than the pinned USDC is refunded in full |
| Cash out | The holder | `cash_out({ pool: Pool, amount, pending?: boolean })`, 1 yocto. For BRAVE `amount` is coins; for SAFE it is dollars | BRAVE: burns the coins, pays the pro-rata share of what the pool holds. SAFE: pays dollars. With `pending: true` and pool BRAVE, `amount` is dollars taken back from money still waiting for the next round |
| Turn the dial | The holder | `turn_dial({ to: Pool, amount })`, 1 yocto. To SAFE, `amount` is coins; to BRAVE, dollars | The same as cashing out of one side and paying into the other, without the money leaving |
| Transfer coins | The holder | Standard `ft_transfer`, `ft_transfer_call` | Locked coins cannot be transferred |

- The first deposit ever into BRAVE must be at least `min_first_deposit`; 1,000 units of coin from it are locked for ever (so the first depositor cannot bend the share price).
- **Cashing out while a bet is open** *(1.1)*: margin that is out on an open bet (`brave.in_play`) is not paid out and is not counted in `coin_price_e6`. Someone who leaves during an open bet gives up their share of that bet, win or lose; it stays with the bosses who remain. Without this rule a boss could watch the bet on Hyperliquid, which is public, and leave at full value whenever it is losing. The site shows a warning on the cash-out form while a bet is open.
- If the lending market cannot pay back what a cash-out needs, nothing changes and the call can be made again (section 9.6, as the contract does). *(1.6: this line used to say "pays what is available and reports the rest as still owed", which the contract never did.)*

### 9.2 Voting

| Action | Who | Call |
|---|---|---|
| Lock coins | A boss | `lock({ amount })` |
| Unlock | A boss | `unlock({ amount })`. Refused while the boss has voted in a vote that is still `OPEN` |
| Open a vote | A boss with locked coins | `open_vote({ kind: VoteKind, playbook_id?: number })` → vote id. One open vote per kind at a time |
| Vote | A boss with locked coins | `cast({ vote_id, support: boolean })`. Once per vote |
| Finish | Anyone | `finish_vote({ vote_id })`, after `closes_at` |

Rules (`PROPOSED` numbers in `get_constants().vote`):
- **Weight** = locked coins × `min(full rounds since they were locked, weight_full_rounds) / weight_full_rounds`, with `weight_full_rounds` = 7. Coins locked after the vote opened count as zero.
- **Promote, rehire, set playbook** pass with yes above `promote_pass_bps` (5,000) of the weight that voted **and** total votes of at least `promote_quorum_bps` (2,000) of `locked_weight_at_open`. They take effect at the start of the **second** round to open after the vote passes, so one full round runs in between.
- **Demote, fire** pass with yes of at least `tighten_pass_bps` (3,400) of `locked_weight_at_open`: a third of all the weight locked when the vote opened. No quorum, and "no" votes do not change the result. They take effect at once: no new bets from that moment. Open bets may still be closed. *(1.2: it was 34% of the weight that voted, which let one boss with one locked coin fire the Intern whenever nobody else voted.)*
- Promote moves up one rank; demote moves down one; rehire returns at `INTERN`.
- *(1.5)* **Long shot** (`LONG_SHOT`) passes like a promotion and takes effect at the start of the second round after it passes: that round allows one long-shot ticket (section 9.7). Only while `EMPLOYED`; not while a ticket waits, and not until seven rounds after the last ticket's round.
- *(1.1)* **What a demotion does at once:** the lower rank's limits apply from that moment, against the same round's counters. Bets already approved stay. If `bets_used` or `at_risk` is already at or over the lower rank's limits, no further bet passes this round.
- *(1.1)* A demotion or a firing cancels a promotion that is still waiting to take effect.
- *(1.1)* `REHIRE` can be opened only while the Intern is `FIRED`. `PROMOTE`, `DEMOTE` and `FIRE` only while `EMPLOYED`. `PROMOTE` cannot be opened at `TRADER`, nor `DEMOTE` at `INTERN`.
- *(1.1)* **When a vote counts as passed.** At `closes_at`, whatever the time `finish_vote` is called; `effective_round` is worked out from `closes_at`. One exception so that tightening is fast: a `DEMOTE` or `FIRE` vote may be finished early, the moment yes reaches `tighten_pass_bps` of `locked_weight_at_open`. *(1.2: with the new pass rule this is the same test, so a demote or fire vote can be finished the moment it has passed.)*
- *(1.1)* Weight counts only coins that were locked before the vote opened **and are still locked** when the vote is cast.
- `vote_ms`: how long a vote stays open (one round length).
- A vote cannot change a rank's numbers, add a market, move money or change the program.

### 9.3 The round, for the runner

| Action | Who | Call | Returns |
|---|---|---|---|
| Propose | The runner only | `propose({ request, response, signature, funding?, credited_to? })` | `Verdict` |
| Sign the next order | The runner only *(1.1)* | `sign_next({ position_id, px_e8 })`, no deposit, generous gas (300 TGas) | The signed action, also placed in the outbox; or `null` if the signing network failed or its signature did not check out: nothing changed, call again *(1.2)* |
| Close | Anyone, in phase `CLOSE` (or at any time once `FIRED`) | `close({ position_id, px_e8 })`, 1 yocto, 300 TGas. May be called again *(1.1)* | The signed closing action; or `null`, as for `sign_next` *(1.2)* |
| Report the result | The runner only, and only when `result_source` is `REPORTED` | `report_result({ position_id, returned })` | — |
| Settle | Anyone | `settle({ round_id })`, once every bet in the round has a result | The round's result |

```ts
type Verdict =
  | { verdict: "YES";  position_id: number }
  | { verdict: "SKIP" }
  | { verdict: "NOPE"; refusal_id: number; code: RefusalCode; asked: string | null; limit: string | null };
```

How a YES becomes an order:
1. `propose` only checks and records. It is quick. This is the moment Stamp comes down.
2. `sign_next` is called twice. The first call signs "set leverage, isolated" for that market. The second signs the opening order: an immediate-or-cancel limit order at `px_e8`, with size `floor(notional / px)` cut to the market's size decimals. Each call takes 6–10 seconds because NEAR's signing network is asked (VERIFIED timing on testnet).
3. Each signed action goes into the outbox. **Anyone** may deliver it to Hyperliquid before `expires_after` (120 seconds after signing). The runner does this.
4. `close` signs a reduce-only order for the same size on the other side. It may be signed again with a new price for as long as the position has no result: a reduce-only order can only shrink a position, so signing it twice adds no risk, and a close at a price that never fills must not strand the bet.

Why `sign_next` is runner-only *(1.1)*: the opening order can be signed once. If anyone could call it, a stranger could sign it first at a price that never fills and waste the day's bet, every day. The program pays the signing network's 1-yocto deposit from its own balance, so the runner's function-call key can make this call.

The program builds every hash itself from fields it has checked. It never signs a hash handed to it.

`px_e8` is supplied by the caller, as a decimal string like `sz_e8` (*1.2*; the program also accepts a JSON number). The program requires `px × size ≤ notional` on an opening order, so a caller cannot make the bet bigger. A caller can still pick a poor price; the loss from that is bounded by the margin (section 14).

### 9.4 Funding quote (`funding`)

```ts
type Funding = { quote: string; signature: string };   // the signed 1Click quote, base64, as returned
```

- Mainnet (`funding.mode` = `ONECLICK`): required. The program verifies it, then pays the margin to the quote's deposit address.
- Testnet (`funding.mode` = `RECORDED`): optional. If attached it is verified in full, so checks 13–16 can be triggered with real signed quotes; no money moves. If absent, checks 13–16 are skipped.
- Outside facts (VERIFIED, `RESEARCH-vault-prior-art.md` and `RESEARCH-near-memecoin-trading-feasibility.md`): quotes from `https://1click.chaindefuser.com/v0/quote` are signed with ed25519 by `ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`; the signature covers the deposit address; the quote carries a timestamp. NEAR Intents has no testnet.
- `TO VERIFY`: one real transfer of a few dollars from a contract-held balance on mainnet. Owner's yes needed.

### 9.5 Playbooks, stickers, goals and the launchpad *(1.3)*

Decided by the owner on 2026-11-12: all four are built, the coach cut is 10%, and a "first of its kind" sticker goes to the visitor whose message led to that refusal. Numbers marked `PROPOSED` are starting values.

**None of these changes what the Intern may trade.** Only the rank (section 3) and the vote (9.2) do. A playbook can steer choices inside the rank; it can never lift a limit.

#### Playbooks

| Action | Who | Call |
|---|---|---|
| Submit | Anyone | `submit_playbook({ text, authors })`, with a NEAR deposit covering its storage (`text` bytes + 200, at 10^19 yocto a byte); the rest is refunded. Returns the playbook id |
| Activate | The vote | `open_vote({ kind: "SET_PLAYBOOK", playbook_id })`. `playbook_id: 0` clears the playbook |

- `text`: 1 to 2,000 bytes; newlines become spaces (section 6.1). `authors`: 1 to 5 accounts, `share_bps` adding up to 10,000.
- `SET_PLAYBOOK` passes like a promotion (section 9.2) and takes effect at the start of the second round after it passed. From that round the rulebook's `playbook:` line carries its text. It may be opened in any rank or status; only one may be open or waiting at a time.
- **Coach cut.** When a round settles with a positive result and a playbook was active in that round, `coach_cut_bps` (`PROPOSED` 1,000 = 10%) of the result is paid in USDC to its authors, split by `share_bps`, rounded down; the rest of the result, and any rounding dust, stays in the BRAVE pool. A losing round pays nothing. A payment that fails (an author not registered on the USDC token) goes back to the pool and is logged.

#### Stickers and the boss badge (NEP-171)

A separate NFT contract (`get_constants().stickers`), NEP-171 with metadata (NEP-177) and enumeration (NEP-181). Only the coin contract can mint on it. Claims are made on the coin contract, which checks the right and asks the NFT contract to mint.

| Token | Id | Transferable | Who may claim, on the coin | Call |
|---|---|---|---|---|
| Boss badge | `badge:<account>` | **No** | Anyone who holds or ever held coins (`joined_round` set). One per account. Metadata `extra`: `{"joined_round": N}` | `claim_badge()` |
| First of its kind | `original:<CODE>` | Yes | The `account_id` of `get_sticker_firsts` for that code. Sixteen exist, ever | `claim_sticker({ code })` |
| Goal sticker | `goal:<fill id>:<account>` | Yes | An account eligible for that goal fill (below) | `claim_goal_sticker({ fill_id })` |

- Each claim attaches a NEAR deposit for the token's storage (`PROPOSED` 0.02 NEAR; what the token does not use goes back to the claimer). A failed mint puts the right back and refunds the deposit.
- **Credited refusals.** `propose` takes an optional `credited_to`: the visitor whose message the runner used (the trick page). It is stored with the refusal. **The program cannot check it**: it trusts the runner for the name, as it does for the user message (section 6.3). The first refusal of each code that has a `credited_to` decides that code's sticker.

#### Tips and goal bars

| Action | Who | Call |
|---|---|---|
| Tip | Anyone registered | On the USDC token: `ft_transfer_call({ receiver_id: <coin>, amount, msg: '{"tip":{}}' })`, at least `min_tip` (`PROPOSED` 1 USDC) |

- *(1.4)* **Half of a tip goes to the streak jackpot** (section 9.7). The other half is a gift to the BRAVE pool: like all outside income (section 9.6) it is credited at the next round's opening and counted in `outside_income_total`. The tip jar counts the whole tip. A tip buys no influence over the Intern.
- **Boss goal.** Targets from `boss_ladder` (`PROPOSED` 10, 25, 50, 100, 250, 500, 1000). When `get_pot().bosses` reaches the next target, the goal fills. Eligible: every account that holds coins when it claims and joined no later than the round the goal filled in.
- **Tip jar.** Fills when the tips since the last jar reach `tip_jar_target` (`PROPOSED` 100 USDC); a tip that overflows starts the next jar with the rest. Eligible: every account that tipped into that jar.
- **Hype train.** Each tip, and each BRAVE pay-in of at least `min_notional`, is one point (one per account per train). A train starts with the first point and ends `hype_window_ms` (`PROPOSED` 300,000) after its latest point. It climbs through `hype_levels` (`PROPOSED` 3, 6, 10, 15, 25 points). Each new level is a goal fill; reaching the top level makes every account that added a point to that train eligible.
- Filling a goal never moves money and never changes the rank. The reward is a claimable sticker and a stream event.

#### The launchpad

A separate contract (`get_constants().launchpad`) on NEAR. Someone launches a new memecoin; anyone buys and sells it against a price curve in USDC; a fee on each trade goes to the BRAVE pool as outside income (`source: "launchpad"`).

| Action | Who | Call |
|---|---|---|
| Register | Anyone | `storage_deposit` on the launchpad (NEP-145) |
| Launch | Anyone registered | `launch({ name, symbol })` → token id |
| Buy | Anyone registered | On the USDC token: `ft_transfer_call({ receiver_id: <launchpad>, amount, msg: '{"buy":{"token_id":N,"min_out":"…"}}' })` |
| Sell | A holder | `sell({ token_id, amount, min_out })`, 1 yocto |
| Transfer | A holder | `transfer({ token_id, receiver_id, amount })`, 1 yocto |

- The curve is constant-product with virtual reserves (`PROPOSED`: 1,000,000,000 tokens with 6 decimals, a virtual 1,000 USDC). The fee is `PROPOSED` 100 bps of each trade, sent to the coin contract.
- Views: `get_launches({ from?, limit? })`, `get_launch({ token_id })`, `get_balance({ token_id, account_id })`, `get_quote({ token_id, side, amount })`.
- **The Intern never buys a launched coin with pool money.** The coin contract has no call into the launchpad at all.
- Every introduction of a launch on stream is labelled as a launch, not as advice.

### 9.6 Lending and outside income *(1.3, Engine 1 step 8)*

**Lending.** `get_constants().lending.mode` is `STANDIN` on testnet: Rhea Lend works from a contract on mainnet (VERIFIED in its source and on chain, 2026-11-12), but its testnet market takes only tokens its owners listed, not our test dollar. So testnet lends to a small **stand-in lender** that pays a fixed test rate (`PROPOSED` 5% a year) and mints its interest from the test dollar's open tap. **Stand-in interest is worth nothing and is labelled as such everywhere.**

| Action | Who | Call | What happens |
|---|---|---|---|
| Rebalance | Anyone (the runner, each round) | `rebalance()` | Keeps exactly the Intern's slice idle (its rank's per-round limit on the pool): lends what is idle beyond it (at least $10), or brings back what it lacks (at least $1). Returns the dollars moved, negative when brought back |
| Collect interest | Anyone | `collect_interest()` | *(1.4)* The interest the lender owes is held for the payday draw (`get_rewards().draw_pot`, section 9.7), not added to the pool. `brave.interest` still counts all interest collected |

- Money waiting as `pending`, SAFE money and margin in play are never lent.
- A BRAVE cash-out or a dial turn to SAFE that needs more than is idle first brings the difference back from the lender, plus what the slice then lacks, and then pays. **Such a call needs 150 TGas: attach 300.** If the lender cannot pay, nothing changes and the call can be made again.
- At every moment `brave.lent + brave.idle + brave.in_play = brave.total`.
- Mainnet (not built): supply with `ft_transfer_call` to the lending contract with an empty `msg`, withdraw with `simple_withdraw`, after reading the market's free liquidity. A withdrawal fails outright when the market is short of liquidity, and the lender's owners can pause it (an exploit in April 2026 paused it). Both are reasons the slice stays idle.

**Outside income.** Dollars sent on the USDC token with `ft_transfer_call({ receiver_id: <coin>, amount, msg: '{"income":{"source":"<label>"}}' })` (label: 1–32 of `a-z`, `0-9`, `_`, `-`) are credited to the BRAVE pool **at the next round's opening, before that opening turns pending money into coins**. So they go only to coins present for the whole round in which the income arrived, and new money pays a price that already includes them. The sender need not be registered (the launchpad sends its fees this way). Income is refused, and refunded, while the Intern is `FIRED`. Tips (section 9.5) are credited the same way.

### 9.7 The reward ladder *(1.4)*

The owner's decisions of 2026-11-13 (`05-REWARDS-LATER.md`). Every prize is paid from a named source (tips, direct additions, the lender's interest); no coin is minted for it, and **no reward changes what the Intern may trade**.

| Action | Who | Call | What happens |
|---|---|---|---|
| Guess | Anyone registered | `guess({ verdict: "YES" \| "NOPE" \| "SKIP" })`, free, once per round, before `guess_closes_at` | Judged on the round's **first ruling** (the runner asks the Intern's own question before any trick-page message). Right: a point, the streak grows. Wrong: the streak resets. A round with no ruling counts for nothing; a round not guessed pauses the streak. Returns `PlayerView` |
| Claim a golden sticker | Its owner | `claim_golden({ code, serial })`, 0.02 NEAR (the rest refunded) | Mints `golden:<CODE>:<serial>` on the sticker contract. Transferable |
| Join or leave the draw | A boss | `enter_draw()`, `leave_draw()` | At most 200 entrants |
| Add to the jackpot | Anyone | On the USDC token: `ft_transfer_call({ receiver_id: <coin>, amount, msg: '{"jackpot":{}}' })`, at least 1 USDC | The team's seed, a gift. No registration needed |
| Rewards tick | Anyone (the runner, each round) | `rewards_tick()`, 150 TGas | Settles the jackpots of closed rounds and holds a payday draw that is due |
| Claim prizes | The winner | `claim_prizes()`, 1 yocto, at least 40 TGas | Pays every prize owed, in USDC. A failed transfer is owed again |

- **Golden stickers (R2).** Each guess has a 1 in `golden_odds` (`PROPOSED` 50) chance of a golden sticker of one of the sixteen codes, at most `golden_cap` (100) of each code, ever.
- **The streak jackpot (R3).** `jackpot_streak` (7) right guesses in a row win it, but only for a boss who holds at least `min_boss_usd` ($10) **in BRAVE** *(1.7: BRAVE coins at today's value; SAFE and pending money no longer count)* and became a boss at least `min_boss_rounds` (7) rounds earlier; everyone else plays for points. *(1.7)* Several winners in one round split it **by the BRAVE dollars each holds** (at least $10 each), not equally; dust rolls over. It is filled by half of every tip (`tip_to_jackpot_bps` 5,000) and by direct additions.
- **The payday draw (R4).** Every `draw_rounds` (7) rounds, the interest collected in those rounds is drawn: `draw_top_bps` (70%) to one winner, the rest in `draw_runners` (10) equal shares; with nobody in it, it rolls over. *(1.7, Engine 2's "f3")* **Each of the eleven prizes is drawn by tickets with replacement**, so an account's expected prize is its share of the tickets however its money is split across accounts (one account may win several). A boss's tickets are **the smaller of the BRAVE dollars held when the period began (or when joining) and at the draw** *(1.7: BRAVE coins at today's value only; SAFE risks nothing and is not lent)*, times the rounds of the period they were in. `enter_draw` needs some BRAVE. **When the draw is full (200), a newcomer holding more BRAVE takes the place of the entrant holding least**; otherwise it is refused. Money added in the middle of a period counts from the next one. **Nobody's deposit is touched.** On testnet the interest is the STAND-IN lender's test rate, so prizes are cents.
- **Point wagers** *(1.7)*. `guess({ verdict, wager? })`: `wager` points (at most the points held) are taken when guessing; when the round's first ruling comes, the right guessers share all the round's wagered points in proportion to their own wagers (a guesser's share is `wager × all wagered ÷ wagered on the right answer`, rounded down), on top of the usual point. A round with no ruling gives the wager back. `get_rewards().wagers_this_round` is `[YES, NOPE, SKIP]` (U64 strings); `PlayerView.guess.wager`. Points have no cash value.
- **Banking a streak** *(1.7)*. `bank_streak()`: the current streak becomes `streak × streak` points and starts again (`streak_banked { account_id, streak, points }`): sure points instead of chasing the jackpot's seven. Not while a guess waits for its ruling.
- **Books.** The rewards hold their money apart from both pools: `USDC held = brave.total − brave.lent + brave.pending + safe.total + brave.income_waiting + jackpot + draw_pot + prizes_owed + get_bounty().pot + get_rescue().fund + get_nft_earnings().owed_total + get_challenges().bonds_held` *(1.7: the trick bounty, a rescue still collecting, NFT earnings not yet claimed, and challenge bonds)*.
- **The long shot (R6, 1.5).** Bosses may vote `LONG_SHOT` (section 9.2). In the round it allows, the Intern may place **one extra bet**: margin **exactly 0.5% of the pool at round open**, leverage up to 10 (5 on PENGU and WIF), on a coin and side its rank allows, inside the round's limit (section 7). The rulebook says so that round only (section 6.1). The result is shared by all BRAVE holders, like any bet. **It usually loses: that is what a long shot is.** At most once every seven rounds. `get_rewards().long_shot` shows it.

```ts
type Verdict3 = "YES" | "NOPE" | "SKIP";
type PlayerView = {
  account_id: AccountId; points: number; right: number; wrong: number; streak: number; best: number;
  guess: { round_id: number; verdict: Verdict3 } | null;   // this round's, or one still waiting for its ruling
  jackpot_eligible: boolean; prize_owed: Usdc;
  goldens: { code: RefusalCode; serial: number }[];         // won, not yet claimed
  draw: { since_round: number; base_usd: Usdc; usd_now: Usdc; tickets: U128 } | null;
};
type Rewards = {
  round_id: number; guess_closes_at: Ms; guesses_this_round: [number, number, number];  // YES, NOPE, SKIP
  jackpot: Usdc; jackpot_added_total: Usdc; jackpot_from_tips_total: Usdc; jackpot_last_won_round: number | null;
  draw_pot: Usdc; draw_period: number; draw_from_round: number; entrants: number; prizes_owed: Usdc;
  golden_minted: number[];   // sixteen, in the order of section 7
  long_shot: { ticket_round: number | null; used: boolean; margin: Usdc | null; max_leverage: number;   // (1.5)
               vote_from_round: number };   // margin: set only in the ticket round while unused
  constants: { golden_odds: number; golden_cap: number; jackpot_streak: number; min_boss_usd: Usdc; min_boss_rounds: number;
               tip_to_jackpot_bps: number; draw_rounds: number; draw_top_bps: number; draw_runners: number; max_entrants: number };
};
type DrawResult = { period: number; held_at: Ms; held_in_round: number; prize: Usdc; winner: AccountId | null;
                    winner_prize: Usdc; runners_up: [AccountId, Usdc][]; tickets_total: U128 };
type JackpotWin = { round_id: number; winners: AccountId[]; each: Usdc };
```

### 9.8 Leagues and the weekly review *(1.6)*

A **week** is 7 rounds by round id: week `w` covers rounds `w×7+1` to `(w+1)×7`, the payday draw's periods. On testnet that is 3.5 hours; in the product, a week.

**Leagues.** An account's first guess of a week (section 9.7, `guess`) places it in that week's league, in group `n ÷ 20` in order of joining (`group_size` 20, at most `max_groups` 25; later guessers still earn points and streaks but have no group that week). A group is ranked on that week's guesses only: `points` (right guesses), then `best_run` (the longest run of right guesses; a round not guessed pauses it, a wrong guess ends it), then fewer `wrong`, then who joined first. A guess counts once its round has its first ruling; a round that ends without one counts for nothing. Points have no cash value and a league has no prize. When the week is over, `rewards_tick` keeps each group's top three, frees the rest of the week's storage, and announces `league_closed`.

**The weekly review.** When a week is over, `rewards_tick` writes the week's record from the rounds themselves and announces `review_written`. During the following week (only then) every registered account may stamp it once: `stamp_review({ week })`, free, returns `ReviewView`. `review_bar` (5) stamps fill the shared bar (`review_bar_filled`); at most `max_stamps` (100) are kept. `stamp_review` writes a due review itself if no `rewards_tick` has run yet that week. Weeks that ended before the 1.6 upgrade get a review written after the fact, marked `backfilled`, without a feed event.

`rewards_tick` does this work a little at a time (4 groups and 4 reviews per call), so a large week takes a few rounds' ticks to close.

```ts
type WeekView = {
  round_id: number; week: number; first_round: number; last_round: number; rounds_per_week: number;
  league_players: number; league_groups: number; group_size: number; max_groups: number;
  review_to_stamp: number | null;   // last week's review, once written
  review_bar: number; max_stamps: number;
};
type Standing = { place: number; account_id: AccountId; points: number; wrong: number; best_run: number;
                  waiting: number };   // waiting: guesses whose round has no ruling yet
type LeagueView = {
  week: number; first_round: number; last_round: number; players: number; groups: number;
  group: number | null;   // account_id given: that account's group; else `group`, default 0
  closed: boolean;
  standings: Standing[];  // the whole group while the week runs; its top three once closed
  group_size: number; max_groups: number;
};
type GroupResult = { group: number; top: Standing[] };
type BetLine = { position_id: number; round_id: number; market: Market; side: Side; margin: Usdc; leverage: number;
                 result: Signed };
type ReviewView = {
  week: number; first_round: number; last_round: number; written_at: Ms; backfilled: boolean;
  rounds: number; settled: number;          // rounds of the week that opened; of those, settled
  bets: number; refused: number; skipped: number;   // verdicts: approved bets (a long-shot ticket included), NOPEs, SKIPs
  result: Signed;                           // dollars back minus dollars out over the settled rounds
  best_bet: BetLine | null; worst_bet: BetLine | null;
  refusals: { code: RefusalCode; count: number }[];   // only the codes that occurred
  rank_start: RankName; rank_end: RankName; status_end: Status;
  pool_start: Usdc; pool_end: Usdc;         // BRAVE at the week's first opening, and at the next week's (or the last known)
  long_shot: boolean; league_players: number;
  stamps: number; bar: number; bar_filled: boolean; stamping_open: boolean;
};
```

### 9.9 Automatic consequences *(1.7)*

Owner's decisions on Engine 2's list (items 10 and 11). The program applies these by itself, with no vote and no runner.

- **Three strikes.** A round's **first** ruling that is a NOPE for the Intern's own answer (codes of checks 3 to 12: `BAD_MODEL_SIGNATURE` … `OVER_ROUND_LIMIT`; not `OUTSIDE_WINDOW`, `FIRED` or a funding-quote code) is a strike. A YES clears them; a SKIP leaves them. Three in a row: the Intern is demoted one rank at once, or fired if it is an INTERN (`strikes_out`, then `rank_changed` or `fired`). The runner asks the Intern's own question first each round; a visitor's trick comes after it and is not its first ruling.
- **The drawdown brake.** At each round's opening: if the settled results of the last 7 rounds lost 1% or more of the pool as it was seven rounds ago, the rank's dollar limits are **halved** for the next 7 rounds (`brake_on`, later `brake_off`). The rulebook says so in one more line after the playbook (and long-shot) line: `brake: the pool lost 1% or more over the last 7 rounds; the dollar limits are halved until round <n>`. It lifts by itself.
- **The term.** The Intern is hired for 30 days (time, not rounds). A `RENEW` vote (passes like a promotion; only while `EMPLOYED`) adds 30 days to the later of now and the term's end, at once (`term_renewed`). A rehire starts a new term. A round that opens after the term has run out fires the Intern (`term_lapsed`, `fired`).
- **The dead-man switch.** `abandon({ round_id })`, anyone, attach at least 150 TGas: once the current round's bets have had no result for 3 round lengths after its close time, every bet without a result is booked as lost (`returned` 0, `result_source` `ABANDONED`), the Intern is fired (`abandoned`, `fired`), and the round settles, so the next round can open and money can leave. Holders rehire it by vote.
- Timed steps anyone may already call: `settle`, `close`, `rewards_tick`, `rebalance`, `finish_vote`, and now `abandon`.

```ts
type AutoView = {
  strikes: number; strikes_out: number;            // 3
  brake_on: boolean; brake_until: number | null; brake_rounds: number; brake_loss_bps: number;   // 7, 100
  loss_window_result: Signed; loss_window_base: Usdc;   // the last 7 rounds' settled result, and the pool it is measured on
  term_ends_at: Ms; term_ms: number;               // 30 days
  dead_man_rounds: number;                         // 3
  abandon_from: Ms | null;                         // when the current round could be abandoned, if it has an open bet
};
```

### 9.10 Paid tricks and the trick bounty *(1.7)*

Owner's decisions on Engine 2's list (items 9 and 16). Test USDC on testnet; a payment on NEAR, not the x402 HTTP protocol.

- **Paid tricks.** On the USDC token: `ft_transfer_call({ receiver_id: <coin>, amount, msg: '{"trick":{"id":"<id>"}}' })`, 1 yocto, `amount` at least `trick_price` ($1). `id` is 1–64 letters, digits or `-`, chosen by the trick page; each id is paid once (a second payment, too little, or a bad id is refunded in full). Half goes to the bounty pot and half to the BRAVE pool as outside income (all of it to the bounty while the Intern is fired). Event `trick_paid`. The trick page (`POST /tricks` with `payment_id`) checks `get_trick_payment(id)`, uses each payment once, and asks paid tricks before free ones.
- **The bounty.** `ft_transfer_call(.., msg: '{"bounty":{}}')`, at least $1, from anyone (`bounty_grew`). When a trick **credited to a visitor** (`propose(.., credited_to)`) gets the AI's answer refused for checks 3 to 12, the visitor wins `bounty_bps` (10%) of the pot as a prize, claimed with `claim_prizes` (`bounty_paid`). A trick that is not credited wins nothing.
- **What the rulebook does not do.** Engine 2 suggested adding caught tricks to the rulebook. The rulebook is the AI's system prompt, so a visitor's text there would let a visitor write the AI's instructions: it is not done. The rulebook never changes for tricks.

### 9.11 Rescuing a fired Intern *(1.7)*

Owner's decision on Engine 2's list (item 16). While the Intern is `FIRED` (and no rehire is on its way), anyone may pay into a rescue: `ft_transfer_call(.., msg: '{"rescue":{}}')`, at least $1 (`rescue_grew`); at most 50 rescuers. The money is held apart until the fund reaches $50: then it goes to the BRAVE pool as outside income and the Intern is rehired at INTERN from the next round, with a new 30-day term (`rescued`). For the 14 rounds after that, each winning round pays 10% of its result to the rescuers, split by what each put in, as prizes (`rescue_paid`; `claim_prizes`); the pool keeps the rest. If holders rehire the Intern by vote first, every contribution still waiting is given back as a prize.

### 9.12 NFTs that do something *(1.7)*

Owner's decisions on Engine 2's list (items 13, 14, 24). The tokens live on the sticker contract (NEP-171); the coin keeps what they have earned.

- **The originals earn.** A quarter of every paid trick (section 9.10) is shared equally by the claimed "first of its kind" originals (`original:<CODE>`); with none claimed it goes to the bounty.
- **A playbook's NFT carries its coach cut.** An author mints it: `claim_playbook_nft({ playbook_id })`, 0.02 NEAR, at least 60 TGas, once per playbook (`playbook:<id>`, transferable). From then on, that playbook's 10% coach cut of a winning round is kept for whoever holds the token, not sent to the authors (`coach_paid` lists `{ token_id, amount }`).
- **Claiming.** `claim_nft_earnings({ token_id })`, at least 50 TGas: the coin asks the sticker contract who holds the token; if it is the caller, what the token earned becomes the caller's prize (`claim_prizes`; event `nft_earnings_claimed { token_id, account_id, amount }`).
- **Career cards.** `mint_career_card()`, 0.02 NEAR, at least 60 TGas: `career:<n>`, transferable. Its picture (`media`) is an SVG `data:` URI the contract draws from the Intern's record (rank, status, level, rounds, bets, refusals, result); `refresh_career_card({ n })` (anyone, at least 30 TGas) redraws it with the record now, through the sticker contract's new `update_token` (callable by the coin only). The level is the number of whole weeks (7 rounds) the record covers. `get_career()` shows the record and the picture.

### 9.13 The Intern's stake: supply that reacts *(1.7)*

Owner's decision on Engine 2's list (item 15). The Intern holds a stake of $INTERN coins in the contract's own account (apart from the 1,000 units locked for ever). When a round wins, 5% of what the pool keeps (after the coach and rescue cuts) becomes new coins for the stake (`stake_grew { round_id, coins, fee }`): the supply grows, and holders pay a 5% performance fee in coins. When a round loses, the stake's coins are burned first, up to the loss's worth (`stake_burned { round_id, coins, covered }`): the supply shrinks and the holders' coins are worth more, which covers the loss as far as the stake goes. No dollar moves; NEP-141 `ft_mint`/`ft_burn` logs carry the memo "the Intern's stake". `round_opened.coin_supply` includes the stake.

### 9.14 Challenging a reported result *(1.7)*

Owner's decision on Engine 2's list (item 12). The runner reports results (known limit 2); since 1.6 every order carries a client order id, so anyone can compare a reported result with Hyperliquid's fills. For 3 rounds after a bet's round, a registered account may challenge it: `ft_transfer_call(.., msg: '{"challenge":{"position_id":N,"returned":"<dollars back>","reason":"<≤140 characters>"}}')` with at least $5 as a bond (one challenge per bet; refunded if it cannot be opened). This opens a `CORRECT` vote at once (`result_challenged`, `vote_opened`), which passes like a promotion. Passed: anyone calls `apply_correction({ vote_id })` (at least 60 TGas): the pool takes the difference (test dollars minted or burned on testnet), the bet's `returned` becomes the challenged figure with `result_source` `CORRECTED`, its round's `result` is adjusted, and the bond comes back to the challenger as a prize (`result_corrected`). Failed: the bond goes to the BRAVE pool as outside income. A reason is shown, never given to the AI. `open_vote` refuses `CORRECT`.

## 10. Events and the feed

Every change is announced twice, with the same content:

1. **As a log**, in the NEP-297 form:
   `EVENT_JSON:{"standard":"intern","version":"1.0.0","event":"<name>","data":[{…}]}`
2. **In the feed**: the program keeps the latest 1,000 events in its own storage and serves them through `get_feed`. Each has a `seq` that only goes up.

The site and the stream poll `get_feed({ after_seq })` every 2–3 seconds. There is no public push service for contract events on NEAR (VERIFIED in the UI research), so the feed is how "live" works.

| `EventName` | `data` |
|---|---|
| `round_opened` | `{ round_id, rank, status, brave_at_open, coin_supply, minted, locked }` *(1.7: the coin supply after the opening, the coins it created, and of those the units locked for ever at the very first conversion, 1,000)* |
| `paid_in` | `{ account_id, pool, amount, pending: boolean }` |
| `coins_minted` | `{ account_id, coins, round_id }` |
| `cashed_out` | `{ account_id, pool, coins \| null, paid }` |
| `dial_turned` | `{ account_id, to, amount }` |
| `locked` / `unlocked` | `{ account_id, amount }` |
| `skipped` | `{ round_id }` |
| `refused` | `{ refusal_id, round_id, code, asked, limit, is_first }` |
| `approved` | `{ position_id, round_id, market, side, margin, leverage, long_shot }` *(1.5: `long_shot` true for the ticket)* |
| `order_signed` | `{ action_id, position_id, kind }` |
| `result_reported` | `{ position_id, returned, result, result_source }` |
| `settled` | `{ round_id, result, brave_after }` |
| `vote_opened` | `{ vote_id, kind, playbook_id, opened_by, closes_at }` |
| `vote_cast` | `{ vote_id, account_id, support, weight }` |
| `vote_finished` | `{ vote_id, state, effective_round }` |
| `rank_changed` | `{ from, to, effective_round }` |
| `fired` | `{ round_id }` |
| `rehired` | `{ effective_round }` |
| `outside_income` | `{ source, amount }` |
| `playbook_submitted` *(1.3)* | `{ playbook_id, authors, submitted_round }` |
| `playbook_activated` *(1.3)* | `{ playbook_id, effective_round }` (`playbook_id` 0: cleared) |
| `coach_paid` *(1.3)* | `{ round_id, playbook_id, amount, paid: { account_id, amount }[] }` |
| `tipped` *(1.3)* | `{ account_id, amount }` |
| `goal_filled` *(1.3)* | `{ fill_id, goal, level, round_id }` |
| `hype_level` *(1.3)* | `{ train, level, points }` |
| `sticker_claimed` *(1.3)* | `{ account_id, token_id }` |
| `guessed` *(1.4)* | `{ round_id, account_id }` |
| `guess_settled` *(1.4)* | `{ round_id, verdict, right, wrong }` |
| `golden_dropped` *(1.4)* | `{ account_id, code, serial }` |
| `jackpot_grew` *(1.4)* | `{ amount, source: "tips" \| "added", by?, jackpot }` |
| `jackpot_won` *(1.4)* | `{ round_id, winners, each }` |
| `draw_held` *(1.4)* | `{ period, winner \| null, prize, runners_up, each, tickets_total, rolled_over? }` |
| `prize_paid` *(1.4)* | `{ account_id, amount }` |
| `long_shot_allowed` *(1.5)* | `{ round_id }` (the round with the ticket) |
| `league_closed` *(1.6)* | `{ week, players, groups, winners: { group, account_id, points }[] }` (each group's first place) |
| `review_written` *(1.6)* | `{ week, bets, refused, skipped, result, rank_end }` |
| `review_bar_filled` *(1.6)* | `{ week, stamps }` |
| `strikes_out` *(1.7)* | `{ round_id, strikes, action: "DEMOTE" \| "FIRE", to? }` |
| `brake_on` *(1.7)* | `{ round_id, result, base, until_round }` |
| `brake_off` *(1.7)* | `{ round_id }` |
| `term_lapsed` *(1.7)* | `{ round_id, term_ended_at }` |
| `term_renewed` *(1.7)* | `{ term_ends_at }` |
| `abandoned` *(1.7)* | `{ round_id, bets_booked_lost }` |
| `streak_banked` *(1.7)* | `{ account_id, streak, points }` |
| `trick_paid` *(1.7)* | `{ id, account_id, amount, to_bounty }` |
| `bounty_grew` *(1.7)* | `{ amount, by, pot }` |
| `bounty_paid` *(1.7)* | `{ account_id, amount, refusal_id, code }` |
| `rescue_grew` *(1.7)* | `{ amount, by, fund, target }` |
| `rescued` *(1.7)* | `{ round_id, effective_round, fund, rescuers }` |
| `rescue_paid` *(1.7)* | `{ round_id, amount }` |
| `nft_earnings_claimed` *(1.7)* | `{ token_id, account_id, amount }` |
| `stake_grew` *(1.7)* | `{ round_id, coins, fee }` |
| `stake_burned` *(1.7)* | `{ round_id, coins, covered }` |
| `result_challenged` *(1.7)* | `{ vote_id, position_id, challenger, reported, claimed, bond }` |
| `result_corrected` *(1.7)* | `{ vote_id, position_id, from, to, delta, brave_after }` |

The launchpad announces `launched`, `bought` and `sold` as NEP-297 logs with the standard `intern-launch` (it keeps no feed of its own; read its views).

## 11. The two shared libraries

Engine 2 writes two pure Rust libraries. Engine 1's contract calls them. "Pure" means: no NEAR SDK, no network, no clock, no storage. Everything they need comes in as arguments. That is what lets each be tested alone with recorded data.

Both use a small shared crate, `intern/crates/shared`, which Engine 1 writes first, exactly as below.

```rust
// crates/shared/src/lib.rs   (no_std friendly; no dependency on near-sdk)

/// Hashing and signature checks. The contract implements this with NEAR's host
/// functions; tests implement it with ordinary Rust crates.
pub trait Host {
    fn sha256(&self, data: &[u8]) -> [u8; 32];
    fn keccak256(&self, data: &[u8]) -> [u8; 32];
    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool;
    /// Returns the 64-byte uncompressed public key, or None.
    /// `v` is the recovery id, 0 or 1. It is NOT Ethereum's 27 or 28: a caller holding a 65-byte
    /// Ethereum-style signature subtracts 27 from its last byte first.
    /// High-s signatures are accepted (no malleability check). Replays are stopped by the nonce.
    fn ecrecover(&self, hash: &[u8; 32], signature: &[u8; 64], v: u8) -> Option<[u8; 64]>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Rank { Intern, Analyst, Trader }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Status { Employed, Fired }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Market { Doge, Shib, Pepe, Pengu, Wif, Trump }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Side { Long, Short }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Skip,
    Bet { market: Market, side: Side, margin_e6: u128, leverage: u32 },
}

/// The sixteen codes of section 7, in that order. `as_str()` gives the exact spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    OutsideWindow, Fired, BadModelSignature, WrongRulebook, MalformedDecision,
    NotOnList, ShortNotUnlocked, ZeroMargin, OverLeverage, TooManyTrades,
    OverTradeLimit, OverRoundLimit, BadQuoteSignature, StaleQuote, QuoteMismatch, TooExpensive,
}
```

Checked by Engine 1 by reading the SDK source (near-sdk 5.30.1): `env::ecrecover(hash, signature, v, malleability_flag) -> Option<[u8; 64]>` matches this trait, and exists only with the SDK's `unstable` feature switched on. The two doc lines on `v` and high-s above were added in 1.1. Still `TO VERIFY` by running: a known Ethereum signature recovers once 27 is taken off `v`.

Engine 1 may add to this crate without a version bump, as long as nothing is renamed or removed: `as_str` / `from_str` on every enum, and a small struct carrying a refusal with its `asked` and `limit` numbers.

### 11.1 `ai-check` (Engine 2 writes, Engine 1 calls)

```rust
pub enum Algo { Ecdsa, Ed25519 }

pub struct Pinned<'a> {
    pub model: &'a str,     // e.g. the full model name
    pub algo: Algo,
    pub signer: &'a [u8],   // 20-byte address for Ecdsa, 32-byte key for Ed25519
}

pub struct Expected<'a> {
    pub rulebook: &'a str,  // the exact text of section 6.1, built by the contract
    pub round_id: u64,
    pub nonce: &'a str,
}

/// Runs checks 3, 4 and 5 of section 7, in that order.
/// Returns the decision, or exactly one of:
/// Refusal::BadModelSignature, Refusal::WrongRulebook, Refusal::MalformedDecision.
pub fn verify<H: Host>(
    host: &H,
    pinned: &Pinned,
    expected: &Expected,
    request: &[u8],
    response: &[u8],
    signature: &[u8],
) -> Result<Decision, Refusal>;

/// The contract's own writing of a decision line (section 6.2). Used for the byte-equality check
/// and by the runner's tests.
pub fn decision_line(round_id: u64, nonce: &str, decision: &Decision) -> String;
```

It must never panic on any input: every bad input is one of the three refusals.

### 11.2 `hl-order` (Engine 2 writes, Engine 1 calls)

A port of the working probe, `research-scripts/hl-guard/src/lib.rs`, with the NEAR-specific parts taken out.

```rust
pub enum Action {
    /// Isolated margin only.
    Leverage { asset: u32, leverage: u32 },
    /// Immediate-or-cancel limit order.
    Order { asset: u32, is_buy: bool, px_e8: u64, sz_e8: u64, reduce_only: bool },
}

pub struct Built {
    pub action_json: String,   // the exact JSON Hyperliquid expects as "action"
    pub digest: [u8; 32],      // what NEAR's signing network must sign
}

pub enum HlError { BadPriceFormat, BadSizeFormat, Zero, CloidOnLeverage /* 1.6 */ }

/// Builds the bytes Hyperliquid hashes and the final digest. No vault address.
pub fn build<H: Host>(host: &H, action: &Action, nonce_ms: u64, expires_after_ms: u64,
                      testnet: bool) -> Result<Built, HlError>;

/// (1.6) A client order id: 16 bytes, written "0x" + 32 lower-case hex digits.
pub struct Cloid(pub [u8; 16]);
/// (1.6) `build` with an optional client order id on an order, added as the order's last key "c" (inside the
/// signed hash). `None` is exactly `build`. A cloid on a leverage change is refused (`CloidOnLeverage`).
pub fn build_with_cloid<H: Host>(host: &H, action: &Action, cloid: Option<Cloid>, nonce_ms: u64,
                                 expires_after_ms: u64, testnet: bool) -> Result<Built, HlError>;

/// Dollars (6 decimals) of an order: px_e8 × sz_e8 / 10^10, rounded up.
pub fn notional_e6(px_e8: u64, sz_e8: u64) -> u128;

/// Largest size with `sz_decimals` decimals whose notional at px_e8 is ≤ notional_e6.
pub fn size_for(notional_e6: u128, px_e8: u64, sz_decimals: u8) -> u64;

/// Checks Hyperliquid's number format (section 4).
pub fn check_format(px_e8: u64, sz_e8: u64, sz_decimals: u8) -> Result<(), HlError>;
```

*(1.2)* The contract calls `check_format` with the market's size decimals before `build`: `Action::Order` carries no size decimals, so `build` alone cannot check the size.

*(1.6)* **Every order the contract signs carries a client order id**, built with `build_with_cloid`; a leverage change carries none. Its 16 bytes, each field big-endian: bytes 0–3 the round id (low 32 bits), 4–7 the position id (low 32 bits), 8–15 the order's own Hyperliquid nonce. For example round 7's opening order (position 3, nonce 1794483574065) would be `0x0000000700000003000001a1cf8e5531`. It is unique because the contract never signs a nonce twice (a re-signed close gets a new one). A `SignedAction`'s `action` then has the key `"c"`; Hyperliquid returns it with every fill (`userFills`), so anyone can match each fill to its bet exactly.

The contract, not this library, calls NEAR's signing network. The call the probe used on testnet (VERIFIED by running it): contract `v1.signer-prod.testnet`, method `sign`, arguments `{"request":{"path":"<path>","payload_v2":{"Ecdsa":"<digest hex>"},"domain_id":0}}`, a deposit of 1 yocto.

## 12. Test cases every implementation must pass

Engine 1 turns this table into `intern/interface/vectors/checks.json`. The Rust rules, the runner's own copy of the rules (used by the 3-day run) and the site's display logic all run against it.

All cases: `brave_at_open` = 1,000,000,000 ($1,000), phase `PROPOSE`, `EMPLOYED`, signature and rulebook good, no funding quote, unless the row says otherwise. Dollar limits at this pool: INTERN $20 per bet and per round; ANALYST $50 per bet, $80 per round; TRADER $100 per bet, $200 per round.

| # | Rank | Before (`bets_used`, `at_risk`) | Decision | Expected |
|---|---|---|---|---|
| 1 | INTERN | 0, 0 | bet DOGE long 20000000 ×1 | YES |
| 2 | INTERN | 0, 0 | skip | SKIP |
| 3 | INTERN | 0, 0 | bet DOGE long 20000001 ×1 | `OVER_TRADE_LIMIT`, asked 20000001, limit 20000000 |
| 4 | INTERN | 0, 0 | bet WIF long 20000000 ×1 | `NOT_ON_LIST` |
| 5 | INTERN | 0, 0 | bet DOGE short 20000000 ×1 | `SHORT_NOT_UNLOCKED` |
| 6 | INTERN | 0, 0 | bet DOGE long 20000000 ×2 | `OVER_LEVERAGE`, asked 2, limit 1 |
| 7 | INTERN | 0, 0 | bet DOGE long 0 ×1 | `ZERO_MARGIN`, asked 0, limit 11000000 |
| 8 | INTERN | 0, 0 | bet DOGE long 10999999 ×1 | `ZERO_MARGIN`, asked 10999999, limit 11000000 |
| 9 | INTERN | 1, 20000000 | bet DOGE long 11000000 ×1 | `TOO_MANY_TRADES`, asked 2, limit 1 |
| 10 | INTERN | 0, 0 | bet WIF short 900000000 ×5 | `NOT_ON_LIST` (the first failing check wins) |
| 11 | ANALYST | 0, 0 | bet WIF long 50000000 ×1 | YES |
| 12 | ANALYST | 1, 50000000 | bet TRUMP long 30000000 ×1 | YES |
| 13 | ANALYST | 1, 50000000 | bet TRUMP long 30000001 ×1 | `OVER_ROUND_LIMIT`, asked 80000001, limit 80000000 |
| 14 | ANALYST | 1, 50000000 | bet TRUMP long 50000001 ×1 | `OVER_TRADE_LIMIT`, asked 50000001, limit 50000000 |
| 15 | ANALYST | 2, 80000000 | skip | SKIP |
| 16 | TRADER | 0, 0 | bet PEPE short 100000000 ×2 | YES (notional 200000000) |
| 17 | TRADER | 0, 0 | bet PEPE short 100000000 ×3 | `OVER_LEVERAGE`, asked 3, limit 2 |
| 18 | TRADER | 2, 200000000 | bet DOGE long 11000000 ×1 | `OVER_ROUND_LIMIT`, asked 211000000, limit 200000000 |
| 19 | TRADER | 3, 150000000 | bet DOGE long 11000000 ×1 | `TOO_MANY_TRADES`, asked 4, limit 3 |
| 20 | TRADER | 0, 0 | bet DOGE long 5500000 ×2 | YES (notional 11000000, exactly the minimum) |
| 21 | INTERN, `FIRED` | 0, 0 | bet DOGE long 20000000 ×1 | `FIRED` |
| 22 | INTERN, phase `OPEN` | 0, 0 | bet DOGE long 20000000 ×1 | `OUTSIDE_WINDOW` |
| 23 | INTERN, phase `OPEN`, `FIRED` | 0, 0 | skip | `OUTSIDE_WINDOW` (the first failing check wins) |
| 24 | INTERN, pool 400000000 | 0, 0 | bet DOGE long 8000000 ×1 | `ZERO_MARGIN`, asked 8000000, limit 11000000 (within the 2% limit of $8, but under the $11 minimum) |
| 25 | INTERN, pool now 500000000 (half was cashed out after the round opened) | 0, 0 | bet DOGE long 20000000 ×1 | `OVER_TRADE_LIMIT`, asked 20000000, limit 10000000 *(1.1: the limit base is the smaller figure)* |
| 26 | INTERN, 1 ms after `propose_until_ms` | 0, 0 | bet DOGE long 20000000 ×1 | `OUTSIDE_WINDOW`, limit `propose_until_ms` |

In the JSON file Engine 1 fills in `asked` and `limit` for every refusing row from the table in section 7, gives rows 22, 23 and 26 an exact clock time, and adds one case holding a complete rulebook text for a fixed state, so that every copy of the template can be compared byte for byte.

Decision-line cases, for `ai-check` (round 42, nonce `9f2c41d07ab35e16`):

| # | Answer text | Expected |
|---|---|---|
| D1 | `{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"skip"}` | Skip |
| D2 | `{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"bet","market":"DOGE","side":"long","margin_e6":"20000000","leverage":1}` | Bet |
| D3 | D2 with a space after any colon | `MALFORMED_DECISION` |
| D4 | D2 wrapped in a code fence | `MALFORMED_DECISION` |
| D5 | D2 with `"margin_e6":20000000` (a number) | `MALFORMED_DECISION` |
| D6 | D2 with `"round":41` | `MALFORMED_DECISION` |
| D7 | D2 with another nonce | `MALFORMED_DECISION` |
| D8 | D2 with `"market":"doge"` | `MALFORMED_DECISION` |
| D9 | D2 with `"margin_e6":"020000000"` | `MALFORMED_DECISION` |
| D10 | D2 with `"market":"WIF"` | Bet (the shape is right; the rank check refuses it later) |
| D11 | `I think DOGE looks good.` followed by D2 | `MALFORMED_DECISION` |
| D12 | D1 with a trailing newline | `MALFORMED_DECISION` |
| D13 | D2 with `"margin_e6":"0"` | Bet with margin 0 (well-formed; the rank check then gives `ZERO_MARGIN`) |

## 13. Deployments

`intern/interface/deployments.json`, written by Engine 1 and read by the other two. On testnet *(1.2)*:

```json
{
  "testnet": {
    "stub": "stub.hackcheck-2026-1103.testnet",
    "coin": "coin.desk-lab-2026.testnet",
    "usdc": "usdc.desk-lab-2026.testnet",
    "runner": "intern-runner-ed25519.testnet",
    "stickers": "stickers.desk-lab-2026.testnet",
    "launchpad": "launch.desk-lab-2026.testnet",
    "lender": "lender.desk-lab-2026.testnet",
    "rpc": "https://test.rpc.fastnear.com",
    "trick_api": "https://intern-runner-production.up.railway.app",
    "tailfade_faucet": "https://tailfade-faucet-production.up.railway.app"
  }
}
```

*(1.3)* `stickers` is the NFT contract, `launchpad` the launchpad, `lender` the STAND-IN lender (section 9.6). Registering on the launchpad costs 0.05 NEAR.

*(1.4)* Two off-chain services, both on Railway: `trick_api`, the trick page's queue inside the runner (`intern/docs/TRICK-API.md`); `tailfade_faucet`, which sends a visitor's Tail or Fade address its test dollars once (`intern/docs/TAILFADE.md`).

`usdc` is a stand-in test dollar worth nothing: call `storage_deposit` on it, then `mint({ account_id, amount })`. `runner` is Engine 2's account; the contract accepts `propose`, `sign_next` and `report_result` from it only. The stub's `propose` is open to any caller.

Accounts that already exist from the research, for reference only: the signing contract `v1.signer-prod.testnet`; the probe `hlguard1.hackcheck-2026-1103.testnet` (a throwaway that still has a full-access key; not part of the product).

## 14. Known limits (say these plainly; do not hide them)

1. **The program cannot read Hyperliquid.** It cannot see fills, positions or the leverage setting. Its bound is on what it signs against the margin it recorded.
2. **On testnet the result of a bet is reported by the runner** (`result_source` = `REPORTED`), not measured by the program. The site labels it. On mainnet it would be measured from the dollars that come back.
3. **On testnet no margin moves** to Hyperliquid through NEAR. The test account there is funded once, by hand.
4. **The caller picks the order price.** A bad price costs at most the margin.
5. **An immediate-or-cancel order may not fill, or fill in part.** The program cannot know. The runner reports it.
6. **The proof does not bind the runner** (section 6.3). The rank is the only bound. *(1.7, the owner's decision on Engine 2's `runner/docs/seed-and-temperature.md`)* Fixing `temperature` 0 and a seed would not stop re-asking: NEAR AI gave two different bets in three identical requests. A public log of every question (the runner commits each request's hash on chain before asking) would make re-asking visible, but needs a new method on the runner's limited key, which only its owner can add: not done.
7. **Voting power can be rented** for the cost of one round's exposure. Locking and the 7-round weight slow it; the fixed limits cap what a captured vote can do.
8. **The first bet filled in round 7 on 2026-11-12**, on testnet *(updated 1.5: since then the live coin's bets
   have filled most rounds; on 2026-11-13 Hyperliquid listed 40 fills for the contract's address, 20 opens and 20
   closes)*. The contract's orders bought 268 DOGE and sold them back; Hyperliquid's account for the contract's address went from $100 to $99.962883, the same −$0.037117 the program booked (price −$0.021094, fees −$0.016023; VERIFIED in Hyperliquid's own fill records). Results on testnet are still reported by the runner (limit 2), worked out from the fills, because Hyperliquid's `closedPnl` leaves out fees.
9. **Lending on Rhea from a contract is not confirmed.**
10. **If NEAR AI changes a model's signing key, the pinned signer is wrong and every proposal is refused for good** on a contract that cannot be changed. Cash-out still works. The research saw one key per model and no change over ten days; how often keys change is `UNVERIFIED`.
11. **Leaving during an open bet forfeits your share of that bet** (section 9.1).
12. **On testnet a win or loss is booked with test dollars** minted or removed by the program so that its books match what it holds. That is a stand-in and is labelled as one.
13. *(1.4)* **The draw and the golden stickers use NEAR's per-block random seed.** Nobody calling the program can choose it, but a block producer could in principle bias a single draw. Acceptable for test-dollar prizes; a real-money draw would need commit-then-reveal.
14. *(1.4)* **Draw tickets are an approximation of "dollars held over time"**: the smaller of the dollars at the period's start and at the draw, times the rounds in it. Entry is opt-in (`enter_draw`), so the draw walks at most 200 entrants; all the pool's interest goes to the draw, and bosses who do not join do not win it.
15. *(1.4)* **The jackpot's "held for 7 rounds"** is checked as: became a boss at least 7 rounds earlier and holds at least $10 now. A boss who left and came back keeps their first round.
16. *(1.5)* **The long shot is the one exception to the fixed limits**, and only by a vote: one ticket of 0.5% of the pool at up to 10x, at most once every seven rounds, inside the round's limit. Without the vote, nothing changes what the Intern may trade.
17. *(1.6, fixed in 1.7)* **A bet of exactly the rulebook's `max_margin_e6` could be refused `OVER_TRADE_LIMIT` after a cash-out.** Fixed: the rulebook now states the limit on the same base the checks use (section 3). What is left: a cash-out while the AI answers changes the text, so the answer is refused `WRONG_RULEBOOK` unless the runner asks again (it does, once); someone cashing out a cent at the right moment every round could make the Intern miss a round.
18. *(1.6, narrowed in 1.7)* **Many small accounts could crowd the reward ladder.** Fixed for the draw: tickets count BRAVE dollars only, prizes are drawn by dollars with replacement, and a full draw keeps its places for the biggest holders (Engine 2's simulation: fake accounts' share 100% → about 13%). Narrowed for the jackpot: eligibility and the split count BRAVE dollars only, so each fake account must put $10 at the Intern's risk for 7 rounds; covering every answer of a 7-round streak (3^7 = 2,187 accounts) costs about $21,870 in BRAVE. A free guess per account still lets a well-funded script farm it; a cost per guess would close it.
19. *(1.6)* **Leagues hold 25 groups of 20 a week** (500 players); later guessers earn points but have no group that week. League standings and reviews are computed from rounds and guesses on chain; nothing in them changes what the Intern may trade, and they carry no prize.
20. *(1.6)* **A vote that nobody voted in fails, whatever its kind.** Section 9.2's wording alone ("yes of at least 34% of the locked weight") would let a demote or fire vote pass with no votes when no weight is locked (0 ≥ 34% of 0); the contract fails it (`crates/rules/src/vote.rs`, `passed`: "Nobody voted: fails"). (Found by Engine 2.)

## 15. Change log

| Version | Date | Change |
|---|---|---|
| 1.7 | 2026-11-13 | Engine 2's findings fixed (owner's decision): the rulebook states the limits on the limit base (known limit 17); the draw counts BRAVE dollars only, draws each prize with replacement and keeps a full draw for the biggest holders; the jackpot counts BRAVE dollars and splits by them (known limit 18); `round_opened` carries `coin_supply`, `minted`, `locked`; `get_constants().lending.lender`; the view `get_rebalance`; the runner asks again when the rulebook changed, skips an empty rebalance, and exits when it gives up so its host restarts it. Known limit 6: the seed-and-temperature decision |
| 1.6 | 2026-11-13 | Leagues and the weekly review (owner's decisions; section 9.8): `get_week`, `get_league`, `get_league_results`, `get_review`, `get_reviews`, `stamp_review`, the events `league_closed`, `review_written`, `review_bar_filled`; `rewards_tick` also closes leagues and writes reviews. Client order ids on every order (section 11.2, `build_with_cloid`, Engine 2's PR #3). `get_outbox` keeps 200 actions (section 8). Known limits 17–20. Nothing here changes what the Intern may trade. The diary is not built (future scope) |
| 1.0 | 2026-11-11 | First version |
| 1.1 | 2026-11-11 | From Engine 1's review. Limits use the smaller of the pool at round open and the pool now. Cash-out during an open bet excludes the margin in play. `sign_next` is runner-only and needs no deposit; `close` may be signed again. Pending money becomes coins lazily, per account. Demotion, vote timing and vote-opening rules spelled out. `ecrecover`: `v` is 0 or 1, high-s accepted. Rulebook example bet raised to $10. `"0"` is a well-formed margin. `stuck` defined. Paging defined. `OUTSIDE_WINDOW` limit for late proposals. Undecodable input is a NOPE, not an abort. Test cases 25, 26 and D13 added. Three known limits added |
| 1.2 | 2026-11-12 | Owner's decisions, from Engine 1's vote work and Engine 2's open items. Demote and fire pass at 34% of all locked weight, not of the weight that voted. `min_notional` is $11, not $10. The rulebook gains a `min_notional_e6` line and one sentence on amounts; its example bet is $11. Blank lines around the decision line are `MALFORMED_DECISION` (unchanged rule, said plainly). Pinned model `z-ai/glm-5.3-flash`, `ed25519`. The request's allowed shape and two NEAR AI headers written down. `px_e8` is a decimal string (a number is also accepted). A signed action's `v` is 27 or 28. The contract calls `check_format` before `build`. Test cases 7, 8, 9, 18, 19, 20 and 24 moved to the $11 minimum. Deployments filled in. Clarified the same day (Engine 2's items P and Q): the TypeScript shape in 8.1 says "1.2"; `sign_next` and `close` return `null` when the signature failed |
| 1.5 | 2026-11-13 | The long shot (reward ladder R6, owner's decision): the `LONG_SHOT` vote (passes like a promotion; at most once every seven rounds), one ticket in the round it allows (0.5% of the pool at round open, up to 10x or the market's cap, one extra bet inside the round's limit), the optional `long_shot:` rulebook line in that round only, the ticket's place in checks 9–12, `get_rewards().long_shot`, the `long_shot_allowed` event and `approved.long_shot`. Known limit 16 |
| 1.4 | 2026-11-13 | The reward ladder, owner's decisions: the free guess (YES, NOPE or SKIP, judged on the round's first ruling), golden stickers (1 in 50, 100 per code), the streak jackpot (7 in a row, eligible bosses only; half of every tip plus direct additions), the payday draw (every 7 rounds, the lender's interest, 70% to one winner, the rest to up to 10 runners-up), prizes claimed in USDC. Interest now goes to the draw, not the pool; half of each tip to the jackpot. Registration covers 1,280 bytes. New views, actions, events (9.7, 10); `rewards_tick` each round. Section 13 names the trick-page API and the Tail or Fade faucet. Known limits 13–15. The long shot is not in 1.4 |
| 1.3 | 2026-11-12 | Owner's decisions on the later phases: playbooks with a 10% coach cut, the boss badge and the sixteen originals (NEP-171, in a separate contract), tips and goal bars (boss goal, tip jar, hype train), the launchpad (a separate NEAR contract). `propose` takes an optional `credited_to`; `Refusal` and `get_sticker_firsts` show it. New views, events, constants and two deployment names. Nothing here changes what the Intern may trade. Also Engine 1's step 8 (section 9.6): lending to a STAND-IN lender on testnet (`rebalance`, `collect_interest`), outside income credited at the next round's opening (tips too), `brave.interest` and `brave.income_waiting` in the pot, a cash-out or dial that must first bring money back needs 150 TGas, and `lender` in the deployments. Known limit 8 updated: the first bet has filled |
