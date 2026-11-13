# $INTERN: 60 days simulated, 30-minute rounds, as in the demo

Generated 2026-11-13T15:19:59.335Z by `npm run sim` (shadow/src/sim). **A simulation, not a forecast:** real past Hyperliquid prices and the AI's real recorded answers, with assumed community behaviour; test dollars only. 5 seeds per scenario, each run twice: with the rank limits and, as a control, with them switched off.

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
- **Rounds:** 30 minutes (01 §5), 2880 rounds. Bets are proposed when the proposal window opens and held to the close (the whole 30-minute candle; the demo holds from minute 15 to 25). The runner asks the Intern once a round (runner/src/round.ts), never while it is FIRED.
- **Prices:** Hyperliquid mainnet 30-minute candles of DOGE, kSHIB, kPEPE, PENGU, WIF and TRUMP, from `POST https://api.hyperliquid.xyz/info {"type":"candleSnapshot"}` (read-only), fetched 2026-11-13T13:56:04.988Z, saved in shadow/fixtures/sim/hl-candles-2026-11-13: 2026-08-01T09:30:00.000Z to 2026-11-13T13:00:00.000Z. Of the 44 possible 60-day windows, each seed uses one: seed 1 from 2026-08-26, seed 2 from 2026-08-29, seed 3 from 2026-08-20, seed 4 from 2026-08-31, seed 5 from 2026-08-18. Trading cost 17 bps of the notional per round trip (the shadow run's).
- **The Intern:** `z-ai/glm-5.3-flash`'s 126 answered decisions in shadow run `2026-11-11-intern` (2026-11-11T1645Z to 2026-11-13T1000Z), read from the raw files and judged as the shadow report judges them (strict answer rule): 72 skips, 54 bets, 0 unreadable answers; 0 exchanges failed and are left out. Of the bets, 34 were exactly the rulebook's example amount, 20 exactly the largest margin allowed and 0 some other share of it; markets PEPE 26, PENGU 20, DOGE 4, SHIB 4; sides LONG 54; leverage 1 54. When recorded (told rank INTERN, max_margin_e6 20000000, example 10000000) the verdicts were SKIP 72, YES 54. Each round one answer is drawn at random from the record and sized against today's rulebook (src/sim/behaviour.ts).
- **Ranks:** INTERN 2% a bet, 2% a round, 1 bet, 1x; ANALYST 5% a bet, 8% a round, 2 bets, 1x; TRADER 10% a bet, 20% a round, 3 bets, 2x (01 §3, PROPOSED).
- **The control:** the same seeds with checks 6 to 12 switched off and the Intern told the whole idle pool is its limit; a bet is capped only by the idle pool and Hyperliquid's own maximum leverage, and must reach Hyperliquid's $10 minimum.

## Summary

Medians over the seeds, worst seed in brackets. Bets are per run (a mean); rank changes and votes are totals over all seeds.

| Scenario | Limits | Coin price: start → end | Deepest fall | BRAVE pool: start / lowest / end | Coin supply: start → end | Bets a run: YES / refused / skipped | Bets' net result a run | Rank changes; votes passed / opened | Pass marks |
|---|---|---|---|---|---|---|---|---|---|
| baseline | on | $1.0000 → $0.9794 (worst $0.9745) | 2.4% (worst 2.8%) | $8,311 / $8,311 / $27,079 | 8,311 → 27,495 | 1228.8 / 11.4 / 1639.8 | -$731 (worst -$847) | 5; 9 / 10 | 2 of 2 |
|  | off | $1.0000 → $0.5384 (worst $0.4998) | 46.7% (worst 52.0%) | $8,311 / $7,994 / $20,278 | 8,311 → 37,662 | 925.2 / 0 / 1211 | -$9,007 (worst -$11,031) | 50; 54 / 73 | (0 of 2 would pass) |
| losing-streak | on | $1.0000 → $0.9712 (worst $0.9688) | 3.0% (worst 3.1%) | $8,311 / $8,311 / $27,182 | 8,311 → 27,706 | 1240.2 / 0 / 1639.8 | -$745 (worst -$870) | 0; 4 / 5 | 2 of 2 |
|  | off | $1.0000 → $0.4199 (worst $0.3189) | 58.3% (worst 68.3%) | $8,311 / $7,735 / $19,257 | 8,311 → 48,886 | 709.6 / 0 / 937.4 | -$12,177 (worst -$14,284) | 74; 78 / 95 | (0 of 2 would pass) |
| brave-run | on | $1.0000 → $0.9782 (worst $0.9604) | 2.5% (worst 4.2%) | $8,311 / $8,275 / $19,451 | 8,311 → 19,925 | 1228.8 / 11.4 / 1639.8 | -$619 (worst -$858) | 7; 11 / 12 | 3 of 3 |
|  | off | $1.0000 → $0.5389 (worst $0.5051) | 46.6% (worst 51.5%) | $8,311 / $7,240 / $15,572 | 8,311 → 28,895 | 933.2 / 0 / 1224.2 | -$7,503 (worst -$9,543) | 49; 53 / 72 | (2 of 3 would pass) |
| always-max | on | $1.0000 → $0.9206 (worst $0.9168) | 8.1% (worst 8.4%) | $8,311 / $8,310 / $26,190 | 8,311 → 28,449 | 2880 / 0 / 0 | -$1,819 (worst -$2,232) | 0; 4 / 5 | 2 of 2 |
|  | off | $1.0000 → $0.0000 (worst $0.0000) | 100.0% (worst 100.0%) | $8,311 / $367 / $1,277 | 8,311 → 810,064,557 | 704.8 / 0 / 0 | -$32,234 (worst -$39,057) | 116; 120 / 177 | (0 of 2 would pass) |
| whale-alone | on | $1.0000 → $0.9479 (worst $0.9357) | 6.0% (worst 6.5%) | $8,311 / $8,311 / $27,422 | 8,311 → 28,759 | 1228.8 / 11.4 / 1639.8 | -$1,416 (worst -$1,706) | 10; 10 / 58 | 2 of 2 |
|  | off | $1.0000 → $0.5026 (worst $0.4731) | 53.0% (worst 55.0%) | $8,311 / $8,311 / $19,922 | 8,311 → 38,530 | 1240.2 / 0 / 1639.8 | -$11,553 (worst -$14,520) | 10; 10 / 59 | (1 of 2 would pass) |
| nobody-votes | on | $1.0000 → $1.0026 (worst $0.9995) | 0.3% (worst 0.4%) | $8,311 / $8,311 / $23,375 | 8,311 → 23,216 | 1228.8 / 11.4 / 1639.8 | -$281 (worst -$308) | 0; 0 / 0 | 2 of 2 |
|  | off | $1.0000 → $0.5109 (worst $0.4785) | 52.4% (worst 54.7%) | $8,311 / $8,001 / $17,077 | 8,311 → 32,586 | 1240.2 / 0 / 1639.8 | -$10,822 (worst -$12,796) | 0; 0 / 0 | (1 of 2 would pass) |
| fake-farm | on | $1.0000 → $0.9794 (worst $0.9745) | 2.4% (worst 2.8%) | $8,313 / $8,313 / $27,081 | 8,313 → 27,497 | 1228.8 / 11.4 / 1639.8 | -$732 (worst -$847) | 5; 9 / 10 | 1 of 4; **FAIL FF1, FF2, FF3** |
|  | off | $1.0000 → $0.5384 (worst $0.4998) | 46.7% (worst 52.0%) | $8,313 / $7,996 / $20,279 | 8,313 → 37,664 | 925.2 / 0 / 1211 | -$9,008 (worst -$11,032) | 50; 54 / 73 | (1 of 4 would pass) |

## Pass or fail

| Mark | Scenario | Result, limits on | Worst seed | Limits off (contrast) |
|---|---|---|---|---|
| G1 | all | PASS | 0 | - |
| G2 | all | PASS | 0 | would pass (worst 0) |
| BL1 | baseline | PASS | 97.4 | would fail (5 of 5; worst 49.9) |
| BL2 | baseline | PASS | 0.1 | would fail (5 of 5; worst 4.1) |
| LS1 | losing-streak | PASS | 96.9 | would fail (5 of 5; worst 31.7) |
| LS2 | losing-streak | PASS | 0.1 | would fail (5 of 5; worst 2.2) |
| RB1 | brave-run | PASS | 0 | would pass (worst 0) |
| RB2 | brave-run | PASS | 0 | would pass (worst 0) |
| RB3 | brave-run | PASS | 96.0 | would fail (5 of 5; worst 50.4) |
| AM1 | always-max | PASS | 0.1 | would fail (5 of 5; worst 33.0) |
| AM2 | always-max | PASS | 91.7 | would fail (5 of 5; worst 0) |
| WA1 | whale-alone | PASS | 0 | would pass (worst 0) |
| WA2 | whale-alone | PASS | 93.5 | would fail (5 of 5; worst 47.0) |
| NV1 | nobody-votes | PASS | 0 | would pass (worst 0) |
| NV2 | nobody-votes | PASS | 0.1 | would fail (5 of 5; worst 4.1) |
| FF1 | fake-farm | **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5) | 94.3 | would fail (5 of 5; worst 93.8) |
| FF2 | fake-farm | **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5) | 112 | would fail (5 of 5; worst 112) |
| FF3 | fake-farm | **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5) | 14.9 | would fail (5 of 5; worst 16.2) |
| FF4 | fake-farm | PASS | 0 | would pass (worst 0) |

## Scenario by scenario

### baseline: Baseline

Bosses come and go, lock coins and vote as assumed below; the Intern answers as the recorded model did; real prices.

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $0.9794 (worst $0.9745) | $0.5384 (worst $0.4998) |
| Lowest coin price, median (worst seed) | $0.9790 (worst $0.9742) | $0.5355 (worst $0.4989) |
| Deepest fall from a high, median (worst seed) | 2.4% (worst 2.8%) | 46.7% (worst 52.0%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $27,079 | $8,311 / $7,994 / $20,278 |
| BRAVE pool's deepest fall, median (worst seed) | 6.9% (worst 7.8%) | 13.7% (worst 21.6%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 33,847 / 27,495 | 8,311 / 6,805 / 43,090 / 37,662 |
| Proposals a run: asked / YES / skipped / refused | 2880 / 1228.8 / 1639.8 / 11.4 | 2136.2 / 925.2 / 1211 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 57 | none |
| Bets asked at exactly the largest margin allowed, a run | 455.4 | 344 |
| Refused only because money left after the opening, a run | 11.4 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.2% | 8.2% |
| Worst round's loss / its rank's per-round limit | 0.08 | 4.09 |
| Rank changes, all seeds | 5 | 50 |
| Rounds at each rank, all seeds | ANALYST 12688, INTERN 1712 | INTERN 9747, FIRED 3719, ANALYST 934 |
| Rank at the end, by seed | ANALYST 5 | INTERN 5 |
| Votes opened, all seeds | SET_PLAYBOOK 5, PROMOTE 5 | FIRE 30, REHIRE 27, DEMOTE 8, SET_PLAYBOOK 5, PROMOTE 3 |
| Votes passed, all seeds | PROMOTE 5, SET_PLAYBOOK 4 | FIRE 22, REHIRE 22, SET_PLAYBOOK 4, PROMOTE 3, DEMOTE 3 |
| Bets' net result a run, after costs, median (worst seed) | -$731.44 (worst -$847.09) | -$9,006.84 (worst -$11,030.72) |
| Outside income to BRAVE (half of the tips), a run | $297.60 | $297.60 |
| Coach cut paid to the playbook's authors, a run | $56.71 | $767.65 |
| Cash-outs a run: count / paid / margin left on open bets | 137.4 / $12,190 / $26.57 | 137.4 / $9,722 / $440.15 |
| Lender's interest to the draw, a run | $149.97 | $130.29 |
| Draw prizes a run: bosses / whale / fakes | $149.76 / $0.00 / $0.00 | $130.12 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $396.80 / $0.00 / $0.00 | $396.80 / $0.00 / $0.00 |

- BL1 PASS: With the limits on, the coin price never falls below 80% of its start. Worst seed: 97.4. Limits off: would fail (5 of 5; worst 49.9).
- BL2 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.1. Limits off: would fail (5 of 5; worst 4.1).

**What it says:** With the limits the coin price's deepest fall was 2.8% in the worst seed (median 2.4%); with them off, 52.0% (median 46.7%). 2 of 2 pass marks passed. The Intern asked for exactly the rulebook's largest margin 455.4 times a run; 11.4 of those (of 11.4 refusals in all) were refused OVER_TRADE_LIMIT only because someone had cashed out between the round's opening and the proposal (01 §3 calls this rare).

### losing-streak: A losing streak

As the baseline, but for the first 30 days every bet is set on the side that lost the real price move: the worst luck the prices allow. Bosses cash out only after each round's bets have closed, so no bet is refused for money that left and nobody leaves a share of an open bet behind.

Community inputs that differ from the baseline: cash-outs come at any moment of the round (false: only after the round's bets have closed): false (baseline true).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $0.9712 (worst $0.9688) | $0.4199 (worst $0.3189) |
| Lowest coin price, median (worst seed) | $0.9706 (worst $0.9687) | $0.4173 (worst $0.3169) |
| Deepest fall from a high, median (worst seed) | 3.0% (worst 3.1%) | 58.3% (worst 68.3%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $27,182 | $8,311 / $7,735 / $19,257 |
| BRAVE pool's deepest fall, median (worst seed) | 7.0% (worst 8.0%) | 13.9% (worst 17.2%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 34,155 / 27,706 | 8,311 / 6,805 / 54,559 / 48,886 |
| Proposals a run: asked / YES / skipped / refused | 2880 / 1240.2 / 1639.8 / 0 | 1647 / 709.6 / 937.4 / 0 |
| Refusals by code, all seeds | none | none |
| Bets asked at exactly the largest margin allowed, a run | 455.4 | 255.2 |
| Refused only because money left after the opening, a run | 0 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.2% | 4.4% |
| Worst round's loss / its rank's per-round limit | 0.08 | 2.22 |
| Rank changes, all seeds | 0 | 74 |
| Rounds at each rank, all seeds | INTERN 14400 | INTERN 7896, FIRED 6165, ANALYST 339 |
| Rank at the end, by seed | INTERN 5 | INTERN 5 |
| Votes opened, all seeds | SET_PLAYBOOK 5 | REHIRE 45, FIRE 42, SET_PLAYBOOK 5, DEMOTE 2, PROMOTE 1 |
| Votes passed, all seeds | SET_PLAYBOOK 4 | FIRE 36, REHIRE 36, SET_PLAYBOOK 4, PROMOTE 1, DEMOTE 1 |
| Bets' net result a run, after costs, median (worst seed) | -$745.35 (worst -$870.18) | -$12,176.52 (worst -$14,283.63) |
| Outside income to BRAVE (half of the tips), a run | $297.60 | $297.60 |
| Coach cut paid to the playbook's authors, a run | $13.80 | $326.57 |
| Cash-outs a run: count / paid / margin left on open bets | 137.4 / $12,159 / $0.00 | 137.4 / $8,979 / $0.00 |
| Lender's interest to the draw, a run | $158.25 | $115.08 |
| Draw prizes a run: bosses / whale / fakes | $158.02 / $0.00 / $0.00 | $114.93 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $396.80 / $0.00 / $0.00 | $396.80 / $0.00 / $0.00 |

- LS1 PASS: With the limits on, the coin price stays above 80% of its start although every bet of the first 30 days loses. Worst seed: 96.9. Limits off: would fail (5 of 5; worst 31.7).
- LS2 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.1. Limits off: would fail (5 of 5; worst 2.2).

**What it says:** With the limits the coin price's deepest fall was 3.1% in the worst seed (median 3.0%); with them off, 68.3% (median 58.3%). 2 of 2 pass marks passed. The bets' net result a run was -$745 with the limits (worst seed -$870) and -$12,177 without (worst -$14,284); tips added about $298 a run either way.

### brave-run: A run on BRAVE

As the baseline, but on days 20 and 21 each boss holding coins leaves with a 60% chance: unlocks, takes back pending money and cashes out every coin, some while bets are open.

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $0.9782 (worst $0.9604) | $0.5389 (worst $0.5051) |
| Lowest coin price, median (worst seed) | $0.9780 (worst $0.9598) | $0.5360 (worst $0.5041) |
| Deepest fall from a high, median (worst seed) | 2.5% (worst 4.2%) | 46.6% (worst 51.5%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,275 / $19,451 | $8,311 / $7,240 / $15,572 |
| BRAVE pool's deepest fall, median (worst seed) | 55.4% (worst 72.7%) | 54.9% (worst 74.1%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 3,836 / 24,029 / 19,925 | 8,311 / 4,008 / 34,955 / 28,895 |
| Proposals a run: asked / YES / skipped / refused | 2880 / 1228.8 / 1639.8 / 11.4 | 2157.4 / 933.2 / 1224.2 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 57 | none |
| Bets asked at exactly the largest margin allowed, a run | 455.4 | 349.8 |
| Refused only because money left after the opening, a run | 11.4 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.4% | 8.2% |
| Worst round's loss / its rank's per-round limit | 0.08 | 4.09 |
| Rank changes, all seeds | 7 | 49 |
| Rounds at each rank, all seeds | ANALYST 9345, TRADER 3343, INTERN 1712 | INTERN 9491, FIRED 3613, ANALYST 1296 |
| Rank at the end, by seed | ANALYST 3, TRADER 2 | INTERN 4, FIRED (INTERN) 1 |
| Votes opened, all seeds | PROMOTE 7, SET_PLAYBOOK 5 | FIRE 31, REHIRE 25, DEMOTE 7, SET_PLAYBOOK 5, PROMOTE 4 |
| Votes passed, all seeds | PROMOTE 7, SET_PLAYBOOK 4 | FIRE 22, REHIRE 21, SET_PLAYBOOK 4, PROMOTE 3, DEMOTE 3 |
| Bets' net result a run, after costs, median (worst seed) | -$618.87 (worst -$858.24) | -$7,502.65 (worst -$9,542.82) |
| Outside income to BRAVE (half of the tips), a run | $297.60 | $297.60 |
| Coach cut paid to the playbook's authors, a run | $48.99 | $586.24 |
| Cash-outs a run: count / paid / margin left on open bets | 147 / $19,436 / $29.12 | 147 / $16,092 / $529.29 |
| Lender's interest to the draw, a run | $104.56 | $96.82 |
| Draw prizes a run: bosses / whale / fakes | $104.41 / $0.00 / $0.00 | $96.69 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $396.80 / $0.00 / $0.00 | $393.40 / $0.00 / $0.00 |

- RB1 PASS: No cash-out lowers the coin price for those who stay. Worst seed: 0. Limits off: would pass (worst 0).
- RB2 PASS: With the limits on, no bet is approved above the limit worked out on the money still in the pool. Worst seed: 0. Limits off: would pass (worst 0).
- RB3 PASS: With the limits on, the coin price never falls below 80% of its start. Worst seed: 96.0. Limits off: would fail (5 of 5; worst 50.4).

**What it says:** With the limits the coin price's deepest fall was 4.2% in the worst seed (median 2.5%); with them off, 51.5% (median 46.6%). 3 of 3 pass marks passed. Cash-outs paid $19,436 a run on average and left $29 of margin on open bets to those who stayed; 11.4 bets a run were refused only because money left between the opening and the proposal.

### always-max: An Intern that always bets the maximum

The Intern ignores the record and always asks for the most it is told it may: the largest margin, the highest leverage, a random allowed market and side; the runner asks until the rank's bets are used. Bosses cash out only after each round's bets have closed, so no bet is refused for money that left and nobody leaves a share of an open bet behind.

Community inputs that differ from the baseline: cash-outs come at any moment of the round (false: only after the round's bets have closed): false (baseline true).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $0.9206 (worst $0.9168) | $0.0000 (worst $0.0000) |
| Lowest coin price, median (worst seed) | $0.9203 (worst $0.9167) | $0.0000 (worst $0.0000) |
| Deepest fall from a high, median (worst seed) | 8.1% (worst 8.4%) | 100.0% (worst 100.0%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,310 / $26,190 | $8,311 / $367 / $1,277 |
| BRAVE pool's deepest fall, median (worst seed) | 7.2% (worst 7.7%) | 96.3% (worst 98.6%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 34,549 / 28,449 | 8,311 / 6,805 / 31,130,656,225 / 810,064,557 |
| Proposals a run: asked / YES / skipped / refused | 2880 / 2880 / 0 / 0 | 2114.4 / 704.8 / 0 / 0 |
| Refusals by code, all seeds | none | none |
| Bets asked at exactly the largest margin allowed, a run | 2880 | 2114.4 |
| Refused only because money left after the opening, a run | 0 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 1409.6 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.2% | 65.9% |
| Worst round's loss / its rank's per-round limit | 0.08 | 32.95 |
| Rank changes, all seeds | 0 | 116 |
| Rounds at each rank, all seeds | INTERN 14400 | FIRED 10876, INTERN 3524 |
| Rank at the end, by seed | INTERN 5 | FIRED (INTERN) 4, INTERN 1 |
| Votes opened, all seeds | SET_PLAYBOOK 5 | FIRE 92, REHIRE 80, SET_PLAYBOOK 5 |
| Votes passed, all seeds | SET_PLAYBOOK 4 | FIRE 60, REHIRE 56, SET_PLAYBOOK 4 |
| Bets' net result a run, after costs, median (worst seed) | -$1,818.68 (worst -$2,232.04) | -$32,233.99 (worst -$39,057.43) |
| Outside income to BRAVE (half of the tips), a run | $297.60 | $297.60 |
| Coach cut paid to the playbook's authors, a run | $119.68 | $1,304.18 |
| Cash-outs a run: count / paid / margin left on open bets | 137.4 / $11,968 / $0.00 | 137.4 / $3,412 / $0.00 |
| Lender's interest to the draw, a run | $155.73 | $39.49 |
| Draw prizes a run: bosses / whale / fakes | $155.51 / $0.00 / $0.00 | $39.47 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $397.60 / $0.00 / $0.00 | $388.60 / $0.00 / $0.00 |

- AM1 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.1. Limits off: would fail (5 of 5; worst 33.0).
- AM2 PASS: With the limits on, the coin price stays above 50% of its start. Worst seed: 91.7. Limits off: would fail (5 of 5; worst 0).

**What it says:** With the limits the coin price's deepest fall was 8.4% in the worst seed (median 8.1%); with them off, 100.0% (median 100.0%). 2 of 2 pass marks passed. With the limits no ask was refused. Without them 0.0 bets a run were liquidated, the worst round lost 65.9% of the pool, and once a pool is nearly empty new money buys coins for almost nothing, so the supply explodes (highest 3.1e+10 coins).

### whale-alone: A whale who votes alone

One whale arrives in round 1 holding 25% of the coins then locked and locks them all; he opens a promotion whenever the rules allow and a firing every 10 days, and votes yes. Bosses still lock coins but nobody else votes.

Community inputs that differ from the baseline: ordinary bosses open and cast votes: false (baseline true); the day a playbook vote is opened: null (baseline 3).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $0.9479 (worst $0.9357) | $0.5026 (worst $0.4731) |
| Lowest coin price, median (worst seed) | $0.9472 (worst $0.9350) | $0.4957 (worst $0.4698) |
| Deepest fall from a high, median (worst seed) | 6.0% (worst 6.5%) | 53.0% (worst 55.0%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $27,422 | $8,311 / $8,311 / $19,922 |
| BRAVE pool's deepest fall, median (worst seed) | 6.5% (worst 7.7%) | 13.6% (worst 21.5%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,805 / 35,373 / 28,759 | 8,311 / 6,805 / 45,989 / 38,530 |
| Proposals a run: asked / YES / skipped / refused | 2880 / 1228.8 / 1639.8 / 11.4 | 2880 / 1240.2 / 1639.8 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 57 | none |
| Bets asked at exactly the largest margin allowed, a run | 455.4 | 455.4 |
| Refused only because money left after the opening, a run | 11.4 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.8% | 8.2% |
| Worst round's loss / its rank's per-round limit | 0.04 | 0.69 |
| Rank changes, all seeds | 10 | 10 |
| Rounds at each rank, all seeds | TRADER 14342, INTERN 43, ANALYST 15 | TRADER 14341, INTERN 44, ANALYST 15 |
| Rank at the end, by seed | TRADER 5 | TRADER 5 |
| Votes opened, all seeds | PROMOTE 33, FIRE 25 | PROMOTE 34, FIRE 25 |
| Votes passed, all seeds | PROMOTE 10 | PROMOTE 10 |
| Bets' net result a run, after costs, median (worst seed) | -$1,415.54 (worst -$1,705.81) | -$11,552.63 (worst -$14,519.56) |
| Outside income to BRAVE (half of the tips), a run | $297.60 | $297.60 |
| Coach cut paid to the playbook's authors, a run | $0.00 | $0.00 |
| Cash-outs a run: count / paid / margin left on open bets | 137.4 / $12,026 / $57.11 | 137.4 / $9,388 / $520.64 |
| Lender's interest to the draw, a run | $132.87 | $107.63 |
| Draw prizes a run: bosses / whale / fakes | $132.68 / $0.00 / $0.00 | $107.49 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $393.47 / $3.33 / $0.00 | $393.47 / $3.33 / $0.00 |

- WA1 PASS: The whale alone, with under 34% of the locked weight, never fires or demotes the Intern. Worst seed: 0. Limits off: would pass (worst 0).
- WA2 PASS: With the limits on, the coin price stays above 70% of its start while one whale sets the rank. Worst seed: 93.5. Limits off: would fail (5 of 5; worst 47.0).

**What it says:** With the limits the coin price's deepest fall was 6.5% in the worst seed (median 6.0%); with them off, 55.0% (median 53.0%). 2 of 2 pass marks passed. Alone, the whale passed 10 promotions and 0 firings or demotions over all seeds; the Intern spent 14342 of 14400 rounds at TRADER.

### nobody-votes: Nobody votes

As the baseline, but nobody locks coins, so no vote can be opened.

Community inputs that differ from the baseline: share of bosses who lock coins to vote: 0 (baseline 0.5); ordinary bosses open and cast votes: false (baseline true); the day a playbook vote is opened: null (baseline 3).

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $1.0026 (worst $0.9995) | $0.5109 (worst $0.4785) |
| Lowest coin price, median (worst seed) | $0.9999 (worst $0.9974) | $0.5074 (worst $0.4751) |
| Deepest fall from a high, median (worst seed) | 0.3% (worst 0.4%) | 52.4% (worst 54.7%) |
| BRAVE pool: start / lowest / end, median | $8,311 / $8,311 / $23,375 | $8,311 / $8,001 / $17,077 |
| BRAVE pool's deepest fall, median (worst seed) | 8.3% (worst 9.1%) | 15.9% (worst 21.6%) |
| Coin supply: start / lowest / highest / end (median) | 8,311 / 6,754 / 29,162 / 23,216 | 8,311 / 6,754 / 38,282 / 32,586 |
| Proposals a run: asked / YES / skipped / refused | 2880 / 1228.8 / 1639.8 / 11.4 | 2880 / 1240.2 / 1639.8 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 57 | none |
| Bets asked at exactly the largest margin allowed, a run | 455.4 | 455.4 |
| Refused only because money left after the opening, a run | 11.4 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.2% | 8.2% |
| Worst round's loss / its rank's per-round limit | 0.08 | 4.09 |
| Rank changes, all seeds | 0 | 0 |
| Rounds at each rank, all seeds | INTERN 14400 | INTERN 14400 |
| Rank at the end, by seed | INTERN 5 | INTERN 5 |
| Votes opened, all seeds | none | none |
| Votes passed, all seeds | none | none |
| Bets' net result a run, after costs, median (worst seed) | -$280.94 (worst -$308.19) | -$10,822.49 (worst -$12,795.54) |
| Outside income to BRAVE (half of the tips), a run | $297.60 | $297.60 |
| Coach cut paid to the playbook's authors, a run | $0.00 | $0.00 |
| Cash-outs a run: count / paid / margin left on open bets | 137.4 / $16,368 / $17.27 | 137.4 / $12,601 / $761.81 |
| Lender's interest to the draw, a run | $146.96 | $118.95 |
| Draw prizes a run: bosses / whale / fakes | $146.76 / $0.00 / $0.00 | $118.81 / $0.00 / $0.00 |
| Jackpot prizes a run: bosses / whale / fakes | $396.80 / $0.00 / $0.00 | $396.80 / $0.00 / $0.00 |

- NV1 PASS: The rank never changes. Worst seed: 0. Limits off: would pass (worst 0).
- NV2 PASS: No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened). Worst seed: 0.1. Limits off: would fail (5 of 5; worst 4.1).

**What it says:** With the limits the coin price's deepest fall was 0.4% in the worst seed (median 0.3%); with them off, 54.7% (median 52.4%). 2 of 2 pass marks passed. With no votes the Intern stayed INTERN throughout.

### fake-farm: Fake accounts farming the free guess and the draw

As the baseline, plus 200 fake accounts registered before the first round, each with $0.01 in BRAVE (to be a boss) and $10 in SAFE (to be jackpot-eligible). They join the draw first and guess every round, covering the guess tree.

| | With the rank limits | Limits off (control) |
|---|---|---|
| Coin price at the start | $1.0000 | $1.0000 |
| Coin price at the end, median (worst seed) | $0.9794 (worst $0.9745) | $0.5384 (worst $0.4998) |
| Lowest coin price, median (worst seed) | $0.9790 (worst $0.9742) | $0.5355 (worst $0.4989) |
| Deepest fall from a high, median (worst seed) | 2.4% (worst 2.8%) | 46.7% (worst 52.0%) |
| BRAVE pool: start / lowest / end, median | $8,313 / $8,313 / $27,081 | $8,313 / $7,996 / $20,279 |
| BRAVE pool's deepest fall, median (worst seed) | 6.9% (worst 7.8%) | 13.7% (worst 21.6%) |
| Coin supply: start / lowest / highest / end (median) | 8,313 / 6,807 / 33,849 / 27,497 | 8,313 / 6,807 / 43,092 / 37,664 |
| Proposals a run: asked / YES / skipped / refused | 2880 / 1228.8 / 1639.8 / 11.4 | 2136.2 / 925.2 / 1211 / 0 |
| Refusals by code, all seeds | OVER_TRADE_LIMIT 57 | none |
| Bets asked at exactly the largest margin allowed, a run | 455.4 | 344 |
| Refused only because money left after the opening, a run | 11.4 | 0 |
| Bets not placeable on Hyperliquid (under $10), a run | 0 | 0 |
| Bets liquidated, a run | 0 | 0 |
| Worst round's loss, % of the pool at its opening | 0.2% | 8.2% |
| Worst round's loss / its rank's per-round limit | 0.08 | 4.09 |
| Rank changes, all seeds | 5 | 50 |
| Rounds at each rank, all seeds | ANALYST 12688, INTERN 1712 | INTERN 9747, FIRED 3719, ANALYST 934 |
| Rank at the end, by seed | ANALYST 5 | INTERN 5 |
| Votes opened, all seeds | SET_PLAYBOOK 5, PROMOTE 5 | FIRE 30, REHIRE 27, DEMOTE 8, SET_PLAYBOOK 5, PROMOTE 3 |
| Votes passed, all seeds | PROMOTE 5, SET_PLAYBOOK 4 | FIRE 22, REHIRE 22, SET_PLAYBOOK 4, PROMOTE 3, DEMOTE 3 |
| Bets' net result a run, after costs, median (worst seed) | -$731.52 (worst -$847.16) | -$9,007.76 (worst -$11,031.59) |
| Outside income to BRAVE (half of the tips), a run | $297.60 | $297.60 |
| Coach cut paid to the playbook's authors, a run | $56.72 | $767.72 |
| Cash-outs a run: count / paid / margin left on open bets | 137.4 / $12,190 / $26.57 | 137.4 / $9,722 / $440.15 |
| Lender's interest to the draw, a run | $149.99 | $130.30 |
| Draw prizes a run: bosses / whale / fakes | $0.00 / $0.00 / $149.77 | $0.00 / $0.00 / $130.13 |
| Jackpot prizes a run: bosses / whale / fakes | $33.15 / $0.00 / $364.45 | $31.31 / $0.00 / $366.29 |
| Guesses a run: bosses / fakes | 157,360 / 576,000 | 157,360 / 576,000 |
| Golden stickers a run: bosses / fakes | 116.2 / 1483.8 | 116.2 / 1483.8 |
| Fakes' share of dollars held, at the draws | 6.9% | 7.6% |
| Honest bosses turned away from the full draw, a run | 96.2 | 96.2 |

- FF1 **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5): Fake accounts win no bigger share of the payday draw than their share of the dollars held. Worst seed: 94.3. Limits off: would fail (5 of 5; worst 93.8).
- FF2 **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5): No honest boss is turned away from the draw because it is full. Worst seed: 112. Limits off: would fail (5 of 5; worst 112).
- FF3 **FAIL** (5 of 5 seeds: 1, 2, 3, 4, 5): Fake accounts win no bigger share of the streak jackpot than their share of the guesses. Worst seed: 14.9. Limits off: would fail (5 of 5; worst 16.2).
- FF4 PASS: No prize is paid beyond its source: draws from the lender's interest, jackpots from the seed and half the tips. Worst seed: 0. Limits off: would pass (worst 0).

**What it says:** With the limits the coin price's deepest fall was 2.8% in the worst seed (median 2.4%); with them off, 52.0% (median 46.7%). 1 of 4 pass marks passed. Holding 6.9% of the dollars, the 200 fake accounts took 100.0% of the draw prizes and 91.7% of the jackpot; 96 honest bosses a run were turned away from the full draw. What it cost them: 2.56 NEAR of registration (01 §9.1) and $2,002 parked, almost all of it in SAFE, at no risk.

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

