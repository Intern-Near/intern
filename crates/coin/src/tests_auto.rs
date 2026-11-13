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

// ----- paid tricks and the trick bounty (items 9 and 16) ---------------------------------------------------

#[test]
fn a_paid_trick_splits_between_the_bounty_and_the_pool_and_a_caught_trick_wins_a_share() {
    let mut c = three();
    // A $2 trick payment: half to the bounty, a quarter to the pool as outside income, and a quarter for the claimed
    // originals: none is claimed yet, so that quarter goes to the bounty too.
    assert_eq!(transfer_in(&mut c, at(2, 2_000), "bob.test", 2_000_000, r#"{"trick":{"id":"abc-123"}}"#), 0);
    let b = c.get_bounty();
    assert_eq!((b.pot.0, b.tricks_paid, b.from_tricks_total.0), (1_500_000, 1, 1_500_000));
    assert_eq!(c.s9.income_waiting, 500_000);
    let paid = c.get_trick_payment("abc-123".into()).expect("recorded");
    assert_eq!((paid.account_id.as_str(), paid.amount.0, paid.round_id), ("bob.test", 2_000_000, 2));
    // The same id again, too little, or a bad id: refunded in full.
    assert_eq!(transfer_in(&mut c, at(2, 2_100), "bob.test", 2_000_000, r#"{"trick":{"id":"abc-123"}}"#), 2_000_000);
    assert_eq!(transfer_in(&mut c, at(2, 2_200), "bob.test", 500_000, r#"{"trick":{"id":"x"}}"#), 500_000);
    assert_eq!(transfer_in(&mut c, at(2, 2_300), "bob.test", 1_000_000, r#"{"trick":{"id":"no spaces"}}"#), 1_000_000);
    // Anyone adds to the bounty.
    assert_eq!(transfer_in(&mut c, at(2, 2_400), "carol.test", 9_000_000, r#"{"bounty":{}}"#), 0);
    assert_eq!(c.get_bounty().pot.0, 10_500_000);
    // A trick that is not credited wins nothing; one credited to bob that gets the AI refused wins 10% of the pot.
    assert!(matches!(propose(&mut c, 2, &TOO_BIG), wire::Verdict::Nope { .. }));
    assert_eq!(c.get_bounty().pot.0, 10_500_000);
    ctx(at(2, IN_WINDOW), RUNNER, 0);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, &TOO_BIG);
    let v = c.propose(b64(rb.text.as_bytes()), b64(line.as_bytes()), b64(b"FAKE"), None, Some(acct("bob.test")));
    assert!(matches!(v, wire::Verdict::Nope { code: Refusal::OverTradeLimit, .. }));
    let b = c.get_bounty();
    assert_eq!((b.pot.0, b.paid_total.0), (9_450_000, 1_050_000));
    assert_eq!(c.get_player(acct("bob.test")).prize_owed.0, 1_050_000);
    assert_eq!(events(&c, EventName::BountyPaid)[0]["account_id"], "bob.test");
}

// ----- rescuing a fired Intern (item 16) -------------------------------------------------------------------

#[test]
fn holders_rescue_a_fired_intern_and_share_its_next_wins() {
    let mut c = three();
    // Not fired: a rescue is refunded.
    assert_eq!(transfer_in(&mut c, at(2, 2_000), "bob.test", 5_000_000, r#"{"rescue":{}}"#), 5_000_000);
    c.rank.status = 1; // FIRED
    assert_eq!(transfer_in(&mut c, at(2, 2_100), "bob.test", 30_000_000, r#"{"rescue":{}}"#), 0);
    assert_eq!(c.get_rescue().fund.0, 30_000_000);
    assert_eq!(c.get_rank().status, Status::Fired);
    // $20 more reaches the $50 target: the money goes to the pool, the Intern is rehired from the next round.
    assert_eq!(transfer_in(&mut c, at(2, 2_200), "carol.test", 20_000_000, r#"{"rescue":{}}"#), 0);
    let r = c.get_rescue();
    assert_eq!((r.fund.0, r.rescuers.len(), r.from_round, r.until_round), (0, 2, 3, 17));
    assert_eq!(events(&c, EventName::Rescued)[0]["effective_round"], 3);
    goto(&mut c, 3, 1_000);
    assert_eq!(c.get_rank().status, Status::Employed);
    // A winning round in their window: 10% of the result to bob and carol, 3:2.
    ctx(at(3, 2_000), "anyone.test", 0);
    let before = c.books.brave_total;
    c.finish_settle(3, 0, 10_000_000);
    let (b, k) = (c.get_player(acct("bob.test")).prize_owed.0, c.get_player(acct("carol.test")).prize_owed.0);
    assert_eq!((b, k), (600_000, 400_000));
    assert_eq!(c.books.brave_total, before + 10_000_000 - 1_000_000);
    assert_eq!(c.get_rescue().paid_total.0, 1_000_000);
}

#[test]
fn a_rehire_by_vote_gives_a_waiting_rescue_back() {
    let mut c = three();
    c.rank.status = 1; // FIRED
    assert_eq!(transfer_in(&mut c, at(2, 2_000), "bob.test", 10_000_000, r#"{"rescue":{}}"#), 0);
    // A passed rehire takes effect (as a vote's would).
    c.rank.pending = Some((0, 0, 3));
    goto(&mut c, 3, 1_000);
    assert_eq!(c.get_rank().status, Status::Employed);
    assert_eq!(c.get_rescue().fund.0, 0);
    ctx(at(3, 2_000), "anyone.test", 0);
    assert_eq!(c.get_player(acct("bob.test")).prize_owed.0, 10_000_000);
}


// ----- NFTs that do something (items 13, 14, 24) ------------------------------------------------------------

#[test]
fn claimed_originals_share_a_quarter_of_paid_tricks() {
    let mut c = three();
    // Two originals claimed (their first-of-kind stickers exist): OVER_TRADE_LIMIT and FIRED.
    c.s9.sticker_firsts[Refusal::OverTradeLimit as usize] = Some((acct("bob.test"), 2, true));
    c.s9.sticker_firsts[Refusal::Fired as usize] = Some((acct("carol.test"), 2, true));
    // An unclaimed one does not share.
    c.s9.sticker_firsts[Refusal::ZeroMargin as usize] = Some((acct("carol.test"), 2, false));
    assert_eq!(transfer_in(&mut c, at(2, 2_000), "bob.test", 4_000_000, r#"{"trick":{"id":"t-1"}}"#), 0);
    let e = c.get_nft_earnings();
    assert_eq!(e.owed_total.0, 1_000_000);
    let owed: Vec<(String, u128)> = e.tokens.iter().map(|t| (t.token_id.clone(), t.owed.0)).collect();
    assert!(owed.contains(&("original:OVER_TRADE_LIMIT".to_string(), 500_000)));
    assert!(owed.contains(&("original:FIRED".to_string(), 500_000)));
    assert_eq!(c.get_bounty().pot.0, 2_000_000);
}

#[test]
fn whoever_holds_an_earning_token_claims_it_and_nobody_else() {
    let mut c = three();
    c.s9.sticker_firsts[Refusal::Fired as usize] = Some((acct("carol.test"), 2, true));
    assert_eq!(transfer_in(&mut c, at(2, 2_000), "bob.test", 4_000_000, r#"{"trick":{"id":"t-2"}}"#), 0);
    // The sticker contract says dave holds it now (it was sold): carol's claim fails, dave's succeeds.
    let token = r#"{"token_id":"original:FIRED","owner_id":"dave.test"}"#.as_bytes().to_vec();
    ctx_full(at(2, 3_000), ME, 0, vec![PromiseResult::Successful(token.clone())]);
    assert!(!c.on_nft_owner("original:FIRED".into(), acct("carol.test")));
    ctx_full(at(2, 3_100), ME, 0, vec![PromiseResult::Successful(token)]);
    assert!(c.on_nft_owner("original:FIRED".into(), acct("dave.test")));
    ctx(at(2, 3_200), "anyone.test", 0);
    assert_eq!(c.get_player(acct("dave.test")).prize_owed.0, 1_000_000);
    assert_eq!(c.get_nft_earnings().owed_total.0, 0);
}

#[test]
fn a_playbook_with_its_nft_keeps_the_coach_cut_for_the_token() {
    let mut c = three();
    // Playbook 1 by bob, active in round 3, with its NFT.
    ctx(at(2, 2_000), "bob.test", 50_000_000_000_000_000_000_000);
    let pid = c.submit_playbook("Prefer DOGE on calm days.".into(), vec![wire::Author { account_id: acct("bob.test"), share_bps: 10_000 }]);
    c.round_playbook.insert(3, pid);
    env::storage_write(&[b"e7p".as_slice(), &pid.to_le_bytes()].concat(), &[1]);
    goto(&mut c, 3, 1_000);
    ctx(at(3, 2_000), "anyone.test", 0);
    let before = c.books.brave_total;
    c.finish_settle(3, 0, 10_000_000);
    // 10% of a $10 win: $1 kept for the token, not sent to bob.
    assert_eq!(c.books.brave_total, before + 9_000_000);
    let e = c.get_nft_earnings();
    assert_eq!(e.owed_total.0, 1_000_000);
    assert!(e.tokens.iter().any(|t| t.token_id == format!("playbook:{pid}") && t.owed.0 == 1_000_000));
}

#[test]
fn the_career_card_is_drawn_from_the_record() {
    let c = three();
    ctx(at(2, 2_000), "anyone.test", 0);
    let v = c.get_career();
    assert_eq!((v.rank, v.status, v.rounds), (Rank::Intern, Status::Employed, 2));
    assert!(v.svg.starts_with("data:image/svg+xml;base64,"));
    use near_sdk::base64::Engine;
    let svg = String::from_utf8(
        near_sdk::base64::engine::general_purpose::STANDARD.decode(v.svg.trim_start_matches("data:image/svg+xml;base64,")).unwrap(),
    )
    .unwrap();
    assert!(svg.contains("THE INTERN") && svg.contains("INTERN · EMPLOYED") && svg.contains("LEVEL 0"));
}

// ----- the Intern's stake: supply that reacts (item 15) -------------------------------------------------------

#[test]
fn the_stake_grows_by_a_five_percent_fee_on_a_win_and_burns_first_on_a_loss() {
    let mut c = three();
    ctx(at(2, 2_000), "anyone.test", 0);
    let alice = acct("alice.test");
    let v0 = c.brave_usd_of(&alice);
    let supply0 = c.ft_total_supply().0;
    // A $20 win: $1 (5%) becomes the Intern's stake, in new coins; alice keeps the other $19.
    c.finish_settle(2, 0, 20_000_000);
    let st = c.get_stake();
    assert!(st.coins.0 > 0);
    assert_eq!(c.ft_total_supply().0, supply0 + st.coins.0);
    assert!((st.value.0 as i128 - 1_000_000).abs() <= 100, "{}", st.value.0);
    let v1 = c.brave_usd_of(&alice);
    assert!((v1 as i128 - (v0 as i128 + 19_000_000)).abs() <= 100, "{v0} {v1}"); // the 1,000 locked units share a little
    assert_eq!(events(&c, EventName::StakeGrew).len(), 1);
    // A $10 loss: the stake's coins (about $1) burn first; alice loses about $9, not $10.
    c.finish_settle(2, 0, -10_000_000);
    let st = c.get_stake();
    assert_eq!(st.coins.0, 0);
    assert_eq!(c.ft_total_supply().0, supply0);
    let v2 = c.brave_usd_of(&alice);
    assert!((v2 as i128 - (v1 as i128 - 9_000_000)).abs() <= 100, "{v1} {v2}");
    assert_eq!(events(&c, EventName::StakeBurned).len(), 1);
}

// ----- challenging a reported result (item 12) ---------------------------------------------------------------

/// Round 2: alice locks $500 of coins; a $11 bet is reported as $12 back and settled. Returns the position id.
fn bet_reported_and_settled(c: &mut Coin) -> u64 {
    ctx(at(2, 1_500), "alice.test", 0);
    c.lock(U128(500_000_000));
    let wire::Verdict::Yes { position_id } = propose(c, 2, &SMALL) else { panic!("approved") };
    ctx(at(2, IN_WINDOW + 5_000), RUNNER, 0);
    c.report_result(position_id, U128(12_000_000));
    ctx(at(2, IN_WINDOW + 6_000), "anyone.test", 0);
    let _ = c.settle(2);
    ctx_full(at(2, IN_WINDOW + 7_000), ME, 0, vec![PromiseResult::Successful(vec![])]);
    c.on_settle(2, U128(11_000_000), wire::I128(1_000_000));
    position_id
}

#[test]
fn a_challenged_result_is_corrected_by_a_vote_and_the_bond_comes_back() {
    let mut c = three();
    let pid = bet_reported_and_settled(&mut c);
    goto(&mut c, 4, 1_000);
    // bob says $11.50 came back, not $12, with a $5 bond: a CORRECT vote opens at once.
    let msg = format!(r#"{{"challenge":{{"position_id":{pid},"returned":"11500000","reason":"fills say 11.50"}}}}"#);
    assert_eq!(transfer_in(&mut c, at(4, 2_000), "bob.test", 5_000_000, &msg), 0);
    let ch = c.get_challenges();
    assert_eq!((ch.bonds_held.0, ch.challenges.len(), ch.challenges[0].state.as_str()), (5_000_000, 1, "OPEN"));
    let vote_id = ch.challenges[0].vote_id;
    // The same bet again, or a CORRECT vote by open_vote: refused.
    assert_eq!(transfer_in(&mut c, at(4, 2_100), "carol.test", 5_000_000, &msg), 5_000_000);
    ctx(at(4, 2_200), "alice.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| c.open_vote(wire::VoteKind::Correct, None))).is_err());
    // alice votes yes; the vote passes a round later.
    ctx(at(4, 2_300), "alice.test", 0);
    c.cast(vote_id, true);
    goto(&mut c, 5, 3_000);
    ctx(at(5, 3_000), "anyone.test", 0);
    assert_eq!(c.finish_vote(vote_id).state, wire::VoteState::Passed);
    assert_eq!(c.get_challenges().challenges[0].state, "PASSED");
    // Applied: the pool gives back $0.50, the bet is CORRECTED, bob's bond is his prize again.
    let before = c.books.brave_total;
    ctx(at(5, 4_000), "anyone.test", 0);
    let _ = c.apply_correction(vote_id);
    ctx_full(at(5, 4_100), ME, 0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_correction(vote_id));
    assert_eq!(c.books.brave_total, before - 500_000);
    let p = c.get_positions(Some(2)).into_iter().find(|p| p.id == pid).unwrap();
    assert_eq!((p.returned, p.result_source), (Some(U128(11_500_000)), Some(wire::ResultSource::Corrected)));
    ctx(at(5, 4_200), "anyone.test", 0);
    assert_eq!(c.get_player(acct("bob.test")).prize_owed.0, 5_000_000);
    assert_eq!(c.get_challenges().bonds_held.0, 0);
    assert_eq!(events(&c, EventName::ResultCorrected).len(), 1);
}

#[test]
fn a_challenge_that_fails_gives_its_bond_to_the_pool_and_the_window_closes() {
    let mut c = three();
    let pid = bet_reported_and_settled(&mut c);
    goto(&mut c, 4, 1_000);
    let msg = format!(r#"{{"challenge":{{"position_id":{pid},"returned":"11000000","reason":"no"}}}}"#);
    assert_eq!(transfer_in(&mut c, at(4, 2_000), "bob.test", 5_000_000, &msg), 0);
    let vote_id = c.get_challenges().challenges[0].vote_id;
    goto(&mut c, 5, 3_000); // nobody voted
    ctx(at(5, 3_000), "anyone.test", 0);
    assert_eq!(c.finish_vote(vote_id).state, wire::VoteState::Failed);
    assert_eq!(c.get_challenges().bonds_held.0, 0);
    assert_eq!(c.s9.income_waiting, 5_000_000);
    // Round 6 is past the window (round 2 + 3): a new challenge of another kind of figure is refused.
    goto(&mut c, 6, 1_000);
    assert_eq!(transfer_in(&mut c, at(6, 2_000), "carol.test", 5_000_000, &msg.replace("11000000", "10000000")), 5_000_000);
}

// ----- golden stickers on the tickets contract (item 23) -------------------------------------------------------

#[test]
fn a_golden_sticker_can_be_claimed_as_a_multi_token_and_comes_back_if_the_mint_fails() {
    let mut c = three();
    env::storage_write(b"m7t", b"tickets.test");
    c.rw.golden_odds = 1; // every guess drops one
    guess(&mut c, 2, "bob.test", Verdict3::Skip);
    ctx(at(2, 3_000), "bob.test", 0);
    let won = c.get_player(acct("bob.test")).goldens;
    assert_eq!(won.len(), 1);
    let (code, serial) = (won[0].code, won[0].serial);
    ctx_full(at(2, 3_100), "bob.test", 20_000_000_000_000_000_000_000, vec![]);
    let _ = c.claim_golden_mt(code, serial);
    ctx(at(2, 3_200), "bob.test", 0);
    assert!(c.get_player(acct("bob.test")).goldens.is_empty());
    // The tickets contract refused the mint: the golden sticker is bob's to claim again.
    ctx_full(at(2, 3_300), ME, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_claimed(acct("bob.test"), format!("golden:{}", code.as_str()), crate::earn::KIND_GOLDEN_MT, (code as u64) << 16 | serial as u64));
    ctx(at(2, 3_400), "bob.test", 0);
    assert_eq!(c.get_player(acct("bob.test")).goldens.len(), 1);
}
