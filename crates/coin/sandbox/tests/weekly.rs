//! Leagues and the weekly review (interface 1.6) on a local NEAR node: a week with a win, a loss and a refusal is
//! reviewed at the next week's first `rewards_tick`, its league closes with its top three, and the review takes a
//! stamp. Then the 1.5 contract coin-fast runs today (its exact code, `fixtures/coin-fast-1.5.wasm`, sha256 =
//! coin-fast's code_hash DdPGoc…) upgraded in place to 1.6 with no migration: the pool, the books, the reward
//! ladder and the feed are kept, the weeks before the upgrade get a backfilled review, and new guesses join a
//! league. Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

async fn call(who: &Account, to: &Contract, method: &str, args: Value, deposit: NearToken) -> anyhow::Result<Value> {
    let out = who.call(to.id(), method).args_json(args).deposit(deposit).gas(Gas::from_tgas(300)).transact().await?;
    let logs: Vec<String> = out.logs().iter().map(|s| s.to_string()).collect();
    let r = out.into_result().map_err(|e| anyhow::anyhow!("{method}: {e:?} {logs:?}"))?;
    Ok(r.json::<Value>().unwrap_or(Value::Null))
}

const NO: NearToken = NearToken::from_yoctonear(0);

fn bet(margin: &str) -> Value {
    json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": margin, "leverage": 1})
}

#[tokio::test]
async fn a_week_with_a_win_a_loss_and_a_refusal_is_reviewed_and_its_league_closes() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let [round_ms, _, propose_from, ..] = REAL;
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * round_ms + into;
    let alice = boss(&w, 2_000_000_000).await?;
    let bob = boss(&w, 1_000_000).await?;
    w.pay_in(&alice, &w.usdc, 1_000_000_000, BRAVE).await?.into_result()?;

    // Round 2: alice guesses YES, bob NOPE; a $20 bet is approved and comes back $25.
    w.set_now(at(2, 1_000)).await?;
    call(&alice, &w.coin, "guess", json!({"verdict": "YES"}), NO).await?;
    call(&bob, &w.coin, "guess", json!({"verdict": "NOPE"}), NO).await?;
    w.set_now(at(2, propose_from + 60_000)).await?;
    let v = w.propose_text(&w.line_for(&bet("20000000")).await?).await?;
    assert_eq!(v["verdict"], "YES", "{v}");
    let win = v["position_id"].as_u64().unwrap();
    call(&w.runner, &w.coin, "report_result", json!({"position_id": win, "returned": "25000000"}), NO).await?;
    call(&alice, &w.coin, "settle", json!({"round_id": 2}), NO).await?;

    // Round 3: both guess YES; a $20 bet comes back $12; a second bet is refused (TOO_MANY_TRADES).
    w.set_now(at(3, 1_000)).await?;
    call(&alice, &w.coin, "guess", json!({"verdict": "YES"}), NO).await?;
    call(&bob, &w.coin, "guess", json!({"verdict": "YES"}), NO).await?;
    w.set_now(at(3, propose_from + 60_000)).await?;
    let v = w.propose_text(&w.line_for(&bet("20000000")).await?).await?;
    let loss = v["position_id"].as_u64().unwrap();
    let v = w.propose_text(&w.line_for(&bet("20000000")).await?).await?;
    assert_eq!(v["code"], "TOO_MANY_TRADES", "{v}");
    call(&w.runner, &w.coin, "report_result", json!({"position_id": loss, "returned": "12000000"}), NO).await?;
    call(&alice, &w.coin, "settle", json!({"round_id": 3}), NO).await?;

    // The league while the week runs.
    let l = w.view(&w.coin, "get_league", json!({})).await?;
    assert_eq!((l["week"].as_u64(), l["players"].as_u64(), l["closed"].as_bool()), (Some(0), Some(2), Some(false)));
    assert_eq!(l["standings"][0]["account_id"], alice.id().as_str());
    assert_eq!((l["standings"][0]["points"].as_u64(), l["standings"][0]["best_run"].as_u64()), (Some(2), Some(2)));
    assert_eq!((l["standings"][1]["points"].as_u64(), l["standings"][1]["wrong"].as_u64()), (Some(1), Some(1)));

    // Rounds 4 to 7 open and close with nothing; round 8 is week 1, whose first rewards_tick closes week 0.
    for r in 4..=7 {
        w.set_now(at(r, 1_000)).await?;
        call(&bob, &w.coin, "rewards_tick", json!({}), NO).await?;
    }
    assert_eq!(w.view(&w.coin, "get_review", json!({"week": 0})).await?, Value::Null);
    w.set_now(at(8, 1_000)).await?;
    let out = bob.call(w.coin.id(), "rewards_tick").args_json(json!({})).gas(Gas::from_tgas(150)).transact().await?;
    let burnt = out.total_gas_burnt.as_tgas();
    out.into_result()?;
    let r = w.view(&w.coin, "get_review", json!({"week": 0})).await?;
    // Every round of the week opened and settled (a round without a bet settles with nothing to do).
    assert_eq!((r["rounds"].as_u64(), r["settled"].as_u64()), (Some(7), Some(7)), "{r}");
    assert_eq!((r["bets"].as_u64(), r["refused"].as_u64(), r["skipped"].as_u64()), (Some(2), Some(1), Some(0)));
    assert_eq!(r["result"], "-3000000");
    assert_eq!((r["best_bet"]["position_id"].as_u64(), r["best_bet"]["result"].as_str()), (Some(win), Some("5000000")));
    assert_eq!((r["worst_bet"]["position_id"].as_u64(), r["worst_bet"]["result"].as_str()), (Some(loss), Some("-8000000")));
    assert_eq!(r["refusals"], json!([{"code": "TOO_MANY_TRADES", "count": 1}]));
    assert_eq!((r["rank_start"].as_str(), r["rank_end"].as_str(), r["backfilled"].as_bool()), (Some("INTERN"), Some("INTERN"), Some(false)));
    // Round 1 opened before alice's money became coins (round 2): the week started with an empty pool.
    assert_eq!(u(&r["pool_start"]), 0);
    assert_eq!(u(&r["pool_end"]), 997_000_000);
    let l = w.view(&w.coin, "get_league", json!({"week": 0})).await?;
    assert_eq!(l["closed"], true);
    assert_eq!(l["standings"].as_array().unwrap().len(), 2);
    let feed = w.view(&w.coin, "get_feed", json!({"limit": 20})).await?;
    let names: Vec<&str> = feed.as_array().unwrap().iter().map(|f| f["event"].as_str().unwrap()).collect();
    assert!(names.contains(&"league_closed") && names.contains(&"review_written"), "{names:?}");

    // A stamp; the same account cannot stamp twice.
    let v = call(&alice, &w.coin, "stamp_review", json!({"week": 0}), NO).await?;
    assert_eq!((v["stamps"].as_u64(), v["bar"].as_u64(), v["stamping_open"].as_bool()), (Some(1), Some(5), Some(true)));
    assert!(call(&alice, &w.coin, "stamp_review", json!({"week": 0}), NO).await.is_err());
    w.books_match(0).await?;
    println!("weekly: the week-0 review and league written by one rewards_tick ({burnt} TGas burnt)");
    Ok(())
}

#[tokio::test]
async fn a_1_5_contract_upgrades_in_place_keeping_everything() -> anyhow::Result<()> {
    // The exact code coin-fast runs on testnet today.
    let old = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/coin-fast-1.5.wasm"))?;
    let worker = near_workspaces::sandbox().await?;
    let usdc = token(&worker).await?;
    let coin = worker.dev_deploy(&old).await?;
    let genesis_ms = worker.view_block().await?.timestamp() / 1_000_000;
    let runner = worker.dev_create_account().await?;
    let c = MINUTE;
    coin.call("new")
        .args_json(json!({"config": {
            "usdc_token": usdc.id(), "runner": runner.id(),
            "round": {"genesis_ms": genesis_ms, "round_ms": c[0], "guess_close_ms": c[1], "propose_from_ms": c[2],
                      "propose_until_ms": c[3], "close_from_ms": c[4], "tail_fade_ms": c[5]},
            "min_first_deposit": MIN_FIRST.to_string(),
        }}))
        .transact()
        .await?
        .into_result()?;
    usdc.call("storage_deposit").args_json(json!({"account_id": coin.id()})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    let w = World { worker, usdc, coin, runner, genesis_ms };
    let alice = boss(&w, 1_000_000_000).await?;
    w.pay_in(&alice, &w.usdc, 600_000_000, BRAVE).await?.into_result()?;
    w.pay_in(&alice, &w.usdc, 20_000_000, r#"{"tip":{}}"#).await?.into_result()?;
    w.reach_round(2).await?;
    let pot_before = w.pot().await?;
    let rewards_before = w.view(&w.coin, "get_rewards", json!({})).await?;
    let feed_before = w.view(&w.coin, "get_feed", json!({"limit": 100})).await?;
    assert_eq!(w.view(&w.coin, "get_constants", json!({})).await?["interface_version"], "1.5");

    w.coin.as_account().deploy(&wasm("target/near/coin-fake/coin.wasm")).await?.into_result()?;
    assert_eq!(w.view(&w.coin, "get_constants", json!({})).await?["interface_version"], "1.7"); // v2: 1.6 and 1.7 together
    assert_eq!(w.pot().await?, pot_before, "the pool is exactly as it was");
    assert_eq!(u(&w.view(&w.coin, "get_rewards", json!({})).await?["jackpot"]), u(&rewards_before["jackpot"]));
    assert_eq!(w.view(&w.coin, "get_feed", json!({"limit": 100})).await?, feed_before, "the feed reads as before");
    w.books_match(0).await?;

    // New guesses join a league; the next week's tick writes the reviews (backfilled for the weeks before 1.6).
    let wk = w.view(&w.coin, "get_week", json!({})).await?;
    let week = wk["week"].as_u64().unwrap();
    let r = w.round().await?;
    if w.genesis_ms + (r["id"].as_u64().unwrap() - 1) * c[0] + c[1] > worker_now(&w).await? {
        call(&alice, &w.coin, "guess", json!({"verdict": "SKIP"}), NO).await?;
        assert_eq!(w.view(&w.coin, "get_league", json!({})).await?["players"], 1);
    }
    let next_week_round = (week + 1) * 7 + 1;
    for r in w.round_id().await? + 1..=next_week_round {
        w.reach_round(r).await?;
        call(&alice, &w.coin, "rewards_tick", json!({}), NO).await?;
    }
    let reviews = w.view(&w.coin, "get_reviews", json!({})).await?;
    let weeks: Vec<u64> = reviews.as_array().unwrap().iter().map(|r| r["week"].as_u64().unwrap()).collect();
    assert_eq!(weeks.first().copied(), Some(week), "{reviews}");
    w.books_match(0).await?;
    Ok(())
}

async fn worker_now(w: &World) -> anyhow::Result<u64> {
    Ok(w.worker.view_block().await?.timestamp() / 1_000_000)
}
