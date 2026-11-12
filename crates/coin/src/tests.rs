//! Unit tests: `cargo test -p coin`. Host functions run through nearcore's own VM logic. The
//! cross-contract parts (USDC really moving) are in the sandbox tests, `crates/coin/sandbox`.

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use wire::Phase;

const ME: &str = "coin.test";
const USDC: &str = "usdc.test";
/// A demo-clock genesis on a 30-minute boundary.
const G: u64 = 1_794_355_200_000;
const ROUND: u64 = 1_800_000;
const MIN_FIRST: u128 = 10_000_000;

fn ctx_full(
    now: u64,
    caller: &str,
    deposit: NearToken,
    gas_tgas: u64,
    results: Vec<PromiseResult>,
) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(ME.parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .block_timestamp(now * 1_000_000)
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(gas_tgas))
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn ctx(now: u64, caller: &str) {
    ctx_full(now, caller, NearToken::from_yoctonear(0), 300, vec![]);
}

fn ctx_paying(now: u64, caller: &str, deposit: NearToken) {
    ctx_full(now, caller, deposit, 300, vec![]);
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn config() -> InitConfig {
    InitConfig {
        usdc_token: acct(USDC),
        runner: acct("runner.test"),
        round: wire::RoundConstants {
            genesis_ms: G,
            round_ms: ROUND,
            guess_close_ms: 840_000,
            propose_from_ms: 900_000,
            propose_until_ms: 1_200_000,
            close_from_ms: 1_500_000,
            tail_fade_ms: 600_000,
        },
        min_first_deposit: U128(MIN_FIRST),
        pins: None,
        stickers: None,
        launchpad: None,
        lender: None,
    }
}

/// A fresh coin at `G + 1 s`, with alice and bob registered.
fn setup() -> Coin {
    ctx(G + 1_000, "owner.test");
    let mut c = Coin::new(config());
    for who in ["alice.test", "bob.test"] {
        ctx_paying(G + 1_000, who, Coin::storage_min());
        c.storage_deposit(None, None);
    }
    c
}

fn pay_in(c: &mut Coin, now: u64, who: &str, amount: u128, msg: &str) -> u128 {
    ctx(now, USDC);
    match c.ft_on_transfer(acct(who), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("pay-in never returns a promise"),
    }
}

const BRAVE: &str = r#"{"pool":"BRAVE"}"#;

fn last_events(c: &Coin, n: u32) -> Vec<String> {
    c.get_feed(None, Some(n))
        .into_iter()
        .map(|f| {
            serde_json::to_value(f.event)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

// ----- rounds -----------------------------------------------------------------------------------------

#[test]
fn init_opens_round_one_on_the_grid() {
    let c = setup();
    let r = c.get_round();
    assert_eq!(
        (r.id, r.started_at, r.phase, r.settled, r.stuck),
        (1, G, Phase::Open, false, false)
    );
    assert_eq!(r.ends_at, G + ROUND);
    assert_eq!(last_events(&c, 1), vec!["round_opened"]);
}

#[test]
#[should_panic(expected = "genesis_ms is in the future")]
fn genesis_cannot_be_in_the_future() {
    ctx(G - 1, "owner.test");
    Coin::new(config());
}

#[test]
fn an_empty_round_settles_itself_and_the_next_opens_on_the_grid() {
    let mut c = setup();
    // Views show round 2 the moment its slot starts, before any transaction.
    ctx(G + ROUND + 5, "anyone.test");
    let r = c.get_round();
    assert_eq!((r.id, r.started_at, r.phase), (2, G + ROUND, Phase::Open));
    let prev = c.get_round_by_id(1).unwrap();
    assert!(prev.settled && prev.result == Some(wire::I128(0)));
    // Skipped slots get no round: nothing happens until slot 5.
    ctx(G + 5 * ROUND + 7, "anyone.test");
    assert_eq!(
        c.get_round().id,
        2,
        "round 2 opens in slot 5 (slots 1-4 had no round written)"
    );
    assert_eq!(c.get_round().started_at, G + 5 * ROUND);
    // A write makes it real and logs it.
    pay_in(&mut c, G + 5 * ROUND + 7, "alice.test", MIN_FIRST, BRAVE);
    assert_eq!(c.current.unwrap().id, 2);
    assert!(c.get_round_by_id(1).unwrap().settled);
    let feed: Vec<String> = last_events(&c, 3);
    assert_eq!(feed, vec!["settled", "round_opened", "paid_in"]);
}

#[test]
fn phases_follow_the_clock() {
    let c = setup();
    for (ms, phase) in [
        (899_999, Phase::Open),
        (900_000, Phase::Propose),
        (1_200_000, Phase::Hold),
        (1_500_000, Phase::Close),
    ] {
        ctx(G + ms, "anyone.test");
        assert_eq!(c.get_round().phase, phase, "{ms}");
    }
}

// ----- pay in ---------------------------------------------------------------------------------------

#[test]
fn pay_in_waits_as_pending_and_becomes_coins_at_the_next_round() {
    let mut c = setup();
    assert_eq!(
        pay_in(&mut c, G + 60_000, "alice.test", 100_000_000, BRAVE),
        0,
        "nothing refunded"
    );
    let a = c.get_account(acct("alice.test"));
    assert_eq!(
        (a.coin, a.pending_brave, a.joined_round),
        (U128(0), U128(100_000_000), None)
    );
    let p = c.get_pot();
    assert_eq!(
        (p.brave.pending, p.brave.total, p.coin_supply, p.bosses),
        (U128(100_000_000), U128(0), U128(0), 0)
    );
    assert_eq!(last_events(&c, 1), vec!["paid_in"]);

    // Round 2: shown at once, no transaction yet. 1,000 units are locked for ever.
    ctx(G + ROUND, "anyone.test");
    let a = c.get_account(acct("alice.test"));
    assert_eq!(
        (a.coin, a.pending_brave, a.joined_round),
        (U128(99_999_000), U128(0), Some(2))
    );
    assert_eq!(a.brave_value, U128(99_999_000));
    let p = c.get_pot();
    assert_eq!(
        (
            p.brave.total,
            p.brave.pending,
            p.coin_supply,
            p.coin_price_e6,
            p.bosses
        ),
        (
            U128(100_000_000),
            U128(0),
            U128(100_000_000),
            U128(1_000_000),
            1
        )
    );
    assert_eq!(c.ft_balance_of(acct("alice.test")), U128(99_999_000));
    assert_eq!(c.ft_total_supply(), U128(100_000_000));
    assert_eq!(c.get_round().brave_at_open, U128(100_000_000));

    // Bob pays in; his write opens round 2 for real. Alice's coins are written when she acts.
    pay_in(&mut c, G + ROUND + 10, "bob.test", 50_000_000, BRAVE);
    assert_eq!(c.bal(&acct("alice.test")), 0, "not written yet");
    assert_eq!(
        c.get_account(acct("alice.test")).coin,
        U128(99_999_000),
        "but shown"
    );
    assert_eq!(
        c.token.total_supply, 1_000,
        "only the locked units are written"
    );
    // Round 3: Bob's coins at round 3's price; Alice's value unchanged (no dilution).
    ctx(G + 2 * ROUND, "anyone.test");
    let b = c.get_account(acct("bob.test"));
    assert_eq!(b.coin, U128(50_000_000));
    assert_eq!(
        c.get_account(acct("alice.test")).brave_value,
        U128(99_999_000)
    );
    assert_eq!(c.get_pot().bosses, 2);
}

#[test]
fn refunds_in_full() {
    let mut c = setup();
    let before = (c.books, c.feed.last_seq());
    // Any other token.
    ctx(G + 60_000, "junk.test");
    assert!(matches!(
        c.ft_on_transfer(acct("alice.test"), U128(50_000_000), BRAVE.into()),
        PromiseOrValue::Value(U128(50_000_000))
    ));
    // An unregistered sender, a bad message, zero, a first deposit under the minimum. (SAFE pay-ins
    // are credited since step 6: tests_safe.rs.)
    assert_eq!(
        pay_in(&mut c, G + 60_000, "carol.test", 50_000_000, BRAVE),
        50_000_000
    );
    assert_eq!(
        pay_in(&mut c, G + 60_000, "alice.test", 50_000_000, "BRAVE"),
        50_000_000
    );
    assert_eq!(
        pay_in(
            &mut c,
            G + 60_000,
            "alice.test",
            50_000_000,
            r#"{"pool":"BRAVE","x":1}"#
        ),
        50_000_000
    );
    assert_eq!(pay_in(&mut c, G + 60_000, "alice.test", 0, BRAVE), 0);
    assert_eq!(
        pay_in(&mut c, G + 60_000, "alice.test", MIN_FIRST - 1, BRAVE),
        MIN_FIRST - 1
    );
    assert_eq!((c.books, c.feed.last_seq()), before, "nothing changed");
    // Once a qualifying first deposit waits, smaller ones are fine.
    assert_eq!(
        pay_in(&mut c, G + 60_000, "alice.test", MIN_FIRST, BRAVE),
        0
    );
    assert_eq!(pay_in(&mut c, G + 60_000, "bob.test", 1, BRAVE), 0);
}

#[test]
fn a_first_round_under_the_minimum_keeps_waiting() {
    let mut c = setup();
    pay_in(&mut c, G + 60_000, "alice.test", MIN_FIRST, BRAVE);
    // Alice takes most of it back before the round opens, leaving less than the minimum.
    ctx_full(
        G + 61_000,
        "alice.test",
        NearToken::from_yoctonear(1),
        100,
        vec![],
    );
    let _ = c.cash_out(Pool::Brave, U128(MIN_FIRST - 5), Some(true));
    ctx(G + ROUND, "anyone.test");
    let a = c.get_account(acct("alice.test"));
    assert_eq!(
        (a.coin, a.pending_brave),
        (U128(0), U128(5)),
        "still waiting"
    );
    assert_eq!(c.get_pot().coin_supply, U128(0));
}

// ----- cash out ---------------------------------------------------------------------------------------

/// Alice holds 99,999,000 coins of a $100 pool, written.
fn alice_holds() -> Coin {
    let mut c = setup();
    pay_in(&mut c, G + 60_000, "alice.test", 100_000_000, BRAVE);
    ctx(G + ROUND, "alice.test");
    c.tick();
    c.materialize(&acct("alice.test"));
    c
}

fn cash_out(c: &mut Coin, who: &str, amount: u128, pending: bool) {
    ctx_full(
        G + ROUND + 100,
        who,
        NearToken::from_yoctonear(1),
        100,
        vec![],
    );
    let _ = c.cash_out(Pool::Brave, U128(amount), pending.then_some(true));
}

fn callback(c: &mut Coin, who: &str, coins: Option<u128>, paid: u128, ok: bool) -> bool {
    let r = if ok {
        PromiseResult::Successful(vec![])
    } else {
        PromiseResult::Failed
    };
    ctx_full(
        G + ROUND + 200,
        ME,
        NearToken::from_yoctonear(0),
        100,
        vec![r],
    );
    c.on_payout(acct(who), Pool::Brave, coins.map(U128), U128(paid))
}

#[test]
fn cash_out_burns_coins_first_and_logs_when_the_payout_lands() {
    let mut c = alice_holds();
    let seq = c.feed.last_seq();
    cash_out(&mut c, "alice.test", 49_999_500, false);
    // State first: coins burned and dollars out of the pool before USDC moves.
    assert_eq!(c.bal(&acct("alice.test")), 49_999_500);
    assert_eq!(c.books.brave_total, 100_000_000 - 49_999_500);
    assert_eq!(
        c.feed.last_seq(),
        seq,
        "no cashed_out until the payout lands"
    );
    assert_eq!(c.extra(&acct("alice.test")).in_flight, 1);
    assert!(callback(
        &mut c,
        "alice.test",
        Some(49_999_500),
        49_999_500,
        true
    ));
    assert_eq!(last_events(&c, 1), vec!["cashed_out"]);
    assert_eq!(c.extra(&acct("alice.test")).in_flight, 0);
    // The books add up: total = paid in − paid out.
    assert_eq!(c.get_pot().brave.total, U128(100_000_000 - 49_999_500));
}

#[test]
fn a_failed_payout_puts_everything_back() {
    let mut c = alice_holds();
    let (books, bal, supply) = (c.books, c.bal(&acct("alice.test")), c.supply());
    cash_out(&mut c, "alice.test", 10_000_000, false);
    assert!(!callback(
        &mut c,
        "alice.test",
        Some(10_000_000),
        10_000_000,
        false
    ));
    assert_eq!(
        (c.books, c.bal(&acct("alice.test")), c.supply()),
        (books, bal, supply)
    );
    assert!(get_logs().iter().any(|l| l.contains("failed: put back")));
    assert_eq!(c.extra(&acct("alice.test")).in_flight, 0);
}

#[test]
fn taking_back_pending_money_and_a_failure_putting_it_back() {
    let mut c = setup();
    pay_in(&mut c, G + 60_000, "alice.test", 30_000_000, BRAVE);
    ctx_full(
        G + 70_000,
        "alice.test",
        NearToken::from_yoctonear(1),
        100,
        vec![],
    );
    let _ = c.cash_out(Pool::Brave, U128(10_000_000), Some(true));
    assert_eq!(
        c.get_account(acct("alice.test")).pending_brave,
        U128(20_000_000)
    );
    assert_eq!(c.books.pending_total, 20_000_000);
    ctx_full(
        G + 80_000,
        ME,
        NearToken::from_yoctonear(0),
        100,
        vec![PromiseResult::Failed],
    );
    assert!(!c.on_payout(acct("alice.test"), Pool::Brave, None, U128(10_000_000)));
    assert_eq!(
        c.get_account(acct("alice.test")).pending_brave,
        U128(30_000_000)
    );
    assert_eq!(c.books.pending_total, 30_000_000);
}

#[test]
fn a_failed_pending_refund_after_a_conversion_waits_for_the_next_one() {
    let mut c = setup();
    pay_in(&mut c, G + 60_000, "alice.test", 30_000_000, BRAVE);
    ctx_full(
        G + 70_000,
        "alice.test",
        NearToken::from_yoctonear(1),
        100,
        vec![],
    );
    let _ = c.cash_out(Pool::Brave, U128(10_000_000), Some(true));
    // The round opens (converting the remaining 20) before the failed refund comes back.
    ctx(G + ROUND, "bob.test");
    c.tick();
    ctx_full(
        G + ROUND + 1,
        ME,
        NearToken::from_yoctonear(0),
        100,
        vec![PromiseResult::Failed],
    );
    c.on_payout(acct("alice.test"), Pool::Brave, None, U128(10_000_000));
    let a = c.get_account(acct("alice.test"));
    assert_eq!(
        a.coin,
        U128(19_999_000),
        "the 20 converted, minus the locked units"
    );
    assert_eq!(a.pending_brave, U128(10_000_000), "the 10 wait for round 3");
    assert_eq!(c.books.pending_total, 10_000_000);
}

#[test]
#[should_panic(expected = "attach at least 60 TGas")]
fn cash_out_needs_gas_for_the_callback() {
    let mut c = alice_holds();
    ctx_full(
        G + ROUND + 100,
        "alice.test",
        NearToken::from_yoctonear(1),
        59,
        vec![],
    );
    let _ = c.cash_out(Pool::Brave, U128(1), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn cash_out_needs_one_yocto() {
    let mut c = alice_holds();
    ctx_full(
        G + ROUND + 100,
        "alice.test",
        NearToken::from_yoctonear(0),
        100,
        vec![],
    );
    let _ = c.cash_out(Pool::Brave, U128(1), None);
}

#[test]
#[should_panic(expected = "not that many coins")]
fn cannot_cash_out_more_than_held() {
    let mut c = alice_holds();
    cash_out(&mut c, "alice.test", 99_999_001, false);
}

#[test]
fn cash_out_during_an_open_bet_leaves_the_margin_in_play() {
    let mut c = alice_holds();
    c.books.in_play = 20_000_000; // a $20 bet is out (bets arrive in step 4)
    cash_out(&mut c, "alice.test", 50_000_000, false);
    // 50,000,000 of 100,000,000 coins, of $80 held outside the bet.
    assert_eq!(c.books.brave_total, 100_000_000 - 40_000_000);
    assert_eq!(
        c.get_pot().coin_price_e6,
        U128((60_000_000u128 - 20_000_000) * 1_000_000 / 50_000_000)
    );
}

// ----- transfers and storage ---------------------------------------------------------------------------

#[test]
fn transfers_write_pending_coins_first_and_count_bosses() {
    let mut c = setup();
    pay_in(&mut c, G + 60_000, "alice.test", 100_000_000, BRAVE);
    ctx_paying(G + ROUND, "alice.test", NearToken::from_yoctonear(1));
    c.ft_transfer(acct("bob.test"), U128(1_000_000), None);
    assert_eq!(c.bal(&acct("alice.test")), 98_999_000);
    assert_eq!(c.bal(&acct("bob.test")), 1_000_000);
    assert_eq!(c.get_pot().bosses, 2);
    assert_eq!(c.get_account(acct("bob.test")).joined_round, Some(2));
    ctx_paying(G + ROUND, "bob.test", NearToken::from_yoctonear(1));
    c.ft_transfer(acct("alice.test"), U128(1_000_000), None);
    assert_eq!(c.get_pot().bosses, 1);
}

#[test]
#[should_panic(expected = "coins cannot be sent to the coin contract")]
fn coins_cannot_be_sent_to_the_contract() {
    let mut c = alice_holds();
    ctx_paying(G + ROUND, "alice.test", NearToken::from_yoctonear(1));
    c.ft_transfer(acct(ME), U128(1), None);
}

#[test]
fn registration_and_unregistration() {
    let mut c = setup();
    let b = c.storage_balance_bounds();
    assert_eq!(b.min, U128(Coin::storage_min().as_yoctonear()));
    assert!(c.storage_balance_of(acct("alice.test")).is_some());
    assert!(c.storage_balance_of(acct("carol.test")).is_none());
    // Empty: may leave.
    ctx_paying(G + 2_000, "bob.test", NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(None));
    assert!(!c.get_account(acct("bob.test")).registered);
}

#[test]
#[should_panic(expected = "cash out everything first")]
fn cannot_unregister_with_pending_money() {
    let mut c = setup();
    pay_in(&mut c, G + 60_000, "alice.test", MIN_FIRST, BRAVE);
    ctx_paying(G + 70_000, "alice.test", NearToken::from_yoctonear(1));
    c.storage_unregister(Some(true));
}

#[test]
fn one_boss_fits_in_the_registration_storage() {
    // A 64-character account id, registered, with pending money and every Extra field set.
    let mut c = setup();
    let long: AccountId = format!("{}.test", "a".repeat(59)).parse().unwrap();
    let before = env::storage_usage();
    ctx_paying(G + 2_000, long.as_str(), Coin::storage_min());
    c.storage_deposit(None, None);
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
    c.extras.flush();
    let used = env::storage_usage() - before;
    // The full check, with the vote-lock record of step 5, is in tests_vote.rs.
    println!("one boss uses {used} of {ACCOUNT_STORAGE_BYTES} bytes");
    assert!(
        used + 16 + 8 * 24 + 5 * 9 <= ACCOUNT_STORAGE_BYTES,
        "used {used}"
    );
}

#[test]
fn every_view_has_the_section_8_field_names() {
    let mut c = alice_holds();
    pay_in(&mut c, G + ROUND + 10, "bob.test", 20_000_000, BRAVE);
    ctx(G + ROUND + 20, "anyone.test");
    let keys = |v: serde_json::Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let sorted = |s: &[&str]| -> Vec<String> {
        let mut k: Vec<String> = s.iter().map(|x| x.to_string()).collect();
        k.sort();
        k
    };
    let j = |x: serde_json::Value| x;
    assert_eq!(
        keys(j(serde_json::to_value(c.get_round()).unwrap())),
        sorted(&[
            "id",
            "phase",
            "settled",
            "stuck",
            "started_at",
            "guess_closes_at",
            "propose_from",
            "propose_until",
            "close_from",
            "ends_at",
            "rank",
            "status",
            "brave_at_open",
            "bets_used",
            "at_risk",
            "skipped",
            "refused",
            "result"
        ])
    );
    assert_eq!(
        keys(serde_json::to_value(c.get_pot()).unwrap()),
        sorted(&[
            "brave",
            "safe",
            "coin_supply",
            "coin_price_e6",
            "bosses",
            "outside_income_total"
        ])
    );
    assert_eq!(
        keys(serde_json::to_value(c.get_account(acct("bob.test"))).unwrap()),
        sorted(&[
            "account_id",
            "registered",
            "coin",
            "locked",
            "brave_value",
            "pending_brave",
            "safe",
            "joined_round",
            "vote_weight"
        ])
    );
    let constants = serde_json::to_value(c.get_constants()).unwrap();
    assert_eq!(constants["interface_version"], "1.3");
    assert_eq!(constants["round"]["genesis_ms"], G);
    assert_eq!(constants["refusal_codes"].as_array().unwrap().len(), 16);
    assert_eq!(c.get_sticker_firsts().len(), 16);
    for f in c.get_feed(None, None) {
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(keys(v.clone()), sorted(&["seq", "at", "event", "data"]));
    }
}
