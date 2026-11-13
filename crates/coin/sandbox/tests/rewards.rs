//! The reward ladder (interface 1.4) on a local NEAR node, with the real sticker and lender contracts and test
//! dollars really moving: guesses judged by the round's ruling, half of a tip and a direct seed in the jackpot,
//! seven right in a row winning it, interest from the lender held for the payday draw and drawn, prizes claimed
//! in USDC, a golden sticker minted and moved. The USDC the coin holds matches its books after every money move.
//! Then a 1.3 contract (the code coin-fast runs today, downloaded from testnet) upgraded in place to 1.4.
//! Run with `./run.sh`.

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
const ONE: NearToken = NearToken::from_yoctonear(1);
const CLAIM: NearToken = NearToken::from_millinear(20);

struct Rw {
    w: World,
    stickers: Contract,
    lender: Contract,
}

async fn rewards_world() -> anyhow::Result<Rw> {
    let worker = near_workspaces::sandbox().await?;
    let usdc = token(&worker).await?;
    let coin = worker.dev_deploy(&wasm("target/near/coin-test/coin.wasm")).await?;
    let stickers = worker.dev_deploy(&wasm("target/near/stickers/stickers.wasm")).await?;
    stickers.call("new").args_json(json!({"minter": coin.id()})).transact().await?.into_result()?;
    let lender = worker.dev_deploy(&wasm("target/near/lender/lender.wasm")).await?;
    lender.call("new").args_json(json!({"usdc": usdc.id(), "rate_bps": 500})).transact().await?.into_result()?;
    let genesis_ms = worker.view_block().await?.timestamp() / 1_000_000;
    let runner = worker.dev_create_account().await?;
    let c = REAL;
    coin.call("new")
        .args_json(json!({"config": {
            "usdc_token": usdc.id(), "runner": runner.id(),
            "round": {"genesis_ms": genesis_ms, "round_ms": c[0], "guess_close_ms": c[1], "propose_from_ms": c[2],
                      "propose_until_ms": c[3], "close_from_ms": c[4], "tail_fade_ms": c[5]},
            "min_first_deposit": MIN_FIRST.to_string(),
            "stickers": stickers.id(), "lender": lender.id(),
        }}))
        .transact()
        .await?
        .into_result()?;
    for who in [coin.id(), lender.id()] {
        usdc.call("storage_deposit")
            .args_json(json!({"account_id": who}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Rw { w: World { worker, usdc, coin, runner, genesis_ms }, stickers, lender })
}

async fn skip(w: &World) -> anyhow::Result<()> {
    let v = w.propose_text(&w.line_for(&json!({"action": "SKIP"})).await?).await?;
    assert_eq!(v["verdict"], "SKIP");
    Ok(())
}

#[tokio::test]
async fn the_reward_ladder_with_the_real_contracts() -> anyhow::Result<()> {
    let rw = rewards_world().await?;
    let w = &rw.w;
    let [round_ms, _, propose_from, ..] = REAL;
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * round_ms + into;
    // Registration now pays for the reward records too: 1,280 bytes.
    let bounds = w.view(&w.coin, "storage_balance_bounds", json!({})).await?;
    assert_eq!(u(&bounds["min"]), 12_800_000_000_000_000_000_000);
    let alice = boss(w, 3_000_000_000).await?;
    let bob = boss(w, 1_000_000_000).await?;
    let team = boss(w, 200_000_000).await?;
    w.pay_in(&alice, &w.usdc, 2_000_000_000, BRAVE).await?.into_result()?;
    w.set_now(at(2, 1_000)).await?;

    // ----- the jackpot fills: half of a $20 tip, and the team's $100 seed
    w.pay_in(&bob, &w.usdc, 20_000_000, r#"{"tip":{}}"#).await?.into_result()?;
    w.pay_in(&team, &w.usdc, 100_000_000, r#"{"jackpot":{}}"#).await?.into_result()?;
    let r = w.view(&w.coin, "get_rewards", json!({})).await?;
    assert_eq!(u(&r["jackpot"]), 110_000_000);
    w.books_match(0).await?;

    // ----- the payday draw: alice joins; the pool lends; the lender's interest is held for the draw
    call(&alice, &w.coin, "enter_draw", json!({}), NO).await?;
    call(&bob, &w.coin, "rebalance", json!({}), NO).await?;
    w.worker.fast_forward(200).await?;
    let got: Value = call(&bob, &w.coin, "collect_interest", json!({}), NO).await?;
    let interest = u(&got);
    assert!(interest > 0, "the stand-in lender pays a fixed test rate");
    let r = w.view(&w.coin, "get_rewards", json!({})).await?;
    assert_eq!(u(&r["draw_pot"]), interest, "interest is held for the draw, not added to the pool");
    w.books_match(0).await?;

    // ----- seven rounds: alice guesses SKIP before the window, the Intern skips; bob guesses YES (wrong)
    for round in 3..=9 {
        w.set_now(at(round, 2_000)).await?;
        call(&alice, &w.coin, "guess", json!({"verdict": "SKIP"}), NO).await?;
        call(&bob, &w.coin, "guess", json!({"verdict": "YES"}), NO).await?;
        w.set_now(at(round, propose_from + 60_000)).await?;
        skip(w).await?;
    }
    // A stranger cannot guess (nothing would pay for the record); a guess after the close is refused.
    let stranger = w.worker.dev_create_account().await?;
    assert!(call(&stranger, &w.coin, "guess", json!({"verdict": "YES"}), NO).await.is_err());
    assert!(call(&alice, &w.coin, "guess", json!({"verdict": "YES"}), NO).await.is_err());

    // ----- round 10: the tick settles the jackpot (round 9) and holds the draw (rounds 1..=7)
    w.set_now(at(10, 1_000)).await?;
    call(&bob, &w.coin, "rewards_tick", json!({}), NO).await?;
    let a = w.view(&w.coin, "get_player", json!({"account_id": alice.id()})).await?;
    assert_eq!((a["points"].as_u64(), a["best"].as_u64(), a["streak"].as_u64()), (Some(7), Some(7), Some(0)));
    assert_eq!(u(&a["prize_owed"]), 110_000_000 + interest, "the jackpot and the whole draw (alone in it)");
    let b = w.view(&w.coin, "get_player", json!({"account_id": bob.id()})).await?;
    assert_eq!((b["points"].as_u64(), b["wrong"].as_u64()), (Some(0), Some(7)));
    let r = w.view(&w.coin, "get_rewards", json!({})).await?;
    assert_eq!((u(&r["jackpot"]), u(&r["draw_pot"])), (0, 0));
    assert_eq!(r["jackpot_last_won_round"], 9);
    let draws = w.view(&w.coin, "get_draw_results", json!({})).await?;
    assert_eq!(draws[0]["winner"], json!(alice.id()));
    w.books_match(0).await?;

    // ----- alice claims her prizes in USDC
    let before = w.usdc_of(alice.id()).await?;
    call(&alice, &w.coin, "claim_prizes", json!({}), ONE).await?;
    assert_eq!(w.usdc_of(alice.id()).await? - before, 110_000_000 + interest);
    assert_eq!(u(&w.view(&w.coin, "get_rewards", json!({})).await?["prizes_owed"]), 0);
    w.books_match(0).await?;

    // ----- golden stickers (odds turned up for the test): one drops, is minted, and can be given away
    w.coin.call("test_set_golden_odds").args_json(json!({"odds": 1})).transact().await?.into_result()?;
    w.set_now(at(11, 2_000)).await?;
    let p = call(&bob, &w.coin, "guess", json!({"verdict": "SKIP"}), NO).await?;
    let g = p["goldens"][0].clone();
    let token = format!("golden:{}:{}", g["code"].as_str().unwrap(), g["serial"]);
    call(&bob, &w.coin, "claim_golden", json!({"code": g["code"], "serial": g["serial"]}), CLAIM).await?;
    let owned = w.view(&rw.stickers, "nft_tokens_for_owner", json!({"account_id": bob.id()})).await?;
    assert!(owned.as_array().unwrap().iter().any(|t| t["token_id"] == json!(token)), "{owned}");
    call(&bob, &rw.stickers, "nft_transfer", json!({"receiver_id": alice.id(), "token_id": token}), ONE).await?;
    let owned = w.view(&rw.stickers, "nft_tokens_for_owner", json!({"account_id": alice.id()})).await?;
    assert!(owned.as_array().unwrap().iter().any(|t| t["token_id"] == json!(token)), "golden stickers are transferable");
    assert!(w.usdc_of(rw.lender.id()).await? > 0);
    println!("reward ladder: jackpot $110 + draw {interest} paid to alice; golden {token} minted and given");
    Ok(())
}

#[tokio::test]
async fn a_1_3_contract_upgrades_to_1_4_keeping_everything() -> anyhow::Result<()> {
    // The exact code coin-fast runs on testnet (downloaded; its sha256 is coin-fast's code_hash 9pJfHu…).
    let old = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/coin-fast-1.3.wasm"))?;
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
    w.pay_in(&alice, &w.usdc, 100_000_000, r#"{"pool":"SAFE"}"#).await?.into_result()?;
    w.reach_round(2).await?;
    call(&alice, &w.coin, "lock", json!({"amount": "100000000"}), NO).await?; // opens round 2: coins written
    let pot = w.pot().await?;
    let mut acct = w.account(&alice).await?;
    acct.as_object_mut().unwrap().remove("vote_weight"); // grows each round; 1-minute rounds may tick over
    let feed_before = w.view(&w.coin, "get_feed", json!({"limit": 100})).await?.as_array().unwrap().len();
    assert!(w.view(&w.coin, "get_rewards", json!({})).await.is_err(), "1.3 has no rewards");

    // Upgrade in place: the new code, then migrate_rewards (only the contract itself may call it).
    w.coin.as_account().deploy(&wasm("target/near/coin-fake/coin.wasm")).await?.into_result()?;
    assert!(call(&alice, &w.coin, "migrate_rewards", json!({}), NO).await.is_err());
    w.coin.call("migrate_rewards").args_json(json!({})).transact().await?.into_result()?;

    assert_eq!(w.pot().await?, pot, "the pool is exactly as it was");
    let mut after = w.account(&alice).await?;
    after.as_object_mut().unwrap().remove("vote_weight");
    assert_eq!(after, acct, "alice is exactly as she was");
    let feed_after = w.view(&w.coin, "get_feed", json!({"limit": 100})).await?.as_array().unwrap().len();
    assert!(feed_after >= feed_before, "the feed is kept");
    let r = w.view(&w.coin, "get_rewards", json!({})).await?;
    assert_eq!((u(&r["jackpot"]), u(&r["draw_pot"]), u(&r["prizes_owed"])), (0, 0, 0));
    w.books_match(0).await?;
    // The new parts work at once: a tip goes half to the jackpot; alice can join the draw.
    w.pay_in(&alice, &w.usdc, 10_000_000, r#"{"tip":{}}"#).await?.into_result()?;
    assert_eq!(u(&w.view(&w.coin, "get_rewards", json!({})).await?["jackpot"]), 5_000_000);
    call(&alice, &w.coin, "enter_draw", json!({}), NO).await?;
    w.books_match(0).await?;
    // And the old parts still work: cash out SAFE.
    w.cash_out_pool(&alice, "SAFE", 50_000_000).await?.into_result()?;
    w.books_match(0).await?;
    Ok(())
}
