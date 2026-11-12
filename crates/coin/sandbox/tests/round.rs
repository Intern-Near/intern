//! Step 4 on a local NEAR node: `propose` with all sixteen checks, and bets settled with test
//! dollars really minted and burned (section 14.12). Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::{json, Value};
use std::path::PathBuf;

fn checks() -> Value {
    let p =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../interface/vectors/checks.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[tokio::test]
async fn all_26_interface_cases_through_the_deployed_propose() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let file = checks();
    for case in file["rule_cases"].as_array().unwrap() {
        let id = case["id"].as_u64().unwrap();
        let st = &case["state"];
        w.coin
            .call("test_set")
            .args_json(json!({"rank": st["rank"], "status": st["status"], "brave_at_open": st["brave_at_open"],
                              "brave_now": st["brave_now"], "bets_used": st["bets_used"], "at_risk": st["at_risk"],
                              "ms_into_round": st["ms_into_round"]}))
            .transact()
            .await?
            .into_result()?;
        let line = w.line_for(&case["decision"]).await?;
        let v = w.propose_text(&line).await?;
        let e = &case["expected"];
        assert_eq!(v["verdict"], e["verdict"], "case {id}: {v}");
        if e["verdict"] == "NOPE" {
            assert_eq!(
                (&v["code"], &v["asked"], &v["limit"]),
                (&e["code"], &e["asked"], &e["limit"]),
                "case {id}"
            );
        }
    }
    println!("26 of 26 interface cases gave the expected verdict on the deployed contract");
    Ok(())
}

#[tokio::test]
async fn bets_settle_with_real_test_dollars_and_the_books_keep_matching() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let [round_ms, _, propose_from, ..] = REAL;
    let alice = boss(&w, 2_000_000_000).await?;
    w.pay_in(&alice, &w.usdc, 1_000_000_000, BRAVE)
        .await?
        .into_result()?;

    // Round 2, in its proposal window: alice's $1,000 are coins and the pool's limit base.
    w.set_now(w.genesis_ms + round_ms + propose_from + 60_000)
        .await?;
    let bet = json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": "20000000", "leverage": 1});
    let v = w.propose_text(&w.line_for(&bet).await?).await?;
    assert_eq!(v["verdict"], "YES", "{v}");
    let pid = v["position_id"].as_u64().unwrap();
    let pot = w.pot().await?;
    assert_eq!(
        (u(&pot["brave"]["total"]), u(&pot["brave"]["in_play"])),
        (1_000_000_000, 20_000_000)
    );
    w.books_match(0).await?;

    // A NOPE changes no money: the INTERN has used its one bet.
    let before = w.pot().await?;
    let v = w.propose_text(&w.line_for(&bet).await?).await?;
    assert_eq!(
        (v["verdict"].as_str(), v["code"].as_str()),
        (Some("NOPE"), Some("TOO_MANY_TRADES"))
    );
    assert_eq!(w.pot().await?, before);

    // Only the runner may propose.
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    let r = alice
        .call(w.coin.id(), "propose")
        .args_json(json!({"request": b64(b"x"), "response": b64(b"x"), "signature": b64(b"FAKE")}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(r.is_failure(), "a stranger's proposal must be rejected");
    assert_eq!(
        w.view(&w.coin, "get_rulebook", json!({})).await?,
        rb,
        "and it changed nothing"
    );

    // A win of $5: the program mints 5 test dollars into itself, then settles.
    w.runner
        .call(w.coin.id(), "report_result")
        .args_json(json!({"position_id": pid, "returned": "25000000"}))
        .transact()
        .await?
        .into_result()?;
    let s = alice
        .call(w.coin.id(), "settle")
        .args_json(json!({"round_id": 2}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_eq!(
        s.json::<Value>()?,
        json!("5000000"),
        "settle returns the round's result"
    );
    let pot = w.pot().await?;
    assert_eq!(
        (u(&pot["brave"]["total"]), u(&pot["brave"]["in_play"])),
        (1_005_000_000, 0)
    );
    w.books_match(0).await?;
    assert_eq!(w.round().await?["settled"], true);

    // Round 3: a loss of $8. The program burns 8 test dollars, then settles.
    w.set_now(w.genesis_ms + 2 * round_ms + propose_from + 60_000)
        .await?;
    let v = w.propose_text(&w.line_for(&bet).await?).await?;
    assert_eq!(v["verdict"], "YES", "{v}");
    let pid = v["position_id"].as_u64().unwrap();
    w.runner
        .call(w.coin.id(), "report_result")
        .args_json(json!({"position_id": pid, "returned": "12000000"}))
        .transact()
        .await?
        .into_result()?;
    let s = alice
        .call(w.coin.id(), "settle")
        .args_json(json!({"round_id": 3}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_eq!(s.json::<Value>()?, json!("-8000000"));
    assert_eq!(u(&w.pot().await?["brave"]["total"]), 997_000_000);
    w.books_match(0).await?;

    // Alice's coins carry the result: she holds all coins but the 1,000 locked units.
    let a = w.account(&alice).await?;
    assert_eq!(
        u(&a["brave_value"]),
        997_000_000u128 * 999_999_000 / 1_000_000_000
    );
    let feed: Value = w.view(&w.coin, "get_feed", json!({"limit": 100})).await?;
    let events: Vec<&str> = feed
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["event"].as_str().unwrap())
        .collect();
    for e in ["approved", "refused", "result_reported", "settled"] {
        assert!(events.contains(&e), "{e} missing from {events:?}");
    }
    Ok(())
}
