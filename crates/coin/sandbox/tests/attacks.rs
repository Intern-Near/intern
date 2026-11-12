//! Step 10: the attack suite, one test per line of the threat table in INTERN-PRODUCT-SPEC.md section 18
//! that code can answer, on a local NEAR node with test dollars really moving. Run with `./run.sh`.
//! (Threats that code cannot answer, like a runner steering inside the rank or a rented vote, are known
//! limits: 01-SHARED-INTERFACE.md section 14 and docs/REAL-VS-STANDIN.md.)

mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};

const ONE: NearToken = NearToken::from_yoctonear(1);

/// First-depositor share inflation: the attacker pays in the minimum, gifts the pool money outside the
/// pay-in path to push the price, and tries to leave almost no coins. The next depositor still gets a
/// fair share.
#[tokio::test]
async fn attack_first_depositor_inflation() -> anyhow::Result<()> {
    let w = world(MINUTE).await?;
    let attacker = boss(&w, 2_000_000_000).await?;
    let victim = boss(&w, 1_000_000_000).await?;
    w.pay_in(&attacker, &w.usdc, MIN_FIRST, BRAVE)
        .await?
        .into_result()?;
    w.reach_round(2).await?;
    // Leave as few coins as possible: everything but 1 unit (1,000 units stay locked for good).
    let coins = u(&w.account(&attacker).await?["coin"]);
    w.cash_out(&attacker, coins - 1, false)
        .await?
        .into_result()?;
    // A $1,000 "donation" straight to the contract, outside the pay-in path.
    attacker
        .call(w.usdc.id(), "ft_transfer")
        .args_json(json!({"receiver_id": w.coin.id(), "amount": "1000000000"}))
        .deposit(ONE)
        .transact()
        .await?
        .into_result()?;
    let pot = w.pot().await?;
    assert_eq!(
        u(&pot["coin_price_e6"]),
        1_000_000,
        "the gift does not move the price: {pot}"
    );
    // The victim pays in $100 and gets $100 worth of coins.
    w.pay_in(&victim, &w.usdc, 100_000_000, BRAVE)
        .await?
        .into_result()?;
    w.reach_round(3).await?;
    let v = w.account(&victim).await?;
    assert!(
        u(&v["brave_value"]) >= 99_999_000,
        "the victim keeps its money: {v}"
    );
    w.books_match(1_000_000_000).await?;
    println!("ATTACK first-depositor inflation: refused (gift ignored, 1,000 units locked); victim kept {}", u(&v["brave_value"]));
    Ok(())
}

/// Reentrancy across async calls: two cash-outs of the same coins sent at once, and a cash-out racing a
/// transfer of the same coins. State is written before the outgoing call, so the coins can leave once.
#[tokio::test]
async fn attack_concurrent_calls_spend_the_same_coins_once() -> anyhow::Result<()> {
    let w = world(MINUTE).await?;
    let a = boss(&w, 1_000_000_000).await?;
    let b = boss(&w, 0_100_000_000).await?;
    w.pay_in(&a, &w.usdc, 500_000_000, BRAVE)
        .await?
        .into_result()?;
    w.reach_round(2).await?;
    let coins = u(&w.account(&a).await?["coin"]);
    let before = w.usdc_of(a.id()).await?;
    let cash = |amount: u128| {
        a.call(w.coin.id(), "cash_out")
            .args_json(json!({"pool": "BRAVE", "amount": amount.to_string()}))
            .deposit(ONE)
            .gas(Gas::from_tgas(100))
            .transact_async()
    };
    let first = cash(coins).await?;
    let second = cash(coins).await?;
    let send = a
        .call(w.coin.id(), "ft_transfer")
        .args_json(json!({"receiver_id": b.id(), "amount": coins.to_string()}))
        .deposit(ONE)
        .transact_async()
        .await?;
    let outcomes = [first.await?, second.await?, send.await?];
    let ok = outcomes.iter().filter(|o| o.is_success()).count();
    assert_eq!(ok, 1, "exactly one of the three may spend the coins");
    let paid = w.usdc_of(a.id()).await? - before;
    assert!(
        paid == 0 || paid == 499_999_000,
        "paid once at most: {paid}"
    );
    assert_eq!(u(&w.account(&a).await?["coin"]), 0);
    w.books_match(0).await?;
    println!("ATTACK concurrent spends of the same coins: 1 of 3 succeeded, paid {paid}");
    Ok(())
}

/// Forged callbacks: every callback is private; a stranger calling one directly is refused.
#[tokio::test]
async fn attack_forged_callbacks_are_refused() -> anyhow::Result<()> {
    let w = world(MINUTE).await?;
    let mallory = w.worker.dev_create_account().await?;
    for (method, args) in [
        (
            "on_payout",
            json!({"account_id": mallory.id(), "pool": "BRAVE", "coins": "1000", "paid": "1000000000"}),
        ),
        (
            "on_settle",
            json!({"round_id": 1, "margin_total": "0", "result": "1000000000"}),
        ),
        (
            "on_signed",
            json!({"position_id": 1, "kind": 1, "action_json": "{}", "digest": "00", "nonce": "1", "expires_after": "2", "prev_stage": 0, "sz_e8": null}),
        ),
        (
            "on_withdrawn",
            json!({"who": mallory.id(), "need": "1", "paid": "1000000000", "coins": "1", "then": "CashOut"}),
        ),
        ("on_lent", json!({"amount": "1000000000"})),
        ("on_interest", json!({})),
        (
            "on_claimed",
            json!({"account_id": mallory.id(), "token_id": "x", "kind": 0, "key": 0}),
        ),
        (
            "on_coach_paid",
            json!({"playbook_id": 1, "account_id": mallory.id(), "amount": "1000000000"}),
        ),
        (
            "migrate",
            json!({"stickers": mallory.id(), "launchpad": mallory.id(), "lender": null}),
        ),
    ] {
        let r = mallory
            .call(w.coin.id(), method)
            .args_json(args)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        assert!(r.is_failure(), "{method} must be refused to a stranger");
    }
    w.books_match(0).await?;
    println!("ATTACK forged callbacks (8) and migrate from a stranger: all refused");
    Ok(())
}

/// Junk tokens sent to the pot: refunded in full, the pool does not move.
#[tokio::test]
async fn attack_junk_token() -> anyhow::Result<()> {
    let w = world(MINUTE).await?;
    let a = boss(&w, 100_000_000).await?;
    let junk = token(&w.worker).await?;
    a.call(junk.id(), "storage_deposit")
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
    a.call(junk.id(), "mint")
        .args_json(json!({"account_id": a.id(), "amount": "77000000"}))
        .transact()
        .await?
        .into_result()?;
    let before = w.pot().await?;
    for msg in [
        BRAVE,
        r#"{"pool":"SAFE"}"#,
        r#"{"tip":{}}"#,
        r#"{"income":{"source":"junk"}}"#,
    ] {
        w.pay_in(&a, &junk, 77_000_000, msg).await?.into_result()?;
        assert_eq!(
            u(
                &w.view(&junk, "ft_balance_of", json!({"account_id": a.id()}))
                    .await?
            ),
            77_000_000,
            "{msg}: refunded"
        );
    }
    assert_eq!(w.pot().await?, before);
    println!("ATTACK junk token as pay-in, SAFE, tip and income: refunded in full, pool unchanged");
    Ok(())
}

/// A replayed proposal: the nonce moved after the first ruling, so the same answer is refused.
#[tokio::test]
async fn attack_replayed_proposal() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    w.set_now(w.genesis_ms + REAL[2] + 60_000).await?;
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    let line = w.line_for(&json!({"action": "SKIP"})).await?;
    let args = json!({"request": b64(rb["text"].as_str().unwrap().as_bytes()), "response": b64(line.as_bytes()), "signature": b64(b"FAKE")});
    let send = || {
        w.runner
            .call(w.coin.id(), "propose")
            .args_json(args.clone())
            .gas(Gas::from_tgas(100))
            .transact()
    };
    assert_eq!(
        send().await?.into_result()?.json::<Value>()?["verdict"],
        "SKIP"
    );
    let again: Value = send().await?.into_result()?.json()?;
    assert_eq!(
        (again["verdict"].as_str(), again["code"].as_str()),
        (Some("NOPE"), Some("MALFORMED_DECISION"))
    );
    println!("ATTACK replayed proposal: NOPE MALFORMED_DECISION (the nonce moved)");
    Ok(())
}

/// The wrong account: only the runner proposes, signs orders and reports results.
#[tokio::test]
async fn attack_wrong_account() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let mallory = w.worker.dev_create_account().await?;
    for (method, args, deposit) in [
        (
            "propose",
            json!({"request": b64(b"x"), "response": b64(b"x"), "signature": b64(b"FAKE")}),
            NearToken::from_yoctonear(0),
        ),
        (
            "sign_next",
            json!({"position_id": 1, "px_e8": "1"}),
            NearToken::from_yoctonear(0),
        ),
        (
            "report_result",
            json!({"position_id": 1, "returned": "1"}),
            NearToken::from_yoctonear(0),
        ),
    ] {
        let r = mallory
            .call(w.coin.id(), method)
            .args_json(args)
            .deposit(deposit)
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        assert!(r.is_failure(), "{method} from a stranger");
    }
    assert_eq!(
        w.view(&w.coin, "get_refusals", json!({})).await?,
        json!([]),
        "nothing was recorded"
    );
    println!("ATTACK propose, sign_next and report_result from the wrong account: refused, nothing recorded");
    Ok(())
}

/// A vote with coins locked after it opened: those coins weigh nothing in it.
#[tokio::test]
async fn attack_vote_with_coins_locked_after_it_opened() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let [round_ms, ..] = REAL;
    let at = |round: u64, into: u64| w.genesis_ms + (round - 1) * round_ms + into;
    let early = boss(&w, 1_000_000_000).await?;
    let whale = boss(&w, 3_000_000_000).await?;
    w.pay_in(&early, &w.usdc, 100_000_000, BRAVE)
        .await?
        .into_result()?;
    w.pay_in(&whale, &w.usdc, 2_000_000_000, BRAVE)
        .await?
        .into_result()?;
    w.set_now(at(2, 1_000)).await?;
    let c = u(&w.account(&early).await?["coin"]);
    early
        .call(w.coin.id(), "lock")
        .args_json(json!({"amount": c.to_string()}))
        .transact()
        .await?
        .into_result()?;
    w.set_now(at(3, 1_000)).await?;
    w.set_now(at(4, 1_000)).await?;
    let id: u64 = early
        .call(w.coin.id(), "open_vote")
        .args_json(json!({"kind": "FIRE"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    // The whale locks twenty times as much right after the vote opened, and tries to vote it down.
    let wc = u(&w.account(&whale).await?["coin"]);
    whale
        .call(w.coin.id(), "lock")
        .args_json(json!({"amount": wc.to_string()}))
        .transact()
        .await?
        .into_result()?;
    let r = whale
        .call(w.coin.id(), "cast")
        .args_json(json!({"vote_id": id, "support": false}))
        .transact()
        .await?;
    assert!(
        r.is_failure(),
        "zero weight in a vote opened before the lock"
    );
    let v = &w.view(&w.coin, "get_votes", json!({})).await?[0];
    assert_eq!(
        (u(&v["no"]), u(&v["locked_weight_at_open"])),
        (0, c / 7),
        "the whale is not in the tally"
    );
    println!("ATTACK coins locked after a vote opened: weigh nothing (the whale's cast refused)");
    Ok(())
}

/// A bet outside the proposal window: NOPE OUTSIDE_WINDOW, no position.
#[tokio::test]
async fn attack_bet_outside_the_window() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let a = boss(&w, 2_000_000_000).await?;
    w.pay_in(&a, &w.usdc, 1_000_000_000, BRAVE)
        .await?
        .into_result()?;
    let [round_ms, _, propose_from, propose_until, ..] = REAL;
    let bet = json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": "11000000", "leverage": 1});
    for into in [propose_from - 1, propose_until + 1] {
        w.set_now(w.genesis_ms + round_ms + into).await?;
        let v = w.propose_text(&w.line_for(&bet).await?).await?;
        assert_eq!(v["code"], "OUTSIDE_WINDOW", "{into}");
    }
    assert_eq!(
        w.view(&w.coin, "get_positions", json!({})).await?,
        json!([])
    );
    println!("ATTACK bets 1 ms before and 1 ms after the window: NOPE OUTSIDE_WINDOW, no position");
    Ok(())
}

/// Storage running out: calls a stranger can make for free do not grow the contract's storage.
#[tokio::test]
async fn attack_free_calls_do_not_grow_storage() -> anyhow::Result<()> {
    let w = world(MINUTE).await?;
    let a = boss(&w, 100_000_000).await?;
    w.pay_in(&a, &w.usdc, 20_000_000, BRAVE)
        .await?
        .into_result()?;
    let mallory = w.worker.dev_create_account().await?;
    let storage = || async { Ok::<u64, anyhow::Error>(w.coin.view_account().await?.storage_usage) };
    let before = storage().await?;
    for _ in 0..3 {
        for (method, args, deposit) in [
            ("cash_out", json!({"pool": "BRAVE", "amount": "1"}), ONE),
            ("lock", json!({"amount": "1"}), NearToken::from_yoctonear(0)),
            (
                "unlock",
                json!({"amount": "1"}),
                NearToken::from_yoctonear(0),
            ),
            (
                "finish_vote",
                json!({"vote_id": 99}),
                NearToken::from_yoctonear(0),
            ),
            (
                "settle",
                json!({"round_id": 99}),
                NearToken::from_yoctonear(0),
            ),
            ("claim_badge", json!({}), NearToken::from_millinear(20)),
            (
                "claim_sticker",
                json!({"code": "FIRED"}),
                NearToken::from_millinear(20),
            ),
            ("turn_dial", json!({"to": "SAFE", "amount": "1"}), ONE),
            (
                "open_vote",
                json!({"kind": "PROMOTE"}),
                NearToken::from_yoctonear(0),
            ),
            (
                "submit_playbook",
                json!({"text": "x".repeat(2_000), "authors": [{"account_id": mallory.id(), "share_bps": 10000}]}),
                NearToken::from_yoctonear(1),
            ),
        ] {
            let r = mallory
                .call(w.coin.id(), method)
                .args_json(args)
                .deposit(deposit)
                .gas(Gas::from_tgas(100))
                .transact()
                .await?;
            assert!(
                r.is_failure(),
                "{method} should be refused to a stranger with nothing"
            );
        }
        // An unregistered sender's pay-in and tip are refunded and store nothing.
        w.pay_in(&mallory, &w.usdc, 0, BRAVE).await.ok();
    }
    assert_eq!(
        storage().await?,
        before,
        "the contract's storage did not grow"
    );
    println!("ATTACK 30 free calls from a stranger: all refused, contract storage unchanged ({before} bytes)");
    Ok(())
}

/// A DOGE bet line with any margin and leverage text, for the current round and nonce.
async fn bet_line(w: &World, margin: &str, lev: u64) -> anyhow::Result<String> {
    let rb = w.view(&w.coin, "get_rulebook", json!({})).await?;
    Ok(format!(
        r#"{{"v":1,"round":{},"nonce":"{}","action":"bet","market":"DOGE","side":"long","margin_e6":"{margin}","leverage":{lev}}}"#,
        rb["round_id"],
        rb["nonce"].as_str().unwrap()
    ))
}

/// Numbers near the top of u128: no panic that would erase a refusal, no overflow that would pay.
#[tokio::test]
async fn attack_numbers_near_the_top_of_u128() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let a = boss(&w, 2_000_000_000).await?;
    w.pay_in(&a, &w.usdc, 1_000_000_000, BRAVE)
        .await?
        .into_result()?;
    w.set_now(w.genesis_ms + REAL[0] + REAL[2] + 60_000).await?;
    let max = u128::MAX.to_string();
    // check 8 multiplies margin by leverage: saturating, so a refusal, never an abort.
    let v = w.propose_text(&bet_line(&w, &max, 2).await?).await?;
    assert_eq!(
        (v["verdict"].as_str(), v["code"].as_str()),
        (Some("NOPE"), Some("OVER_LEVERAGE"))
    );
    let v = w.propose_text(&bet_line(&w, &max, 1).await?).await?;
    assert_eq!(
        (v["code"].as_str(), v["asked"].as_str()),
        (Some("OVER_TRADE_LIMIT"), Some(max.as_str()))
    );
    let v = w
        .propose_text(&bet_line(&w, "1", u32::MAX as u64 + 1).await?)
        .await?;
    assert_eq!(
        v["code"], "MALFORMED_DECISION",
        "a leverage beyond u32 does not even read"
    );
    // A huge lock, cash-out and dial: refused, nothing moves.
    let before = w.pot().await?;
    for (method, args) in [
        ("lock", json!({"amount": max})),
        ("cash_out", json!({"pool": "BRAVE", "amount": max})),
        ("cash_out", json!({"pool": "SAFE", "amount": max})),
        ("turn_dial", json!({"to": "SAFE", "amount": max})),
        ("turn_dial", json!({"to": "BRAVE", "amount": max})),
    ] {
        let r = a
            .call(w.coin.id(), method)
            .args_json(args)
            .deposit(ONE)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        assert!(r.is_failure(), "{method} u128::MAX");
    }
    assert_eq!(w.pot().await?, before);
    w.books_match(0).await?;
    println!("ATTACK u128::MAX margins, leverage beyond u32, u128::MAX lock/cash-out/dial: refusals, no abort, nothing moved");
    Ok(())
}
