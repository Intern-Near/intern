//! Step 7 on a local NEAR node: the deployed contract with the REAL AI check (Engine 2's ai-check)
//! replays recorded GLM answers through `propose`; a signing call whose signer fails leaves the bet where
//! it was; gas is measured. Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::{json, Value};
use std::path::PathBuf;

const GLM_PINS: &str = r#"{"model":"z-ai/glm-5.3-flash","signing_algo":"ed25519",
  "signer":"5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff",
  "hl_address":"0x0000000000000000000000000000000000000001","signer_contract":"no-signer.test.near"}"#;

struct Rec {
    request: Vec<u8>,
    response: Vec<u8>,
    signature: Vec<u8>,
    expected: Value,
}

fn recording(case: &str) -> Rec {
    let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/ai/z-ai--glm-5.3-flash")
        .join(case);
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(d.join("meta.json")).unwrap()).unwrap();
    let sig: Value =
        serde_json::from_str(&std::fs::read_to_string(d.join("signature-ed25519.json")).unwrap())
            .unwrap();
    let hex = sig["signature"].as_str().unwrap();
    Rec {
        request: std::fs::read(d.join("request.bin")).unwrap(),
        response: std::fs::read(d.join("response.bin")).unwrap(),
        signature: (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect(),
        expected: meta["expected"].clone(),
    }
}

#[tokio::test]
async fn recorded_glm_answers_through_the_deployed_real_check() -> anyhow::Result<()> {
    let w = world_with(
        REAL,
        "target/near/coin-real-test/coin.wasm",
        Some(serde_json::from_str(GLM_PINS)?),
    )
    .await?;
    let k = w.view(&w.coin, "get_constants", json!({})).await?;
    assert_eq!(
        k["model"]["id"], "z-ai/glm-5.3-flash",
        "the real check, not the stand-in"
    );
    let mut gas = vec![];
    for (case, flip, want) in [
        ("normal", false, "YES"),
        ("chatty", false, "MALFORMED_DECISION"),
        ("normal", true, "BAD_MODEL_SIGNATURE"),
    ] {
        // A fresh round in its proposal window, an INTERN with $1,000: the state the answer was recorded for.
        w.coin
            .call("test_set")
            .args_json(json!({"rank": "INTERN", "status": "EMPLOYED", "brave_at_open": "1000000000", "brave_now": "1000000000",
                              "bets_used": 0, "at_risk": "0", "ms_into_round": REAL[2] + 60_000}))
            .transact()
            .await?
            .into_result()?;
        let r = recording(case);
        w.coin
            .call("test_expect")
            .args_json(json!({"rulebook": r.expected["rulebook"], "round_id": r.expected["round_id"], "nonce": r.expected["nonce"]}))
            .transact()
            .await?
            .into_result()?;
        let mut response = r.response.clone();
        if flip {
            response[10] ^= 1;
        }
        let out = w
            .runner
            .call(w.coin.id(), "propose")
            .args_json(json!({"request": b64(&r.request), "response": b64(&response), "signature": b64(&r.signature)}))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        let burnt = out.total_gas_burnt.as_tgas();
        let v: Value = out.into_result()?.json()?;
        let got = if v["verdict"] == "NOPE" {
            v["code"].as_str().unwrap().to_string()
        } else {
            v["verdict"].as_str().unwrap().to_string()
        };
        assert_eq!(got, want, "{case}: {v}");
        println!(
            "propose with the real check, recorded GLM answer '{case}'{}: {got}, {burnt} TGas",
            if flip { " (one byte changed)" } else { "" }
        );
        gas.push(burnt);
    }
    let positions: Value = w.view(&w.coin, "get_positions", json!({})).await?;
    let p = &positions.as_array().unwrap()[0];
    assert_eq!(
        (p["market"].as_str(), p["margin"].as_str()),
        (Some("PENGU"), Some("20000000")),
        "the recorded bet: $20 PENGU long"
    );
    assert!(gas.iter().all(|g| *g < 100), "gas: {gas:?}");
    Ok(())
}

#[tokio::test]
async fn a_failed_signature_leaves_the_bet_where_it_was_on_a_real_node() -> anyhow::Result<()> {
    // The signer account does not exist, so every `sign` call fails: the callback must put the bet back.
    let w = world_with(
        REAL,
        "target/near/coin-test/coin.wasm",
        Some(serde_json::from_str(GLM_PINS)?),
    )
    .await?;
    let [round_ms, _, propose_from, ..] = REAL;
    let alice = boss(&w, 2_000_000_000).await?;
    w.pay_in(&alice, &w.usdc, 1_000_000_000, BRAVE)
        .await?
        .into_result()?;
    w.set_now(w.genesis_ms + round_ms + propose_from + 60_000)
        .await?;
    let bet = json!({"action": "BET", "market": "DOGE", "side": "LONG", "margin": "11000000", "leverage": 1});
    let out = w
        .runner
        .call(w.coin.id(), "propose")
        .args_json(json!({"request": b64(b"x"), "response": b64(w.line_for(&bet).await?.as_bytes()), "signature": b64(b"FAKE")}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    println!(
        "propose (stand-in check) YES: {} TGas",
        out.total_gas_burnt.as_tgas()
    );
    let pid = out.into_result()?.json::<Value>()?["position_id"]
        .as_u64()
        .unwrap();
    for attempt in 1..=2 {
        let out = w
            .runner
            .call(w.coin.id(), "sign_next")
            .args_json(json!({"position_id": pid, "px_e8": "6826000"}))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        assert!(
            out.logs().iter().any(|l| l.contains("signing failed")),
            "{:?}",
            out.logs()
        );
        let burnt = out.total_gas_burnt.as_tgas();
        assert_eq!(
            out.json::<Value>()?,
            Value::Null,
            "returns null when the signature failed"
        );
        println!(
            "sign_next with a failing signer, attempt {attempt}: put back, {burnt} TGas burnt"
        );
    }
    let outbox: Value = w.view(&w.coin, "get_outbox", json!({})).await?;
    assert_eq!(outbox, json!([]));
    let p = &w.view(&w.coin, "get_positions", json!({})).await?[0];
    assert_eq!(p["status"], "APPROVED");
    // Too little gas is refused before anything is asked.
    let out = w
        .runner
        .call(w.coin.id(), "sign_next")
        .args_json(json!({"position_id": pid, "px_e8": 6826000}))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    assert!(out.is_failure());
    // A stranger cannot sign.
    let out = alice
        .call(w.coin.id(), "sign_next")
        .args_json(json!({"position_id": pid, "px_e8": "6826000"}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(out.is_failure());
    Ok(())
}
