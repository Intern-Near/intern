//! Step 3 on a local NEAR node (near-workspaces sandbox): mock-usdc and the coin deployed, test
//! dollars really moving. Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

#[tokio::test]
async fn the_brave_pool_end_to_end() -> anyhow::Result<()> {
    let w = world(MINUTE).await?;
    let min: Value = w.view(&w.coin, "storage_balance_bounds", json!({})).await?;
    println!("registration costs {} yoctoNEAR", u(&min["min"]));
    let alice = boss(&w, 1_000_000_000).await?;
    let bob = boss(&w, 1_000_000_000).await?;
    assert_eq!(w.round_id().await?, 1);

    // ----- pay in: waits as pending
    let r = w.pay_in(&alice, &w.usdc, 100_000_000, BRAVE).await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(w.usdc_of(alice.id()).await?, 900_000_000);
    let a = w.account(&alice).await?;
    assert_eq!((u(&a["coin"]), u(&a["pending_brave"])), (0, 100_000_000));
    assert_eq!(u(&w.pot().await?["brave"]["pending"]), 100_000_000);
    w.books_match(0).await?;

    // ----- the next round: coins appear (1,000 units locked for ever), shown before any write
    w.reach_round(2).await?;
    let a = w.account(&alice).await?;
    assert_eq!((u(&a["coin"]), u(&a["pending_brave"])), (99_999_000, 0));
    let pot = w.pot().await?;
    assert_eq!(
        (
            u(&pot["brave"]["total"]),
            u(&pot["coin_supply"]),
            u(&pot["coin_price_e6"])
        ),
        (100_000_000, 100_000_000, 1_000_000)
    );
    w.books_match(0).await?;

    // ----- someone sends USDC outside the pay-in path: the books ignore it (no price bending)
    bob.call(w.usdc.id(), "ft_transfer")
        .args_json(json!({"receiver_id": w.coin.id(), "amount": "500000000"}))
        .deposit(yocto(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        u(&w.pot().await?["coin_price_e6"]),
        1_000_000,
        "the gift does not move the price"
    );
    w.books_match(500_000_000).await?;

    // ----- a second depositor is not diluted by the first, and does not dilute the first
    assert!(w
        .pay_in(&bob, &w.usdc, 50_000_000, BRAVE)
        .await?
        .is_success());
    w.reach_round(3).await?;
    let b = w.account(&bob).await?;
    assert_eq!(u(&b["coin"]), 50_000_000, "bob gets coins at $1.00");
    assert_eq!(u(&b["brave_value"]), 50_000_000);
    assert_eq!(u(&w.account(&alice).await?["brave_value"]), 99_999_000);
    w.books_match(500_000_000).await?;

    // ----- a junk token changes nothing
    let junk = token(&w.worker).await?;
    alice
        .call(junk.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    junk.call("storage_deposit")
        .args_json(json!({"account_id": w.coin.id()}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    alice
        .call(junk.id(), "mint")
        .args_json(json!({"account_id": alice.id(), "amount": "77000000"}))
        .transact()
        .await?
        .into_result()?;
    let pot_before = w.pot().await?;
    assert!(w
        .pay_in(&alice, &junk, 77_000_000, BRAVE)
        .await?
        .is_success());
    assert_eq!(
        u(
            &w.view(&junk, "ft_balance_of", json!({"account_id": alice.id()}))
                .await?
        ),
        77_000_000,
        "refunded in full"
    );
    assert_eq!(
        u(
            &w.view(&junk, "ft_balance_of", json!({"account_id": w.coin.id()}))
                .await?
        ),
        0
    );
    assert_eq!(w.pot().await?, pot_before, "the pool did not move");

    // ----- an unregistered sender and a bad message are refunded in full
    let carol = w.worker.dev_create_account().await?;
    carol
        .call(w.usdc.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    carol
        .call(w.usdc.id(), "mint")
        .args_json(json!({"account_id": carol.id(), "amount": "20000000"}))
        .transact()
        .await?
        .into_result()?;
    w.pay_in(&carol, &w.usdc, 20_000_000, BRAVE)
        .await?
        .into_result()?;
    assert_eq!(w.usdc_of(carol.id()).await?, 20_000_000);
    w.pay_in(&alice, &w.usdc, 20_000_000, "BRAVE please")
        .await?
        .into_result()?;
    assert_eq!(w.usdc_of(alice.id()).await?, 900_000_000);
    w.books_match(500_000_000).await?;

    // ----- cash out: coins burned, USDC paid, numbers add up
    let alice_usdc = w.usdc_of(alice.id()).await?;
    let r = w.cash_out(&alice, 49_999_000, false).await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(u(&w.account(&alice).await?["coin"]), 50_000_000);
    assert_eq!(
        w.usdc_of(alice.id()).await? - alice_usdc,
        49_999_000,
        "price $1.00"
    );
    assert_eq!(
        u(&w.pot().await?["brave"]["total"]),
        150_000_000 - 49_999_000
    );
    w.books_match(500_000_000).await?;
    let feed: Value = w.view(&w.coin, "get_feed", json!({"limit": 3})).await?;
    assert!(
        feed.as_array()
            .unwrap()
            .iter()
            .any(|f| f["event"] == "cashed_out" && u(&f["data"]["paid"]) == 49_999_000),
        "{feed}"
    );

    // ----- taking back money still waiting
    w.pay_in(&bob, &w.usdc, 20_000_000, BRAVE)
        .await?
        .into_result()?;
    let bob_usdc = w.usdc_of(bob.id()).await?;
    w.cash_out(&bob, 5_000_000, true).await?.into_result()?;
    assert_eq!(w.usdc_of(bob.id()).await? - bob_usdc, 5_000_000);
    assert_eq!(u(&w.account(&bob).await?["pending_brave"]), 15_000_000);
    w.books_match(500_000_000).await?;

    // ----- a failed payout puts the balance back: alice leaves USDC (force burns her test
    // dollars), so the payout to her cannot land
    alice
        .call(w.usdc.id(), "storage_unregister")
        .args_json(json!({"force": true}))
        .deposit(yocto(1))
        .transact()
        .await?
        .into_result()?;
    let (a_before, pot_before) = (w.account(&alice).await?, w.pot().await?);
    let r = w.cash_out(&alice, 10_000_000, false).await?;
    assert!(
        r.logs().iter().any(|l| l.contains("failed: put back")),
        "{:?}",
        r.logs()
    );
    assert_eq!(w.account(&alice).await?, a_before, "coins back");
    assert_eq!(w.pot().await?, pot_before, "pool back");
    w.books_match(500_000_000).await?;

    // ----- nobody can leave the coin while holding coins
    let r = alice
        .call(w.coin.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(yocto(1))
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn a_first_deposit_under_the_minimum_is_refunded() -> anyhow::Result<()> {
    let w = world(MINUTE).await?;
    let alice = boss(&w, 100_000_000).await?;
    w.pay_in(&alice, &w.usdc, MIN_FIRST - 1, BRAVE)
        .await?
        .into_result()?;
    assert_eq!(w.usdc_of(alice.id()).await?, 100_000_000, "refunded");
    assert_eq!(u(&w.pot().await?["brave"]["pending"]), 0);
    w.pay_in(&alice, &w.usdc, MIN_FIRST, BRAVE)
        .await?
        .into_result()?;
    assert_eq!(u(&w.pot().await?["brave"]["pending"]), MIN_FIRST);
    Ok(())
}
