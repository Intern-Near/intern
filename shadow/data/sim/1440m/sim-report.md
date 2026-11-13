# $INTERN: 60 days simulated, 24-hour rounds, as in the product

Generated 2026-11-13T14:33:26.151Z by `npm run sim` (shadow/src/sim). **A simulation, not a forecast:** real past Hyperliquid prices and the AI's real recorded answers, with assumed community behaviour; test dollars only. 5 seeds per scenario, each run twice: with the rank limits and, as a control, with them switched off.

## Pass marks (set before the results)

Our bar for the parameters, written into the code (src/sim/scenarios.ts) before the first full run. A mark passes only if every seed passes it; it is judged on the runs with the limits on, and shown for the control for contrast.

| Mark | Scenario | Pass mark | Why this number |
|---|---|---|---|
| G1 | every run | The books balance after every round of every run: coins held add up to the supply, pending money and SAFE add up (book_failures <= 0) | the simulation's own bookkeeping; any failure means a bug in the sim, not in the coin |
| G2 | every run | With the limits on, no bet is ever approved above its per-bet limit on the limit base (approved_over_limit <= 0) | 01 §3 (1.1): the limit base is the smaller of the pool at the opening and the pool now |
| BL1 | baseline | With the limits on, the coin price never falls below 80% of its start (price_floor_pct >= 80) | INTERN risks at most 2% of the pool a round (01 §3) and the bosses act after a 10% fall (assumed); losing a fifth of the pool in 60 days would mean the limits are too loose |
| BL2 | baseline | No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened) (worst_loss_vs_limit <= 1) | 01 §3: a bet can lose at most its margin, and a round's margins must fit inside the per-round limit |
| LS1 | losing-streak | With the limits on, the coin price stays above 80% of its start although every bet of the first 30 days loses (price_floor_pct >= 80) | INTERN risks at most 2% of the pool a round (01 §3) and the bosses act after a 10% fall (assumed); losing a fifth of the pool in 60 days would mean the limits are too loose |
| LS2 | losing-streak | No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened) (worst_loss_vs_limit <= 1) | 01 §3: a bet can lose at most its margin, and a round's margins must fit inside the per-round limit |
| RB1 | brave-run | No cash-out lowers the coin price for those who stay (cashout_price_drop_e6 <= 0) | 01 §2: rounding always favours the pool; 01 §9.1: a cash-out pays its share of what the pool holds, leaving out margin on open bets |
| RB2 | brave-run | With the limits on, no bet is approved above the limit worked out on the money still in the pool (approved_over_limit <= 0) | 01 §3 (1.1): a limit must never be sized on money that has left |
| RB3 | brave-run | With the limits on, the coin price never falls below 80% of its start (price_floor_pct >= 80) | INTERN risks at most 2% of the pool a round (01 §3) and the bosses act after a 10% fall (assumed); losing a fifth of the pool in 60 days would mean the limits are too loose |
| AM1 | always-max | No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened) (worst_loss_vs_limit <= 1) | 01 §3: a bet can lose at most its margin, and a round's margins must fit inside the per-round limit |
| AM2 | always-max | With the limits on, the coin price stays above 50% of its start (price_floor_pct >= 50) | betting the most allowed every round is the worst the ranks allow; losing half the pool in 60 days would mean the ranks are too loose |
| WA1 | whale-alone | The whale alone, with under 34% of the locked weight, never fires or demotes the Intern (tighten_passed <= 0) | 01 §9.2 (1.2): demote and fire need yes from 34% of all the weight locked when the vote opened |
| WA2 | whale-alone | With the limits on, the coin price stays above 70% of its start while one whale sets the rank (price_floor_pct >= 70) | a whale with 20% of the locked weight can promote alone (01 §9.2 quorum), up to TRADER's 20% a round (01 §3) |
| NV1 | nobody-votes | The rank never changes (rank_changes <= 0) | 01 §9.2: only a vote changes the rank, and a vote needs a boss with locked coins |
| NV2 | nobody-votes | No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened) (worst_loss_vs_limit <= 1) | 01 §3: a bet can lose at most its margin, and a round's margins must fit inside the per-round limit |
| FF1 | fake-farm | Fake accounts win no bigger share of the payday draw than their share of the dollars held (fake_draw_excess_pts <= 0) | 01 §9.7: tickets are dollars held times rounds, so a fair draw pays in proportion to dollars |
| FF2 | fake-farm | No honest boss is turned away from the draw because it is full (honest_refused_full <= 0) | 01 §9.7: at most 200 entrants |
| FF3 | fake-farm | Fake accounts win no bigger share of the streak jackpot than their share of the guesses (fake_jackpot_excess_pts <= 0) | a guess is free; more than their share of guesses means their accounts beat the honest players by covering every answer |
| FF4 | fake-farm | No prize is paid beyond its source: draws from the lender's interest, jackpots from the seed and half the tips (prizes_beyond_sources_e6 <= 0) | 01 §9.7: every prize is paid from a named source; nobody's deposit is touched |

## What went in

- **Rules:** 01-SHARED-INTERFACE.md version 1.5. The rank limits are `runner/src/ranks.ts` and every proposal is judged by `runner/src/rules.ts`, the same code the runner and the shadow run use; the rulebook's `max_margin_e6` is the runner's own `maxMarginE6`. Every other rule and number is in src/sim/rules01.ts with its section of 01; test/sim-rules01.test.ts checks them against the live testnet coin's views of 2026-11-13.
- **Rounds:** 1440 minutes (01 §5), 60 rounds. Bets are proposed when the proposal window opens and held to the close (12:00 to 22:00 UTC). The runner asks the Intern once a round (runner/src/round.ts), never while it is FIRED.
- **Prices:** Hyperliquid mainnet 30-minute candles of DOGE, kSHIB, kPEPE, PENGU, WIF and TRUMP, from `POST https://api.hyperliquid.xyz/info {"type":"candleSnapshot"}` (read-only), fetched 2026-11-13T13:56:04.988Z, saved in shadow/fixtures/sim/hl-candles-2026-11-13: 2026-08-01T09:30:00.000Z to 2026-11-13T13:00:00.000Z. Of the 45 possible 60-day windows, each seed uses one: seed 1 from 2026-08-21, seed 2 from 2026-09-09, seed 3 from 2026-08-17, seed 4 from 2026-08-12, seed 5 from 2026-08-29. Trading cost 17 bps of the notional per round trip (the shadow run's).
- **The Intern:** `z-ai/glm-5.3-flash`'s 126 answered decisions in shadow run `2026-11-11-intern` (2026-11-11T1645Z to 2026-11-13T1000Z), read from the raw files and judged as the shadow report judges them (strict answer rule): 72 skips, 54 bets, 0 unreadable answers; 0 exchanges failed and are left out. Of the bets, 34 were exactly the rulebook's example amount, 20 exactly the largest margin allowed and 0 some other share of it; markets PEPE 26, PENGU 20, DOGE 4, SHIB 4; sides LONG 54; leverage 1 54. When recorded (told rank INTERN, max_margin_e6 20000000, example 10000000) the verdicts were SKIP 72, YES 54. Each round one answer is drawn at random from the record and sized against today's rulebook (src/sim/behaviour.ts).
- **Ranks:** INTERN 2% a bet, 2% a round, 1 bet, 1x; ANALYST 5% a bet, 8% a round, 2 bets, 1x; TRADER 10% a bet, 20% a round, 3 bets, 2x (01 §3, PROPOSED).
- **The control:** the same seeds with checks 6 to 12 switched off and the Intern told the whole idle pool is its limit; a bet is capped only by the idle pool and Hyperliquid's own maximum leverage, and must reach Hyperliquid's $10 minimum.

## Summary

Medians over the seeds, worst seed in brackets. Bets are per run (a mean); rank changes and votes are totals over all seeds.

| Scenario | Limits | Coin price: start → end | Deepest fall | BRAVE pool: start / lowest / end | Coin supply: start → end | Bets a run: YES / refused / skipped | Bets' net result a run | Rank changes; votes passed / opened | Pass marks |
|---|---|---|---|---|---|---|---|---|---|
| baseline | on | $1.0000 → $1.0210 (worst $1.0122) | 0.0% (worst 1.1%) | $8,311 / $8,311 / $28,073 | 8,311 → 27,417 | 17.4 / 9 / 33.6 | $22 (worst -$144) | 10; 15 / 16 | 2 of 2 |
|  | off | $1.0000 → $1.0371 (worst $0.9361) | 12.1% (worst 16.0%) | $8,311 / $8,311 / $28,227 | 8,311 → 26,325 | 26.4 / 0 / 33.6 | -$744 (worst -$2,739) | 15; 20 / 25 | (1 of 2 would pass) |
| losing-streak | on | $1.0000 → $1.0113 (worst $0.9992) | 1.0% (worst 1.5%) | $8,311 / $8,311 / $27,821 | 8,311 → 27,724 | 26.4 / 0 / 33.6 | -$75 (worst -$366) | 10; 15 / 17 | 2 of 2 |
|  | off | $1.0000 → $0.8524 (worst $0.8284) | 19.1% (worst 26.0%) | $8,311 / $8,311 / $26,313 | 8,311 → 29,602 | 25 / 0 / 32 | -$1,685 (worst -$3,778) | 16; 21 / 26 | (0 of 2 would pass) |
| brave-run | on | $1.0000 → $1.0367 (worst $1.0175) | 0.3% (worst 1.1%) | $8,311 / $6,785 / $22,736 | 8,311 → 21,890 | 19.6 / 6.8 / 33.6 | $60 (worst -$114) | 10; 15 / 16 | 3 of 3 |
|  | off | $1.0000 → $1.0998 (worst $0.9356) | 10.3% (worst 16.3%) | $8,311 / $6,387 / $23,692 | 8,311 → 21,407 | 26.4 / 0 / 33.6 | -$316 (worst -$1,798) | 16; 21 / 23 | (3 of 3 would pass) |
| always-max | on | $1.0000 → $0.9989 (worst $0.9249) | 5.1% (worst 11.9%) | $8,311 / $8,311 / $25,994 | 8,311 → 28,093 | 110 / 37.2 / 0 | -$8 (worst -$2,265) | 10; 15 / 17 | 2 of 2 |
|  | off | $1.0000 → $0.1802 (worst $0.0000) | 91.0% (worst 100.0%) | $8,311 / $2,465 / $15,038 | 8,311 → 83,453 | 30 / 0 / 0 | -$9,472 (worst -$19,708) | 49; 55 / 76 | (0 of 2 would pass) |
| whale-alone | on | $1.0000 → $1.0214 (worst $1.0167) | 0.0% (worst 0.3%) | $8,311 / $8,311 / $28,910 | 8,311 → 28,192 | 17.4 / 9 / 33.6 | $38 (worst -$25) | 5; 5 / 216 | 2 of 2 |
|  | off | $1.0000 → $1.0477 (worst $0.9452) | 11.9% (worst 15.7%) | $8,311 / $8,311 / $29,248 | 8,311 → 27,065 | 26.4 / 0 / 33.6 | -$769 (worst -$2,816) | 6; 6 / 167 | (2 of 2 would pass) |
| nobody-votes | on | $1.0000 → $1.0217 (worst $1.0190) | 0.0% (worst 0.2%) | $8,311 / $8,311 / $24,315 | 8,311 → 23,776 | 17.4 / 9 / 33.6 | $8 (worst -$20) | 0; 0 / 0 | 2 of 2 |
|  | off | $1.0000 → $1.0945 (worst $0.9635) | 9.3% (worst 15.0%) | $8,311 / $8,311 / $25,413 | 8,311 → 21,767 | 26.4 / 0 / 33.6 | -$800 (worst -$2,366) | 0; 0 / 0 | (1 of 2 would pass) |
| fake-farm | on | $1.0000 → $1.0210 (worst $1.0122) | 0.0% (worst 1.1%) | $8,313 / $8,313 / $28,075 | 8,313 → 27,419 | 17.4 / 9 / 33.6 | $22 (worst -$144) | 10; 15 / 16 | 1 of 4; **FAIL FF1, FF2, FF3** |
|  | off | $1.0000 → $1.0371 (worst $0.9361) | 12.1% (worst 16.0%) | $8,313 / $8,313 / $28,229 | 8,313 → 26,327 | 26.4 / 0 / 33.6 | -$744 (worst -$2,739) | 15; 20 / 25 | (1 of 4 would pass) |

## Pass or fail

| Mark | Scenario | Result, limits on | Worst seed | Limits off (contrast) |
|---|---|---|---|---|
| G1 | all | PASS | 0 | - |
| G2 | all | PASS | 0 | would pass (worst 0) |
| BL1 | baseline | PASS | 100 | would pass (worst 85.7) |
| BL2 | baseline | PASS | 0.1 | would fail (1 of 5; worst 3.1) |
| LS1 | losing-streak | PASS | 99.3 | would fail (1 of 5; worst 74.3) |
| LS2 | losing-streak | PASS | 0.1 | would fail (5 of 5; worst 5.9) |
| RB1 | brave-run | PASS | 0 | would pass (worst 0) |
| RB2 | brave-run | PASS | 0 | would pass (worst 0) |
| RB3 | brave-run | PASS | 100 | would pass (worst 93.2) |
| AM1 | always-max | PASS | 0.2 | would fail (5 of 5; worst 50) |
| AM2 | always-max | PASS | 92.5 | would fail (5 of 5; worst 0) |
| WA1 | whale-alone | PASS | 0 | would pass (worst 0) |
| WA2 | whale-alone | PASS | 100 | would pass (worst 85.7) |
| NV1 | nobody-votes | PASS | 0 | would pass (worst 0) |
| NV2 | nobody-votes | PASS | 0.1 | would fail (5 of 5; worst 5.5) |
| FF1 | fake-farm | **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5) | 93.7 | would fail (5 of 5; worst 94.0) |
| FF2 | fake-farm | **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5) | 111 | would fail (5 of 5; worst 111) |
| FF3 | fake-farm | **FAIL** (4 of 5 seeds: 1, 2, 3, 4) | 13.2 | would fail (5 of 5; worst 21.8) |
| FF4 | fake-farm | PASS | 0 | would pass (worst 0) |

## Scenario by scenario

### baseline: Baseline

Bosses come and go, lock coins and vote as assumed below; the Intern answers as the recorded model did; real prices.

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $1.0210 (worst $1.0122) | $1.0371 (worst $0.9361) |
| Lowest coin price, median (worst seed) | $1.0000 (worst $1.0000) | $0.9333 (worst $0.8571) |
| Deepest fall from a high, median (worst seed) | 0.0% (worst 1.1%) | 12.1% (worst 16.0%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $28,073 | $8,311 / $8,311 / $28,227 |
| BRAVE pool's deepest fall, median (worst seed) | 9.5% (worst 12.1%) | 8.1% (worst 12.9%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 30,059 / 27,417 | 8,311 / 6,805 / 28,165 / 26,325 |
| Proposals a run: asked / YES / skipped / refused | 60 / 17.4 / 33.6 / 9 | 60 / 26.4 / 33.6 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 45 | none |
| Bets asked at exactly the largest margin allowed, a run | 11.4 | 11.4 |
| Refused only because money left after the opening, a run | 9 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 1.1% | 10.9% |
| Worst round's loss / its rank's per-round limit | 0.05 | 3.05 |
| Rank changes, all seeds | 10 | 15 |
| Rounds at each rank, all seeds | TRADER 197, ANALYST 53, INTERN 50 | ANALYST 128, TRADER 110, INTERN 62 |
| Rank at the end, by seed | TRADER 5 | TRADER 4, ANALYST 1 |
| Votes opened, all seeds | PROMOTE 11, SET_PLAYBOOK 5 | PROMOTE 16, SET_PLAYBOOK 5, DEMOTE 4 |
| Votes passed, all seeds | PROMOTE 10, SET_PLAYBOOK 5 | PROMOTE 12, SET_PLAYBOOK 5, DEMOTE 3 |
| Bets' net result a run, after costs, median (worst seed) | $21.92 (worst -$144.25) | -$743.60 (worst -$2,739.02) |
| Outside income to BRAVE (half of the tips), a run | $305.60 | $305.60 |
| Coach cut paid to the playbook's authors, a run | $6.58 | $375.13 |
| Cash-outs a run: count / paid / margin left on open bets | 141.4 / $13,472 / $10.71 | 141.4 / $12,320 / $1,279.55 |
| Lender's interest to the draw, a run | $124.28 | $132.63 |
| Draw prizes a run: bosses / whale / fakes | $112.79 / $0.00 / $0.00 | $120.12 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $375.40 / $0.00 / $0.00 | $375.40 / $0.00 / $0.00 |

- BL1 PASS: With the limits on, the coin price never falls below 80% of its start. Worst seed: 100. Limits off: would pass (worst 85.7).
- BL2 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.1. Limits off: would fail (1 of 5; worst 3.1).

**What it says:** With the limits the coin price's deepest fall was 1.1% in the worst seed (median 0.0%); with them off, 16.0% (median 12.1%). 2 of 2 pass marks passed. The Intern asked for exactly the rulebook's largest margin 11.4 times a run; 9.0 of those (of 9.0 refusals in all) were refused OVER_TRADE_LIMIT only because someone had cashed out between the round's opening and the proposal (01 §3 calls this rare).

### losing-streak: A losing streak

As the baseline, but for the first 30 days every bet is set on the side that lost the real price move: the worst luck the prices allow. Bosses cash out only after each round's bets have closed, so no bet is refused for money that left and nobody leaves a share of an open bet behind.

Community inputs that differ from the baseline: cash-outs come at any moment of the round (false: only after the round's bets have closed): false (baseline true).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $1.0113 (worst $0.9992) | $0.8524 (worst $0.8284) |
| Lowest coin price, median (worst seed) | $0.9965 (worst $0.9931) | $0.8128 (worst $0.7429) |
| Deepest fall from a high, median (worst seed) | 1.0% (worst 1.5%) | 19.1% (worst 26.0%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $27,821 | $8,311 / $8,311 / $26,313 |
| BRAVE pool's deepest fall, median (worst seed) | 9.5% (worst 12.4%) | 8.9% (worst 14.8%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 30,261 / 27,724 | 8,311 / 6,805 / 35,240 / 29,602 |
| Proposals a run: asked / YES / skipped / refused | 60 / 26.4 / 33.6 / 0 | 57 / 25 / 32 / 0 |
| Refusals by code, all seeds | none | none |
| Bets asked at exactly the largest margin allowed, a run | 11.4 | 10.8 |
| Refused only because money left after the opening, a run | 0 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 1.1% | 11.7% |
| Worst round's loss / its rank's per-round limit | 0.12 | 5.86 |
| Rank changes, all seeds | 10 | 16 |
| Rounds at each rank, all seeds | TRADER 189, ANALYST 61, INTERN 50 | INTERN 142, ANALYST 118, TRADER 25, FIRED 15 |
| Rank at the end, by seed | TRADER 5 | ANALYST 2, INTERN 2, TRADER 1 |
| Votes opened, all seeds | PROMOTE 12, SET_PLAYBOOK 5 | PROMOTE 10, DEMOTE 6, SET_PLAYBOOK 5, REHIRE 3, FIRE 2 |
| Votes passed, all seeds | PROMOTE 10, SET_PLAYBOOK 5 | PROMOTE 8, SET_PLAYBOOK 5, DEMOTE 4, FIRE 2, REHIRE 2 |
| Bets' net result a run, after costs, median (worst seed) | -$75.18 (worst -$365.81) | -$1,685.47 (worst -$3,778.33) |
| Outside income to BRAVE (half of the tips), a run | $305.60 | $305.60 |
| Coach cut paid to the playbook's authors, a run | $26.09 | $241.55 |
| Cash-outs a run: count / paid / margin left on open bets | 141.4 / $13,409 / $0.00 | 141.4 / $12,658 / $0.00 |
| Lender's interest to the draw, a run | $124.05 | $130.84 |
| Draw prizes a run: bosses / whale / fakes | $112.59 / $0.00 / $0.00 | $118.05 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $375.40 / $0.00 / $0.00 | $375.40 / $0.00 / $0.00 |

- LS1 PASS: With the limits on, the coin price stays above 80% of its start although every bet of the first 30 days loses. Worst seed: 99.3. Limits off: would fail (1 of 5; worst 74.3).
- LS2 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.1. Limits off: would fail (5 of 5; worst 5.9).

**What it says:** With the limits the coin price's deepest fall was 1.5% in the worst seed (median 1.0%); with them off, 26.0% (median 19.1%). 2 of 2 pass marks passed. The bets' net result a run was -$75 with the limits (worst seed -$366) and -$1,685 without (worst -$3,778); tips added about $306 a run either way.

### brave-run: A run on BRAVE

As the baseline, but on days 20 and 21 each boss holding coins leaves with a 60% chance: unlocks, takes back pending money and cashes out every coin, some while bets are open.

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $1.0367 (worst $1.0175) | $1.0998 (worst $0.9356) |
| Lowest coin price, median (worst seed) | $1.0000 (worst $1.0000) | $0.9434 (worst $0.9316) |
| Deepest fall from a high, median (worst seed) | 0.3% (worst 1.1%) | 10.3% (worst 16.3%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $6,785 / $22,736 | $8,311 / $6,387 / $23,692 |
| BRAVE pool's deepest fall, median (worst seed) | 55.0% (worst 60.7%) | 54.3% (worst 55.8%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 5,376 / 24,799 / 21,890 | 8,311 / 5,331 / 22,909 / 21,407 |
| Proposals a run: asked / YES / skipped / refused | 60 / 19.6 / 33.6 / 6.8 | 60 / 26.4 / 33.6 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 34 | none |
| Bets asked at exactly the largest margin allowed, a run | 11.4 | 11.4 |
| Refused only because money left after the opening, a run | 6.8 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 1.1% | 10.9% |
| Worst round's loss / its rank's per-round limit | 0.05 | 3.05 |
| Rank changes, all seeds | 10 | 16 |
| Rounds at each rank, all seeds | TRADER 197, ANALYST 53, INTERN 50 | TRADER 135, ANALYST 113, INTERN 52 |
| Rank at the end, by seed | TRADER 5 | TRADER 5 |
| Votes opened, all seeds | PROMOTE 11, SET_PLAYBOOK 5 | PROMOTE 15, SET_PLAYBOOK 5, DEMOTE 3 |
| Votes passed, all seeds | PROMOTE 10, SET_PLAYBOOK 5 | PROMOTE 13, SET_PLAYBOOK 5, DEMOTE 3 |
| Bets' net result a run, after costs, median (worst seed) | $59.89 (worst -$113.54) | -$315.77 (worst -$1,797.74) |
| Outside income to BRAVE (half of the tips), a run | $305.60 | $305.60 |
| Coach cut paid to the playbook's authors, a run | $14.33 | $290.15 |
| Cash-outs a run: count / paid / margin left on open bets | 146.8 / $18,519 / $50.35 | 146.8 / $17,593 / $1,469.75 |
| Lender's interest to the draw, a run | $95.48 | $100.54 |
| Draw prizes a run: bosses / whale / fakes | $86.22 / $0.00 / $0.00 | $90.58 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $354.40 / $0.00 / $0.00 | $307.20 / $0.00 / $0.00 |

- RB1 PASS: No cash-out lowers the coin price for those who stay. Worst seed: 0. Limits off: would pass (worst 0).
- RB2 PASS: With the limits on, no bet is approved above the limit worked out on the money still in the pool. Worst seed: 0. Limits off: would pass (worst 0).
- RB3 PASS: With the limits on, the coin price never falls below 80% of its start. Worst seed: 100. Limits off: would pass (worst 93.2).

**What it says:** With the limits the coin price's deepest fall was 1.1% in the worst seed (median 0.3%); with them off, 16.3% (median 10.3%). 3 of 3 pass marks passed. Cash-outs paid $18,519 a run on average and left $50 of margin on open bets to those who stayed; 6.8 bets a run were refused only because money left between the opening and the proposal.

### always-max: An Intern that always bets the maximum

The Intern ignores the record and always asks for the most it is told it may: the largest margin, the highest leverage, a random allowed market and side; the runner asks until the rank's bets are used. Bosses cash out only after each round's bets have closed, so no bet is refused for money that left and nobody leaves a share of an open bet behind.

Community inputs that differ from the baseline: cash-outs come at any moment of the round (false: only after the round's bets have closed): false (baseline true).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $0.9989 (worst $0.9249) | $0.1802 (worst $0.0000) |
| Lowest coin price, median (worst seed) | $0.9745 (worst $0.9249) | $0.1667 (worst $0.0000) |
| Deepest fall from a high, median (worst seed) | 5.1% (worst 11.9%) | 91.0% (worst 100.0%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $25,994 | $8,311 / $2,465 / $15,038 |
| BRAVE pool's deepest fall, median (worst seed) | 8.7% (worst 12.1%) | 82.8% (worst 100.0%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 30,118 / 28,093 | 8,311 / 6,805 / 1,771,875,948,912 / 83,453 |
| Proposals a run: asked / YES / skipped / refused | 147.2 / 110 / 0 / 37.2 | 90 / 30 / 0 / 0 |
| Refusals by code, all seeds | ZERO_MARGIN 186 | none |
| Bets asked at exactly the largest margin allowed, a run | 147.2 | 90 |
| Refused only because money left after the opening, a run | 0 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 60 |
| Bets liquidated, a run | 0 | 0.6 |
| Worst round's loss, % of the pool at its opening | 3.5% | 100.0% |
| Worst round's loss / its rank's per-round limit | 0.17 | 50.00 |
| Rank changes, all seeds | 10 | 49 |
| Rounds at each rank, all seeds | TRADER 186, ANALYST 64, INTERN 50 | FIRED 150, INTERN 145, ANALYST 5 |
| Rank at the end, by seed | TRADER 5 | FIRED (INTERN) 3, INTERN 2 |
| Votes opened, all seeds | PROMOTE 11, SET_PLAYBOOK 5, DEMOTE 1 | FIRE 37, REHIRE 28, SET_PLAYBOOK 5, PROMOTE 3, DEMOTE 3 |
| Votes passed, all seeds | PROMOTE 10, SET_PLAYBOOK 5 | FIRE 23, REHIRE 21, SET_PLAYBOOK 5, PROMOTE 3, DEMOTE 3 |
| Bets' net result a run, after costs, median (worst seed) | -$8.29 (worst -$2,265.06) | -$9,472.40 (worst -$19,707.76) |
| Outside income to BRAVE (half of the tips), a run | $305.60 | $305.60 |
| Coach cut paid to the playbook's authors, a run | $252.54 | $3,939.89 |
| Cash-outs a run: count / paid / margin left on open bets | 141.4 / $13,365 / $0.00 | 141.4 / $12,794 / $0.00 |
| Lender's interest to the draw, a run | $123.94 | $128.68 |
| Draw prizes a run: bosses / whale / fakes | $112.63 / $0.00 / $0.00 | $117.10 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $405.60 / $0.00 / $0.00 | $397.80 / $0.00 / $0.00 |

- AM1 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.2. Limits off: would fail (5 of 5; worst 50).
- AM2 PASS: With the limits on, the coin price stays above 50% of its start. Worst seed: 92.5. Limits off: would fail (5 of 5; worst 0).

**What it says:** With the limits the coin price's deepest fall was 11.9% in the worst seed (median 5.1%); with them off, 100.0% (median 91.0%). 2 of 2 pass marks passed. With the limits 37.2 asks a run were refused (186 ZERO_MARGIN over all seeds: at TRADER two bets of 10% fill the round's 20%, so a third ask is for nothing). Without them 0.6 bets a run were liquidated, the worst round lost 100.0% of the pool, and once a pool is nearly empty new money buys coins for almost nothing, so the supply explodes (highest 1.8e+12 coins).

### whale-alone: A whale who votes alone

One whale arrives in round 1 holding 25% of the coins then locked and locks them all; he opens a promotion whenever the rules allow and a firing every 10 days, and votes yes. Bosses still lock coins but nobody else votes.

Community inputs that differ from the baseline: ordinary bosses open and cast votes: false (baseline true); the day a playbook vote is opened: null (baseline 3).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $1.0214 (worst $1.0167) | $1.0477 (worst $0.9452) |
| Lowest coin price, median (worst seed) | $1.0000 (worst $1.0000) | $0.9425 (worst $0.8572) |
| Deepest fall from a high, median (worst seed) | 0.0% (worst 0.3%) | 11.9% (worst 15.7%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $28,910 | $8,311 / $8,311 / $29,248 |
| BRAVE pool's deepest fall, median (worst seed) | 8.9% (worst 11.8%) | 7.9% (worst 13.2%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 31,081 / 28,192 | 8,311 / 6,805 / 28,922 / 27,065 |
| Proposals a run: asked / YES / skipped / refused | 60 / 17.4 / 33.6 / 9 | 60 / 26.4 / 33.6 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 45 | none |
| Bets asked at exactly the largest margin allowed, a run | 11.4 | 11.4 |
| Refused only because money left after the opening, a run | 9 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.4% | 10.9% |
| Worst round's loss / its rank's per-round limit | 0.11 | 5.48 |
| Rank changes, all seeds | 5 | 6 |
| Rounds at each rank, all seeds | INTERN 152, TRADER 94, ANALYST 54 | INTERN 150, TRADER 141, ANALYST 9 |
| Rank at the end, by seed | TRADER 2, INTERN 2, ANALYST 1 | TRADER 3, INTERN 2 |
| Votes opened, all seeds | PROMOTE 191, FIRE 25 | PROMOTE 142, FIRE 25 |
| Votes passed, all seeds | PROMOTE 5 | PROMOTE 6 |
| Bets' net result a run, after costs, median (worst seed) | $37.74 (worst -$24.66) | -$768.89 (worst -$2,815.96) |
| Outside income to BRAVE (half of the tips), a run | $305.60 | $305.60 |
| Coach cut paid to the playbook's authors, a run | $0.00 | $0.00 |
| Cash-outs a run: count / paid / margin left on open bets | 141.4 / $13,476 / $11.35 | 141.4 / $12,379 / $1,284.39 |
| Lender's interest to the draw, a run | $139.70 | $139.29 |
| Draw prizes a run: bosses / whale / fakes | $126.60 / $0.00 / $0.00 | $125.93 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $375.40 / $0.00 / $0.00 | $375.40 / $0.00 / $0.00 |

- WA1 PASS: The whale alone, with under 34% of the locked weight, never fires or demotes the Intern. Worst seed: 0. Limits off: would pass (worst 0).
- WA2 PASS: With the limits on, the coin price stays above 70% of its start while one whale sets the rank. Worst seed: 100. Limits off: would pass (worst 85.7).

**What it says:** With the limits the coin price's deepest fall was 0.3% in the worst seed (median 0.0%); with them off, 15.7% (median 11.9%). 2 of 2 pass marks passed. Alone, the whale passed 5 promotions and 0 firings or demotions over all seeds; the Intern spent 94 of 300 rounds at TRADER.

### nobody-votes: Nobody votes

As the baseline, but nobody locks coins, so no vote can be opened.

Community inputs that differ from the baseline: share of bosses who lock coins to vote: 0 (baseline 0.5); ordinary bosses open and cast votes: false (baseline true); the day a playbook vote is opened: null (baseline 3).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $1.0217 (worst $1.0190) | $1.0945 (worst $0.9635) |
| Lowest coin price, median (worst seed) | $1.0000 (worst $1.0000) | $0.9601 (worst $0.8637) |
| Deepest fall from a high, median (worst seed) | 0.0% (worst 0.2%) | 9.3% (worst 15.0%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $24,315 | $8,311 / $8,311 / $25,413 |
| BRAVE pool's deepest fall, median (worst seed) | 14.9% (worst 15.2%) | 10.5% (worst 21.0%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,754 / 25,600 / 23,776 | 8,311 / 6,754 / 23,910 / 21,767 |
| Proposals a run: asked / YES / skipped / refused | 60 / 17.4 / 33.6 / 9 | 60 / 26.4 / 33.6 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 45 | none |
| Bets asked at exactly the largest margin allowed, a run | 11.4 | 11.4 |
| Refused only because money left after the opening, a run | 9 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.2% | 10.9% |
| Worst round's loss / its rank's per-round limit | 0.11 | 5.48 |
| Rank changes, all seeds | 0 | 0 |
| Rounds at each rank, all seeds | INTERN 300 | INTERN 300 |
| Rank at the end, by seed | INTERN 5 | INTERN 5 |
| Votes opened, all seeds | none | none |
| Votes passed, all seeds | none | none |
| Bets' net result a run, after costs, median (worst seed) | $7.83 (worst -$20.13) | -$800.22 (worst -$2,365.78) |
| Outside income to BRAVE (half of the tips), a run | $305.60 | $305.60 |
| Coach cut paid to the playbook's authors, a run | $0.00 | $0.00 |
| Cash-outs a run: count / paid / margin left on open bets | 141.4 / $17,387 / $4.63 | 141.4 / $16,145 / $1,673.94 |
| Lender's interest to the draw, a run | $132.85 | $137.04 |
| Draw prizes a run: bosses / whale / fakes | $120.80 / $0.00 / $0.00 | $124.17 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $375.40 / $0.00 / $0.00 | $375.40 / $0.00 / $0.00 |

- NV1 PASS: The rank never changes. Worst seed: 0. Limits off: would pass (worst 0).
- NV2 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.1. Limits off: would fail (5 of 5; worst 5.5).

**What it says:** With the limits the coin price's deepest fall was 0.2% in the worst seed (median 0.0%); with them off, 15.0% (median 9.3%). 2 of 2 pass marks passed. With no votes the Intern stayed INTERN throughout.

### fake-farm: Fake accounts farming the free guess and the draw

As the baseline, plus 200 fake accounts registered before the first round, each with $0.01 in BRAVE (to be a boss) and $10 in SAFE (to be jackpot-eligible). They join the draw first and guess every round, covering the guess tree.

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $1.0210 (worst $1.0122) | $1.0371 (worst $0.9361) |
| Lowest coin price, median (worst seed) | $1.0000 (worst $1.0000) | $0.9333 (worst $0.8571) |
| Deepest fall from a high, median (worst seed) | 0.0% (worst 1.1%) | 12.1% (worst 16.0%) |
| BRAVE pool: start / lowest / end, median | $8,313 / $8,313 / $28,075 | $8,313 / $8,313 / $28,229 |
| BRAVE pool's deepest fall, median (worst seed) | 9.5% (worst 12.1%) | 8.1% (worst 12.9%) |
| Coin supply: start / lowest / highest / end (median) | 8,313 / 6,807 / 30,061 / 27,419 | 8,313 / 6,807 / 28,167 / 26,327 |
| Proposals a run: asked / YES / skipped / refused | 60 / 17.4 / 33.6 / 9 | 60 / 26.4 / 33.6 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 45 | none |
| Bets asked at exactly the largest margin allowed, a run | 11.4 | 11.4 |
| Refused only because money left after the opening, a run | 9 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 1.1% | 10.9% |
| Worst round's loss / its rank's per-round limit | 0.05 | 3.05 |
| Rank changes, all seeds | 10 | 15 |
| Rounds at each rank, all seeds | TRADER 197, ANALYST 53, INTERN 50 | ANALYST 128, TRADER 110, INTERN 62 |
| Rank at the end, by seed | TRADER 5 | TRADER 4, ANALYST 1 |
| Votes opened, all seeds | PROMOTE 11, SET_PLAYBOOK 5 | PROMOTE 16, SET_PLAYBOOK 5, DEMOTE 4 |
| Votes passed, all seeds | PROMOTE 10, SET_PLAYBOOK 5 | PROMOTE 12, SET_PLAYBOOK 5, DEMOTE 3 |
| Bets' net result a run, after costs, median (worst seed) | $21.92 (worst -$144.26) | -$743.79 (worst -$2,739.25) |
| Outside income to BRAVE (half of the tips), a run | $305.60 | $305.60 |
| Coach cut paid to the playbook's authors, a run | $6.58 | $375.16 |
| Cash-outs a run: count / paid / margin left on open bets | 141.4 / $13,472 / $10.71 | 141.4 / $12,320 / $1,279.54 |
| Lender's interest to the draw, a run | $124.30 | $132.64 |
| Draw prizes a run: bosses / whale / fakes | $0.00 / $0.00 / $112.81 | $0.00 / $0.00 / $120.14 |
| Jackpot prizes a run: bosses / whale / fakes | $64.07 / $0.00 / $332.13 | $17.29 / $0.00 / $387.51 |
| Guesses a run: bosses / fakes | 3,393 / 12,000 | 3,393 / 12,000 |
| Golden stickers a run: bosses / fakes | 70.6 / 243.4 | 70.6 / 243.4 |
| Fakes' share of dollars held, at the draws | 6.9% | 6.9% |
| Honest bosses turned away from the full draw, a run | 103.8 | 103.8 |

- FF1 **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5): Fake accounts win no bigger share of the payday draw than their share of the dollars held. Worst seed: 93.7. Limits off: would fail (5 of 5; worst 94.0).
- FF2 **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5): No honest boss is turned away from the draw because it is full. Worst seed: 111. Limits off: would fail (5 of 5; worst 111).
- FF3 **FAIL** (4 of 5 seeds: 1, 2, 3, 4): Fake accounts win no bigger share of the streak jackpot than their share of the guesses. Worst seed: 13.2. Limits off: would fail (5 of 5; worst 21.8).
- FF4 PASS: No prize is paid beyond its source: draws from the lender's interest, jackpots from the seed and half the tips. Worst seed: 0. Limits off: would pass (worst 0).

**What it says:** With the limits the coin price's deepest fall was 1.1% in the worst seed (median 0.0%); with them off, 16.0% (median 12.1%). 1 of 4 pass marks passed. Holding 6.9% of the dollars, the 200 fake accounts took 100.0% of the draw prizes and 83.8% of the jackpot; 104 honest bosses a run were turned away from the full draw. What it cost them: 2.56 NEAR of registration (01 §9.1) and $2,002 parked, almost all of it in SAFE, at no risk.

## Scenario inputs (assumed, not contract rules)

The baseline community; each scenario above says what it changes.

| Input | Baseline | Meaning |
|---|---|---|
| start_bosses | 20 | bosses who pay in before the first round |
| start_deposit_usd | [50,2000] | their deposits, dollars (spread evenly on a log scale) |
| brave_share | 0.7 | share of each deposit put in BRAVE (the rest in SAFE) |
| new_bosses_per_day | 3 | new bosses a day, on average |
| deposit_usd | [20,1000] | new bosses' deposits, dollars |
| cash_out_per_day | 0.02 | chance a boss cashes out on a given day |
| cash_out_share | [0.5,1] | share of their unlocked coins they cash out then |
| cash_out_any_time | true | cash-outs come at any moment of the round (false: only after the round's bets have closed) |
| lock_share | 0.5 | share of bosses who lock coins to vote |
| lock_fraction | 0.5 | share of their coins they lock |
| votes | true | ordinary bosses open and cast votes |
| turnout | 0.5 | chance a boss with locked coins votes in an open vote |
| yes_promote | 0.6 | chance a voter says yes to a promotion |
| yes_tighten | 0.8 | chance a voter says yes to a demotion or firing |
| yes_rehire | 0.6 | chance a voter says yes to a rehire |
| yes_playbook | 0.7 | chance a voter says yes to a playbook |
| promote_after_days | 7 | a promotion is opened after this many days at a rank, if the coin is worth more than when the rank began |
| fire_drawdown_bps | 1000 | a demotion (a firing at INTERN) is opened when the coin falls this far below its high at this rank, bps |
| rehire_after_days | 3 | a rehire is opened this many days after a firing |
| retry_after_days | 2 | days the bosses wait after a failed vote before opening another of that kind |
| playbook_day | 3 | the day a playbook vote is opened |
| guess_share | 0.5 | chance a boss makes the free guess in a round |
| draw_join_share | 0.5 | share of bosses who join the payday draw |
| tips_per_day_usd | 10 | tips a day, dollars |
| tip_usd | 2 | size of each tip, dollars |
| jackpot_seed_usd | 100 | the team's seed for the streak jackpot, dollars |

## Not modeled

- Visitors' messages from the trick page. The runner asks them after the Intern's own question, up to three a proposal window (runner/src/trick-desk.ts); each could use a bet the rank still has. Only the Intern's own question is simulated, once a round as the runner does, so at ANALYST and TRADER the bets a round may be fewer than in the product; the per-round limit still bounds them.
- The long shot (01 §9.7 R6, 1.5).
- Funding quotes (01 §7 checks 13 to 16): optional on testnet, never attached here.
- Hyperliquid's funding payments, slippage beyond the trading cost, orders that do not fill or fill in part (01 §14 limit 5), and rounds stuck because a bet cannot be closed.
- The lender running short of dollars (01 §9.1: a cash-out then pays what is available, TO VERIFY in 01).
- Stickers, goal bars, the launchpad and its fees: no money from them reaches BRAVE in the simulation.
- How a playbook changes the Intern's answers: the 10% coach cut is simulated, a playbook's effect on choices is not.
- Coins changing hands between accounts, and voting power bought or rented (01 §14 limit 7) beyond the whale scenario.
- Two limits that are in the contract but not in 01: at most 100 jackpot candidates a round and four lock lots a boss (crates/coin/src/rewards.rs, vote.rs).
- Claiming prizes: a prize credited counts as won.
- Turning the dial after paying in, and SAFE cash-outs: each deposit is split between BRAVE and SAFE when it is paid in (the dial at that moment); the dial's arithmetic (01 §9.1) is in src/sim/ledger.ts and tested, but no scenario turns it later.
- The Intern's skill: each round's answer is drawn at random from the record, so which market it picks is not tied to that day's prices. The prices themselves are real.
- NEAR gas and storage costs, except that the fake accounts' registration cost is counted.

## Stand-ins

- The community: every number in the table of scenario inputs is assumed. Nobody has measured how bosses behave.
- When bosses cash out: at a random moment of the round, so before the proposal (the limit base shrinks, 01 §3), during the hold (the leaver leaves their share of the open bets' margin, 01 §9.1) or after the close; in the two stress scenarios only after the close, so that neither effect spares the pool.
- With 30-minute rounds each bet is held for the whole 30-minute candle, about three times the demo's real hold (minute 15 to minute 25): its swings are larger than the demo's would be.
- At ANALYST and TRADER the Intern replays its INTERN record: sizes relative to the rulebook it is given, markets, sides and leverage as recorded. No run has recorded a model told a higher rank.
- With the limits off the Intern is told the whole idle pool is its largest margin, all six markets and both sides, and keeps its recorded habits. How a model answers when told it may bet everything is not measured (UNVERIFIED).
- A bet is liquidated when, at a candle's high or low, its loss reaches the margin (the shadow run's rule, shadow/src/paper.ts). Hyperliquid liquidates earlier (maintenance margin), so with leverage the simulation undercounts liquidations.
- The lender's interest is the STAND-IN rate, 5% a year (01 §9.6); on testnet it is worth nothing. It only feeds the payday draw.
- `min_first_deposit` is the live testnet coin's $10; 01 gives no number.

