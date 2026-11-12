//! Step 10: gas measured on a local NEAR node for every call a person or the runner makes. Prints one
//! `MEASURE|<call>|<TGas burnt by the whole transaction, all receipts>|<note>` line per call; the local
//! table in docs/measurements.md was copied from them. Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

fn tgas(r: &ExecutionFinalResult) -> f64 {
    r.outcomes()
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .sum::<u64>() as f64
        / 1e12
}

async fn m(
    name: &str,
    note: &str,
    who: &Account,
    to: &Contract,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<Value> {
    let r = who
        .call(to.id(), method)
        .args_json(args)
        .deposit(deposit)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    println!("MEASURE|{name}|{:.2}|{note}", tgas(&r));
    let logs: Vec<String> = r.logs().iter().map(|s| s.to_string()).collect();
    let r = r
        .into_result()
        .map_err(|e| anyhow::anyhow!("{name}: {e:?} {logs:?}"))?;
    Ok(r.json::<Value>().unwrap_or(Value::Null))
}

const NO: NearToken = NearToken::from_yoctonear(0);
const ONE: NearToken = NearToken::from_yoctonear(1);

#[tokio::test]
async fn gas_of_every_call() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let usdc = token(&worker).await?;
    let coin = worker
        .dev_deploy(&wasm("target/near/coin-test/coin.wasm"))
        .await?;
    let stickers = worker
        .dev_deploy(&wasm("target/near/stickers/stickers.wasm"))
        .await?;
    stickers
        .call("new")
        .args_json(json!({"minter": coin.id()}))
        .transact()
        .await?
        .into_result()?;
    let launchpad = worker
        .dev_deploy(&wasm("target/near/launchpad/launchpad.wasm"))
        .await?;
    launchpad
        .call("new")
        .args_json(json!({"usdc": usdc.id(), "coin": coin.id()}))
        .transact()
        .await?
        .into_result()?;
    let lender = worker
        .dev_deploy(&wasm("target/near/lender/lender.wasm"))
        .await?;
    lender
        .call("new")
        .args_json(json!({"usdc": usdc.id(), "rate_bps": 500}))
        .transact()
        .await?
        .into_result()?;
    let genesis_ms = worker.view_block().await?.timestamp() / 1_000_000;
    let runner = worker.dev_create_account().await?;
    let c = REAL;
    coin.call("new")
        .args_json(json!({"config": {"usdc_token": usdc.id(), "runner": runner.id(),
            "round": {"genesis_ms": genesis_ms, "round_ms": c[0], "guess_close_ms": c[1], "propose_from_ms": c[2], "propose_until_ms": c[3], "close_from_ms": c[4], "tail_fade_ms": c[5]},
            "min_first_deposit": MIN_FIRST.to_string(), "stickers": stickers.id(), "launchpad": launchpad.id(), "lender": lender.id()}}))
        .transact()
        .await?
        .into_result()?;
    for who in [coin.id(), launchpad.id(), lender.id()] {
        usdc.call("storage_deposit")
            .args_json(json!({"account_id": who}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    let w = World {
        worker,
        usdc,
        coin,
        runner,
        genesis_ms,
    };
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * c[0] + into;
    let a = boss(&w, 3_000_000_000).await?;
    let b = boss(&w, 1_000_000_000).await?;
    let newcomer = w.worker.dev_create_account().await?;
    newcomer
        .call(w.usdc.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    let min: Value = w.view(&w.coin, "storage_balance_bounds", json!({})).await?;

    m(
        "storage_deposit (register a boss)",
        "0.0064 NEAR attached",
        &newcomer,
        &w.coin,
        "storage_deposit",
        json!({}),
        NearToken::from_yoctonear(u(&min["min"])),
    )
    .await?;
    let pay =
        |msg: &'static str| json!({"receiver_id": w.coin.id(), "amount": "1000000000", "msg": msg});
    m(
        "pay in BRAVE (ft_transfer_call on USDC)",
        "waits as pending",
        &a,
        &w.usdc,
        "ft_transfer_call",
        pay(BRAVE),
        ONE,
    )
    .await?;
    m(
        "pay in SAFE (ft_transfer_call on USDC)",
        "credited at once",
        &a,
        &w.usdc,
        "ft_transfer_call",
        pay(r#"{"pool":"SAFE"}"#),
        ONE,
    )
    .await?;
    m(
        "pay in BRAVE, second boss",
        "",
        &b,
        &w.usdc,
        "ft_transfer_call",
        json!({"receiver_id": w.coin.id(), "amount": "500000000", "msg": BRAVE}),
        ONE,
    )
    .await?;
    w.set_now(at(2, 1_000)).await?;
    m(
        "lock (first call of a round: opens it, converts pending money)",
        "",
        &a,
        &w.coin,
        "lock",
        json!({"amount": "400000000"}),
        NO,
    )
    .await?;
    m(
        "lock",
        "",
        &b,
        &w.coin,
        "lock",
        json!({"amount": "400000000"}),
        NO,
    )
    .await?;
    m(
        "cash_out BRAVE, paid from idle money",
        "60 TGas minimum",
        &b,
        &w.coin,
        "cash_out",
        json!({"pool": "BRAVE", "amount": "10000000"}),
        ONE,
    )
    .await?;
    m(
        "cash_out SAFE",
        "",
        &a,
        &w.coin,
        "cash_out",
        json!({"pool": "SAFE", "amount": "10000000"}),
        ONE,
    )
    .await?;
    m(
        "turn_dial to SAFE",
        "",
        &a,
        &w.coin,
        "turn_dial",
        json!({"to": "SAFE", "amount": "10000000"}),
        ONE,
    )
    .await?;
    m(
        "turn_dial to BRAVE",
        "",
        &a,
        &w.coin,
        "turn_dial",
        json!({"to": "BRAVE", "amount": "10000000"}),
        ONE,
    )
    .await?;
    m(
        "rebalance (lend)",
        "STAND-IN lender",
        &b,
        &w.coin,
        "rebalance",
        json!({}),
        NO,
    )
    .await?;
    m(
        "tip (ft_transfer_call on USDC)",
        "fills the tip jar",
        &b,
        &w.usdc,
        "ft_transfer_call",
        json!({"receiver_id": w.coin.id(), "amount": "100000000", "msg": r#"{"tip":{}}"#}),
        ONE,
    )
    .await?;
    m(
        "claim_goal_sticker",
        "0.02 NEAR attached; mints on the sticker contract",
        &b,
        &w.coin,
        "claim_goal_sticker",
        json!({"fill_id": 1}),
        NearToken::from_millinear(20),
    )
    .await?;
    m(
        "claim_badge",
        "0.02 NEAR attached",
        &a,
        &w.coin,
        "claim_badge",
        json!({}),
        NearToken::from_millinear(20),
    )
    .await?;
    m("submit_playbook (300 bytes)", "storage deposit attached", &a, &w.coin, "submit_playbook",
        json!({"text": "p".repeat(300), "authors": [{"account_id": a.id(), "share_bps": 6000}, {"account_id": b.id(), "share_bps": 4000}]}), NearToken::from_millinear(50)).await?;
    m(
        "cash_out BRAVE, money brought back from the lender first",
        "150 TGas minimum",
        &a,
        &w.coin,
        "cash_out",
        json!({"pool": "BRAVE", "amount": "300000000"}),
        ONE,
    )
    .await?;
    w.worker.fast_forward(50).await?;
    m(
        "collect_interest",
        "",
        &b,
        &w.coin,
        "collect_interest",
        json!({}),
        NO,
    )
    .await?;
    // votes
    w.set_now(at(3, 1_000)).await?;
    w.set_now(at(4, 1_000)).await?;
    let vid = m(
        "open_vote (SET_PLAYBOOK)",
        "",
        &a,
        &w.coin,
        "open_vote",
        json!({"kind": "SET_PLAYBOOK", "playbook_id": 1}),
        NO,
    )
    .await?;
    m(
        "cast",
        "",
        &a,
        &w.coin,
        "cast",
        json!({"vote_id": vid, "support": true}),
        NO,
    )
    .await?;
    m(
        "cast",
        "",
        &b,
        &w.coin,
        "cast",
        json!({"vote_id": vid, "support": true}),
        NO,
    )
    .await?;
    w.set_now(at(5, 2_000)).await?;
    m(
        "finish_vote (passed)",
        "",
        &b,
        &w.coin,
        "finish_vote",
        json!({"vote_id": vid}),
        NO,
    )
    .await?;
    m(
        "unlock",
        "",
        &b,
        &w.coin,
        "unlock",
        json!({"amount": "1000000"}),
        NO,
    )
    .await?;
    // a round with a bet and a coach cut
    w.set_now(at(6, 1_000)).await?;
    w.set_now(at(7, c[2] + 60_000)).await?;
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    let req = b64(rb["text"].as_str().unwrap().as_bytes());
    let bet = json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": "11000000", "leverage": 1});
    let yes = m("propose: YES (stand-in AI check)", "the real check adds about 1 TGas (sign.rs)", &w.runner, &w.coin, "propose",
        json!({"request": req, "response": b64(w.line_for(&bet).await?.as_bytes()), "signature": b64(b"FAKE")}), NO).await?;
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    m("propose: NOPE (stand-in AI check)", "recorded and logged", &w.runner, &w.coin, "propose",
        json!({"request": b64(rb["text"].as_str().unwrap().as_bytes()), "response": b64(w.line_for(&bet).await?.as_bytes()), "signature": b64(b"FAKE")}), NO).await?;
    w.set_now(at(7, c[4] + 60_000)).await?;
    m(
        "report_result",
        "",
        &w.runner,
        &w.coin,
        "report_result",
        json!({"position_id": yes["position_id"], "returned": "15000000"}),
        NO,
    )
    .await?;
    m(
        "settle (a win: test dollars minted, coach cut to two authors)",
        "135 TGas minimum with a coach cut",
        &b,
        &w.coin,
        "settle",
        json!({"round_id": 7}),
        NO,
    )
    .await?;
    // the launchpad
    for who in [&a, &b] {
        m(
            "launchpad storage_deposit",
            "0.05 NEAR attached",
            who,
            &launchpad,
            "storage_deposit",
            json!({}),
            NearToken::from_millinear(50),
        )
        .await?;
    }
    let tid = m(
        "launchpad launch",
        "",
        &a,
        &launchpad,
        "launch",
        json!({"name": "Stamp Coin", "symbol": "STAMP"}),
        NO,
    )
    .await?;
    m("launchpad buy (ft_transfer_call on USDC)", "fee sent to the coin as income", &b, &w.usdc, "ft_transfer_call",
        json!({"receiver_id": launchpad.id(), "amount": "20000000", "msg": json!({"buy": {"token_id": tid, "min_out": "0"}}).to_string()}), ONE).await?;
    let bal = u(&w
        .view(
            &launchpad,
            "get_balance",
            json!({"token_id": tid, "account_id": b.id()}),
        )
        .await?);
    m(
        "launchpad sell",
        "",
        &b,
        &launchpad,
        "sell",
        json!({"token_id": tid, "amount": (bal / 2).to_string(), "min_out": "0"}),
        ONE,
    )
    .await?;
    w.books_match(0).await?;
    Ok(())
}
