//! Step 6 unit tests: SAFE and the dial. `cargo test -p coin`.

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
const SAFE: &str = r#"{"pool":"SAFE"}"#;
const BRAVE: &str = r#"{"pool":"BRAVE"}"#;

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
        stickers: None,
        launchpad: None,
        lender: None,
    })
}

fn register(c: &mut Coin, now: u64, who: &str) {
    ctx(now, who, Coin::storage_min().as_yoctonear());
    c.storage_deposit(None, None);
}

/// Pays in through the USDC token; returns the refunded amount.
fn pay_in(c: &mut Coin, now: u64, who: &str, amount: u128, msg: &str) -> u128 {
    ctx(now, USDC, 0);
    match c.ft_on_transfer(acct(who), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("no promise expected"),
    }
}

fn dial(c: &mut Coin, now: u64, who: &str, to: Pool, amount: u128) {
    ctx(now, who, 1);
    let _ = c.turn_dial(to, U128(amount));
}

fn view_at(c: &Coin, now: u64, who: &str) -> (wire::Pot, wire::Account) {
    ctx(now, "anyone.test", 0);
    (c.get_pot(), c.get_account(acct(who)))
}

/// alice has 1,000 coins' worth in BRAVE (round 2) and $300 in SAFE.
fn alice_both() -> Coin {
    let mut c = coin();
    register(&mut c, G + 2_000, "alice.test");
    assert_eq!(
        pay_in(&mut c, G + 3_000, "alice.test", 1_000_000_000, BRAVE),
        0
    );
    assert_eq!(
        pay_in(&mut c, G + 3_000, "alice.test", 300_000_000, SAFE),
        0
    );
    ctx(at(2, 1_000), "anyone.test", 0);
    c.tick();
    c
}

#[test]
fn safe_is_credited_at_once_and_never_in_brave_at_open() {
    let mut c = coin();
    register(&mut c, G + 2_000, "alice.test");
    assert_eq!(
        pay_in(&mut c, G + 3_000, "alice.test", 300_000_000, SAFE),
        0
    );
    let (pot, a) = view_at(&c, G + 4_000, "alice.test");
    assert_eq!(
        (pot.safe.total, pot.safe.idle, pot.safe.lent),
        (U128(300_000_000), U128(300_000_000), U128(0))
    );
    assert_eq!(
        (a.safe, a.coin, a.pending_brave),
        (U128(300_000_000), U128(0), U128(0))
    );
    assert_eq!(pot.brave.total, U128(0));
    let f = c.get_feed(None, Some(1)).pop().unwrap();
    assert_eq!(
        (
            f.event,
            f.data["pool"].as_str(),
            f.data["pending"].as_bool()
        ),
        (EventName::PaidIn, Some("SAFE"), Some(false))
    );
    // The next round's limit base does not include SAFE.
    pay_in(&mut c, G + 5_000, "alice.test", 50_000_000, BRAVE);
    ctx(at(2, 1_000), "anyone.test", 0);
    assert_eq!(c.get_round().brave_at_open, U128(50_000_000));
}

#[test]
fn cash_out_safe_pays_dollars_and_a_failure_puts_them_back() {
    let mut c = alice_both();
    ctx(at(2, 2_000), "alice.test", 1);
    let _ = c.cash_out(Pool::Safe, U128(100_000_000), None);
    assert_eq!(c.safe_of(&acct("alice.test")), 200_000_000);
    assert_eq!(c.books_safe, 200_000_000);
    // The payout failed: the dollars come back to SAFE.
    ctx_full(at(2, 3_000), ME, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_payout(acct("alice.test"), Pool::Safe, None, U128(100_000_000)));
    assert_eq!(
        (c.safe_of(&acct("alice.test")), c.books_safe),
        (300_000_000, 300_000_000)
    );
    // It landed: a cashed_out event with coins null.
    ctx(at(2, 4_000), "alice.test", 1);
    let _ = c.cash_out(Pool::Safe, U128(300_000_000), None);
    ctx_full(at(2, 5_000), ME, 0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_payout(acct("alice.test"), Pool::Safe, None, U128(300_000_000)));
    let f = c.get_feed(None, Some(1)).pop().unwrap();
    assert_eq!(
        (f.event, f.data["coins"].is_null(), f.data["paid"].as_str()),
        (EventName::CashedOut, true, Some("300000000"))
    );
    assert!(
        c.safe.get(&acct("alice.test")).is_none(),
        "an empty SAFE leaves no record"
    );
}

#[test]
#[should_panic(expected = "not that much in SAFE")]
fn cannot_cash_out_more_safe_than_held() {
    let mut c = alice_both();
    ctx(at(2, 2_000), "alice.test", 1);
    let _ = c.cash_out(Pool::Safe, U128(300_000_001), None);
}

#[test]
fn the_dial_both_ways() {
    let mut c = alice_both();
    let (_, a) = view_at(&c, at(2, 1_500), "alice.test");
    assert_eq!(
        a.coin,
        U128(999_999_000),
        "shown at once, written at alice's next action"
    );
    // To SAFE: 100,000,000 coins at $1.00 arrive as dollars at once.
    dial(&mut c, at(2, 2_000), "alice.test", Pool::Safe, 100_000_000);
    let (pot, a) = view_at(&c, at(2, 2_500), "alice.test");
    assert_eq!((a.coin, a.safe), (U128(899_999_000), U128(400_000_000)));
    assert_eq!(
        (pot.brave.total, pot.safe.total),
        (U128(900_000_000), U128(400_000_000))
    );
    assert_eq!(
        pot.coin_price_e6,
        U128(1_000_000),
        "the price does not move"
    );
    // To BRAVE: $50 leave SAFE and wait for the next round.
    dial(&mut c, at(2, 3_000), "alice.test", Pool::Brave, 50_000_000);
    let (pot, a) = view_at(&c, at(2, 3_500), "alice.test");
    assert_eq!(
        (a.safe, a.pending_brave, a.coin),
        (U128(350_000_000), U128(50_000_000), U128(899_999_000))
    );
    assert_eq!(
        (pot.safe.total, pot.brave.pending),
        (U128(350_000_000), U128(50_000_000))
    );
    let (pot, a) = view_at(&c, at(3, 1_000), "alice.test");
    assert_eq!(
        (a.coin, a.pending_brave),
        (U128(949_999_000), U128(0)),
        "coins at the next round"
    );
    assert_eq!(pot.brave.total, U128(950_000_000));
    let events: Vec<_> = c.get_feed(None, Some(3)).iter().map(|f| f.event).collect();
    assert_eq!(
        events
            .iter()
            .filter(|e| **e == EventName::DialTurned)
            .count(),
        2
    );
}

#[test]
fn the_dial_to_safe_during_an_open_bet_leaves_the_margin_in_play() {
    let mut c = alice_both();
    goto_window(&mut c, 2);
    bet(&mut c, at(2, IN_WINDOW), 20_000_000);
    // Half the coins out: priced on the $980 not in play, as a cash-out is (1.1).
    dial(
        &mut c,
        at(2, IN_WINDOW + 1_000),
        "alice.test",
        Pool::Safe,
        499_999_500,
    );
    let value = 980_000_000u128 * 499_999_500 / 1_000_000_000;
    assert_eq!(c.safe_of(&acct("alice.test")), 300_000_000 + value);
    assert_eq!(c.books.brave_total, 1_000_000_000 - value);
    assert_eq!(c.books.in_play, 20_000_000);
}

#[test]
#[should_panic(expected = "not that many free coins")]
fn locked_coins_cannot_be_dialled_to_safe() {
    let mut c = alice_both();
    ctx(at(2, 2_000), "alice.test", 0);
    c.lock(U128(999_999_000));
    dial(&mut c, at(2, 3_000), "alice.test", Pool::Safe, 1);
}

#[test]
#[should_panic(expected = "the first money ever into BRAVE must be at least min_first_deposit")]
fn the_first_money_into_brave_by_the_dial_meets_the_minimum() {
    let mut c = coin();
    register(&mut c, G + 2_000, "alice.test");
    pay_in(&mut c, G + 3_000, "alice.test", 300_000_000, SAFE);
    dial(&mut c, G + 4_000, "alice.test", Pool::Brave, 9_999_999);
}

fn goto_window(c: &mut Coin, round: u64) {
    ctx(at(round, IN_WINDOW), "anyone.test", 0);
    c.tick();
}

fn b64(bytes: &[u8]) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn bet(c: &mut Coin, now: u64, margin: u128) -> u64 {
    ctx(now, RUNNER, 0);
    let rb = c.get_rulebook();
    let d = Decision::Bet {
        market: Market::Doge,
        side: Side::Long,
        margin_e6: margin,
        leverage: 1,
    };
    let line = decision_line(rb.round_id, &rb.nonce, &d);
    match c.propose(
        b64(rb.text.as_bytes()),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        None,
        None,
    ) {
        wire::Verdict::Yes { position_id } => position_id,
        v => panic!("{v:?}"),
    }
}

#[test]
fn a_loss_on_a_brave_bet_does_not_change_any_safe_balance() {
    let mut c = alice_both();
    register(&mut c, at(2, 2_000), "bob.test");
    pay_in(&mut c, at(2, 3_000), "bob.test", 70_000_000, SAFE);
    goto_window(&mut c, 2);
    let pid = bet(&mut c, at(2, IN_WINDOW), 20_000_000);
    ctx(at(2, 80_000_000), RUNNER, 0);
    c.report_result(pid, U128(5_000_000)); // lost $15
    ctx(at(2, 80_000_100), "anyone.test", 0);
    let _ = c.settle(2);
    ctx_full(
        at(2, 80_000_200),
        ME,
        0,
        vec![PromiseResult::Successful(vec![])],
    );
    assert_eq!(
        c.on_settle(2, U128(20_000_000), wire::I128(-15_000_000)),
        Some(wire::I128(-15_000_000))
    );
    let (pot, a) = view_at(&c, at(2, 80_000_300), "alice.test");
    assert_eq!(pot.brave.total, U128(985_000_000), "BRAVE took the loss");
    assert_eq!(
        (pot.safe.total, a.safe),
        (U128(370_000_000), U128(300_000_000)),
        "SAFE did not move"
    );
    assert_eq!(c.safe_of(&acct("bob.test")), 70_000_000);
    assert!(
        a.brave_value.0 < 999_999_000,
        "alice's coins carry the loss"
    );
}

#[test]
fn safe_holders_have_no_vote() {
    let mut c = alice_both();
    register(&mut c, at(2, 2_000), "bob.test");
    pay_in(&mut c, at(2, 3_000), "bob.test", 500_000_000, SAFE);
    for r in 3..=10 {
        ctx(at(r, 1_000), "anyone.test", 0);
        c.tick();
    }
    let (_, b) = view_at(&c, at(10, 2_000), "bob.test");
    assert_eq!(
        (b.coin, b.locked, b.vote_weight),
        (U128(0), U128(0), U128(0))
    );
    ctx(at(10, 3_000), "bob.test", 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.lock(U128(1))));
    assert!(r.is_err(), "nothing to lock");
    ctx(at(10, 3_000), "bob.test", 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.open_vote(wire::VoteKind::Promote, None)
    }));
    assert!(r.is_err(), "cannot open a vote");
}

#[test]
#[should_panic(expected = "cash out everything first")]
fn cannot_leave_with_money_in_safe() {
    let mut c = coin();
    register(&mut c, G + 2_000, "alice.test");
    pay_in(&mut c, G + 3_000, "alice.test", 5_000_000, SAFE);
    ctx(G + 4_000, "alice.test", 1);
    c.storage_unregister(None);
}

#[test]
fn one_boss_with_every_record_and_safe_fits_in_the_registration_storage() {
    let mut c = coin();
    let long: AccountId = format!("{}.test", "a".repeat(59)).parse().unwrap();
    let before = env::storage_usage();
    register(&mut c, G + 2_000, long.as_str());
    c.extras.insert(
        long.clone(),
        Extra {
            pending: u128::MAX,
            pending_epoch: u64::MAX,
            newcomer: true,
            joined_round: Some(u64::MAX),
            in_flight: u32::MAX,
        },
    );
    c.locks.insert(
        long.clone(),
        vote::LockRec {
            lots: vec![(u128::MAX, u64::MAX); vote::MAX_LOTS],
            total: u128::MAX,
            cast_in: vec![u64::MAX; 5],
        },
    );
    c.safe.insert(long.clone(), u128::MAX);
    c.extras.flush();
    c.locks.flush();
    c.safe.flush();
    let used = env::storage_usage() - before;
    println!("one boss with every record and SAFE uses {used} of {ACCOUNT_STORAGE_BYTES} bytes");
    assert!(used <= ACCOUNT_STORAGE_BYTES, "used {used}");
}
