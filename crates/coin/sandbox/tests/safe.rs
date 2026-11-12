//! Step 6 on a local NEAR node: SAFE pay-in, the dial both ways, SAFE cash-out, a BRAVE loss that
//! leaves SAFE alone, with the USDC the program holds matching its books after every move.
//! Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::{json, Value};

const SAFE: &str = r#"{"pool":"SAFE"}"#;

#[tokio::test]
async fn safe_and_the_dial_with_real_test_dollars() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let [round_ms, _, propose_from, ..] = REAL;
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * round_ms + into;
    let a = boss(&w, 2_000_000_000).await?;
    let s = boss(&w, 1_000_000_000).await?; // a SAFE-only boss

    // Pay in: BRAVE waits, SAFE is credited at once.
    w.pay_in(&a, &w.usdc, 1_000_000_000, BRAVE)
        .await?
        .into_result()?;
    w.pay_in(&a, &w.usdc, 300_000_000, SAFE)
        .await?
        .into_result()?;
    w.pay_in(&s, &w.usdc, 400_000_000, SAFE)
        .await?
        .into_result()?;
    let acc = w.account(&a).await?;
    assert_eq!(
        (u(&acc["safe"]), u(&acc["pending_brave"])),
        (300_000_000, 1_000_000_000)
    );
    let pot = w.pot().await?;
    assert_eq!(
        (u(&pot["safe"]["total"]), u(&pot["safe"]["idle"])),
        (700_000_000, 700_000_000)
    );
    w.books_match(0).await?;

    // Round 2: coins; SAFE is not in the limit base.
    w.set_now(at(2, 1_000)).await?;
    assert_eq!(u(&w.round().await?["brave_at_open"]), 1_000_000_000);

    // Dial 100,000,000 coins to SAFE: $100 arrive at once.
    let dial = |who: &near_workspaces::Account, to: &str, n: u128| {
        who.call(w.coin.id(), "turn_dial")
            .args_json(json!({"to": to, "amount": n.to_string()}))
            .deposit(yocto(1))
            .transact()
    };
    dial(&a, "SAFE", 100_000_000).await?.into_result()?;
    let acc = w.account(&a).await?;
    assert_eq!(
        (u(&acc["coin"]), u(&acc["safe"])),
        (899_999_000, 400_000_000)
    );
    w.books_match(0).await?;
    // Dial $50 back to BRAVE: waits for the next round.
    dial(&a, "BRAVE", 50_000_000).await?.into_result()?;
    assert_eq!(u(&w.account(&a).await?["pending_brave"]), 50_000_000);
    w.books_match(0).await?;
    w.set_now(at(3, propose_from + 60_000)).await?;
    let acc = w.account(&a).await?;
    assert_eq!(
        (u(&acc["coin"]), u(&acc["safe"]), u(&acc["pending_brave"])),
        (949_999_000, 350_000_000, 0)
    );

    // A $10 loss on a BRAVE bet: BRAVE takes it, SAFE does not move.
    let bet = json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": "15000000", "leverage": 1});
    let v = w.propose_text(&w.line_for(&bet).await?).await?;
    assert_eq!(v["verdict"], "YES", "{v}");
    let pid = v["position_id"].as_u64().unwrap();
    w.runner
        .call(w.coin.id(), "report_result")
        .args_json(json!({"position_id": pid, "returned": "5000000"}))
        .transact()
        .await?
        .into_result()?;
    let r = a
        .call(w.coin.id(), "settle")
        .args_json(json!({"round_id": 3}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_eq!(r.json::<Value>()?, json!("-10000000"));
    let pot = w.pot().await?;
    assert_eq!(
        (u(&pot["brave"]["total"]), u(&pot["safe"]["total"])),
        (940_000_000, 750_000_000)
    );
    assert_eq!(u(&w.account(&s).await?["safe"]), 400_000_000);
    w.books_match(0).await?;

    // The SAFE-only boss has no vote and no coin.
    let acc = w.account(&s).await?;
    assert_eq!((u(&acc["coin"]), u(&acc["vote_weight"])), (0, 0));
    assert!(s
        .call(w.coin.id(), "lock")
        .args_json(json!({"amount": "1"}))
        .transact()
        .await?
        .is_failure());

    // Cash out SAFE: dollars straight back.
    let before = w.usdc_of(s.id()).await?;
    w.cash_out_pool(&s, "SAFE", 150_000_000)
        .await?
        .into_result()?;
    assert_eq!(w.usdc_of(s.id()).await? - before, 150_000_000);
    assert_eq!(u(&w.account(&s).await?["safe"]), 250_000_000);
    w.books_match(0).await?;
    let feed: Value = w.view(&w.coin, "get_feed", json!({"limit": 100})).await?;
    let n = |e: &str| {
        feed.as_array()
            .unwrap()
            .iter()
            .filter(|f| f["event"] == e)
            .count()
    };
    assert_eq!(n("dial_turned"), 2);
    assert!(feed
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["event"] == "cashed_out"
            && f["data"]["pool"] == "SAFE"
            && f["data"]["coins"].is_null()));
    println!("SAFE pay-in, dial both ways, a BRAVE loss, SAFE cash-out: books matched the USDC held after every move");
    Ok(())
}
