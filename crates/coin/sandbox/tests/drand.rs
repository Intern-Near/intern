//! Interface 1.7 (item 22) on a local NEAR node: the compiled coin verifies a real drand quicknet beacon with NEAR's
//! BLS12-381 host functions, refuses a wrong one, and the gas is measured. (The two-step draw itself is covered by
//! the unit tests in `crates/coin/src/tests_rewards.rs`.) Run with `./run.sh`.

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::json;

/// https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/1000
const SIG_1000: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";
const RANDOMNESS_1000: &str = "fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd";

#[tokio::test]
async fn the_real_contract_verifies_a_real_drand_beacon() -> anyhow::Result<()> {
    let w = world(REAL).await?;
    let anyone = w.worker.dev_create_account().await?;
    let out = anyone
        .call(w.coin.id(), "submit_drand")
        .args_json(json!({"round": 1000, "signature": SIG_1000}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let burnt = out.total_gas_burnt.as_gas() as f64 / 1e12;
    let r = out
        .into_result()
        .map_err(|e| anyhow::anyhow!("submit_drand: {e:?}"))?;
    assert_eq!(r.json::<String>()?, RANDOMNESS_1000);
    println!("submit_drand burnt {burnt:.1} TGas");
    assert!(burnt < 100.0);
    let wrong = anyone
        .call(w.coin.id(), "submit_drand")
        .args_json(json!({"round": 1001, "signature": SIG_1000}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(wrong.is_failure(), "another round's signature is refused");
    let v = w.view(&w.coin, "get_drand", json!({})).await?;
    assert_eq!(
        (v["state"].as_str(), v["chain"].as_str()),
        (Some("OPEN"), Some("quicknet"))
    );
    Ok(())
}
