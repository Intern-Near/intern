//! Steps 8 and 9 on a local NEAR node, with the real stickers, launchpad and lender contracts and test
//! dollars really moving: lending and a cash-out that brings money back, interest; tips filling the jar
//! and a goal sticker minted; a boss badge that cannot move; a credited refusal and its original; a
//! launch, a buy and a sale with the fee arriving as outside income; a playbook voted in and its
//! authors paid the coach cut. The USDC the coin holds matches its books after every money move.
//! Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

struct Later {
    w: World,
    stickers: Contract,
    launchpad: Contract,
    lender: Contract,
}

async fn later_world() -> anyhow::Result<Later> {
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
        .args_json(json!({"config": {
            "usdc_token": usdc.id(), "runner": runner.id(),
            "round": {"genesis_ms": genesis_ms, "round_ms": c[0], "guess_close_ms": c[1], "propose_from_ms": c[2],
                      "propose_until_ms": c[3], "close_from_ms": c[4], "tail_fade_ms": c[5]},
            "min_first_deposit": MIN_FIRST.to_string(),
            "stickers": stickers.id(), "launchpad": launchpad.id(), "lender": lender.id(),
        }}))
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
    Ok(Later {
        w: World {
            worker,
            usdc,
            coin,
            runner,
            genesis_ms,
        },
        stickers,
        launchpad,
        lender,
    })
}

async fn call(
    who: &Account,
    to: &Contract,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<Value> {
    let out = who
        .call(to.id(), method)
        .args_json(args)
        .deposit(deposit)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let logs: Vec<String> = out.logs().iter().map(|s| s.to_string()).collect();
    let r = out
        .into_result()
        .map_err(|e| anyhow::anyhow!("{method}: {e:?} {logs:?}"))?;
    Ok(r.json::<Value>().unwrap_or(Value::Null))
}

const NO: NearToken = NearToken::from_yoctonear(0);
const ONE: NearToken = NearToken::from_yoctonear(1);
const CLAIM: NearToken = NearToken::from_millinear(20);

#[tokio::test]
async fn steps_8_and_9_with_the_real_contracts() -> anyhow::Result<()> {
    let l = later_world().await?;
    let w = &l.w;
    let [round_ms, _, propose_from, _, close_from, _] = REAL;
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * round_ms + into;
    let alice = boss(w, 3_000_000_000).await?;
    let bob = boss(w, 1_000_000_000).await?;
    let coach = boss(w, 1_000_000).await?; // registered on USDC: can receive the coach cut
    w.pay_in(&alice, &w.usdc, 2_000_000_000, BRAVE)
        .await?
        .into_result()?;
    w.set_now(at(2, 1_000)).await?;
    w.books_match(0).await?;

    // ----- step 8: lend what is idle beyond the INTERN's 2% slice
    let lent: Value = call(&bob, &w.coin, "rebalance", json!({}), NO).await?;
    assert_eq!(lent, json!("1960000000"), "$2,000 minus the $40 slice");
    let p = w.pot().await?["brave"].clone();
    assert_eq!((u(&p["lent"]), u(&p["idle"])), (1_960_000_000, 40_000_000));
    assert_eq!(
        w.usdc_of(l.lender.id()).await?,
        1_960_000_000,
        "the lender holds it"
    );
    w.books_match(0).await?;
    println!("lent $1,960 to the STAND-IN lender; $40 (the INTERN's slice) stays idle");

    // ----- step 9: tips fill the jar; the tipper's goal sticker is minted
    call(
        &bob,
        &w.usdc,
        "ft_transfer_call",
        json!({"receiver_id": w.coin.id(), "amount": "100000000", "msg": r#"{"tip":{}}"#}),
        ONE,
    )
    .await?;
    let fills: Value = w.view(&w.coin, "get_goal_fills", json!({})).await?;
    let jar = fills
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["goal"] == "TIP_JAR")
        .expect("the jar filled")
        .clone();
    let claimable: Value = w
        .view(&w.coin, "get_claimable", json!({"account_id": bob.id()}))
        .await?;
    assert!(claimable["goal_fills"]
        .as_array()
        .unwrap()
        .contains(&jar["id"]));
    let out = bob
        .call(w.coin.id(), "claim_goal_sticker")
        .args_json(json!({"fill_id": jar["id"]}))
        .deposit(CLAIM)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    for o in out.outcomes() {
        println!(
            "  {} burnt {} TGas, logs {:?}, status {:?}",
            o.executor_id,
            o.gas_burnt.as_tgas(),
            o.logs,
            o.clone().into_result()
        );
    }
    out.into_result()?;
    let token_id = format!("goal:{}:{}", jar["id"], bob.id());
    let t: Value = w
        .view(&l.stickers, "nft_token", json!({"token_id": token_id}))
        .await?;
    assert_eq!(t["owner_id"], bob.id().to_string());
    // 1.4: half of the tip goes to the streak jackpot; the other half counts for the pool from the next round.
    assert_eq!(
        u(&w.pot().await?["brave"]["income_waiting"]),
        50_000_000,
        "half the tip counts from the next round"
    );
    assert_eq!(u(&w.view(&w.coin, "get_rewards", json!({})).await?["jackpot"]), 50_000_000);
    w.books_match(0).await?;
    println!("a $100 tip filled tip jar 1; {token_id} minted to the tipper");

    // ----- the boss badge: minted once, cannot move
    call(&alice, &w.coin, "claim_badge", json!({}), CLAIM).await?;
    let badge = format!("badge:{}", alice.id());
    let t: Value = w
        .view(&l.stickers, "nft_token", json!({"token_id": badge}))
        .await?;
    assert_eq!(t["owner_id"], alice.id().to_string());
    let moved = alice
        .call(l.stickers.id(), "nft_transfer")
        .args_json(json!({"receiver_id": bob.id(), "token_id": badge}))
        .deposit(ONE)
        .transact()
        .await?;
    assert!(moved.is_failure(), "a badge cannot be transferred");
    println!("{badge} minted; transferring it is refused");

    // ----- a credited refusal and its original
    let visitor = w.worker.dev_create_account().await?;
    w.set_now(at(2, propose_from + 60_000)).await?;
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    let line = w.line_for(&json!({"action": "BET", "market": "WIF", "side": "LONG", "margin": "15000000", "leverage": 1})).await?;
    let v = call(&w.runner, &w.coin, "propose",
        json!({"request": b64(rb["text"].as_str().unwrap().as_bytes()), "response": b64(line.as_bytes()), "signature": b64(b"FAKE"), "credited_to": visitor.id()}), NO).await?;
    assert_eq!(v["code"], "NOT_ON_LIST");
    call(
        &visitor,
        &w.coin,
        "claim_sticker",
        json!({"code": "NOT_ON_LIST"}),
        CLAIM,
    )
    .await?;
    let t: Value = w
        .view(
            &l.stickers,
            "nft_token",
            json!({"token_id": "original:NOT_ON_LIST"}),
        )
        .await?;
    assert_eq!(t["owner_id"], visitor.id().to_string());
    println!("a refusal credited to the visitor; original:NOT_ON_LIST minted to them");

    // ----- the launchpad: launch, buy, sell; the fees arrive as outside income
    for who in [&alice, &bob] {
        call(
            who,
            &l.launchpad,
            "storage_deposit",
            json!({}),
            NearToken::from_millinear(50),
        )
        .await?;
    }
    let id = call(
        &alice,
        &l.launchpad,
        "launch",
        json!({"name": "Stamp Coin", "symbol": "STAMP"}),
        NO,
    )
    .await?;
    let waiting0 = u(&w.pot().await?["brave"]["income_waiting"]);
    call(&bob, &w.usdc, "ft_transfer_call",
        json!({"receiver_id": l.launchpad.id(), "amount": "50000000", "msg": json!({"buy": {"token_id": id, "min_out": "0"}}).to_string()}), ONE).await?;
    let got = u(&w
        .view(
            &l.launchpad,
            "get_balance",
            json!({"token_id": id, "account_id": bob.id()}),
        )
        .await?);
    assert!(got > 0);
    call(
        &bob,
        &l.launchpad,
        "sell",
        json!({"token_id": id, "amount": (got / 2).to_string(), "min_out": "0"}),
        ONE,
    )
    .await?;
    let fees = u(&w.pot().await?["brave"]["income_waiting"]) - waiting0;
    assert!(
        fees >= 500_000 && fees < 800_000,
        "1% of $50 in, and of about $25 out: {fees}"
    );
    w.books_match(0).await?;
    println!("launched STAMP; a $50 buy and a sale sent {fees} (about $0.75) of fees to the pool");

    // ----- a cash-out bigger than what is idle brings money back from the lender first
    let before = w.usdc_of(alice.id()).await?;
    let out = alice
        .call(w.coin.id(), "cash_out")
        .args_json(json!({"pool": "BRAVE", "amount": "500000000"}))
        .deposit(ONE)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(out.is_success(), "{:?}", out.logs());
    assert!(w.usdc_of(alice.id()).await? - before > 400_000_000, "paid");
    let p = w.pot().await?["brave"].clone();
    assert_eq!(
        u(&p["lent"]) + u(&p["idle"]) + u(&p["in_play"]),
        u(&p["total"])
    );
    w.books_match(0).await?;
    println!("a $500 cash-out with $40 idle: the rest came back from the lender first");

    // ----- interest
    w.worker.fast_forward(200).await?;
    let got: Value = call(&bob, &w.coin, "collect_interest", json!({}), NO).await?;
    assert!(u(&got) > 0, "some interest after 200 blocks: {got}");
    assert_eq!(u(&w.pot().await?["brave"]["interest"]), u(&got));
    w.books_match(0).await?;
    println!("collected {} of STAND-IN interest", u(&got));

    // ----- a playbook voted in, then a winning round pays its authors 10%
    for who in [&alice, &bob] {
        let coins = u(&w.account(who).await?["coin"]);
        if coins > 0 {
            call(
                who,
                &w.coin,
                "lock",
                json!({"amount": coins.to_string()}),
                NO,
            )
            .await?;
        }
    }
    let pid = call(&alice, &w.coin, "submit_playbook",
        json!({"text": "Prefer PENGU. Never chase a loss.", "authors": [{"account_id": coach.id(), "share_bps": 10000}]}), NearToken::from_millinear(50)).await?;
    w.set_now(at(3, 1_000)).await?;
    w.set_now(at(4, 1_000)).await?;
    let vid = call(
        &alice,
        &w.coin,
        "open_vote",
        json!({"kind": "SET_PLAYBOOK", "playbook_id": pid}),
        NO,
    )
    .await?;
    call(
        &alice,
        &w.coin,
        "cast",
        json!({"vote_id": vid, "support": true}),
        NO,
    )
    .await?;
    w.set_now(at(5, 2_000)).await?;
    let v = call(&bob, &w.coin, "finish_vote", json!({"vote_id": vid}), NO).await?;
    assert_eq!(
        (v["state"].as_str(), v["effective_round"].as_u64()),
        (Some("PASSED"), Some(7))
    );
    w.set_now(at(6, 1_000)).await?;
    w.set_now(at(7, propose_from + 60_000)).await?;
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    assert!(
        rb["text"]
            .as_str()
            .unwrap()
            .contains("playbook: Prefer PENGU. Never chase a loss."),
        "{}",
        rb["text"]
    );
    let bet = json!({"action": "BET", "market": "PENGU", "side": "LONG", "margin": "20000000", "leverage": 1});
    let v = w.propose_text(&w.line_for(&bet).await?).await?;
    assert_eq!(v["verdict"], "YES", "{v}");
    w.set_now(at(7, close_from + 60_000)).await?;
    call(
        &w.runner,
        &w.coin,
        "report_result",
        json!({"position_id": v["position_id"], "returned": "30000000"}),
        NO,
    )
    .await?;
    let coach_before = w.usdc_of(coach.id()).await?;
    let r = call(&bob, &w.coin, "settle", json!({"round_id": 7}), NO).await?;
    assert_eq!(r, json!("10000000"));
    assert_eq!(
        w.usdc_of(coach.id()).await? - coach_before,
        1_000_000,
        "10% of the $10 win"
    );
    w.books_match(0).await?;
    println!("playbook {pid} voted in, in the rulebook from round 7; a $10 win paid its author $1");

    let feed: Value = w.view(&w.coin, "get_feed", json!({"limit": 100})).await?;
    let names: Vec<&str> = feed
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["event"].as_str().unwrap())
        .collect();
    for e in [
        "tipped",
        "goal_filled",
        "sticker_claimed",
        "outside_income",
        "playbook_submitted",
        "playbook_activated",
        "coach_paid",
    ] {
        assert!(names.contains(&e), "{e} missing");
    }
    let _ = &l.lender;
    Ok(())
}
