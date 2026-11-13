//! The long shot (reward ladder R6, interface 1.5) on a local NEAR node: a LONG_SHOT vote passes, two rounds later
//! the rulebook states one ticket, the ticket is approved at 10x as one extra bet, and a second one is refused. Then a
//! 1.4 contract (the code coin-fast runs today, downloaded from testnet) upgraded in place to 1.5, the reward ladder's
//! money and the vote slots kept. Run with `./run.sh`.

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

fn ticket(margin: u128, leverage: u32) -> Value {
    json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": margin.to_string(), "leverage": leverage})
}

#[tokio::test]
async fn a_long_shot_vote_allows_one_ticket_at_10x_on_the_deployed_contract() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let [round_ms, _, propose_from, ..] = REAL;
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * round_ms + into;
    let alice = boss(&w, 2_000_000_000).await?;
    w.pay_in(&alice, &w.usdc, 1_000_000_000, BRAVE).await?.into_result()?;
    w.set_now(at(2, 1_000)).await?;
    call(&alice, &w.coin, "lock", json!({"amount": "500000000"}), NO).await?;
    w.set_now(at(3, 1_000)).await?;
    w.set_now(at(4, 1_000)).await?;
    let id = call(&alice, &w.coin, "open_vote", json!({"kind": "LONG_SHOT"}), NO).await?;
    call(&alice, &w.coin, "cast", json!({"vote_id": id, "support": true}), NO).await?;
    w.set_now(at(5, 3_000)).await?;
    let v = call(&alice, &w.coin, "finish_vote", json!({"vote_id": id}), NO).await?;
    assert_eq!((v["state"].as_str(), v["effective_round"].as_u64()), (Some("PASSED"), Some(7)));

    // Round 6: no ticket; 10x is refused as always.
    w.set_now(at(6, propose_from + 60_000)).await?;
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    assert!(!rb["text"].as_str().unwrap().contains("long_shot:"));
    let v = w.propose_text(&w.line_for(&ticket(4_999_995, 10)).await?).await?;
    assert_eq!(v["code"], "OVER_LEVERAGE");

    // Round 7: the rulebook states the ticket; it is approved at 10x and uses none of the rank's bets.
    w.set_now(at(7, propose_from + 60_000)).await?;
    let lsv = w.view(&w.coin, "get_rewards", json!({})).await?["long_shot"].clone();
    let margin = u(&lsv["margin"]);
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    let line = format!("long_shot: one ticket this round: margin_e6 exactly {margin}, leverage up to 10");
    assert!(rb["text"].as_str().unwrap().contains(&line), "{rb}");
    let v = w.propose_text(&w.line_for(&ticket(margin, 10)).await?).await?;
    assert_eq!(v["verdict"], "YES", "{v}");
    let pos = w.view(&w.coin, "get_positions", json!({"round_id": 7})).await?;
    assert_eq!(pos[0]["leverage"], 10);
    assert_eq!(w.round().await?["bets_used"], 0);
    // A second ticket is refused; the rank's own bet is still there.
    let v = w.propose_text(&w.line_for(&ticket(margin, 10)).await?).await?;
    assert_eq!(v["code"], "OVER_LEVERAGE");
    let v = w
        .propose_text(&w.line_for(&json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": "11000000", "leverage": 1})).await?)
        .await?;
    assert_eq!(v["verdict"], "YES");
    let r = w.view(&w.coin, "get_rewards", json!({})).await?;
    assert_eq!((r["long_shot"]["used"].as_bool(), r["long_shot"]["vote_from_round"].as_u64()), (Some(true), Some(14)));
    // A new long-shot vote waits until round 14.
    assert!(call(&alice, &w.coin, "open_vote", json!({"kind": "LONG_SHOT"}), NO).await.is_err());
    println!("long shot: ticket {margin} at 10x approved in round 7; a second refused; next vote from round 14");
    Ok(())
}

#[tokio::test]
async fn a_1_4_contract_upgrades_to_1_5_keeping_the_rewards() -> anyhow::Result<()> {
    // The exact code coin-fast runs on testnet (downloaded; its sha256 is coin-fast's code_hash 4GgRc4…).
    let old = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/coin-fast-1.4.wasm"))?;
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
    w.reach_round(2).await?;
    call(&alice, &w.coin, "lock", json!({"amount": "100000000"}), NO).await?;
    w.pay_in(&alice, &w.usdc, 20_000_000, r#"{"tip":{}}"#).await?.into_result()?;
    call(&alice, &w.coin, "enter_draw", json!({}), NO).await?;
    let pot = w.pot().await?;
    let rewards = w.view(&w.coin, "get_rewards", json!({})).await?;
    assert_eq!(u(&rewards["jackpot"]), 10_000_000);
    assert!(rewards.get("long_shot").is_none(), "1.4 has no long shot");

    w.coin.as_account().deploy(&wasm("target/near/coin-fake/coin.wasm")).await?.into_result()?;
    assert!(call(&alice, &w.coin, "migrate_long_shot", json!({}), NO).await.is_err());
    w.coin.call("migrate_long_shot").args_json(json!({})).transact().await?.into_result()?;

    assert_eq!(w.pot().await?, pot, "the pool is exactly as it was");
    let r = w.view(&w.coin, "get_rewards", json!({})).await?;
    assert_eq!((u(&r["jackpot"]), r["entrants"].as_u64()), (10_000_000, Some(1)), "the reward ladder is kept");
    assert_eq!(r["long_shot"]["ticket_round"], Value::Null);
    w.books_match(0).await?;
    // The new vote kind opens on the upgraded state (its slot is added on first use). Rounds open lazily: tick round 3
    // open before waiting for round 4.
    w.reach_round(3).await?;
    call(&alice, &w.coin, "rewards_tick", json!({}), NO).await?;
    w.reach_round(4).await?;
    let id = call(&alice, &w.coin, "open_vote", json!({"kind": "LONG_SHOT"}), NO).await?;
    assert!(id.as_u64().is_some());
    let votes = w.view(&w.coin, "get_votes", json!({})).await?;
    assert_eq!(votes[0]["kind"], "LONG_SHOT");
    Ok(())
}
