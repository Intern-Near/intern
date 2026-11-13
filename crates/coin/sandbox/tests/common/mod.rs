//! Shared helpers for the sandbox tests: a local NEAR node with mock-usdc and the coin deployed.
#![allow(dead_code)]

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const MIN_FIRST: u128 = 10_000_000;
pub const BRAVE: &str = r#"{"pool":"BRAVE"}"#;

/// The 24-hour clock of the interface test cases.
pub const REAL: [u64; 6] = [
    86_400_000, 42_900_000, 43_200_000, 46_800_000, 79_200_000, 600_000,
];
/// A one-minute clock for tests that wait on the chain.
pub const MINUTE: [u64; 6] = [60_000, 28_000, 30_000, 40_000, 50_000, 10_000];

/// The wasm files `run.sh` builds: mock-usdc, and the coin with the stand-in AI check and the
/// test hooks (never deployed anywhere else).
pub fn wasm(path: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(path);
    std::fs::read(&p).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (run ./run.sh, which builds the wasm first)",
            p.display()
        )
    })
}

pub fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

pub fn u(v: &Value) -> u128 {
    v.as_str()
        .unwrap_or_else(|| panic!("not a U128 string: {v}"))
        .parse()
        .unwrap()
}

pub fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub struct World {
    pub worker: Worker<Sandbox>,
    pub usdc: Contract,
    pub coin: Contract,
    pub runner: Account,
    pub genesis_ms: u64,
}

impl World {
    pub async fn view(&self, c: &Contract, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(c.view(method).args_json(args).await?.json()?)
    }

    pub async fn usdc_of(&self, who: &near_workspaces::AccountId) -> anyhow::Result<u128> {
        Ok(u(&self
            .view(&self.usdc, "ft_balance_of", json!({"account_id": who}))
            .await?))
    }

    pub async fn account(&self, who: &Account) -> anyhow::Result<Value> {
        self.view(&self.coin, "get_account", json!({"account_id": who.id()}))
            .await
    }

    pub async fn pot(&self) -> anyhow::Result<Value> {
        self.view(&self.coin, "get_pot", json!({})).await
    }

    pub async fn round(&self) -> anyhow::Result<Value> {
        self.view(&self.coin, "get_round", json!({})).await
    }

    pub async fn round_id(&self) -> anyhow::Result<u64> {
        Ok(self.round().await?["id"].as_u64().unwrap())
    }

    /// Moves the chain forward until round `id` is the current one.
    pub async fn reach_round(&self, id: u64) -> anyhow::Result<()> {
        for _ in 0..200 {
            if self.round_id().await? >= id {
                return Ok(());
            }
            self.worker.fast_forward(20).await?;
        }
        anyhow::bail!("round {id} never came")
    }

    pub async fn pay_in(
        &self,
        who: &Account,
        token: &Contract,
        amount: u128,
        msg: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(token.id(), "ft_transfer_call")
            .args_json(
                json!({"receiver_id": self.coin.id(), "amount": amount.to_string(), "msg": msg}),
            )
            .deposit(yocto(1))
            .gas(Gas::from_tgas(150))
            .transact()
            .await?)
    }

    pub async fn cash_out_pool(
        &self,
        who: &Account,
        pool: &str,
        amount: u128,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.coin.id(), "cash_out")
            .args_json(json!({"pool": pool, "amount": amount.to_string()}))
            .deposit(yocto(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    pub async fn cash_out(
        &self,
        who: &Account,
        amount: u128,
        pending: bool,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.coin.id(), "cash_out")
            .args_json(json!({"pool": "BRAVE", "amount": amount.to_string(), "pending": pending}))
            .deposit(yocto(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// TEST HOOK: fix the coin's clock at an absolute time.
    pub async fn set_now(&self, now_ms: u64) -> anyhow::Result<()> {
        self.coin
            .call("test_set_now")
            .args_json(json!({"now_ms": now_ms}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// The runner proposes `line` (a decision line, or any text) signed "FAKE" for the stand-in check.
    pub async fn propose_text(&self, line: &str) -> anyhow::Result<Value> {
        let rb = self.view(&self.coin, "get_rulebook", json!({})).await?;
        Ok(self
            .runner
            .call(self.coin.id(), "propose")
            .args_json(json!({"request": b64(rb["text"].as_str().unwrap().as_bytes()), "response": b64(line.as_bytes()), "signature": b64(b"FAKE")}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?
            .json()?)
    }

    /// The decision line for `decision` (the interface's Decision JSON) in the current round.
    pub async fn line_for(&self, decision: &Value) -> anyhow::Result<String> {
        let rb = self.view(&self.coin, "get_rulebook", json!({})).await?;
        let (round, nonce) = (
            rb["round_id"].as_u64().unwrap(),
            rb["nonce"].as_str().unwrap().to_string(),
        );
        Ok(match decision["action"].as_str().unwrap() {
            "SKIP" => format!(r#"{{"v":1,"round":{round},"nonce":"{nonce}","action":"skip"}}"#),
            _ => format!(
                r#"{{"v":1,"round":{round},"nonce":"{nonce}","action":"bet","market":"{}","side":"{}","margin_e6":"{}","leverage":{}}}"#,
                decision["market"].as_str().unwrap(),
                decision["side"].as_str().unwrap().to_lowercase(),
                decision["margin"].as_str().unwrap(),
                decision["leverage"]
            ),
        })
    }

    /// The USDC the coin really holds equals its books: BRAVE total - lent + pending + SAFE + income waiting (+ `ignored`, money
    /// sent outside the pay-in path, which the books ignore).
    pub async fn books_match(&self, ignored: u128) -> anyhow::Result<()> {
        let pot = self.pot().await?;
        // 1.4: the reward ladder holds its money apart from both pools.
        let rw = self.view(&self.coin, "get_rewards", json!({})).await?;
        // 1.7: the trick bounty is held apart too.
        let bounty = self.view(&self.coin, "get_bounty", json!({})).await?;
        let rescue = self.view(&self.coin, "get_rescue", json!({})).await?;
        let earn = self.view(&self.coin, "get_nft_earnings", json!({})).await?;
        let challenges = self.view(&self.coin, "get_challenges", json!({})).await?;
        let held = self.usdc_of(self.coin.id()).await?;
        assert_eq!(
            held,
            u(&pot["brave"]["total"]) - u(&pot["brave"]["lent"])
                + u(&pot["brave"]["pending"])
                + u(&pot["safe"]["total"])
                + u(&pot["brave"]["income_waiting"])
                + u(&rw["jackpot"])
                + u(&rw["draw_pot"])
                + u(&rw["prizes_owed"])
                + u(&bounty["pot"])
                + u(&rescue["fund"])
                + u(&earn["owed_total"])
                + u(&challenges["bonds_held"])
                + ignored,
            "USDC held vs books: {pot} {rw}"
        );
        Ok(())
    }
}

pub async fn token(worker: &Worker<Sandbox>) -> anyhow::Result<Contract> {
    let t = worker
        .dev_deploy(&wasm("target/near/mock_usdc/mock_usdc.wasm"))
        .await?;
    t.call("new").transact().await?.into_result()?;
    Ok(t)
}

pub async fn boss(w: &World, dollars: u128) -> anyhow::Result<Account> {
    let min: Value = w.view(&w.coin, "storage_balance_bounds", json!({})).await?;
    let a = w.worker.dev_create_account().await?;
    a.call(w.usdc.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    a.call(w.usdc.id(), "mint")
        .args_json(json!({"account_id": a.id(), "amount": dollars.to_string()}))
        .transact()
        .await?
        .into_result()?;
    a.call(w.coin.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(yocto(u(&min["min"])))
        .transact()
        .await?
        .into_result()?;
    Ok(a)
}

/// mock-usdc and the coin (test build) on a fresh local node, genesis = the node's clock.
pub async fn world(clock: [u64; 6]) -> anyhow::Result<World> {
    world_with(clock, "target/near/coin-test/coin.wasm", None).await
}

/// `wasm`: which test build; `pins`: the step 7 pins for `new` (None: nothing pinned).
pub async fn world_with(
    clock: [u64; 6],
    wasm_path: &str,
    pins: Option<Value>,
) -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let usdc = token(&worker).await?;
    let coin = worker.dev_deploy(&wasm(wasm_path)).await?;
    let genesis_ms = worker.view_block().await?.timestamp() / 1_000_000;
    let runner = worker.dev_create_account().await?;
    coin.call("new")
        .args_json(json!({"config": {
            "usdc_token": usdc.id(),
            "runner": runner.id(),
            "round": {"genesis_ms": genesis_ms, "round_ms": clock[0], "guess_close_ms": clock[1], "propose_from_ms": clock[2],
                      "propose_until_ms": clock[3], "close_from_ms": clock[4], "tail_fade_ms": clock[5]},
            "min_first_deposit": MIN_FIRST.to_string(),
            "pins": pins,
        }}))
        .transact()
        .await?
        .into_result()?;
    usdc.call("storage_deposit")
        .args_json(json!({"account_id": coin.id()}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(World {
        worker,
        usdc,
        coin,
        runner,
        genesis_ms,
    })
}
