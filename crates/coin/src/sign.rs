//! Step 7 of the Engine 1 brief: the real AI check (Engine 2's `ai-check`) and real order signing
//! (Engine 2's `hl-order` + NEAR's signing network), following 01-SHARED-INTERFACE.md 1.2,
//! sections 6.3, 8.1 and 9.3.
//!
//! How a YES becomes orders:
//! - `sign_next` (runner only) is called twice: first "set leverage, isolated" for the market, then
//!   the opening order, sized `floor(notional / px)` cut to the market's size decimals, with
//!   `px × size ≤ notional` checked again. Each asks the signing network to sign a digest the
//!   program built itself from fields it has checked; it never signs a hash handed to it.
//! - `close` (anyone, in phase CLOSE or once FIRED) signs a reduce-only order for the recorded size on
//!   the other side. It may be signed again with a new price until the bet has a result.
//! - The callback checks that the signature recovers to the program's published Hyperliquid address
//!   before it is put in the outbox. A failed or wrong signature leaves the bet where it was, so the
//!   call can simply be made again.
//!
//! Readings where the interface is silent (reported to the owner):
//! - Once FIRED, an approved bet's orders are not signed (no new exposure); the runner reports its
//!   margin back with `report_result` and the round settles.
//! - Only one signature per bet is in flight at a time (two racing calls cannot sign the opening twice).
//! - The outbox keeps the last 200 signed actions: an action is useless after `expires_after`, and
//!   anyone may re-sign a close, so an unbounded outbox would let anyone grow the program's storage.

use crate::*;
use near_sdk::json_types::U64;
use near_sdk::serde::Deserialize;
use shared::Host;

/// Gas for the signing network's `sign` (the probe's value, VERIFIED on testnet) and for the callback.
const GAS_MPC: Gas = Gas::from_tgas(200);
const GAS_ON_SIGNED: Gas = Gas::from_tgas(30);
/// A signing call must carry enough gas for both, or a failed signature could not be put back.
pub const GAS_SIGN_MIN: Gas = Gas::from_tgas(250);
/// Signed actions kept in the outbox.
pub const OUTBOX_KEEP: u64 = 200;

// Signing stages of a bet (`sign_stage`).
const NONE: u8 = 0;
const LEVERAGE_ASKED: u8 = 1;
const LEVERAGE_SIGNED: u8 = 2;
const OPEN_ASKED: u8 = 3;
const OPEN_SIGNED: u8 = 4;
const CLOSE_ASKED: u8 = 5;
const CLOSE_SIGNED: u8 = 6;

// Position status codes (PositionRec.status).
const P_APPROVED: u8 = 0;
const P_OPEN_SIGNED: u8 = 1;
const P_CLOSE_SIGNED: u8 = 2;

// Action kinds (ActionRec.kind).
const K_LEVERAGE: u8 = 0;
const K_OPEN: u8 = 1;
const K_CLOSE: u8 = 2;

/// What the program is pinned to (01 §6.3, `get_constants().model` and `.hl`). Fixed at deploy.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pins {
    pub model: String,
    /// 0 ecdsa, 1 ed25519
    pub algo: u8,
    /// 20-byte address (ecdsa) or 32-byte public key (ed25519)
    pub signer: Vec<u8>,
    /// The Hyperliquid address NEAR's signing network gives this account for `path`, lower-case 0x-hex.
    pub hl_address: String,
    pub signer_contract: AccountId,
    pub path: String,
    pub order_expiry_ms: u64,
    pub testnet: bool,
}

/// `new` / `migrate` arguments for the pins (JSON).
#[derive(Deserialize, near_sdk::serde::Serialize, Clone)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PinsInit {
    pub model: String,
    pub signing_algo: wire::SigningAlgo,
    /// Hex, with or without 0x.
    pub signer: String,
    /// 0x + 40 hex: the address the signing network derives for this account and `path`.
    pub hl_address: String,
    #[serde(default)]
    pub signer_contract: Option<AccountId>,
    #[serde(default)]
    pub path: Option<String>,
}

pub(crate) fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl Pins {
    pub fn from_init(p: PinsInit) -> Self {
        let algo = match p.signing_algo {
            wire::SigningAlgo::Ecdsa => 0,
            wire::SigningAlgo::Ed25519 => 1,
        };
        let signer = unhex(&p.signer).unwrap_or_else(|| env::panic_str("signer must be hex"));
        require!(
            signer.len() == if algo == 0 { 20 } else { 32 },
            "signer: 20 bytes for ecdsa, 32 for ed25519"
        );
        let addr = p.hl_address.to_lowercase();
        require!(
            addr.len() == 42 && unhex(&addr).is_some_and(|b| b.len() == 20),
            "hl_address must be 0x + 40 hex"
        );
        Pins {
            model: p.model,
            algo,
            signer,
            hl_address: addr,
            signer_contract: p
                .signer_contract
                .unwrap_or_else(|| "v1.signer-prod.testnet".parse().unwrap()),
            path: p.path.unwrap_or_else(|| "intern-1".to_string()),
            order_expiry_ms: 120_000,
            testnet: true,
        }
    }

    /// Nothing pinned yet: every real check refuses (BAD_MODEL_SIGNATURE) and no signature is accepted.
    pub fn unset() -> Self {
        Pins {
            model: "UNSET".to_string(),
            algo: 1,
            signer: vec![],
            hl_address: format!("0x{}", "0".repeat(40)),
            signer_contract: "v1.signer-prod.testnet".parse().unwrap(),
            path: "intern-1".to_string(),
            order_expiry_ms: 120_000,
            testnet: true,
        }
    }

    pub fn model_view(&self) -> wire::ModelPin {
        wire::ModelPin {
            id: self.model.clone(),
            signing_algo: if self.algo == 0 {
                wire::SigningAlgo::Ecdsa
            } else {
                wire::SigningAlgo::Ed25519
            },
            signer: if self.algo == 0 {
                format!("0x{}", hex(&self.signer))
            } else {
                hex(&self.signer)
            },
        }
    }
}

/// The real checks 3–5: Engine 2's `ai-check` with NEAR's host functions and the pinned model.
pub fn real_check(
    pins: &Pins,
    e: &crate::ai::Expected,
    req: &[u8],
    resp: &[u8],
    sig: &[u8],
) -> Result<shared::Decision, Refusal> {
    let pinned = ai_check::Pinned {
        model: &pins.model,
        algo: if pins.algo == 0 {
            ai_check::Algo::Ecdsa
        } else {
            ai_check::Algo::Ed25519
        },
        signer: &pins.signer,
    };
    let expected = ai_check::Expected {
        rulebook: e.rulebook,
        round_id: e.round_id,
        nonce: e.nonce,
    };
    ai_check::verify(&host::NearHost, &pinned, &expected, req, resp, sig)
}

/// One signed action (01 §8.1 `SignedAction`).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionRec {
    pub id: u64,
    pub position_id: u64,
    pub kind: u8,
    pub action_json: String,
    pub nonce: u64,
    pub expires_after: u64,
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub v: u8,
    pub created_at: u64,
}

/// The signing network's answer: `{"big_r":{"affine_point":"02…"},"s":{"scalar":"…"},"recovery_id":0}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcSig {
    big_r: MpcPoint,
    s: MpcScalar,
    recovery_id: u8,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcPoint {
    affine_point: String,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcScalar {
    scalar: String,
}

/// Reads the signing network's answer into (r, s, recovery id). None for anything unexpected.
pub(crate) fn read_mpc(bytes: &[u8]) -> Option<([u8; 32], [u8; 32], u8)> {
    let m: MpcSig = serde_json::from_slice(bytes).ok()?;
    let point = unhex(&m.big_r.affine_point)?;
    let s = unhex(&m.s.scalar)?;
    if point.len() != 33 || !matches!(point[0], 2 | 3) || s.len() != 32 || m.recovery_id > 1 {
        return None;
    }
    Some((
        point[1..].try_into().ok()?,
        s.try_into().ok()?,
        m.recovery_id,
    ))
}

/// The Ethereum address a signature over `digest` recovers to, lower-case 0x-hex.
pub(crate) fn recovered_address(
    digest: &[u8; 32],
    r: &[u8; 32],
    s: &[u8; 32],
    recovery_id: u8,
) -> Option<String> {
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(r);
    sig[32..].copy_from_slice(s);
    let key = host::NearHost.ecrecover(digest, &sig, recovery_id)?;
    Some(format!("0x{}", hex(&env::keccak256_array(key)[12..])))
}

fn kind_view(k: u8) -> wire::ActionKind {
    match k {
        K_LEVERAGE => wire::ActionKind::Leverage,
        K_OPEN => wire::ActionKind::Open,
        _ => wire::ActionKind::Close,
    }
}

fn market_info(code: u8) -> &'static rules::limits::MarketInfo {
    let m = round::market_of(code);
    rules::limits::MARKETS
        .iter()
        .find(|x| x.market == m)
        .expect("every market is listed")
}

impl Coin {
    fn stage(&self, position_id: u64) -> u8 {
        self.sign_stage.get(&position_id).copied().unwrap_or(NONE)
    }

    /// Strictly increasing millisecond nonces (Hyperliquid's rule), 8 bytes when hashed.
    fn next_hl_nonce(&mut self) -> u64 {
        let n = (self.last_hl_nonce + 1).max(env::block_timestamp_ms());
        self.last_hl_nonce = n;
        n
    }

    /// Builds `action`, asks the signing network for a signature over its digest, and checks the answer in
    /// `on_signed`.
    fn ask_signature(
        &mut self,
        position_id: u64,
        kind: u8,
        action: hl_order::Action,
        prev_stage: u8,
        sz_e8: Option<u64>,
    ) -> Promise {
        let nonce = self.next_hl_nonce();
        let expires_after = nonce + self.pins.order_expiry_ms;
        // 1.6: every order (not a leverage change) carries a client order id, so each Hyperliquid fill names its bet.
        let cloid = match action {
            hl_order::Action::Order { .. } => {
                let round_id = self.positions.get(&position_id).map_or(0, |p| p.round_id);
                Some(order_cloid(round_id, position_id, nonce))
            }
            hl_order::Action::Leverage { .. } => None,
        };
        let built = hl_order::build_with_cloid(
            &host::NearHost,
            &action,
            cloid,
            nonce,
            expires_after,
            self.pins.testnet,
        )
        .unwrap_or_else(|e| env::panic_str(&format!("this order cannot be built: {e:?}")));
        let args = json!({"request": {"path": self.pins.path, "payload_v2": {"Ecdsa": hex(&built.digest)}, "domain_id": 0}});
        Promise::new(self.pins.signer_contract.clone())
            .function_call(
                "sign".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_MPC,
            )
            .then(
                Self::ext(Self::me())
                    .with_static_gas(GAS_ON_SIGNED)
                    .on_signed(
                        position_id,
                        kind,
                        built.action_json,
                        hex(&built.digest),
                        U64(nonce),
                        U64(expires_after),
                        prev_stage,
                        sz_e8.map(U64),
                    ),
            )
    }

    fn action_view(a: &ActionRec) -> wire::SignedAction {
        wire::SignedAction {
            id: a.id,
            position_id: a.position_id,
            kind: kind_view(a.kind),
            action: serde_json::from_str(&a.action_json).unwrap_or(serde_json::Value::Null),
            nonce: a.nonce,
            expires_after: a.expires_after,
            signature: wire::EcdsaSignature {
                r: format!("0x{}", hex(&a.r)),
                s: format!("0x{}", hex(&a.s)),
                v: a.v,
            },
            created_at: a.created_at,
        }
    }
}

#[near]
impl Coin {
    /// Runner only, no deposit, at least 250 TGas (attach 300). First call: signs "set leverage,
    /// isolated" for the bet's market. Second call: signs the opening order at `px_e8`. Returns the
    /// signed action (also in the outbox), or null if the signature failed (call again).
    pub fn sign_next(&mut self, position_id: u64, px_e8: wire::PxE8) -> Promise {
        require!(
            env::predecessor_account_id() == self.cfg.runner,
            "only the runner may sign orders"
        );
        require!(
            env::prepaid_gas() >= GAS_SIGN_MIN,
            "attach at least 250 TGas (300 is safe): the signing network needs 200"
        );
        self.tick();
        let p = *self
            .positions
            .get(&position_id)
            .unwrap_or_else(|| env::panic_str("no such position"));
        require!(
            p.status == P_APPROVED && p.returned.is_none(),
            "this bet's orders are already signed"
        );
        require!(
            self.rank_now().1 == Status::Employed,
            "the Intern is FIRED: no new orders; report the margin back instead"
        );
        let m = market_info(p.market);
        match self.stage(position_id) {
            NONE => {
                self.sign_stage.insert(position_id, LEVERAGE_ASKED);
                let action = hl_order::Action::Leverage {
                    asset: m.testnet_asset,
                    leverage: p.leverage,
                };
                self.ask_signature(position_id, K_LEVERAGE, action, NONE, None)
            }
            LEVERAGE_SIGNED => {
                let px = px_e8.0;
                let sz = hl_order::size_for(p.notional, px, m.sz_decimals);
                require!(sz > 0, "at this price the bet buys less than one size step");
                if let Err(e) = hl_order::check_format(px, sz, m.sz_decimals) {
                    env::panic_str(&format!("price or size not in Hyperliquid's format: {e:?}"));
                }
                require!(
                    hl_order::notional_e6(px, sz) <= p.notional,
                    "px × size is above the bet's notional"
                );
                self.sign_stage.insert(position_id, OPEN_ASKED);
                let action = hl_order::Action::Order {
                    asset: m.testnet_asset,
                    is_buy: round::side_of(p.side) == shared::Side::Long,
                    px_e8: px,
                    sz_e8: sz,
                    reduce_only: false,
                };
                self.ask_signature(position_id, K_OPEN, action, LEVERAGE_SIGNED, Some(sz))
            }
            LEVERAGE_ASKED | OPEN_ASKED => {
                env::panic_str("a signature for this bet is being made: wait for it (about 10 s)")
            }
            _ => env::panic_str("this bet's orders are already signed"),
        }
    }

    /// Anyone, 1 yocto, at least 250 TGas, in phase CLOSE or once the Intern is FIRED. Signs a
    /// reduce-only order for the bet's size on the other side. May be called again until the bet has a
    /// result.
    #[payable]
    pub fn close(&mut self, position_id: u64, px_e8: wire::PxE8) -> Promise {
        assert_one_yocto();
        require!(
            env::prepaid_gas() >= GAS_SIGN_MIN,
            "attach at least 250 TGas (300 is safe): the signing network needs 200"
        );
        self.tick();
        let p = *self
            .positions
            .get(&position_id)
            .unwrap_or_else(|| env::panic_str("no such position"));
        require!(p.returned.is_none(), "this bet already has a result");
        require!(
            matches!(p.status, P_OPEN_SIGNED | P_CLOSE_SIGNED),
            "this bet was never opened"
        );
        let r = self.current.expect("round");
        let in_close = r.id == p.round_id
            && Self::now().saturating_sub(r.started_at) >= self.cfg.close_from_ms;
        require!(
            in_close || self.rank_now().1 == Status::Fired,
            "a bet can be closed in the CLOSE phase, or at any time once the Intern is FIRED"
        );
        let prev = self.stage(position_id);
        require!(
            prev != CLOSE_ASKED,
            "a closing signature for this bet is being made: wait for it (about 10 s)"
        );
        let m = market_info(p.market);
        let sz =
            u64::try_from(p.sz_e8.expect("an opened bet has a size")).expect("sizes fit in u64");
        if let Err(e) = hl_order::check_format(px_e8.0, sz, m.sz_decimals) {
            env::panic_str(&format!("price not in Hyperliquid's format: {e:?}"));
        }
        self.sign_stage.insert(position_id, CLOSE_ASKED);
        let action = hl_order::Action::Order {
            asset: m.testnet_asset,
            is_buy: round::side_of(p.side) == shared::Side::Short,
            px_e8: px_e8.0,
            sz_e8: sz,
            reduce_only: true,
        };
        self.ask_signature(position_id, K_CLOSE, action, prev, None)
    }

    /// Callback of a signature. Success (and the signature recovers to the program's address): the
    /// action goes into the outbox and the bet moves on. Anything else: the bet goes back where it was.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_signed(
        &mut self,
        position_id: u64,
        kind: u8,
        action_json: String,
        digest: String,
        nonce: U64,
        expires_after: U64,
        prev_stage: u8,
        sz_e8: Option<U64>,
    ) -> Option<wire::SignedAction> {
        let digest: [u8; 32] = unhex(&digest)
            .and_then(|d| d.try_into().ok())
            .expect("our own digest");
        let signed = match env::promise_result_checked(0, 2_048) {
            Ok(bytes) => read_mpc(&bytes),
            Err(_) => None,
        };
        let Some((r, s, rid)) = signed else {
            self.sign_stage.insert(position_id, prev_stage);
            env::log_str(
                "signing failed or the answer could not be read: nothing changed, call again",
            );
            return None;
        };
        if recovered_address(&digest, &r, &s, rid).as_deref() != Some(self.pins.hl_address.as_str())
        {
            self.sign_stage.insert(position_id, prev_stage);
            env::log_str("the signature does not recover to the program's Hyperliquid address: not used, nothing changed");
            return None;
        }
        let now = Self::now();
        let id = self.outbox_next;
        let a = ActionRec {
            id,
            position_id,
            kind,
            action_json,
            nonce: nonce.0,
            expires_after: expires_after.0,
            r,
            s,
            v: 27 + rid,
            created_at: now,
        };
        self.outbox.insert(id, a.clone());
        self.outbox_next += 1;
        while self.outbox_next - self.outbox_first > OUTBOX_KEEP {
            self.outbox.remove(&self.outbox_first);
            self.outbox_first += 1;
        }
        let mut p = *self.positions.get(&position_id).expect("position");
        let next = match kind {
            K_LEVERAGE => LEVERAGE_SIGNED,
            K_OPEN => {
                p.status = P_OPEN_SIGNED;
                p.open_signed_at = Some(now);
                p.sz_e8 = sz_e8.map(|x| u128::from(x.0));
                OPEN_SIGNED
            }
            _ => {
                p.status = P_CLOSE_SIGNED;
                p.close_signed_at = Some(now);
                CLOSE_SIGNED
            }
        };
        self.positions.insert(position_id, p);
        self.sign_stage.insert(position_id, next);
        self.feed.push(
            EventName::OrderSigned,
            json!({"action_id": id, "position_id": position_id, "kind": kind_view(kind)}),
        );
        Some(Self::action_view(&a))
    }

    /// Oldest first, after `after_id` (01 §8). The last 200 signed actions are kept.
    pub fn get_outbox(&self, after_id: Option<u64>, limit: Option<u32>) -> Vec<wire::SignedAction> {
        let from = after_id.map_or(self.outbox_first, |a| (a + 1).max(self.outbox_first));
        let n = limit.map_or(50, |l| l.clamp(1, 100)) as u64;
        (from..self.outbox_next.min(from.saturating_add(n)))
            .filter_map(|i| self.outbox.get(&i))
            .map(Self::action_view)
            .collect()
    }
}

/// 1.6: an order's client order id (01 §11.2): bytes 0-3 the round id, 4-7 the position id (their low 32 bits),
/// 8-15 the order's own Hyperliquid nonce, all big-endian. Unique, because the contract never signs a nonce twice.
pub fn order_cloid(round_id: u64, position_id: u64, nonce: u64) -> hl_order::Cloid {
    let mut id = [0u8; 16];
    id[..4].copy_from_slice(&(round_id as u32).to_be_bytes());
    id[4..8].copy_from_slice(&(position_id as u32).to_be_bytes());
    id[8..].copy_from_slice(&nonce.to_be_bytes());
    hl_order::Cloid(id)
}
