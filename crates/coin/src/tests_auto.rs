//! Automatic consequences (interface 1.7): three strikes, the drawdown brake, the term, the dead-man switch.

use super::*;
use crate::ai::decision_line;
use crate::rewards::Verdict3;
use crate::auto::{AutoState, BRAKE_ROUNDS, TERM_MS};
use near_sdk::borsh;
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

const OVER_: Decision = Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: 500_000_000, leverage: 1 };


const SMALL: Decision = Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: 11_000_000, leverage: 1 };
const TOO_BIG: Decision = Decision::Bet { market: Market::Doge, side: Side::Long, margin_e6: 500_000_000, leverage: 1 };

fn set_auto(s: &AutoState) {
    env::storage_write(b"a7s", &borsh::to_vec(s).unwrap());
}

/// Rounds `from..=to`: the Intern's first answer each round is refused (OVER_TRADE_LIMIT), a strike.
fn strike_rounds(c: &mut Coin, from: u64, to: u64) {
    for r in from..=to {
        if r > c.current.unwrap().id {
            goto(c, r, 1_000);
        }
        assert!(matches!(propose(c, r, &TOO_BIG), wire::Verdict::Nope { .. }));
    }
}

// ----- three strikes -----------------------------------------------------------------------------------------

#[test]
fn three_strikes_in_a_row_fire_an_intern() {
    let mut c = three();
    strike_rounds(&mut c, 2, 3);
    assert_eq!(c.get_auto().strikes, 2);
    assert_eq!(c.get_rank().status, Status::Employed);
    strike_rounds(&mut c, 4, 4);
    assert_eq!(c.get_rank().status, Status::Fired);
    let out = events(&c, EventName::StrikesOut);
    assert_eq!((out.len(), out[0]["action"].as_str()), (1, Some("FIRE")));
    assert_eq!(c.get_auto().strikes, 0);
}

#[test]
fn three_strikes_demote_an_analyst_and_a_skip_does_not_clear_them() {
    let mut c = three();
    c.rank.rank = 1; // ANALYST
    strike_rounds(&mut c, 2, 3);
    goto(&mut c, 4, 1_000);
    propose(&mut c, 4, &Decision::Skip); // neutral
    assert_eq!(c.get_auto().strikes, 2);
    strike_rounds(&mut c, 5, 5);
    assert_eq!((c.get_rank().rank, c.get_rank().status), (Rank::Intern, Status::Employed));
    assert_eq!(events(&c, EventName::StrikesOut)[0]["action"], "DEMOTE");
}

#[test]
fn a_second_ruling_in_a_round_and_a_refusal_outside_the_window_are_not_strikes() {
    let mut c = three();
    // Round 2: the first ruling is a SKIP; later NOPEs in the round (tricks) are not the Intern's first answer.
    propose(&mut c, 2, &Decision::Skip);
    propose(&mut c, 2, &TOO_BIG);
    assert_eq!(c.get_auto().strikes, 0);
    // Round 3: proposed before the window: OUTSIDE_WINDOW is the runner's timing, not the Intern's answer.
    goto(&mut c, 3, 1_000);
    ctx(at(3, 1_000), RUNNER, 0);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, &TOO_BIG);
    let v = c.propose(b64(rb.text.as_bytes()), b64(line.as_bytes()), b64(b"FAKE"), None, None);
    assert!(matches!(v, wire::Verdict::Nope { code: Refusal::OutsideWindow, .. }));
    assert_eq!(c.get_auto().strikes, 0);
}

// ----- the drawdown brake ------------------------------------------------------------------------------------

#[test]
fn a_week_that_lost_one_percent_halves_the_limits_for_seven_rounds() {
    let mut c = three();
    for r in 3..=8 {
        goto(&mut c, r, 1_000);
    }
    // Rounds 2..=8 settled; make round 5 a loss of $10 (1% of alice's $1,000), as a settled bet would.
    let mut r5 = *c.rounds.get(&5).unwrap();
    r5.result = -10_000_000;
    c.rounds.insert(5, r5);
    goto(&mut c, 9, 1_000);
    let on = events(&c, EventName::BrakeOn);
    assert_eq!((on.len(), on[0]["until_round"].as_u64()), (1, Some(9 + BRAKE_ROUNDS)));
    assert!(c.get_auto().brake_on);
    ctx(at(9, IN_WINDOW), RUNNER, 0);
    let text = c.get_rulebook().text;
    assert!(text.contains("max_margin_e6: 10000000"), "halved from $20: {text}");
    assert!(text.contains("brake: the pool lost 1% or more over the last 7 rounds; the dollar limits are halved until round 16"));
    // $10 is refused now ($11 is the minimum notional, over the halved limit); it lifts in round 16.
    assert!(matches!(propose(&mut c, 9, &SMALL), wire::Verdict::Nope { code: Refusal::OverTradeLimit, .. }));
    for r in 10..=16 {
        goto(&mut c, r, 1_000);
    }
    assert_eq!(events(&c, EventName::BrakeOff).len(), 1);
    ctx(at(16, IN_WINDOW), RUNNER, 0);
    assert!(c.get_rulebook().text.contains("max_margin_e6: 20000000"));
    assert!(!c.get_auto().brake_on);
}

// ----- the term ----------------------------------------------------------------------------------------------

#[test]
fn the_term_lapses_unless_renewed() {
    let mut c = three();
    ctx(at(2, 2_000), "anyone.test", 0);
    let ends = c.get_auto().term_ends_at;
    assert!(ends >= at(2, 0) + TERM_MS - ROUND && ends <= at(2, 2_000) + TERM_MS);
    // A RENEW vote: alice locks, opens, votes, finishes: 30 more days from the term's end.
    ctx(at(2, 1_500), "alice.test", 0);
    c.lock(U128(500_000_000));
    goto(&mut c, 4, 1_000);
    ctx(at(4, 2_000), "alice.test", 0);
    let id = c.open_vote(wire::VoteKind::Renew, None);
    ctx(at(4, 2_100), "alice.test", 0);
    c.cast(id, true);
    goto(&mut c, 5, 3_000);
    ctx(at(5, 3_000), "anyone.test", 0);
    assert_eq!(c.finish_vote(id).state, wire::VoteState::Passed);
    let renewed = c.get_auto().term_ends_at;
    assert_eq!(renewed, ends + TERM_MS);
    assert_eq!(events(&c, EventName::TermRenewed).len(), 1);
    // The term runs out: the next round that opens fires the Intern.
    let mut s: AutoState = borsh::from_slice(&env::storage_read(b"a7s").unwrap()).unwrap();
    s.term_ends_at = at(6, 0);
    set_auto(&s);
    goto(&mut c, 6, 1_000);
    assert_eq!(c.get_rank().status, Status::Fired);
    assert_eq!(events(&c, EventName::TermLapsed).len(), 1);
}

// ----- the dead-man switch -----------------------------------------------------------------------------------

#[test]
fn a_bet_with_no_result_can_be_abandoned_three_rounds_after_its_close() {
    let mut c = three();
    let wire::Verdict::Yes { position_id } = propose(&mut c, 2, &SMALL) else { panic!("approved") };
    let from = c.get_auto().abandon_from.expect("a round with an open bet");
    // Too early: refused.
    ctx(from - 1, "anyone.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| drop(c.abandon(2)))).is_err());
    // On time: the bet is booked as lost, the Intern is fired, the round settles.
    ctx_full(from, "anyone.test", 0, vec![]);
    let _ = c.abandon(2);
    let p = c.get_positions(Some(2)).into_iter().find(|p| p.id == position_id).unwrap();
    assert_eq!((p.returned, p.result_source), (Some(U128(0)), Some(wire::ResultSource::Abandoned)));
    assert_eq!(c.get_rank().status, Status::Fired);
    assert_eq!(events(&c, EventName::Abandoned)[0]["bets_booked_lost"], 1);
}
