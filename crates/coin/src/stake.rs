//! Interface 1.7, owner's decision (Engine 2's list, item 15): the coin's supply reacts to the Intern.
//!
//! The Intern holds a stake of $INTERN coins in the contract's own account (apart from the 1,000 units locked for
//! ever at the first conversion):
//! - **When a round wins**, `STAKE_FEE_BPS` (5%) of what the pool keeps (after the coach and rescue cuts) becomes
//!   new coins for the stake: the supply grows and the holders pay a 5% performance fee, in coins.
//! - **When a round loses**, the stake's coins are burned first, up to the loss's worth: the supply shrinks and the
//!   holders' coins are worth more, which covers the loss as far as the stake goes.
//!
//! No dollar moves: only coins are minted to and burned from the contract's account (NEP-141 `ft_mint` and
//! `ft_burn` logs, memo "the Intern's stake"). Events `stake_grew` and `stake_burned`. State lives under its own
//! storage key (`k7s`): no migration.

use crate::*;
use near_sdk::borsh;

pub const STAKE_FEE_BPS: u128 = 500;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StakeState {
    pub coins: u128,
    pub grew_total: u128,
    pub burned_total: u128,
}

#[near(serializers = [json])]
pub struct StakeView {
    pub coins: U128,
    /// What the stake's coins are worth now (dollars e6).
    pub value: U128,
    pub fee_bps: u32,
    pub grew_total: U128,
    pub burned_total: U128,
}

fn read() -> StakeState {
    env::storage_read(b"k7s").map_or_else(StakeState::default, |b| {
        borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("stake state"))
    })
}
fn write(s: &StakeState) {
    env::storage_write(b"k7s", &borsh::to_vec(s).unwrap_or_else(|_| env::panic_str("stake state")));
}

impl Coin {
    /// finish_settle, after the pool took the round's result: the stake grows on a win, burns on a loss.
    pub(crate) fn stake_after_settle(&mut self, round_id: u64, kept: i128) {
        let supply = self.supply();
        let held = self.books.brave_total.saturating_sub(self.books.in_play);
        if supply == 0 || held == 0 {
            return;
        }
        let me = Self::me();
        let mut s = read();
        if kept > 0 {
            let fee = (kept as u128) * STAKE_FEE_BPS / 10_000;
            if fee == 0 || fee >= held {
                return;
            }
            // Coins `m` such that m / (supply + m) of the pool is the fee: the holders keep `held - fee`.
            let m = fee.saturating_mul(supply) / (held - fee);
            if m == 0 {
                return;
            }
            self.token.internal_deposit(&me, m);
            FtMint { owner_id: &me, amount: U128(m), memo: Some("the Intern's stake") }.emit();
            s.coins += m;
            s.grew_total += m;
            self.feed.push(EventName::StakeGrew, json!({"round_id": round_id, "coins": U128(m), "fee": U128(fee)}));
        } else if kept < 0 && s.coins > 0 {
            let loss = kept.unsigned_abs();
            // The stake's coins worth the loss at today's price, at most all of them.
            let worth = loss.saturating_mul(supply).div_ceil(held);
            let b = worth.min(s.coins);
            if b == 0 {
                return;
            }
            self.token.internal_withdraw(&me, b);
            FtBurn { owner_id: &me, amount: U128(b), memo: Some("the Intern's stake") }.emit();
            s.coins -= b;
            s.burned_total += b;
            let covered = b.saturating_mul(held) / supply;
            self.feed.push(
                EventName::StakeBurned,
                json!({"round_id": round_id, "coins": U128(b), "covered": U128(covered)}),
            );
        } else {
            return;
        }
        write(&s);
    }
}

#[near]
impl Coin {
    /// 1.7. The Intern's stake of coins.
    pub fn get_stake(&self) -> StakeView {
        let s = read();
        let (_, b, _, supply) = self.projected();
        StakeView {
            coins: U128(s.coins),
            value: U128(shares::brave_value(s.coins, b.brave_total, b.in_play, supply)),
            fee_bps: STAKE_FEE_BPS as u32,
            grew_total: U128(s.grew_total),
            burned_total: U128(s.burned_total),
        }
    }
}
