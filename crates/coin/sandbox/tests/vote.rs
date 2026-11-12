//! Step 5 on a local NEAR node: two bosses lock, promote the Intern, see the promotion wait two
//! rounds, then fire it and watch `propose` refuse in the same round. Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::{json, Value};

#[tokio::test]
async fn lock_promote_wait_two_rounds_then_fire() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let [round_ms, _, propose_from, ..] = REAL;
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * round_ms + into;
    let a = boss(&w, 1_000_000_000).await?;
    let b = boss(&w, 1_000_000_000).await?;
    w.pay_in(&a, &w.usdc, 500_000_000, BRAVE)
        .await?
        .into_result()?;
    w.pay_in(&b, &w.usdc, 500_000_000, BRAVE)
        .await?
        .into_result()?;

    // Round 2: both hold coins and lock them.
    w.set_now(at(2, 1_000)).await?;
    // Both converted in the same round, so they share the 1,000 units locked for ever: 499,999,500 each.
    for who in [&a, &b] {
        let n = u(&w.account(who).await?["coin"]);
        assert_eq!(n, 499_999_500);
        who.call(w.coin.id(), "lock")
            .args_json(json!({"amount": n.to_string()}))
            .transact()
            .await?
            .into_result()?;
    }
    assert_eq!(u(&w.account(&a).await?["locked"]), 499_999_500);
    // Locked coins cannot leave.
    let r = a
        .call(w.coin.id(), "ft_transfer")
        .args_json(json!({"receiver_id": b.id(), "amount": "1"}))
        .deposit(yocto(1))
        .transact()
        .await?;
    assert!(r.is_failure(), "locked coins moved");

    // Round 4: one full round has passed (round 3), so the locks weigh 1/7.
    w.set_now(at(3, 1_000)).await?;
    w.set_now(at(4, 1_000)).await?;
    assert_eq!(u(&w.account(&b).await?["vote_weight"]), 499_999_500 / 7);
    let id: u64 = a
        .call(w.coin.id(), "open_vote")
        .args_json(json!({"kind": "PROMOTE"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    for who in [&a, &b] {
        who.call(w.coin.id(), "cast")
            .args_json(json!({"vote_id": id, "support": true}))
            .transact()
            .await?
            .into_result()?;
    }
    // Voted: cannot unlock while the vote is open.
    let r = a
        .call(w.coin.id(), "unlock")
        .args_json(json!({"amount": "1"}))
        .transact()
        .await?;
    assert!(r.is_failure(), "unlocked during an open vote");

    // Round 5, past closes_at: finish. It passed and waits for round 7.
    w.set_now(at(5, 2_000)).await?;
    let v: Value = b
        .call(w.coin.id(), "finish_vote")
        .args_json(json!({"vote_id": id}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        (v["state"].as_str(), v["effective_round"].as_u64()),
        (Some("PASSED"), Some(7))
    );
    let rank = w.view(&w.coin, "get_rank", json!({})).await?;
    assert_eq!(rank["rank"], "INTERN");
    assert_eq!(
        rank["pending"],
        json!({"rank": "ANALYST", "status": "EMPLOYED", "effective_round": 7})
    );
    w.set_now(at(6, 1_000)).await?;
    assert_eq!(
        w.view(&w.coin, "get_rank", json!({})).await?["rank"],
        "INTERN",
        "not in the next round"
    );
    w.set_now(at(7, propose_from + 60_000)).await?;
    let rank = w.view(&w.coin, "get_rank", json!({})).await?;
    assert_eq!(
        (rank["rank"].as_str(), &rank["pending"]),
        (Some("ANALYST"), &Value::Null)
    );
    assert_eq!(w.round().await?["rank"], "ANALYST");

    // Round 7, in the proposal window: fire. Half the weight says yes: finished at once.
    let f: u64 = b
        .call(w.coin.id(), "open_vote")
        .args_json(json!({"kind": "FIRE"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    b.call(w.coin.id(), "cast")
        .args_json(json!({"vote_id": f, "support": true}))
        .transact()
        .await?
        .into_result()?;
    let v: Value = a
        .call(w.coin.id(), "finish_vote")
        .args_json(json!({"vote_id": f}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(v["state"], "PASSED");
    assert_eq!(
        w.view(&w.coin, "get_rank", json!({})).await?["status"],
        "FIRED"
    );
    // propose in the same round: NOPE, FIRED.
    let bet = json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": "10000000", "leverage": 1});
    let v = w.propose_text(&w.line_for(&bet).await?).await?;
    assert_eq!(
        (v["verdict"].as_str(), v["code"].as_str()),
        (Some("NOPE"), Some("FIRED"))
    );
    // Cash-out still works for free coins: a unlocks some (its votes are closed now) and leaves.
    w.set_now(at(8, 1_000)).await?;
    a.call(w.coin.id(), "unlock")
        .args_json(json!({"amount": "100000000"}))
        .transact()
        .await?
        .into_result()?;
    let before = w.usdc_of(a.id()).await?;
    w.cash_out(&a, 100_000_000, false).await?.into_result()?;
    assert!(w.usdc_of(a.id()).await? > before);
    w.books_match(0).await?;

    let feed: Value = w.view(&w.coin, "get_feed", json!({"limit": 100})).await?;
    let events: Vec<&str> = feed
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    for e in [
        "locked",
        "vote_opened",
        "vote_cast",
        "vote_finished",
        "rank_changed",
        "fired",
        "refused",
        "unlocked",
    ] {
        assert!(events.contains(&e), "{e} missing from {events:?}");
    }
    let votes: Value = w.view(&w.coin, "get_votes", json!({})).await?;
    assert_eq!(votes.as_array().unwrap().len(), 2);
    let _ = Gas::from_tgas(1);
    println!("lock → promote → ANALYST two rounds later → fire → propose refused FIRED: all on the deployed contract");
    Ok(())
}
