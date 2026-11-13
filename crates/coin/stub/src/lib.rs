//! STAND-IN: the $INTERN stub contract (Engine 1 brief, step 1).
//!
//! Answers every view of 01-SHARED-INTERFACE.md (version 1.1) section 8 with made-up data in the
//! exact shapes, and accepts every action of section 9 with the exact arguments. Actions only add
//! an item to the feed (and its NEP-297 log line) and return a correctly shaped answer; they never
//! change the canned data and never move money. `set_scene` (stub only, open to anyone) switches
//! the canned data between ten named scenes. Nothing here is the product.
//!
//! Times: when a scene is switched on, the shown round is placed so that "now" sits inside the
//! scene's phase. Call `set_scene` again to refresh the times.

#![forbid(unsafe_code)]

pub mod scenes;
pub mod table;

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue,
};
use scenes::{Clock, Scene, SceneData, BOSS, DEMO, MARGIN, REAL};
use wire::*;

/// The feed keeps this many items (section 10).
pub const FEED_KEEP: u64 = 1_000;
/// `limit` defaults to 50 and is capped at 100 (section 8).
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 100;
/// NEP-145 registration price used by the stub: 125 bytes at NEAR's 10^19 yocto per byte.
const STORAGE_MIN: u128 = 1_250_000_000_000_000_000_000;
/// Ids handed out by the stub's own actions start here, clear of the canned ids.
const FIRST_LIVE_ID: u64 = 100;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stub {
    scene: Scene,
    /// 0 (deployed): the shown round follows the clock, its start is always `now − the scene's
    /// point`, so the phase matches the scene however long ago it was set. Non-zero (tests only):
    /// a fixed start, used to compare with the section 8.2 samples.
    pinned_start: u64,
    /// false: the 30-minute demo round (deployed). true: the 24-hour round (tests only).
    real_clock: bool,
    /// seq -> FeedItem as JSON text.
    feed: LookupMap<u64, String>,
    feed_first: u64,
    feed_next: u64,
    registered: LookupSet<AccountId>,
    next_id: u64,
    nonce_counter: u64,
    sign_count: u64,
}

/// `px_e8` for `sign_next` and `close` (1.2: a decimal string; a JSON number is also accepted).
pub use wire::PxE8;

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PayInMsg {
    pool: Pool,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn page_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize
}

/// Newest-first paging (section 8): `from` is the highest id to return.
fn newest_first<T: Clone>(
    items: &[T],
    id: impl Fn(&T) -> u64,
    from: Option<u64>,
    limit: Option<u32>,
) -> Vec<T> {
    items
        .iter()
        .filter(|x| from.is_none_or(|f| id(x) <= f))
        .take(page_limit(limit))
        .cloned()
        .collect()
}

fn decodes(b64: &str) -> bool {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD
        .decode(b64)
        .is_ok()
}

impl Stub {
    /// Builds the stub in a scene. `pinned` None: the round follows the clock (as deployed).
    pub(crate) fn make(scene: Scene, real_clock: bool, pinned: Option<u64>) -> Self {
        let mut s = Stub {
            scene,
            pinned_start: 0,
            real_clock,
            feed: LookupMap::new(b"f"),
            feed_first: 1,
            feed_next: 1,
            registered: LookupSet::new(b"r"),
            next_id: FIRST_LIVE_ID,
            nonce_counter: 0,
            sign_count: 0,
        };
        s.registered.insert(BOSS.parse().unwrap());
        s.switch(scene, pinned);
        s
    }

    /// The start of the shown round: pinned (tests), or `now − the scene's point` (deployed).
    fn anchor(&self) -> u64 {
        if self.pinned_start != 0 {
            return self.pinned_start;
        }
        now_ms().saturating_sub(scenes::scene_point(self.scene, &self.clock()))
    }

    fn clock(&self) -> Clock {
        if self.real_clock {
            REAL
        } else {
            DEMO
        }
    }

    fn data(&self) -> SceneData {
        scenes::build(self.scene, &self.clock(), self.anchor())
    }

    fn switch(&mut self, scene: Scene, pinned: Option<u64>) {
        self.scene = scene;
        self.pinned_start = pinned.unwrap_or(0);
        // The feed is emptied and refilled with the scene's story; seq keeps rising.
        for seq in self.feed_first..self.feed_next {
            self.feed.remove(&seq);
        }
        self.feed_first = self.feed_next;
        self.nonce_counter += 1;
        // Every item set_scene adds carries the current block time, so the site treats the
        // scene's last event as fresh (it ignores events older than 15 s for its big moments).
        let now = now_ms();
        for (_, event, data) in self.data().story {
            self.push(now, event, data);
        }
    }

    fn push(&mut self, at: u64, event: EventName, data: Value) {
        env::log_str(&event_log(event, &data));
        let item = FeedItem {
            seq: self.feed_next,
            at,
            event,
            data,
        };
        self.feed
            .insert(self.feed_next, serde_json::to_string(&item).unwrap());
        self.feed_next += 1;
        while self.feed_next - self.feed_first > FEED_KEEP {
            self.feed.remove(&self.feed_first);
            self.feed_first += 1;
        }
    }

    fn take_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id - 1
    }

    fn nonce(&self) -> String {
        let h = env::sha256_array(
            format!("stub-nonce:{}:{}", self.scene.as_str(), self.nonce_counter).as_bytes(),
        );
        h[..8].iter().map(|b| format!("{b:02x}")).collect()
    }

    fn signed_action(&mut self, position_id: u64, kind: ActionKind, px_e8: u64) -> SignedAction {
        let id = self.take_id();
        let at = now_ms();
        let px = wire_number(px_e8);
        let asset = scenes::DOGE_TESTNET_ASSET;
        let action = match kind {
            ActionKind::Leverage => {
                json!({"type":"updateLeverage","asset":asset,"isCross":false,"leverage":1})
            }
            ActionKind::Open => {
                json!({"type":"order","orders":[{"a":asset,"b":true,"p":px,"s":"293","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"})
            }
            ActionKind::Close => {
                json!({"type":"order","orders":[{"a":asset,"b":false,"p":px,"s":"293","r":true,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"})
            }
        };
        let a = SignedAction {
            id,
            position_id,
            kind,
            action,
            nonce: at,
            expires_after: at + 120_000,
            // Not a signature: the stub never calls NEAR's signing network.
            signature: EcdsaSignature {
                r: format!("0x{:064x}", 0x5757_0000 + id),
                s: format!("0x{:064x}", 0x5151_0000 + id),
                v: 27,
            },
            created_at: at,
        };
        self.push(
            at,
            EventName::OrderSigned,
            json!({"action_id": id, "position_id": position_id, "kind": kind}),
        );
        a
    }
}

#[near]
impl Stub {
    #[init]
    pub fn new() -> Self {
        Self::make(Scene::Holding, false, None)
    }

    // ===== stub only ================================================================================

    /// STUB ONLY. Switches the canned data. Open to anyone. Scenes: QUIET, REFUSED, APPROVED,
    /// HOLDING, SETTLED_WIN, SETTLED_LOSS, VOTE_OPEN, PROMOTED, FIRED, STUCK.
    pub fn set_scene(&mut self, scene: String) {
        let Some(s) = Scene::parse(&scene) else {
            let names: Vec<&str> = Scene::ALL.iter().map(|s| s.as_str()).collect();
            env::panic_str(&format!(
                "unknown scene {scene:?}; one of {}",
                names.join(", ")
            ));
        };
        self.switch(s, None);
    }

    /// STUB ONLY. Which scene is on, and the list.
    pub fn get_scene(&self) -> Value {
        json!({
            "scene": self.scene.as_str(),
            "scenes": Scene::ALL.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            "started_at": self.anchor(),
            "note": "STAND-IN. Made-up data in the shapes of 01-SHARED-INTERFACE.md 1.1. The round follows the clock: its phase always matches the scene. set_scene switches the scene and refills the feed with the current block time.",
        })
    }

    // ===== section 8: views ===========================================================================

    pub fn get_constants(&self) -> Constants {
        let c = self.clock();
        let id = scenes::round_id(self.scene);
        let me = env::current_account_id();
        Constants {
            interface_version: INTERFACE_VERSION.to_string(),
            network: Network::Testnet,
            usdc_token: format!("usdc.{me}").parse().unwrap(),
            coin_decimals: 6,
            ranks: Rank::ALL.into_iter().map(table::limits).collect(),
            markets: table::testnet_markets(),
            min_notional: U128(rules::limits::MIN_NOTIONAL),
            round: RoundConstants {
                genesis_ms: self.anchor().saturating_sub((id - 1) * c.round_ms),
                round_ms: c.round_ms,
                guess_close_ms: c.guess_close_ms,
                propose_from_ms: c.propose_from_ms,
                propose_until_ms: c.propose_until_ms,
                close_from_ms: c.close_from_ms,
                tail_fade_ms: c.tail_fade_ms,
            },
            vote: VoteConstants {
                promote_pass_bps: 5_000,
                promote_quorum_bps: 2_000,
                tighten_pass_bps: 3_400,
                vote_ms: c.round_ms,
                weight_full_rounds: 7,
            },
            model: ModelPin {
                id: "UNSET-stub-model".to_string(),
                signing_algo: SigningAlgo::Ecdsa,
                signer: format!("0x{}", "0".repeat(40)),
            },
            funding: FundingConstants {
                mode: FundingMode::Recorded,
                quote_signer: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc".to_string(),
                quote_max_age_ms: 60_000,
                max_funding_cost_bps: 400,
            },
            result_source: ResultSource::Reported,
            lending: LendingConstants {
                mode: LendingMode::Standin,
                lender: Some("lender.desk-lab-2026.testnet".parse().unwrap()),
            },
            hl: HlConstants {
                testnet: true,
                address: format!("0x{}", "0".repeat(40)),
                signer_contract: "v1.signer-prod.testnet".parse().unwrap(),
                path: "intern-1".to_string(),
                order_expiry_ms: 120_000,
            },
            runner: "intern-runner-ed25519.testnet".parse().unwrap(), // Engine 2's runner (1.2)
            min_first_deposit: U128(10_000_000),
            refusal_codes: table::refusal_codes(),
            // 1.3: the stub has no playbooks, goals or claims of its own; these show the real values.
            coach_cut_bps: 1_000,
            goals: wire::GoalConstants {
                boss_ladder: vec![10, 25, 50, 100, 250, 500, 1000],
                tip_jar_target: U128(100_000_000),
                min_tip: U128(1_000_000),
                hype_window_ms: 300_000,
                hype_levels: vec![3, 6, 10, 15, 25],
            },
            stickers: "stickers.desk-lab-2026.testnet".parse().unwrap(),
            launchpad: "launch.desk-lab-2026.testnet".parse().unwrap(),
        }
    }

    pub fn get_rank(&self) -> RankState {
        self.data().rank
    }

    pub fn get_limits(&self, rank: Rank) -> Limits {
        table::limits(rank)
    }

    pub fn get_round(&self) -> Round {
        self.data().round
    }

    pub fn get_round_by_id(&self, round_id: u64) -> Option<Round> {
        let current = self.data().round;
        if round_id == current.id {
            return Some(current);
        }
        if round_id == 0 || round_id > current.id {
            return None;
        }
        // An earlier round: made up as a quiet, settled round with no bet.
        let c = self.clock();
        let s = current.started_at - (current.id - round_id) * c.round_ms;
        Some(Round {
            id: round_id,
            phase: Phase::Close,
            settled: true,
            stuck: false,
            started_at: s,
            guess_closes_at: s + c.guess_close_ms,
            propose_from: s + c.propose_from_ms,
            propose_until: s + c.propose_until_ms,
            close_from: s + c.close_from_ms,
            ends_at: s + c.round_ms,
            rank: Rank::Intern,
            status: Status::Employed,
            brave_at_open: U128(1_000_000_000),
            bets_used: 0,
            at_risk: U128(0),
            skipped: 1,
            refused: 0,
            result: Some(I128(0)),
        })
    }

    pub fn get_rulebook(&self) -> Rulebook {
        let d = self.data();
        let nonce = self.nonce();
        let text = table::rulebook_text(
            d.round.id,
            &nonce,
            d.rank.rank,
            d.round.brave_at_open.0,
            d.round.bets_used,
            d.round.at_risk.0,
            None,
        );
        Rulebook {
            round_id: d.round.id,
            nonce,
            text,
        }
    }

    pub fn get_positions(&self, round_id: Option<u64>) -> Vec<Position> {
        let d = self.data();
        if round_id.is_none_or(|r| r == d.round.id) {
            d.positions
        } else {
            vec![]
        }
    }

    pub fn get_outbox(&self, after_id: Option<u64>, limit: Option<u32>) -> Vec<SignedAction> {
        self.data()
            .outbox
            .into_iter()
            .filter(|a| after_id.is_none_or(|after| a.id > after))
            .take(page_limit(limit))
            .collect()
    }

    pub fn get_pot(&self) -> Pot {
        self.data().pot
    }

    pub fn get_account(&self, account_id: AccountId) -> Account {
        if !self.registered.contains(&account_id) {
            return Account {
                account_id,
                registered: false,
                coin: U128(0),
                locked: U128(0),
                brave_value: U128(0),
                pending_brave: U128(0),
                safe: U128(0),
                joined_round: None,
                vote_weight: U128(0),
            };
        }
        let coin = 250_000_000u128;
        let price = self.data().pot.coin_price_e6.0;
        Account {
            account_id,
            registered: true,
            coin: U128(coin),
            locked: U128(100_000_000),
            brave_value: U128(coin * price / 1_000_000),
            pending_brave: U128(0),
            safe: U128(100_000_000),
            joined_round: Some(12),
            vote_weight: U128(100_000_000),
        }
    }

    pub fn get_votes(&self, from: Option<u64>, limit: Option<u32>) -> Vec<Vote> {
        newest_first(&self.data().votes, |v| v.id, from, limit)
    }

    pub fn get_refusals(&self, from: Option<u64>, limit: Option<u32>) -> Vec<RefusalRecord> {
        newest_first(&self.data().refusals, |r| r.id, from, limit)
    }

    pub fn get_sticker_firsts(&self) -> Vec<StickerFirst> {
        self.data().firsts
    }

    /// Oldest first. No `after_seq`: the latest `limit` items. Behind the oldest kept item: starts
    /// at the oldest kept item (the jump in `seq` shows the gap).
    pub fn get_feed(&self, after_seq: Option<u64>, limit: Option<u32>) -> Vec<FeedItem> {
        let n = page_limit(limit) as u64;
        let start = match after_seq {
            None => self.feed_next.saturating_sub(n).max(self.feed_first),
            Some(a) => (a + 1).max(self.feed_first),
        };
        let end = (start + n).min(self.feed_next);
        (start..end)
            .filter_map(|seq| self.feed.get(&seq))
            .map(|text| serde_json::from_str(text).unwrap())
            .collect()
    }

    pub fn get_active_playbook(&self) -> Option<Playbook> {
        None
    }

    // ----- NEP-141 / NEP-145 / NEP-148 views

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.get_account(account_id).coin
    }

    pub fn ft_total_supply(&self) -> U128 {
        self.data().pot.coin_supply
    }

    pub fn ft_metadata(&self) -> FtMetadata {
        FtMetadata {
            spec: "ft-1.0.0".to_string(),
            name: "INTERN (stub)".to_string(),
            symbol: "INTERN".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.registered
            .contains(&account_id)
            .then_some(StorageBalance {
                total: U128(STORAGE_MIN),
                available: U128(0),
            })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_MIN),
            max: Some(U128(STORAGE_MIN)),
        }
    }

    // ===== section 9.1: money ========================================================================

    /// NEP-145. Registers `account_id` (default: the caller). Needs `storage_balance_bounds().min`
    /// the first time. The stub keeps the deposit.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        if !self.registered.contains(&who) {
            require!(
                env::attached_deposit() >= NearToken::from_yoctonear(STORAGE_MIN),
                "attach at least storage_balance_bounds().min"
            );
            self.registered.insert(who);
        }
        StorageBalance {
            total: U128(STORAGE_MIN),
            available: U128(0),
        }
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        let _ = amount;
        assert_one_yocto();
        StorageBalance {
            total: U128(STORAGE_MIN),
            available: U128(0),
        }
    }

    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let _ = force;
        assert_one_yocto();
        self.registered.remove(&env::predecessor_account_id())
    }

    /// Pay in. In the product only the pinned USDC token calls this; on the stub anyone may, and no
    /// money arrives. A bad `msg` is "refunded": the whole amount is returned as unused.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let Ok(PayInMsg { pool }) = serde_json::from_str::<PayInMsg>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        self.push(
            now_ms(),
            EventName::PaidIn,
            json!({"account_id": sender_id, "pool": pool, "amount": amount, "pending": pool == Pool::Brave}),
        );
        PromiseOrValue::Value(U128(0))
    }

    #[payable]
    pub fn cash_out(&mut self, pool: Pool, amount: U128, pending: Option<bool>) {
        assert_one_yocto();
        let (coins, paid) = match (pool, pending.unwrap_or(false)) {
            (Pool::Brave, false) => (
                Some(amount),
                U128(amount.0 * self.data().pot.coin_price_e6.0 / 1_000_000),
            ),
            _ => (None, amount),
        };
        self.push(
            now_ms(),
            EventName::CashedOut,
            json!({"account_id": env::predecessor_account_id(), "pool": pool, "coins": coins, "paid": paid}),
        );
    }

    #[payable]
    pub fn turn_dial(&mut self, to: Pool, amount: U128) {
        assert_one_yocto();
        self.push(
            now_ms(),
            EventName::DialTurned,
            json!({"account_id": env::predecessor_account_id(), "to": to, "amount": amount}),
        );
    }

    /// NEP-141. The stub moves nothing.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let _ = (receiver_id, amount, memo);
        assert_one_yocto();
    }

    /// NEP-141. The stub moves nothing and calls no one; it reports the whole amount as used.
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = (receiver_id, memo, msg);
        assert_one_yocto();
        PromiseOrValue::Value(amount)
    }

    // ===== section 9.2: voting =======================================================================

    pub fn lock(&mut self, amount: U128) {
        self.push(
            now_ms(),
            EventName::Locked,
            json!({"account_id": env::predecessor_account_id(), "amount": amount}),
        );
    }

    pub fn unlock(&mut self, amount: U128) {
        self.push(
            now_ms(),
            EventName::Unlocked,
            json!({"account_id": env::predecessor_account_id(), "amount": amount}),
        );
    }

    pub fn open_vote(&mut self, kind: VoteKind, playbook_id: Option<u64>) -> u64 {
        let id = self.take_id();
        let at = now_ms();
        let closes_at = at + self.clock().round_ms;
        self.push(
            at,
            EventName::VoteOpened,
            json!({"vote_id": id, "kind": kind, "playbook_id": playbook_id, "opened_by": env::predecessor_account_id(), "closes_at": closes_at}),
        );
        id
    }

    pub fn cast(&mut self, vote_id: u64, support: bool) {
        self.push(
            now_ms(),
            EventName::VoteCast,
            json!({"vote_id": vote_id, "account_id": env::predecessor_account_id(), "support": support, "weight": U128(100_000_000)}),
        );
    }

    pub fn finish_vote(&mut self, vote_id: u64) {
        let effective = self.data().round.id + 2;
        self.push(
            now_ms(),
            EventName::VoteFinished,
            json!({"vote_id": vote_id, "state": VoteState::Passed, "effective_round": effective}),
        );
    }

    // ===== section 9.3: the round ====================================================================

    /// The verdict follows the scene: outside PROPOSE it is OUTSIDE_WINDOW; FIRED gives FIRED;
    /// undecodable base64 gives BAD_MODEL_SIGNATURE (or BAD_QUOTE_SIGNATURE for the quote);
    /// REFUSED gives OVER_TRADE_LIMIT; otherwise SKIP if the response contains "action":"skip"
    /// (plain or JSON-escaped), else YES. No signature is checked and the bet is not read.
    pub fn propose(
        &mut self,
        request: String,
        response: String,
        signature: String,
        funding: Option<Funding>,
    ) -> Verdict {
        let d = self.data();
        let c = self.clock();
        let now = now_ms();
        let round_id = d.round.id;
        self.nonce_counter += 1;

        let nope = |code: Refusal, asked: Option<u128>, limit: Option<u128>| (code, asked, limit);
        let outcome: Result<bool, (Refusal, Option<u128>, Option<u128>)> =
            if d.round.phase != Phase::Propose {
                let limit = if d.round.phase == Phase::Open {
                    c.propose_from_ms
                } else {
                    c.propose_until_ms
                };
                Err(nope(
                    Refusal::OutsideWindow,
                    Some(now.saturating_sub(self.anchor()) as u128),
                    Some(limit as u128),
                ))
            } else if d.rank.status == Status::Fired {
                Err(nope(Refusal::Fired, None, None))
            } else if !(decodes(&request) && decodes(&response) && decodes(&signature)) {
                Err(nope(Refusal::BadModelSignature, None, None))
            } else if self.scene == Scene::Refused {
                Err(nope(
                    Refusal::OverTradeLimit,
                    Some(450_000_000),
                    Some(MARGIN),
                ))
            } else if funding
                .as_ref()
                .is_some_and(|f| !(decodes(&f.quote) && decodes(&f.signature)))
            {
                Err(nope(Refusal::BadQuoteSignature, None, None))
            } else {
                use near_sdk::base64::Engine;
                let body = near_sdk::base64::engine::general_purpose::STANDARD
                    .decode(&response)
                    .unwrap_or_default();
                let body = String::from_utf8_lossy(&body);
                // The raw line, or the same line escaped inside a JSON response body.
                Ok(body.contains(r#""action":"skip""#) || body.contains(r#"\"action\":\"skip\""#))
            };

        match outcome {
            Err((code, asked, limit)) => {
                let refusal_id = self.take_id();
                let (asked, limit) = (asked.map(U128), limit.map(U128));
                self.push(
                    now,
                    EventName::Refused,
                    json!({"refusal_id": refusal_id, "round_id": round_id, "code": code, "asked": asked, "limit": limit, "is_first": false}),
                );
                Verdict::Nope {
                    refusal_id,
                    code,
                    asked,
                    limit,
                }
            }
            Ok(true) => {
                self.push(now, EventName::Skipped, json!({"round_id": round_id}));
                Verdict::Skip
            }
            Ok(false) => {
                let position_id = self.take_id();
                self.push(
                    now,
                    EventName::Approved,
                    json!({"position_id": position_id, "round_id": round_id, "market": Market::Doge, "side": Side::Long,
                           "margin": U128(MARGIN), "leverage": 1}),
                );
                Verdict::Yes { position_id }
            }
        }
    }

    /// Runner only in the product; anyone on the stub. No deposit. Alternates LEVERAGE and OPEN.
    pub fn sign_next(&mut self, position_id: u64, px_e8: PxE8) -> SignedAction {
        self.sign_count += 1;
        let kind = if self.sign_count % 2 == 1 {
            ActionKind::Leverage
        } else {
            ActionKind::Open
        };
        self.signed_action(position_id, kind, px_e8.0)
    }

    #[payable]
    pub fn close(&mut self, position_id: u64, px_e8: PxE8) -> SignedAction {
        assert_one_yocto();
        self.signed_action(position_id, ActionKind::Close, px_e8.0)
    }

    pub fn report_result(&mut self, position_id: u64, returned: U128) {
        let result = I128(returned.0 as i128 - MARGIN as i128);
        self.push(
            now_ms(),
            EventName::ResultReported,
            json!({"position_id": position_id, "returned": returned, "result": result, "result_source": ResultSource::Reported}),
        );
    }

    pub fn settle(&mut self, round_id: u64) -> I128 {
        let d = self.data();
        let result = d.round.result.unwrap_or(I128(0));
        self.push(
            now_ms(),
            EventName::Settled,
            json!({"round_id": round_id, "result": result, "brave_after": d.pot.brave.total}),
        );
        result
    }
}

/// A 1e8-scaled number as Hyperliquid writes it: no trailing zeros, no trailing dot.
fn wire_number(v_e8: u64) -> String {
    let (i, f) = (v_e8 / 100_000_000, v_e8 % 100_000_000);
    if f == 0 {
        return i.to_string();
    }
    format!("{}.{}", i, format!("{f:08}").trim_end_matches('0'))
}

#[cfg(test)]
mod tests;
