//! Interface 1.7, owner's decision (Engine 2's list, item 19): the sixteen originals own a Hyperliquid account.
//!
//! Each "first of its kind" original (`original:<CODE>`) has its own Hyperliquid testnet account, derived from this
//! contract by NEAR's signing network with the path `sticker-<CODE>` (the same derivation Tail or Fade uses, with the
//! coin as the predecessor), so only this contract can sign for it. Whoever holds the original may:
//! - `sticker_hl_approve(code, agent)`: have the contract sign an `approveAgent` for a trading key of theirs (unnamed:
//!   it replaces the previous holder's key), which can then trade the sticker's account, never withdraw;
//! - `sticker_hl_withdraw(code, destination, amount)`: have the contract sign a `usdSend` from the sticker's account.
//! The coin checks with the sticker contract that the caller holds the token, then asks the signing network; the
//! signed action is kept (`get_sticker_hl`) for the holder to send to Hyperliquid. Funding the account is up to anyone
//! (send it test USDC). State lives under its own storage keys (prefix `h7`): no migration.

use crate::sign::{hex, read_mpc, recovered_address};
use crate::*;
use near_sdk::json_types::U64;
use near_sdk::{borsh, ext_contract};

const GAS_OWNER: Gas = Gas::from_tgas(10);
const GAS_ON_OWNER: Gas = Gas::from_tgas(245);
const GAS_MPC: Gas = Gas::from_tgas(200);
const GAS_ON_SIGNED: Gas = Gas::from_tgas(20);
const KEEP: usize = 10;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StickerSigned {
    /// The refusal code, as written in 01 §7.
    pub code: String,
    pub kind: String,
    /// The exact JSON Hyperliquid expects as `action`; `nonce` is its nonce or time.
    pub action: String,
    pub nonce: u64,
    pub r: String,
    pub s: String,
    pub v: u8,
    pub signer: String,
    pub for_account: AccountId,
    pub at: u64,
}

#[near(serializers = [json])]
pub struct StickerHlView {
    pub code: Refusal,
    pub token_id: String,
    pub path: String,
    /// The latest signed actions, newest first (at most 10).
    pub signed: Vec<StickerSigned>,
}

fn key(code: Refusal) -> Vec<u8> {
    [b"h7s".as_slice(), code.as_str().as_bytes()].concat()
}
fn read(code: Refusal) -> Vec<StickerSigned> {
    env::storage_read(&key(code)).map_or_else(Vec::new, |b| borsh::from_slice(&b).unwrap_or_default())
}
fn write(code: Refusal, v: &Vec<StickerSigned>) {
    env::storage_write(&key(code), &borsh::to_vec(v).unwrap_or_else(|_| env::panic_str("sticker hl")));
}
fn path(code: Refusal) -> String {
    format!("sticker-{}", code.as_str())
}

#[ext_contract(ext_owner)]
#[allow(dead_code)]
trait Owner {
    fn nft_token(&self, token_id: String) -> Option<near_sdk::serde_json::Value>;
}

/// "0x" + 40 lower-case hex: an address.
fn address20(s: &str) -> Option<[u8; 20]> {
    let b = crate::sign::unhex(s.strip_prefix("0x")?)?;
    if s.len() != 42 || s.to_lowercase() != s {
        return None;
    }
    b.try_into().ok()
}

/// A decimal amount as Hyperliquid writes it: digits, at most one dot, at most 6 decimals, not zero.
fn amount_ok(a: &str) -> bool {
    let mut parts = a.split('.');
    let (whole, frac) = (parts.next().unwrap_or(""), parts.next());
    parts.next().is_none()
        && !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| !f.is_empty() && f.len() <= 6 && f.bytes().all(|b| b.is_ascii_digit()))
        && a.bytes().any(|b| (b'1'..=b'9').contains(&b))
}

#[near]
impl Coin {
    /// 1.7. The holder of `original:<code>` has the contract sign an `approveAgent` for `agent` (0x + 40 lower-case
    /// hex) on the sticker's Hyperliquid account. Attach 300 TGas and 1 yocto.
    #[payable]
    pub fn sticker_hl_approve(&mut self, code: Refusal, agent: String) -> Promise {
        assert_one_yocto();
        require!(address20(&agent).is_some(), "agent must be 0x and 40 lower-case hex digits");
        self.sticker_hl_start(code, "APPROVE_AGENT".into(), agent, String::new())
    }

    /// 1.7. The holder of `original:<code>` has the contract sign a `usdSend` of `amount` (decimal string) from the
    /// sticker's Hyperliquid account to `destination` (0x + 40 lower-case hex). Attach 300 TGas and 1 yocto.
    #[payable]
    pub fn sticker_hl_withdraw(&mut self, code: Refusal, destination: String, amount: String) -> Promise {
        assert_one_yocto();
        require!(address20(&destination).is_some(), "destination must be 0x and 40 lower-case hex digits");
        require!(amount_ok(&amount), "amount is a decimal like 12.5, at most 6 decimals");
        self.sticker_hl_start(code, "USD_SEND".into(), destination, amount)
    }

    #[private]
    pub fn on_sticker_owner(&mut self, code: Refusal, who: AccountId, kind: String, to: String, amount: String) -> PromiseOrValue<bool> {
        let owner = match env::promise_result_checked(0, 4_096) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| v.get("owner_id").and_then(|o| o.as_str().map(str::to_string))),
            Err(_) => None,
        };
        if owner.as_deref() != Some(who.as_str()) {
            env::log_str("only the original's holder can use its Hyperliquid account");
            return PromiseOrValue::Value(false);
        }
        let now = Self::now();
        let (action, digest) = if kind == "APPROVE_AGENT" {
            let agent = address20(&to).expect("checked");
            hl_order::approve_agent(&host::NearHost, agent, "", now, self.pins.testnet)
        } else {
            hl_order::usd_send(&host::NearHost, &to, &amount, now, self.pins.testnet)
        };
        let args = json!({"request": {"path": path(code), "payload_v2": {"Ecdsa": hex(&digest)}, "domain_id": 0}});
        PromiseOrValue::Promise(
            Promise::new(self.pins.signer_contract.clone())
                .function_call("sign".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_MPC)
                .then(
                    Self::ext(Self::me())
                        .with_static_gas(GAS_ON_SIGNED)
                        .on_sticker_signed(code, who, kind, action, hex(&digest), U64(now)),
                ),
        )
    }

    #[private]
    pub fn on_sticker_signed(
        &mut self,
        code: Refusal,
        who: AccountId,
        kind: String,
        action: String,
        digest: String,
        nonce: U64,
    ) -> Option<StickerSigned> {
        let d: [u8; 32] = crate::sign::unhex(&digest).and_then(|x| x.try_into().ok()).expect("our digest");
        let Some((r, s, rid)) = env::promise_result_checked(0, 2_048).ok().and_then(|b| read_mpc(&b)) else {
            env::log_str("signing failed: nothing was signed, call again");
            return None;
        };
        let signer = recovered_address(&d, &r, &s, rid).unwrap_or_default();
        let rec = StickerSigned {
            code: code.as_str().to_string(),
            kind: kind.clone(),
            action,
            nonce: nonce.0,
            r: format!("0x{}", hex(&r)),
            s: format!("0x{}", hex(&s)),
            v: 27 + rid,
            signer: signer.clone(),
            for_account: who.clone(),
            at: Self::now(),
        };
        let mut list = read(code);
        list.insert(0, rec.clone());
        list.truncate(KEEP);
        write(code, &list);
        self.feed.push(
            EventName::StickerHlSigned,
            json!({"code": code, "kind": kind, "account_id": who, "signer": signer}),
        );
        Some(rec)
    }

    /// 1.7. A sticker's Hyperliquid account: its derivation path and the latest actions signed for it.
    pub fn get_sticker_hl(&self, code: Refusal) -> StickerHlView {
        StickerHlView {
            code,
            token_id: format!("original:{}", code.as_str()),
            path: path(code),
            signed: read(code),
        }
    }
}

impl Coin {
    fn sticker_hl_start(&mut self, code: Refusal, kind: String, to: String, amount: String) -> Promise {
        require!(env::prepaid_gas() >= Gas::from_tgas(290), "attach 300 TGas");
        require!(
            matches!(self.s9.sticker_firsts[code as usize], Some((_, _, true))),
            "this code's original has not been claimed"
        );
        let who = env::predecessor_account_id();
        ext_owner::ext(self.s9.stickers.clone())
            .with_static_gas(GAS_OWNER)
            .nft_token(format!("original:{}", code.as_str()))
            .then(Self::ext(Self::me()).with_static_gas(GAS_ON_OWNER).on_sticker_owner(code, who, kind, to, amount))
    }
}
