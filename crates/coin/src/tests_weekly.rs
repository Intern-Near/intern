//! Leagues and the weekly review (interface 1.6). `cargo test -p coin`.

use super::*;
use crate::ai::decision_line;
use crate::rewards::Verdict3;
use crate::weekly::{GROUP_SIZE, REVIEW_BAR};
use near_sdk::serde_json::Value;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use shared::{Decision, Market, Side};
use std::panic::{catch_unwind, AssertUnwindSafe};

const ME: &str = "coin.test";
const USDC: &str = "usdc.test";
const RUNNER: &str = "runner.test";
const G: u64 = 1_794_355_200_000;
const ROUND: u64 = 86_400_000;
const IN_WINDOW: u64 = 43_260_000;
const BEFORE_CLOSE: u64 = 2_000;

fn ctx_full(now: u64, caller: &str, deposit: u128, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(ME.parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .block_timestamp(now * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300))
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn ctx(now: u64, caller: &str, deposit: u128) {
    ctx_full(now, caller, deposit, vec![]);
}
fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn at(round: u64, into: u64) -> u64 {
    G + (round - 1) * ROUND + into
}

fn coin() -> Coin {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    ctx(G + 1_000, "owner.test", 0);
    Coin::new(InitConfig {
        usdc_token: acct(USDC),
        runner: acct(RUNNER),
        round: wire::RoundConstants {
            genesis_ms: G,
            round_ms: ROUND,
            guess_close_ms: 42_900_000,
            propose_from_ms: 43_200_000,
            propose_until_ms: 46_800_000,
            close_from_ms: 79_200_000,
            tail_fade_ms: 600_000,
        },
        min_first_deposit: U128(10_000_000),
        pins: None,
        stickers: Some(acct("stickers.test")),
        launchpad: Some(acct("launch.test")),
        lender: Some(acct("lender.test")),
    })
}

fn register(c: &mut Coin, now: u64, who: &str) {
    ctx(now, who, Coin::storage_min().as_yoctonear());
    c.storage_deposit(None, None);
}

fn transfer_in(c: &mut Coin, now: u64, who: &str, amount: u128, msg: &str) -> u128 {
    ctx(now, USDC, 0);
    match c.ft_on_transfer(acct(who), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("no promise expected"),
    }
}

fn goto(c: &mut Coin, to: u64, into: u64) {
    let from = c.current.unwrap().id;
    for r in from + 1..=to {
        ctx(at(r, 1_000), "anyone.test", 0);
        c.tick();
    }
    ctx(at(to, into), "anyone.test", 0);
    c.tick();
}

fn b64(bytes: &[u8]) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn propose(c: &mut Coin, round: u64, d: &Decision) -> wire::Verdict {
    ctx(at(round, IN_WINDOW), RUNNER, 0);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, d);
    c.propose(b64(rb.text.as_bytes()), b64(line.as_bytes()), b64(b"FAKE"), None, None)
}

fn guess(c: &mut Coin, round: u64, who: &str, v: Verdict3) {
    ctx(at(round, BEFORE_CLOSE), who, 0);
    c.guess(v, None);
}

fn tick_rewards(c: &mut Coin, round: u64) {
    ctx(at(round, 3_000), "anyone.test", 0);
    c.rewards_tick();
}

fn events(c: &Coin, name: EventName) -> Vec<Value> {
    c.get_feed(None, Some(100)).into_iter().filter(|f| f.event == name).map(|f| f.data).collect()
}

/// alice has $1,000 of coins from round 2; bob and carol are registered. The clock is at the start of round 2.
fn three() -> Coin {
    let mut c = coin();
    register(&mut c, G + 2_000, "alice.test");
    assert_eq!(transfer_in(&mut c, G + 3_000, "alice.test", 1_000_000_000, r#"{"pool":"BRAVE"}"#), 0);
    register(&mut c, G + 4_000, "bob.test");
    register(&mut c, G + 5_000, "carol.test");
    goto(&mut c, 2, 1_000);
    c
}

const OVER: Decision = Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: 500_000_000, leverage: 1 };

// ----- leagues ---------------------------------------------------------------------------------------------

#[test]
fn a_league_ranks_this_weeks_guesses_and_closes_with_its_top_three() {
    let mut c = three();
    // Week 0 is rounds 1-7. Round 2: the Intern skips. alice and bob right, carol wrong.
    guess(&mut c, 2, "alice.test", Verdict3::Skip);
    guess(&mut c, 2, "bob.test", Verdict3::Skip);
    guess(&mut c, 2, "carol.test", Verdict3::Yes);
    propose(&mut c, 2, &Decision::Skip);
    // Round 3: a NOPE. alice right, bob wrong.
    goto(&mut c, 3, 1_000);
    guess(&mut c, 3, "alice.test", Verdict3::Nope);
    guess(&mut c, 3, "bob.test", Verdict3::Yes);
    assert!(matches!(propose(&mut c, 3, &OVER), wire::Verdict::Nope { .. }));
    // Round 4: carol guesses and the round has no ruling yet: waiting.
    goto(&mut c, 4, 1_000);
    guess(&mut c, 4, "carol.test", Verdict3::Skip);

    let l = c.get_league(None, None, None);
    assert_eq!((l.week, l.first_round, l.last_round, l.players, l.groups, l.group), (0, 1, 7, 3, 1, Some(0)));
    assert!(!l.closed);
    let s: Vec<(&str, u32, u32, u32, u32, u32)> = l
        .standings
        .iter()
        .map(|s| (s.account_id.as_str(), s.place, s.points, s.wrong, s.best_run, s.waiting))
        .collect();
    assert_eq!(
        s,
        vec![("alice.test", 1, 2, 0, 2, 0), ("bob.test", 2, 1, 1, 1, 0), ("carol.test", 3, 0, 1, 0, 1)]
    );
    // An account's own group.
    assert_eq!(c.get_league(None, None, Some(acct("carol.test"))).group, Some(0));
    assert_eq!(c.get_league(None, None, Some(acct("nobody.test"))).group, None);

    // Round 8 is week 1: the first rewards_tick closes week 0's league.
    goto(&mut c, 8, 1_000);
    tick_rewards(&mut c, 8);
    let l = c.get_league(Some(0), None, None);
    assert!(l.closed);
    assert_eq!(l.standings.iter().map(|s| s.account_id.as_str()).collect::<Vec<_>>(), ["alice.test", "bob.test", "carol.test"]);
    // carol's round-4 guess ended without a ruling: it counts for nothing.
    assert_eq!((l.standings[2].points, l.standings[2].waiting), (0, 0));
    let closed = events(&c, EventName::LeagueClosed);
    assert_eq!(closed.len(), 1);
    assert_eq!((closed[0]["week"].as_u64(), closed[0]["players"].as_u64()), (Some(0), Some(3)));
    assert_eq!(closed[0]["winners"][0]["account_id"], "alice.test");
    let results = c.get_league_results(0);
    assert_eq!((results.len(), results[0].top.len()), (1, 3));
    // The week's member records are gone; the closed group is still found from its results.
    assert_eq!(c.get_league(Some(0), None, Some(acct("bob.test"))).group, Some(0));
    // A second tick does not close it again.
    tick_rewards(&mut c, 8);
    assert_eq!(events(&c, EventName::LeagueClosed).len(), 1);
    // Week 1 has its own, empty league.
    assert_eq!(c.get_league(None, None, None).players, 0);
}

#[test]
fn twenty_one_players_make_two_groups() {
    let mut c = three();
    let names: Vec<String> = (0..GROUP_SIZE + 1).map(|i| format!("p{i:02}.test")).collect();
    for (i, n) in names.iter().enumerate() {
        register(&mut c, at(2, 1_100 + i as u64), n);
    }
    for n in &names {
        guess(&mut c, 2, n, Verdict3::Skip);
    }
    let w = c.get_week();
    assert_eq!((w.week, w.league_players, w.league_groups), (0, GROUP_SIZE + 1, 2));
    assert_eq!(c.get_league(None, Some(0), None).standings.len(), GROUP_SIZE as usize);
    let g1 = c.get_league(None, Some(1), None);
    assert_eq!((g1.group, g1.standings.len()), (Some(1), 1));
    assert_eq!(g1.standings[0].account_id.as_str(), "p20.test");
    assert_eq!(c.get_league(None, None, Some(acct("p20.test"))).group, Some(1));
}

// ----- the weekly review -----------------------------------------------------------------------------------

#[test]
fn the_review_counts_the_weeks_verdicts_and_refusals_and_takes_stamps_the_next_week() {
    // (An approved bet keeps its round open until it settles, so this week has no bet; the full cycle with a
    // settled bet is checked on a local node and on coin-fast.)
    let mut c = three();
    propose(&mut c, 2, &Decision::Skip);
    goto(&mut c, 3, 1_000);
    assert!(matches!(propose(&mut c, 3, &OVER), wire::Verdict::Nope { .. }));
    assert!(matches!(propose(&mut c, 3, &OVER), wire::Verdict::Nope { .. }));
    goto(&mut c, 4, 1_000);
    propose(&mut c, 4, &Decision::Skip);
    assert!(c.get_review(0).is_none());

    goto(&mut c, 8, 1_000);
    tick_rewards(&mut c, 8);
    let r = c.get_review(0).expect("written at week 1's first tick");
    assert_eq!((r.first_round, r.last_round, r.rounds), (1, 7, 7));
    assert_eq!((r.bets, r.refused, r.skipped), (0, 2, 2));
    assert!(r.best_bet.is_none() && r.worst_bet.is_none());
    assert_eq!(r.refusals.len(), 1);
    assert_eq!((r.refusals[0].code, r.refusals[0].count), (Refusal::OverTradeLimit, 2));
    assert_eq!((r.rank_start, r.rank_end), (Rank::Intern, Rank::Intern));
    assert!(r.stamping_open && !r.bar_filled && !r.backfilled);
    assert_eq!(r.pool_end.0, c.current.unwrap().brave_at_open);
    let written = events(&c, EventName::ReviewWritten);
    assert_eq!(written.len(), 1);
    assert_eq!((written[0]["week"].as_u64(), written[0]["refused"].as_u64()), (Some(0), Some(2)));
    assert_eq!(c.get_week().review_to_stamp, Some(0));
    assert_eq!(c.get_reviews(None, None).len(), 1);

    // Stamps: once per account, registered accounts only, only last week's review.
    for (i, who) in ["alice.test", "bob.test", "carol.test", "dave.test", "erin.test"].iter().enumerate() {
        if i >= 3 {
            register(&mut c, at(8, 4_000 + i as u64), who);
        }
        ctx(at(8, 5_000 + i as u64), who, 0);
        let v = c.stamp_review(0);
        assert_eq!(v.stamps, i as u32 + 1);
    }
    assert_eq!(REVIEW_BAR, 5);
    assert!(c.get_review(0).unwrap().bar_filled);
    assert_eq!(events(&c, EventName::ReviewBarFilled).len(), 1);
    ctx(at(8, 6_000), "alice.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.stamp_review(0))).is_err(), "a second stamp");
    ctx(at(8, 6_000), "stranger.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.stamp_review(0))).is_err(), "not registered");
    ctx(at(8, 6_000), "bob.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.stamp_review(1))).is_err(), "this week's review is not written");

    // Week 2: week 0's review can no longer be stamped.
    goto(&mut c, 15, 1_000);
    ctx(at(15, 7_000), "carol.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.stamp_review(0))).is_err());
    assert!(!c.get_review(0).unwrap().stamping_open);
}

#[test]
fn stamping_writes_a_due_review_if_no_tick_ran_yet() {
    let mut c = three();
    propose(&mut c, 2, &Decision::Skip);
    goto(&mut c, 8, 1_000);
    ctx(at(8, 2_000), "alice.test", 0);
    let v = c.stamp_review(0);
    assert_eq!((v.week, v.stamps, v.skipped), (0, 1, 1));
}

#[test]
fn refusals_made_before_the_first_weekly_call_are_counted_once() {
    // Two refusals in round 3 with the weekly state absent (as right after the 1.6 upgrade), then one more.
    let mut c = three();
    goto(&mut c, 3, 1_000);
    propose(&mut c, 3, &OVER);
    // Simulate a 1.5 contract upgraded now: drop the weekly state and its counters made by the first refusal.
    for k in [b"w6s".to_vec(), [b"w6c".as_slice(), &0u64.to_le_bytes()].concat()] {
        ctx(at(3, IN_WINDOW), "anyone.test", 0);
        env::storage_remove(&k);
    }
    propose(&mut c, 3, &OVER); // the first 1.6 write: counts both stored refusals, not this one twice
    propose(&mut c, 3, &OVER);
    goto(&mut c, 8, 1_000);
    tick_rewards(&mut c, 8);
    let r = c.get_review(0).unwrap();
    assert_eq!((r.refused, r.refusals[0].count), (3, 3));
}

#[test]
fn weeks_before_the_upgrade_get_a_backfilled_review_without_a_feed_event() {
    let mut c = three();
    // Weeks 0 and 1 go by with no weekly call at all (as on a 1.5 contract), then week 2's first tick.
    propose(&mut c, 2, &Decision::Skip);
    goto(&mut c, 9, 1_000);
    propose(&mut c, 9, &Decision::Skip);
    goto(&mut c, 15, 1_000);
    tick_rewards(&mut c, 15);
    let (w0, w1) = (c.get_review(0).unwrap(), c.get_review(1).unwrap());
    assert!(w0.backfilled && w1.backfilled);
    assert_eq!((w0.skipped, w1.skipped), (1, 1));
    assert!(events(&c, EventName::ReviewWritten).is_empty());
    assert_eq!(c.get_reviews(None, None).iter().map(|r| r.week).collect::<Vec<_>>(), [1, 0]);
}

// ----- 1.7 fixes -------------------------------------------------------------------------------------------

#[test]
fn after_a_cash_out_the_rulebook_states_the_limit_the_checks_will_allow() {
    // alice's $1,000 is the pool; the INTERN may bet 2%: the rulebook says $20.
    let mut c = three();
    ctx(at(2, IN_WINDOW), RUNNER, 0);
    assert!(c.get_rulebook().text.contains("max_margin_e6: 20000000"));
    // $100 leaves the pool after the opening (as a cash-out does). The limit base is now $900: the rulebook says
    // $18, the same number checks 11 and 12 use (before 1.7 it kept saying $20, and a $20 bet was refused).
    c.books.brave_total -= 100_000_000;
    ctx(at(2, IN_WINDOW), RUNNER, 0);
    let text = c.get_rulebook().text;
    assert!(text.contains("max_margin_e6: 18000000"), "{text}");
    let max = Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: 18_000_000, leverage: 1 };
    assert!(matches!(propose(&mut c, 2, &max), wire::Verdict::Yes { .. }));
}

#[test]
fn a_bet_over_the_rulebooks_maximum_after_a_cash_out_is_still_refused() {
    let mut c = three();
    c.books.brave_total -= 100_000_000;
    let old_max = Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: 20_000_000, leverage: 1 };
    assert!(matches!(
        propose(&mut c, 2, &old_max),
        wire::Verdict::Nope { code: Refusal::OverTradeLimit, .. }
    ));
}

#[test]
fn round_opened_carries_the_coin_supply_and_what_the_opening_minted() {
    // 1.7: alice's $1,000 converts at round 2's opening; the very first conversion locks 1,000 units for ever.
    let c = three();
    let opened = events(&c, EventName::RoundOpened);
    let r2 = opened.iter().find(|e| e["round_id"] == 2).expect("round 2 opened");
    let supply = c.ft_total_supply().0;
    assert_eq!(r2["coin_supply"], U128(supply).0.to_string());
    assert_eq!(r2["minted"], r2["coin_supply"], "everything in existence was minted at this opening");
    assert_eq!(r2["locked"], "1000");
    let r1 = opened.iter().find(|e| e["round_id"] == 1).expect("round 1 opened");
    assert_eq!((r1["coin_supply"].as_str(), r1["minted"].as_str()), (Some("0"), Some("0")));
}

#[test]
fn get_rebalance_says_what_a_rebalance_would_move_without_moving_it() {
    // 1.7: alice's $1,000 is idle; the INTERN's slice is 2% ($20): the rest ($980) would be lent.
    let mut c = three();
    ctx(at(2, 5_000), "anyone.test", 0);
    let v = c.get_rebalance();
    assert_eq!((v.action.as_str(), v.amount.0), ("LEND", 980_000_000));
    // Once it is lent, only the slice is idle: nothing to move.
    c.s9.lent = 980_000_000;
    assert_eq!(c.get_rebalance().action, "NONE");
    // After $15 more leaves the idle part (as a cash-out does), the slice is short: bring it back.
    c.s9.lent = 995_000_000;
    let v = c.get_rebalance();
    assert_eq!(v.action, "RECALL");
    assert!(v.amount.0 > 0 && v.amount.0 <= 15_000_000);
}

// ----- 1.7: point wagers and banking a streak -----------------------------------------------------------------

#[test]
fn wagered_points_go_to_the_right_guessers_in_proportion() {
    let mut c = three();
    // Round 2: all three guess SKIP and are right: a point each.
    for who in ["alice.test", "bob.test", "carol.test"] {
        guess(&mut c, 2, who, Verdict3::Skip);
    }
    propose(&mut c, 2, &Decision::Skip);
    // Round 3: alice wagers 1 point on SKIP, bob 1 on YES; carol wagers nothing. The Intern skips.
    goto(&mut c, 3, 1_000);
    ctx(at(3, BEFORE_CLOSE), "alice.test", 0);
    c.guess(Verdict3::Skip, Some(1));
    ctx(at(3, BEFORE_CLOSE), "bob.test", 0);
    c.guess(Verdict3::Yes, Some(1));
    guess(&mut c, 3, "carol.test", Verdict3::Skip);
    assert_eq!(c.get_rewards().wagers_this_round.map(|w| w.0), [1, 0, 1]);
    ctx(at(3, BEFORE_CLOSE), "alice.test", 0);
    assert_eq!(c.get_player(acct("alice.test")).guess.unwrap().wager, 1);
    propose(&mut c, 3, &Decision::Skip);
    // alice: 1 - 1 (staked) + 2 (her 1 × the pool of 2 / SKIP's 1) + 1 (right) = 3; bob: 1 - 1 = 0; carol: 2.
    ctx(at(3, IN_WINDOW + 1_000), "anyone.test", 0);
    let pts = |who: &str| c.get_player(acct(who)).points;
    assert_eq!((pts("alice.test"), pts("bob.test"), pts("carol.test")), (3, 0, 2));
    // More than you hold is refused.
    goto(&mut c, 4, 1_000);
    ctx(at(4, BEFORE_CLOSE), "bob.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.guess(Verdict3::Skip, Some(1))))).is_err());
}

#[test]
fn a_streak_can_be_banked_for_its_square_in_points() {
    let mut c = three();
    for r in 2..=4 {
        if r > 2 {
            goto(&mut c, r, 1_000);
        }
        guess(&mut c, r, "alice.test", Verdict3::Skip);
        propose(&mut c, r, &Decision::Skip);
    }
    goto(&mut c, 5, 1_000);
    ctx(at(5, 2_000), "alice.test", 0);
    let before = c.get_player(acct("alice.test"));
    assert_eq!((before.points, before.streak), (3, 3));
    let after = c.bank_streak();
    assert_eq!((after.points, after.streak), (3 + 9, 0));
    assert_eq!(events(&c, EventName::StreakBanked)[0]["points"], 9);
    // Nothing left to bank.
    ctx(at(5, 2_100), "alice.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.bank_streak()))).is_err());
}
