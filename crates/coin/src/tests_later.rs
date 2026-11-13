//! Steps 8 and 9 unit tests (01 1.3): outside income, lending, playbooks and the coach cut, credited
//! refusals and claims, tips and goal bars. `cargo test -p coin`.

use super::*;
use crate::ai::decision_line;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use shared::{Decision, Market, Side};

const ME: &str = "coin.test";
const USDC: &str = "usdc.test";
const RUNNER: &str = "runner.test";
const G: u64 = 1_794_355_200_000;
const ROUND: u64 = 86_400_000;
const IN_WINDOW: u64 = 43_260_000;

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

fn coin(lender: bool) -> Coin {
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
        lender: lender.then(|| acct("lender.test")),
    })
}

fn register(c: &mut Coin, now: u64, who: &str) {
    ctx(now, who, Coin::storage_min().as_yoctonear());
    c.storage_deposit(None, None);
}

/// Through the USDC token; returns the refund.
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

fn propose(c: &mut Coin, now: u64, d: &Decision, credited: Option<&str>) -> wire::Verdict {
    ctx(now, RUNNER, 0);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, d);
    c.propose(
        b64(rb.text.as_bytes()),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        None,
        credited.map(acct),
    )
}

/// alice has $1,000 of coins (round 2).
fn alice_in(lender: bool) -> Coin {
    let mut c = coin(lender);
    register(&mut c, G + 2_000, "alice.test");
    assert_eq!(
        transfer_in(
            &mut c,
            G + 3_000,
            "alice.test",
            1_000_000_000,
            r#"{"pool":"BRAVE"}"#
        ),
        0
    );
    goto(&mut c, 2, 1_000);
    c
}

fn events(c: &Coin, name: EventName) -> Vec<Value> {
    c.get_feed(None, Some(100))
        .into_iter()
        .filter(|f| f.event == name)
        .map(|f| f.data)
        .collect()
}
use near_sdk::serde_json::Value;

// ----- step 8: outside income -------------------------------------------------------------------------

#[test]
fn outside_income_counts_from_the_next_round_before_new_money_converts() {
    let mut c = alice_in(false);
    let income = r#"{"income":{"source":"launchpad"}}"#;
    assert_eq!(
        transfer_in(&mut c, at(2, 2_000), "launch.test", 100_000_000, income),
        0
    );
    ctx(at(2, 3_000), "anyone.test", 0);
    let pot = c.get_pot();
    assert_eq!(
        (
            pot.brave.total,
            pot.brave.income_waiting,
            pot.outside_income_total
        ),
        (U128(1_000_000_000), U128(100_000_000), U128(100_000_000))
    );
    // bob pays in during round 2; he converts at round 3's opening at the price that includes the income.
    register(&mut c, at(2, 4_000), "bob.test");
    transfer_in(
        &mut c,
        at(2, 5_000),
        "bob.test",
        110_000_000,
        r#"{"pool":"BRAVE"}"#,
    );
    ctx(at(3, 1_000), "anyone.test", 0);
    let pot = c.get_pot();
    assert_eq!(
        (pot.brave.total, pot.brave.income_waiting),
        (U128(1_210_000_000), U128(0))
    );
    assert_eq!(
        pot.coin_price_e6,
        U128(1_100_000),
        "alice's coins carry the income: $1.10"
    );
    assert_eq!(
        c.get_account(acct("bob.test")).coin,
        U128(100_000_000),
        "bob bought at $1.10: no part of the income"
    );
    // Bad source, or a FIRED Intern: refunded.
    assert_eq!(
        transfer_in(
            &mut c,
            at(3, 2_000),
            "x.test",
            5,
            r#"{"income":{"source":"Bad Source"}}"#
        ),
        5
    );
    c.rank.status = Status::Fired as u8;
    assert_eq!(
        transfer_in(&mut c, at(3, 3_000), "launch.test", 5, income),
        5
    );
}

// ----- step 8: lending ----------------------------------------------------------------------------------

#[test]
fn rebalance_keeps_the_interns_slice_idle_and_the_pot_adds_up() {
    let mut c = alice_in(true);
    ctx(at(2, 2_000), "anyone.test", 0);
    let _ = c.rebalance();
    // INTERN: per-round limit 2% of $1,000 = $20 stays idle; $980 goes.
    assert_eq!(c.s9.lend_in_flight, 980_000_000);
    let p = c.get_pot().brave;
    assert_eq!((p.lent, p.idle), (U128(980_000_000), U128(20_000_000)));
    // The lender took it all.
    ctx_full(
        at(2, 3_000),
        ME,
        0,
        vec![PromiseResult::Successful(b"\"980000000\"".to_vec())],
    );
    assert_eq!(c.on_lent(U128(980_000_000)), U128(980_000_000));
    let p = c.get_pot().brave;
    assert_eq!(
        u128::from(p.lent) + u128::from(p.idle) + u128::from(p.in_play),
        u128::from(p.total)
    );
    // Nothing to move now.
    ctx(at(2, 4_000), "anyone.test", 0);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.rebalance()))).is_err()
    );
    // Interest collected is held for the payday draw (1.4), not added to the pool.
    ctx_full(
        at(2, 5_000),
        ME,
        0,
        vec![PromiseResult::Successful(b"\"1500000\"".to_vec())],
    );
    assert_eq!(c.on_interest(), U128(1_500_000));
    let p = c.get_pot().brave;
    assert_eq!(
        (p.total, p.interest),
        (U128(1_000_000_000), U128(1_500_000))
    );
    assert_eq!(c.get_rewards().draw_pot, U128(1_500_000));
}

#[test]
fn a_cash_out_bigger_than_idle_brings_money_back_first_and_a_failure_changes_nothing() {
    let mut c = alice_in(true);
    ctx(at(2, 2_000), "anyone.test", 0);
    let _ = c.rebalance();
    ctx_full(
        at(2, 3_000),
        ME,
        0,
        vec![PromiseResult::Successful(b"\"980000000\"".to_vec())],
    );
    c.on_lent(U128(980_000_000));
    // alice cashes out $500: $20 is idle, $480 must come back, plus $10 so the new slice is idle.
    let before = (c.get_account(acct("alice.test")), c.get_pot());
    ctx(at(2, 4_000), "alice.test", 1);
    let _ = c.cash_out(Pool::Brave, U128(500_000_000), None);
    assert_eq!(
        (c.s9.lent, c.s9.withdraw_in_flight),
        (490_000_000, true),
        "$480 short + the new $10 slice"
    );
    // The lender could not pay: everything back.
    ctx_full(at(2, 5_000), ME, 0, vec![PromiseResult::Failed]);
    let _ = c.on_withdrawn(
        acct("alice.test"),
        U128(490_000_000),
        U128(500_000_000),
        U128(500_000_000),
        lending::Then::CashOut,
    );
    ctx(at(2, 5_500), "anyone.test", 0);
    assert_eq!((c.get_account(acct("alice.test")), c.get_pot()), before);
    assert!(!c.s9.withdraw_in_flight);
    // Again, and it pays.
    ctx(at(2, 6_000), "alice.test", 1);
    let _ = c.cash_out(Pool::Brave, U128(500_000_000), None);
    ctx_full(
        at(2, 7_000),
        ME,
        0,
        vec![PromiseResult::Successful(b"true".to_vec())],
    );
    assert!(matches!(
        c.on_withdrawn(
            acct("alice.test"),
            U128(490_000_000),
            U128(500_000_000),
            U128(500_000_000),
            lending::Then::CashOut
        ),
        PromiseOrValue::Promise(_)
    ));
    let p = c.get_pot().brave;
    assert_eq!(
        (p.total, p.lent, p.idle),
        (U128(500_000_000), U128(490_000_000), U128(10_000_000)),
        "the slice is idle again"
    );
}

// ----- step 9: playbooks and the coach cut ------------------------------------------------------------------

fn submit(
    c: &mut Coin,
    now: u64,
    who: &str,
    text: &str,
    authors: &[(&str, u32)],
    deposit: u128,
) -> u64 {
    ctx(now, who, deposit);
    c.submit_playbook(
        text.into(),
        authors
            .iter()
            .map(|(a, s)| wire::Author {
                account_id: acct(a),
                share_bps: *s,
            })
            .collect(),
    )
}

const PB_DEPOSIT: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR

#[test]
fn playbooks_are_checked_and_pay_for_their_storage() {
    let mut c = alice_in(false);
    let id = submit(
        &mut c,
        at(2, 2_000),
        "coach.test",
        "Only bet DOGE.\nNever chase.",
        &[("coach.test", 7_000), ("friend.test", 3_000)],
        PB_DEPOSIT,
    );
    let p = &c.get_playbooks(None, None)[0];
    assert_eq!(
        (p.id, p.text.as_str(), p.active_from),
        (id, "Only bet DOGE. Never chase.", None),
        "newlines became spaces"
    );
    let refund = near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .any(|r| r.receiver_id.as_str() == "coach.test");
    assert!(refund, "the unused deposit goes back");
    let fails = |c: &mut Coin, text: &str, authors: &[(&str, u32)], dep: u128| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            submit(c, at(2, 3_000), "coach.test", text, authors, dep)
        }))
        .is_err()
    };
    assert!(
        fails(&mut c, "x", &[("a.test", 9_000)], PB_DEPOSIT),
        "shares must add up to 10,000"
    );
    assert!(
        fails(
            &mut c,
            "x",
            &[("a.test", 5_000), ("a.test", 5_000)],
            PB_DEPOSIT
        ),
        "an author twice"
    );
    assert!(
        fails(
            &mut c,
            &"x".repeat(2_001),
            &[("a.test", 10_000)],
            PB_DEPOSIT
        ),
        "too long"
    );
    assert!(
        fails(&mut c, "x", &[("a.test", 10_000)], 1),
        "storage not paid"
    );
}

/// A coin where a SET_PLAYBOOK vote for `pid` has passed (bosses a and b locked in round 1, vote in round 9).
fn with_playbook_voted() -> (Coin, u64) {
    let mut c = coin(false);
    for who in ["a.test", "b.test"] {
        let a = acct(who);
        c.token.internal_register_account(&a);
        c.token.internal_deposit(&a, 500_000_000);
        c.books.brave_total += 500_000_000;
        ctx(at(1, 2_000), who, 0);
        c.lock(U128(500_000_000));
    }
    let pid = submit(
        &mut c,
        at(1, 3_000),
        "coach.test",
        "Prefer PENGU.",
        &[("coach.test", 7_000), ("friend.test", 3_000)],
        PB_DEPOSIT,
    );
    goto(&mut c, 9, 1_000);
    ctx(at(9, 1_000), "a.test", 0);
    let v = c.open_vote(wire::VoteKind::SetPlaybook, Some(pid));
    for who in ["a.test", "b.test"] {
        ctx(at(9, 2_000), who, 0);
        c.cast(v, true);
    }
    goto(&mut c, 10, 1_000);
    ctx(at(10, 1_000), "anyone.test", 0);
    let f = c.finish_vote(v);
    assert_eq!(
        (f.state, f.effective_round, f.playbook_id),
        (wire::VoteState::Passed, Some(12), Some(pid))
    );
    (c, pid)
}

#[test]
fn a_playbook_voted_in_enters_the_rulebook_two_rounds_later_and_can_be_cleared() {
    let (mut c, pid) = with_playbook_voted();
    assert!(
        c.get_rulebook().text.contains("playbook: none"),
        "not in the round in progress"
    );
    goto(&mut c, 11, IN_WINDOW);
    assert!(
        c.get_rulebook().text.contains("playbook: none"),
        "nor the next"
    );
    goto(&mut c, 12, IN_WINDOW);
    assert!(c.get_rulebook().text.contains("playbook: Prefer PENGU."));
    assert_eq!(
        c.get_active_playbook().map(|p| (p.id, p.active_from)),
        Some((pid, Some(12)))
    );
    assert_eq!(events(&c, EventName::PlaybookActivated).len(), 1);
    // Only one playbook change may wait at a time; 0 clears.
    ctx(at(12, IN_WINDOW + 1_000), "a.test", 0);
    let v = c.open_vote(wire::VoteKind::SetPlaybook, Some(0));
    ctx(at(12, IN_WINDOW + 2_000), "a.test", 0);
    c.cast(v, true);
    goto(&mut c, 13, IN_WINDOW + 2_000); // after closes_at
    ctx(at(13, IN_WINDOW + 2_000), "anyone.test", 0);
    c.finish_vote(v);
    goto(&mut c, 15, IN_WINDOW);
    assert!(c.get_rulebook().text.contains("playbook: none"));
    assert_eq!(c.get_active_playbook(), None);
}

#[test]
fn a_winning_round_with_a_playbook_pays_its_authors_ten_percent_and_a_failed_payment_comes_back() {
    let (mut c, pid) = with_playbook_voted();
    goto(&mut c, 12, IN_WINDOW);
    let d = Decision::Bet {
        market: Market::Pengu,
        side: Side::Long,
        margin_e6: 20_000_000,
        leverage: 1,
    };
    let wire::Verdict::Yes { position_id } = propose(&mut c, at(12, IN_WINDOW), &d, None) else {
        panic!()
    };
    ctx(at(12, 80_000_000), RUNNER, 0);
    c.report_result(position_id, U128(30_000_000)); // won $10
    let total_before = c.books.brave_total;
    ctx(at(12, 80_000_100), "anyone.test", 0);
    let _ = c.settle(12);
    ctx_full(
        at(12, 80_000_200),
        ME,
        0,
        vec![PromiseResult::Successful(vec![])],
    );
    c.on_settle(12, U128(20_000_000), wire::I128(10_000_000));
    // 10% of $10 = $1: $0.70 and $0.30. The pool keeps $9.
    assert_eq!(c.books.brave_total, total_before + 9_000_000);
    let paid = &events(&c, EventName::CoachPaid)[0];
    assert_eq!(
        (
            paid["amount"].as_str(),
            paid["paid"][0]["amount"].as_str(),
            paid["paid"][1]["amount"].as_str()
        ),
        (Some("1000000"), Some("700000"), Some("300000"))
    );
    assert_eq!(c.get_playbooks(None, None)[0].paid_total, U128(1_000_000));
    // friend.test was not registered on the USDC token: its $0.30 comes back.
    ctx_full(at(12, 80_000_300), ME, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_coach_paid(pid, acct("friend.test"), U128(300_000)));
    assert_eq!(c.books.brave_total, total_before + 9_300_000);
    assert_eq!(c.get_playbooks(None, None)[0].paid_total, U128(700_000));
}

#[test]
fn a_losing_round_pays_no_coach() {
    let (mut c, _) = with_playbook_voted();
    goto(&mut c, 12, IN_WINDOW);
    let d = Decision::Bet {
        market: Market::Pengu,
        side: Side::Long,
        margin_e6: 20_000_000,
        leverage: 1,
    };
    let wire::Verdict::Yes { position_id } = propose(&mut c, at(12, IN_WINDOW), &d, None) else {
        panic!()
    };
    ctx(at(12, 80_000_000), RUNNER, 0);
    c.report_result(position_id, U128(15_000_000));
    ctx_full(
        at(12, 80_000_200),
        ME,
        0,
        vec![PromiseResult::Successful(vec![])],
    );
    c.on_settle(12, U128(20_000_000), wire::I128(-5_000_000));
    assert!(events(&c, EventName::CoachPaid).is_empty());
}

// ----- step 9: credited refusals and claims ---------------------------------------------------------------

#[test]
fn the_credited_visitor_claims_the_original_once_and_a_failed_mint_reopens_it() {
    let mut c = alice_in(false);
    goto(&mut c, 2, IN_WINDOW);
    let d = Decision::Bet {
        market: Market::Wif,
        side: Side::Long,
        margin_e6: 15_000_000,
        leverage: 1,
    };
    let v = propose(&mut c, at(2, IN_WINDOW), &d, Some("visitor.test"));
    assert!(matches!(
        v,
        wire::Verdict::Nope {
            code: Refusal::NotOnList,
            ..
        }
    ));
    assert!(c
        .get_claimable(acct("visitor.test"))
        .originals
        .contains(&Refusal::NotOnList));
    let claim = |c: &mut Coin, who: &str| {
        ctx(
            at(2, IN_WINDOW + 1_000),
            who,
            20_000_000_000_000_000_000_000,
        );
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drop(c.claim_sticker(Refusal::NotOnList))
        }))
        .is_ok()
    };
    assert!(!claim(&mut c, "mallory.test"), "only the credited visitor");
    assert!(claim(&mut c, "visitor.test"));
    assert!(!claim(&mut c, "visitor.test"), "once");
    // The mint failed: the right is back.
    ctx_full(at(2, IN_WINDOW + 2_000), ME, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_claimed(
        acct("visitor.test"),
        "original:NOT_ON_LIST".into(),
        1,
        Refusal::NotOnList as u64
    ));
    assert!(claim(&mut c, "visitor.test"));
    ctx_full(
        at(2, IN_WINDOW + 3_000),
        ME,
        0,
        vec![PromiseResult::Successful(vec![])],
    );
    assert!(c.on_claimed(
        acct("visitor.test"),
        "original:NOT_ON_LIST".into(),
        1,
        Refusal::NotOnList as u64
    ));
    ctx(at(2, IN_WINDOW + 4_000), "anyone.test", 0);
    let f = c
        .get_sticker_firsts()
        .into_iter()
        .find(|f| f.code == Refusal::NotOnList)
        .unwrap();
    assert_eq!(
        (f.account_id.unwrap().as_str(), f.claimed),
        ("visitor.test", true)
    );
}

#[test]
fn a_boss_claims_one_badge() {
    let mut c = alice_in(false);
    let claim = |c: &mut Coin, who: &str| {
        ctx(at(2, 2_000), who, 20_000_000_000_000_000_000_000);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.claim_badge()))).is_ok()
    };
    assert!(!claim(&mut c, "nobody.test"), "not a boss");
    assert!(c.get_claimable(acct("alice.test")).badge);
    assert!(claim(&mut c, "alice.test"));
    assert!(!claim(&mut c, "alice.test"), "one per account");
    assert!(!c.get_claimable(acct("alice.test")).badge);
}

// ----- step 9: tips and goals ---------------------------------------------------------------------------

#[test]
fn tips_fill_the_jar_with_overflow_and_the_tippers_may_claim() {
    let mut c = alice_in(false);
    for who in ["t1.test", "t2.test"] {
        register(&mut c, at(2, 2_000), who);
    }
    let tip = r#"{"tip":{}}"#;
    assert_eq!(
        transfer_in(&mut c, at(2, 3_000), "t1.test", 999_999, tip),
        999_999,
        "under the minimum tip"
    );
    assert_eq!(
        transfer_in(&mut c, at(2, 3_000), "t1.test", 60_000_000, tip),
        0
    );
    assert_eq!(
        transfer_in(&mut c, at(2, 4_000), "t2.test", 70_000_000, tip),
        0
    );
    let g = c.get_goals();
    assert_eq!(
        (g.tip_jar.jar, g.tip_jar.now),
        (2, U128(30_000_000)),
        "jar 1 filled, $30 carried into jar 2"
    );
    let fill = c
        .get_goal_fills(None, None)
        .into_iter()
        .find(|f| f.goal == wire::GoalKind::TipJar)
        .unwrap();
    assert!(c
        .get_claimable(acct("t1.test"))
        .goal_fills
        .contains(&fill.id));
    assert!(c
        .get_claimable(acct("t2.test"))
        .goal_fills
        .contains(&fill.id));
    assert!(!c
        .get_claimable(acct("alice.test"))
        .goal_fills
        .contains(&fill.id));
    // 1.4: half of every tip goes to the streak jackpot, half to the pool as outside income.
    assert_eq!(
        c.get_pot().brave.income_waiting,
        U128(65_000_000),
        "half of the tips is outside income"
    );
    assert_eq!(c.get_rewards().jackpot, U128(65_000_000));
    ctx(at(2, 5_000), "t1.test", 20_000_000_000_000_000_000_000);
    let _ = c.claim_goal_sticker(fill.id);
    assert!(!c
        .get_claimable(acct("t1.test"))
        .goal_fills
        .contains(&fill.id));
}

#[test]
fn the_boss_goal_fills_at_ten_bosses() {
    let mut c = coin(false);
    for i in 0..10 {
        let who = format!("b{i}.test");
        register(&mut c, G + 2_000, &who);
        transfer_in(&mut c, G + 3_000, &who, 20_000_000, r#"{"pool":"BRAVE"}"#);
    }
    assert_eq!(c.get_goals().boss.level, 0);
    goto(&mut c, 2, 1_000); // ten newcomers convert at round 2's opening
    let g = c.get_goals().boss;
    assert_eq!((g.level, g.target, g.now), (1, Some(25), 10));
    let fill = c.get_goal_fills(None, None)[0].clone();
    assert_eq!(
        (fill.goal, fill.level, fill.round_id),
        (wire::GoalKind::Boss, 1, 2)
    );
    assert!(c
        .get_claimable(acct("b3.test"))
        .goal_fills
        .contains(&fill.id));
}

#[test]
fn a_hype_train_climbs_with_points_inside_the_window_and_ends_after_it() {
    let mut c = alice_in(false);
    let tip = r#"{"tip":{}}"#;
    for (i, who) in ["h1.test", "h2.test", "h3.test"].iter().enumerate() {
        register(&mut c, at(2, 2_000), who);
        transfer_in(
            &mut c,
            at(2, 10_000 + i as u64 * 60_000),
            who,
            1_000_000,
            tip,
        );
    }
    transfer_in(&mut c, at(2, 200_000), "h1.test", 1_000_000, tip); // the same account again: no new point
    ctx(at(2, 200_001), "anyone.test", 0);
    let h = c.get_goals().hype;
    // (alice's $1,000 pay-in started train 1 back in round 1; these tips are train 2)
    assert_eq!((h.train, h.level, h.points), (2, 1, 3));
    assert_eq!(
        h.ends_at,
        Some(at(2, 130_000) + goals::HYPE_WINDOW_MS),
        "5 minutes after the latest POINT (the repeat tip was none)"
    );
    assert_eq!(events(&c, EventName::HypeLevel).len(), 1);
    // Only the top level gives a sticker.
    let fill = c.get_goal_fills(None, None)[0].id;
    assert!(!c.get_claimable(acct("h1.test")).goal_fills.contains(&fill));
    // Five minutes after its last point, the train is over; the next point starts train 2.
    register(&mut c, at(2, 600_000), "h4.test");
    transfer_in(&mut c, at(2, 600_000), "h4.test", 1_000_000, tip);
    ctx(at(2, 600_001), "anyone.test", 0);
    let h = c.get_goals().hype;
    assert_eq!((h.train, h.level, h.points), (3, 0, 1));
}

#[test]
fn rebalance_brings_back_what_the_slice_lacks_after_a_small_cash_out() {
    let mut c = alice_in(true);
    ctx(at(2, 2_000), "anyone.test", 0);
    let _ = c.rebalance();
    ctx_full(
        at(2, 3_000),
        ME,
        0,
        vec![PromiseResult::Successful(b"\"980000000\"".to_vec())],
    );
    c.on_lent(U128(980_000_000));
    // $15 out of the $20 idle: paid at once, and the slice is now short.
    ctx(at(2, 4_000), "alice.test", 1);
    let _ = c.cash_out(Pool::Brave, U128(15_000_000), None);
    assert!(!c.s9.withdraw_in_flight, "paid from idle money");
    ctx(at(2, 5_000), "anyone.test", 0);
    let p = c.get_pot().brave;
    assert_eq!(
        (p.idle, c.slice()),
        (U128(5_000_000), 19_700_000),
        "2% of $985"
    );
    let _ = c.rebalance();
    assert_eq!(
        (c.s9.lent, c.s9.withdraw_in_flight),
        (980_000_000 - 14_700_000, true)
    );
    ctx_full(
        at(2, 6_000),
        ME,
        0,
        vec![PromiseResult::Successful(b"true".to_vec())],
    );
    assert_eq!(c.on_recalled(U128(14_700_000)), wire::I128(-14_700_000));
    ctx(at(2, 7_000), "anyone.test", 0);
    assert_eq!(
        c.get_pot().brave.idle,
        U128(19_700_000),
        "the slice is idle again"
    );
    // A failure leaves it counted as lent.
    c.s9.withdraw_in_flight = true;
    c.s9.lent -= 1_000_000;
    ctx_full(at(2, 8_000), ME, 0, vec![PromiseResult::Failed]);
    assert_eq!(c.on_recalled(U128(1_000_000)), wire::I128(0));
    assert_eq!(c.s9.lent, 980_000_000 - 14_700_000);
}

#[test]
fn payments_above_a_trillion_dollars_are_refunded() {
    let mut c = alice_in(false);
    for msg in [r#"{"pool":"BRAVE"}"#, r#"{"pool":"SAFE"}"#, r#"{"tip":{}}"#, r#"{"income":{"source":"launchpad"}}"#] {
        assert_eq!(transfer_in(&mut c, at(2, 2_000), "alice.test", MAX_PAYMENT + 1, msg), MAX_PAYMENT + 1, "{msg}");
        assert_eq!(transfer_in(&mut c, at(2, 2_000), "alice.test", u128::MAX, msg), u128::MAX, "{msg}");
    }
}
