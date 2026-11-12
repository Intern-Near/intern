//! Property tests for the rules (Engine 1 brief, step 2.7). Run with `cargo test -p rules`.

use proptest::prelude::*;
use rules::checks::{check_bet, rule, Ctx, Ruling};
use rules::clock::{next_slot, phase_at, slot_at, Offsets, Phase, DEMO, REAL};
use rules::limits::{dollar_limits, limit_base, limits, MIN_NOTIONAL};
use rules::shares::{self, convert, open_round_mint, redeem, OpenMint, LOCKED_FOREVER};
use rules::vote::{self, can_finish_early, passed, weight, Tally, VoteKind, RULES};
use rules::{Decision, Market, Rank, Refusal, Side, Status};
use std::cell::Cell;

fn any_rank() -> impl Strategy<Value = Rank> {
    prop::sample::select(Rank::ALL.to_vec())
}
fn any_market() -> impl Strategy<Value = Market> {
    prop::sample::select(Market::ALL.to_vec())
}
fn any_side() -> impl Strategy<Value = Side> {
    prop::sample::select(Side::ALL.to_vec())
}
fn any_offsets() -> impl Strategy<Value = Offsets> {
    prop::sample::select(vec![REAL, DEMO])
}

/// Margins mostly in the interesting range, sometimes anywhere.
fn margin() -> impl Strategy<Value = u128> {
    prop_oneof![
        4 => 0u128..=300_000_000,
        1 => any::<u128>(),
    ]
}
fn leverage() -> impl Strategy<Value = u32> {
    prop_oneof![8 => 0u32..=4, 1 => any::<u32>()]
}
fn pool() -> impl Strategy<Value = u128> {
    prop_oneof![8 => 0u128..=5_000_000_000, 1 => any::<u128>()]
}

fn in_window(o: &Offsets) -> u64 {
    o.propose_from_ms + 1
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2_000, ..ProptestConfig::default() })]

    /// Section 7 order: the code returned is the first check, in order, whose condition fails,
    /// for any input at all. Checks 3–5 are asked exactly when 1–2 pass.
    #[test]
    fn the_first_failing_check_wins(
        offsets in any_offsets(),
        ms in prop_oneof![3 => 0u64..=100_000_000, 1 => any::<u64>()],
        fired in any::<bool>(),
        rank in any_rank(),
        at_open in pool(),
        now in pool(),
        bets_used in prop_oneof![4 => 0u32..=4, 1 => any::<u32>()],
        at_risk in prop_oneof![4 => 0u128..=300_000_000, 1 => any::<u128>()],
        verify_fails in prop::option::of(prop::sample::select(vec![
            Refusal::BadModelSignature, Refusal::WrongRulebook, Refusal::MalformedDecision])),
        skip in prop::bool::weighted(0.1),
        market in any_market(), side in any_side(), m in margin(), lev in leverage(),
    ) {
        let status = if fired { Status::Fired } else { Status::Employed };
        let ctx = Ctx { offsets, ms_into_round: ms, status, rank, brave_at_open: at_open, brave_now: now, bets_used, at_risk };
        let d = if skip { Decision::Skip } else { Decision::Bet { market, side, margin_e6: m, leverage: lev } };
        let asked = Cell::new(false);
        let got = rule(&ctx, || { asked.set(true); verify_fails.map_or(Ok(d), Err) }, |_| Ok(()));

        // The conditions of section 7, written out a second time, in order.
        let l = limits(rank);
        let base = at_open.min(now);
        let per_bet = base / 10_000 * l.per_bet_bps as u128 + base % 10_000 * l.per_bet_bps as u128 / 10_000;
        let per_round = base / 10_000 * l.per_round_bps as u128 + base % 10_000 * l.per_round_bps as u128 / 10_000;
        let notional = m.saturating_mul(lev as u128);
        let gate = [
            (Refusal::OutsideWindow, phase_at(&offsets, ms) != Phase::Propose),
            (Refusal::Fired, fired),
        ];
        let bet = [
            (Refusal::NotOnList, !l.markets.contains(&market)),
            (Refusal::ShortNotUnlocked, !l.sides.contains(&side)),
            (Refusal::ZeroMargin, m == 0 || notional < MIN_NOTIONAL),
            (Refusal::OverLeverage, lev > l.max_leverage),
            (Refusal::TooManyTrades, bets_used >= l.max_bets),
            (Refusal::OverTradeLimit, m > per_bet),
            (Refusal::OverRoundLimit, at_risk.saturating_add(m) > per_round),
        ];
        let expect = if let Some((code, _)) = gate.iter().find(|(_, fails)| *fails) {
            prop_assert!(!asked.get(), "3-5 asked after a gate failure");
            Some(*code)
        } else {
            prop_assert!(asked.get(), "3-5 not asked");
            if let Some(code) = verify_fails { Some(code) }
            else if skip { None }
            else { bet.iter().find(|(_, fails)| *fails).map(|(c, _)| *c) }
        };
        match (expect, got) {
            (None, Ruling::Skip) => prop_assert!(skip),
            (None, Ruling::Yes(b)) => prop_assert!(!skip && b.notional == notional),
            (Some(code), Ruling::Nope { refused, .. }) => prop_assert_eq!(refused.code, code),
            (e, g) => prop_assert!(false, "expected {:?}, got {:?}", e, g),
        }
    }

    /// Whatever the AI asks for, over a whole round, with money leaving between proposals: no accepted
    /// bet breaks the rank. Every YES is on the list, on an allowed side, within the leverage cap and
    /// the exchange minimum, within the per-bet limit; the bets never outnumber `max_bets`; and the
    /// total at risk never passes the per-round limit of the base at the moment of each YES, nor of
    /// `brave_at_open`.
    #[test]
    fn accepted_bets_in_a_round_never_break_the_rank(
        rank in any_rank(),
        at_open in 0u128..=5_000_000_000,
        asks in prop::collection::vec((any_market(), any_side(), margin(), leverage(), 0u128..=10_000), 1..12),
    ) {
        let l = limits(rank);
        let mut now = at_open;
        let (mut used, mut at_risk) = (0u32, 0u128);
        for (market, side, m, lev, keep_bps) in asks {
            now = now * keep_bps / 10_000; // some money leaves (or none, at 10,000)
            let ctx = Ctx { offsets: REAL, ms_into_round: in_window(&REAL), status: Status::Employed, rank,
                            brave_at_open: at_open, brave_now: now, bets_used: used, at_risk };
            if let Ruling::Yes(b) = rule(&ctx, || Ok(Decision::Bet { market, side, margin_e6: m, leverage: lev }), |_| Ok(())) {
                let d = dollar_limits(rank, limit_base(at_open, now));
                prop_assert!(l.markets.contains(&b.market) && l.sides.contains(&b.side));
                prop_assert!(b.leverage >= 1 && b.leverage <= l.max_leverage);
                prop_assert!(b.notional == b.margin * b.leverage as u128 && b.notional >= MIN_NOTIONAL);
                prop_assert!(b.margin <= d.per_bet);
                used += 1;
                at_risk += b.margin;
                prop_assert!(at_risk <= d.per_round);
            }
            prop_assert!(used <= l.max_bets);
            prop_assert!(at_risk <= dollar_limits(rank, at_open).per_round);
        }
    }

    /// A higher rank is never stricter: a bet accepted at a lower rank is accepted at a higher one
    /// with the same counters. And money leaving never makes a refused bet pass.
    #[test]
    fn ranks_and_money_are_monotone(
        at_open in pool(), now in pool(), less_bps in 0u128..=10_000,
        bets_used in 0u32..=3, at_risk in 0u128..=300_000_000,
        market in any_market(), side in any_side(), m in margin(), lev in leverage(),
    ) {
        let ctx = |rank, now| Ctx { offsets: REAL, ms_into_round: in_window(&REAL), status: Status::Employed, rank,
                                     brave_at_open: at_open, brave_now: now, bets_used, at_risk };
        for pair in Rank::ALL.windows(2) {
            if check_bet(&ctx(pair[0], now), market, side, m, lev).is_ok() {
                prop_assert!(check_bet(&ctx(pair[1], now), market, side, m, lev).is_ok(), "{} looser than {}", pair[0], pair[1]);
            }
        }
        let lower = now / 10_000 * less_bps + now % 10_000 * less_bps / 10_000;
        for rank in Rank::ALL {
            if check_bet(&ctx(rank, lower), market, side, m, lev).is_ok() {
                prop_assert!(check_bet(&ctx(rank, now), market, side, m, lev).is_ok());
            }
            let (a, b) = (dollar_limits(rank, limit_base(at_open, lower)), dollar_limits(rank, limit_base(at_open, now)));
            prop_assert!(a.per_bet <= b.per_bet && a.per_round <= b.per_round);
        }
    }

    /// The pool never owes more than it holds. A random life of the BRAVE pool: people pay in, rounds
    /// open (pending money becomes coins at the round's rate), the Intern bets within the rank, bets
    /// come back with anything from nothing to triple, people cash out (also while a bet is open).
    /// After every step: what every coin holder could take out together is at most what the pool
    /// holds outside open bets, and the books add up.
    #[test]
    fn the_pool_never_owes_more_than_it_holds(
        ops in prop::collection::vec((0u8..5, 0usize..4, 1u128..=2_000_000_000, 0u128..=30_000), 1..60),
    ) {
        const MIN_FIRST: u128 = 10_000_000;
        let mut total: u128 = 0;        // BRAVE total: idle + in play (no lending in this model)
        let mut in_play: u128 = 0;
        let mut supply: u128 = 0;       // includes the locked units and dust
        let mut coins = [0u128; 4];
        let mut pending = [0u128; 4];
        let mut paid_in: u128 = 0;
        let mut paid_out: u128 = 0;
        let mut results: i128 = 0;
        for (op, who, amount, x) in ops {
            match op {
                // pay in
                0 => { pending[who] += amount; }
                // a round opens: convert everyone's pending at one rate
                1 if in_play == 0 => {
                    let p: u128 = pending.iter().sum();
                    if let OpenMint::Mint { rate, minted, locked } = open_round_mint(total, supply, p, MIN_FIRST).unwrap() {
                        let mut given = 0;
                        for i in 0..4 {
                            let c = convert(pending[i], rate);
                            coins[i] += c;
                            given += c;
                            pending[i] = 0;
                        }
                        prop_assert!(given + locked <= minted);
                        total += p;
                        paid_in += p;
                        supply += minted;
                    }
                }
                // the Intern bets: margin within 20% of the pool (the TRADER per-round limit)
                2 if in_play == 0 && total > 0 => {
                    let m = (total / 5).min(amount);
                    in_play = m;
                }
                // the bet comes back with returned = margin × x / 10,000 (0 to 3x)
                3 if in_play > 0 => {
                    let returned = in_play * x / 10_000;
                    results += shares::result_of(in_play, returned);
                    total = total - in_play + returned;
                    in_play = 0;
                }
                // cash out a share of one holder's coins, at any time
                4 if coins[who] > 0 => {
                    let c = (coins[who] * (x % 10_001) / 10_000).max(1);
                    let out = redeem(c, shares::held(total, in_play), supply).unwrap();
                    prop_assert!(out <= shares::held(total, in_play));
                    coins[who] -= c;
                    supply -= c;
                    total -= out;
                    paid_out += out;
                }
                _ => {}
            }
            // Invariants.
            let held = shares::held(total, in_play);
            let owed: u128 = coins.iter().filter(|c| **c > 0).map(|c| redeem(*c, held, supply).unwrap()).sum();
            prop_assert!(owed <= held, "owes {owed}, holds {held}");
            prop_assert!(in_play <= total);
            prop_assert!(coins.iter().sum::<u128>() <= supply);
            if supply > 0 { prop_assert!(supply - coins.iter().sum::<u128>() >= LOCKED_FOREVER); }
            prop_assert_eq!(total as i128, paid_in as i128 - paid_out as i128 + results, "books add up");
        }
    }

    /// Bosses' weights, counted one boss at a time, never add up to more than all the locked weight
    /// counted at once (what `locked_weight_at_open` holds), so a vote's tally never passes it.
    #[test]
    fn vote_weights_never_add_up_to_more_than_the_total(
        bosses in prop::collection::vec(prop::collection::vec((1u128..=1u128 << 80, 0u64..=40), 1..6), 1..8),
        vote_round in 0u64..=45,
    ) {
        let each: u128 = bosses.iter().map(|lots| weight(lots.iter().copied(), vote_round, &RULES)).sum();
        let all = weight(bosses.iter().flatten().copied(), vote_round, &RULES);
        prop_assert!(each <= all);
        let locked: u128 = bosses.iter().flatten().map(|(a, _)| a).sum();
        prop_assert!(all <= locked, "weight never above the coins locked");
    }

    /// More yes never turns a pass into a fail; more no never turns a fail into a pass; an early
    /// finish is always also a pass (when no more weight voted than was locked at the opening).
    #[test]
    fn vote_outcomes_are_monotone(
        kind in prop::sample::select(VoteKind::ALL.to_vec()),
        yes in 0u128..=1_000_000, no in 0u128..=1_000_000, extra in 0u128..=1_000_000, slack in 0u128..=1_000_000,
    ) {
        let locked = yes + no + slack;
        let t = Tally { yes, no, locked_weight_at_open: locked };
        let more_yes = Tally { yes: yes + extra, locked_weight_at_open: locked + extra, ..t };
        let more_no = Tally { no: no + extra, locked_weight_at_open: locked + extra, ..t };
        if passed(kind, &t, &RULES) && !kind.is_tightening() {
            // (quorum can only get easier with more votes; the share of yes only higher)
            prop_assert!(passed(kind, &more_yes, &RULES));
        }
        if kind.is_tightening() {
            if passed(kind, &t, &RULES) { prop_assert!(passed(kind, &more_yes, &RULES)); }
            if !passed(kind, &t, &RULES) { prop_assert!(!passed(kind, &more_no, &RULES)); }
            if can_finish_early(kind, &t, &RULES) { prop_assert!(passed(kind, &t, &RULES)); }
        }
        let _ = vote::effective_round(kind, 1);
    }

    /// The clock: the phase only moves forward through a round, and a slot always contains "now".
    #[test]
    fn the_clock_only_moves_forward(o in any_offsets(), a in 0u64..=200_000_000, b in 0u64..=200_000_000,
                                    genesis in 0u64..=1u64 << 50, now in 0u64..=1u64 << 51) {
        let (x, y) = (a.min(b), a.max(b));
        prop_assert!(phase_at(&o, x) <= phase_at(&o, y));
        if let Some(s) = slot_at(genesis, o.round_ms, now) {
            prop_assert!(s.started_at <= now && now < s.started_at + o.round_ms);
            prop_assert_eq!(next_slot(genesis, o.round_ms, Some(s.index), true, now), None, "never two rounds in one slot");
        } else {
            prop_assert!(now < genesis);
        }
    }
}
