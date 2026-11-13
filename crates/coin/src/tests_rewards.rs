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
    c.guess(v, None)
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
    assert!(catch_unwind(AssertUnwindSafe(|| c.guess(Verdict3::Yes, None))).is_err());
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
    // 1.7: split by the BRAVE dollars each holds (alice about $1,000, bob about $500): about two to one.
    let (a, b) = (player(&c, "alice.test").prize_owed.0, player(&c, "bob.test").prize_owed.0);
    let (wa, wb) = (c.brave_usd_of(&acct("alice.test")), c.brave_usd_of(&acct("bob.test")));
    assert_eq!((a, b), (100_000_001 * wa / (wa + wb), 100_000_001 * wb / (wa + wb)));
    assert!(a > b * 19 / 10 && a < b * 21 / 10, "{a} {b}");
    assert!(c.get_rewards().jackpot.0 <= 1); // the dust rolls over
}

#[test]
fn a_full_draw_keeps_its_places_for_the_biggest_brave_holders() {
    // 1.7 (Engine 2's f3): 200 entrants with $2 each fill the draw; a newcomer with $5 takes the place of one of the
    // smallest, a newcomer with $1 is turned away.
    let mut c = alice_in();
    let names: Vec<String> = (0..crate::rewards::MAX_ENTRANTS).map(|i| format!("e{i:03}.test")).collect();
    for (i, n) in names.iter().enumerate() {
        register(&mut c, at(2, 2_000 + i as u64), n);
        assert_eq!(transfer_in(&mut c, at(2, 2_000 + i as u64), n, 2_000_000, r#"{"pool":"BRAVE"}"#), 0);
    }
    register(&mut c, at(2, 3_000), "big.test");
    assert_eq!(transfer_in(&mut c, at(2, 3_001), "big.test", 5_000_000, r#"{"pool":"BRAVE"}"#), 0);
    register(&mut c, at(2, 3_002), "small.test");
    assert_eq!(transfer_in(&mut c, at(2, 3_003), "small.test", 1_000_000, r#"{"pool":"BRAVE"}"#), 0);
    goto(&mut c, 3, 1_000);
    for (i, n) in names.iter().enumerate() {
        ctx(at(3, 2_000 + i as u64), n, 0);
        c.enter_draw();
    }
    assert_eq!(c.get_rewards().entrants, crate::rewards::MAX_ENTRANTS);
    ctx(at(3, 4_000), "small.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.enter_draw()))).is_err(), "holds less than everyone in it");
    ctx(at(3, 4_001), "big.test", 0);
    c.enter_draw();
    assert_eq!(c.get_rewards().entrants, crate::rewards::MAX_ENTRANTS);
    assert!(c.rw.entrants.contains(&acct("big.test")));
    assert_eq!(names.iter().filter(|n| c.rw.entrants.contains(&acct(n))).count(), names.len() - 1);
}

#[test]
fn money_parked_in_safe_neither_enters_the_draw_nor_makes_a_jackpot_boss() {
    // 1.7: a farming account holding $10 in SAFE and nothing in BRAVE (Engine 2's simulation) gets nothing.
    let mut c = alice_in();
    register(&mut c, at(2, 1_500), "farm.test");
    assert_eq!(transfer_in(&mut c, at(2, 1_600), "farm.test", 10_000_000, r#"{"pool":"SAFE"}"#), 0);
    ctx(at(2, 2_000), "farm.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.enter_draw()))).is_err());
    goto(&mut c, 12, 1_000);
    assert!(!player(&c, "farm.test").jackpot_eligible);
    assert!(player(&c, "alice.test").jackpot_eligible);
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
    // 1.7 (item 22): the tickets are fixed and a drand round a minute ahead is chosen; nothing is drawn yet.
    let pending = &events(&c, EventName::DrawPending)[0];
    let round = pending["drand_round"].as_u64().unwrap();
    assert_eq!(round, crate::drand::drand_round_at(at(8, 2_000) + 60_000));
    assert_eq!(c.get_rewards().draw_period, 0);
    assert_eq!(c.get_drand(None)["state"], "WAITING");
    ctx(at(8, 3_000), "anyone.test", 0);
    c.rewards_tick();
    assert_eq!(
        c.get_rewards().draw_period,
        0,
        "still waiting for the beacon"
    );
    // The beacon arrives (submit_drand verifies it; see drand.rs): the draw uses it.
    crate::drand::put_randomness(round, [7u8; 32]);
    ctx(at(8, 4_000), "anyone.test", 0);
    c.rewards_tick();
    let held = &events(&c, EventName::DrawHeld)[0];
    assert_eq!(
        (held["randomness"].as_str(), held["drand_round"].as_u64()),
        (Some("drand"), Some(round))
    );
    let v = c.get_drand(Some(0));
    assert_eq!(
        (v["state"].as_str(), v["source"].as_str()),
        (Some("HELD"), Some("drand"))
    );
    assert_eq!(v["randomness"], crate::sign::hex(&[7u8; 32]));
    // The frozen tickets stay readable, so anyone can replay the draw from the randomness.
    let t = v["tickets"].as_array().expect("tickets kept");
    assert_eq!(t.len(), 2);
    let sum: u128 = t.iter().map(|x| x[1].as_str().unwrap().parse::<u128>().unwrap()).sum();
    let d = &c.get_draw_results(None, None)[0];
    assert_eq!(U128(sum), d.tickets_total);
    assert_eq!(d.period, 0);
    assert_eq!(d.prize, U128(7_000_000));
    // alice: $1,000 for rounds 2..=7 (6 rounds); bob: about $500 for rounds 3..=7 (5 rounds).
    // 1.7: the 70% and each of the ten 3% shares (210,000) are drawn by tickets with replacement.
    let a = player(&c, "alice.test").prize_owed.0;
    let b = player(&c, "bob.test").prize_owed.0;
    assert_eq!(a + b, 7_000_000);
    let (hi, lo) = (a.max(b), a.min(b));
    assert!(hi >= 4_900_000 && (hi - 4_900_000) % 210_000 == 0 && lo % 210_000 == 0, "{a} {b}");
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
fn a_draw_without_its_beacon_falls_back_to_the_block_seed_after_two_rounds() {
    let mut c = alice_in();
    bob_pays(&mut c, 2, 500_000_000);
    ctx(at(2, 3_000), "alice.test", 0);
    c.enter_draw();
    goto(&mut c, 3, 1_000);
    ctx(at(3, 2_000), "bob.test", 0);
    c.enter_draw();
    interest(&mut c, at(3, 5_000), 7_000_000);
    goto(&mut c, 8, 1_000);
    ctx(at(8, 2_000), "anyone.test", 0);
    c.rewards_tick();
    assert_eq!(events(&c, EventName::DrawPending).len(), 1);
    goto(&mut c, 9, 1_000);
    ctx(at(9, 2_000), "anyone.test", 0);
    c.rewards_tick();
    assert_eq!(
        c.get_rewards().draw_period,
        0,
        "one round without a beacon: still waiting"
    );
    goto(&mut c, 10, 1_000);
    ctx(at(10, 2_000), "anyone.test", 0);
    c.rewards_tick();
    let held = &events(&c, EventName::DrawHeld)[0];
    assert_eq!(held["randomness"], "block");
    assert_eq!(c.get_rewards().draw_period, 1);
    assert_eq!(c.get_drand(Some(0))["source"], "block");
    let paid = player(&c, "alice.test").prize_owed.0 + player(&c, "bob.test").prize_owed.0;
    assert_eq!(paid, 7_000_000);
}

#[test]
fn a_wrong_drand_signature_is_refused() {
    let mut c = alice_in();
    ctx(at(2, 2_000), "anyone.test", 0);
    let sig = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.submit_drand(1001, sig.into())))).is_err());
    let r = c.submit_drand(1000, sig.into());
    assert_eq!(
        r,
        "fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd"
    );
    assert_eq!(events(&c, EventName::DrandSubmitted)[0]["round"], 1000);
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

// ----- R6 the long shot (1.5) ----------------------------------------------------------------------------------

const CLOSE: u64 = 79_200_000;

/// alice locks half her coins in round 2; in round 4 they weigh something, and she alone can pass a vote.
fn long_shot_passed() -> Coin {
    let mut c = alice_in();
    ctx(at(2, 1_500), "alice.test", 0);
    c.lock(U128(500_000_000));
    goto(&mut c, 4, 1_000);
    ctx(at(4, 2_000), "alice.test", 0);
    let id = c.open_vote(wire::VoteKind::LongShot, None);
    ctx(at(4, 2_100), "alice.test", 0);
    c.cast(id, true);
    // The vote runs one round length; finished in round 5, it passes and allows a ticket in round 7.
    goto(&mut c, 5, 3_000);
    ctx(at(5, 3_000), "anyone.test", 0);
    let v = c.finish_vote(id);
    assert_eq!(v.state, wire::VoteState::Passed);
    assert_eq!(v.effective_round, Some(7));
    c
}

fn ticket_bet(margin: u128, leverage: u32) -> Decision {
    Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: margin, leverage }
}

#[test]
fn a_passed_long_shot_allows_one_extra_ticket_at_10x_in_its_round_only() {
    let mut c = long_shot_passed();
    let allowed = events(&c, EventName::LongShotAllowed);
    assert_eq!(allowed[0]["round_id"], 7);
    assert_eq!(c.get_rewards().long_shot.ticket_round, Some(7));
    // Round 6: no ticket yet; 10x is refused as always, and the rulebook has no long_shot line.
    goto(&mut c, 6, 1_000);
    ctx(at(6, IN_WINDOW), RUNNER, 0);
    assert!(!c.get_rulebook().text.contains("long_shot:"));
    let margin6 = rules::limits::long_shot_margin(c.current.unwrap().brave_at_open);
    assert!(matches!(propose(&mut c, 6, &ticket_bet(margin6, 10)), wire::Verdict::Nope { code: Refusal::OverLeverage, .. }));
    // Round 7: the rulebook states the ticket exactly.
    goto(&mut c, 7, 1_000);
    let margin = rules::limits::long_shot_margin(c.current.unwrap().brave_at_open);
    ctx(at(7, IN_WINDOW), RUNNER, 0);
    let text = c.get_rulebook().text;
    assert!(text.contains(&format!("long_shot: one ticket this round: margin_e6 exactly {margin}, leverage up to 10")), "{text}");
    assert_eq!(c.get_rewards().long_shot.margin, Some(U128(margin)));
    // The ticket: approved at 10x; it does not use the rank's one bet.
    let v = propose(&mut c, 7, &ticket_bet(margin, 10));
    let wire::Verdict::Yes { position_id } = v else { panic!("the ticket: {v:?}") };
    assert_eq!(c.get_round().bets_used, 0);
    let approved = events(&c, EventName::Approved);
    assert_eq!(approved.last().unwrap()["long_shot"], true);
    assert_eq!(approved.last().unwrap()["leverage"], 10);
    // The rank's own bet is still there; a second ticket is not (the ticket is used: 10x is refused again).
    let normal = propose(&mut c, 7, &ticket_bet(11_000_000, 1));
    assert!(matches!(normal, wire::Verdict::Yes { .. }), "{normal:?}");
    assert!(matches!(propose(&mut c, 7, &ticket_bet(margin, 10)), wire::Verdict::Nope { code: Refusal::OverLeverage, .. }));
    assert!(c.get_rewards().long_shot.used);
    // Both bets settle as usual; the ticket's margin was inside the round's limit.
    ctx(at(7, CLOSE + 1_000), RUNNER, 0);
    for p in c.get_positions(Some(7)) {
        c.report_result(p.id, p.margin);
    }
    let _ = c.settle(7);
    assert!(c.get_round_by_id(7).unwrap().settled);
    let _ = position_id;
}

#[test]
fn a_round_whose_only_bet_is_the_ticket_does_not_close_itself_unsettled() {
    // 1.6 fix (found by Engine 2 reading the code): the ticket uses none of the rank's bets, so `bets_used` stays 0;
    // the round must still wait for its result like any round with a bet, not settle itself with 0.
    let mut c = long_shot_passed();
    goto(&mut c, 7, 1_000);
    let margin = rules::limits::long_shot_margin(c.current.unwrap().brave_at_open);
    let v = propose(&mut c, 7, &ticket_bet(margin, 10));
    let wire::Verdict::Yes { position_id } = v else { panic!("the ticket: {v:?}") };
    assert_eq!((c.get_round().bets_used, c.get_round().at_risk.0), (0, margin));
    // The next slot comes and the ticket is not settled: round 7 stays the current round, unsettled.
    ctx(at(8, 5_000), "anyone.test", 0);
    c.tick();
    assert_eq!(c.current.unwrap().id, 7);
    assert!(!c.get_round_by_id(7).unwrap().settled);
    assert_eq!(c.get_pot().brave.in_play.0, margin, "the ticket's margin is still in play");
    // Reported and settled late, it settles normally; then round 8 opens.
    ctx(at(8, 6_000), RUNNER, 0);
    c.report_result(position_id, U128(margin));
    let _ = c.settle(7);
    assert!(c.get_round_by_id(7).unwrap().settled);
    assert_eq!(c.get_pot().brave.in_play.0, 0);
}

#[test]
fn a_new_long_shot_vote_waits_seven_rounds_after_the_last_ticket() {
    let mut c = long_shot_passed();
    goto(&mut c, 8, 1_000);
    ctx(at(8, 2_000), "alice.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.open_vote(wire::VoteKind::LongShot, None))).is_err());
    assert_eq!(c.get_rewards().long_shot.vote_from_round, 14);
    goto(&mut c, 14, 1_000);
    ctx(at(14, 2_000), "alice.test", 0);
    let id = c.open_vote(wire::VoteKind::LongShot, None);
    assert!(id > 0);
}

#[test]
fn no_long_shot_while_fired() {
    let mut c = alice_in();
    c.rank.status = 1; // FIRED
    ctx(at(2, 1_500), "alice.test", 0);
    c.lock(U128(500_000_000));
    goto(&mut c, 4, 1_000);
    ctx(at(4, 2_000), "alice.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.open_vote(wire::VoteKind::LongShot, None))).is_err());
}
