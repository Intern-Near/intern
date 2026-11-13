//! The reward ladder (interface 1.4): the free guess, golden stickers, the streak jackpot, the payday draw and
//! prizes. `cargo test -p coin`.

use super::*;
use crate::ai::decision_line;
use crate::rewards::Verdict3;
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

fn guess(c: &mut Coin, round: u64, who: &str, v: Verdict3) -> crate::rewards::PlayerView {
    ctx(at(round, BEFORE_CLOSE), who, 0);
    c.guess(v)
}

fn player(c: &Coin, who: &str) -> crate::rewards::PlayerView {
    c.get_player(acct(who))
}

fn events(c: &Coin, name: EventName) -> Vec<Value> {
    c.get_feed(None, Some(200)).into_iter().filter(|f| f.event == name).map(|f| f.data).collect()
}

/// alice has $1,000 of coins from round 2; the clock is at the start of round 2.
fn alice_in() -> Coin {
    let mut c = coin();
    register(&mut c, G + 2_000, "alice.test");
    assert_eq!(transfer_in(&mut c, G + 3_000, "alice.test", 1_000_000_000, r#"{"pool":"BRAVE"}"#), 0);
    goto(&mut c, 2, 1_000);
    c
}

/// bob pays in during round `r` (coins from round r+1).
fn bob_pays(c: &mut Coin, r: u64, dollars: u128) {
    register(c, at(r, 1_500), "bob.test");
    assert_eq!(transfer_in(c, at(r, 1_600), "bob.test", dollars, r#"{"pool":"BRAVE"}"#), 0);
}

const OVER: Decision = Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: 500_000_000, leverage: 1 };

// ----- R1 the free guess -----------------------------------------------------------------------------------

#[test]
fn a_guess_is_judged_on_the_rounds_first_ruling() {
    let mut c = alice_in();
    // Round 2: SKIP, and the Intern skips. Right: a point and a streak of 1.
    guess(&mut c, 2, "alice.test", Verdict3::Skip);
    assert_eq!(player(&c, "alice.test").guess.map(|g| g.round_id), Some(2));
    assert!(matches!(propose(&mut c, 2, &Decision::Skip), wire::Verdict::Skip));
    let p = player(&c, "alice.test");
    assert_eq!((p.points, p.streak, p.right, p.wrong), (1, 1, 1, 0));
    assert!(p.guess.is_none());
    let settled = events(&c, EventName::GuessSettled);
    assert_eq!(settled[0]["verdict"], "SKIP");
    assert_eq!((settled[0]["right"].as_u64(), settled[0]["wrong"].as_u64()), (Some(1), Some(0)));

    // Round 3: NOPE, but the Intern skips. Wrong: the streak resets.
    goto(&mut c, 3, 1_000);
    guess(&mut c, 3, "alice.test", Verdict3::Nope);
    propose(&mut c, 3, &Decision::Skip);
    let p = player(&c, "alice.test");
    assert_eq!((p.points, p.streak, p.right, p.wrong), (1, 0, 1, 1));

    // Round 4: NOPE, and the Intern is refused. Right again.
    goto(&mut c, 4, 1_000);
    guess(&mut c, 4, "alice.test", Verdict3::Nope);
    assert!(matches!(propose(&mut c, 4, &OVER), wire::Verdict::Nope { .. }));
    // A second ruling in the same round (a trick) changes nothing: the first one decided.
    propose(&mut c, 4, &Decision::Skip);
    let p = player(&c, "alice.test");
    assert_eq!((p.points, p.streak, p.best), (2, 1, 1));
}

#[test]
fn a_round_with_no_ruling_counts_for_nothing_and_a_missed_round_pauses_the_streak() {
    let mut c = alice_in();
    guess(&mut c, 2, "alice.test", Verdict3::Skip);
    propose(&mut c, 2, &Decision::Skip);
    // Round 3: no guess (the streak pauses), the Intern skips.
    goto(&mut c, 3, 1_000);
    propose(&mut c, 3, &Decision::Skip);
    // Round 4: right again: streak 2.
    goto(&mut c, 4, 1_000);
    guess(&mut c, 4, "alice.test", Verdict3::Skip);
    propose(&mut c, 4, &Decision::Skip);
    assert_eq!(player(&c, "alice.test").streak, 2);
    // Round 5: a guess, then no ruling at all (the runner was down). In round 6 it counts for nothing.
    goto(&mut c, 5, 1_000);
    guess(&mut c, 5, "alice.test", Verdict3::Yes);
    goto(&mut c, 6, 1_000);
    let p = player(&c, "alice.test");
    assert_eq!((p.points, p.streak, p.right, p.wrong), (2, 2, 2, 0));
    assert!(p.guess.is_none());
}

#[test]
fn guesses_close_before_the_window_once_per_round_and_only_registered_accounts() {
    let mut c = alice_in();
    guess(&mut c, 2, "alice.test", Verdict3::Yes);
    assert!(catch_unwind(AssertUnwindSafe(|| guess(&mut c, 2, "alice.test", Verdict3::Nope))).is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| guess(&mut c, 2, "stranger.test", Verdict3::Yes))).is_err());
    register(&mut c, at(2, 1_500), "late.test");
    ctx(at(2, 42_900_000), "late.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.guess(Verdict3::Yes))).is_err());
    assert_eq!(c.get_rewards().guesses_this_round, [1, 0, 0]);
    assert_eq!(events(&c, EventName::Guessed).len(), 1);
}

// ----- R2 golden stickers ---------------------------------------------------------------------------------

#[test]
fn golden_stickers_drop_are_capped_and_a_failed_mint_puts_them_back() {
    let mut c = alice_in();
    c.rw.golden_odds = 1; // every guess drops one (the real odds are 1 in 50)
    let p = guess(&mut c, 2, "alice.test", Verdict3::Yes);
    assert_eq!(p.goldens.len(), 1);
    let g = &p.goldens[0];
    assert_eq!(g.serial, 1);
    assert_eq!(c.get_rewards().golden_minted.iter().sum::<u32>(), 1);
    assert_eq!(events(&c, EventName::GoldenDropped).len(), 1);
    // Claimed: 0.02 NEAR; the sticker contract is asked to mint golden:<CODE>:1.
    let code = g.code;
    ctx(at(2, 3_000), "alice.test", 20_000_000_000_000_000_000_000);
    let _ = c.claim_golden(code, 1);
    assert!(player(&c, "alice.test").goldens.is_empty());
    // The mint failed: the golden sticker is back, to claim again.
    ctx_full(at(2, 3_100), ME, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_claimed(acct("alice.test"), format!("golden:{}:1", code.as_str()), claims::KIND_GOLDEN, (code as u64) << 16 | 1));
    assert_eq!(player(&c, "alice.test").goldens.len(), 1);
    // Claiming one you do not have is refused.
    ctx(at(2, 3_200), "alice.test", 20_000_000_000_000_000_000_000);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.claim_golden(code, 99)))).is_err());
    // Every code at its cap: no more drops.
    c.rw.golden_minted = vec![crate::rewards::GOLDEN_CAP; 16];
    goto(&mut c, 3, 1_000);
    assert_eq!(guess(&mut c, 3, "alice.test", Verdict3::Yes).goldens.len(), 1);
}

// ----- R3 the streak jackpot --------------------------------------------------------------------------------

#[test]
fn seven_right_in_a_row_wins_the_jackpot_only_for_an_eligible_boss() {
    let mut c = alice_in();
    // The jackpot: half of a $20 tip, and the team's $100 seed (anyone may add; no registration needed).
    assert_eq!(transfer_in(&mut c, at(2, 1_100), "alice.test", 20_000_000, r#"{"tip":{}}"#), 0);
    assert_eq!(transfer_in(&mut c, at(2, 1_200), "team.test", 100_000_000, r#"{"jackpot":{}}"#), 0);
    assert_eq!(transfer_in(&mut c, at(2, 1_300), "team.test", 500_000, r#"{"jackpot":{}}"#), 500_000); // under $1: refunded
    let rw = c.get_rewards();
    assert_eq!((rw.jackpot, rw.jackpot_added_total, rw.jackpot_from_tips_total), (U128(110_000_000), U128(100_000_000), U128(10_000_000)));
    // bob becomes a boss in round 3: too late to be eligible in round 9.
    bob_pays(&mut c, 2, 500_000_000);
    for r in 3..=9 {
        goto(&mut c, r, 1_000);
        guess(&mut c, r, "alice.test", Verdict3::Skip);
        guess(&mut c, r, "bob.test", Verdict3::Skip);
        propose(&mut c, r, &Decision::Skip);
    }
    assert!(player(&c, "alice.test").jackpot_eligible);
    assert!(!player(&c, "bob.test").jackpot_eligible);
    goto(&mut c, 10, 1_000);
    ctx(at(10, 2_000), "anyone.test", 0);
    c.rewards_tick();
    // alice alone takes the whole jackpot; bob's streak completed too, but he was not eligible.
    let a = player(&c, "alice.test");
    assert_eq!(a.prize_owed, U128(110_000_000));
    assert_eq!((a.streak, a.best, a.points), (0, 7, 7));
    assert_eq!(player(&c, "bob.test").prize_owed, U128(0));
    let rw = c.get_rewards();
    assert_eq!((rw.jackpot, rw.prizes_owed, rw.jackpot_last_won_round), (U128(0), U128(110_000_000), Some(9)));
    let won = events(&c, EventName::JackpotWon);
    assert_eq!(won.len(), 1);
    assert_eq!(won[0]["round_id"], 9);
    assert_eq!(c.get_jackpot_wins(None)[0].winners, vec![acct("alice.test")]);
    // A second tick pays nothing twice.
    c.rewards_tick();
    assert_eq!(player(&c, "alice.test").prize_owed, U128(110_000_000));

    // Claiming: 1 yocto; the prize leaves the books at once and comes back if the transfer fails.
    ctx(at(10, 3_000), "alice.test", 1);
    let _ = c.claim_prizes();
    assert_eq!(c.get_rewards().prizes_owed, U128(0));
    ctx_full(at(10, 3_100), ME, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_prize_paid(acct("alice.test"), U128(110_000_000)));
    assert_eq!(player(&c, "alice.test").prize_owed, U128(110_000_000));
    ctx(at(10, 3_200), "alice.test", 1);
    let _ = c.claim_prizes();
    ctx_full(at(10, 3_300), ME, 0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_prize_paid(acct("alice.test"), U128(110_000_000)));
    assert_eq!(events(&c, EventName::PrizePaid).len(), 1);
    ctx(at(10, 3_400), "alice.test", 1);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.claim_prizes()))).is_err()); // nothing left
}

#[test]
fn several_winners_in_one_round_split_the_jackpot() {
    let mut c = alice_in();
    bob_pays(&mut c, 2, 500_000_000);
    assert_eq!(transfer_in(&mut c, at(2, 1_700), "team.test", 100_000_001, r#"{"jackpot":{}}"#), 0);
    // Both guess right for rounds 4..=10; bob joined in round 3, so both are eligible by round 10.
    for r in 3..=10 {
        goto(&mut c, r, 1_000);
        if r >= 4 {
            guess(&mut c, r, "alice.test", Verdict3::Skip);
            guess(&mut c, r, "bob.test", Verdict3::Skip);
        }
        propose(&mut c, r, &Decision::Skip);
    }
    goto(&mut c, 11, 1_000);
    ctx(at(11, 2_000), "anyone.test", 0);
    c.rewards_tick();
    assert_eq!(player(&c, "alice.test").prize_owed, U128(50_000_000));
    assert_eq!(player(&c, "bob.test").prize_owed, U128(50_000_000));
    assert_eq!(c.get_rewards().jackpot, U128(1)); // the dust rolls over
}

// ----- R4 the payday draw ---------------------------------------------------------------------------------

fn interest(c: &mut Coin, now: u64, amount: u128) {
    ctx_full(now, ME, 0, vec![PromiseResult::Successful(format!("\"{amount}\"").into_bytes())]);
    c.on_interest();
}

#[test]
fn the_draw_pays_the_periods_interest_to_one_winner_and_shares_the_rest() {
    let mut c = alice_in();
    bob_pays(&mut c, 2, 500_000_000);
    ctx(at(2, 2_000), "alice.test", 0);
    let e = c.enter_draw();
    // $1,000 paid in is worth $999.999: the first conversion locks 1,000 units for ever (step 3).
    assert_eq!((e.since_round, e.base_usd), (2, U128(999_999_000)));
    goto(&mut c, 3, 1_000);
    ctx(at(3, 2_000), "bob.test", 0);
    c.enter_draw();
    ctx(at(3, 2_100), "bob.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.enter_draw()))).is_err()); // once
    interest(&mut c, at(3, 5_000), 7_000_000);
    assert_eq!(c.get_rewards().draw_pot, U128(7_000_000));
    // Period 0 is rounds 1..=7: not drawn before round 8.
    goto(&mut c, 7, 1_000);
    ctx(at(7, 2_000), "anyone.test", 0);
    c.rewards_tick();
    assert_eq!(c.get_rewards().draw_period, 0);
    goto(&mut c, 8, 1_000);
    ctx(at(8, 2_000), "anyone.test", 0);
    c.rewards_tick();
    let d = &c.get_draw_results(None, None)[0];
    assert_eq!(d.period, 0);
    assert_eq!(d.prize, U128(7_000_000));
    // alice: $1,000 for rounds 2..=7 (6 rounds); bob: about $500 for rounds 3..=7 (5 rounds).
    let a = player(&c, "alice.test").prize_owed.0;
    let b = player(&c, "bob.test").prize_owed.0;
    assert_eq!(a + b, 7_000_000);
    assert!((a, b) == (4_900_000, 2_100_000) || (a, b) == (2_100_000, 4_900_000));
    let rw = c.get_rewards();
    assert_eq!((rw.draw_pot, rw.prizes_owed, rw.draw_period), (U128(0), U128(7_000_000), 1));
    assert_eq!(events(&c, EventName::DrawHeld).len(), 1);
    // Nobody's deposit moved: the pool is what alice and bob paid in.
    assert_eq!(c.get_pot().brave.total, U128(1_500_000_000));
}

#[test]
fn alone_in_the_draw_takes_it_all_and_an_empty_draw_rolls_over() {
    let mut c = alice_in();
    interest(&mut c, at(2, 5_000), 3_000_000);
    // Period 0 with nobody in it: the interest rolls over.
    goto(&mut c, 8, 1_000);
    ctx(at(8, 2_000), "anyone.test", 0);
    c.rewards_tick();
    assert_eq!((c.get_rewards().draw_pot, c.get_rewards().draw_period), (U128(3_000_000), 1));
    // Period 1 (rounds 8..=14) with alice alone: all of it.
    ctx(at(8, 3_000), "alice.test", 0);
    c.enter_draw();
    goto(&mut c, 15, 1_000);
    ctx(at(15, 2_000), "anyone.test", 0);
    c.rewards_tick();
    assert_eq!(player(&c, "alice.test").prize_owed, U128(3_000_000));
    // Leaving the draw.
    ctx(at(15, 3_000), "alice.test", 0);
    c.leave_draw();
    assert!(player(&c, "alice.test").draw.is_none());
    assert_eq!(c.get_rewards().entrants, 0);
}

#[test]
fn money_added_mid_period_counts_from_the_next_period() {
    let mut c = alice_in();
    ctx(at(2, 2_000), "alice.test", 0);
    c.enter_draw();
    // alice adds $9,000 in round 4: this period's tickets still count $1,000.
    assert_eq!(transfer_in(&mut c, at(4, 1_500), "alice.test", 9_000_000_000, r#"{"pool":"BRAVE"}"#), 0);
    goto(&mut c, 5, 1_000);
    let e = player(&c, "alice.test").draw.expect("in the draw");
    assert_eq!(e.base_usd, U128(999_999_000));
    assert_eq!(e.tickets, U128(999_999_000 * 6));
}

// ----- the books ----------------------------------------------------------------------------------------------

#[test]
fn reward_money_is_held_apart_from_both_pools() {
    let mut c = alice_in();
    assert_eq!(transfer_in(&mut c, at(2, 1_100), "alice.test", 20_000_000, r#"{"tip":{}}"#), 0);
    interest(&mut c, at(2, 5_000), 2_000_000);
    let rw = c.get_rewards();
    assert_eq!(rw.jackpot.0 + rw.draw_pot.0 + rw.prizes_owed.0, 12_000_000);
    assert_eq!(c.rw.held(), 12_000_000);
    // The tip's other half waits for the pool as outside income.
    assert_eq!(c.get_pot().brave.income_waiting, U128(10_000_000));
}

#[test]
fn a_players_reward_records_fit_in_the_registration_storage() {
    let mut c = coin();
    let long: AccountId = format!("{}.test", "a".repeat(59)).parse().unwrap();
    let before = env::storage_usage();
    c.rw.players.insert(
        long.clone(),
        crate::rewards::PlayerRec {
            points: u32::MAX,
            right: u32::MAX,
            wrong: u32::MAX,
            streak: u8::MAX,
            best: u8::MAX,
            last: Some((u64::MAX, 2)),
            goldens: vec![(15, u16::MAX); 4],
        },
    );
    c.rw.entries.insert(long.clone(), crate::rewards::EntryRec { since_round: u64::MAX, base_usd: u128::MAX });
    c.rw.entrants.insert(long.clone());
    c.rw.prizes.insert(long.clone(), u128::MAX);
    c.rw.players.flush();
    c.rw.entries.flush();
    c.rw.entrants.flush();
    c.rw.prizes.flush();
    let used = env::storage_usage() - before;
    println!("a player's reward records use {used} bytes");
    assert!(used <= crate::REWARDS_ACCOUNT_BYTES, "used {used}");
}
