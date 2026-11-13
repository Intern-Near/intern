use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(who: &str, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct("tickets.test"))
        .predecessor_account_id(acct(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}
fn fresh() -> Tickets {
    ctx("owner.test", 0);
    let mut t = Tickets::new(acct("coin.test"), acct("usdc.test"));
    ctx("coin.test", 20_000_000_000_000_000_000_000);
    t.mint("golden:FIRED".into(), acct("alice.test"), U128(3), "Golden FIRED".into(), "A golden sticker".into());
    t
}

#[test]
fn only_the_coin_mints_and_balances_and_supply_add_up() {
    let mut t = fresh();
    assert_eq!(t.mt_balance_of(acct("alice.test"), "golden:FIRED".into()), U128(3));
    assert_eq!(t.mt_supply("golden:FIRED".into()), Some(U128(3)));
    assert!(get_logs()[0].contains("\"standard\":\"nep245\"") && get_logs()[0].contains("mt_mint"));
    ctx("alice.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| t.mint("golden:FIRED".into(), acct("alice.test"), U128(1), "x".into(), "y".into()))).is_err());
    assert_eq!(t.mt_token(vec!["golden:FIRED".into(), "nope".into()])[0].as_ref().unwrap().title, "Golden FIRED");
}

#[test]
fn transfers_move_units_and_need_one_yocto() {
    let mut t = fresh();
    ctx("alice.test", 1);
    t.mt_transfer(acct("bob.test"), "golden:FIRED".into(), U128(2), None, None);
    assert_eq!(t.mt_batch_balance_of(acct("bob.test"), vec!["golden:FIRED".into()]), vec![U128(2)]);
    ctx("alice.test", 1);
    assert!(catch_unwind(AssertUnwindSafe(|| t.mt_transfer(acct("bob.test"), "golden:FIRED".into(), U128(2), None, None))).is_err());
    ctx("alice.test", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| t.mt_transfer(acct("bob.test"), "golden:FIRED".into(), U128(1), None, None))).is_err());
    ctx("bob.test", 1);
    t.mt_batch_transfer(acct("carol.test"), vec!["golden:FIRED".into()], vec![U128(1)], None, None);
    assert_eq!(t.mt_balance_of(acct("carol.test"), "golden:FIRED".into()), U128(1));
}

#[test]
fn a_listing_sells_units_for_usdc_and_refunds_what_is_wrong() {
    let mut t = fresh();
    ctx("alice.test", 1);
    let id = t.list("golden:FIRED".into(), U128(2), U128(1_500_000));
    assert_eq!(t.mt_balance_of(acct("alice.test"), "golden:FIRED".into()), U128(1));
    assert_eq!(t.get_listings(None, None).len(), 1);
    // Another token than the pinned USDC, too little, or more than listed: refunded in full.
    ctx("fake.test", 0);
    let msg = format!(r#"{{"buy":{{"listing_id":{id},"amount":"1"}}}}"#);
    assert!(matches!(t.ft_on_transfer(acct("bob.test"), U128(1_500_000), msg.clone()), PromiseOrValue::Value(U128(1_500_000))));
    ctx("usdc.test", 0);
    assert!(matches!(t.ft_on_transfer(acct("bob.test"), U128(1_000_000), msg.clone()), PromiseOrValue::Value(U128(1_000_000))));
    let three = format!(r#"{{"buy":{{"listing_id":{id},"amount":"3"}}}}"#);
    assert!(matches!(t.ft_on_transfer(acct("bob.test"), U128(9_000_000), three), PromiseOrValue::Value(U128(9_000_000))));
    // A good purchase: one unit to bob, the change back.
    assert!(matches!(t.ft_on_transfer(acct("bob.test"), U128(2_000_000), msg), PromiseOrValue::Value(U128(500_000))));
    assert_eq!(t.mt_balance_of(acct("bob.test"), "golden:FIRED".into()), U128(1));
    assert_eq!(t.get_listings(None, None)[0].amount, U128(1));
    // The seller takes the rest back.
    ctx("bob.test", 1);
    assert!(catch_unwind(AssertUnwindSafe(|| t.unlist(id))).is_err());
    ctx("alice.test", 1);
    t.unlist(id);
    assert_eq!(t.mt_balance_of(acct("alice.test"), "golden:FIRED".into()), U128(2));
    assert!(t.get_listings(None, None).is_empty());
}
