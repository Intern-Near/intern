# $INTERN: the owner's options, simulated

**PROPOSALS, not current rules.** Generated 2026-11-13T15:24:05.792Z by `npm run sim -- --compare-proposals` (shadow/src/sim/options.ts). Each option is switched on alone, with the rank limits, and compared with today's rules (01-SHARED-INTERFACE.md version 1.5) on the same 5 seeds and the same 60-day windows of real Hyperliquid prices (hl-candles-2026-11-13), for 24-hour rounds (the product) and 30-minute rounds (the demo). The Intern replays `z-ai/glm-5.3-flash`'s recorded answers (2026-11-11-intern); the community is the main report's assumed one (data/sim/1440m/sim-report.md). Counts are means a run; prices and results are medians, with the worst seed.

How a blocked bet is counted: every answer is also judged the way today's rules would judge it at that moment. A good bet blocked is one today's rules would have approved and the option stopped (refused it, or did not ask while the Intern was suspended or halted); it would have won if it made money at that round's close on the real prices. The honest bosses' result is what the ordinary bosses hold at the end plus what they took out and won, minus what they paid in; the paired difference is the median over seeds of (with it − today), which leaves out the noise that both share.

## Summary

| Option | What it changes | Side effects |
|---|---|---|
| a. Three strikes | Suspends the Intern after 3 refusals in a row. The pinned model, which broke no rule when recorded, was suspended 0.2 (24 h) and 0 (30 min) times a run in the baseline, every strike a bet refused only because money left before the proposal (finding 1). A model whose answers are all malformed is suspended at its third answer and then spends 44.6 (24 h) and 2846 (30 min) rounds a run fired, where today it stays employed and every answer is refused. | A griefer cashing out a cent before each window got it suspended 0.4 (24 h) and 5.6 (30 min) times a run, stopping 0.4 good bets (24 h) and 242 good bets (30 min) a run until holders rehired it. Each suspension stops every bet until a rehire vote passes, days later, and the rehire returns the Intern at INTERN. |
| b. A drawdown halt | Stops new bets after a 10% fall of the coin price until holders vote to resume. In the worst case (always the maximum, every bet losing for 30 days, nobody voting) it tripped 0 (24 h) and 1 (30 min) times a run and the worst fall went 0.7% (same) (24 h) and 19.8% → 10.0% (30 min). | With nobody voting a halt never lifts (0 (24 h) and 1963 (30 min) rounds halted a run in the worst case, every later bet blocked: 0 good bets, 0 of them winners (24 h) and 1963 good bets, 462 of them winners (30 min)). It did not trip with nobody voting and an ordinary Intern, nor with a whale voting alone. |
| c. A record gate | Halves the limits after a week whose bets lost more than 1% of the pool. It shut 12 (24 h) and 0 (30 min) rounds a run with an Intern always betting the maximum, whose worst fall went 11.9% → 8.8% (24 h) and 8.4% (same) (30 min). At INTERN, where a bet is at most 2% of the pool and real moves are a few percent, a week rarely loses 1%: even in the worst case it shut 0 (24 h) and 0 (30 min) rounds a run. | When shut it shrinks every bet, the winners too: 24 bets shrunk and 12 stopped (5 of them winners) (24 h) and 0 bets shrunk and 0 stopped (0 of them winners) (30 min) a run with an Intern always betting the maximum, and the honest bosses' result moved -$109 (24 h) and $0 (30 min) a run. It opens again by itself as the losses leave the 7-round window: no vote needed. |
| d. A capped buy-and-burn | Buys and burns coins with 10% of winning rounds: the coin supply at the end goes 28,093 → 27,889 (24 h) and 28,449 → 28,364 (30 min) with an Intern always betting the maximum. | The coin price does not move ($1.0210 (same) (24 h) and $0.9794 → $0.9795 (30 min) in the baseline): every coin can already be cashed out at its share of the pool, so buying coins at that price only hands holders their own money in another form, while the pool, and the Intern's limits with it, shrink. It would lift the price only where the coin trades below its pool value, on a DEX, which the sim does not have. |
| e1. Rulebook max on the pool now | Ends the refusals of max-size bets for money that left before the proposal: 9 → 0 (24 h) and 11.4 → 0 (30 min) a run in the baseline, 11.4 → 0 (24 h) and 455 → 0 (30 min) against a griefer cashing out before each window. | A cash-out while the model is answering now changes the rulebook, so the answer is refused WRONG_RULEBOOK, a skip included: honest cash-outs landing in the seconds the model answers caused 0 (24 h) and 1.4 (30 min) such refusals a run in the baseline, but a griefer who times a cent for those seconds gets every proposal refused (60 (24 h) and 2880 (30 min) a run), a wider hole than today's. The max-size bets it lets through lost money on these prices: the honest bosses' result moved -$91 (24 h) and -$16 (30 min) a run in the baseline, so today's refusals had been sparing the pool by accident. |
| e2. Rulebook max on the pool now, and the runner asks again | As e1, and the runner asks again when the rulebook changed while the model answered: refused for money that left 9 → 0 (24 h) and 11.4 → 0 (30 min) a run in the baseline; against the griefer who times a cent for those seconds, WRONG_RULEBOOK 0 (24 h) and 0 (30 min) a run. | Each change costs another answer from the model (60.2 (24 h) and 2881 (30 min) re-asks a run against that griefer), and the answer asked again can differ from the first, so its "blocked" and "let through" compare two answers; the bets placed say more (15 → 22.8 (24 h) and 785 → 1241 (30 min) a run against that griefer). The max-size bets it lets through lost money on these prices: the honest bosses' result moved -$91 (24 h) and -$16 (30 min) a run in the baseline, so today's refusals had been sparing the pool by accident. A griefer sending a cash-out every few seconds could outlast the three re-asks; that costs gas, which the sim does not count. |
| f1. Lowest balance held | Counts the lowest balance held during the period: fakes' share of the draw 100.0% (same) (24 h) and 100.0% (same) (30 min); of the jackpot 83.8% (same) (24 h) and 91.7% (same) (30 min). | It stops money that comes in just for a draw or a streak, but the fake accounts here hold their $10 from the first round to the last, so it does not touch them. Honest bosses' result: $810 (same) (24 h) and $31 (same) (30 min) in the baseline. |
| f2. Held across a round boundary | Counts only money held across a round's opening: fakes' share of the draw 100.0% (same) (24 h) and 100.0% (same) (30 min); of the jackpot 83.8% (same) (24 h) and 91.7% (same) (30 min). | It stops money that comes in just for a draw or a streak, but the fake accounts here hold their $10 from the first round to the last, so it does not touch them. Honest bosses' result: $810 (same) (24 h) and $31 (same) (30 min) in the baseline. |
| f3. A draw by dollars, not by accounts | Draws by dollars and keeps the 200 places for the biggest entrants: fakes' share of the draw 100.0% → 13.2% (24 h) and 100.0% → 9.0% (30 min), holding 6.9% (24 h) and 6.9% (30 min) of the dollars; honest bosses turned away 104 → 0 (24 h) and 96.2 → 0 (30 min) a run. | It does nothing for the streak jackpot (83.8% (same) (24 h) and 91.7% (same) (30 min)): a free guess per account still lets a script cover every answer. The fakes still win a little more than their dollar share, because they joined first and count every round of every period. |
| f. f1, f2 and f3 together | All three farming fixes: fakes' share of the draw 100.0% → 13.3% (24 h) and 100.0% → 9.0% (30 min); of the jackpot 83.8% (same) (24 h) and 91.7% (same) (30 min). | The draw is fixed by f3 alone; the jackpot stays open to patient fake accounts. A jackpot free guesses cannot farm needs a cost per guess or a stake that grows with the prize: not tested here. |

## a. Three strikes (PROPOSAL)

Three refusals in a row on the Intern's own proposals suspend it, as a firing does: no new bets until holders pass a REHIRE vote, which returns it at INTERN (01 §9.2).

**Parameters:** 3 refusals, the number the owner named. Every refusal code counts, including those the Intern did not cause (money that left before the proposal), because the contract cannot tell them apart.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Suspensions a run; rounds fired: today → with it |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 → 17 | 9 (same) | 0.4 (0.2) | 0 / 0 | $810 (same) ($0) | 0.2; 0 → 1.2 |
| baseline | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 (same) ($0) | 0; 0 (same) |
| brave-run | 24 h | $1.0367 ($1.0175) (same) | 1.1% (same) | 19.6 (same) | 6.8 (same) | 0 (0) | 0 / 0 | $697 (same) ($0) | 0; 0 (same) |
| brave-run | 30 min | $0.9782 ($0.9604) (same) | 4.2% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $115 (same) ($0) | 0; 0 (same) |
| griefer-before | 24 h | $1.0200 ($1.0175) (same) | 0.0% (same) | 15 → 14.6 | 11.4 → 11 | 0.4 (0.2) | 0 / 0 | $795 → $796 ($0) | 0.4; 0 → 2.4 |
| griefer-before | 30 min | $1.0162 ($1.0134) → $1.0166 ($1.0136) | 0.0% (same) | 785 → 543 | 455 → 305 | 242 (83.2) | 0 / 0 | $785 → $808 ($28) | 5.6; 0 → 916 |
| broken-model | 24 h | $1.0202 ($1.0176) (same) | 0.0% (same) | 0 (same) | 60 → 23 | 0 (0) | 0 / 0 | $829 → $824 ($17) | 7.6; 0 → 44.6 |
| broken-model | 30 min | $1.0172 ($1.0140) (same) | 0.0% (same) | 0 (same) | 2880 → 51 | 0 (0) | 0 / 0 | $816 → $840 ($16) | 17; 0 → 2846 |

**What it changes:** Suspends the Intern after 3 refusals in a row. The pinned model, which broke no rule when recorded, was suspended 0.2 (24 h) and 0 (30 min) times a run in the baseline, every strike a bet refused only because money left before the proposal (finding 1). A model whose answers are all malformed is suspended at its third answer and then spends 44.6 (24 h) and 2846 (30 min) rounds a run fired, where today it stays employed and every answer is refused.

**Side effects:** A griefer cashing out a cent before each window got it suspended 0.4 (24 h) and 5.6 (30 min) times a run, stopping 0.4 good bets (24 h) and 242 good bets (30 min) a run until holders rehired it. Each suspension stops every bet until a rehire vote passes, days later, and the rehire returns the Intern at INTERN.

## b. A drawdown halt (PROPOSAL)

When the coin price falls 10% below its high since the Intern last started or resumed, no new bet is taken until holders pass a RESUME vote (passing like a rehire, 01 §9.2, effective two rounds later, keeping the rank). Bets already open still close.

**Parameters:** The line is on the coin price, not on BRAVE's dollars: a dollar line would halt the Intern every time holders cash out, though no holder lost anything. 10% is where the assumed community already acts on its own, and half of the 20% the pass marks allow, so the halt is the backstop when nobody acts.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Halts a run; rounds halted a run |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $810 (same) ($0) | 0; 0 |
| baseline | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 (same) ($0) | 0; 0 |
| losing-streak | 24 h | $1.0113 ($0.9992) (same) | 1.5% (same) | 26.4 (same) | 0 (same) | 0 (0) | 0 / 0 | $647 (same) ($0) | 0; 0 |
| losing-streak | 30 min | $0.9712 ($0.9688) (same) | 3.1% (same) | 1240 (same) | 0 (same) | 0 (0) | 0 / 0 | $60 (same) ($0) | 0; 0 |
| always-max | 24 h | $0.9989 ($0.9249) → $0.9989 ($0.9378) | 11.9% → 10.7% | 110 → 109 | 37.2 → 36.8 | 0.4 (0) | 0 / 0 | $611 (same) ($0) | 0.2; 0.4 |
| always-max | 30 min | $0.9206 ($0.9168) (same) | 8.4% (same) | 2880 (same) | 0 (same) | 0 (0) | 0 / 0 | -$1,109 (same) ($0) | 0; 0 |
| worst-case | 24 h | $1.0013 ($0.9995) (same) | 0.7% (same) | 60 (same) | 0 (same) | 0 (0) | 0 / 0 | $548 (same) ($0) | 0; 0 |
| worst-case | 30 min | $0.8057 ($0.8019) → $0.9095 ($0.9072) | 19.8% → 10.0% | 2880 → 917 | 0 (same) | 1963 (462) | 0 / 0 | -$2,668 → -$682 ($1,885) | 1; 1963 |
| nobody-votes | 24 h | $1.0217 ($1.0190) (same) | 0.2% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $817 (same) ($0) | 0; 0 |
| nobody-votes | 30 min | $1.0026 ($0.9995) (same) | 0.4% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $563 (same) ($0) | 0; 0 |
| whale-alone | 24 h | $1.0214 ($1.0167) (same) | 0.3% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $819 (same) ($0) | 0; 0 |
| whale-alone | 30 min | $0.9479 ($0.9357) (same) | 6.5% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | -$605 (same) ($0) | 0; 0 |

**What it changes:** Stops new bets after a 10% fall of the coin price until holders vote to resume. In the worst case (always the maximum, every bet losing for 30 days, nobody voting) it tripped 0 (24 h) and 1 (30 min) times a run and the worst fall went 0.7% (same) (24 h) and 19.8% → 10.0% (30 min).

**Side effects:** With nobody voting a halt never lifts (0 (24 h) and 1963 (30 min) rounds halted a run in the worst case, every later bet blocked: 0 good bets, 0 of them winners (24 h) and 1963 good bets, 462 of them winners (30 min)). It did not trip with nobody voting and an ordinary Intern, nor with a whale voting alone.

## c. A record gate (PROPOSAL)

When the Intern's bets of the last 7 rounds lost more than 1% of the pool in all, every limit of its rank is halved (the per-bet and per-round limits, and the rulebook's max_margin_e6 with them) until those losses drop out of the window.

**Parameters:** 7 rounds, 01's own unit (vote weight and the draw both count 7 rounds); 1% of the pool, half of INTERN's per-round limit, so one bad round does not trip it but a bad week does; halving, the simplest shrink that still lets the Intern bet.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Rounds with the limits halved, a run |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $810 (same) ($0) | 1.4 |
| baseline | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 (same) ($0) | 0 |
| losing-streak | 24 h | $1.0113 ($0.9992) (same) | 1.5% (same) | 26.4 (same) | 0 (same) | 0 (0) | 0.2 / 0 | $647 (same) ($0) | 2.4 |
| losing-streak | 30 min | $0.9712 ($0.9688) (same) | 3.1% (same) | 1240 (same) | 0 (same) | 0 (0) | 0 / 0 | $60 (same) ($0) | 0 |
| always-max | 24 h | $0.9989 ($0.9249) → $0.9939 ($0.9580) | 11.9% → 8.8% | 110 (same) | 37.2 (same) | 12 (5) | 24 / 0 | $611 → $485 (-$109) | 12 |
| always-max | 30 min | $0.9206 ($0.9168) (same) | 8.4% (same) | 2880 (same) | 0 (same) | 0 (0) | 0 / 0 | -$1,109 (same) ($0) | 0 |
| worst-case | 24 h | $1.0013 ($0.9995) (same) | 0.7% (same) | 60 (same) | 0 (same) | 0 (0) | 0 / 0 | $548 (same) ($0) | 0 |
| worst-case | 30 min | $0.8057 ($0.8019) (same) | 19.8% (same) | 2880 (same) | 0 (same) | 0 (0) | 0 / 0 | -$2,668 (same) ($0) | 0 |

**What it changes:** Halves the limits after a week whose bets lost more than 1% of the pool. It shut 12 (24 h) and 0 (30 min) rounds a run with an Intern always betting the maximum, whose worst fall went 11.9% → 8.8% (24 h) and 8.4% (same) (30 min). At INTERN, where a bet is at most 2% of the pool and real moves are a few percent, a week rarely loses 1%: even in the worst case it shut 0 (24 h) and 0 (30 min) rounds a run.

**Side effects:** When shut it shrinks every bet, the winners too: 24 bets shrunk and 12 stopped (5 of them winners) (24 h) and 0 bets shrunk and 0 stopped (0 of them winners) (30 min) a run with an Intern always betting the maximum, and the honest bosses' result moved -$109 (24 h) and $0 (30 min) a run. It opens again by itself as the losses leave the 7-round window: no vote needed.

## d. A capped buy-and-burn (PROPOSAL)

10% of each winning round's result (after the coach cut) buys coins at the coin price and burns them, at most 0.5% of BRAVE a round. In the sim the coins are bought from every holder in proportion to their unlocked coins, as if each sold a sliver at the pool's price.

**Parameters:** 10% mirrors the coach cut; the 0.5% cap keeps one lucky round from shrinking the pool by more than a quarter of INTERN's per-round limit.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Coin supply at the end: today → with it; spent buying coins, a run |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $810 (same) (-$0) | 27,417 → 27,413; $6 |
| baseline | 30 min | $0.9794 ($0.9745) → $0.9795 ($0.9745) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 → $32 ($1) | 27,495 → 27,459; $71 |
| always-max | 24 h | $0.9989 ($0.9249) (same) | 11.9% (same) | 110 (same) | 37.2 (same) | 0 (0) | 0 / 0 | $611 → $613 ($2) | 28,093 → 27,889; $228 |
| always-max | 30 min | $0.9206 ($0.9168) → $0.9207 ($0.9168) | 8.4% (same) | 2880 (same) | 0 (same) | 0 (0) | 0 / 0 | -$1,109 → -$1,103 ($5) | 28,449 → 28,364; $148 |

**What it changes:** Buys and burns coins with 10% of winning rounds: the coin supply at the end goes 28,093 → 27,889 (24 h) and 28,449 → 28,364 (30 min) with an Intern always betting the maximum.

**Side effects:** The coin price does not move ($1.0210 (same) (24 h) and $0.9794 → $0.9795 (30 min) in the baseline): every coin can already be cashed out at its share of the pool, so buying coins at that price only hands holders their own money in another form, while the pool, and the Intern's limits with it, shrink. It would lift the price only where the coin trades below its pool value, on a DEX, which the sim does not have.

## e1. Rulebook max on the pool now (PROPOSAL)

The fix the owner named for finding 1: the rulebook's max_margin_e6 is worked out on the smaller of the pool at the opening and the pool now, as checks 11 and 12 already are. A cash-out before the rulebook is fetched then only lowers the max the Intern is told. A cash-out while the model is answering changes the rulebook, so the answer is refused WRONG_RULEBOOK (check 4), whatever it was.

**Parameters:** No number to choose.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Refused for money that left: today → with it; WRONG_RULEBOOK a run; asked again a run |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 24 h | $1.0210 ($1.0122) → $1.0243 ($1.0082) | 1.1% → 1.5% | 17.4 → 26.4 | 9 → 0 | 0 (0) | 0 / 9 | $810 → $667 (-$91) | 9 → 0; 0; 0 |
| baseline | 30 min | $0.9794 ($0.9745) → $0.9776 ($0.9742) | 2.8% → 2.9% | 1229 → 1240 | 11.4 → 1.4 | 0.2 (0) | 0 / 11.2 | $31 → -$3 (-$16) | 11.4 → 0; 1.4; 0 |
| brave-run | 24 h | $1.0367 ($1.0175) → $1.0355 ($1.0146) | 1.1% → 1.4% | 19.6 → 26.4 | 6.8 → 0 | 0 (0) | 0 / 6.8 | $697 → $670 (-$61) | 6.8 → 0; 0; 0 |
| brave-run | 30 min | $0.9782 ($0.9604) → $0.9775 ($0.9610) | 4.2% → 4.1% | 1229 → 1239 | 11.4 → 2 | 0.4 (0) | 0 / 10.8 | $115 → $101 (-$17) | 11.4 → 0; 2; 0 |
| griefer-before | 24 h | $1.0200 ($1.0175) → $1.0241 ($1.0081) | 0.0% → 1.5% | 15 → 26.4 | 11.4 → 0 | 0 (0) | 0 / 11.4 | $795 → $664 (-$78) | 11.4 → 0; 0; 0 |
| griefer-before | 30 min | $1.0162 ($1.0134) → $0.9776 ($0.9741) | 0.0% → 2.9% | 785 → 1240 | 455 → 1.4 | 0.2 (0) | 0 / 455 | $785 → -$5 (-$751) | 455 → 0; 1.4; 0 |
| griefer-in-flight | 24 h | $1.0200 ($1.0175) → $1.0201 ($1.0175) | 0.0% (same) | 15 → 0 | 11.4 → 60 | 15 (6.8) | 0 / 0 | $795 → $825 ($51) | 11.4 → 0; 60; 0 |
| griefer-in-flight | 30 min | $1.0162 ($1.0134) → $1.0171 ($1.0139) | 0.0% (same) | 785 → 0 | 455 → 2880 | 785 (286) | 0 / 0 | $785 → $811 ($17) | 455 → 0; 2880; 0 |

**What it changes:** Ends the refusals of max-size bets for money that left before the proposal: 9 → 0 (24 h) and 11.4 → 0 (30 min) a run in the baseline, 11.4 → 0 (24 h) and 455 → 0 (30 min) against a griefer cashing out before each window.

**Side effects:** A cash-out while the model is answering now changes the rulebook, so the answer is refused WRONG_RULEBOOK, a skip included: honest cash-outs landing in the seconds the model answers caused 0 (24 h) and 1.4 (30 min) such refusals a run in the baseline, but a griefer who times a cent for those seconds gets every proposal refused (60 (24 h) and 2880 (30 min) a run), a wider hole than today's. The max-size bets it lets through lost money on these prices: the honest bosses' result moved -$91 (24 h) and -$16 (30 min) a run in the baseline, so today's refusals had been sparing the pool by accident.

## e2. Rulebook max on the pool now, and the runner asks again (PROPOSAL)

As e1, plus a runner change: before proposing, the runner fetches the rulebook again and, if it changed while the model was answering, asks again (up to 3 times) instead of proposing an answer that will be refused.

**Parameters:** Up to 3 asks: the proposal window (an hour, or five minutes in the demo) has room for several answers of 17 to 84 seconds (the pinned model's recorded times).

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Refused for money that left: today → with it; WRONG_RULEBOOK a run; asked again a run |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 24 h | $1.0210 ($1.0122) → $1.0243 ($1.0082) | 1.1% → 1.5% | 17.4 → 26.4 | 9 → 0 | 0 (0) | 0 / 9 | $810 → $667 (-$91) | 9 → 0; 0; 0 |
| baseline | 30 min | $0.9794 ($0.9745) → $0.9776 ($0.9742) | 2.8% → 2.9% | 1229 → 1240 | 11.4 → 0 | 0.2 (0) | 0 / 11.8 | $31 → -$3 (-$16) | 11.4 → 0; 0; 1.4 |
| brave-run | 24 h | $1.0367 ($1.0175) → $1.0355 ($1.0146) | 1.1% → 1.4% | 19.6 → 26.4 | 6.8 → 0 | 0 (0) | 0 / 6.8 | $697 → $670 (-$61) | 6.8 → 0; 0; 0 |
| brave-run | 30 min | $0.9782 ($0.9604) → $0.9775 ($0.9610) | 4.2% → 4.1% | 1229 → 1240 | 11.4 → 0 | 0.2 (0) | 0 / 11.8 | $115 → $101 (-$19) | 11.4 → 0; 0; 2 |
| griefer-before | 24 h | $1.0200 ($1.0175) → $1.0241 ($1.0081) | 0.0% → 1.5% | 15 → 26.4 | 11.4 → 0 | 0 (0) | 0 / 11.4 | $795 → $664 (-$78) | 11.4 → 0; 0; 0 |
| griefer-before | 30 min | $1.0162 ($1.0134) → $0.9776 ($0.9741) | 0.0% → 2.9% | 785 → 1240 | 455 → 0 | 0.2 (0) | 0 / 456 | $785 → -$5 (-$751) | 455 → 0; 0; 1.4 |
| griefer-in-flight | 24 h | $1.0200 ($1.0175) → $1.0216 ($1.0072) | 0.0% → 1.3% | 15 → 22.8 | 11.4 → 0 | 8.8 (4.2) | 0 / 16.6 | $795 → $749 (-$20) | 11.4 → 0; 0; 60.2 |
| griefer-in-flight | 30 min | $1.0162 ($1.0134) → $0.9749 ($0.9461) | 0.0% → 5.7% | 785 → 1241 | 455 → 0 | 448 (161) | 0 / 904 | $785 → -$41 (-$790) | 455 → 0; 0; 2881 |

**What it changes:** As e1, and the runner asks again when the rulebook changed while the model answered: refused for money that left 9 → 0 (24 h) and 11.4 → 0 (30 min) a run in the baseline; against the griefer who times a cent for those seconds, WRONG_RULEBOOK 0 (24 h) and 0 (30 min) a run.

**Side effects:** Each change costs another answer from the model (60.2 (24 h) and 2881 (30 min) re-asks a run against that griefer), and the answer asked again can differ from the first, so its "blocked" and "let through" compare two answers; the bets placed say more (15 → 22.8 (24 h) and 785 → 1241 (30 min) a run against that griefer). The max-size bets it lets through lost money on these prices: the honest bosses' result moved -$91 (24 h) and -$16 (30 min) a run in the baseline, so today's refusals had been sparing the pool by accident. A griefer sending a cash-out every few seconds could outlast the three re-asks; that costs gas, which the sim does not count.

## f1. Lowest balance held (PROPOSAL)

Draw tickets count the lowest balance held during the period (at the end of each round), and jackpot eligibility needs $10 held at every round end of the last 7, not $10 now.

**Parameters:** No number to choose: the period and the 7 rounds are 01's own.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Fakes' share of the draw; of the jackpot (today → with it); honest bosses turned away a run |
|---|---|---|---|---|---|---|---|---|---|
| fake-farm | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $402 (same) ($0) | 100.0% (same); 83.8% (same); 104 (same) |
| fake-farm | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | -$476 (same) ($0) | 100.0% (same); 91.7% (same); 96.2 (same) |
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $810 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |
| baseline | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |

**What it changes:** Counts the lowest balance held during the period: fakes' share of the draw 100.0% (same) (24 h) and 100.0% (same) (30 min); of the jackpot 83.8% (same) (24 h) and 91.7% (same) (30 min).

**Side effects:** It stops money that comes in just for a draw or a streak, but the fake accounts here hold their $10 from the first round to the last, so it does not touch them. Honest bosses' result: $810 (same) (24 h) and $31 (same) (30 min) in the baseline.

## f2. Held across a round boundary (PROPOSAL)

Only money already held when the current round opened counts: to join the draw, for the draw's tickets, and for the jackpot's $10.

**Parameters:** One round boundary, as asked.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Fakes' share of the draw; of the jackpot (today → with it); honest bosses turned away a run |
|---|---|---|---|---|---|---|---|---|---|
| fake-farm | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $402 (same) ($0) | 100.0% (same); 83.8% (same); 104 → 101 |
| fake-farm | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | -$476 (same) ($0) | 100.0% (same); 91.7% (same); 96.2 → 96 |
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $810 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |
| baseline | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |

**What it changes:** Counts only money held across a round's opening: fakes' share of the draw 100.0% (same) (24 h) and 100.0% (same) (30 min); of the jackpot 83.8% (same) (24 h) and 91.7% (same) (30 min).

**Side effects:** It stops money that comes in just for a draw or a streak, but the fake accounts here hold their $10 from the first round to the last, so it does not touch them. Honest bosses' result: $810 (same) (24 h) and $31 (same) (30 min) in the baseline.

## f3. A draw by dollars, not by accounts (PROPOSAL)

Each of the draw's prizes (70%, then ten shares of 3%) is drawn by tickets with replacement, so an account's expected prize is its share of the tickets however the money is split; when the draw is full, a newcomer holding more takes the place of the entrant holding least.

**Parameters:** No number to choose: the prize split and the 200 places stay as they are.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Fakes' share of the draw; of the jackpot (today → with it); honest bosses turned away a run |
|---|---|---|---|---|---|---|---|---|---|
| fake-farm | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $402 → $499 ($103) | 100.0% → 13.2%; 83.8% (same); 104 → 0 |
| fake-farm | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | -$476 → -$345 ($130) | 100.0% → 9.0%; 91.7% (same); 96.2 → 0 |
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $810 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |
| baseline | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |

**What it changes:** Draws by dollars and keeps the 200 places for the biggest entrants: fakes' share of the draw 100.0% → 13.2% (24 h) and 100.0% → 9.0% (30 min), holding 6.9% (24 h) and 6.9% (30 min) of the dollars; honest bosses turned away 104 → 0 (24 h) and 96.2 → 0 (30 min) a run.

**Side effects:** It does nothing for the streak jackpot (83.8% (same) (24 h) and 91.7% (same) (30 min)): a free guess per account still lets a script cover every answer. The fakes still win a little more than their dollar share, because they joined first and count every round of every period.

## f. f1, f2 and f3 together (PROPOSAL)

All three fixes for fake-account farming at once.

**Parameters:** As above.

| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | Fakes' share of the draw; of the jackpot (today → with it); honest bosses turned away a run |
|---|---|---|---|---|---|---|---|---|---|
| fake-farm | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $402 → $499 ($103) | 100.0% → 13.3%; 83.8% (same); 104 → 0 |
| fake-farm | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | -$476 → -$345 ($130) | 100.0% → 9.0%; 91.7% (same); 96.2 → 0 |
| baseline | 24 h | $1.0210 ($1.0122) (same) | 1.1% (same) | 17.4 (same) | 9 (same) | 0 (0) | 0 / 0 | $810 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |
| baseline | 30 min | $0.9794 ($0.9745) (same) | 2.8% (same) | 1229 (same) | 11.4 (same) | 0 (0) | 0 / 0 | $31 (same) ($0) | 0.0% (same); 0.0% (same); 0 (same) |

**What it changes:** All three farming fixes: fakes' share of the draw 100.0% → 13.3% (24 h) and 100.0% → 9.0% (30 min); of the jackpot 83.8% (same) (24 h) and 91.7% (same) (30 min).

**Side effects:** The draw is fixed by f3 alone; the jackpot stays open to patient fake accounts. A jackpot free guesses cannot farm needs a cost per guess or a stake that grows with the prize: not tested here.

## The abuse table

From the runs under today's rules (and, for the risk left, with the fixes above). Per day is the 60-day run divided by 60; the cases are listed in shadow/src/sim/options.ts.

| Attack | What it costs the attacker | What it captures | The defence today | The risk left |
|---|---|---|---|---|
| 200 fake accounts farm the payday draw | 2.56 NEAR of registration (01 §9.1); $2,002 parked, $2 of it in BRAVE, the rest in SAFE at no risk | 24 h: $1.88 a day, $113 a run (100.0% of the draw, holding 6.9% of the dollars); 104 honest bosses turned away a run; 30 min: $2.50 a day, $150 a run (100.0% of the draw, holding 6.9% of the dollars); 96.2 honest bosses turned away a run | None: the draw's 200 places go to whoever joins first, and every runner-up gets the same share whatever its tickets (01 §9.7) | 24 h: all of the draw today; with f3, 13.2%; 30 min: all of the draw today; with f3, 9.0% |
| The same 200 accounts farm the free guess and the streak jackpot | The same accounts; each guess is free | 24 h: $5.54 a day, $332 a run (83.8% of the jackpot) and 243 golden stickers a run; 30 min: $6.07 a day, $364 a run (91.7% of the jackpot) and 1484 golden stickers a run | $10 held and a boss for 7 rounds (01 §9.7) | 24 h: most of the jackpot; with f1, f2 and f3 together still 83.8%; 30 min: most of the jackpot; with f1, f2 and f3 together still 91.7% |
| A whale with 25% of the locked weight votes alone | 24 h: $696 of coins locked, at the Intern's risk like everyone's; 30 min: $696 of coins locked, at the Intern's risk like everyone's | 24 h: control of the rank: TRADER 31.3% of the time; no money directly; 30 min: control of the rank: TRADER 99.6% of the time; no money directly | Promote needs 20% of the locked weight to vote and a majority; fire and demote need 34% of all locked weight; weight grows over 7 rounds; the limits never change (01 §9.2, §3) | With 20% of the locked weight a whale promotes the Intern alone when nobody else votes; with 34% it fires it alone |
| The whale votes in a playbook of his own | As above | 24 h: the coach cut: $0.08 a day, $5 a run; 30 min: the coach cut: $2.78 a day, $167 a run | SET_PLAYBOOK passes like a promotion (01 §9.5); the cut is 10% of winning rounds only | 10% of every winning round goes to him for as long as the playbook stays |
| A vote sniper buys 40% of the locked coins on day 10 and opens a firing every round | 24 h: $2,306 of coins locked; 30 min: $2,210 of coins locked | 24 h: fires the Intern 7 rounds after locking; 10.8 rounds fired a run; 30 min: fires the Intern 7 rounds after locking; 499 rounds fired a run | Only coins locked before a vote opened count, and their weight grows over 7 rounds (01 §9.2): no firing on fresh coins | Anyone who holds 34% of the locked weight for about a week can fire the Intern alone, as often as rehires let them |
| A griefer cashes out a cent of coins a minute before every proposal window | One NEAR transaction a round (gas not modeled); the cent stays his | 24 h: nothing for himself; every bet of exactly the largest margin is refused: 11.4 a run (honest cash-outs alone: 9); 30 min: nothing for himself; every bet of exactly the largest margin is refused: 455 a run (honest cash-outs alone: 11.4) | None (01 §3, §6.1: the rulebook's max is on the pool at the opening, the check on the smaller of that and the pool now) | 24 h: with e1, 0 a run; 30 min: with e1, 0 a run |
| The griefer times the cent for while the model answers | As above | 24 h: today the same as before the window: 11.4 max-size bets refused a run; 30 min: today the same as before the window: 455 max-size bets refused a run | As above | 24 h: with e1 every proposal is refused WRONG_RULEBOOK (60 a run, skips too); with e2 0 a run, at 60.2 extra answers; 30 min: with e1 every proposal is refused WRONG_RULEBOOK (2880 a run, skips too); with e2 0 a run, at 2881 extra answers |
| A holder leaves while a bet is losing, to dodge the loss | Their share of the margin out on open bets | Nothing: the leaver gives up their share of every open bet, win or lose (01 §9.1, 1.1); no cash-out lowered the coin price in any run (pass mark RB1) | 01 §9.1 (1.1) | None found |

### Attacks not modeled

- Trading against the Intern's open bets. Its orders and positions on Hyperliquid are public; someone large could push a thin market against a bet, or hunt its liquidation price. The sim has no market impact.
- Steering answers through the trick page. A visitor's message can make the model answer differently, but the trick page is asked after the Intern's own question (so the guess game is untouched) and the rank still bounds every bet. Trick-page proposals are not simulated.
- The runner picking among several answers (01 §6.3, §14 limit 6): the proof shows which model answered, not that the runner did not ask twice.
- Buying or renting votes from other holders, beyond one whale or sniper holding the coins themselves (01 §14 limit 7).
- Moving the coin's price on a DEX, if it is ever listed: the sim's only price is the pool's.
- A block producer biasing the payday draw (01 §14 limit 13).
- Filling the contract's 100 jackpot candidates a round with fake accounts so that honest players on six right are left out: a contract limit not in 01.
- A griefer sending cash-outs every few seconds to outlast e2's re-asks: needs NEAR gas, which the sim does not count.

