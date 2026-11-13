//! Interface 1.7, owner's decisions (Engine 2's list, items 9 and 16): the Intern earns from tricks, and players
//! fund a bounty for catching it out.
//!
//! - **Paid tricks.** A visitor pays `TRICK_PRICE` ($1, test USDC on testnet) to the coin with
//!   `ft_transfer_call(coin, amount, '{"trick":{"id":"<the trick page's id>"}}')`. The payment is recorded under that
//!   id (`get_trick_payment`) so the trick page can check it, and paid tricks go ahead of free ones in its queue.
//!   Half goes to the bounty pot, a quarter to the claimed "first of its kind" originals (`earn.rs`; the bounty's
//!   if none is claimed) and a quarter to the BRAVE pool as outside income (the bounty's while the Intern is
//!   fired). This is a payment on NEAR, not the x402 HTTP protocol.
//! - **The bounty.** Anyone may add to the pot (`'{"bounty":{}}'`, at least $1). When a trick credited to a visitor
//!   (`propose(.., credited_to)`) gets the AI's answer refused for checks 3 to 12, the visitor wins `BOUNTY_BPS`
//!   (10%) of the pot as a prize, claimed with `claim_prizes` like the jackpot's.
//! - Visitor text never goes into the rulebook (that would let a visitor write the AI's instructions); the
//!   rulebook does not change for tricks.
//!
//! The pot is USDC held apart from both pools: the books add `bounty` (01 §9.7's "Books" line). State lives under its
//! own storage keys (prefix `t7`): no migration.

use crate::*;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};

pub const TRICK_PRICE: u128 = 1_000_000;
pub const BOUNTY_BPS: u128 = 1_000;
const MAX_ID: usize = 64;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BountyState {
    pub pot: u128,
    pub paid_total: u128,
    pub added_total: u128,
    pub from_tricks_total: u128,
    pub tricks_paid: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrickPayment {
    pub account_id: AccountId,
    pub amount: U128,
    pub at: u64,
    pub round_id: u64,
}

#[near(serializers = [json])]
pub struct BountyView {
    pub pot: U128,
    pub paid_total: U128,
    pub added_total: U128,
    pub from_tricks_total: U128,
    pub tricks_paid: u64,
    pub trick_price: U128,
    pub bounty_bps: u32,
}

/// `{"trick":{"id":"…"}}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct TrickMsg {
    pub trick: TrickBody,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct TrickBody {
    pub id: String,
}
/// `{"bounty":{}}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct BountyMsg {
    #[allow(dead_code)]
    pub bounty: crate::TipBody,
}

fn state_key() -> Vec<u8> {
    b"t7s".to_vec()
}
fn pay_key(id: &str) -> Vec<u8> {
    [b"t7p".as_slice(), id.as_bytes()].concat()
}
fn read<T: BorshDeserialize>(k: &[u8]) -> Option<T> {
    env::storage_read(k).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("tricks state")))
}
fn write<T: BorshSerialize>(k: &[u8], v: &T) {
    env::storage_write(k, &borsh::to_vec(v).unwrap_or_else(|_| env::panic_str("tricks state")));
}

pub(crate) fn bounty_state() -> BountyState {
    read(&state_key()).unwrap_or_default()
}

impl Coin {
    /// ft_on_transfer with `{"trick":{"id"}}`. Returns what to refund.
    pub(crate) fn take_trick_payment(&mut self, who: &AccountId, id: &str, amount: u128) -> u128 {
        if id.is_empty() || id.len() > MAX_ID || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            env::log_str("a trick id is 1-64 letters, digits or '-': refunded");
            return amount;
        }
        if amount < TRICK_PRICE {
            env::log_str("a trick costs at least 1 USDC: refunded");
            return amount;
        }
        if env::storage_has_key(&pay_key(id)) {
            env::log_str("this trick id is already paid: refunded");
            return amount;
        }
        self.tick();
        let round_id = self.current.expect("round").id;
        // Half to the bounty; a quarter to the claimed originals (the bounty's, if none is claimed); a quarter to the
        // pool (the bounty's too while the Intern is fired).
        let employed = self.rank_now().1 == Status::Employed;
        let quarter = amount / 4;
        let to_pool = if employed { quarter } else { 0 };
        let not_placed = self.share_with_originals(quarter);
        let to_bounty = amount - to_pool - (quarter - not_placed);
        let mut s = bounty_state();
        s.pot += to_bounty;
        s.from_tricks_total += to_bounty;
        s.tricks_paid += 1;
        write(&state_key(), &s);
        if to_pool > 0 {
            self.take_income("tricks", to_pool);
        }
        write(
            &pay_key(id),
            &TrickPayment { account_id: who.clone(), amount: U128(amount), at: Self::now(), round_id },
        );
        self.feed.push(
            EventName::TrickPaid,
            json!({"id": id, "account_id": who, "amount": U128(amount), "to_bounty": U128(to_bounty)}),
        );
        0
    }

    /// ft_on_transfer with `{"bounty":{}}`.
    pub(crate) fn add_bounty(&mut self, who: &AccountId, amount: u128) {
        let mut s = bounty_state();
        s.pot += amount;
        s.added_total += amount;
        write(&state_key(), &s);
        self.feed.push(EventName::BountyGrew, json!({"amount": U128(amount), "by": who, "pot": U128(s.pot)}));
    }

    /// propose, after a NOPE: a trick credited to a visitor that got the AI's own answer refused wins a share.
    pub(crate) fn bounty_for_refusal(&mut self, refusal_id: u64, code: Refusal, credited_to: Option<&AccountId>) {
        let Some(who) = credited_to else { return };
        if !(2..=11).contains(&(code as u8)) {
            return;
        }
        let mut s = bounty_state();
        let share = s.pot * BOUNTY_BPS / 10_000;
        if share == 0 {
            return;
        }
        s.pot -= share;
        s.paid_total += share;
        write(&state_key(), &s);
        self.rw_credit_prize(who, share);
        self.feed.push(
            EventName::BountyPaid,
            json!({"account_id": who, "amount": U128(share), "refusal_id": refusal_id, "code": code}),
        );
    }
}

#[near]
impl Coin {
    /// 1.7. The trick bounty and the trick price.
    pub fn get_bounty(&self) -> BountyView {
        let s = bounty_state();
        BountyView {
            pot: U128(s.pot),
            paid_total: U128(s.paid_total),
            added_total: U128(s.added_total),
            from_tricks_total: U128(s.from_tricks_total),
            tricks_paid: s.tricks_paid,
            trick_price: U128(TRICK_PRICE),
            bounty_bps: BOUNTY_BPS as u32,
        }
    }

    /// 1.7. A paid trick, by the trick page's id (null if not paid).
    pub fn get_trick_payment(&self, id: String) -> Option<TrickPayment> {
        read(&pay_key(&id))
    }
}
